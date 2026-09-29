# 原生状态连接：已完成当前标准 VM 联调

常驻运行模块使用 Node、`node:crypto`、`ws` 和 protobuf 编解码。**状态运行时不加载 Puppeteer、不启动 Chrome、不读取 DOM / React，也不依赖页面定时器。** `pair.cjs`、`contract-check.cjs` 是一次性授权 / 请求格式诊断工具，才会打开专用 Chrome。桌宠外观由 Electron 渲染，与 Muse 状态连接分离。

## 已完成

- `noise-xx.cjs`：Noise XX / X25519 / AES-256-GCM / SHA-256。三轮握手、握手哈希、双向传输与 noise-c 独立测试向量逐字节一致；认证失败后作废密钥状态。
- `wire.cjs`：Muse Noise protobuf 请求 / 响应、流 ID、分片组装与字节上限。
- `subscription.cjs`：增量 UTF-8 / NDJSON 解析，状态和公开聊天事件使用独立回调；未订阅聊天回调的只读状态消费者继续丢弃聊天，工具内部事件不进入会话 UI。
- `gateway-client.cjs`：仅连接固定的官方 `hatch.metaaivm.com/v1/noise`；保留 TLS 校验。通用 `request()` 允许状态、聊天历史与附件只读查询、订阅与保活；独立的 `sendChat()` / `transcribePCM()` 由本机输入面板的用户操作调用。不提供取消任务、自动审批或删除入口。
- `activity-model.cjs`：按智能体分别记录状态；一个智能体的 `online` 不会把另一个正在工作的智能体清成空闲。连接断开、心跳过期或覆盖不完整时显示未知。
- `monitor.cjs`：浏览器无关 CLI、重连退避、保活、脱敏状态输出。
- `outgoing.cjs` / `audio.cjs`：文字投递去重、明确确认与未知结果处理、24k PCM 转换及语音最终转写解析。任务和音频不写入日志或本地文件。
- `replies.cjs` / `attachments.cjs`：主会话回复合并、事件去重、历史与实时竞态处理；从真实 presentation 提取附件，通过原生 `fs.stat` / `fs.read` 按需读取。只允许工作区路径与已登记附件，校验文件长度和媒体格式。UI 将全部正文与代码按文本处理，不执行；文件需手动保存，音频需手动播放。具体容量和格式限制见上级 README。

文字协议参考当前公开客户端 `14hyzlnci3o9o.js` 的 `chat.stream`（`message`、`capabilities` 与返回 `message_id`）；语音协议参考 `3qxdrzta9l34d.js` 的 `/api/voice/dictation?sample_rate_hz=24000`，使用独立 Noise 流、PCM16 LE、BodyChunk 和 `partial/final/error` 记录。已在用户授权下真实发送一次限定测试并收到文字、代码、PNG、WAV；尚未测试实际麦克风和语音转写。

`npm run native` 启动原生桌宠，使用用户已批准的本机加密会话。只读 stdin 的开发 CLI 保留为 `npm run native:stdin`；它不会自动发现凭据。原生连接失败不会回退启动浏览器。

## 当前验证与边界

1. 用户明确授权后，仅导入桌宠专用会话中 Muse 域名的登录 Cookie。已验证系统加密存储往返、0600 权限、无专用 Chrome 时的原生会话续期和令牌获取。未导出日常 Chrome、聊天数据或 CVM 恢复私钥。
2. `vault.cjs` 使用 Electron safeStorage（Mac 系统钥匙串保护密钥）加密；`auth.cjs` 只访问两个固定的官方 HTTPS 授权路径，禁止自动重定向，核对 VM ID。会话每 10 分钟续期，令牌仅在内存中按需获取。过期不能续期时提示重新授权。
3. 当前支持 standard VM 的 Message 2 标准绑定：外层 field 2，内层 field 1 公钥、field 2 本次客户端随机挑战。逐字节验证绑定并保持公钥记录；不将任意非空证明当成可忽略字段。CVM / SNP 仍不支持，不自动降级。
4. 标准 VM 的公钥会随云端服务重启轮换，不能把它误当成永久设备公钥。`peer-renewal.cjs` 只在原有用户授权、原有 standard 策略下重新获取官方 VM 分配和令牌；VM ID、名称、地址全部匹配，并且**另一条新连接**匹配候选公钥 / 新鲜挑战且应用 ping 成功，才更新加密记录。信任根仍是官方 TLS / 已授权账号的 VM 分配，没有切换到任意服务器；若改为 CVM、身份不同或任何验证失败则停止。
5. 三种真实订阅已成功。服务器可能先发 2xx 空消息体而长时间不发 ACK，客户端把这视为订阅受理，但不视为已有实时状态。另每 10 秒查询 `tasks.runs(limit=100)`、`tasks.list`、`subagents.list`。
6. 已在当前账号读取 2 个启用计划和最近 100 条记录；在专用 Chrome 关闭时观察到真实循环任务“运行中 → 未见运行任务”。未关闭用户日常 Chrome；原生实现没有连接它们。
7. 全量跨会话、无限历史和全天候稳定性仍不能宣称已证明。界面用“当前未见运行任务”而不是“全局一定空闲”；旧的运行记录被截断时保持待确认。`NativeActivityModel.authoritativeSnapshot()` 仍只用于测试，不被真实适配器冒充完整快照调用。
8. 存在本机加密会话时桌宠已默认选择原生源，显示“原生”；`--browser` 仅为手动兼容模式。

Mac 自身休眠时本机也会暂停，唤醒后重新同步。浏览器关闭与电脑睡眠不是同一件事。真实断网、睡眠恢复与长时间稳定性尚需额外验收。

## 已授权的配对方案

使用桌宠自己的专用登录会话，**不读取日常 Chrome 配置**。一次性授权后，会话凭据用系统钥匙串保护的密钥在本机加密保存，原生进程仅向官方 Muse 端点申请 / 更新短期网关令牌。浏览器只参与交互式登录，不参与日常状态获取或续期。凭据不进入仓库、日志、聊天或第三方服务器。

配对同时核对 VM 身份与现有信任策略。不会导出 CVM 恢复私钥，不会不经验证直接更新公钥；如果账户要求当前实现不支持的证明，停止并报告。

`--credentials-stdin` 仅是开发接线入口，要求调用者提供已验证的凭据与 peer policy。正常使用走桌宠的 OS 加密存储，不应手工填写 pin 或把真实 token 写进命令行、聊天、Git。

## SSH 分支调查

`relay-proxy.cjs` 和 `ssh.cjs` 用既有 SSH 配置及固定主机指纹进行了只读探测，真实登录已成功，无本地监听端口、无浏览器。现有内部 socket 对 `/subagents/status`、`/activity`、`/tasks/runs` 返回：

```json
{"status":403,"error":{"code":"forbidden","message":"route not allowed on sandbox API"}}
```

因此该分支停止在权限边界，没有 sudo / 提权、读取其他进程凭据、改变远端配置或尝试走特权 socket。SSH 中继的 online 不被用作任务忙闲信号。不会将这条不可用的路线接入桌宠。

## 证据和测试

```sh
npm test
npm run native
```

- Noise 参考向量：<https://github.com/rweather/noise-c/blob/master/tests/vector/noise-c-basic.txt>
- 官网协议定义和路由的调查链接见 `../../docs/muse-desktop-pet-research.md`。
- 测试样本里的密钥来自公开测试向量，不是用户密钥。
- 协议测试、当前账号线上联调和后台任务全量覆盖是不同的验证级别；本次未将最近 100 条记录说成无限历史保证。
