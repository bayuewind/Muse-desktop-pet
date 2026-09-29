# 原生状态连接：实验阶段

本目录只使用 Node、`node:crypto`、`ws` 和 protobuf 编解码。**不加载 Puppeteer，不启动 Chrome，不读取 DOM / React，也不依赖页面定时器。** 桌宠外观仍可由 Electron 渲染，但 Muse 状态连接与该网页运行时分离。

## 已完成

- `noise-xx.cjs`：Noise XX / X25519 / AES-256-GCM / SHA-256。三轮握手、握手哈希、双向传输与 noise-c 独立测试向量逐字节一致；认证失败后作废密钥状态。
- `wire.cjs`：Muse Noise protobuf 请求 / 响应、流 ID、分片组装与字节上限。
- `subscription.cjs`：增量 UTF-8 / NDJSON 解析，只传递状态事件，丢弃聊天和工具输出事件。
- `gateway-client.cjs`：仅连接固定的官方 `hatch.metaaivm.com/v1/noise`；保留 TLS 校验；仅允许状态查询、订阅与保活，不允许发消息、取消任务、审批或删除。
- `activity-model.cjs`：按智能体分别记录状态；一个智能体的 `online` 不会把另一个正在工作的智能体清成空闲。连接断开、心跳过期或覆盖不完整时显示未知。
- `monitor.cjs`：浏览器无关 CLI、重连退避、保活、脱敏状态输出。

运行 `npm run native` 会明确报告 `authorization_required`（退出码 2），不会偷偷读取现有登录凭据，也不会回退启动浏览器。

## 未完成，不能宣称已可用

1. 尚未得到用户对“将专用登录会话转存为原生凭据”的明确授权，因此没有导入会话、没有申请新的网关令牌、没有进行真实账号的原生 Noise 联调。
2. 尚未实现安全的本机凭据配对、加密存储和原生 HTTP 续期。短期 token 到期后不能靠重连恢复，必须进入需要授权状态。
3. 当前默认验证器仅接受**已可信配对的服务端公钥**、明确的 standard VM / attestation-off 策略和空的 Message 2 attestation 负载。不能手填 `off` 来降级账号现有安全策略；CVM / SNP / 非空 attestation 必须添加对应校验后才能支持。未添加关闭验证的开关。
4. `chat.subscribe`、`activity.subscribe`、`tasks.subscribe` 路由来自官网代码。真实响应、全账号后台任务覆盖、定时任务运行记录关联与断线事件重放尚未验证。
5. CLI 不会把“只收到一些 online 事件”解释成全局空闲。`authoritativeSnapshot()` 目前仅在测试中调用；需验证完整快照协议后才能接入真实数据。
6. 尚未把这个实验源设为桌宠默认来源。当前运行的桌宠仍然是已知的浏览器版，不会混淆二者。

只有在完成授权、真实订阅范围验证，以及关闭所有 Muse 网页后的任务开始 / 结束测试后，才算达到“浏览器休眠仍能判断循环任务状态”。Mac 自身休眠时本机也会暂停，唤醒后仍需重新同步。

## 授权方案（待用户同意）

使用桌宠自己的专用登录会话，**不读取日常 Chrome 配置**。一次性授权后，会话凭据用系统钥匙串保护的密钥在本机加密保存，原生进程仅向官方 Muse 端点申请 / 更新短期网关令牌。浏览器只参与交互式登录，不参与日常状态获取或续期。凭据不进入仓库、日志、聊天或第三方服务器。

配对同时核对 VM 身份与现有信任策略。不能未经确认导出 CVM 恢复私钥，不能自动信任陌生服务端公钥；如果账户要求当前实现不支持的证明，停止并报告。

`--credentials-stdin` 仅是开发接线入口，要求调用者提供已验证的凭据与 peer policy。不要把真实 token 写进命令行、聊天或 Git 文件。当前不要用手工填假 pin 的方式尝试真实连接。

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
- 没有浏览器依赖的协议测试成功，不等于已验证 Muse 线上协议、账号鉴权或后台任务完整覆盖。
