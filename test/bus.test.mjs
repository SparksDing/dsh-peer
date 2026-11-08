import assert from 'node:assert/strict'
import { PeerBus } from '../lib/bus.js'

const bus = new PeerBus({ limit: 10 })
const delivered = []
const entry = await bus.ingest({ peer: 'p', text: 'hi', targetSessionId: 's' }, async message => {
  delivered.push(message)
  return true
})
assert.equal(entry.peer, 'p')
assert.equal(bus.inbox.length, 1)
assert.equal(bus.pending.length, 0)
assert.equal(delivered.length, 1)

const queued = await bus.ingest({ peer: 'p', text: 'no target' }, async () => true)
assert.equal(bus.pending.length, 1)
assert.equal(queued.targetSessionId, undefined)

const bound = await bus.bind(queued.id, async message => {
  delivered.push(message)
  return true
})
assert.equal(bound, true)
assert.equal(bus.pending.length, 0)
assert.equal(delivered.length, 2)

const waiting = bus.wait(50)
bus.record({ peer: 'p', text: 'later' })
const arrived = await waiting
assert.equal(arrived.length, 1)
assert.equal(arrived[0].text, 'later')

const timedOut = await bus.wait(5)
assert.deepEqual(timedOut, [])

assert.equal(bus.drain().length, 3)
assert.equal(bus.inbox.length, 0)

console.log('bus.test.mjs: all checks passed')
