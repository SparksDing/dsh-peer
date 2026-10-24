/**
 * Session mirror check: remote events replay into one local session, surface
 * events keep their placement fields, and a mid-log start is refused.
 * Run with `node test/mirror.test.mjs`; no dsh runtime required.
 */
import assert from 'node:assert/strict'
import { SessionMirror } from '../lib/mirror.js'

/** Build a context whose session store records every append. */
function fakeContext() {
  const created = []
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
  }
  return { ctx: { get: name => (name === 'sessions' ? sessions : undefined) }, created }
}

// 1. A full replay from seq 1 creates one session and mirrors every event.
{
  const { ctx, created } = fakeContext()
  const mirror = new SessionMirror(ctx)
  assert.equal(mirror.available(), true)
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 1, type: 'turn/start', data: { turn: 1 } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 2, type: 'user/message', data: { content: [] }, surfaceOp: 'append' })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 3, type: 'assistant/message', data: { message: { content: [] } } })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 4, type: 'tool/result', data: { message: {} }, surfaceOp: 'append', sourceEventSeqs: [3] })
  mirror.append('SPARKS', 'peer-SPARKS-default', { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  assert.equal(created.length, 1)
  assert.equal(created[0].id, 'peer-mirror-peer-SPARKS-default')
  assert.deepEqual(created[0].options, { meta: { cwd: process.cwd() } })
  assert.deepEqual(created[0].events.map(event => event.type), ['turn/start', 'user/message', 'assistant/message', 'tool/result', 'turn/end'])
  assert.deepEqual(created[0].events[1].intent, { surfaceOp: 'append' })
  assert.deepEqual(created[0].events[3].intent, { surfaceOp: 'append', sourceEventSeqs: [3] })
  assert.equal(created[0].events[0].intent, undefined)
}

// 2. A surface event without an explicit op defaults to append.
{
  const { ctx, created } = fakeContext()
  new SessionMirror(ctx).append('HP', 'peer-HP-x', { seq: 1, type: 'user/message', data: {} })
  assert.deepEqual(created[0].events[0].intent, { surfaceOp: 'append' })
}

// 3. Starting mid-log is refused rather than producing wrong citations.
{
  const { ctx, created } = fakeContext()
  const mirror = new SessionMirror(ctx)
  mirror.append('HP', 'peer-HP-old', { seq: 42, type: 'assistant/message', data: {} })
  mirror.append('HP', 'peer-HP-old', { seq: 43, type: 'turn/end', data: {} })
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
