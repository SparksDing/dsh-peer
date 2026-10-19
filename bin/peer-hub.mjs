#!/usr/bin/env node
/**
 * Standalone peer hub: accept outbound links and serve a local control socket.
 *
 * The hub owns no harness, so it runs without dsh. Links (DSH runtimes with
 * the `link` role) dial in; `peer.mjs` drives them over the control socket.
 * Use this daemon when the local runtime should not host the hub plugin.
 *
 * Usage: peer-hub.mjs --port 3099 --token <secret> [--host 127.0.0.1] [--control /tmp/dsh-peer.sock]
 */
import { createServer } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { PeerHub } from '../lib/hub.js'
import { PeerConnection } from '../lib/protocol.js'

/** Parse `--flag value` and `--flag=value` forms. */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const [flag, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) {
      options[flag] = inline
    } else {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        options[flag] = 'true'
      } else {
        options[flag] = next
        index++
      }
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const host = options.host ?? process.env.DSH_PEER_HOST ?? '127.0.0.1'
const port = Number(options.port ?? process.env.DSH_PEER_PORT ?? 3099)
const token = options.token ?? process.env.DSH_PEER_TOKEN ?? ''
const name = options.name ?? process.env.DSH_PEER_NAME ?? 'dsh-hub'
const control = options.control ?? process.env.DSH_PEER_CONTROL ?? '/tmp/dsh-peer.sock'
const wsPort = options['ws-port'] ?? process.env.DSH_PEER_WS_PORT
const wsHost = options['ws-host'] ?? process.env.DSH_PEER_WS_HOST ?? '127.0.0.1'
const wsPath = options['ws-path'] ?? process.env.DSH_PEER_WS_PATH ?? '/dsh-peer'
const quiet = options.quiet === 'true'

/** Timestamped stderr diagnostics; stdout stays free for control clients. */
const logger = {
  info: (...args) => { if (!quiet) console.error(new Date().toISOString(), '[peer-hub]', ...args) },
  warn: (...args) => { console.error(new Date().toISOString(), '[peer-hub]', ...args) },
  error: (...args) => { console.error(new Date().toISOString(), '[peer-hub]', ...args) },
}

const hub = new PeerHub({ logger, get: () => undefined }, {
  name,
  token,
  listen: { host, port },
  wsListen: wsPort === undefined ? undefined : { host: wsHost, port: Number(wsPort), path: wsPath },
  version: '0.1.0',
})

if (token.length === 0 && host !== '127.0.0.1' && host !== '::1') {
  console.error('peer-hub: refusing a non-loopback bind without --token (or DSH_PEER_TOKEN)')
  process.exit(2)
}

try {
  await hub.start()
} catch (error) {
  console.error(`peer-hub: cannot listen on ${host}:${String(port)}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (existsSync(control)) {
  try {
    unlinkSync(control)
  } catch {
    // A stale socket that cannot be removed fails at listen(), which reports it.
  }
}
const controlServer = createServer(socket => {
  const conn = new PeerConnection(socket, { label: 'control', heartbeat: false, logger })
  conn.onRequest(async (method, params) => {
    switch (method) {
      case 'control/ping':
        return { at: Date.now(), hub: name }
      case 'control/list':
        return { links: hub.list().map(link => link.describe()) }
      case 'control/ask':
        return hub.ask(/** @type {any} */ (params))
      case 'control/send':
        return hub.send(/** @type {any} */ (params))
      case 'control/wait':
        return hub.wait(/** @type {any} */ (params))
      case 'control/inbox':
        return hub.readInbox(/** @type {any} */ (params))
      case 'control/stop':
        setImmediate(() => { void shutdown(0) })
        return { stopping: true }
      default:
        throw new Error(`control does not serve "${method}"`)
    }
  })
  conn.start()
})
await new Promise((resolve, reject) => {
  controlServer.once('error', reject)
  controlServer.listen(control, () => {
    controlServer.off('error', reject)
    resolve(undefined)
  })
})
logger.info(`control socket ${control}`)

let stopping = false
/** @param {number} code */
async function shutdown(code) {
  if (stopping) return
  stopping = true
  logger.info('shutting down')
  await hub.stop()
  await new Promise(resolve => controlServer.close(() => resolve(undefined)))
  if (existsSync(control)) {
    try { unlinkSync(control) } catch { /* best effort */ }
  }
  process.exit(code)
}

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })
logger.info(`hub "${name}" listening on ${host}:${String(port)}`)
