# dsh-peer

让两台机器上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）实例互相对话、互相派活。

A bidirectional peer channel between two DeepSeek Harness runtimes on different machines: one instance delegates turns to the other, and both can send messages across.

## 为什么需要它

dsh 自带的 SDK 协议只走 stdio（父进程 spawn 子进程），跨机器没有任何现成通道。这个插件补上了这一层：

- **复用 dsh 的 SDK JSON-RPC 协议**（`initialize` / `session/prompt` / `session.event` / `session.status`），不另造 agent API。
- **连接方向和服务方向相反**：内网机器（Windows）主动拨号出去，同时把本机 harness 服务给公网侧。
- **传输可插拔**：TCP / TLS / WebSocket。只有一个 HTTP 端口可达时，用 WebSocket + 反向代理即可。

```
        公网侧 (hub)                              内网侧 (link)
  ┌──────────────────────┐                  ┌──────────────────────┐
  │ peer_ask / peer_send │  JSON-RPC 请求   │  HarnessSdkJsonRpc   │
  │ peer_wait / peer_inbox│ ───────────────► │  Server              │
  │                      │                  │   ├─ agents.create   │
  │  PeerHub             │ ◄─────────────── │   ├─ preset.mount    │
  │  链接注册 · 会话状态   │  session.event   │   └─ followup()      │
  └──────────────────────┘                  └──────────────────────┘
            │                                          ▲
            └──────── TCP / TLS / WebSocket ───────────┘
                       （由 link 主动拨号）
```

## 快速开始

### 1. hub 侧（公网 / 可达的机器）

装进一个正在运行的 profile（hot-load，无需重启）：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: peer-hub
      name: ./dsh-peer/lib/index.js
      config:
        role: hub
        name: linux-vm
        token: <共享密钥>
        listen: { host: 0.0.0.0, port: 3099 }
```

或者用独立守护进程（不依赖 dsh 进程）：

```bash
node bin/peer-hub.mjs --port 3099 --token <共享密钥> --control /tmp/dsh-peer.sock
# 另一个终端
DSH_PEER_CONTROL=/tmp/dsh-peer.sock node bin/peer.mjs list
DSH_PEER_CONTROL=/tmp/dsh-peer.sock node bin/peer.mjs ask --peer windows --prompt "查一下磁盘"
```

### 2. link 侧（内网 / NAT 后的机器）

把本目录放到 `%USERPROFILE%\.dsh\profiles\sdk\dsh-peer`，然后：

```yaml
# %USERPROFILE%\.dsh\profiles\sdk\cordis.patch.yml
- insert:
    - id: peer-link
      name: ./dsh-peer/lib/index.js
      config:
        role: link
        name: windows-pc
        token: <共享密钥>
        connect: { url: ws://hub.example:3080/dsh-peer }
        cwd: 'C:\Users\you'
        provider: deepseek-official
        model: deepseek-v4-flash
```

```powershell
dsh --profile sdk     # 保持窗口打开
```

看到 `peer link "windows-pc" connected to hub "linux-vm"` 即成功。Windows 的一键安装见 [`install/`](install/)。

### 3. 只有 HTTP 端口可达时

```
link --ws--> nginx (/dsh-peer) --ws--> peer-ws-bridge --tcp--> hub:3099
```

```nginx
location = /dsh-peer {
    proxy_pass http://127.0.0.1:3098;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
}
```

```bash
node bin/peer-ws-bridge.mjs --listen 3098 --target 127.0.0.1:3099 --path /dsh-peer
```

### 4. 活动看板（可选）

桥可以顺带把对端的事件流做成一个只读看板：

```bash
node bin/peer-ws-bridge.mjs --listen 3098 --target 127.0.0.1:3099 --path /dsh-peer --ui-token <token>
```

浏览器打开 `http://<host>:3098/?token=<token>`。经过 nginx 时再加一条 `/peer-ui/` 转发：

```nginx
location /peer-ui/ {
    proxy_pass http://127.0.0.1:3098/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_buffering off;
}
```

看板按会话展示用户消息、reasoning、助手文本、工具调用与结果、回合边界，900ms 增量轮询，只读。只有**经过桥**的 WebSocket link 才会出现在看板里；直连 TCP 的 link 不会。

## 工具

hub 侧（模型可见）：

| 工具 | 作用 |
|---|---|
| `peer_list` | 列出已连接的 peer 及其平台、cwd、模型 |
| `peer_ask` | 给 peer 发任务并等待这一轮结束，返回最终文本 |
| `peer_send` | 发任务但不等 |
| `peer_wait` | 等 peer 主动发来的消息 |
| `peer_inbox` | 读取未读消息 |

link 侧：

| 工具 | 作用 |
|---|---|
| `peer_reply` | 主动发消息给 hub（任务中途汇报、反问） |
| `peer_status` | 当前连接状态 |

二进制产物（截图、二维码）走独立的带 token 上传口 `bin/peer-files.mjs`，不塞进 JSON-RPC。

## 协议要点

- 换行分隔 JSON-RPC 2.0，帧格式与 `@deepseek-ai/dsh-sdk-protocol` 一致。
- 握手：`peer/hello {protocol, name, role, token, identity…}`，协议版本与 token 不匹配即拒绝。
- harness 方法：`initialize`、`session/prompt`、`session/wait`、`session/working-directory/*`；自定义 `peer/ping`、`peer/info`、`peer/reply`、`peer/ensure-session`。
- 通知：`session.event`、`session.status`，按连接拥有的会话过滤，不泄露同机其他会话。
- 会话身份：`peer-<link>-<topic>`，重连后自动 resume，`fresh: true` 开新话题。
- 保活：应用层 ping + TCP keepalive；断线指数退避重连（1s→30s）。

## 安全

- token 常量时间比较；非 loopback 监听且无 token 时拒绝启动。
- link 主动出站，内网机器无需开放任何入站端口。
- **peer 会话默认没有审批人**，工具调用会 fail closed。需要远端执行命令时，要显式给权限模式（例如 Windows 上 `$env:DSH_PERMISSION_MODE='danger-full-access'`），这等于把该机器的完整文件权限交给持有 token 的一方。
- 建议把 hub 放在反向代理后面并只暴露一条专用路径，或直接用 SSH 隧道。

## 已知限制

- link 侧 agent 由事件驱动：只在被 prompt 时运行，不能凭空主动开一轮；但可以在跑任务过程中用 `peer_reply` 插话。
- 每条连接一个 link；同一台机器多个 runtime 请用不同 `name`。
- 协议只传文本；大文件请用上传口。

## 开发

```bash
node test/hub.test.mjs     # 协议 + hub 会话状态机（无需模型、无需 dsh）
node test/tools.test.mjs   # 工具 schema 与渲染
```

hub 侧纯 Node，无 dsh 依赖；link 侧作为 dsh 插件运行。

## 许可

MIT。`lib/transport.js` 改编自 `@deepseek-ai/dsh-sdk-protocol`（MIT, deepseek-harness），见 [NOTICE](NOTICE)。
