/**
 * Session mirror check: transcript replay with a persistence handle, dedicated
 * workspace, prompt-summary titles, and recency order.
 * Run with `node test/mirror.test.mjs`.
 */
import assert from 'node:assert/strict'
import { SessionMirror } from '../lib/mirror.js'

const WORKSPACE = '/tmp/peer-mirror-test'
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** Build a context with recording sessions, persistence, workspace and titles. */
function fakeContext({ extraSessionIds = [] } = {}) {
  const created = []
  const attached = []
  const moved = []
  const titles = []
  const handleEvents = []
  const flushes = []

  const sessions = {
    create(id, options) {
      const session = {
        id,
        options,
        header: { id, cwd: options?.meta?.cwd },
        // The real constructor appends the session-end seed as seq 1.
        events: [{ seq: 0, type: 'session/end-seed', data: {} }],
        append(type, data, intent) {
          const event = { seq: this.events.length, type, data, intent }
          this.events.push(event)
          return event
        },
        eventAt(seq) {
          return this.events[seq]
        },
      }
      created.push(session)
      return session
    },
  }

  const persistence = {
    create: async () => ({
      append: async (events) => { handleEvents.push(...events.map(event => event.type)) },
      flush: async () => { flushes.push(true) },
    }),
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
  const sessionTitle = {
    rename: (session, title) => {
      titles.push([session.id, title])
      session.append('session/title', { title })
    },
  }

  const ctx = {
    get: name => (name === 'sessions' ? sessions
      : name === 'sessionPersistence' ? persistence
        : name === 'workspaceRegistry' ? registry
          : name === 'sessionTitle' ? sessionTitle
            : undefined),
  }
  return { ctx, created, attached, moved, titles, handleEvents, flushes }
}

// 1. Replay writes both the session and its persistence handle, in order.
{
  const { ctx, created, attached, handleEvents, flushes, titles, moved } = fakeContext({ extraSessionIds: ['older'] })
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  assert.equal(mirror.available(), true)

  const remote = 'peer-SPARKS-chat-abcdef123456'
  mirror.append('SPARKS', remote, { seq: 1, type: 'session/end-seed', data: {} })
  mirror.append('SPARKS', remote, { seq: 2, type: 'turn/start', data: { turn: 1 } })
  mirror.append('SPARKS', remote, { seq: 2.5, type: 'step/start', data: { turn: 1, step: 1 } })
  mirror.append('SPARKS', remote, { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '帮我查一下磁盘空间够不够' }] } })
  mirror.append('SPARKS', remote, { seq: 4, type: 'assistant/message', data: { message: { content: [] } } })
  mirror.append('SPARKS', remote, { seq: 5, type: 'tool/call', data: { name: 'pwsh' } })
  mirror.append('SPARKS', remote, { seq: 6, type: 'tool/result', data: { message: {} } })
  mirror.append('SPARKS', remote, { seq: 7, type: 'step/end', data: { turn: 1, step: 1 } })
  mirror.append('SPARKS', remote, { seq: 8, type: 'turn/end', data: { turn: 1 } })
  await settle()

  assert.equal(created.length, 1)
  assert.equal(created[0].id, 'peer-mirror-peer-SPARKS-chat-abcdef123456')
  assert.deepEqual(created[0].options, { meta: { cwd: WORKSPACE } })
  assert.deepEqual(created[0].events.map(event => event.type), [
    'session/end-seed', 'session/title',
    'turn/start', 'step/start', 'user/message', 'session/title', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end',
  ])
  assert.deepEqual(handleEvents, [
    'session/end-seed', 'session/title',
    'turn/start', 'step/start', 'user/message', 'session/title', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end',
  ])
  assert.deepEqual(attached, ['peer-mirror-peer-SPARKS-chat-abcdef123456'])
  assert.deepEqual(titles.at(-1), ['peer-mirror-peer-SPARKS-chat-abcdef123456', 'Peer: SPARKS · 123456 · 帮我查一下磁盘空间够不够'])
  assert.deepEqual(moved, [['peer-mirror-peer-SPARKS-chat-abcdef123456', 'older']])
  assert.equal(flushes.length, 1)
}

// 2. Lifecycle-only traffic creates nothing.
{
  const { ctx, created } = fakeContext()
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  mirror.append('HP', 'peer-HP-old', { seq: 1, type: 'session/end-seed', data: {} })
  mirror.append('HP', 'peer-HP-old', { seq: 2, type: 'agent-preset/selected', data: {} })
  await settle()
  assert.equal(created.length, 0)
}

// 3. A context without a session store is a no-op; invalid payloads are ignored.
{
  const mirror = new SessionMirror({ get: () => undefined }, { workspacePath: WORKSPACE })
  assert.equal(mirror.available(), false)
  mirror.append('HP', 'peer-HP-z', { seq: 1, type: 'turn/start', data: {} })

  const { ctx, created } = fakeContext()
  const invalid = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  invalid.append('HP', 'peer-HP-w', null)
  invalid.append('HP', 'peer-HP-w', { seq: 1 })
  await settle()
  assert.equal(created.length, 0)
}

// 4. A failing session append stops that conversation without throwing.
{
  const { ctx } = fakeContext()
  let appends = 0
  ctx.get = name => (name === 'sessions' ? {
    create: () => ({
      id: 'x',
      header: { id: 'x' },
      eventAt: () => undefined,
      append: () => { appends += 1; throw new Error('invalid event') },
    }),
  } : undefined)
  const mirror = new SessionMirror(ctx, { workspacePath: WORKSPACE })
  mirror.append('HP', 'peer-HP-y', { seq: 1, type: 'turn/start', data: {} })
  mirror.append('HP', 'peer-HP-y', { seq: 2, type: 'turn/end', data: {} })
  await settle()
  assert.equal(appends, 1)
}

console.log('mirror.test.mjs: all checks passed')
