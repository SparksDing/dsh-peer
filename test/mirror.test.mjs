/**
 * Session mirror check: only visible transcript events replay into one local
 * session, lifecycle records are skipped, and surface placement is explicit.
 * Run with `node test/mirror.test.mjs`; no dsh runtime required.
 */
import assert from 'node:assert/strict'
import { SessionMirror } from '../lib/mirror.js'

/** Build a context whose session store records every append. */
function fakeContext() {
  const created = []
  const attached = []
  const flushed = []
  let workspace
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
  workspace = {
    path: process.cwd(),
    attachSession: async (id) => { attached.push(id) },
  }
  const workspaceRegistry = { list: () => [workspace], create: async () => workspace }
  const titles = []
  const sessionTitle = { rename: (session, title) => { titles.push([session.id, title]) } }
  return {
    ctx: {
      get: name => (name === 'sessions' ? sessions
        : name === 'workspaceRegistry' ? workspaceRegistry
          : name === 'sessionTitle' ? sessionTitle
            : undefined),
    },
    created,
    attached,
    flushed,
    titles,
  }
}

/** Let scheduled async work run. */
const tick = () => new Promise(resolve => setImmediate(resolve))

// 1. Only the visible transcript is mirrored, in order.
{
  const { ctx, created, attached, flushed, titles } = fakeContext()
  const mirror = new SessionMirror(ctx)
  assert.equal(mirror.available(), true)
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 1, type: 'session/end-seed', data: {} })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 2, type: 'agent-preset/selected', data: {} })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 3, type: 'turn/start', data: { turn: 1 } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 4, type: 'user/message', data: { content: [] } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 5, type: 'assistant/message', data: { message: { content: [] } } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 6, type: 'tool/call', data: { name: 'pwsh' } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 7, type: 'tool/result', data: { message: {} } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 8, type: 'turn/end', data: { turn: 1 } })

  await tick()
  assert.equal(created.length, 1)
  assert.deepEqual(attached, ['peer-mirror-peer-SPARKS-default'])
  assert.deepEqual(flushed, ['peer-mirror-peer-SPARKS-default'])
  assert.deepEqual(titles, [['peer-mirror-peer-SPARKS-default', 'Peer: SPARKS']])
  assert.equal(created[0].id, 'peer-mirror-peer-SPARKS-default')
  assert.deepEqual(created[0].options, { meta: { cwd: process.cwd() } })
  assert.deepEqual(created[0].events.map(event => event.type), [
    'turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end',
  ])
}

// 2. Surface events carry an explicit append op and never cite remote seqs.
{
  const { ctx, created } = fakeContext()
  new SessionMirror(ctx).append('HP', 'peer-HP-x', { seq: 9, type: 'user/message', data: {}, sourceEventSeqs: [1, 2] })
  assert.deepEqual(created[0].events[0].intent, { surfaceOp: 'append' })
}

// 3. A conversation that only sends lifecycle records creates nothing.
{
  const { ctx, created } = fakeContext()
  const mirror = new SessionMirror(ctx)
  mirror.append('HP', 'peer-HP-old', { seq: 1, type: 'session/end-seed', data: {} })
  mirror.append('HP', 'peer-HP-old', { seq: 2, type: 'agent-preset/selected', data: {} })
  assert.equal(created.length, 0)
}

// 4. A failing replay stops that conversation without throwing.
{
  const { ctx } = fakeContext()
  let appends = 0
  ctx.get = name => (name === 'sessions' ? {
    create: () => ({ append: () => { appends += 1; throw new Error('invalid event') } }),
  } : undefined)
  const mirror = new SessionMirror(ctx)
  mirror.append('HP', 'peer-HP-y', { seq: 1, type: 'turn/start', data: {} })
  mirror.append('HP', 'peer-HP-y', { seq: 2, type: 'turn/end', data: {} })
  assert.equal(appends, 1)
}

// 5. A context without a session store is a no-op.
{
  const mirror = new SessionMirror({ get: () => undefined })
  assert.equal(mirror.available(), false)
  mirror.append('HP', 'peer-HP-z', { seq: 1, type: 'turn/start', data: {} })
}

// 6. Invalid payloads are ignored.
{
  const { ctx, created } = fakeContext()
  const mirror = new SessionMirror(ctx)
  mirror.append('HP', 'peer-HP-w', null)
  mirror.append('HP', 'peer-HP-w', { seq: 1 })
  assert.equal(created.length, 0)
}

console.log('mirror.test.mjs: all checks passed')
