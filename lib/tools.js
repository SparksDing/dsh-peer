/**
 * Model-facing tools for the two roles.
 *
 * The hub exposes delegation and messaging tools; a link exposes only the
 * reply tool, because its agent is the one being asked. Every tool description
 * names the concrete remote peer so the model does not confuse a peer turn
 * with a local subagent turn.
 *
 * @module @local/dsh-peer/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from './hub.js'

/** Highest deadline one tool call may request. */
const MAX_TIMEOUT_MS = 3_600_000

/**
 * Render a plain text block list.
 * @param {string} text - model-facing text.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * Resolve the calling session's effective working directory, which is the
 * workspace path the GUI groups it under. The session header keeps the origin
 * cwd from creation time, so it is only a fallback.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} exec - tool execution context.
 * @returns {Promise<string | undefined>} the workspace path, when known.
 */
async function callerCwd(ctx, exec) {
  const agent = exec?.agent
  if (agent === undefined) return undefined
  try {
    const directory = await ctx.get('workingDirectory')?.ensure?.(agent)
    if (typeof directory === 'string' && directory.length > 0) return directory
  } catch {
    // A missing or unreadable directory falls back to the header origin.
  }
  return agent.session?.header?.cwd
}

/**
 * Ask the user where a send should go, enforced inside the tool rather than
 * left to the model's judgement. Returns undefined values when the host has no
 * user-questions service or the call is not tied to a live agent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} hub - running hub.
 * @param {string} peer - peer name.
 * @param {{ agent?: any, signal?: AbortSignal }} exec - tool execution context.
 * @returns {Promise<{ session?: string, workspace?: string }>} chosen values.
 */
async function pickRemoteTarget(ctx, hub, peer, exec) {
  const questions = ctx.get?.('userQuestions')
  if (questions === undefined || exec?.agent === undefined) return {}
  const target = await hub.targets(peer)
  const workspaces = [...new Set([
    target.cwd,
    ...(target.workspaces ?? []).map(entry => entry.path),
  ].filter(path => typeof path === 'string' && path.length > 0))]
  const sessions = Array.isArray(target.sessions) ? target.sessions : []
  const NEW_DIR = '新建目录（在下方输入绝对路径）'
  const NEW_SESSION = '新建会话（在下方输入名字）'
  const answer = await questions.ask({
    agent: exec.agent,
    signal: exec.signal,
    questions: [
      {
        id: 'workspace',
        header: '远端工作区',
        question: `在 ${peer} 的哪个目录执行？`,
        options: [...workspaces.slice(0, 8).map(path => ({ label: path })), { label: NEW_DIR }],
      },
      {
        id: 'session',
        header: '远端会话',
        question: '用哪个远端会话？',
        options: [...sessions.slice(0, 6).map(id => ({ label: id })), { label: NEW_SESSION }],
      },
    ],
  })
  const workspaceAnswer = answer.answers?.find(item => item.id === 'workspace')
  const sessionAnswer = answer.answers?.find(item => item.id === 'session')
  let workspace = workspaceAnswer?.selected?.[0]
  if (workspace === NEW_DIR) workspace = workspaceAnswer?.custom
  let session = sessionAnswer?.selected?.[0]
  if (session === NEW_SESSION) session = sessionAnswer?.custom
  if (typeof session === 'string' && session.startsWith(`peer-${peer}-`)) {
    session = session.slice(`peer-${peer}-`.length)
  }
  return {
    ...typeof workspace === 'string' && workspace.length > 0 ? { workspace } : {},
    ...typeof session === 'string' && session.length > 0 ? { session } : {},
  }
}

/**
 * Register the hub's peer tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context with a tool registry.
 * @param {import('./hub.js').PeerHub} hub - the running hub.
 * @returns {void}
 */
export function registerHubTools(ctx, hub) {
  ctx.tools.register(defineTool({
    name: 'peer_list',
    description:
      'List the DeepSeek Harness peers currently linked to this instance. A peer is a separate DSH runtime on another machine that dialed in; '
      + 'use `peer_ask` to delegate a task to one and `peer_inbox` to read messages it sent you.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          links: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                arch: { type: 'string', required: true },
                hostname: { type: 'string', required: true },
                version: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                connectedAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock(value.links.length === 0
        ? 'No peer is linked right now.'
        : value.links.map(link => `- ${link.name} (${link.platform}/${link.arch}, host ${link.hostname || '?'}, dsh ${link.version}) cwd=${link.cwd || '?'} model=${link.model || '?'}`).join('\n')),
    },
    execute() {
      return Promise.resolve({
        links: hub.list().map(link => {
          const info = link.describe()
          return {
            name: info.name,
            platform: info.platform,
            arch: info.arch,
            hostname: info.hostname,
            version: info.version,
            cwd: info.cwd,
            provider: info.provider,
            model: info.model,
            connectedAt: info.connectedAt,
          }
        }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_targets',
    description:
      'Report where a peer currently works: its default directory and the remote sessions the hub has used with it. '
      + 'Call it before sending, then use ask_user_question to let the user pick the remote directory and session.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name from `peer_list`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          workspaces: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
          sessions: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => textBlock([
        `${value.peer} default dir: ${value.cwd}`,
        `workspaces: ${(value.workspaces ?? []).map(entry => entry.path).join(', ') || '(none)'}`,
        `sessions: ${(value.sessions ?? []).join(', ') || '(none)'}`,
      ].join('\n')),
    },
    execute(args) {
      return Promise.resolve(hub.targets(args.peer))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_ask',
    description:
      'Send a prompt to a linked DeepSeek Harness peer and wait for that peer\'s agent to finish its turn. '
      + 'The peer runs on its own machine with its own runtime, model route, tools, and filesystem; this call returns only its final assistant text. '
      + 'Reuse the same `session` name to continue a conversation; pass `fresh: true` to start a new one. '
      + 'Before sending, call `peer_targets` and `ask_user_question` so the user picks the remote directory and session; pass them as `remoteDir` and `session`.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Linked peer name from `peer_list`. A unique substring is accepted.' },
      prompt: { type: 'string', required: true, description: 'The task or message to send to the remote agent.' },
      session: { type: 'string', description: 'Conversation name on this peer; reuse it for follow-ups. Defaults to the peer\'s default conversation.' },
      fresh: { type: 'boolean', description: 'Start a new conversation instead of continuing the default one.' },
      remoteDir: { type: 'string', description: 'Absolute workspace directory on the peer; applied before the turn.' },
      timeoutMs: { type: 'integer', description: `Deadline in milliseconds (default ${String(DEFAULT_ASK_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          text: { type: 'string', required: true },
          status: { type: 'string', required: true },
          elapsedMs: { type: 'integer', required: true },
          timedOut: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(
        value.timedOut
          ? `[${value.peer}] still running after ${String(value.elapsedMs)}ms; partial text:\n${value.text || '(none yet)'}`
          : `[${value.peer}] ${value.text || '(no assistant text)'}`,
      ),
    },
    async execute(args, exec) {
      const picked = await pickRemoteTarget(ctx, hub, args.peer, exec)
      const result = await hub.ask({
        peer: args.peer,
        prompt: args.prompt,
        session: args.session ?? picked.session,
        fresh: args.fresh,
        remoteDir: args.remoteDir ?? picked.workspace,
        mirrorCwd: await callerCwd(ctx, exec),
        callerSessionId: exec.agent === undefined ? undefined : String(exec.agent.session.id),
        timeoutMs: clampTimeout(args.timeoutMs, DEFAULT_ASK_TIMEOUT_MS),
        signal: exec.signal,
      })
      return {
        peer: result.peer,
        sessionId: result.sessionId,
        text: result.text,
        status: result.status,
        elapsedMs: result.elapsedMs,
        timedOut: result.timedOut,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_send',
    description:
      'Send a prompt to a linked DeepSeek Harness peer without waiting for its turn to finish. '
      + 'Use it to start remote work in the background, then read the outcome with `peer_wait` or `peer_inbox`. '
      + 'Before sending, call `peer_targets` and `ask_user_question` so the user picks the remote directory and session.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Linked peer name from `peer_list`.' },
      prompt: { type: 'string', required: true, description: 'The task or message to send.' },
      session: { type: 'string', description: 'Conversation name on this peer; reuse it for follow-ups.' },
      fresh: { type: 'boolean', description: 'Start a new conversation instead of continuing the default one.' },
      remoteDir: { type: 'string', description: 'Absolute workspace directory on the peer; applied before the turn.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(`Queued on [${value.peer}] session ${value.sessionId} (message ${value.messageId}).`),
    },
    async execute(args, exec) {
      const picked = await pickRemoteTarget(ctx, hub, args.peer, exec)
      return hub.send({
        peer: args.peer,
        prompt: args.prompt,
        session: args.session ?? picked.session,
        fresh: args.fresh,
        remoteDir: args.remoteDir ?? picked.workspace,
        mirrorCwd: await callerCwd(ctx, exec),
        callerSessionId: exec.agent === undefined ? undefined : String(exec.agent.session.id),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_steer',
    description:
      'Inject a message into the remote peer\'s running turn. The message is queued in its inbox and consumed at the next step boundary, '
      + 'so the current turn continues and the model sees the correction without a new turn. When the peer is idle it degrades to a '
      + 'normal prompt. Use it to correct direction or add constraints mid-task; peers older than 0.3.0 also degrade to a prompt.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name from `peer_list`.' },
      text: { type: 'string', required: true, description: 'Message to inject.' },
      session: { type: 'string', description: 'Conversation name; defaults to the existing conversation.' },
      remoteDir: { type: 'string', description: 'Absolute workspace directory on the peer; applied before delivery.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(value.mode === 'steer'
        ? `Steered into ${value.peer}; delivered at its next step.`
        : `${value.peer} was idle or older than 0.3.0; queued as its next turn.`),
    },
    async execute(args) {
      const result = await hub.steer({ peer: args.peer, text: args.text, session: args.session, remoteDir: args.remoteDir })
      return { peer: result.peer, sessionId: result.sessionId, mode: result.mode, accepted: result.accepted }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_cancel',
    description:
      'Abort the remote peer\'s current turn. Running tools are not killed, but the agent stops at the next boundary and queued messages '
      + 'are kept. Returns cancelled=false when the peer is idle. Requires link version 0.3.0 or newer.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name from `peer_list`.' },
      session: { type: 'string', description: 'Conversation name; defaults to the existing conversation.' },
      reason: { type: 'string', description: 'Audit reason recorded in the peer log.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          cancelled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(value.cancelled
        ? `Cancelled the current turn on ${value.peer}.`
        : `${value.peer} had no active turn.`),
    },
    async execute(args) {
      const result = await hub.cancel({ peer: args.peer, session: args.session, reason: args.reason })
      return { peer: result.peer, sessionId: result.sessionId, cancelled: result.cancelled }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_pending',
    description:
      'List peer messages waiting for the user to choose a session, together with the local sessions that can receive them. '
      + 'Use it after a peer notice, before asking the user where the message belongs.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pending: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                peer: { type: 'string', required: true },
                remoteSessionId: { type: 'string', required: true },
                workspace: { type: 'string', required: true },
                text: { type: 'string', required: true },
                at: { type: 'number', required: true },
              },
            },
          },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                workspace: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock(value.pending.length === 0
        ? 'No peer messages are waiting for a session.'
        : `${value.pending.map(entry => `${entry.id} · ${entry.peer}/${entry.remoteSessionId} · ${entry.workspace} · ${entry.text.slice(0, 100)}`).join('\n')}\n${value.sessions.length} session(s) available.`),
    },
    execute() {
      return Promise.resolve(hub.pendingView())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_bind',
    description:
      'Deliver one pending peer message to a chosen local session, or create a new session for it. '
      + 'Call it after the user picks a session with ask_user_question.',
    parameters: {
      id: { type: 'string', required: true, description: 'Pending message id from peer_pending.' },
      sessionId: { type: 'string', description: 'Existing session id; omit when create is true.' },
      create: { type: 'boolean', description: 'Create a new session for this message instead.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock(value.ok
        ? `Bound to session ${value.sessionId}.`
        : `Bind failed: ${value.error}`),
    },
    async execute(args) {
      return hub.bind({ id: args.id, sessionId: args.sessionId, create: args.create === true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_wait',
    description:
      'Wait for a linked DeepSeek Harness peer to send an unsolicited message through its reply tool. '
      + 'Returns as soon as one arrives, or after the deadline with no messages. The remote agent sends such messages when it wants to reach you '
      + 'while it is not answering a `peer_ask`.',
    parameters: {
      peer: { type: 'string', description: 'Only wait for this linked peer. Defaults to any peer.' },
      timeoutMs: { type: 'integer', description: `Deadline in milliseconds (default ${String(DEFAULT_WAIT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                peer: { type: 'string', required: true },
                text: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
          },
          timedOut: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(value.messages.length === 0
        ? 'No peer message before the deadline.'
        : value.messages.map(message => `[${message.peer} @ ${message.at}] ${message.text}`).join('\n')),
    },
    async execute(args, exec) {
      return hub.wait({
        peer: args.peer,
        timeoutMs: clampTimeout(args.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS),
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_inbox',
    description: 'Read messages that linked DeepSeek Harness peers sent and that no earlier call consumed.',
    parameters: {
      peer: { type: 'string', description: 'Only read this linked peer\'s messages. Defaults to any peer.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                peer: { type: 'string', required: true },
                text: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock(value.messages.length === 0
        ? 'No unread peer messages.'
        : value.messages.map(message => `[${message.peer} @ ${message.at}] ${message.text}`).join('\n')),
    },
    execute(args) {
      return Promise.resolve(hub.readInbox({ peer: args.peer }))
    },
  }))
}

/**
 * Register the link's reply tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context with a tool registry.
 * @param {import('./link.js').PeerLink} link - the running link.
 * @returns {void}
 */
export function registerLinkTools(ctx, link) {
  ctx.tools.register(defineTool({
    name: 'peer_reply',
    description:
      'Send a message from this machine to the DeepSeek Harness hub you are linked to. '
      + 'Use it to report progress, ask the other side something, or answer without ending your turn. '
      + 'The hub agent is woken immediately, so it can react in a new turn.',
    parameters: {
      text: { type: 'string', required: true, description: 'Message body to deliver to the hub.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          delivered: { type: 'boolean', required: true },
          hub: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value.accepted
        ? (value.delivered
            ? `Delivered to hub "${value.hub}" and woke its agent.`
            : `Stored in hub "${value.hub}" inbox; no live agent was woken.`)
        : `Hub "${value.hub}" did not accept the message.`),
    },
    async execute(args, exec) {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const result = await link.reply(args.text, sessionId)
      return { accepted: result.accepted, delivered: result.delivered === true, hub: String(link.hubInfo?.name ?? 'hub') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_send',
    description:
      'Proactively send a message from this machine to the DeepSeek Harness hub, without waiting for a request. '
      + 'The hub agent is woken with a new turn and can reply through `peer_ask` or `peer_send`. '
      + 'Use it for unsolicited reports, alerts, or questions the other side should act on now.',
    parameters: {
      text: { type: 'string', required: true, description: 'Message body to deliver to the hub.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          delivered: { type: 'boolean', required: true },
          hub: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value.accepted
        ? (value.delivered
            ? `Delivered to hub "${value.hub}" and woke its agent.`
            : `Stored in hub "${value.hub}" inbox; no live agent was woken.`)
        : `Hub "${value.hub}" did not accept the message.`),
    },
    async execute(args, exec) {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const result = await link.reply(args.text, sessionId)
      return { accepted: result.accepted, delivered: result.delivered === true, hub: String(link.hubInfo?.name ?? 'hub') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_status',
    description: 'Report whether this machine is currently linked to its DeepSeek Harness hub.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          hub: { type: 'string', required: true },
          url: { type: 'string', required: true },
          since: { type: 'string', required: true },
          version: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value.connected
        ? `Linked to hub "${value.hub}" at ${value.url} since ${value.since} (peer ${value.version}).`
        : `Not linked (target ${value.url}).`),
    },
    execute() {
      const status = link.status()
      return Promise.resolve({
        connected: status.connected,
        hub: status.hub ?? '',
        url: status.url,
        since: status.since ?? '',
        version: status.version ?? '0.0.0',
      })
    },
  }))
}

/**
 * Clamp a requested deadline into the accepted range.
 * @param {number | undefined} value - model-supplied milliseconds.
 * @param {number} fallback - default when omitted.
 * @returns {number} the accepted deadline.
 */
function clampTimeout(value, fallback) {
  if (value === undefined) return fallback
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)))
}
