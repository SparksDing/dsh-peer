/**
 * Hub-plugin probe: greet a hub, send one `peer/reply`, print the result.
 * Run with `node test/fake-link-probe.mjs tcp://127.0.0.1:3199 token name`.
 */
import { connect } from 'node:net'
import { once } from 'node:events'
import { PeerConnection } from '../lib/protocol.js'
import { connectWebSocket } from '../lib/ws.js'

const [url = 'tcp://127.0.0.1:3199', token = 'test-token', name = 'probe-link'] = process.argv.slice(2)
const target = new URL(url)
let socket
if (target.protocol === 'ws:' || target.protocol === 'wss:') {
  socket = await connectWebSocket(url)
} else {
  socket = connect(Number(target.port), target.hostname)
  await once(socket, 'connect')
}
const conn = new PeerConnection(socket, { label: 'probe-link', heartbeat: false })
conn.start()
const hello = await conn.request('peer/hello', { protocol: 1, name, role: 'link', token })
console.log(`hello: ${JSON.stringify(hello)}`)
const reply = await conn.request('peer/reply', { text: 'PLUGIN-HUB-OK', sessionId: 'probe' })
console.log(`reply: ${JSON.stringify(reply)}`)
conn.close()
