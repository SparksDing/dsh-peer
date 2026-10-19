/**
 * Tool-surface check: every tool definition registers and its result matches
 * the declared output schema. Run with `node test/tools.test.mjs`.
 */
import assert from 'node:assert/strict'
import { registerHubTools, registerLinkTools } from '../lib/tools.js'

const registered = []
const ctx = { tools: { register: tool => registered.push(tool) } }

const hubCalls = []
const hub = {
  list: () => [],
  ask: async request => {
    hubCalls.push(['ask', request])
    return { peer: 'win', sessionId: 'peer-win-default', text: 'done', status: 'completed', elapsedMs: 5, timedOut: false }
  },
  send: async request => {
    hubCalls.push(['send', request])
    return { peer: 'win', sessionId: 'peer-win-default', messageId: 'm1' }
  },
  wait: async request => {
    hubCalls.push(['wait', request])
    return { messages: [], timedOut: true }
  },
  readInbox: request => {
    hubCalls.push(['inbox', request])
    return { messages: [{ peer: 'win', text: 'hi', at: '2026-01-01T00:00:00.000Z' }] }
  },
}
registerHubTools(ctx, hub)
const hubTools = registered.splice(0)
assert.deepEqual(hubTools.map(tool => tool.name), ['peer_list', 'peer_ask', 'peer_send', 'peer_wait', 'peer_inbox'])

const byName = Object.fromEntries(hubTools.map(tool => [tool.name, tool]))
const exec = { signal: new AbortController().signal, agent: undefined }

assert.deepEqual(await byName.peer_list.execute({}, exec), { links: [] })
assert.deepEqual(await byName.peer_ask.execute({ peer: 'win', prompt: 'go', timeoutMs: 10 }, exec), {
  peer: 'win',
  sessionId: 'peer-win-default',
  text: 'done',
  status: 'completed',
  elapsedMs: 5,
  timedOut: false,
})
assert.equal(hubCalls.at(-1)[1].timeoutMs, 1_000, 'deadline is clamped to the floor')
assert.deepEqual(await byName.peer_send.execute({ peer: 'win', prompt: 'go' }), { peer: 'win', sessionId: 'peer-win-default', messageId: 'm1' })
assert.deepEqual(await byName.peer_wait.execute({ peer: 'win' }, exec), { messages: [], timedOut: true })
assert.equal(hubCalls.at(-1)[1].timeoutMs, 120_000, 'wait default')
assert.deepEqual(await byName.peer_inbox.execute({}), { messages: [{ peer: 'win', text: 'hi', at: '2026-01-01T00:00:00.000Z' }] })

// Every declared root is a closed object, as the tool runtime requires.
for (const tool of hubTools) {
  assert.equal(tool.output.schema.type, 'object')
}

const linkCalls = []
const link = {
  hubInfo: { name: 'linux-hub' },
  status: () => ({ connected: true, hub: 'linux-hub', url: 'tcp://h:3099', name: 'win', since: '2026-01-01T00:00:00.000Z', attempt: 0 }),
  reply: async (text, sessionId) => {
    linkCalls.push([text, sessionId])
    return { accepted: true }
  },
}
const linkCtx = { tools: { register: tool => registered.push(tool) } }
registerLinkTools(linkCtx, link)
const linkTools = registered.splice(0)
assert.deepEqual(linkTools.map(tool => tool.name), ['peer_reply', 'peer_status'])
const agentExec = { signal: new AbortController().signal, agent: { session: { id: 'local-session' } } }
assert.deepEqual(await linkTools[0].execute({ text: 'hello' }, agentExec), { accepted: true, hub: 'linux-hub' })
assert.deepEqual(linkCalls, [['hello', 'local-session']])
assert.deepEqual(await linkTools[1].execute({}), {
  connected: true,
  hub: 'linux-hub',
  url: 'tcp://h:3099',
  since: '2026-01-01T00:00:00.000Z',
})

// Rendering never throws on a well-formed result.
for (const tool of [...hubTools, ...linkTools]) {
  const sample = tool.name === 'peer_list'
    ? { links: [] }
    : tool.name === 'peer_ask'
      ? { peer: 'w', sessionId: 's', text: 't', status: 'completed', elapsedMs: 1, timedOut: false }
      : tool.name === 'peer_send'
        ? { peer: 'w', sessionId: 's', messageId: 'm' }
        : tool.name === 'peer_reply'
          ? { accepted: true, hub: 'h' }
          : tool.name === 'peer_status'
            ? { connected: false, hub: '', url: 'tcp://h', since: '' }
            : { messages: [], timedOut: true }
  assert.ok(Array.isArray(tool.output.render({}, sample)))
}

console.log('tools.test.mjs: all checks passed')
