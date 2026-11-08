/**
 * dsh-peer: a bidirectional channel between two DeepSeek Harness runtimes.
 *
 * One side runs `role: hub` and listens; the other runs `role: link`, dials
 * the hub, and serves its harness to it. The link side works from behind NAT,
 * so only the hub needs a reachable address. The hub's agent delegates turns
 * with `peer_ask`/`peer_send` and reads unsolicited messages with
 * `peer_wait`/`peer_inbox`; the link's agent answers with `peer_reply`.
 *
 * @module @local/dsh-peer
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_PORT } from './protocol.js'
import { PeerHub } from './hub.js'
import { PeerLink } from './link.js'
import { PeerNode } from './node.js'
import { registerPeerTools } from './peer-tools.js'

export const name = 'peer'
export const inject = ['tools']

/** Deployment configuration accepted from the profile patch row. */
export const Config = Schema.object({
  /** Which end of the channel this runtime is. */
  role: Schema.union(['hub', 'link']).required(),
  /** Name this runtime publishes to the other side. */
  name: Schema.string().default('dsh-peer'),
  /** Shared secret; required for a link and for a non-loopback hub bind. */
  token: Schema.string().default(''),
  /** Hub bind address. */
  listen: Schema.object({
    host: Schema.string().default('127.0.0.1'),
    port: Schema.natural().default(DEFAULT_PORT),
  }),
  /** Link target. */
  connect: Schema.object({
    url: Schema.string(),
  }),
  /** Replay remote peer sessions into local read-only sessions for the GUI (default on). */
  mirror: Schema.boolean().default(true),
  /** Workspace path mirrored sessions attach to; defaults to the calling session's cwd. */
  mirrorWorkspace: Schema.string(),
  /** Maximum steer/cancel calls per peer per minute. */
  steerPerMinute: Schema.number().default(20),
  /** Loopback port for the pending/bind API used by the GUI picker. */
  apiPort: Schema.number().default(3096),
  /** 'auto' delivers unsolicited peer messages immediately; 'picker' waits for a choice. */
  bindMode: Schema.string().default('auto'),
  /** Optional WebSocket listener for hosts where only an HTTP port is reachable. */
  wsListen: Schema.object({
    host: Schema.string().default('127.0.0.1'),
    port: Schema.natural(),
    path: Schema.string(),
  }),
  /** TLS material: hub paths to a certificate chain and key, link paths to trust and client material. */
  tls: Schema.object({
    cert: Schema.string(),
    key: Schema.string(),
    ca: Schema.string(),
    rejectUnauthorized: Schema.boolean(),
  }),
  /** Working directory published by a link and used by the hub's `initialize` when it has no override. */
  cwd: Schema.string(),
  /** Provider route a link prefers and a hub overrides in `initialize`. */
  provider: Schema.string(),
  /** Model a link prefers and a hub overrides in `initialize`. */
  model: Schema.string(),
  /** Output-token cap a hub sends in `initialize`. */
  maxTokens: Schema.natural(),
  /** Version this runtime publishes to its peer. */
  version: Schema.string(),
  /** Agent preset peer sessions join; omitted uses the registry default. */
  agentPreset: Schema.string(),
})

/**
 * Boot the configured role and register its tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof Config>} config - validated configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.role === 'hub') {
    const hub = new PeerHub(ctx, {
      name: config.name,
      token: config.token ?? '',
      listen: {
        host: config.listen?.host ?? '127.0.0.1',
        port: config.listen?.port ?? DEFAULT_PORT,
      },
      tls: config.tls?.cert === undefined ? undefined : { cert: config.tls.cert, key: config.tls.key },
      mirror: config.mirror,
      mirrorWorkspace: config.mirrorWorkspace,
      steerPerMinute: config.steerPerMinute,
      apiListen: { host: '127.0.0.1', port: config.apiPort },
      bindMode: config.bindMode,
      wsListen: config.wsListen?.port === undefined
        ? undefined
        : { host: config.wsListen.host ?? '127.0.0.1', port: config.wsListen.port, path: config.wsListen.path },
      version: config.version,
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      maxTokens: config.maxTokens,
    })
    const node = new PeerNode({
      name: config.name,
      capabilities: {
        targets: peer => hub.targets(peer),
        ask: request => hub.ask(request),
        send: request => hub.send(request),
        list: () => (hub.list() ?? []).map(link => ({
          name: link.name,
          platform: link.info?.platform ?? '',
          version: link.info?.version ?? '',
          status: link.status ?? '',
          cwd: link.info?.cwd ?? '',
          model: link.info?.model ?? '',
          since: link.info?.since ?? '',
        })),
        steer: request => hub.steer(request),
        cancel: request => hub.cancel(request),
        pending: () => {
          const view = hub.pendingView()
          return {
            pending: (view.pending ?? []).map(entry => ({
              id: entry.id,
              peer: entry.peer,
              remoteSessionId: entry.remoteSessionId ?? '',
              workspace: entry.workspace ?? '',
              text: entry.text,
            })),
            sessions: (view.sessions ?? []).map(entry => typeof entry === 'string' ? entry : String(entry?.id ?? '')),
          }
        },
        bind: request => hub.bind(request),
        wait: request => hub.wait(request),
        inbox: () => hub.inbox.map(entry => ({ peer: entry.peer, text: entry.text, read: Boolean(entry.read) })),
        status: () => ({ connected: true, name: config.name }),
        origin: sessionId => hub.originFor(sessionId),
      },
    })
    registerPeerTools(ctx, node)
    ctx.effect(() => {
      void hub.start().catch(error => {
        ctx.logger.error(`peer hub failed to start: ${error instanceof Error ? error.message : String(error)}`)
      })
      return () => { void hub.stop() }
    }, 'peer.hub')
    return
  }

  if (config.role === 'link') {
    const url = config.connect?.url
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('peer link requires connect.url, for example tcp://hub.example:3099')
    }
    if (config.token.length === 0) throw new Error('peer link requires the shared token')
    // The SDK server reads `ctx.agents` and `ctx.workingDirectory`, and Cordis
    // checks injection on the exact context a service is read from. A child
    // context declares them, so a hub-only deployment still boots without them.
    ctx.inject(['agents'], (linkCtx) => {
      const link = new PeerLink(linkCtx, {
        name: config.name,
        url,
        token: config.token,
        cwd: config.cwd ?? process.cwd(),
        provider: config.provider,
        model: config.model,
        tls: config.tls,
        version: config.version,
        agentPreset: config.agentPreset,
      })
      const node = new PeerNode({
        name: config.name,
        capabilities: {
          targets: async () => link.targets(),
          ask: request => link.reply(request.prompt, request.callerSessionId, request.remoteSessionId, true),
          send: async request => {
            const result = await link.reply(request.prompt, request.callerSessionId, request.remoteSessionId, false)
            return {
              peer: String(link.hubInfo?.name ?? 'hub'),
              sessionId: String(request.remoteSessionId ?? ''),
              messageId: String(result.at ?? ''),
            }
          },
          list: () => {
            const state = link.status?.() ?? {}
            if (state.connected !== true) return []
            return [{
              name: String(state.hub ?? 'hub'),
              platform: '',
              version: String(state.version ?? ''),
              status: 'connected',
              cwd: '',
              model: '',
              since: String(state.since ?? ''),
            }]
          },
          status: () => link.status?.() ?? { connected: false },
          origin: sessionId => {
            const hubSessionId = link.originFor?.(sessionId)
            return typeof hubSessionId === 'string' && hubSessionId.length > 0
              ? { peer: String(link.hubInfo?.name ?? 'hub'), sessionId: hubSessionId }
              : undefined
          },
          pending: () => ({
            pending: link.pendingView().map(entry => ({
              id: entry.id,
              peer: entry.peer,
              remoteSessionId: entry.targetSessionId ?? '',
              workspace: '',
              text: entry.text,
            })),
            sessions: [],
          }),
          bind: request => link.bindPending(request.id, request.sessionId),
          steer: request => link.steer(
            request.remoteSessionId ?? '',
            [{ type: 'text', text: request.text }],
          ),
          cancel: request => link.cancel(request.remoteSessionId ?? '', request.reason),
          wait: async request => {
            const messages = await link.wait(request?.timeoutMs ?? 60_000)
            return { messages: messages.map(entry => ({ peer: entry.peer, text: entry.text })), timedOut: messages.length === 0 }
          },
          inbox: () => link.inbox().map(entry => ({ peer: entry.peer, text: entry.text, read: Boolean(entry.read) })),
        },
      })
      registerPeerTools(linkCtx, node)
      const prompt = linkCtx.get?.('systemPrompt')
      prompt?.context?.({
        name: 'peer:result-routing',
        order: 900,
        interpolate: false,
        text: 'Peer result routing: after calling peer_send or peer_reply, send the message and END your turn. '
          + 'The hub pushes its final answer back to this session automatically as a `[hub] ...` message. '
          + 'Never poll files, URLs, or peer status to wait for that answer; polling only delays it.',
      })
      linkCtx.effect(() => {
        link.start()
        return () => link.stop()
      }, 'peer.link')
    })
    return
  }

  throw new Error(`peer: unknown role ${JSON.stringify(config.role)}`)
}
