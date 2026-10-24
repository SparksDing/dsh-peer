/**
 * Mirror remote peer sessions into local read-only sessions.
 *
 * `peer_ask` is an ordinary tool call, and the tool runtime has no streaming
 * progress channel, so the local session trace can only show a call and its
 * final result. Mirroring solves that without touching the Web client: each
 * remote conversation is replayed into a local session, and the existing GUI
 * renders that session like any other transcript.
 *
 * Replay is only safe from the start: `sourceEventSeqs` references remote
 * sequence numbers, so a mirror that begins mid-log would cite the wrong
 * entries. A conversation whose first observed event is not `seq 1` is left
 * unmirrored instead of showing a misleading transcript.
 *
 * @module @local/dsh-peer/mirror
 */

/** Message-producing events that must carry a surface intent. */
const SURFACE_EVENTS = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * Replays remote session events into local sessions.
 */
export class SessionMirror {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host context with `sessions`.
   * @param {{ prefix?: string, cwd?: string, logger?: import('@deepseek-ai/cordis').Context['logger'] }} [options]
   *   local id prefix, header cwd, and diagnostics.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.prefix = options.prefix ?? 'peer-mirror'
    this.cwd = options.cwd ?? process.cwd()
    this.logger = options.logger
    /** @type {Map<string, { session?: any, skipped?: boolean }>} */
    this.sessions = new Map()
  }

  /** @returns {boolean} whether the host exposes the session store. */
  available() {
    return this.ctx.get?.('sessions') !== undefined
  }

  /**
   * Replay one remote event.
   * @param {string} link - peer name, used only for diagnostics.
   * @param {string} remoteSessionId - remote wire session id.
   * @param {{ seq: number, type: string, data: unknown, surfaceOp?: unknown, sourceEventSeqs?: unknown }} event - remote session event.
   */
  append(link, remoteSessionId, event) {
    if (!this.available()) return
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
    let state = this.sessions.get(remoteSessionId)
    if (state === undefined) {
      if (event.seq !== 1) {
        this.sessions.set(remoteSessionId, { skipped: true })
        this.logger?.warn?.(`peer mirror: skipping ${remoteSessionId} from ${link}; first observed seq was ${String(event.seq)}`)
        return
      }
      const id = `${this.prefix}-${remoteSessionId}`.slice(0, 120)
      try {
        const store = this.ctx.get('sessions')
        if (store === undefined) return
        const session = store.create(id, { meta: { cwd: this.cwd } })
        state = { session }
        this.sessions.set(remoteSessionId, state)
      } catch (error) {
        this.sessions.set(remoteSessionId, { skipped: true })
        this.logger?.warn?.(`peer mirror: cannot create ${id}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    if (state.skipped === true || state.session === undefined) return
    try {
      if (SURFACE_EVENTS.has(event.type)) {
        state.session.append(event.type, event.data, {
          surfaceOp: event.surfaceOp ?? 'append',
          ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
        })
      } else {
        state.session.append(event.type, event.data)
      }
    } catch (error) {
      state.skipped = true
      this.logger?.warn?.(`peer mirror: replay of ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
