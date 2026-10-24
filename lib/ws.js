/**
 * Minimal WebSocket transport for the peer channel.
 *
 * A raw TCP listener is unusable when the only reachable public port is an
 * HTTP reverse proxy. This module carries the same newline-delimited JSON-RPC
 * frames inside WebSocket binary messages, so the hub can sit behind nginx on
 * a port that is already open. Both ends expose an ordinary `Duplex`, which is
 * what the peer connection and line transport already expect.
 *
 * Only the RFC 6455 subset this channel needs is implemented: binary/text
 * data frames with continuation, ping/pong, and close. No extensions, no
 * compression, no subprotocols.
 *
 * @module @local/dsh-peer/ws
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/**
 * Encode one unfragmented frame.
 * @param {number} opcode - frame opcode.
 * @param {Buffer} payload - frame payload.
 * @param {boolean} mask - whether to mask (clients must, servers must not).
 * @returns {Buffer} the wire bytes.
 */
function encodeFrame(opcode, payload, mask) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  if (!mask) return Buffer.concat([header, payload])
  header[1] |= 0x80
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index++) masked[index] ^= key[index % 4]
  return Buffer.concat([header, key, masked])
}

/**
 * Duplex over one upgraded WebSocket connection.
 */
class WebSocketDuplex extends Duplex {
  /**
   * @param {import('node:stream').Duplex} socket - the upgraded TCP socket.
   * @param {{ masked: boolean, initial?: Buffer }} options - framing direction and any bytes read with the handshake.
   */
  constructor(socket, options) {
    super()
    this.socket = socket
    this.masked = options.masked
    this.buffer = options.initial ?? Buffer.alloc(0)
    this.fragments = []
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.#parse()
    })
    socket.on('error', error => this.destroy(error))
    socket.on('close', () => {
      if (!this.destroyed) {
        this.push(null)
        this.destroy()
      }
    })
    if (this.buffer.length > 0) queueMicrotask(() => this.#parse())
  }

  /** @param {number} _size */
  _read(_size) {}

  /**
   * @param {Buffer} chunk - outgoing bytes.
   * @param {BufferEncoding} _encoding - ignored.
   * @param {(error?: Error | null) => void} callback - write completion.
   */
  _write(chunk, _encoding, callback) {
    try {
      this.socket.write(encodeFrame(OP_BINARY, chunk, this.masked))
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** @param {(error?: Error | null) => void} callback */
  _final(callback) {
    try {
      this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0), this.masked))
    } catch {
      // The socket may already be gone; close is best effort.
    }
    callback()
  }

  /**
   * @param {Error | null} error - destroy reason.
   * @param {(error?: Error | null) => void} callback
   */
  _destroy(error, callback) {
    this.socket.destroy()
    callback(error)
  }

  /** Consume every complete frame in the buffer. */
  #parse() {
    for (;;) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined
      offset += maskLength
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (mask !== undefined) {
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
      }
      this.buffer = this.buffer.subarray(offset + length)
      if (opcode === OP_CLOSE) {
        this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0), this.masked))
        this.push(null)
        this.destroy()
        return
      }
      if (opcode === OP_PING) {
        this.socket.write(encodeFrame(OP_PONG, payload, this.masked))
        continue
      }
      if (opcode === OP_PONG) continue
      if (opcode === OP_CONTINUATION) {
        this.fragments.push(payload)
        if (fin) {
          this.push(Buffer.concat(this.fragments))
          this.fragments = []
        }
        continue
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) {
          this.fragments = [payload]
          continue
        }
        this.push(payload)
        continue
      }
      // Unknown opcodes are ignored; the channel only needs data and control frames.
    }
  }
}

/**
 * Start an HTTP server that upgrades every request on `path` to a WebSocket.
 * @param {object} options - listener configuration.
 * @param {string} options.host - bind host.
 * @param {number} options.port - bind port.
 * @param {string} [options.path] - accepted request path; omitted accepts any.
 * @param {(stream: Duplex, remote: string) => void} options.onConnection - one upgraded stream.
 * @param {{ info: Function, warn: Function }} [options.logger] - diagnostics.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} [options.onRequest] - plain HTTP requests that are not upgrades.
 * @returns {Promise<{ close: () => Promise<void> }>} the running server.
 */
export async function createWebSocketServer(options) {
  const server = createServer((request, response) => {
    if (options.onRequest !== undefined) {
      options.onRequest(request, response)
      return
    }
    response.writeHead(426, { 'content-type': 'text/plain', connection: 'close' })
    response.end(`websocket upgrade required\n`)
  })
  server.on('upgrade', (request, socket, head) => {
    if (options.path !== undefined && request.url !== undefined) {
      const pathname = new URL(request.url, 'http://placeholder').pathname
      if (pathname !== options.path) {
        socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n')
        return
      }
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || key.length === 0) {
      socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))
    const stream = new WebSocketDuplex(socket, { masked: false, initial: head })
    options.onConnection(stream, socket.remoteAddress ?? 'ws')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  options.logger?.info?.(`websocket listener on ${options.host}:${String(options.port)}${options.path ?? ''}`)
  return {
    close: () => new Promise(resolve => server.close(() => resolve(undefined))),
  }
}

/**
 * Dial one WebSocket and expose it as a Duplex.
 * @param {string} url - `ws://` or `wss://` endpoint.
 * @param {{ timeoutMs?: number }} [options] - handshake deadline.
 * @returns {Promise<Duplex>} the connected stream.
 */
export function connectWebSocket(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* already closed */ }
      reject(new Error(`websocket open timed out after ${timeoutMs}ms: ${url}`))
    }, timeoutMs)
    timer.unref?.()
    socket.onopen = () => {
      clearTimeout(timer)
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          try {
            socket.send(chunk)
            callback()
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        },
        final(callback) {
          try { socket.close() } catch { /* already closed */ }
          callback()
        },
        destroy(error, callback) {
          try { socket.close() } catch { /* already closed */ }
          callback(error)
        },
      })
      socket.onmessage = event => {
        if (typeof event.data === 'string') stream.push(Buffer.from(event.data))
        else if (event.data instanceof ArrayBuffer) stream.push(Buffer.from(event.data))
      }
      socket.onclose = () => {
        if (!stream.destroyed) {
          stream.push(null)
          stream.destroy()
        }
      }
      socket.onerror = () => stream.destroy(new Error('websocket transport error'))
      resolve(stream)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`websocket connection failed: ${url}`))
    }
  })
}
