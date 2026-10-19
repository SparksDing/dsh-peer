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
  }

  /**
   * Create or resume one peer session, joining the configured preset first.
   * @param {string} sessionId - wire session id.
   * @param {boolean} resume - restore persisted history instead of starting fresh.
   * @returns {Promise<{ handle: import('@deepseek-ai/dsh-agent').AgentHandle, failure: undefined }>} the session record.
   */
  async createSession(sessionId, resume) {
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
          meta: { cwd: this.cwd, ...presetId === undefined ? {} : { agentPreset: presetId } },
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
    return record
  }
}
