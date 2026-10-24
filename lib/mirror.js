/**
 * Mirror remote peer sessions into local read-only sessions.
 *
 * `peer_ask` is an ordinary tool call, and the tool runtime has no streaming
 * progress channel, so the local session trace can only show a call and its
 * final result. Mirroring solves that without touching the Web client: each
 * remote conversation is replayed into a local session, and the existing GUI
 * renders that session like any other transcript.
 *
 * Only the visible transcript is replayed: turn boundaries, messages, tool
 * calls and tool results. Lifecycle records the local constructor already owns
 * (for example `session/end-seed`) are skipped because appending a second one
 * fails, and `sourceEventSeqs` is dropped because it cites remote sequence
 * numbers that a partial replay cannot preserve.
 *
 * The Web sidebar lists sessions through workspaces and filters each workspace
 * by the session header cwd, so a mirror adopts its workspace path as cwd and
 * attaches itself there. Without that it exists in the store but stays
 * invisible.
 *
 * @module @local/dsh-peer/mirror
 */

/** Events that make up the visible transcript. */
const MIRRORED_EVENTS = new Set([
  'turn/start',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/end',
])

/** Events that must carry a surface intent. */
const SURFACE_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result'])

/**
 * Replays remote session events into local sessions.
 */
export class SessionMirror {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host context with `sessions`.
   * @param {{ prefix?: string, cwd?: string, logger?: import('@deepseek-ai/cordis').Context['logger'] }} [options]
   *   local id prefix, fallback header cwd, and diagnostics.
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
   * @param {string} link - peer name.
   * @param {string} remoteSessionId - remote wire session id.
   * @param {{ type: string, data: unknown }} event - remote session event.
   */
  append(link, remoteSessionId, event) {
    if (!this.available()) return
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
    if (!MIRRORED_EVENTS.has(event.type)) return
    let state = this.sessions.get(remoteSessionId)
    if (state === undefined) {
      state = this.#create(link, remoteSessionId)
      if (state === undefined) return
      this.sessions.set(remoteSessionId, state)
    }
    if (state.skipped === true || state.session === undefined) return
    try {
      if (SURFACE_EVENTS.has(event.type)) {
        state.session.append(event.type, event.data, { surfaceOp: 'append' })
      } else {
        state.session.append(event.type, event.data)
      }
      if (event.type === 'turn/end') {
        void this.ctx.get('sessions')?.flush?.(state.session)?.catch?.(() => {})
      }
    } catch (error) {
      state.skipped = true
      process.stderr.write(`[peer-mirror] replay failed ${event.type}: ${error instanceof Error ? error.message : String(error)}\n`)
      this.logger?.warn?.(`peer mirror: replay of ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Create the local session in the workspace it will appear under.
   * @param {string} link - peer name, used in the title.
   * @param {string} remoteSessionId - remote wire session id.
   * @returns {{ session: any } | { skipped: true } | undefined} session state.
   */
  #create(link, remoteSessionId) {
    const store = this.ctx.get('sessions')
    if (store === undefined) return undefined
    const id = `${this.prefix}-${remoteSessionId}`.slice(0, 120)
    const registry = this.ctx.get('workspaceRegistry')
    const workspace = registry?.list().find(candidate => candidate.path === this.cwd) ?? registry?.list()[0]
    const cwd = workspace?.path ?? this.cwd
    try {
      const session = store.create(id, { meta: { cwd } })
      process.stderr.write(`[peer-mirror] created ${id} cwd=${cwd}\n`)
      const title = `Peer: ${link}`
      void this.ctx.get('sessionTitle')?.rename?.(session, title)
      if (workspace !== undefined) {
        void workspace.attachSession(id).then(
          () => process.stderr.write(`[peer-mirror] attached ${id} to ${workspace.path}\n`),
          error => process.stderr.write(`[peer-mirror] attach failed ${id}: ${error instanceof Error ? error.message : String(error)}\n`),
        )
      }
      return { session }
    } catch (error) {
      process.stderr.write(`[peer-mirror] create failed ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
      this.logger?.warn?.(`peer mirror: cannot create ${id}: ${error instanceof Error ? error.message : String(error)}`)
      return { skipped: true }
    }
  }
}
