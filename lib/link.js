/**
 * Link role: dial one hub and serve that hub this harness.
 *
 * The link is the TCP client but the JSON-RPC server for harness methods, so
 * a machine behind NAT can join a publicly reachable hub. After the token
 * handshake the link answers the same methods as the stdio SDK server and
 * forwards this runtime's session events back; `peer/reply` is the only
 * method the hub serves for the link. A dropped link reconnects with backoff
 * and keeps its persisted sessions, so conversations survive a hub restart.
 *
 * @module @local/dsh-peer/link
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { PeerHarnessServer } from './link-server.js'
import { PeerConnection, describeError, localIdentity } from './protocol.js'
import { connectWebSocket } from './ws.js'

/** Initial reconnect delay. */
const RECONNECT_MIN_MS = 1_000

/** Reconnect delay ceiling. */
const RECONNECT_MAX_MS = 30_000

/** Handshake attempts refused for a bad token before the loop stops. */
const MAX_AUTH_FAILURES = 3

/**
 * One outbound link with a single live connection at a time.
 */
export class PeerLink {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host context that owns agents and sessions.
   * @param {object} config - resolved deployment configuration.
   * @param {string} config.name - link name published to the hub.
   * @param {string} config.url - `tcp://host:port`, `tls://host:port`, `ws://host:port/path` or `wss://...`.
   * @param {string} config.token - shared secret.
   * @param {string} [config.cwd] - working directory published to the hub.
   * @param {string} [config.provider] - route this harness prefers.
   * @param {string} [config.model] - model this harness prefers.
   * @param {string} [config.version] - version published to the hub.
   * @param {string} [config.agentPreset] - agent preset peer sessions join; omitted uses the registry default.
   * @param {object} [config.tls] - client TLS material (`ca`, `cert`, `key` paths) and `rejectUnauthorized`.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {PeerConnection | undefined} */
    this.conn = undefined
    /** @type {PeerHarnessServer | undefined} */
    this.server = undefined
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.retryTimer = undefined
    this.attempt = 0
    this.authFailures = 0
    this.stopped = false
    this.connectedAt = undefined
    this.hubInfo = undefined
    /** @type {import('node:net').Socket | undefined} */
    this.socket = undefined
  }

  /** Start the connect loop. */
  start() {
    if (this.stopped) return
    if (this.ctx.get('agents') === undefined) {
      throw new Error('peer link requires the agents service; mount it in a profile that composes an agent runtime')
    }
    void this.#connect()
  }

  /** Stop reconnecting and drop the live connection. */
  stop() {
    this.stopped = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    void this.#release()
    this.socket?.destroy()
    this.socket = undefined
    this.conn?.close()
    this.conn = undefined
  }

  /** @returns {{ connected: boolean, hub?: string, url: string, name: string, since?: string, attempt: number }} connection status. */
  status() {
    return {
      connected: this.conn !== undefined,
      hub: this.hubInfo === undefined ? undefined : String(this.hubInfo.name ?? ''),
      url: this.config.url,
      name: this.config.name,
      since: this.connectedAt === undefined ? undefined : new Date(this.connectedAt).toISOString(),
      attempt: this.attempt,
    }
  }

  /**
   * Send one unsolicited message to the hub.
   * @param {string} text - message body.
   * @param {string} [sessionId] - the local session this message came from.
   * @returns {Promise<{ accepted: boolean }>} hub acknowledgement.
   */
  async reply(text, sessionId) {
    const conn = this.conn
    if (conn === undefined) throw new Error('peer link is not connected to its hub')
    const result = await conn.request('peer/reply', { text, sessionId }, { timeoutMs: 15_000 })
    return { accepted: /** @type {{ accepted?: boolean }} */ (result).accepted === true }
  }

  /** Connect once, or schedule the next attempt. */
  async #connect() {
    if (this.stopped) return
    let socket
    try {
      socket = await this.#dial()
    } catch (error) {
      this.ctx.logger.warn(`peer link: dial ${this.config.url} failed: ${describeError(error)}`)
      this.#scheduleReconnect()
      return
    }
    this.socket = socket
    const conn = new PeerConnection(socket, { label: `link->${this.config.url}`, logger: this.ctx.logger })
    this.conn = conn
    try {
      // Serve before greeting: the hub may drive the harness as soon as it has
      // answered `peer/hello`, which can precede this side's response microtask.
      this.#serve(conn)
      conn.start()
      const hub = await conn.request('peer/hello', {
        ...localIdentity({
          name: this.config.name,
          role: 'link',
          cwd: this.config.cwd,
          provider: this.config.provider,
          model: this.config.model,
          version: this.config.version ?? '0.1.0',
        }),
        token: this.config.token,
      }, { timeoutMs: 15_000 })
      const hubInfo = /** @type {{ hub?: Record<string, unknown> }} */ (hub).hub ?? {}
      this.hubInfo = hubInfo
      this.connectedAt = Date.now()
      this.attempt = 0
      this.authFailures = 0
      this.ctx.logger.info(`peer link "${this.config.name}" connected to hub "${String(hubInfo.name ?? '?')}" at ${this.config.url}`)
      conn.onClose((reason) => {
        this.ctx.logger.warn(`peer link: disconnected${reason === undefined ? '' : `: ${reason.message}`}`)
        this.conn = undefined
        this.hubInfo = undefined
        this.socket = undefined
        void this.#release()
        this.#scheduleReconnect()
      })
    } catch (error) {
      const message = describeError(error)
      if (message.includes('token')) this.authFailures += 1
      this.ctx.logger.warn(`peer link: handshake failed: ${message}`)
      this.conn = undefined
      this.socket = undefined
      conn.close()
      void this.#release()
      if (this.authFailures >= MAX_AUTH_FAILURES) {
        this.ctx.logger.warn(`peer link: stopping after ${String(this.authFailures)} refused handshakes`)
        this.stopped = true
        return
      }
      this.#scheduleReconnect()
    }
  }

  /** Wait on a bounded exponential backoff. */
  #scheduleReconnect() {
    if (this.stopped) return
    this.attempt += 1
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempt - 1, 5))
    this.ctx.logger.info(`peer link: reconnect attempt ${String(this.attempt)} in ${String(delay)}ms`)
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => { void this.#connect() }, delay)
    this.retryTimer.unref?.()
  }

  /**
   * Open the socket for the configured URL.
   * @returns {Promise<import('node:net').Socket>} the connected socket.
   */
  #dial() {
    const url = new URL(this.config.url)
    const port = Number(url.port)
    if (!Number.isInteger(port) || port <= 0) throw new Error(`peer link url has no port: ${this.config.url}`)
    if (url.protocol === 'tls:') {
      return new Promise((resolve, reject) => {
        const material = this.config.tls ?? {}
        const socket = tlsConnect({
          host: url.hostname,
          port,
          servername: url.hostname,
          ...material.ca === undefined ? {} : { ca: material.ca },
          ...material.cert === undefined ? {} : { cert: material.cert },
          ...material.key === undefined ? {} : { key: material.key },
          ...material.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: material.rejectUnauthorized },
        }, () => resolve(socket))
        socket.once('error', reject)
        socket.setNoDelay(true)
      })
    }
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return connectWebSocket(this.config.url, { timeoutMs: 20_000 })
    }
    if (url.protocol !== 'tcp:') throw new Error(`peer link supports tcp://, tls://, ws:// and wss:// URLs, got ${url.protocol}`)
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: url.hostname, port }, () => resolve(socket))
      socket.once('error', reject)
      socket.setNoDelay(true)
    })
  }

  /** Release server-owned agents after a connection ends. */
  async #release() {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    try {
      await server.shutdown()
    } catch (error) {
      this.ctx.logger.warn(`peer link: session teardown failed: ${describeError(error)}`)
    }
  }

  /**
   * Serve hub requests from this runtime and forward its events back.
   * @param {PeerConnection} conn - authenticated connection.
   */
  #serve(conn) {
    /** @type {Set<string>} */
    const owned = new Set()
    const ctx = this.ctx
    const filteringPeer = {
      /** @param {string} method @param {object} params @param {AbortSignal} [signal] */
      request(method, params, signal) {
        return conn.request(method, params, { signal })
      },
      /** @param {string} method @param {object} [params] */
      notify(method, params) {
        if (method === 'session.event' || method === 'session.status') {
          const sessionId = /** @type {{ sessionId?: unknown }} */ (params ?? {}).sessionId
          if (typeof sessionId !== 'string' || !owned.has(sessionId)) return
        } else if (method === 'subagent.started' || method === 'subagent.finished') {
          const parentSessionId = /** @type {{ parentSessionId?: unknown }} */ (params ?? {}).parentSessionId
          if (typeof parentSessionId !== 'string' || !owned.has(parentSessionId)) return
        }
        conn.notify(method, params)
      },
    }
    const server = new PeerHarnessServer(ctx, filteringPeer, { maxTokensAsSuccess: false }, this.config.agentPreset)
    this.server = server
    conn.onRequest(async (method, params) => {
      switch (method) {
        case 'peer/ping':
          return { at: Date.now() }
        case 'peer/info':
          return {
            link: localIdentity({
              name: this.config.name,
              role: 'link',
              cwd: this.config.cwd,
              provider: this.config.provider,
              model: this.config.model,
              version: this.config.version ?? '0.1.0',
            }),
            status: this.status(),
          }
        case 'peer/ensure-session': {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
          if (sessionId.length === 0) throw new Error('peer/ensure-session requires a sessionId')
          owned.add(sessionId)
          try {
            await server.handleRequest('session/resume', { sessionId })
            return { resumed: true }
          } catch {
            // A missing session is expected on first use; the next prompt creates it.
            return { resumed: false }
          }
        }
        case 'shutdown':
          throw new Error('shutdown is unavailable over a peer link')
        default:
          break
      }
      if (typeof params.sessionId === 'string') owned.add(params.sessionId)
      return server.handleRequest(method, params)
    })
    conn.onNotification((method, params) => {
      ctx.logger.warn(`peer link: ignoring unexpected notification "${method}" from hub: ${JSON.stringify(params).slice(0, 200)}`)
    })
  }
}
