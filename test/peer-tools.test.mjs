import assert from 'node:assert/strict'
import { registerPeerTools } from '../lib/peer-tools.js'

const registered = []
const ctx = { tools: { register: tool => registered.push(tool) } }
const exec = { signal: new AbortController().signal, agent: { session: { id: 'local' } } }
const node = {
  name: 'node-a',
  list: () => [{ name: 'b', platform: 'linux', version: '1', status: 'connected', cwd: '/w', model: 'm', since: '' }],
  status: () => ({ connected: true }),
  targets: async () => ({ workspaces: [], sessions: [] }),
  ask: async request => ({ peer: request.peer, sessionId: 's', text: 'ok', status: 'completed', elapsedMs: 1, timedOut: false }),
  send: async request => ({ peer: request.peer, sessionId: 's', messageId: 'm' }),
  reply: async () => ({ peer: 'b', sessionId: 's', messageId: 'm' }),
  steer: async request => ({ peer: request.peer, sessionId: 's', mode: 'steer', accepted: true }),
  cancel: async request => ({ peer: request.peer, sessionId: 's', cancelled: false, status: 'idle' }),
  pending: () => ({ pending: [], sessions: [] }),
  bind: async () => ({ ok: true, sessionId: 's' }),
  wait: async () => ({ messages: [], timedOut: true }),
  inbox: () => [],
}

registerPeerTools(ctx, node)
assert.deepEqual(registered.map(tool => tool.name), [
  'peer_list', 'peer_status', 'peer_targets', 'peer_ask', 'peer_send',
  'peer_reply', 'peer_steer', 'peer_cancel', 'peer_pending', 'peer_bind',
  'peer_wait', 'peer_inbox',
])
const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
assert.equal((await byName.peer_list.execute({}, exec)).links.length, 1)
assert.deepEqual(await byName.peer_targets.execute({ peer: 'b' }, exec), { peer: 'b', workspaces: [], sessions: [] })
assert.equal((await byName.peer_ask.execute({ peer: 'b', prompt: 'hi' }, exec)).text, 'ok')
assert.equal((await byName.peer_send.execute({ peer: 'b', prompt: 'hi' }, exec)).messageId, 'm')
assert.equal((await byName.peer_reply.execute({ text: 'hi' }, exec)).messageId, 'm')
assert.equal((await byName.peer_steer.execute({ peer: 'b', text: 'x' }, exec)).accepted, true)
assert.equal((await byName.peer_cancel.execute({ peer: 'b' }, exec)).status, 'idle')
assert.deepEqual(await byName.peer_pending.execute({}, exec), { pending: [], sessions: [] })
assert.equal((await byName.peer_bind.execute({ id: 'p' }, exec)).ok, true)
assert.deepEqual(await byName.peer_wait.execute({}, exec), { messages: [], timedOut: true })
assert.deepEqual(await byName.peer_inbox.execute({}, exec), { messages: [] })

console.log('peer-tools.test.mjs: all checks passed')
