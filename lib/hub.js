/**
 * Hub role: accept outbound links, keep their harnesses reachable, and serve
 * the local agent's peer tools.
 *
 * A hub owns no remote process. Each link dials in, greets with a shared
 * token, and then answers the harness JSON-RPC methods that the stdio SDK
 * server defines. The hub keeps one conversation state per remote session and
 * turns those notifications into tool results.
 *
 * @module @local/dsh-peer/hub
 */

import { createServer } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { PeerConnection, HANDSHAKE_TIMEOUT_MS, describeError, localIdentity, peerSessionId, readHello, tokenMatches } from './protocol.js'
import { createWebSocketServer } from './ws.js'
import { SessionMirror } from './mirror.js'

/** Default deadline for one delegated turn. */
export const DEFAULT_ASK_TIMEOUT_MS = 900_000

/** Default deadline for `peer_wait`. */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000

/** Inbox entries retained for `peer_inbox` and late `peer_wait` calls. */
const INBOX_LIMIT = 200

/**
 * One connected link and its conversation state.
 */
export class LinkSession {
  /**
   * @param {PeerConnection} conn - authenticated connection.
   * @param {Record<string, unknown>} info - the link's published identity.
   */
  constructor(conn, info) {
    this.conn = conn
    this.info = info
    this.name = /** @type {string} */ (info.name)
    this.connectedAt = Date.now()
    /** @type {Map<string, SessionState>} */
    this.sessions = new Map()
    /** @type {Promise<void> | undefined} */
    this.initializing = undefined
    /** @type {Set<string>} */
    this.attached = new Set()
    this.ready = false
  }

  /** Describe this link for `peer_list`. */
  describe() {
    return {
      name: this.name,
      platform: this.info.platform ?? 'unknown',
      arch: this.info.arch ?? 'unknown',
      hostname: this.info.hostname ?? '',
      version: this.info.version ?? 'unknown',
      cwd: this.info.cwd ?? '',
      provider: this.info.provider ?? '',
      model: this.info.model ?? '',
      connectedAt: new Date(this.connectedAt).toISOString(),
      sessions: [...this.sessions.keys()],
    }
  }
}

/**
 * Conversation facts the hub retains for one remote session.
 */
class SessionState {
  constructor() {
    this.lastAssistant = ''
    this.lastTurnReason = ''
    this.status = 'idle'
    this.idleCount = 0
    /** @type {Set<string>} */
    this.receipts = new Set()
    /** @type {Set<() => void>} */
    this.waiters = new Set()
  }

  /** Resolve every waiter; each re-checks its own predicate. */
  wake() {
    for (const waiter of [...this.waiters]) waiter()
  }
}

/**
 * Hub server plus the link registry it serves.
 */
export class PeerHub {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
   * @param {object} config - resolved deployment configuration.
   * @param {string} config.name - hub name published to links.
   * @param {string} config.token - shared secret links must present.
   * @param {{ host: string, port: number }} config.listen - bind address.
   * @param {{ host: string, port: number, path?: string }} [config.wsListen] - optional WebSocket listener behind an HTTP proxy.
   * @param {boolean} [config.mirror] - replay remote sessions into local read-only sessions (default on).
   * @param {object} [config.tls] - server TLS material when the listener terminates TLS.
   * @param {string} [config.tls.cert] - PEM certificate chain path.
   * @param {string} [config.tls.key] - PEM private key path.
   * @param {string} [config.version] - version published to links.
   * @param {string} [config.provider] - route override sent in `initialize`.
   * @param {string} [config.model] - model override sent in `initialize`.
   * @param {string} [config.cwd] - working-directory override sent in `initialize`.
   * @param {number} [config.maxTokens] - output cap sent in `initialize`.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, LinkSession>} */
    this.links = new Map()
    /** @type {import('node:net').Server | undefined} */
    this.server = undefined
    /** @type {{ close: () => Promise<void> } | undefined} */
    this.wsServer = undefined
    /** @type {{ peer: string, text: string, sessionId: string, at: number, read: boolean }[]} */
    this.inbox = []
    /** @type {Set<() => void>} */
    this.inboxWaiters = new Set()
    this.mirror = config.mirror === false
      ? undefined
      : new SessionMirror(ctx, { cwd: config.cwd ?? process.cwd(), logger: ctx.logger })
  }

  /** Bind the listener. Fails loud when a non-loopback bind has no token. */
  async start() {
    const { host, port } = this.config.listen
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
    if (!loopback && this.config.token.length === 0) {
      throw new Error(`peer hub: refusing to listen on ${host} without a token; set token or bind 127.0.0.1`)
    }
    this.server = this.config.tls === undefined
      ? createServer({ allowHalfOpen: false }, socket => this.#accept(socket, `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '')}`))
      : createTlsServer({
          cert: await readFile(this.config.tls.cert),
          key: await readFile(this.config.tls.key),
          allowHalfOpen: false,
        }, socket => this.#accept(socket, `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '')}`))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server?.off('error', reject)
        resolve(undefined)
      })
    })
    this.ctx.logger.info(`peer hub "${this.config.name}" listening on ${host}:${String(port)}`)
    if (this.config.wsListen !== undefined) {
      const ws = this.config.wsListen
      this.wsServer = await createWebSocketServer({
        host: ws.host,
        port: ws.port,
        path: ws.path,
        logger: this.ctx.logger,
        onConnection: (stream, remote) => this.#accept(stream, `${remote}`),
      })
    }
  }

  /** Stop accepting links and close every connection. */
  async stop() {
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise(resolve => server.close(() => resolve(undefined)))
    }
    for (const link of this.links.values()) link.conn.close()
    this.links.clear()
    const wsServer = this.wsServer
    this.wsServer = undefined
    if (wsServer !== undefined) await wsServer.close()
  }

  /** @returns {LinkSession[]} connected links in connection order. */
  list() {
    return [...this.links.values()]
  }

  /**
   * Resolve one connected link by name.
   * @param {string} name - link name, or a unique suffix of it.
   * @returns {LinkSession} the link.
   */
  require(name) {
    const exact = this.links.get(name)
    if (exact !== undefined) return exact
    const matches = this.list().filter(link => link.name.toLowerCase().includes(name.toLowerCase()))
    if (matches.length === 1) return /** @type {LinkSession} */ (matches[0])
    if (matches.length === 0) {
      const known = this.list().map(link => link.name).join(', ') || 'none'
      throw new Error(`no connected peer matches "${name}" (connected: ${known})`)
    }
    throw new Error(`peer name "${name}" is ambiguous: ${matches.map(link => link.name).join(', ')}`)
  }

  /**
   * Prompt a remote session and wait for its turn to finish.
   * @param {object} request - call options.
   * @param {string} request.peer - link name.
   * @param {string} request.prompt - text to send.
   * @param {string} [request.session] - stable conversation name.
   * @param {boolean} [request.fresh] - start a new conversation instead.
   * @param {number} [request.timeoutMs] - deadline.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<{ peer: string, sessionId: string, text: string, status: string, elapsedMs: number, timedOut: boolean }>} the turn result.
   */
  async ask(request) {
    const link = this.require(request.peer)
    const timeoutMs = request.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
    const sessionId = this.#sessionFor(link, request.session, request.fresh)
    const state = this.#state(link, sessionId)
    const startedAt = Date.now()
    const idleBefore = state.idleCount
    state.lastAssistant = ''
    state.receipts.clear()
    await this.#initialize(link)
    await this.#ensureSession(link, sessionId)
    const prompt = await link.conn.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: request.prompt }],
    }, { timeoutMs: 60_000, signal: request.signal })
    const messageId = /** @type {{ messageId?: string }} */ (prompt).messageId
    if (typeof messageId !== 'string') throw new Error('session/prompt returned no messageId')
    const finished = await this.#waitFor(state, () => state.idleCount > idleBefore, timeoutMs, request.signal)
    return {
      peer: link.name,
      sessionId,
      text: state.lastAssistant,
      status: finished ? state.lastTurnReason : 'running',
      elapsedMs: Date.now() - startedAt,
      timedOut: !finished,
    }
  }

  /**
   * Prompt a remote session without waiting for the turn.
   * @param {{ peer: string, prompt: string, session?: string, fresh?: boolean, signal?: AbortSignal }} request - call options.
   * @returns {Promise<{ peer: string, sessionId: string, messageId: string }>} the enqueue receipt.
   */
  async send(request) {
    const link = this.require(request.peer)
    const sessionId = this.#sessionFor(link, request.session, request.fresh)
    this.#state(link, sessionId)
    await this.#initialize(link)
    await this.#ensureSession(link, sessionId)
    const prompt = await link.conn.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: request.prompt }],
    }, { timeoutMs: 60_000 })
    const messageId = /** @type {{ messageId?: string }} */ (prompt).messageId
    if (typeof messageId !== 'string') throw new Error('session/prompt returned no messageId')
    return { peer: link.name, sessionId, messageId }
  }

  /**
   * Wait for the next unsolicited message from a link.
   * @param {{ peer?: string, timeoutMs?: number, signal?: AbortSignal }} [request] - filter and deadline.
   * @returns {Promise<{ messages: { peer: string, text: string, at: string }[], timedOut: boolean }>} unread messages.
   */
  async wait(request = {}) {
    const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const peer = request.peer
    if (this.#unread(peer).length === 0) {
      await this.#waitForInbox(peer, timeoutMs, request.signal)
    }
    const messages = this.#drainInbox(peer)
    return { messages, timedOut: messages.length === 0 }
  }

  /**
   * Read unread messages without waiting.
   * @param {{ peer?: string }} [request] - filter.
   * @returns {{ messages: { peer: string, text: string, at: string }[] }} unread messages.
   */
  readInbox(request = {}) {
    return { messages: this.#drainInbox(request.peer) }
  }

  /**
   * Ensure this link's harness accepted `initialize`.
   * @param {LinkSession} link - the link.
   * @returns {Promise<void>} readiness.
   */
  async #initialize(link) {
    if (link.ready) {
      return
    }
    link.initializing ??= (async () => {
      const info = link.info
      const cwd = this.config.cwd ?? (typeof info.cwd === 'string' && info.cwd.length > 0 ? info.cwd : '/')
      const provider = this.config.provider ?? (typeof info.provider === 'string' && info.provider.length > 0 ? info.provider : 'deepseek-official')
      const model = this.config.model ?? (typeof info.model === 'string' && info.model.length > 0 ? info.model : 'deepseek-v4-flash')
      await link.conn.request('initialize', {
        cwd,
        provider,
        model,
        ...this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens },
      }, { timeoutMs: 60_000 })
      link.ready = true
    })().finally(() => { link.initializing = undefined })
    try {
      await link.initializing
    } catch (error) {
      throw new Error(`peer "${link.name}" initialization failed: ${describeError(error)}`)
    }
  }

  /**
   * Attach an existing persisted session on this link before its first prompt.
   * A missing session is expected on first use; the following prompt creates it.
   * @param {LinkSession} link - target link.
   * @param {string} sessionId - wire session id.
   * @returns {Promise<void>} settlement after the attempt.
   */
  async #ensureSession(link, sessionId) {
    if (link.attached.has(sessionId)) return
    try {
      await link.conn.request('peer/ensure-session', { sessionId }, { timeoutMs: 30_000 })
    } catch (error) {
      this.ctx.logger.warn(`peer hub: attaching session ${sessionId} failed: ${describeError(error)}`)
    }
    link.attached.add(sessionId)
  }

  /**
   * Resolve the wire session id for one named conversation.
   * @param {LinkSession} link - target link.
   * @param {string | undefined} session - conversation name.
   * @param {boolean | undefined} fresh - force a new conversation.
   * @returns {string} wire session id.
   */
  #sessionFor(link, session, fresh) {
    if (fresh === true) return peerSessionId(link.name)
    if (session !== undefined && session.length > 0) return peerSessionId(link.name, session)
    const existing = [...link.sessions.keys()].find(id => id.startsWith(`peer-${link.name}-`))
    return existing ?? peerSessionId(link.name, 'default')
  }

  /**
   * Get or create the conversation state for a session.
   * @param {LinkSession} link - owning link.
   * @param {string} sessionId - wire session id.
   * @returns {SessionState} its state.
   */
  #state(link, sessionId) {
    let state = link.sessions.get(sessionId)
    if (state === undefined) {
      state = new SessionState()
      link.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * Wait until a conversation predicate holds.
   * @param {SessionState} state - conversation state.
   * @param {() => boolean} predicate - condition to observe.
   * @param {number} timeoutMs - deadline.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<boolean>} whether the condition held before the deadline.
   */
  #waitFor(state, predicate, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (reached, error) => {
        if (settled) return
        settled = true
        state.waiters.delete(check)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(reached)
      }
      const check = () => { if (predicate()) done(true, undefined) }
      const onAbort = () => done(false, signal?.reason instanceof Error ? signal.reason : new Error('peer request aborted'))
      const timer = setTimeout(() => done(false, undefined), timeoutMs)
      timer.unref?.()
      if (signal?.aborted === true) {
        done(false, new Error('peer request aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      state.waiters.add(check)
      check()
    })
  }

  /**
   * Wait for an unread message.
   * @param {string | undefined} peer - optional peer filter.
   * @param {number} timeoutMs - deadline.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<boolean>} whether a message arrived before the deadline.
   */
  #waitForInbox(peer, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (reached, error) => {
        if (settled) return
        settled = true
        this.inboxWaiters.delete(check)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(reached)
      }
      const check = () => { if (this.#unread(peer).length > 0) done(true, undefined) }
      const onAbort = () => done(false, signal?.reason instanceof Error ? signal.reason : new Error('peer wait aborted'))
      const timer = setTimeout(() => done(false, undefined), timeoutMs)
      timer.unref?.()
      if (signal?.aborted === true) {
        done(false, new Error('peer wait aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.inboxWaiters.add(check)
      check()
    })
  }

  /**
   * @param {string | undefined} peer - optional peer filter.
   * @returns {typeof this.inbox} unread entries.
   */
  #unread(peer) {
    return peer === undefined || peer.length === 0
      ? this.inbox.filter(entry => !entry.read)
      : this.inbox.filter(entry => !entry.read && entry.peer === peer)
  }

  /**
   * Mark matching entries read and return them.
   * @param {string | undefined} peer - optional peer filter.
   * @returns {{ peer: string, text: string, at: string }[]} drained messages.
   */
  #drainInbox(peer) {
    const unread = this.#unread(peer)
    for (const entry of unread) entry.read = true
    return unread.map(entry => ({ peer: entry.peer, text: entry.text, at: new Date(entry.at).toISOString() }))
  }

  /**
   * Accept one raw socket and run its handshake.
   * @param {import('node:net').Socket} socket - unauthenticated socket.
   */
  #accept(stream, remote) {
    const conn = new PeerConnection(stream, { label: `hub<-${remote}`, logger: this.ctx.logger })
    let link
    const timer = setTimeout(() => {
      conn.destroy(new Error('handshake timeout'))
    }, HANDSHAKE_TIMEOUT_MS)
    timer.unref?.()
    conn.onRequest(async (method, params) => {
      if (link === undefined) {
        if (method !== 'peer/hello') throw new Error('handshake required')
        const hello = readHello(params)
        if (!tokenMatches(this.config.token, hello.body.token)) {
          throw new Error('token rejected')
        }
        const existing = this.links.get(hello.name)
        if (existing !== undefined) {
          this.ctx.logger.warn(`peer hub: replacing existing link "${hello.name}"`)
          existing.conn.destroy(new Error('replaced by a newer connection'))
          this.links.delete(hello.name)
        }
        link = new LinkSession(conn, hello.body)
        this.links.set(link.name, link)
        clearTimeout(timer)
        this.ctx.logger.info(`peer hub: link "${link.name}" connected from ${remote}`)
        return {
          protocol: 1,
          hub: localIdentity({ name: this.config.name, role: 'hub', version: this.config.version ?? '0.1.0' }),
        }
      }
      return this.#handleRequest(link, method, params)
    })
    conn.onNotification((method, params) => {
      if (link !== undefined) this.onLinkNotification(link, method, params)
    })
    conn.onClose((reason) => {
      clearTimeout(timer)
      if (link !== undefined && this.links.get(link.name) === link) {
        this.links.delete(link.name)
        this.ctx.logger.warn(`peer hub: link "${link.name}" disconnected${reason === undefined ? '' : `: ${reason.message}`}`)
      }
    })
    conn.start()
  }

  /**
   * Serve requests the link initiator sends to this hub.
   * @param {LinkSession} link - the authenticated link.
   * @param {string} method - JSON-RPC method.
   * @param {Record<string, unknown>} params - request parameters.
   * @returns {Promise<unknown>} result.
   */
  async #handleRequest(link, method, params) {
    switch (method) {
      case 'peer/ping':
        return { at: Date.now() }
      case 'peer/info':
        return { hub: this.config.name, link: link.describe() }
      case 'peer/reply': {
        const text = typeof params.text === 'string' ? params.text : ''
        if (text.trim().length === 0) throw new Error('peer/reply requires non-empty text')
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
        this.inbox.push({ peer: link.name, text, sessionId, at: Date.now(), read: false })
        if (this.inbox.length > INBOX_LIMIT) this.inbox.splice(0, this.inbox.length - INBOX_LIMIT)
        for (const waiter of [...this.inboxWaiters]) waiter()
        return { accepted: true, at: Date.now() }
      }
      default:
        throw new Error(`hub does not serve "${method}"`)
    }
  }

  /**
   * Record a notification from a link.
   * @param {LinkSession} link - source link.
   * @param {string} method - notification method.
   * @param {Record<string, unknown>} params - payload.
   */
  onLinkNotification(link, method, params) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (sessionId === undefined) return
    const state = link.sessions.get(sessionId)
    if (state === undefined) return
    if (method === 'session.status') {
      if (params.status === 'running') {
        state.status = 'running'
      } else if (params.status === 'idle') {
        state.status = 'idle'
        state.idleCount += 1
        state.wake()
      }
      return
    }
    if (method !== 'session.event') return
    const event = /** @type {Record<string, unknown> | undefined} */ (params.event)
    if (event !== undefined) this.mirror?.append(link.name, sessionId, /** @type {any} */ (event))
    if (event === undefined || typeof event.type !== 'string') return
    if (event.type === 'agent/inbox/spliced') {
      const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      for (const message of inserted) {
        if (message !== null && typeof message === 'object' && typeof message.id === 'string') {
          state.receipts.add(message.id)
        }
      }
      state.wake()
      return
    }
    if (event.type === 'assistant/message') {
      const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
      const message = /** @type {Record<string, unknown>} */ (data.message ?? {})
      const content = Array.isArray(message.content) ? message.content : []
      state.lastAssistant = content
        .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
        .map(block => String(/** @type {{ text?: unknown }} */ (block).text ?? ''))
        .join('')
      return
    }
    if (event.type === 'turn/end') {
      const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
      const reason = /** @type {Record<string, unknown>} */ (data.reason ?? {})
      state.lastTurnReason = typeof reason.kind === 'string' ? reason.kind : 'unknown'
      state.wake()
    }
  }
}

/**
 * Read a PEM file for TLS material.
 * @param {string} path - file path.
 * @returns {Promise<Buffer>} file contents.
 */
async function readFile(path) {
  const { readFile: read } = await import('node:fs/promises')
  return read(path)
}
