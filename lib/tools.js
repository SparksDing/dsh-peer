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
    name: 'peer_ask',
    description:
      'Send a prompt to a linked DeepSeek Harness peer and wait for that peer\'s agent to finish its turn. '
      + 'The peer runs on its own machine with its own runtime, model route, tools, and filesystem; this call returns only its final assistant text. '
      + 'Reuse the same `session` name to continue a conversation; pass `fresh: true` to start a new one. '
      + 'The peer works in the directory its own profile configured.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Linked peer name from `peer_list`. A unique substring is accepted.' },
      prompt: { type: 'string', required: true, description: 'The task or message to send to the remote agent.' },
      session: { type: 'string', description: 'Conversation name on this peer; reuse it for follow-ups. Defaults to the peer\'s default conversation.' },
      fresh: { type: 'boolean', description: 'Start a new conversation instead of continuing the default one.' },
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
      const result = await hub.ask({
        peer: args.peer,
        prompt: args.prompt,
        session: args.session,
        fresh: args.fresh,
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
      + 'Use it to start remote work in the background, then read the outcome with `peer_wait` or `peer_inbox`.',
    parameters: {
      peer: { type: 'string', required: true, description: 'Linked peer name from `peer_list`.' },
      prompt: { type: 'string', required: true, description: 'The task or message to send.' },
      session: { type: 'string', description: 'Conversation name on this peer; reuse it for follow-ups.' },
      fresh: { type: 'boolean', description: 'Start a new conversation instead of continuing the default one.' },
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
    async execute(args) {
      return hub.send({
        peer: args.peer,
        prompt: args.prompt,
        session: args.session,
        fresh: args.fresh,
      })
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
      + 'The hub\'s agent sees the message through its `peer_wait` or `peer_inbox` tool.',
    parameters: {
      text: { type: 'string', required: true, description: 'Message body to deliver to the hub.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          hub: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value.accepted ? `Delivered to hub "${value.hub}".` : `Hub "${value.hub}" did not accept the message.`),
    },
    async execute(args, exec) {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const result = await link.reply(args.text, sessionId)
      return { accepted: result.accepted, hub: String(link.hubInfo?.name ?? 'hub') }
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
        },
      },
      render: (_args, value) => textBlock(value.connected
        ? `Linked to hub "${value.hub}" at ${value.url} since ${value.since}.`
        : `Not linked (target ${value.url}).`),
    },
    execute() {
      const status = link.status()
      return Promise.resolve({
        connected: status.connected,
        hub: status.hub ?? '',
        url: status.url,
        since: status.since ?? '',
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
