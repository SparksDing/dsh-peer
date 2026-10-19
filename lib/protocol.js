/**
 * Peer wire layer: newline-delimited JSON-RPC 2.0 over one duplex socket.
 *
 * Both ends are symmetric JSON-RPC peers, so either side may issue requests.
 * The link initiates the TCP connection and the `peer/hello` handshake; after
 * that the hub drives harness requests and the link sends `peer/reply`
 * messages back. The frame format and request correlation match the
 * stdio SDK runtime's dialect, so both sides already understand the harness
 * methods.
 *
 * @module @local/dsh-peer/protocol
 */

import { randomUUID } from 'node:crypto'
import { LineTransport, JsonRpcResponseError } from './transport.js'

/** Wire revision; a mismatched peer is refused instead of half-understood. */
export const PROTOCOL_VERSION = 1

/** Default TCP port a hub listens on. */
export const DEFAULT_PORT = 3099

/** Bound on one handshake exchange before the socket is dropped. */
export const HANDSHAKE_TIMEOUT_MS = 10_000

/** Application-level keepalive period. */
export const HEARTBEAT_INTERVAL_MS = 25_000

/** Per-heartbeat response budget. */
export const HEARTBEAT_TIMEOUT_MS = 10_000

/** Consecutive missed heartbeats tolerated before the socket is dropped. */
export const HEARTBEAT_MISSES = 2

/**
 * One live peer connection: framing, request timeouts, keepalive, and closure.
 * `close()` detaches the framing and rejects pending requests; the owner owns
 * the socket itself.
 */
export class PeerConnection {
  /**
   * @param {import('node:stream').Duplex} socket - the connected duplex socket.
   * @param {{ label?: string, logger?: import('@deepseek-ai/cordis').Context['logger'], heartbeat?: boolean }} [options]
   *   label for diagnostics, host logger, and whether to run keepalives.
   */
  constructor(socket, options = {}) {
    this.label = options.label ?? 'peer'
    this.logger = options.logger
    this.heartbeatEnabled = options.heartbeat ?? true
    this.closed = false
    this.remoteInfo = undefined
    this.localInfo = undefined
    this.#transport = new LineTransport(socket, socket)
    this.#socket = socket
    socket.setNoDelay?.(true)
    socket.setKeepAlive?.(true, 15_000)
    socket.on('error', (error) => this.#onSocketGone(error))
    socket.on('close', () => this.#onSocketGone(undefined))
  }

  /** @type {LineTransport} */
  #transport
  /** @type {import('node:stream').Duplex} */
  #socket
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #heartbeat
  /** @type {number} */
  #missed = 0
  /** @type {(reason: Error | undefined) => void} */
  #closeListeners = []

  /** Install the request handler (one per connection). @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} handler */
  onRequest(handler) {
    this.#transport.onRequest(handler)
  }

  /** Install the notification handler. @param {(method: string, params: Record<string, unknown>) => void} handler */
  onNotification(handler) {
    this.#transport.onNotification(handler)
  }

  /** Register a closure listener. @param {(reason: Error | undefined) => void} listener */
  onClose(listener) {
    this.#closeListeners.push(listener)
  }

  /** Begin reading frames and keepalives. */
  start() {
    this.#transport.start()
    if (this.heartbeatEnabled) {
      this.#heartbeat = setInterval(() => { void this.#beat() }, HEARTBEAT_INTERVAL_MS)
      this.#heartbeat.unref?.()
    }
  }

  /**
   * Issue a request with a deadline.
   * @param {string} method - JSON-RPC method.
   * @param {object} params - request parameters.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - deadline and caller cancellation.
   * @returns {Promise<unknown>} the peer's result.
   */
  async request(method, params, options = {}) {
    if (this.closed) throw new Error('peer connection is closed')
    const timeoutMs = options.timeoutMs ?? 30_000
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    const outer = options.signal
    const onAbort = () => controller.abort(outer?.reason)
    if (outer !== undefined) {
      if (outer.aborted) controller.abort(outer.reason)
      else outer.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await this.#transport.request(method, params, controller.signal)
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Send a notification.
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - notification payload.
   */
  notify(method, params) {
    if (this.closed) return
    try {
      this.#transport.notify(method, params)
    } catch (error) {
      this.logger?.warn?.(`peer ${this.label}: notify ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Detach framing, stop keepalives, and reject pending requests. */
  close() {
    if (this.closed) return
    this.closed = true
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    this.#transport.close()
    this.#socket.destroy()
    for (const listener of this.#closeListeners) listener(undefined)
    this.#closeListeners = []
  }

  /**
   * Drop the connection with a diagnostic reason.
   * @param {Error} reason - why the owner dropped it.
   */
  destroy(reason) {
    if (this.closed) return
    this.logger?.warn?.(`peer ${this.label}: closing: ${reason.message}`)
    this.closed = true
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    this.#transport.close()
    this.#socket.destroy()
    for (const listener of this.#closeListeners) listener(reason)
    this.#closeListeners = []
  }

  /** @param {Error | undefined} reason */
  #onSocketGone(reason) {
    if (this.closed) return
    this.closed = true
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    this.#transport.close()
    for (const listener of this.#closeListeners) listener(reason)
    this.#closeListeners = []
  }

  async #beat() {
    if (this.closed) return
    try {
      await this.request('peer/ping', { at: Date.now() }, { timeoutMs: HEARTBEAT_TIMEOUT_MS })
      this.#missed = 0
    } catch {
      this.#missed += 1
      if (this.#missed >= HEARTBEAT_MISSES) this.destroy(new Error('peer keepalive missed'))
    }
  }
}

/**
 * Constant-time token comparison.
 * @param {string} expected - configured token.
 * @param {unknown} received - peer-supplied token.
 * @returns {boolean} whether they match.
 */
export function tokenMatches(expected, received) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length || a.length === 0) return false
  return constantTimeEqual(a, b)
}

/**
 * Compare two equal-length buffers without an early exit.
 * @param {Buffer} a - left operand.
 * @param {Buffer} b - right operand.
 * @returns {boolean} equality.
 */
function constantTimeEqual(a, b) {
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return diff === 0
}

/**
 * Describe this process for the handshake.
 * @param {{ name: string, role: 'hub' | 'link', cwd?: string, provider?: string, model?: string, version: string }} input
 *   identity fields to publish.
 * @returns {Record<string, unknown>} the `peer/hello` body.
 */
export function localIdentity(input) {
  return {
    protocol: PROTOCOL_VERSION,
    name: input.name,
    role: input.role,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    node: process.version,
    version: input.version,
    cwd: input.cwd,
    provider: input.provider,
    model: input.model,
    hostname: hostnameOf(),
  }
}

/** @returns {string} this machine's hostname, or an empty string when unavailable. */
function hostnameOf() {
  try {
    return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? ''
  } catch {
    return ''
  }
}

/**
 * Fresh session identity for one peer conversation.
 * @param {string} peer - link name.
 * @param {string} [topic] - stable topic, or omitted for a new conversation.
 * @returns {string} wire session id.
 */
export function peerSessionId(peer, topic) {
  const slug = topic === undefined ? `chat-${randomUUID().replaceAll('-', '').slice(0, 12)}` : topic
  return `peer-${sanitize(peer)}-${sanitize(slug)}`
}

/**
 * Restrict a name to characters that are safe in a session id.
 * @param {string} value - raw name.
 * @returns {string} sanitized name.
 */
export function sanitize(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64)
}

/**
 * Validate a `peer/hello` payload.
 * @param {unknown} value - raw params.
 * @returns {{ body: Record<string, unknown>, name: string }} validated handshake.
 */
export function readHello(value) {
  if (value === null || typeof value !== 'object') throw new Error('hello must be an object')
  const body = /** @type {Record<string, unknown>} */ (value)
  if (body.protocol !== PROTOCOL_VERSION) {
    throw new Error(`protocol mismatch: hub speaks ${PROTOCOL_VERSION}, got ${String(body.protocol)}`)
  }
  if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 64) {
    throw new Error('name must be a non-empty string of at most 64 characters')
  }
  if (typeof body.token !== 'string') throw new Error('token must be a string')
  if (body.role !== 'link') throw new Error('only a link may greet a hub')
  return { body, name: body.name }
}

/**
 * Reduce a request failure to a message a model can read.
 * @param {unknown} error - thrown value.
 * @returns {string} diagnostic text.
 */
export function describeError(error) {
  if (error instanceof JsonRpcResponseError) return `${error.message} (${String(error.code)})`
  return error instanceof Error ? error.message : String(error)
}
