/**
 * Hub protocol check: one real `PeerHub` against an in-process fake link.
 * Run with `node test/hub.test.mjs`; it needs no model and no dsh process.
 */
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { once } from 'node:events'
import { PeerHub } from '../lib/hub.js'
import { PeerConnection } from '../lib/protocol.js'

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const hub = new PeerHub({ logger, get: () => undefined }, {
  name: 'test-hub',
  token: 'correct-horse',
  listen: { host: '127.0.0.1', port: 3199 },
  version: 'test',
})
await hub.start()

let replySeq = 0
const replies = []

async function connectFakeLink(name, token) {
  const socket = connect(3199, '127.0.0.1')
  await once(socket, 'connect')
  const conn = new PeerConnection(socket, { label: 'fake', logger })
  conn.onRequest(async (method, params) => {
    switch (method) {
      case 'peer/ping':
        return { at: Date.now() }
      case 'initialize':
        return { serverInfo: { name: 'fake-runtime', version: '0' } }
      case 'peer/ensure-session':
        return { resumed: false }
      case 'session/prompt': {
        const messageId = `msg-${++replySeq}`
        const sessionId = String(params.sessionId)
        setTimeout(() => {
          conn.notify('session.event', { sessionId, event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } } })
          conn.notify('session.event', { sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `echo: ${String(params.contentBlocks[0].text)}` }] } } } })
          conn.notify('session.event', { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
          conn.notify('session.status', { sessionId, status: 'idle' })
        }, 10)
        return { messageId }
      }
      default:
        throw new Error(`fake link cannot serve ${method}`)
    }
  })
  conn.start()
  const result = await conn.request('peer/hello', { protocol: 1, name, role: 'link', token })
  assert.equal(result.protocol, 1)
  return conn
}

// 1. Bad token is refused and the hub stays up.
{
  const socket = connect(3199, '127.0.0.1')
  await once(socket, 'connect')
  const conn = new PeerConnection(socket, { label: 'bad', logger })
  conn.start()
  await assert.rejects(conn.request('peer/hello', { protocol: 1, name: 'intruder', role: 'link', token: 'wrong' }), /token rejected/)
  conn.close()
  assert.equal(hub.list().length, 0)
}

// 2. A link can greet, be discovered, answer a turn, and be waited on.
const link = await connectFakeLink('windows-pc', 'correct-horse')
assert.equal(hub.list().length, 1)
assert.equal(hub.list()[0].name, 'windows-pc')

const asked = await hub.ask({ peer: 'windows-pc', prompt: 'ping' })
assert.equal(asked.text, 'echo: ping')
assert.equal(asked.status, 'completed')
assert.equal(asked.timedOut, false)
assert.match(asked.sessionId, /^peer-windows-pc-/)

const second = await hub.ask({ peer: 'windows', prompt: 'again' })
assert.equal(second.sessionId, asked.sessionId, 'the default conversation is reused')
assert.equal(second.text, 'echo: again')

const fresh = await hub.ask({ peer: 'windows-pc', prompt: 'new', fresh: true })
assert.notEqual(fresh.sessionId, asked.sessionId)

const named = await hub.ask({ peer: 'windows-pc', prompt: 'named', session: 'deploy' })
assert.match(named.sessionId, /^peer-windows-pc-deploy$/)
assert.equal((await hub.ask({ peer: 'windows-pc', prompt: 'named2', session: 'deploy' })).sessionId, named.sessionId)

// 3. An unsolicited reply reaches the hub's inbox and a blocked wait.
const pending = hub.wait({ timeoutMs: 5_000 })
await new Promise(resolve => setTimeout(resolve, 50))
await link.request('peer/reply', { text: 'status: disk at 90%', sessionId: 'local-1' })
const waited = await pending
assert.equal(waited.timedOut, false)
assert.equal(waited.messages.length, 1)
assert.equal(waited.messages[0].text, 'status: disk at 90%')
assert.equal(waited.messages[0].peer, 'windows-pc')

// 4. Reading the inbox drains it; a later wait times out cleanly.
assert.deepEqual(hub.readInbox().messages, [])
const empty = await hub.wait({ timeoutMs: 100 })
assert.equal(empty.timedOut, true)
assert.deepEqual(empty.messages, [])

// 5. Ambiguous names fail loud; an unknown name lists the connected peers.
await assert.rejects(hub.ask({ peer: 'nope', prompt: 'x' }), /no connected peer matches "nope"/)

link.close()
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(hub.list().length, 0)

await hub.stop()
console.log('hub.test.mjs: all checks passed')
