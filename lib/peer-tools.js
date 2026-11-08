/**
 * One tool surface for every peer node.
 *
 * A node is a node: it may listen, connect, or both. The tools below call the
 * node's capabilities, so the same names and behavior exist on every instance;
 * "initiator" and "target" are properties of one exchange, not of the node.
 *
 * @module @local/dsh-peer/peer-tools
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
 * Register the peer tool surface on one node.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context with a tool registry.
 * @param {import('./node.js').PeerNode} node - the running node.
 * @returns {void}
 */
export function registerPeerTools(ctx, node) {
  ctx.tools.register(defineTool({
    name: 'peer_list',
    description: 'List the peers this node can reach, with their version and status.',
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
                version: { type: 'string', required: true },
                status: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                model: { type: 'string', required: true },
                since: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock((value.links ?? []).length === 0
        ? 'No peers connected.'
        : value.links.map(link => `- ${link.name} (${link.platform}, ${link.status}) cwd=${link.cwd}`).join('\n')),
    },
    execute() {
      const links = (node.list() ?? []).map(link => ({
        name: String(link?.name ?? ''),
        platform: String(link?.platform ?? ''),
        version: String(link?.version ?? ''),
        status: String(link?.status ?? ''),
        cwd: String(link?.cwd ?? ''),
        model: String(link?.model ?? ''),
        since: String(link?.since ?? ''),
      }))
      return Promise.resolve({ links })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_status',
    description: 'Report this node\'s own transport status.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          details: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
    },
    execute() {
      const status = node.status() ?? { connected: false }
      return Promise.resolve({
        connected: status.connected === true,
        name: String(node.name ?? ''),
        details: JSON.stringify(status),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_targets',
    description:
      'List the peer\'s workspaces and sessions so you can choose where a message goes. '
      + 'Call it before sending, then let the user pick the workspace and session.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name from `peer_list`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
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
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                title: { type: 'string', required: true },
                createdAt: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock([
        `${value.peer} workspaces: ${(value.workspaces ?? []).map(entry => entry.path).join(', ') || '(none)'}`,
        `${value.peer} sessions: ${(value.sessions ?? []).map(entry => `${entry.title || entry.id} · ${entry.cwd}`).join(', ') || '(none)'}`,
      ].join('\n')),
    },
    async execute(args) {
      const target = await node.targets(args.peer)
      return { peer: args.peer, workspaces: target?.workspaces ?? [], sessions: target?.sessions ?? [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_ask',
    description:
      'Send a message to a peer and wait for its turn to finish, returning the final text. '
      + 'The target defaults to the session that last messaged this conversation.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name from `peer_list`.' },
      prompt: { type: 'string', required: true, description: 'Task or question for the peer.' },
      session: { type: 'string', description: 'Conversation name on the peer; reuse it for follow-ups.' },
      remoteSessionId: { type: 'string', description: 'Full peer session id, overriding the conversation name.' },
      remoteDir: { type: 'string', description: 'Absolute workspace directory on the peer.' },
      fresh: { type: 'boolean', description: 'Start a new conversation.' },
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
          elapsedMs: { type: 'number', required: true },
          timedOut: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(value.text.length > 0 ? value.text : `(no text; status ${value.status})`),
    },
    execute(args, exec) {
      return node.ask({
        peer: args.peer,
        prompt: args.prompt,
        session: args.session,
        remoteSessionId: args.remoteSessionId,
        remoteDir: args.remoteDir,
        fresh: args.fresh,
        timeoutMs: args.timeoutMs,
        callerSessionId: exec?.agent === undefined ? undefined : String(exec.agent.session.id),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_send',
    description:
      'Send a message to a peer without waiting. The peer pushes its turn result back to this session as a `[peer] ...` message; end the turn after sending.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name from `peer_list`.' },
      prompt: { type: 'string', required: true, description: 'Task or message for the peer.' },
      session: { type: 'string', description: 'Conversation name on the peer.' },
      remoteSessionId: { type: 'string', description: 'Full peer session id.' },
      remoteDir: { type: 'string', description: 'Absolute workspace directory on the peer.' },
      fresh: { type: 'boolean', description: 'Start a new conversation.' },
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
      render: (_args, value) => textBlock(`Sent to ${value.peer}/${value.sessionId} (${value.messageId})`),
    },
    execute(args, exec) {
      return node.send({
        peer: args.peer,
        prompt: args.prompt,
        session: args.session,
        remoteSessionId: args.remoteSessionId,
        remoteDir: args.remoteDir,
        fresh: args.fresh,
        callerSessionId: exec?.agent === undefined ? undefined : String(exec.agent.session.id),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_reply',
    description:
      'Reply to the session that last messaged this conversation, without creating a new one.',
    parameters: {
      text: { type: 'string', required: true, description: 'Reply body.' },
      peer: { type: 'string', description: 'Peer name; defaults to the origin peer.' },
      targetSessionId: { type: 'string', description: 'Remote session id; defaults to the origin session.' },
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
      render: (_args, value) => textBlock(`Replied to ${value.peer}/${value.sessionId} (${value.messageId})`),
    },
    async execute(args, exec) {
      const result = await node.reply(
        exec?.agent === undefined ? undefined : String(exec.agent.session.id),
        args.text,
        args.targetSessionId,
      )
      return { peer: String(result.peer ?? ''), sessionId: String(result.sessionId ?? ''), messageId: String(result.messageId ?? '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_steer',
    description: 'Inject a message into a running peer turn; if the peer is idle it starts one.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name.' },
      text: { type: 'string', required: true, description: 'Message to inject.' },
      session: { type: 'string', description: 'Conversation name on the peer.' },
      remoteSessionId: { type: 'string', description: 'Full peer session id.' },
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
      render: (_args, value) => textBlock(`Steered into ${value.peer}/${value.sessionId} (${value.mode}).`),
    },
    execute(args, exec) {
      return node.steer({
        peer: args.peer,
        text: args.text,
        session: args.session,
        remoteSessionId: args.remoteSessionId,
        callerSessionId: exec?.agent === undefined ? undefined : String(exec.agent.session.id),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_cancel',
    description: 'Abort a running peer turn, keeping its queued messages.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Peer name.' },
      session: { type: 'string', description: 'Conversation name on the peer.' },
      remoteSessionId: { type: 'string', description: 'Full peer session id.' },
      reason: { type: 'string', description: 'Reason recorded in the peer log.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          cancelled: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value.cancelled
        ? `Cancelled ${value.peer}/${value.sessionId} (status ${value.status}).`
        : `${value.peer}/${value.sessionId} was not running (status ${value.status}).`),
    },
    execute(args) {
      return node.cancel({ peer: args.peer, session: args.session, remoteSessionId: args.remoteSessionId, reason: args.reason })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_pending',
    description: 'List unbound messages this node has received, with their origin session and workspace.',
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
              },
            },
          },
          sessions: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => textBlock((value.pending ?? []).length === 0
        ? 'No pending messages.'
        : value.pending.map(entry => `${entry.id} · ${entry.peer}/${entry.remoteSessionId} · ${entry.workspace}\n${entry.text.slice(0, 100)}`).join('\n\n')),
    },
    execute() {
      return Promise.resolve(node.pending())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_bind',
    description: 'Deliver one pending message into a local session, or a new one.',
    parameters: {
      id: { type: 'string', required: true, description: 'Pending message id from `peer_pending`.' },
      sessionId: { type: 'string', description: 'Existing local session to receive the message.' },
      create: { type: 'boolean', description: 'Create a new local session for it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value.ok ? `Bound to ${value.sessionId}.` : `Bind failed: ${value.error}`),
    },
    execute(args) {
      return node.bind({ id: args.id, sessionId: args.sessionId, create: args.create })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_wait',
    description: 'Wait for the next unsolicited peer message.',
    parameters: {
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
              },
            },
          },
          timedOut: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock((value.messages ?? []).map(message => `[${message.peer}] ${message.text}`).join('\n') || 'No message before the deadline.'),
    },
    execute(args) {
      return node.wait({ timeoutMs: args.timeoutMs })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'peer_inbox',
    description: 'Drain messages this node received but no turn has consumed yet.',
    parameters: {},
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
                read: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock((value.messages ?? []).map(message => `[${message.peer}] ${message.text} (read=${String(message.read)})`).join('\n') || 'Empty.'),
    },
    execute() {
      return Promise.resolve({ messages: node.inbox() })
    },
  }))
}
