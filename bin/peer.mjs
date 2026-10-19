#!/usr/bin/env node
/**
 * Drive a running peer hub from a shell.
 *
 * The hub daemon owns links; this client sends one control request per call.
 * `ask` prints the remote agent's final text, so a shell (or any agent with a
 * shell tool) reaches a linked DSH runtime without loading a plugin locally.
 *
 * Usage:
 *   peer.mjs list [--json]
 *   peer.mjs ask --peer NAME --prompt TEXT [--session NAME] [--fresh] [--timeout MS] [--json]
 *   peer.mjs send --peer NAME --prompt TEXT [--session NAME] [--fresh] [--json]
 *   peer.mjs wait [--peer NAME] [--timeout MS] [--json]
 *   peer.mjs inbox [--peer NAME] [--json]
 *   peer.mjs status [--json]
 */
import { connect } from 'node:net'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { PeerConnection } from '../lib/protocol.js'

const CONTROL = process.env.DSH_PEER_CONTROL ?? '/tmp/dsh-peer.sock'

/** Parse positional words plus `--flag value` / `--flag=value` options. */
function parseArgv(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [flag, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) {
      options[flag] = inline
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[flag] = true
    } else {
      options[flag] = next
      index++
    }
  }
  return { positional, options }
}

const { positional, options } = parseArgv(process.argv.slice(2))
const command = positional[0] ?? 'status'
const url = options.control ?? CONTROL
const asJson = options.json === true

if (options.help === true || command === 'help') {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 16).join('\n'))
  process.exit(0)
}

const socket = connect(url)
try {
  await once(socket, 'connect')
} catch {
  console.error(`peer: cannot reach the hub control socket at ${url}. Start it with bin/peer-hub.mjs.`)
  process.exit(2)
}
const conn = new PeerConnection(socket, { label: 'cli', heartbeat: false })
conn.start()

const timeoutMs = options.timeout === undefined ? undefined : Number(options.timeout)
const params = {
  ...options.peer === undefined ? {} : { peer: String(options.peer) },
  ...options.prompt === undefined ? {} : { prompt: String(options.prompt) },
  ...options.session === undefined ? {} : { session: String(options.session) },
  ...options.fresh === true ? { fresh: true } : {},
  ...timeoutMs === undefined ? {} : { timeoutMs },
}

if (params.prompt === '-' || params.prompt === undefined && (command === 'ask' || command === 'send')) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  params.prompt = Buffer.concat(chunks).toString('utf8')
}
if (params.prompt !== undefined && String(params.prompt).trim().length === 0) {
  console.error('peer: a prompt is required (use --prompt - to read stdin)')
  process.exit(2)
}
if ((command === 'ask' || command === 'send') && params.peer === undefined) {
  console.error('peer: --peer is required')
  process.exit(2)
}

const method = `control/${command}`
if (!['control/list', 'control/ask', 'control/send', 'control/wait', 'control/inbox', 'control/ping'].includes(method)) {
  console.error(`peer: unknown command "${command}"`)
  process.exit(2)
}

let result
try {
  result = await conn.request(method, params, { timeoutMs: (params.timeoutMs ?? 120_000) + 30_000 })
} catch (error) {
  console.error(`peer: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  conn.close()
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

switch (command) {
  case 'ask':
    console.log(result.text)
    if (result.timedOut === true) {
      console.error(`peer: turn still running after ${String(result.elapsedMs)}ms (session ${result.sessionId})`)
      process.exit(3)
    }
    break
  case 'send':
    console.log(`${result.sessionId} ${result.messageId}`)
    break
  case 'wait':
  case 'inbox':
    if (result.messages.length === 0) console.log('(no messages)')
    for (const message of result.messages) console.log(`[${message.peer} ${message.at}] ${message.text}`)
    break
  case 'list':
    if (result.links.length === 0) console.log('(no linked peers)')
    for (const link of result.links) {
      console.log(`${link.name}\t${link.platform}/${link.arch}\tdsh ${link.version}\tcwd ${link.cwd || '?'}\tmodel ${link.model || '?'}`)
    }
    break
  default:
    console.log(JSON.stringify(result))
}
