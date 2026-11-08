/**
 * One peer node. Every DSH instance is this same node: it may listen, connect,
 * or both, and it exposes one tool surface. "Hub" and "link" survive only as
 * transport capabilities, never as node types: whoever sends a message is that
 * exchange's initiator, and whoever receives it is its target.
 */

/**
 * @typedef {object} PeerNodeCapabilities
 * @property {(peer: string) => Promise<any>} targets - the other side's sessions.
 * @property {(request: object) => Promise<any>} ask - send and wait for the turn.
 * @property {(request: object) => Promise<any>} send - fire-and-forget send.
 * @property {(request: object) => Promise<any>} reply - answer the origin session.
 * @property {() => any} list - connected peers.
 * @property {(request: object) => Promise<any>} [steer] - inject into a running turn.
 * @property {(request: object) => Promise<any>} [cancel] - abort a turn.
 * @property {() => any} [pending] - unbound received messages.
 * @property {(request: object) => Promise<any>} [bind] - bind a pending message.
 * @property {() => any} [status] - connection status.
 */

export class PeerNode {
  /**
   * @param {object} options - node identity and capabilities.
   * @param {string} options.name - this node's name.
   * @param {PeerNodeCapabilities} options.capabilities - transport-backed operations.
   */
  constructor(options) {
    this.name = options.name
    this.capabilities = options.capabilities
    /** @type {Map<string, { peer: string, sessionId: string }>} local session -> the remote session that messaged it */
    this.origins = new Map()
    /** @type {Map<string, { remoteDir?: string, session?: string, remoteSessionId?: string }>} local session:peer -> bound target */
    this.bindings = new Map()
  }

  /**
   * Remember which remote session last messaged one local session.
   * @param {string} localSessionId - local session id.
   * @param {string} peer - peer name.
   * @param {string} sessionId - peer session id.
   * @returns {void}
   */
  remember(localSessionId, peer, sessionId) {
    this.origins.set(String(localSessionId), { peer, sessionId: String(sessionId) })
  }

  /**
   * The remote session that last messaged a local session.
   * @param {string} localSessionId - local session id.
   * @returns {{ peer: string, sessionId: string } | undefined} the origin.
   */
  originFor(localSessionId) {
    return this.origins.get(String(localSessionId))
  }

  /**
   * The bound target for one local session and peer.
   * @param {string} localSessionId - local session id.
   * @param {string} peer - peer name.
   * @returns {{ remoteDir?: string, session?: string, remoteSessionId?: string } | undefined} the binding.
   */
  bindingFor(localSessionId, peer) {
    return this.bindings.get(`${String(localSessionId)}:${peer}`)
  }

  /**
   * Bind one local session to a peer target; later sends reuse it.
   * @param {string} localSessionId - local session id.
   * @param {string} peer - peer name.
   * @param {{ remoteDir?: string, session?: string, remoteSessionId?: string }} target - chosen target.
   * @returns {void}
   */
  bindTarget(localSessionId, peer, target) {
    this.bindings.set(`${String(localSessionId)}:${peer}`, { ...target })
  }

  /**
   * Send a message to a peer, defaulting the target to the calling session's origin.
   * @param {object} request - `{ callerSessionId, peer, session, remoteSessionId, prompt, remoteDir, fresh }`.
   * @returns {Promise<any>} the transport receipt.
   */
  send(request) {
    const origin = request.remoteSessionId === undefined && request.session === undefined
      && typeof request.callerSessionId === 'string'
      ? this.originFor(request.callerSessionId)
      : undefined
    const routed = origin === undefined || origin.peer !== request.peer
      ? request
      : { ...request, remoteSessionId: origin.sessionId }
    return this.capabilities.send(routed)
  }

  /**
   * Ask a peer and wait for its turn, defaulting the target to the calling session's origin.
   * @param {object} request - same fields as {@link send}.
   * @returns {Promise<any>} the peer's answer.
   */
  ask(request) {
    const origin = request.remoteSessionId === undefined && request.session === undefined
      && typeof request.callerSessionId === 'string'
      ? this.originFor(request.callerSessionId)
      : undefined
    const routed = origin === undefined || origin.peer !== request.peer
      ? request
      : { ...request, remoteSessionId: origin.sessionId }
    return this.capabilities.ask(routed)
  }

  /**
   * Reply to the session that last messaged a local session.
   * @param {string} callerSessionId - the local session replying.
   * @param {string} text - reply body.
   * @param {string} [targetSessionId] - explicit target.
   * @returns {Promise<any>} the transport receipt.
   */
  reply(callerSessionId, text, targetSessionId) {
    const origin = this.originFor(callerSessionId)
    if (origin === undefined && targetSessionId === undefined) {
      throw new Error('peer_reply has no origin; pass targetSessionId or send with peer_send')
    }
    return this.send({
      callerSessionId,
      peer: origin?.peer,
      remoteSessionId: targetSessionId ?? origin?.sessionId,
      prompt: text,
    })
  }

  /** @returns {any} connected peers. */
  list() {
    return this.capabilities.list()
  }

  /** @param {string} peer - peer name. @returns {Promise<any>} the peer's sessions. */
  targets(peer) {
    return this.capabilities.targets(peer)
  }

  /** @param {object} request - steer request. @returns {Promise<any>} the receipt. */
  steer(request) {
    return this.capabilities.steer === undefined
      ? Promise.reject(new Error('this node cannot steer'))
      : this.capabilities.steer(request)
  }

  /** @param {object} request - cancel request. @returns {Promise<any>} the receipt. */
  cancel(request) {
    return this.capabilities.cancel === undefined
      ? Promise.reject(new Error('this node cannot cancel'))
      : this.capabilities.cancel(request)
  }

  /** @returns {any} unbound received messages. */
  pending() {
    return this.capabilities.pending?.() ?? []
  }

  /** @param {object} request - bind request. @returns {Promise<any>} the receipt. */
  bind(request) {
    return this.capabilities.bind === undefined
      ? Promise.reject(new Error('this node cannot bind'))
      : this.capabilities.bind(request)
  }

  /**
   * Wait for the next unsolicited peer message.
   * @param {object} request - `{ timeoutMs }`.
   * @returns {Promise<any>} the messages or a timeout.
   */
  wait(request) {
    return this.capabilities.wait === undefined
      ? Promise.resolve({ messages: [], timedOut: true })
      : this.capabilities.wait(request)
  }

  /** @returns {any[]} received messages no turn has consumed. */
  inbox() {
    return this.capabilities.inbox?.() ?? []
  }

  /** @returns {any} connection status. */
  status() {
    return this.capabilities.status?.() ?? { connected: false }
  }
}
