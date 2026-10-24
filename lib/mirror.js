/**
 * Mirror remote peer sessions into local read-only sessions.
 *
 * `peer_ask` is an ordinary tool call, and the tool runtime has no streaming
 * progress channel, so the local session trace can only show a call and its
 * final result. Mirroring solves that without touching the Web client: each
 * remote conversation is replayed into a local session, and the existing GUI
 * renders that session like any other transcript.
 *
 * All mirrors live in one dedicated workspace (default `~/peer-sessions`) so
 * they do not mix with project sessions. The workspace lists sessions in
 * registry order, so every finished turn moves its mirror to the top, which
 * keeps the list sorted by activity.
 *
 * Only the visible transcript is replayed. Lifecycle records the local
 * constructor already owns (for example `session/end-seed`) are skipped, and
 * `sourceEventSeqs` is dropped because it cites remote sequence numbers that a
 * partial replay cannot preserve.
 *
 * @module @local/dsh-peer/mirror
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
   * @param {{ prefix?: string, workspacePath?: string, workspaceTitle?: string, logger?: import('@deepseek-ai/cordis').Context['logger'] }} [options]
   *   local id prefix, dedicated workspace location and title, diagnostics.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.prefix = options.prefix ?? 'peer-mirror'
    this.workspacePath = options.workspacePath ?? join(homedir(), 'peer-sessions')
    this.workspaceTitle = options.workspaceTitle ?? 'Peer'
    this.logger = options.logger
    /** @type {Map<string, { session?: any, skipped?: boolean }>} */
    this.sessions = new Map()
    /** @type {Promise<any> | undefined} */
    this.workspace = undefined
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
   * @param {string} [_callerCwd] - retained for callers that still pass it.
   */
  append(link, remoteSessionId, event, _callerCwd) {
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
        void this.#touch(state.session.id)
      }
    } catch (error) {
      state.skipped = true
      process.stderr.write(`[peer-mirror] replay failed ${event.type}: ${error instanceof Error ? error.message : String(error)}\n`)
      this.logger?.warn?.(`peer mirror: replay of ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @returns {Promise<any | undefined>} the dedicated workspace, created on first use. */
  async #ensureWorkspace() {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const existing = registry.list().find(candidate => candidate.path === this.workspacePath)
    if (existing !== undefined) return existing
    await mkdir(this.workspacePath, { recursive: true })
    try {
      const created = await registry.create(this.workspacePath, this.workspaceTitle)
      process.stderr.write(`[peer-mirror] workspace created ${this.workspacePath}\n`)
      return created
    } catch (error) {
      process.stderr.write(`[peer-mirror] workspace create failed: ${error instanceof Error ? error.message : String(error)}\n`)
      return undefined
    }
  }

  /**
   * Create the local session inside the dedicated workspace.
   * @param {string} link - peer name, used in the title.
   * @param {string} remoteSessionId - remote wire session id.
   * @returns {{ session: any } | { skipped: true } | undefined} session state.
   */
  #create(link, remoteSessionId) {
    const store = this.ctx.get('sessions')
    if (store === undefined) return undefined
    const id = `${this.prefix}-${remoteSessionId}`.slice(0, 120)
    try {
      const session = store.create(id, { meta: { cwd: this.workspacePath } })
      const suffix = remoteSessionId.slice(-6)
      void this.ctx.get('sessionTitle')?.rename?.(session, `Peer: ${link} · ${suffix}`)
      process.stderr.write(`[peer-mirror] created ${id} cwd=${this.workspacePath}\n`)
      void this.#attach(id)
      return { session }
    } catch (error) {
      process.stderr.write(`[peer-mirror] create failed ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
      this.logger?.warn?.(`peer mirror: cannot create ${id}: ${error instanceof Error ? error.message : String(error)}`)
      return { skipped: true }
    }
  }

  /**
   * Attach a mirrored session to the dedicated workspace.
   * @param {string} sessionId - mirrored local session id.
   * @returns {Promise<void>} settlement of the attachment.
   */
  async #attach(sessionId) {
    const workspace = await (this.workspace ??= this.#ensureWorkspace())
    if (workspace === undefined) return
    try {
      await workspace.attachSession(sessionId)
      process.stderr.write(`[peer-mirror] attached ${sessionId} to ${workspace.path}\n`)
    } catch (error) {
      process.stderr.write(`[peer-mirror] attach failed ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  /**
   * Move a session to the top of its workspace so the list stays sorted by
   * most recent activity.
   * @param {string} sessionId - mirrored local session id.
   * @returns {Promise<void>} settlement of the move.
   */
  async #touch(sessionId) {
    const workspace = await (this.workspace ??= this.#ensureWorkspace())
    if (workspace === undefined) return
    try {
      const ids = workspace.sessionIds
      if (ids[0] === sessionId) return
      const anchor = ids.find(id => id !== sessionId)
      if (anchor === undefined) return
      await workspace.insertSessionBefore(sessionId, anchor)
    } catch (error) {
      process.stderr.write(`[peer-mirror] reorder failed ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}
