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

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { PeerConnection, HANDSHAKE_TIMEOUT_MS, PEER_VERSION, describeError, localIdentity, peerSessionId, readHello, tokenMatches } from './protocol.js'
import { createWebSocketServer } from './ws.js'
import { pickerHtml } from './activity.js'
import { SessionMirror } from './mirror.js'

/** Compare dotted versions; missing components count as zero. */
function versionAtLeast(version, minimum) {
  const parse = value => String(value ?? '').split('.').map(part => Number.parseInt(part, 10)).filter(Number.isFinite)
  const left = parse(version)
  const right = parse(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

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
    /** Recent steer/cancel timestamps for rate limiting. */
    this.steerTimes = []
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
    this.mirrorCwd = undefined
    /** Local session that most recently asked this remote session. */
    this.callerSessionId = undefined
    this.lastAssistant = ''
    this.lastTurnReason = ''
    this.status = 'idle'
    this.idleCount = 0
    /** @type {Set<string>} */
    this.receipts = new Set()
    /** @type {Set<() => void>} */
    this.waiters = new Set()
    /** Local session that most recently talked to any peer; wake fallback. */
    this.lastCallerSessionId = undefined
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
    /** Unbound messages waiting for the user to choose a session. */
    this.pending = []
    /** Sessions awaiting an auto-reply back to the link that messaged them. */
    this.pendingReplies = new Map()
    /** Synchronous asks waiting for their target turn to finish. */
    this.waiters = new Map()
    /** @type {import('node:http').Server | undefined} */
    this.apiServer = undefined
    this.pendingCounter = 0
    /** @type {Set<() => void>} */
    this.inboxWaiters = new Set()
    this.mirror = config.mirror === false
      ? undefined
      : new SessionMirror(ctx, {
          cwd: config.cwd ?? process.cwd(),
          workspacePath: config.mirrorWorkspace,
          logger: ctx.logger,
        })
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
    await this.#loadPending()
    this.ctx.on?.('session/event', (session, event) => {
      const waiter = this.waiters.get(String(session.id))
      if (waiter !== undefined) {
        if (event.type === 'turn/start' && waiter.phase === 'await') {
          waiter.phase = 'turn'
          waiter.sinceSeq = event.seq
          return
        }
        if (event.type === 'turn/end' && waiter.phase === 'turn') {
          this.waiters.delete(String(session.id))
          clearTimeout(waiter.timer)
          waiter.resolve(this.#collectText(session, waiter.sinceSeq))
          return
        }
      }
      const pending = this.pendingReplies.get(String(session.id))
      if (pending === undefined) return
      if (event.type === 'turn/start') {
        if (pending.phase === 'await') {
          pending.phase = 'turn'
          pending.sinceSeq = event.seq
        }
        return
      }
      if (event.type !== 'turn/end' || pending.phase !== 'turn') return
      this.pendingReplies.delete(String(session.id))
      void this.#sendReply(pending, session)
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
        onRequest: (request, response) => {
          const url = new URL(request.url ?? '/', 'http://placeholder')
          if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            response.end(pickerHtml(this.config.apiToken ?? this.config.token))
            return
          }
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found\n')
        },
      })
    }
    if (this.config.apiListen !== undefined) {
      const api = this.config.apiListen
      this.apiServer = createHttpServer((request, response) => {
        void this.#handleApi(request, response).catch(error => {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        })
      })
      await new Promise((resolve, reject) => {
        this.apiServer.once('error', reject)
        this.apiServer.listen(api.port, api.host, () => {
          this.apiServer?.off('error', reject)
          resolve(undefined)
        })
      })
      this.ctx.logger.info(`peer hub api listening on ${api.host}:${String(api.port)}`)
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
    const apiServer = this.apiServer
    this.apiServer = undefined
    if (apiServer !== undefined) await new Promise(resolve => apiServer.close(() => resolve(undefined)))
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
   * @param {string} [request.mirrorCwd] - local session cwd the mirror should adopt.
   * @param {number} [request.timeoutMs] - deadline.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<{ peer: string, sessionId: string, text: string, status: string, elapsedMs: number, timedOut: boolean }>} the turn result.
   */
  async ask(request) {
    const link = this.require(request.peer)
    const timeoutMs = request.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
    const sessionId = typeof request.remoteSessionId === 'string' && request.remoteSessionId.length > 0
      ? request.remoteSessionId
      : this.#sessionFor(link, request.session, request.fresh)
    const state = this.#state(link, sessionId)
    if (typeof request.mirrorCwd === 'string' && request.mirrorCwd.length > 0) state.mirrorCwd = request.mirrorCwd
    if (typeof request.callerSessionId === 'string' && request.callerSessionId.length > 0) {
      state.callerSessionId = request.callerSessionId
      this.lastCallerSessionId = request.callerSessionId
    }
    const startedAt = Date.now()
    const idleBefore = state.idleCount
    state.lastAssistant = ''
    state.receipts.clear()
    await this.#initialize(link)
    await this.#prepareSession(link, sessionId, request.remoteDir)
    await this.#ensureSession(link, sessionId)
    await this.#applyRemoteDir(link, sessionId, request.remoteDir)
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
    const sessionId = typeof request.remoteSessionId === 'string' && request.remoteSessionId.length > 0
      ? request.remoteSessionId
      : this.#sessionFor(link, request.session, request.fresh)
    const state = this.#state(link, sessionId)
    if (typeof request.callerSessionId === 'string' && request.callerSessionId.length > 0) {
      state.callerSessionId = request.callerSessionId
      this.lastCallerSessionId = request.callerSessionId
    }
    await this.#initialize(link)
    await this.#prepareSession(link, sessionId, request.remoteDir)
    await this.#ensureSession(link, sessionId)
    await this.#applyRemoteDir(link, sessionId, request.remoteDir)
    const blocks = [{ type: 'text', text: request.prompt }]
    let prompt
    try {
      prompt = await link.conn.request('session/steer', { sessionId, contentBlocks: blocks }, { timeoutMs: 15_000 })
    } catch {
      prompt = await link.conn.request('session/prompt', { sessionId, contentBlocks: blocks }, { timeoutMs: 60_000 })
    }
    const messageId = /** @type {{ messageId?: string }} */ (prompt).messageId
    if (typeof messageId !== 'string') throw new Error('session/prompt returned no messageId')
    return { peer: link.name, sessionId, messageId }
  }

  /**
   * Inject a message into a running turn, or queue it as the next turn when
   * the link is idle. Links older than 0.3.0 have no steer method, so they
   * degrade to an ordinary queued prompt.
   * @param {{ peer: string, text: string, session?: string }} request - call options.
   * @returns {Promise<{ peer: string, sessionId: string, mode: 'steer' | 'prompt', accepted: boolean, messageId: string }>} delivery mode and receipt.
   */
  async steer(request) {
    const link = this.require(request.peer)
    this.#limitSteer(link)
    const sessionId = this.#sessionFor(link, request.session, false)
    const state = this.#state(link, sessionId)
    const contentBlocks = [{ type: 'text', text: request.text }]
    await this.#applyRemoteDir(link, sessionId, request.remoteDir)
    if (!this.#supportsSteer(link)) {
      const prompt = await link.conn.request('session/prompt', { sessionId, contentBlocks }, { timeoutMs: 60_000 })
      return { peer: link.name, sessionId, mode: 'prompt', accepted: true, messageId: String(prompt.messageId ?? '') }
    }
    if (state.status === 'running') {
      const result = await link.conn.request('session/steer', { sessionId, contentBlocks }, { timeoutMs: 15_000 })
      return { peer: link.name, sessionId, mode: 'steer', accepted: result.accepted === true, messageId: String(result.messageId ?? '') }
    }
    const prompt = await link.conn.request('session/prompt', { sessionId, contentBlocks }, { timeoutMs: 60_000 })
    return { peer: link.name, sessionId, mode: 'prompt', accepted: true, messageId: String(prompt.messageId ?? '') }
  }

  /**
   * Abort the link's current activity while keeping queued messages.
   * @param {{ peer: string, session?: string, reason?: string }} request - call options.
   * @returns {Promise<{ peer: string, sessionId: string, cancelled: boolean }>} whether a turn was active.
   */
  async cancel(request) {
    const link = this.require(request.peer)
    this.#limitSteer(link)
    if (!this.#supportsSteer(link)) throw new Error('peer does not support cancel (link version is older than 0.3.0)')
    const sessionId = this.#sessionFor(link, request.session, false)
    const state = this.#state(link, sessionId)
    if (state.status !== 'running') return { peer: link.name, sessionId, cancelled: false }
    const result = await link.conn.request('session/cancel', { sessionId, reason: request.reason ?? '' }, { timeoutMs: 15_000 })
    return { peer: link.name, sessionId, cancelled: result.cancelled === true }
  }

  /**
   * Tell the link which directory a not-yet-created session should adopt, so
   * its header cwd (and therefore its workspace visibility) matches the choice.
   * @param {LinkSession} link - target link.
   * @param {string} sessionId - remote session id.
   * @param {string | undefined} dir - chosen directory.
   * @returns {Promise<void>} settlement; older links are ignored.
   */
  async #prepareSession(link, sessionId, dir) {
    if (typeof dir !== 'string' || dir.length === 0) return
    try {
      await link.conn.request('peer/prepare-session', { sessionId, cwd: dir }, { timeoutMs: 10_000 })
    } catch {
      // Links without the method still get the working-directory change.
    }
  }

  /**
   * Point one remote session at a workspace directory before the next turn.
   * @param {LinkSession} link - target link.
   * @param {string} sessionId - remote session id.
   * @param {string | undefined} dir - absolute directory, or undefined to keep it.
   * @returns {Promise<void>} settlement after the remote accepted the path.
   */
  async #applyRemoteDir(link, sessionId, dir) {
    if (typeof dir !== 'string' || dir.length === 0) return
    try {
      await link.conn.request('session/working-directory/set', { sessionId, path: dir, createDir: true }, { timeoutMs: 15_000 })
    } catch {
      // A session that does not exist yet takes its cwd from peer/prepare-session.
    }
  }

  /**
   * List the remote workspace and the sessions the hub has used with it.
   * @param {string} peer - link name.
   * @returns {{ peer: string, cwd: string, sessions: string[] }} target options.
   */
  async targets(peer) {
    const link = this.require(peer)
    let workspaces = []
    try {
      const result = await link.conn.request('peer/workspaces', {}, { timeoutMs: 10_000 })
      if (Array.isArray(result?.workspaces)) {
        workspaces = result.workspaces
          .filter(entry => entry !== null && typeof entry === 'object')
          .map(entry => ({ path: String(entry.path ?? ''), title: String(entry.title ?? '') }))
      }
    } catch {
      // Older links have no workspaces method; the default cwd still works.
    }
    let sessions = []
    try {
      const result = await link.conn.request('peer/sessions', {}, { timeoutMs: 10_000 })
      if (Array.isArray(result?.sessions)) {
        sessions = result.sessions
          .filter(entry => entry !== null && typeof entry === 'object')
          .map(entry => ({
            id: String(entry.id ?? ''),
            cwd: String(entry.cwd ?? ''),
            title: String(entry.title ?? ''),
            createdAt: Number(entry.createdAt ?? 0),
          }))
          .filter(entry => entry.id.length > 0)
      }
    } catch {
      // Older links only know what the hub already asked for.
    }
    if (sessions.length === 0) sessions = [...link.sessions.keys()].map(id => ({ id, cwd: '', title: '', createdAt: 0 }))
    return {
      peer: link.name,
      cwd: String(link.info?.cwd ?? ''),
      workspaces,
      sessions,
    }
  }

  /**
   * Whether the link implements the 0.3.0 steer/cancel methods.
   * @param {LinkSession} link - target link.
   * @returns {boolean} true when supported.
   */
  #supportsSteer(link) {
    return versionAtLeast(link.info?.version, '0.3.0')
  }

  /**
   * Enforce a per-link steer/cancel budget.
   * @param {LinkSession} link - target link.
   * @returns {void}
   */
  #limitSteer(link) {
    const now = Date.now()
    link.steerTimes = link.steerTimes.filter(at => now - at < 60_000)
    const limit = this.config.steerPerMinute ?? 20
    if (link.steerTimes.length >= limit) {
      throw new Error(`peer steer rate limit: ${limit} calls per minute for "${link.name}"`)
    }
    link.steerTimes.push(now)
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
          hub: localIdentity({ name: this.config.name, role: 'hub', version: this.config.version ?? PEER_VERSION }),
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
      case 'peer/targets':
        return {
          workspaces: this.#localWorkspaces(),
          sessions: await this.#sessionsView(),
        }
      case 'peer/reply': {
        const text = typeof params.text === 'string' ? params.text : ''
        if (text.trim().length === 0) throw new Error('peer/reply requires non-empty text')
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
        const targetSessionId = typeof params.targetSessionId === 'string' ? params.targetSessionId : ''
        if (targetSessionId.length > 0) {
          const target = await this.#ensureAgent(targetSessionId)
          if (target !== undefined && typeof target.followup === 'function') {
            if (params.wait === true) {
              const reply = await this.#waitForTurn(targetSessionId, target.session.seq)
              return { accepted: true, at: Date.now(), delivered: true, reply }
            }
            this.pendingReplies.set(targetSessionId, { link, remoteSessionId: sessionId, sinceSeq: target.session.seq, phase: 'await' })
            const deliver = target.status === 'idle' ? 'followup' : 'steer'
            if (deliver === 'steer') this.pendingReplies.set(targetSessionId, { link, remoteSessionId: sessionId, sinceSeq: target.session.seq, phase: 'turn' })
            target[deliver]({
              id: `peer-message-${randomUUID()}`,
              role: 'user',
              content: [{ type: 'text', text: `[peer ${link.name}] ${text}` }],
              source: { kind: 'user' },
            })
            return { accepted: true, at: Date.now(), delivered: true }
          }
        }
        this.inbox.push({ peer: link.name, text, sessionId, at: Date.now(), read: false })
        if (this.inbox.length > INBOX_LIMIT) this.inbox.splice(0, this.inbox.length - INBOX_LIMIT)
        for (const waiter of [...this.inboxWaiters]) waiter()
        if ((this.config.bindMode ?? 'auto') === 'picker') {
          this.pending.push({
            id: `pending-${++this.pendingCounter}`,
            peer: link.name,
            remoteSessionId: sessionId,
            workspace: String(link.info?.cwd ?? ''),
            text,
            at: Date.now(),
          })
          if (this.pending.length > INBOX_LIMIT) this.pending.splice(0, this.pending.length - INBOX_LIMIT)
          const entry = this.pending[this.pending.length - 1]
          this.#savePending()
          const noticed = await this.#notifyPending(link, entry)
          return { accepted: true, at: Date.now(), delivered: noticed, pending: true }
        }
        const delivered = await this.#deliverToAgent(link, sessionId, text)
        return { accepted: true, at: Date.now(), delivered }
      }
      default:
        throw new Error(`hub does not serve "${method}"`)
    }
  }

  /**
   * Session ids sorted by their log mtime, newest first. Used as a wake
   * fallback when no caller was recorded (for example after a hub restart).
   * @returns {Promise<string[]>} recent session ids.
   */
  async #recentSessionIds() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const root = join(home, 'sessions')
    const rows = []
    try {
      for (const project of await readdir(root)) {
        const projectDir = join(root, project)
        for (const id of await readdir(projectDir)) {
          if (!id.startsWith('session-') && !id.startsWith('peer-')) continue
          try {
            const info = await stat(join(projectDir, id, 'session.v4.jsonl.zstd'))
            rows.push({ id, at: info.mtimeMs })
          } catch {
            // A session without the current log file is skipped.
          }
        }
      }
    } catch {
      return []
    }
    return rows.sort((a, b) => b.at - a.at).slice(0, 10).map(row => row.id)
  }

  /**
   * Wake the current local session so its agent can ask the user where the
   * pending message belongs. The notice is user-role text because the runtime
   * only injects user messages; it names the pending id and the expected tools.
   * @param {LinkSession} link - source link.
   * @param {{ id: string, text: string }} entry - pending entry.
   * @returns {boolean} whether a live agent was woken.
   */
  async #notifyPending(link, entry) {
    const agents = this.ctx.get?.('agents')
    let target = this.lastCallerSessionId
    let agent = target === undefined ? undefined : agents?.get?.(target)
    if (agent === undefined) {
      for (const candidate of await this.#recentSessionIds()) {
        const live = agents?.get?.(candidate)
        if (live !== undefined) {
          target = candidate
          agent = live
          break
        }
      }
    }
    if (agent === undefined || typeof agent.followup !== 'function') return false
    const preview = entry.text.length > 300 ? `${entry.text.slice(0, 300)}…` : entry.text
    try {
      agent.followup({
        id: `peer-message-${randomUUID()}`,
        role: 'user',
        content: [{
          type: 'text',
          text: `[peer ${link.name} · 远端会话 ${entry.remoteSessionId}${entry.workspace === '' ? '' : ` · 工作区 ${entry.workspace}`}] 有一条待绑定消息（id=${entry.id}）：\n${preview}\n\n`
            + '请不要直接处理它。先用 peer_pending 确认该 id 仍存在：\n'
            + '- 存在：用 ask_user_question 让用户选择「放到哪个本地会话」或「新建会话」，再用 peer_bind 绑定；\n'
            + '- 不存在：说明已被绑定，直接回复「已处理」并结束，不要再次提问。',
        }],
        source: { kind: 'user' },
      })
      return true
    } catch (error) {
      this.ctx.logger.warn(`peer hub: could not notify ${String(target)}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Serve the small binding API used by the GUI picker.
   * @param {import('node:http').IncomingMessage} request - HTTP request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @returns {Promise<void>} settlement after the response is written.
   */
  async #handleApi(request, response) {
    const url = new URL(request.url ?? '/', 'http://placeholder')
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/index.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(pickerHtml(url.searchParams.get('token') ?? ''))
      return
    }
    const token = this.config.apiToken ?? this.config.token
    if (url.searchParams.get('token') !== token) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'bad token' }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/pending') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, pending: this.pending, sessions: this.#localSessions() }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/bind') {
      const body = await new Promise((resolve, reject) => {
        let data = ''
        request.on('data', chunk => { data += chunk })
        request.on('end', () => {
          try { resolve(data.length === 0 ? {} : JSON.parse(data)) } catch (error) { reject(error) }
        })
        request.on('error', reject)
      })
      const result = await this.bind(body)
      response.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'not found' }))
  }

  /**
   * Local sessions offered to the picker.
   * @returns {{ id: string, workspace: string }[]} session ids grouped by workspace path.
   */
  #localSessions() {
    const registry = this.ctx.get?.('workspaceRegistry')
    if (registry === undefined) return []
    const sessions = []
    for (const workspace of registry.list()) {
      for (const sessionId of workspace.sessionIds) sessions.push({ id: String(sessionId), workspace: String(workspace.path) })
    }
    return sessions
  }

  /**
   * Durable location of the pending queue.
   * @returns {string} absolute file path.
   */
  #pendingPath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'peer-pending.json')
  }

  /**
   * Restore pending messages saved by a previous process.
   * @returns {Promise<void>} settlement after the read attempt.
   */
  async #loadPending() {
    try {
      const raw = JSON.parse(await readFile(this.#pendingPath(), 'utf8'))
      if (!Array.isArray(raw)) return
      this.pending = raw
        .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
        .map(entry => ({ ...entry, workspace: typeof entry.workspace === 'string' ? entry.workspace : '' }))
      this.pendingCounter = this.pending.reduce((max, entry) => {
        const value = Number.parseInt(String(entry.id).replace('pending-', ''), 10)
        return Number.isFinite(value) && value > max ? value : max
      }, 0)
    } catch {
      // Missing or malformed file just means an empty queue.
    }
  }

  /**
   * Persist the pending queue; failures leave the in-memory copy authoritative.
   * @returns {void}
   */
  #savePending() {
    void writeFile(this.#pendingPath(), JSON.stringify(this.pending, null, 2)).catch(() => {})
  }

  /**
   * Workspaces registered in the hub profile, offered to a link that wants to
   * choose a target session before sending.
   * @returns {{ path: string, title: string }[]} registered workspaces.
   */
  #localWorkspaces() {
    const registry = this.ctx.get?.('workspaceRegistry')
    if (registry === undefined) return []
    return registry.list().map(workspace => ({ path: String(workspace.path), title: String(workspace.title ?? '') }))
  }

  /**
   * List the hub's sessions with titles, for the initiator's picker.
   * @returns {Promise<{ id: string, cwd: string, title: string, createdAt: number }[]>} recent sessions.
   */
  async #sessionsView() {
    const byId = new Map()
    const agents = this.ctx.get?.('agents')
    const titles = this.ctx.get?.('sessionTitle')
    for (const entry of this.#localSessions()) {
      const agent = agents?.get?.(entry.id)
      const session = agent?.session
      let title = ''
      try { title = String(titles?.get?.(session)?.title ?? '') } catch { /* best effort */ }
      byId.set(entry.id, {
        id: entry.id,
        cwd: String(session?.header?.cwd ?? entry.workspace ?? ''),
        title,
        createdAt: Number(session?.header?.createdAt ?? 0),
      })
    }
    const persistence = this.ctx.get?.('sessionPersistence')
    const cache = this.ctx.get?.('sessionProjectionCache')
    if (persistence !== undefined) {
      try {
        for (const snapshot of await persistence.list()) {
          const id = String(snapshot?.header?.id ?? '')
          if (id.length === 0 || byId.has(id)) continue
          let title = ''
          try {
            const block = cache?.cachedSnapshot(snapshot.header) ?? cache?.cachedPredecessorTitle(snapshot.header)
            const value = block?.values?.title
            if (typeof value === 'string') title = value
          } catch { /* no cached title */ }
          byId.set(id, { id, cwd: String(snapshot.header?.cwd ?? ''), title, createdAt: Number(snapshot.header?.createdAt ?? 0) })
        }
      } catch { /* listing is best-effort */ }
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
  }

  /**
   * Read the pending queue and the sessions offered by the picker.
   * @returns {{ pending: { id: string, peer: string, remoteSessionId: string, text: string, at: number }[], sessions: { id: string, workspace: string }[] }} pending view.
   */
  pendingView() {
    return { pending: [...this.pending], sessions: this.#localSessions() }
  }

  /**
   * Deliver one pending message to a chosen local session, creating one when asked.
   * @param {{ id?: string, sessionId?: string, create?: boolean }} request - picker choice.
   * @returns {Promise<{ ok: boolean, sessionId?: string, error?: string }>} result.
   */
  async bind(request) {
    const id = typeof request.id === 'string' ? request.id : ''
    const index = this.pending.findIndex(entry => entry.id === id)
    if (index < 0) return { ok: false, error: `unknown pending message: ${id}` }
    const entry = this.pending[index]
    const text = `[peer ${entry.peer}] ${entry.text}`
    if (request.create === true) {
      const sessions = this.ctx.get?.('sessions')
      const agents = this.ctx.get?.('agents')
      if (sessions === undefined || agents === undefined) return { ok: false, error: 'host cannot create sessions' }
      const sessionId = `peer-inbox-${randomUUID().slice(0, 8)}`
      const baseCwd = this.config.cwd ?? process.cwd()
      try {
        const registry = this.ctx.get?.('workspaceRegistry')
        const workspace = registry?.list().find(candidate => candidate.path === baseCwd) ?? registry?.list()[0]
        const cwd = workspace?.path ?? baseCwd
        const agentOptions = typeof this.config.provider === 'string' && this.config.provider.length > 0
          && typeof this.config.model === 'string' && this.config.model.length > 0
          ? { provider: this.config.provider, model: this.config.model }
          : undefined
        const handle = await agents.create({
          sessionId,
          meta: { cwd },
          ...agentOptions === undefined ? {} : { agentOptions },
        })
        if (workspace !== undefined) await workspace.attachSession(sessionId)
        handle.agent.followup({ id: `peer-message-${randomUUID()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
        this.pending.splice(index, 1)
        this.#savePending()
        this.ctx.get('sessionTitle')?.rename?.(handle.agent.session, `Peer: ${entry.peer}`)
        return { ok: true, sessionId }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
    const agent = this.ctx.get?.('agents')?.get?.(sessionId)
    if (agent === undefined) return { ok: false, error: `session is not live: ${sessionId}` }
    try {
      agent.followup({ id: `peer-message-${randomUUID()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      this.pending.splice(index, 1)
      this.#savePending()
      return { ok: true, sessionId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Concatenate the text blocks of the assistant messages after a sequence.
   * @param {any} session - session to read.
   * @param {number} sinceSeq - last sequence before the turn.
   * @returns {string} joined assistant text.
   */
  #collectText(session, sinceSeq) {
    const parts = []
    try {
      for (let seq = sinceSeq + 1; seq <= session.seq; seq++) {
        const event = session.eventAt(seq)
        if (event === undefined || event.type !== 'assistant/message') continue
        const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
        for (const block of content) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
      }
    } catch {
      // A missing event just yields an empty reply.
    }
    return parts.join('').trim()
  }

  /**
   * Wait for the turn that the peer message starts, then return its text.
   * @param {string} sessionId - target local session.
   * @param {number} sinceSeq - sequence before delivery.
   * @returns {Promise<string | undefined>} the reply text, or undefined on timeout.
   */
  #waitForTurn(sessionId, sinceSeq) {
    return new Promise(resolve => {
      const waiter = {
        phase: 'await',
        sinceSeq,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(sessionId)
          resolve(undefined)
        }, 120_000),
      }
      this.waiters.set(sessionId, waiter)
    })
  }

  /**
   * Push the finished turn's assistant text back to the link that asked, so the
   * initiator receives a result without the hub agent remembering to reply.
   * @param {{ link: LinkSession, remoteSessionId: string, sinceSeq: number }} pending - delivery record.
   * @param {any} session - finished local session.
   * @returns {Promise<void>} settlement after the push attempt.
   */
  async #sendReply(pending, session) {
    const logPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'peer-push.log')
    const note = async (line) => { try { await appendFile(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* best effort */ } }
    const link = this.links.get(pending.link.name)
    if (link === undefined || link !== pending.link || link.conn === undefined) {
      await note(`skip: no live link (${pending.link.name})`)
      return
    }
    const text = this.#collectText(session, pending.sinceSeq)
    if (text.length === 0) {
      await note(`skip: empty text (${pending.remoteSessionId})`)
      return
    }
    const contentBlocks = [{ type: 'text', text: `[hub] ${text}\n\n（hub 已完成这一轮，直接继续即可，不需要轮询。）` }]
    try {
      await this.#initialize(link)
    } catch {
      // An older link may reject initialize; the steer attempt reports the real error.
    }
    try {
      await link.conn.request('session/steer', { sessionId: pending.remoteSessionId, contentBlocks }, { timeoutMs: 15_000 })
      await note(`pushed steer ${pending.remoteSessionId} bytes=${text.length}`)
      return
    } catch {
      // Not open in the link (or steer unsupported); fall back to a prompt.
    }
    try {
      await link.conn.request('session/prompt', { sessionId: pending.remoteSessionId, contentBlocks }, { timeoutMs: 60_000 })
      await note(`pushed prompt ${pending.remoteSessionId} bytes=${text.length}`)
    } catch (error) {
      await note(`failed ${pending.remoteSessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Resolve the hub-owned inbox agent that receives peer messages when no
   * user session can be woken. The hub owns this session, so it is visible to
   * the hub's own agent registry.
   * @returns {Promise<any | undefined>} the inbox agent.
   */
  async #inboxAgent() {
    const agents = this.ctx.get?.('agents')
    if (agents === undefined) return undefined
    const sessionId = 'peer-inbox'
    const live = agents.get?.(sessionId)
    if (live !== undefined) return live
    const agentOptions = typeof this.config.provider === 'string' && this.config.provider.length > 0
      && typeof this.config.model === 'string' && this.config.model.length > 0
      ? { provider: this.config.provider, model: this.config.model }
      : undefined
    const registry = this.ctx.get?.('workspaceRegistry')
    const workspace = registry?.list()?.[0]
    const cwd = workspace?.path ?? this.config.cwd ?? process.cwd()
    try {
      const handle = await agents.create({
        sessionId,
        meta: { cwd },
        ...agentOptions === undefined ? {} : { agentOptions },
      })
      if (workspace !== undefined) await workspace.attachSession(sessionId)
      try { this.ctx.get?.('sessionTitle')?.rename?.(handle.agent.session, 'Peer Inbox') } catch { /* best effort */ }
      return handle.agent
    } catch {
      try {
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          ...agentOptions === undefined ? {} : { agentOptions },
        })
        return handle.agent
      } catch {
        return undefined
      }
    }
  }

  /**
   * Resolve a live agent for one local session, resuming it when the session
   * is persisted but no turn is running. Agents exist only while their driver
   * runs, so an idle session has no agent until it is resumed.
   * @param {string} sessionId - local session id.
   * @returns {Promise<any | undefined>} the agent, or undefined when unavailable.
   */
  async #ensureAgent(sessionId) {
    const agents = this.ctx.get?.('agents')
    let live = agents?.get?.(sessionId)
    if (live === undefined) {
      try {
        const resolved = await agents?.resolveAgent?.(sessionId)
        if (resolved !== undefined && resolved !== null && resolved.agent !== undefined) live = resolved.agent
      } catch {
        // Fall through to resume/create.
      }
    }
    if (live !== undefined) return live
    const agentOptions = typeof this.config.provider === 'string' && this.config.provider.length > 0
      && typeof this.config.model === 'string' && this.config.model.length > 0
      ? { provider: this.config.provider, model: this.config.model }
      : undefined
    try {
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...agentOptions === undefined ? {} : { agentOptions },
      })
      return handle.agent
    } catch {
      return undefined
    }
  }

  /**
   * Deliver an unsolicited message to the local agent that last asked this
   * remote session, waking it with a new turn. Without this the message only
   * lands in the inbox, which the local agent sees only while it is waiting.
   * @param {LinkSession} link - source link.
   * @param {string} sessionId - remote session id the link replied on.
   * @param {string} text - message body.
   * @returns {boolean} whether a live local agent was woken.
   */
  async #deliverToAgent(link, sessionId, text) {
    const state = link.sessions.get(sessionId)
    const callerSessionId = state?.callerSessionId ?? this.lastCallerSessionId
    const candidates = callerSessionId === undefined ? [] : [callerSessionId]
    candidates.push(...await this.#recentSessionIds())
    let agent
    for (const candidate of candidates) {
      agent = await this.#ensureAgent(candidate)
      if (agent !== undefined && typeof agent.followup === 'function') break
    }
    if (agent === undefined || typeof agent.followup !== 'function') agent = await this.#inboxAgent()
    if (agent === undefined || typeof agent.followup !== 'function') return false
    try {
      const localSessionId = String(agent.session.id)
      const message = {
        id: `peer-message-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: `[peer ${link.name}] ${text}\n\n（本轮结束后，你的最终回复会自动回传给 ${link.name}，直接给出结果即可。）` }],
        source: { kind: 'user' },
      }
      const deliver = agent.status === 'idle' ? 'followup' : 'steer'
      this.pendingReplies.set(localSessionId, {
        link,
        remoteSessionId: sessionId,
        sinceSeq: agent.session.seq,
        phase: deliver === 'steer' ? 'turn' : 'await',
      })
      agent[deliver](message)
      return true
    } catch (error) {
      this.ctx.logger.warn(`peer hub: could not wake ${String(callerSessionId)}: ${error instanceof Error ? error.message : String(error)}`)
      return false
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
    if (event !== undefined) this.mirror?.append(link.name, sessionId, /** @type {any} */ (event), state.mirrorCwd)
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
