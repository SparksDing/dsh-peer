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
import { ActivityStore, dashboardHtml } from '../lib/activity.js'

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
const uiToken = options['ui-token'] ?? process.env.DSH_PEER_UI_TOKEN ?? ''
const [targetHost, targetPortText] = target.split(':')
const targetPort = Number(targetPortText)
if (!Number.isInteger(targetPort) || targetPort <= 0) throw new Error(`invalid --target: ${target}`)

const logger = {
  info: (...args) => console.error(new Date().toISOString(), '[peer-ws]', ...args),
  warn: (...args) => console.error(new Date().toISOString(), '[peer-ws]', ...args),
}

const activity = new ActivityStore()

/** Split one tapped byte stream into JSON-RPC frames. */
function tap(stream, onMessage) {
  let buffer = ''
  stream.on('data', chunk => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      try { onMessage(JSON.parse(line)) } catch { /* non-JSON peer frame */ }
    }
    if (buffer.length > 4_000_000) buffer = ''
  })
}

const server = await createWebSocketServer({
  host,
  port: listenPort,
  path,
  logger,
  onRequest: (request, response) => {
    const url = new URL(request.url ?? '/', 'http://placeholder')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(dashboardHtml(uiToken))
      return
    }
    if (url.pathname === '/api/activity') {
      if (uiToken.length > 0 && url.searchParams.get('token') !== uiToken) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: 'bad token' }))
        return
      }
      const since = Number(url.searchParams.get('since') ?? 0)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(activity.snapshot(Number.isFinite(since) ? since : 0)))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found\n')
  },
  onConnection: (stream, remote) => {
    let peer = remote
    tap(stream, message => {
      if (typeof message?.method !== 'string') return
      if (message.method === 'peer/hello') {
        if (typeof message.params?.name === 'string') {
          peer = message.params.name
          activity.connected(peer)
        }
        return
      }
      if (message.id !== undefined) return
      if (message.method === 'session.event' || message.method === 'session.status') {
        activity.record(peer, message.method, message.params ?? {})
      }
    })
    const upstream = connect(targetPort, targetHost)
    const close = (error) => {
      if (error !== undefined) logger.warn(`connection from ${remote} closed: ${error.message}`)
      stream.destroy()
      upstream.destroy()
    }
    upstream.on('error', error => close(error))
    upstream.on('close', () => { stream.destroy(); activity.disconnected(peer) })
    stream.on('error', error => close(error))
    stream.on('close', () => upstream.destroy())
    upstream.on('connect', () => {
      stream.pipe(upstream)
      upstream.pipe(stream)
    })
  },
})

logger.info(`bridging ws://${host}:${String(listenPort)}${path} -> tcp://${targetHost}:${String(targetPort)}`)
logger.info(`activity dashboard on http://${host}:${String(listenPort)}/ (token ${uiToken.length > 0 ? 'required' : 'disabled'})`)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
