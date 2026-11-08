/**
 * One peer node's transport-agnostic bridge.
 *
 * The hub/link split is historical: a node is a node. Whoever sends a message
 * is that exchange's origin ("hub"); the receiver is its peer. This module owns
 * the parts both directions must share: sending, asking, replying, and the
 * local-session -> remote-session origin map used to route replies back.
 */

/**
 * @typedef {{ peer: string, sessionId: string }} PeerOrigin
 */

export class PeerBridge {
  /**
   * @param {object} options - transport adapter.
   * @param {string} options.name - this node's name.
   * @param {(peer: string) => any} options.require - resolve a connected peer by name.
   * @param {(peer: string, request: object) => Promise<any>} options.send - fire-and-forget send.
   * @param {(peer: string, request: object) => Promise<any>} options.ask - send and wait for the turn.
   * @param {(peer: string) => Promise<any>} options.targets - list the peer's sessions.
   */
  constructor(options) {
    /** @type {string} */
    this.name = options.name
    this.require = options.require
    this.send = options.send
    this.ask = options.ask
    this.targets = options.targets
    /** @type {Map<string, PeerOrigin>} local session -> the remote session that messaged it */
    this.origins = new Map()
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
   * @returns {PeerOrigin | undefined} the origin.
   */
  originFor(localSessionId) {
    return this.origins.get(String(localSessionId))
  }

  /**
   * Resolve the target for a send: an explicit session wins, then the origin of
   * the calling local session, then undefined (the transport decides).
   * @param {object} request - `{ peer, session, remoteSessionId, callerSessionId }`.
   * @returns {{ peer: string, session?: string, remoteSessionId?: string }} routed request.
   */
  route(request) {
    if (typeof request.remoteSessionId === 'string' && request.remoteSessionId.length > 0) return request
    if (typeof request.session === 'string' && request.session.length > 0) return request
    const origin = typeof request.callerSessionId === 'string' ? this.originFor(request.callerSessionId) : undefined
    if (origin !== undefined && origin.peer === request.peer) {
      return { ...request, remoteSessionId: origin.sessionId }
    }
    return request
  }
}
