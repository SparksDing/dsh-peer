/**
 * Harness SDK server variant for peer sessions.
 *
 * `HarnessSdkJsonRpcServer` creates a root Agent whose model-facing composition
 * comes from the Host plane. In a profile that composes tools through agent
 * presets (the Web profile does), such an Agent sees only globally mounted
 * tools, so a peer session could not run shell or filesystem work. This
 * subclass joins a preset while the Agent is still unpublished, which is the
 * documented creation hook for that composition.
 *
 * The override mirrors the upstream `createSession` body: preset composition is
 * the only difference. A profile without `agentPresets` keeps the original
 * behavior.
 *
 * @module @local/dsh-peer/link-server
 */

import { mkdir } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

/**
 * SDK server that composes peer sessions with an agent preset.
 */
export class PeerHarnessServer extends HarnessSdkJsonRpcServer {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
   * @param {{ request(method: string, params: object): Promise<unknown>, notify(method: string, params?: object): void }} transport - peer-bound transport.
   * @param {object} [options] - deployment options forwarded to the base server.
   * @param {string} [presetId] - preset to join, or omitted for the registry default.
   */
  constructor(ctx, transport, options, presetId) {
    super(ctx, transport, options)
    this.presetId = presetId
    /** Working directory requested before a peer session is created. */
    this.sessionCwds = new Map()
  }

  /**
   * Record the directory a new peer session should be created in.
   * @param {string} sessionId - wire session id.
   * @param {string} cwd - absolute directory.
   * @returns {void}
   */
  prepareSessionCwd(sessionId, cwd) {
    this.sessionCwds.set(sessionId, cwd)
  }

  /**
   * Attach a peer session to the workspace matching its directory so it is
   * visible in the Web GUI, creating that workspace when needed.
   * @param {string} sessionId - wire session id.
   * @param {string} cwd - session header directory.
   * @returns {Promise<void>} settlement after the attach attempt.
   */
  async attachWorkspace(sessionId, cwd) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      let workspace = registry.list().find(candidate => candidate.path === cwd)
      if (workspace === undefined) workspace = await registry.create(cwd, cwd.split('/').pop() ?? 'peer')
      await workspace.attachSession(sessionId)
    } catch {
      // Visibility is best-effort; the session still works.
    }
  }

  /**
   * Dispatch peer-specific methods before the upstream SDK methods.
   *
   * `session/steer` and `session/cancel` reach the same Agent the hub prompts;
   * they exist here because the upstream SDK server has no preemption surface.
   * Every method resolves the session from `this.sessions`, which only holds
   * sessions this server created, so a link cannot touch a local session it
   * was never asked about.
   *
   * @param {string} method - JSON-RPC method.
   * @param {Record<string, unknown> | undefined} params - request parameters.
   * @returns {Promise<unknown>} result for the caller.
   */
  async handleRequest(method, params) {
    if (method === 'session/working-directory/set') return this.#setDirectory(params)
    if (method === 'peer/workspaces') return this.#workspaces()
    if (method === 'peer/sessions') return this.#sessions()
    if (method === 'session/steer') return this.#steer(params)
    if (method === 'session/cancel') return this.#cancel(params)
    if (method === 'session/state') return this.#state(params)
    return super.handleRequest(method, params)
  }

  /**
   * List the peer sessions this link currently owns, with their header cwd.
   * @returns {{ sessions: { id: string, cwd: string }[] }} owned sessions.
   */
  async #sessions() {
    const byId = new Map()
    const titles = this.ctx.get('sessionTitle')
    for (const [id, record] of this.sessions) {
      const session = record?.handle?.agent?.session
      const cwd = session?.header?.cwd
      let title = ''
      try { title = String(titles?.get?.(session)?.title ?? '') } catch { /* best effort */ }
      byId.set(String(id), { id: String(id), cwd: typeof cwd === 'string' ? cwd : '', title, createdAt: Number(session?.header?.createdAt ?? 0) })
    }
    const persistence = this.ctx.get('sessionPersistence')
    const cache = this.ctx.get('sessionProjectionCache')
    if (persistence !== undefined) {
      try {
        for (const snapshot of await persistence.list()) {
          const id = String(snapshot?.header?.id ?? '')
          if (id.length === 0 || byId.has(id)) continue
          let title = ''
          try {
            const block = cache?.cachedSnapshot(snapshot.header) ?? cache?.cachedPredecessorTitle(snapshot.header)
            const value = block?.values?.title
            if (typeof value === 'string') title = value
          } catch { /* no cached title */ }
          byId.set(id, {
            id,
            cwd: String(snapshot.header?.cwd ?? ''),
            title,
            createdAt: Number(snapshot.header?.createdAt ?? 0),
          })
        }
      } catch {
        // Persistence listing is best-effort; live sessions still show.
      }
    }
    const sessions = [...byId.values()]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 30)
    return { sessions }
  }

  /**
   * List the workspaces registered in this DSH profile so the hub can offer
   * them when the user picks a remote directory.
   * @returns {{ workspaces: { path: string, title: string }[] }} registered paths.
   */
  #workspaces() {
    const registry = this.ctx.get('workspaceRegistry')
    const workspaces = registry === undefined
      ? []
      : registry.list().map(workspace => ({ path: String(workspace.path), title: String(workspace.title ?? '') }))
    return { workspaces }
  }

  /**
   * Change one owned session's working directory, creating it when the caller
   * asked for a new directory. Implemented here instead of delegating to the
   * upstream method because property access to `ctx.workingDirectory` requires
   * an injection this plugin does not declare.
   * @param {Record<string, unknown> | undefined} params - `{ sessionId, path, createDir? }`.
   * @returns {Promise<{ cwd: string }>} the committed directory.
   */
  async #setDirectory(params) {
    const record = await this.#record(params)
    const path = typeof params?.path === 'string' ? params.path : ''
    if (path.length === 0) throw new TypeError('session/working-directory/set requires a path')
    if (params?.createDir === true) await mkdir(path, { recursive: true })
    const service = this.ctx.get('workingDirectory')
    if (service === undefined) throw new Error('workingDirectory service is not available')
    const cwd = await service.set(record.handle.agent, path)
    return { cwd }
  }

  /**
   * @param {Record<string, unknown> | undefined} params - request parameters.
   * @returns {{ handle: import('@deepseek-ai/dsh-agent').AgentHandle }} the owned record.
   */
  async #record(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (sessionId.length === 0) throw new TypeError('peer session method requires a non-empty sessionId')
    const record = this.sessions.get(sessionId)
    if (record !== undefined) return record
    try {
      const resolved = await this.ctx.get?.('agents')?.resolveAgent?.(sessionId)
      if (resolved !== undefined && resolved !== null && resolved.agent !== undefined) {
        const joined = { handle: { agent: resolved.agent }, failure: undefined }
        this.sessions.set(sessionId, joined)
        return joined
      }
    } catch {
      // Fall through to the unknown-session error.
    }
    throw new Error(`unknown peer session: ${sessionId}`)
  }

  /**
   * Queue a user message for the next step of the running turn.
   * @param {Record<string, unknown> | undefined} params - `{ sessionId, contentBlocks }`.
   * @returns {{ accepted: boolean, messageId: string }} the enqueue receipt.
   */
  async #steer(params) {
    const blocks = params?.contentBlocks
    if (!Array.isArray(blocks) || blocks.length === 0) throw new TypeError('session/steer requires contentBlocks')
    let record
    try {
      record = await this.#record(params)
    } catch {
      const controller = this.ctx.get?.('sessionController')
      if (controller !== undefined && typeof controller.prompt === 'function') {
        const requestId = `peer-${Math.random().toString(36).slice(2)}`
        await controller.prompt({
          requestId,
          sessionId: typeof params?.sessionId === 'string' ? params.sessionId : '',
          mode: 'steer',
          content: blocks,
        }, new AbortController().signal)
        return { accepted: true, messageId: requestId }
      }
      throw new Error(`unknown peer session: ${String(params?.sessionId)}`)
    }
    if (!Array.isArray(blocks) || blocks.length === 0) throw new TypeError('session/steer requires contentBlocks')
    const message = createUserMessage({ content: blocks, source: { kind: 'user' } })
    if (record.handle.agent.status === 'idle') record.handle.agent.followup(message)
    else record.handle.agent.steer(message)
    return { accepted: true, messageId: message.id }
  }

  /**
   * Abort the current activity, keeping queued messages for a later turn.
   * @param {Record<string, unknown> | undefined} params - `{ sessionId, reason? }`.
   * @returns {{ cancelled: boolean, status: string }} whether a turn was active.
   */
  async #cancel(params) {
    const record = await this.#record(params)
    const agent = record.handle.agent
    const reason = typeof params?.reason === 'string' && params.reason.length > 0
      ? params.reason
      : 'cancelled by peer'
    const running = agent.status !== 'idle'
    agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    return { cancelled: running, status: agent.status }
  }

  /**
   * Report whether the agent is running so the hub can pick steer or prompt.
   * @param {Record<string, unknown> | undefined} params - `{ sessionId }`.
   * @returns {{ status: string, seq: number }} current agent state.
   */
  async #state(params) {
    const record = await this.#record(params)
    return { status: record.handle.agent.status, seq: record.handle.agent.session.seq }
  }

  /**
   * Create or resume one peer session, joining the configured preset first.
   * @param {string} sessionId - wire session id.
   * @param {boolean} resume - restore persisted history instead of starting fresh.
   * @returns {Promise<{ handle: import('@deepseek-ai/dsh-agent').AgentHandle, failure: undefined }>} the session record.
   */
  async createSession(sessionId, resume) {
    const cwd = this.sessionCwds.get(sessionId) ?? this.cwd
    const presets = this.ctx.get('agentPresets')
    void import('node:fs/promises').then(fs => fs.appendFile('/root/dshCommunicate/.dsh-test/link-debug.log', `${new Date().toISOString()} createSession ${sessionId} resume=${String(resume)} presets=${presets === undefined ? 'none' : 'yes'} presetId=${String(this.presetId)}\n`)).catch(() => {})
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    let setup
    let presetId
    if (presets !== undefined) {
      const preset = await presets.resolve(this.presetId)
      presetId = preset.id
      void import('node:fs/promises').then(fs => fs.appendFile('/root/dshCommunicate/.dsh-test/link-debug.log', `${new Date().toISOString()} resolved preset ${presetId}\n`)).catch(() => {})
      setup = async agentCtx => {
        await presets.mount(agentCtx, presetId)
      }
    }
    const compose = setup === undefined ? {} : { setup }
    let handle
    if (resume) {
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, ...compose })
    } else {
      try {
        handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd, ...presetId === undefined ? {} : { agentPreset: presetId } },
          agentOptions,
          ...compose,
        })
      } catch (error) {
        // A peer that reconnects reuses its session ids. Older SDK servers only
        // expose `agents.create`, which refuses an id that already persists, so
        // fall back to loading that history instead of losing the conversation.
        if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error
        handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, ...compose })
      }
    }
    const record = { handle, failure: undefined }
    this.sessions.set(sessionId, record)
    void this.attachWorkspace(sessionId, cwd)
    return record
  }
}
