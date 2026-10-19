#!/usr/bin/env node
/**
 * WebSocket-to-TCP bridge for a running peer hub.
 *
 * A hub that listens only on a raw TCP port cannot be reached when the only
 * open public port belongs to an HTTP reverse proxy. This bridge terminates
 * the WebSocket upgrade and pipes each connection to the hub's TCP port, so
 * the hub keeps its original transport and needs no reload.
 *
 * Topology: link --ws--> nginx --ws--> this bridge --tcp--> hub
 *
 * Usage: peer-ws-bridge.mjs --listen 3098 --target 127.0.0.1:3099 [--host 127.0.0.1] [--path /dsh-peer]
 */
import { connect } from 'node:net'
import { createWebSocketServer } from '../lib/ws.js'

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
const host = options.host ?? process.env.DSH_PEER_WS_HOST ?? '127.0.0.1'
const listenPort = Number(options.listen ?? process.env.DSH_PEER_WS_PORT ?? 3098)
const path = options.path ?? process.env.DSH_PEER_WS_PATH ?? '/dsh-peer'
const target = options.target ?? process.env.DSH_PEER_WS_TARGET ?? '127.0.0.1:3099'
const [targetHost, targetPortText] = target.split(':')
const targetPort = Number(targetPortText)
if (!Number.isInteger(targetPort) || targetPort <= 0) throw new Error(`invalid --target: ${target}`)

const logger = {
  info: (...args) => console.error(new Date().toISOString(), '[peer-ws]', ...args),
  warn: (...args) => console.error(new Date().toISOString(), '[peer-ws]', ...args),
}

const server = await createWebSocketServer({
  host,
  port: listenPort,
  path,
  logger,
  onConnection: (stream, remote) => {
    const upstream = connect(targetPort, targetHost)
    const close = (error) => {
      if (error !== undefined) logger.warn(`connection from ${remote} closed: ${error.message}`)
      stream.destroy()
      upstream.destroy()
    }
    upstream.on('error', error => close(error))
    upstream.on('close', () => stream.destroy())
    stream.on('error', error => close(error))
    stream.on('close', () => upstream.destroy())
    upstream.on('connect', () => {
      stream.pipe(upstream)
      upstream.pipe(stream)
    })
  },
})

logger.info(`bridging ws://${host}:${String(listenPort)}${path} -> tcp://${targetHost}:${String(targetPort)}`)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
