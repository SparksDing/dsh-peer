dsh-peer — Windows 安装（link 角色）
====================================

链路：Windows link --ws--> 8.153.157.183:3080 (nginx) --ws--> 桥 --tcp--> hub

前提
----
- Windows 已能运行 dsh（Node 22+），并且能访问 8.153.157.183:3080
- 不需要在 Windows 上开任何入站端口，也不需要 ngrok
  （ngrok 的 TCP 隧道是把“客户端所在机器”的服务暴露到公网，
    方向是 公网→Windows；而我们需要 Windows→Linux，所以走已经开放的 3080 更直接）

安装
----
1) 下载并解压：
   $d = "$env:USERPROFILE\.dsh\profiles\sdk"
   New-Item -ItemType Directory -Force $d | Out-Null
   Invoke-WebRequest http://8.153.157.183/dsh-peer.zip -OutFile "$env:TEMP\dsh-peer.zip"
   Expand-Archive -Force "$env:TEMP\dsh-peer.zip" $d

2) 写配置（把 TOKEN 换成 hub 的 token）：
   powershell -ExecutionPolicy Bypass -File "$d\dsh-peer\install\install-windows.ps1" -Token <TOKEN>

   或者手写 $d\cordis.patch.yml，模板见 windows-sdk.cordis.patch.yml。

3) 起 link，保持窗口打开：
   dsh --profile sdk

   看到下面这行就是连上了：
   peer link "..." connected to hub "linux-vm"

验证（在 Linux hub 侧）
----------------------
peer_list          -> 应出现你的 Windows 主机名
peer_ask           -> 给它派任务，返回最终回答
peer_inbox         -> 收它主动发来的消息

注意
----
- sdk profile 带完整的 PowerShell / 文件工具，peer 会话能真正干活。
- 关掉窗口 = 断开；重连后会话自动恢复（同一 session id）。
- token 是密钥，不要外传。想换 token 就在两边同时改。
- 如果 3080 也不通，用 SSH 隧道：
    ssh -N -L 3099:127.0.0.1:3099 root@8.153.157.183
  并把 url 改成 tcp://127.0.0.1:3099
