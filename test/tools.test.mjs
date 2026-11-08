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
  targets: async peer => ({ peer, cwd: '/w', workspaces: [{ path: '/w', title: 'w' }], sessions: [{ id: 'peer-win-default', cwd: '/w', title: 'win chat', createdAt: 1 }] }),
  ask: async request => {
    hubCalls.push(['ask', request])
    return { peer: 'win', sessionId: 'peer-win-default', text: 'done', status: 'completed', elapsedMs: 5, timedOut: false }
  },
  send: async request => {
    hubCalls.push(['send', request])
    return { peer: 'win', sessionId: 'peer-win-default', messageId: 'm1' }
  },
  steer: async request => {
    hubCalls.push(['steer', request])
    return { peer: 'win', sessionId: 'peer-win-default', mode: 'steer', accepted: true, messageId: 'm2' }
  },
  cancel: async request => {
    hubCalls.push(['cancel', request])
    return { peer: 'win', sessionId: 'peer-win-default', cancelled: true }
  },
  pendingView: () => ({ pending: [{ id: 'pending-1', peer: 'win', remoteSessionId: 'peer-win-default', workspace: '/w', text: 'hi', at: 1 }], sessions: [{ id: 's1', workspace: '/w' }] }),
  bind: async request => {
    hubCalls.push(['bind', request])
    return { ok: true, sessionId: request.sessionId ?? 'peer-inbox-x' }
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
assert.deepEqual(hubTools.map(tool => tool.name), ['peer_list', 'peer_targets', 'peer_ask', 'peer_send', 'peer_steer', 'peer_cancel', 'peer_pending', 'peer_bind', 'peer_wait', 'peer_inbox'])

const byName = Object.fromEntries(hubTools.map(tool => [tool.name, tool]))
const exec = { signal: new AbortController().signal, agent: undefined }

assert.deepEqual(await byName.peer_list.execute({}, exec), { links: [] })
assert.deepEqual(await byName.peer_targets.execute({ peer: 'win' }, exec), { peer: 'win', cwd: '/w', workspaces: [{ path: '/w', title: 'w' }], sessions: [{ id: 'peer-win-default', cwd: '/w', title: 'win chat', createdAt: 1 }] })
assert.deepEqual(await byName.peer_ask.execute({ peer: 'win', prompt: 'go', timeoutMs: 10 }, exec), {
  peer: 'win',
  sessionId: 'peer-win-default',
  text: 'done',
  status: 'completed',
  elapsedMs: 5,
  timedOut: false,
})
assert.equal(hubCalls.at(-1)[1].timeoutMs, 1_000, 'deadline is clamped to the floor')
assert.deepEqual(await byName.peer_send.execute({ peer: 'win', prompt: 'go' }, exec), { peer: 'win', sessionId: 'peer-win-default', messageId: 'm1' })
assert.deepEqual(await byName.peer_steer.execute({ peer: 'win', text: 'stop that' }, exec), { peer: 'win', sessionId: 'peer-win-default', mode: 'steer', accepted: true })
assert.deepEqual(await byName.peer_cancel.execute({ peer: 'win', reason: 'test' }, exec), { peer: 'win', sessionId: 'peer-win-default', cancelled: true })
assert.deepEqual(await byName.peer_pending.execute({}, exec), { pending: [{ id: 'pending-1', peer: 'win', remoteSessionId: 'peer-win-default', workspace: '/w', text: 'hi', at: 1 }], sessions: [{ id: 's1', workspace: '/w' }] })
assert.deepEqual(await byName.peer_bind.execute({ id: 'pending-1', sessionId: 's1' }, exec), { ok: true, sessionId: 's1' })
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
  targets: async () => ({ workspaces: [], sessions: [] }),
  originFor: () => undefined,
  status: () => ({ connected: true, hub: 'linux-hub', url: 'tcp://h:3099', name: 'win', since: '2026-01-01T00:00:00.000Z', attempt: 0, version: '0.2.0' }),
  reply: async (text, sessionId) => {
    linkCalls.push([text, sessionId])
    return { accepted: true, delivered: true, pending: false }
  },
}
const linkCtx = { tools: { register: tool => registered.push(tool) } }
registerLinkTools(linkCtx, link)
const linkTools = registered.splice(0)
assert.deepEqual(linkTools.map(tool => tool.name), ['peer_reply', 'peer_targets', 'peer_ask', 'peer_send', 'peer_status'])
const agentExec = { signal: new AbortController().signal, agent: { session: { id: 'local-session' } } }
const linkByName = Object.fromEntries(linkTools.map(tool => [tool.name, tool]))
assert.deepEqual(await linkByName.peer_reply.execute({ text: 'hello' }, agentExec), { accepted: true, delivered: true, pending: false, hub: 'linux-hub' })
assert.deepEqual(linkCalls, [['hello', 'local-session']])
assert.deepEqual(await linkByName.peer_targets.execute({}, agentExec), { workspaces: [], sessions: [] })
assert.deepEqual(await linkByName.peer_ask.execute({ text: 'q' }, agentExec), { hub: 'linux-hub', reply: '(no reply before timeout)' })
assert.deepEqual(await linkByName.peer_send.execute({ text: 'unsolicited' }, agentExec), { accepted: true, delivered: true, pending: false, hub: 'linux-hub' })
assert.deepEqual(await linkByName.peer_status.execute({}), {
  connected: true,
  hub: 'linux-hub',
  url: 'tcp://h:3099',
  since: '2026-01-01T00:00:00.000Z',
  version: '0.2.0',
})

// Rendering never throws on a well-formed result.
for (const tool of [...hubTools, ...linkTools]) {
  const sample = tool.name === 'peer_list'
    ? { links: [] }
    : tool.name === 'peer_ask'
      ? { peer: 'w', sessionId: 's', text: 't', status: 'completed', elapsedMs: 1, timedOut: false }
      : tool.name === 'peer_send'
        ? { peer: 'w', sessionId: 's', messageId: 'm' }
        : tool.name === 'peer_steer'
          ? { peer: 'w', sessionId: 's', mode: 'steer', accepted: true }
          : tool.name === 'peer_cancel'
            ? { peer: 'w', sessionId: 's', cancelled: true }
            : tool.name === 'peer_pending'
              ? { pending: [{ id: 'p', peer: 'w', remoteSessionId: 'r', workspace: '/w', text: 't', at: 1 }], sessions: [] }
              : tool.name === 'peer_bind'
                ? { ok: true, sessionId: 's' }
            : tool.name === 'peer_reply'
              ? { accepted: true, delivered: true, pending: false, hub: 'h' }
          : tool.name === 'peer_status'
            ? { connected: false, hub: '', url: 'tcp://h', since: '' }
            : { messages: [], timedOut: true }
  assert.ok(Array.isArray(tool.output.render({}, sample)))
}

console.log('tools.test.mjs: all checks passed')
