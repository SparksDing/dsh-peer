#!/usr/bin/env node
/**
 * Tiny authenticated upload endpoint for files produced on a peer machine.
 *
 * The peer protocol carries JSON text, so binary artifacts (screenshots,
 * preview QR codes, build output) cannot ride it directly. A peer can POST or
 * PUT the file here instead; nginx exposes this listener under `/peer-files/`
 * on the already-open HTTP port, and the hub operator reads the stored file.
 *
 * Usage: peer-files.mjs --port 3097 --dir /root/dshCommunicate/peer-files --token <secret>
 */
import { createServer } from 'node:http'
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Parse `--flag value` and `--flag=value` forms. */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const [flag, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) {
      options[flag] = inline
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[flag] = 'true'
    } else {
      options[flag] = next
      index++
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const port = Number(options.port ?? process.env.PEER_FILES_PORT ?? 3097)
const host = options.host ?? '127.0.0.1'
const dir = options.dir ?? process.env.PEER_FILES_DIR ?? '/root/dshCommunicate/peer-files'
const token = options.token ?? process.env.PEER_FILES_TOKEN ?? ''
if (token.length === 0) {
  console.error('peer-files: refusing to start without --token (or PEER_FILES_TOKEN)')
  process.exit(2)
}
await mkdir(dir, { recursive: true })

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://placeholder')
  if (url.searchParams.get('token') !== token) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'bad token' }))
    return
  }
  if (url.pathname === '/list') {
    void listFiles().then(files => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, files }))
    }).catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: String(error) }))
    })
    return
  }
  if (!url.pathname.startsWith('/upload/')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'use /upload/<name>' }))
    return
  }
  if (request.method !== 'PUT' && request.method !== 'POST') {
    response.writeHead(405, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'use PUT or POST' }))
    return
  }
  const name = basename(decodeURIComponent(url.pathname.slice('/upload/'.length)))
  if (name.length === 0 || name === '.' || name === '..') {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'bad file name' }))
    return
  }
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    void writeFile(join(dir, name), body).then(() => {
      console.log(`${new Date().toISOString()} stored ${name} (${String(body.length)} bytes)`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, name, bytes: body.length, path: join(dir, name) }))
    }).catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: String(error) }))
    })
  })
})

/** List stored files with sizes. */
async function listFiles() {
  const names = await readdir(dir)
  const files = []
  for (const name of names) {
    const info = await stat(join(dir, name))
    files.push({ name, bytes: info.size, modified: info.mtime.toISOString() })
  }
  return files
}

server.listen(port, host, () => {
  console.log(`peer-files listening on ${host}:${String(port)}, storing in ${dir}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
