/**
 * Newline-delimited JSON-RPC 2.0 over a duplex byte stream.
 *
 * Adapted from `@deepseek-ai/dsh-sdk-protocol` (MIT, deepseek-harness) so the
 * hub and its CLI run without importing the harness: only the link, which is
 * a harness plugin, needs the host packages. Frames with `id` and `method` are
 * requests, `id` alone is a response, `method` alone is a notification;
 * malformed lines are ignored.
 *
 * @module @local/dsh-peer/transport
 */

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

/**
 * A JSON-RPC error response, preserving the wire `code` and optional `data`.
 */
export class JsonRpcResponseError extends Error {
  /**
   * @param {number | undefined} code - the wire error code.
   * @param {string} message - the wire error message.
   * @param {unknown} [data] - optional structured payload.
   */
  constructor(code, message, data) {
    super(message)
    this.name = 'JsonRpcResponseError'
    this.code = code
    this.data = data
  }
}

/**
 * Line-delimited endpoint over caller-owned streams.
 */
export class LineTransport {
  /**
   * @param {import('node:stream').Readable} input - frame source.
   * @param {import('node:stream').Writable} output - frame sink.
   */
  constructor(input, output) {
    this.input = input
    this.output = output
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.started = false
    /** @type {((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined} */
    this.requestHandler = undefined
    /** @type {((method: string, params: Record<string, unknown>) => void) | undefined} */
    this.notificationHandler = undefined
    /** @type {Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
    this.pending = new Map()
  }

  /** Attach input listeners and begin reading frames. Idempotent. */
  start() {
    if (this.started) return
    this.started = true
    this.onData = chunk => {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
      this.drain()
    }
    this.onError = error => this.failPending(error)
    this.onEnd = () => {
      this.buffer += this.decoder.end()
      this.drain()
      this.failPending(new Error('JSON-RPC input closed'))
    }
    this.input.on('data', this.onData)
    this.input.on('error', this.onError)
    this.input.on('end', this.onEnd)
  }

  /** Detach listeners and reject pending requests. */
  close() {
    if (this.started) {
      this.input.off('data', this.onData)
      this.input.off('error', this.onError)
      this.input.off('end', this.onEnd)
      this.started = false
    }
    this.failPending(new Error('JSON-RPC transport closed'))
  }

  /** @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} handler */
  onRequest(handler) {
    this.requestHandler = handler
  }

  /** @param {(method: string, params: Record<string, unknown>) => void} handler */
  onNotification(handler) {
    this.notificationHandler = handler
  }

  /**
   * Send a request and await its response.
   * @param {string} method - JSON-RPC method.
   * @param {object} params - request parameters.
   * @param {AbortSignal} [signal] - abandonment signal.
   * @returns {Promise<unknown>} the peer's result.
   */
  request(method, params, signal) {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    return new Promise((resolve, reject) => {
      let detach = () => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = () => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        resolve: value => {
          detach()
          resolve(value)
        },
        reject: error => {
          detach()
          reject(error)
        },
      })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Send a notification.
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - notification payload.
   */
  notify(method, params) {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /** @returns {Promise<void>} settlement once prior writes flushed. */
  flush() {
    return new Promise((resolve, reject) => {
      this.output.write('', error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /** @param {Buffer | string} chunk */
  drain() {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) void this.handleLine(line)
    }
  }

  /** @param {string} line */
  async handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    const id = message.id
    const method = message.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleRequest(id, method, objectParams(message.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleResponse(id, message)
      return
    }
    if (typeof method === 'string') this.notificationHandler?.(method, objectParams(message.params))
  }

  /**
   * @param {string | number} id - request identity.
   * @param {string} method - requested method.
   * @param {Record<string, unknown>} params - request parameters.
   */
  async handleRequest(id, method, params) {
    const handler = this.requestHandler
    if (handler === undefined) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result: result ?? {} })
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /**
   * @param {string | number} id - response correlation id.
   * @param {Record<string, unknown>} frame - response frame.
   */
  handleResponse(id, frame) {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (frame.error !== undefined && typeof frame.error === 'object' && frame.error !== null) {
      const error = frame.error
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  /** @param {Record<string, unknown>} message */
  write(message) {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  /** @param {Error} error */
  failPending(error) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

/**
 * Normalize JSON-RPC `params` to a plain object.
 * @param {unknown} params - raw params.
 * @returns {Record<string, unknown>} object params.
 */
function objectParams(params) {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}
}

/**
 * Normalize an abort reason into an Error.
 * @param {unknown} reason - abort reason.
 * @returns {Error} the rejection error.
 */
function abortError(reason) {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}
