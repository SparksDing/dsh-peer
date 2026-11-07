/**
 * Mirror remote peer sessions into local read-only sessions.
 *
 * `peer_ask` is an ordinary tool call, and the tool runtime has no streaming
 * progress channel, so the local session trace can only show a call and its
 * final result. Mirroring solves that without touching the Web client: each
 * remote conversation is replayed into a local session, and the existing GUI
 * renders that session like any other transcript.
 *
 * All mirrors live in one dedicated workspace (default `~/peer-sessions`), each
 * titled with the peer, the remote id suffix, and a short prompt summary. Every
 * finished turn moves its mirror to the top of the workspace list.
 *
 * A mirror has no Agent, so the agent loop never acquires its persistence write
 * handle. The mirror acquires one itself and appends each event as it is
 * replayed; the first handle append carries the session's own initial event so
 * sequence numbers stay contiguous.
 *
 * @module @local/dsh-peer/mirror
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Events that make up the visible transcript. */
const MIRRORED_EVENTS = new Set([
  'turn/start',
  'step/start',
  'step/end',
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
    /** @type {Map<string, any>} */
    this.sessions = new Map()
    /** @type {Promise<any> | undefined} */
    this.workspace = undefined
  }

  /** @returns {boolean} whether the host exposes the session store. */
  available() {
    return this.ctx.get?.('sessions') !== undefined
  }

  /**
   * Replay one remote event. Events are queued per remote session so session
   * appends and persistence appends stay in wire order.
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
      state = { created: undefined, pending: Promise.resolve(), titled: false }
      this.sessions.set(remoteSessionId, state)
    }
    state.pending = state.pending
      .then(() => this.#emit(state, link, remoteSessionId, event))
      .catch((error) => {
        state.skipped = true
        process.stderr.write(`[peer-mirror] replay failed ${event.type}: ${error instanceof Error ? error.message : String(error)}\n`)
        this.logger?.warn?.(`peer mirror: replay of ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /**
   * Append one event to the local session and its persistence handle.
   * @param {any} state - per-conversation state.
   * @param {string} link - peer name.
   * @param {string} remoteSessionId - remote wire session id.
   * @param {{ type: string, data: unknown }} event - remote event.
   * @returns {Promise<void>} settlement.
   */
  async #emit(state, link, remoteSessionId, event) {
    if (state.skipped === true) return
    state.created ??= this.#create(link, remoteSessionId)
    const created = await state.created
    if (created === undefined || created === null) { state.skipped = true; return }
    if (SURFACE_EVENTS.has(event.type)) {
      created.session.append(event.type, event.data, { surfaceOp: 'append' })
    } else {
      created.session.append(event.type, event.data)
    }
    if (event.type === 'user/message' && state.titled !== true) {
      state.titled = true
      const summary = promptSummary(event.data)
      if (summary.length > 0) await this.#rename(created.session, `Peer: ${link} · ${remoteSessionId.slice(-6)} · ${summary}`)
    }
    await this.#sync(created)
    if (event.type === 'turn/end') {
      if (created.handle !== undefined) await created.handle.flush().catch(error => {
        process.stderr.write(`[peer-mirror] flush failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
      await this.#touch(created.session.id)
    }
  }

  /**
   * Create the local session, its persistence handle, and the workspace entry.
   * @param {string} link - peer name, used in the title.
   * @param {string} remoteSessionId - remote wire session id.
   * @returns {Promise<{ session: any, handle?: any } | undefined>} created resources.
   */
  async #create(link, remoteSessionId) {
    const store = this.ctx.get('sessions')
    if (store === undefined) return undefined
    const id = `${this.prefix}-${remoteSessionId}`.slice(0, 120)
    try {
      const session = store.create(id, { meta: { cwd: this.workspacePath } })
      let handle
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence !== undefined) {
        try {
          handle = await persistence.create(session.header)
        } catch (error) {
          handle = undefined
          process.stderr.write(`[peer-mirror] persistence unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
      const created = { session, handle, cursor: 0 }
      await this.#rename(session, `Peer: ${link} · ${remoteSessionId.slice(-6)}`)
      await this.#sync(created)
      process.stderr.write(`[peer-mirror] created ${id} cwd=${this.workspacePath}${handle === undefined ? ' (memory only)' : ''}\n`)
      void this.#attach(id)
      return created
    } catch (error) {
      process.stderr.write(`[peer-mirror] create failed ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
      this.logger?.warn?.(`peer mirror: cannot create ${id}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Persist every session event the handle has not written yet. A rename or any
   * other local append can interleave events, so the handle follows a cursor
   * instead of assuming each mirrored event is the next sequence number.
   * @param {{ session: any, handle?: any, cursor: number }} created - mirrored resources.
   * @returns {Promise<void>} settlement once the handle catches up.
   */
  async #sync(created) {
    if (created.handle === undefined) return
    for (;;) {
      const event = created.session.eventAt(created.cursor)
      if (event === undefined) return
      await created.handle.append([event])
      created.cursor += 1
    }
  }

  /**
   * Rename a mirrored session, ignoring a missing title service.
   * @param {any} session - mirrored session.
   * @param {string} title - display title.
   * @returns {Promise<void>} settlement.
   */
  async #rename(session, title) {
    try {
      await this.ctx.get('sessionTitle')?.rename?.(session, title)
    } catch (error) {
      process.stderr.write(`[peer-mirror] rename failed: ${error instanceof Error ? error.message : String(error)}\n`)
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

/**
 * Short, single-line summary of the first user prompt.
 * @param {{ content?: unknown }} data - user message payload.
 * @returns {string} at most 24 characters.
 */
function promptSummary(data) {
  const content = Array.isArray(data?.content) ? data.content : []
  const text = content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return ''
  return text.length <= 24 ? text : `${text.slice(0, 24)}…`
}
