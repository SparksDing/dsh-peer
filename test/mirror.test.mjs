/**
 * Session mirror check: visible transcript replay, dedicated workspace,
 * recency reorder, and clear titles. Run with `node test/mirror.test.mjs`.
 */
import assert from 'node:assert/strict'
import { SessionMirror } from '../lib/mirror.js'

const WORKSPACE = '/tmp/peer-mirror-test'

/** Build a context with a recording session store and one existing workspace. */
function fakeContext({ extraSessionIds = [] } = {}) {
  const created = []
  const attached = []
  const moved = []
  const titles = []
  const flushed = []
  const sessions = {
    create(id, options) {
      const session = {
        id,
        options,
        events: [],
        append(type, data, intent) {
          this.events.push({ type, data, intent })
        },
      }
      created.push(session)
      return session
    },
    flush(session) {
      flushed.push(session.id)
      return Promise.resolve()
    },
  }
  const workspace = {
    path: WORKSPACE,
    get sessionIds() {
      return [...extraSessionIds, ...created.map(session => session.id)]
    },
    attachSession: async (id) => { attached.push(id) },
    insertSessionBefore: async (id, anchor) => { moved.push([id, anchor]) },
  }
  const registry = { list: () => (created.length === 0 ? [] : [workspace]), create: async () => workspace }
  const sessionTitle = { rename: (session, title) => { titles.push([session.id, title]) } }
  const ctx = {
    get: name => (name === 'sessions' ? sessions
      : name === 'workspaceRegistry' ? registry
        : name === 'sessionTitle' ? sessionTitle
          : undefined),
  }
  return { ctx, created, attached, moved, titles, flushed }
}

/** Let scheduled async work run. */
const tick = () => new Promise(resolve => setImmediate(resolve))

// 1. Only the visible transcript is mirrored, in order, into the dedicated workspace.
{
  const { ctx, created, attached, titles } = fakeContext()
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  assert.equal(mirror.available(), true)
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 1, type: 'session/end-seed', data: {} })
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 2, type: 'turn/start', data: { turn: 1 } })
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 3, type: 'user/message', data: { content: [] } })
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 4, type: 'assistant/message', data: { message: { content: [] } } })
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 5, type: 'tool/call', data: { name: 'pwsh' } })
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 6, type: 'tool/result', data: { message: {} } })
  mirror.append('SPARKS', 'peer-SPARKS-chat-abcdef123456', { seq: 7, type: 'turn/end', data: { turn: 1 } })
  await tick()

  assert.equal(created.length, 1)
  assert.equal(created[0].id, 'peer-mirror-peer-SPARKS-chat-abcdef123456')
  assert.deepEqual(created[0].options, { meta: { cwd: WORKSPACE } })
  assert.deepEqual(created[0].events.map(event => event.type), [
    'turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end',
  ])
  assert.deepEqual(attached, ['peer-mirror-peer-SPARKS-chat-abcdef123456'])
  assert.deepEqual(titles, [['peer-mirror-peer-SPARKS-chat-abcdef123456', 'Peer: SPARKS · 123456']])
}

// 2. A finished turn moves the mirror above older sessions.
{
  const { ctx, moved } = fakeContext({ extraSessionIds: ['older-session'] })
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  mirror.append('HP', 'peer-HP-x', { seq: 1, type: 'turn/start', data: {} })
  mirror.append('HP', 'peer-HP-x', { seq: 2, type: 'turn/end', data: {} })
  await tick()
  assert.deepEqual(moved, [['peer-mirror-peer-HP-x', 'older-session']])
}

// 3. Surface events carry an explicit append op and never cite remote seqs.
{
  const { ctx, created } = fakeContext()
  new SessionMirror(ctx, { workspacePath: WORKSPACE }).append('HP', 'peer-HP-x', { seq: 9, type: 'user/message', data: {}, sourceEventSeqs: [1, 2] })
  assert.deepEqual(created[0].events[0].intent, { surfaceOp: 'append' })
}

// 4. Lifecycle-only traffic creates nothing.
{
  const { ctx, created } = fakeContext()
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  mirror.append('HP', 'peer-HP-old', { seq: 1, type: 'session/end-seed', data: {} })
  mirror.append('HP', 'peer-HP-old', { seq: 2, type: 'agent-preset/selected', data: {} })
  assert.equal(created.length, 0)
}

// 5. A failing replay stops that conversation without throwing.
{
  const { ctx } = fakeContext()
  let appends = 0
  ctx.get = name => (name === 'sessions' ? {
    create: () => ({ id: 'x', append: () => { appends += 1; throw new Error('invalid event') } }),
  } : undefined)
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  mirror.append('HP', 'peer-HP-y', { seq: 1, type: 'turn/start', data: {} })
  mirror.append('HP', 'peer-HP-y', { seq: 2, type: 'turn/end', data: {} })
  assert.equal(appends, 1)
}

// 6. A context without a session store is a no-op; invalid payloads are ignored.
{
  const mirror = new SessionMirror({ get: () => undefined }, { workspacePath: WORKSPACE })
  assert.equal(mirror.available(), false)
  mirror.append('HP', 'peer-HP-z', { seq: 1, type: 'turn/start', data: {} })

  const { ctx, created } = fakeContext()
  const invalid = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  invalid.append('HP', 'peer-HP-w', null)
  invalid.append('HP', 'peer-HP-w', { seq: 1 })
  assert.equal(created.length, 0)
}

console.log('mirror.test.mjs: all checks passed')
