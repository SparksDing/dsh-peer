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
import { registerHubTools, registerLinkTools } from './tools.js'

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
      wsListen: config.wsListen?.port === undefined
        ? undefined
        : { host: config.wsListen.host ?? '127.0.0.1', port: config.wsListen.port, path: config.wsListen.path },
      version: config.version,
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      maxTokens: config.maxTokens,
    })
    registerHubTools(ctx, hub)
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
      registerLinkTools(linkCtx, link)
      linkCtx.effect(() => {
        link.start()
        return () => link.stop()
      }, 'peer.link')
    })
    return
  }

  throw new Error(`peer: unknown role ${JSON.stringify(config.role)}`)
}
