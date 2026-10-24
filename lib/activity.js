/**
 * Peer activity feed for the WebSocket bridge.
 *
 * The bridge sees every JSON-RPC frame in both directions, so it can observe
 * the remote harness without changing the hub or the link. This module turns
 * those frames into a compact timeline (prompts, reasoning, assistant text,
 * tool calls and results, turn boundaries) and serves it as a small polling
 * dashboard next to the WebSocket upgrade path.
 *
 * @module @local/dsh-peer/activity
 */

/** Fields trimmed from one assistant message. */
function assistantParts(data) {
  const message = data?.message ?? {}
  const content = Array.isArray(message.content) ? message.content : []
  const text = []
  const reasoning = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text)
  }
  return { text: text.join(''), reasoning: reasoning.join('') }
}

/** Text of a user or tool message payload. */
function contentText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(`[tool-call ${String(block.name ?? '')}]`)
  }
  return parts.join('')
}

/** Truncate one display string. */
function clamp(value, limit = 4000) {
  if (typeof value !== 'string') return ''
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * Ring buffer of peer events plus per-session status.
 */
export class ActivityStore {
  /**
   * @param {{ perSessionLimit?: number, totalLimit?: number }} [options] - retention bounds.
   */
  constructor(options = {}) {
    this.perSessionLimit = options.perSessionLimit ?? 400
    this.totalLimit = options.totalLimit ?? 4000
    this.seq = 0
    /** @type {Map<string, { name: string, connectedAt: number, lastAt: number, sessions: Map<string, any> }>} */
    this.peers = new Map()
  }

  /** Note that a peer connection opened. @param {string} peer */
  connected(peer) {
    const now = Date.now()
    this.peers.set(peer, { name: peer, connectedAt: now, lastAt: now, sessions: new Map() })
  }

  /** Note that a peer connection closed. @param {string} peer */
  disconnected(peer) {
    const entry = this.peers.get(peer)
    if (entry !== undefined) entry.lastAt = Date.now()
  }

  /**
   * @param {string} peer - connection label.
   * @param {string} sessionId - wire session id.
   * @returns {{ id: string, status: string, lastAt: number, events: any[] }}
   */
  #session(peer, sessionId) {
    let entry = this.peers.get(peer)
    if (entry === undefined) {
      entry = { name: peer, connectedAt: Date.now(), lastAt: Date.now(), sessions: new Map() }
      this.peers.set(peer, entry)
    }
    entry.lastAt = Date.now()
    let session = entry.sessions.get(sessionId)
    if (session === undefined) {
      session = { id: sessionId, status: 'idle', lastAt: Date.now(), events: [] }
      entry.sessions.set(sessionId, session)
    }
    session.lastAt = Date.now()
    return session
  }

  /**
   * Record one wire notification.
   * @param {string} peer - connection label.
   * @param {string} method - notification method.
   * @param {Record<string, unknown>} params - payload.
   */
  record(peer, method, params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined
    if (sessionId === undefined) return
    const session = this.#session(peer, sessionId)
    if (method === 'session.status') {
      session.status = typeof params.status === 'string' ? params.status : session.status
      this.#push(session, { kind: 'status', title: session.status })
      return
    }
    if (method !== 'session.event') return
    const event = params.event
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message':
        this.#push(session, { kind: 'user', text: clamp(contentText(data)) })
        break
      case 'assistant/message': {
        const { text, reasoning } = assistantParts(data)
        if (reasoning.length > 0) this.#push(session, { kind: 'reasoning', text: clamp(reasoning) })
        if (text.length > 0) this.#push(session, { kind: 'assistant', text: clamp(text) })
        break
      }
      case 'tool/call':
        this.#push(session, {
          kind: 'tool',
          title: typeof data.name === 'string' ? data.name : 'tool',
          text: clamp(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}), 2000),
        })
        break
      case 'tool/result': {
        const message = data.message ?? {}
        this.#push(session, {
          kind: message.isError === true ? 'tool-error' : 'tool-result',
          title: message.isError === true ? 'tool failed' : 'tool result',
          text: clamp(contentText(message), 3000),
        })
        break
      }
      case 'turn/start':
        this.#push(session, { kind: 'turn', title: `turn ${String(data.turn ?? '?')} start` })
        break
      case 'turn/end': {
        const reason = data.reason ?? {}
        this.#push(session, { kind: 'turn', title: `turn ${String(data.turn ?? '?')} end (${String(reason.kind ?? '?')})` })
        break
      }
      case 'llm/retry':
        this.#push(session, { kind: 'notice', title: 'llm retry', text: clamp(JSON.stringify(data)) })
        break
      case 'approval/asked':
        this.#push(session, { kind: 'notice', title: 'approval asked', text: clamp(JSON.stringify(data)) })
        break
      default:
        break
    }
  }

  /**
   * Append one entry and enforce retention.
   * @param {{ events: any[] }} session - owning session.
   * @param {{ kind: string, title?: string, text?: string }} entry - event fields.
   */
  #push(session, entry) {
    this.seq += 1
    session.events.push({ seq: this.seq, at: Date.now(), ...entry })
    if (session.events.length > this.perSessionLimit) {
      session.events.splice(0, session.events.length - this.perSessionLimit)
    }
    let total = 0
    for (const peer of this.peers.values()) {
      for (const item of peer.sessions.values()) total += item.events.length
    }
    if (total > this.totalLimit) {
      // Drop the oldest events from the least recently active session.
      const oldest = [...this.peers.values()]
        .flatMap(peer => [...peer.sessions.values()])
        .sort((left, right) => left.lastAt - right.lastAt)[0]
      if (oldest !== undefined && oldest !== session && oldest.events.length > 0) oldest.events.shift()
    }
  }

  /**
   * Snapshot for the dashboard.
   * @param {number} [since] - only include events with a greater sequence number.
   * @returns {object} peers, sessions, and their recent events.
   */
  snapshot(since = 0) {
    return {
      now: Date.now(),
      seq: this.seq,
      peers: [...this.peers.values()].map(peer => ({
        name: peer.name,
        connectedAt: peer.connectedAt,
        lastAt: peer.lastAt,
        sessions: [...peer.sessions.values()].map(session => ({
          id: session.id,
          status: session.status,
          lastAt: session.lastAt,
          events: session.events.filter(event => event.seq > since),
        })),
      })),
    }
  }
}

/**
 * The dashboard document: one self-contained page, no external assets.
 * @param {string} token - required token echoed into fetch calls.
 * @returns {string} HTML.
 */
export function dashboardHtml(token) {
  const encoded = JSON.stringify(token).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-peer activity</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #c9d1d9; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; z-index: 2; display: flex; gap: 16px; align-items: center;
           padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .muted { color: #8b949e; }
  #peers { display: flex; gap: 8px; flex-wrap: wrap; }
  .peer { display: flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid #30363d;
          border-radius: 999px; background: #0d1117; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b949e; }
  .dot.running { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  main { padding: 12px 16px 40vh; }
  .session { margin-bottom: 22px; border: 1px solid #21262d; border-radius: 8px; overflow: hidden; }
  .session > .head { display: flex; gap: 10px; align-items: center; padding: 6px 10px;
                     background: #161b22; border-bottom: 1px solid #21262d; }
  .event { display: grid; grid-template-columns: 78px 92px 1fr; gap: 10px; padding: 6px 10px;
           border-top: 1px solid #161b22; }
  .event:first-child { border-top: 0; }
  .time { color: #6e7681; }
  .kind { font-weight: 600; }
  .kind.user { color: #58a6ff; }
  .kind.assistant { color: #e6edf3; }
  .kind.reasoning { color: #bc8cff; }
  .kind.tool { color: #d29922; }
  .kind.tool-result { color: #3fb950; }
  .kind.tool-error { color: #f85149; }
  .kind.turn { color: #8b949e; }
  .kind.status { color: #8b949e; }
  .kind.notice { color: #f0883e; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .body .title { color: #8b949e; margin-right: 8px; }
  .hidden { display: none; }
  #empty { color: #8b949e; padding: 24px 0; }
</style>
</head>
<body>
<header>
  <h1>dsh-peer activity</h1>
  <div id="peers"></div>
  <span class="muted" id="meta"></span>
  <label class="muted"><input type="checkbox" id="scroll" checked> 跟随</label>
</header>
<main><div id="empty">等待远端事件…</div><div id="sessions"></div></main>
<script>
const TOKEN = ${encoded};
let since = 0;
const seen = new Map();       // sessionId -> element
const expanded = new Set();   // session keys whose events are shown

function pad(n) { return String(n).padStart(2, '0'); }
function clock(ms) { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }

async function tick() {
  try {
    const response = await fetch('api/activity?since=' + since + '&token=' + encodeURIComponent(TOKEN), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    render(data);
    since = Math.max(since, data.seq);
  } catch (error) {
    document.getElementById('meta').textContent = '连接失败: ' + error.message;
  }
}

function render(data) {
  document.getElementById('meta').textContent = data.peers.length + ' peer · seq ' + data.seq;
  const peers = document.getElementById('peers');
  peers.replaceChildren(...data.peers.map(peer => {
    const wrap = document.createElement('span');
    wrap.className = 'peer';
    const dot = document.createElement('span');
    dot.className = 'dot ' + (peer.sessions.some(s => s.status === 'running') ? 'running' : '');
    const label = document.createElement('span');
    label.textContent = peer.name;
    wrap.append(dot, label);
    return wrap;
  }));
  const root = document.getElementById('sessions');
  let count = 0;
  for (const peer of data.peers) {
    for (const session of peer.sessions) {
      count += 1;
      const key = peer.name + '/' + session.id;
      let box = seen.get(key);
      if (!box) {
        box = document.createElement('section');
        box.className = 'session';
        box.innerHTML = '<div class="head"></div><div class="events"></div>';
        seen.set(key, box);
        root.append(box);
      }
      box.querySelector('.head').textContent = peer.name + ' · ' + session.id + ' · ' + session.status;
      const list = box.querySelector('.events');
      for (const event of session.events) list.append(renderEvent(event));
      box.dataset.last = session.lastAt;
    }
  }
  document.getElementById('empty').classList.toggle('hidden', count > 0);
  if (document.getElementById('scroll').checked) window.scrollTo({ top: document.body.scrollHeight });
}

function renderEvent(event) {
  const row = document.createElement('div');
  row.className = 'event';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = clock(event.at);
  const kind = document.createElement('span');
  kind.className = 'kind ' + event.kind;
  kind.textContent = event.kind;
  const body = document.createElement('span');
  body.className = 'body';
  if (event.title) {
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = event.title;
    body.append(title);
  }
  body.append(document.createTextNode(event.text || ''));
  row.append(time, kind, body);
  return row;
}

tick();
setInterval(tick, 900);
</script>
</body>
</html>`
}
