/**
 * One node's inbound message bus.
 *
 * Every node has the same bus: incoming peer messages land in the inbox; a
 * message with a writable target session is delivered immediately, otherwise
 * it waits in `pending` until the user binds it. Waiters are notified on every
 * ingest, so `peer_wait` works the same on every node.
 */

/**
 * @typedef {object} PeerBusMessage
 * @property {string} id - stable message id.
 * @property {string} peer - sender node name.
 * @property {string} text - body.
 * @property {string} [targetSessionId] - requested local session.
 * @property {string} [originSessionId] - sender's session, for replies.
 * @property {number} at - epoch milliseconds.
 */

export class PeerBus {
  /**
   * @param {object} options - bus limits.
   * @param {number} [options.limit] - maximum retained inbox entries.
   */
  constructor(options = {}) {
    this.limit = options.limit ?? 200
    /** @type {PeerBusMessage[]} */
    this.inbox = []
    /** @type {PeerBusMessage[]} */
    this.pending = []
    /** @type {Set<() => void>} */
    this.waiters = new Set()
    this.counter = 0
  }

  /**
   * Take one inbound message: record it, then deliver or queue it.
   * @param {object} message - `{ peer, text, targetSessionId?, originSessionId? }`.
   * @param {(message: PeerBusMessage) => Promise<boolean>} deliver - delivery attempt.
   * @returns {Promise<PeerBusMessage>} the recorded message.
   */
  async ingest(message, deliver) {
    const entry = {
      id: `msg-${++this.counter}`,
      peer: String(message.peer ?? ''),
      text: String(message.text ?? ''),
      ...message.targetSessionId === undefined ? {} : { targetSessionId: String(message.targetSessionId) },
      ...message.originSessionId === undefined ? {} : { originSessionId: String(message.originSessionId) },
      at: Date.now(),
    }
    this.inbox.push(entry)
    if (this.inbox.length > this.limit) this.inbox.splice(0, this.inbox.length - this.limit)
    let delivered = false
    if (entry.targetSessionId !== undefined) {
      try {
        delivered = await deliver(entry)
      } catch {
        delivered = false
      }
    }
    if (!delivered) this.pending.push(entry)
    for (const waiter of [...this.waiters]) waiter()
    return entry
  }

  /**
   * Record one inbound message that was already delivered.
   * @param {object} message - `{ peer, text, targetSessionId? }`.
   * @returns {PeerBusMessage} the recorded entry.
   */
  record(message) {
    const entry = {
      id: `msg-${++this.counter}`,
      peer: String(message.peer ?? ''),
      text: String(message.text ?? ''),
      ...message.targetSessionId === undefined ? {} : { targetSessionId: String(message.targetSessionId) },
      at: Date.now(),
    }
    this.inbox.push(entry)
    if (this.inbox.length > this.limit) this.inbox.splice(0, this.inbox.length - this.limit)
    for (const waiter of [...this.waiters]) waiter()
    return entry
  }

  /**
   * List unbound messages.
   * @returns {PeerBusMessage[]} pending entries.
   */
  pendingView() {
    return [...this.pending]
  }

  /**
   * Deliver one pending message through the given delivery function.
   * @param {string} id - pending message id.
   * @param {(message: PeerBusMessage) => Promise<boolean>} deliver - delivery attempt.
   * @returns {Promise<boolean>} whether it was delivered.
   */
  async bind(id, deliver) {
    const index = this.pending.findIndex(entry => entry.id === id)
    if (index < 0) return false
    const entry = this.pending[index]
    const delivered = await deliver(entry)
    if (delivered) this.pending.splice(index, 1)
    return delivered
  }

  /**
   * Wait for the next inbound message after the current inbox head.
   * @param {number} timeoutMs - deadline.
   * @returns {Promise<PeerBusMessage[]>} messages received, empty on timeout.
   */
  wait(timeoutMs) {
    const start = this.inbox.length
    return new Promise(resolve => {
      const finish = () => {
        this.waiters.delete(finish)
        clearTimeout(timer)
        resolve(this.inbox.slice(start))
      }
      const timer = setTimeout(() => {
        this.waiters.delete(finish)
        resolve([])
      }, Math.max(1, timeoutMs))
      this.waiters.add(finish)
    })
  }

  /**
   * Read and clear consumed messages.
   * @returns {PeerBusMessage[]} the drained inbox.
   */
  drain() {
    const messages = [...this.inbox]
    this.inbox.length = 0
    return messages
  }
}
