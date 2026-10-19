/**
 * Link check: a fake hub that dials nothing, accepts one link, runs one prompt
 * through the real remote harness, and asserts the link's `peer_reply` tool
 * reaches the hub. Run with `node test/fake-hub.mjs` while a dsh instance runs
 * the link role against `tcp://127.0.0.1:3199`.
 */
import { createServer } from 'node:net'
import { PeerConnection } from '../lib/protocol.js'

const TOKEN = process.env.PEER_TEST_TOKEN ?? 'test-token'
const PROMPT = process.env.PEER_TEST_PROMPT
  ?? "Call the peer_reply tool once with text 'BACK-FROM-LINK'. Then reply with exactly PEER_OK."

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const replies = []
let finalText = ''
let turnSeen = false

const server = createServer(async socket => {
  const conn = new PeerConnection(socket, { label: 'fake-hub', logger })
  let onHello = () => {}
  const helloSettled = new Promise(resolve => { onHello = () => resolve(undefined) })
  conn.onRequest(async (method, params) => {
    if (method === 'peer/hello') {
      if (params.token !== TOKEN) throw new Error('token rejected')
      onHello()
      return { protocol: 1, hub: { name: 'fake-hub', version: 'test' } }
    }
    if (method === 'peer/ping') return { at: Date.now() }
    if (method === 'peer/reply') {
      replies.push(String(params.text))
      return { accepted: true, at: Date.now() }
    }
    if (method === 'peer/info') return { hub: 'fake-hub', link: {} }
    throw new Error(`fake hub cannot serve ${method}`)
  })
  conn.onNotification((method, params) => {
    if (method === 'session.status' && params.status === 'idle') turnSeen = true
    if (method === 'session.event' && params.event.type === 'assistant/message') {
      finalText = params.event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
    }
  })
  conn.onClose(() => {
    console.log(JSON.stringify({ ok: false, error: 'link disconnected', replies, finalText }))
    process.exit(1)
  })
  conn.start()
  try {
  await helloSettled
  const init = await conn.request('initialize', {
    cwd: process.cwd(),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  }, { timeoutMs: 60_000 })
  console.log(`initialized: ${JSON.stringify(init)}`)
  const prompt = await conn.request('session/prompt', {
    sessionId: 'peer-win-test-smoke',
    contentBlocks: [{ type: 'text', text: PROMPT }],
  }, { timeoutMs: 60_000 })
  console.log(`prompt queued: ${JSON.stringify(prompt)}`)
  const deadline = Date.now() + 180_000
  while (!turnSeen && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  // Give a delayed peer/reply request a moment to arrive.
  await new Promise(resolve => setTimeout(resolve, 500))
  console.log(JSON.stringify({ ok: turnSeen, finalText, replies }, null, 2))
  } catch (error) {
    console.error(`fake hub failed: ${error?.message ?? error}`)
  }
  conn.close()
  server.close()
  process.exit(turnSeen ? 0 : 1)
})

server.listen(3199, '127.0.0.1', () => console.log('fake hub listening on 3199'))
