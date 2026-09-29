# Muse 桌宠：素材与后台状态调查

调查日期：2026-09-29（Asia/Shanghai）。本文件不包含 Cookie、令牌、私人网关地址、聊天正文或账号标识。

## 结论与验证级别

- **已在登录页面确认**：头像是 `<video>`，当前资源为 `blob:` URL；实际 Blob 的 MIME 为 `video/mp4`，357,801 字节，480 × 480，约 5.041667 秒，静音循环播放。不是普通 PNG，也不是凭截图推断。
- **已从前端源代码确认**：动画由连接状态与 `activity_code` 共同决定，默认状态也会播放视频，不能用“是否在动”判断是否工作。
- **已在登录页面确认**：存在活动状态容器和 WebSocket 网关运行时，含状态查询、事件监听和请求发送能力。
- **已从前端源代码确认**：后端使用 Noise 加密的 WebSocket RPC，有 `agent.status`、`task.status` 事件以及聊天、活动、定时任务订阅定义。
- **尚未完成**：独立于 Chrome 的客户端鉴权、握手、订阅及持续同步测试。未取得可公开调用的稳定状态 API，不能宣称关掉 Chrome 后已经能同步。
- 未导出浏览器 Cookie，未申请新的访问令牌，未安装扩展，未改变 Muse 任务、账号或现有 SSH 中继。

## 1. 头像素材

登录页面选中节点包含：

```html
<video src="blob:https://muse.ai/[redacted]"
  autoplay playsinline loop
  data-hatch-avatar-layer="ready"
  data-hatch-avatar-slot="current"
  data-hatch-avatar-transition-duration-ms="500"
  data-hatch-media-owner="avatar-layer">
</video>
```

`blob:` 是当前页面的临时对象地址，不是可供独立桌宠长期访问的下载地址。

前端内置的回退素材如下；对前四个视频的 HTTP HEAD 检查均返回 200、`video/mp4`：

| 变体 | 内置地址 | HEAD Content-Length |
| --- | --- | ---: |
| 默认 / 连接 / 恢复 | https://muse.ai/avatars/hatch.mp4 | 77,099 |
| 工作 / 等待子智能体 | https://muse.ai/avatars/hatch_working.mp4 | 81,629 |
| 制作内容 | https://muse.ai/avatars/hatch_making_something.mp4 | 146,095 |
| 升级庆祝 | https://muse.ai/avatars/hatch_milestone_level_up.mp4 | 186,790 |
| 成就庆祝 | https://muse.ai/avatars/hatch_milestone_achievement.mp4 | 未检查 |
| 静态回退 | https://muse.ai/avatars/hatch.jpg | 未检查 |

重要区别：当前页面 Blob 的字节数不同于内置默认视频。前端还支持 `avatar.imageUrl`、`avatar.videoUrlsByVariant`、`avatar.milestoneVideoUrl`。**不能声称当前用户头像必然就是上述内置视频**；实际变体原始 URL 仍需从登录状态模型核实。

素材是否具有透明通道、适合无边框桌面展示，尚未验证。MP4 文件后缀和 DOM 的圆形裁切不等于视频本身透明。公开资源也不意味着可自由再分发；发布产品前需要另行确认素材授权或使用自有角色。

## 2. 官方前端的状态映射

`getBaseHatchAvatarVisualState(connection, activityCode, resume)` 的逻辑：

| 条件 | 头像视觉状态 |
| --- | --- |
| 已连接，`online` / 空值 / 默认分支 | `default` |
| 已连接，`responding` / `composing` / `working` / `waiting_for_subagents` / `compacting` | `working` |
| 已连接，`making_something` | `making_something` |
| 已连接，`waiting_for_user` / `needs_approval` / `out_of_credits` | `static` |
| `connecting` / `reconnecting` | `default` |
| `unavailable` 且原因 `no_vm` | `default` |
| 其他不可用状态 | `static` |

这只是官网的动画选择逻辑，不应原样当作桌宠的任务真实性判断。例如未知活动码、丢失状态、未连接时，桌宠应明确显示“未知 / 重新同步”，不能兜底成“空闲”。

## 3. 实时状态来源

页面可见的状态容器 `window.__hatch_store__` 提供 `getState`、`subscribe`。相关分区与字段：

```text
activity
  agentActivityCode
  agentActivityRootAgentId
  agentSubagentCount
  agentActivitiesByRootAgentId
  currentChatRootAgentId
  currentChatSessionId
  currentChatRouteKey
  liveTaskStatusesByTaskId
  taskStatusesByTaskId
  snapshotPendingApprovalsById
tasks
  schedules
  runs
avatar
  imageUrl
  videoUrlsByVariant
  milestoneVideoUrl
```

前端 `agent.status` 处理器使用的负载字段包括：

```text
activity_code, activity_text, activity_emoji, agent_id, count, cta
```

事件元数据有 `seq`，订阅重连代码使用 replay 参数。`task.status` 使用 `task_id`、`status`，并且另有 `approvals.snapshot` 事件。

**作用域问题**：页面状态包含当前聊天路由以及按根智能体分组的活动。当前聊天空闲不代表全部后台任务空闲；`tasks` 分区主要还包含定时任务安排。实现前必须验证各订阅的覆盖范围、初始快照与重放行为，不能仅盯一个全局变量。

## 4. 网关协议和鉴权

前端运行时 `window.__hatchEarlyGatewayRuntimeState.activeRuntime` 的快照包含：

```text
connectionAuthority, connectionState, isConnected,
hasEverConnected, hasPendingConnectionRecovery,
reconnectExhausted, lastFailureKind, terminalFailureKind,
sendRequest, onEvent, ensureLiveConnection, reconnect, disconnect
```

公开前端定义的关键路径：

1. `GET /api/session` 用于会话 / VM 分配信息；这不是“任务是否在工作”的接口。
2. `POST /api/hatch/token`，请求带 `vmAddress` 和可选 `vmName`，返回网关短期令牌及可能的 notary token。此调查只读了代码，未发起该请求。
3. 使用共享网关 `/v1/noise` 建立 WebSocket。连接构造含 `vm_id`、`auth_token`、`app_id`、`request_id` 以及可选 notary 信息，不能记录完整连接 URL。
4. Noise 握手算法标识为 `Noise_XX_25519_AESGCM_SHA256`。请求经过加密，内部有 HTTP 方法 / 路径以及流 ID；不能直接向 WebSocket 发送 JSON 代替协议。
5. 标准 / confidential VM 可能有不同的身份验证和信任流程。必须保留证书、服务端身份与 attestation 校验，不能为了连通而关闭这些验证。

代码中的相关 RPC 定义：

| RPC 方法 | 隧道内部 HTTP 路径 | 说明 |
| --- | --- | --- |
| `chat.subscribe` | POST `/chat/subscribe` | `noiseOnly`，subscription，30 秒请求超时 |
| `activity.subscribe` | POST `/activity/subscribe` | `noiseOnly`，subscription |
| `tasks.subscribe` | POST `/tasks/subscribe` | `noiseOnly`，subscription |
| `activity.list` | GET `/activity` | 活动列表；不保证等于实时全局忙闲 |
| `tasks.list` | GET `/tasks` | 任务安排 |
| `tasks.runs` | GET `/tasks/runs` | 运行记录 |
| `subagents.status` | GET `/subagents/status` | 子智能体状态 |
| `connection.ping` | POST `/api/ping` | `noiseOnly`，连接保活 |

这些是**前端路由表证据**，不是已在独立客户端验证成功的调用。隧道内部 HTTP 路径不代表在 `https://muse.ai` 上拼接该路径就能访问。

## 5. 推荐实现及待决策点

目标数据流：`Muse 云端 → 本机常驻连接层 → 本机状态模型 → 透明桌宠窗口`。

两条候选路线：

1. **独立协议客户端**：本地进程实现 Noise、鉴权和订阅。真正不依赖浏览器运行时，但需要完成协议与 VM 信任流程适配；当前只有可行性证据，尚未打通。
2. **桌宠内独立登录的网页运行时**：复用 Muse 自己的连接、加密和状态逻辑，使用受控运行时避免 Chrome 标签页被冻结 / 丢弃；这不是监听用户 Chrome 标签页，但仍依赖 Web 引擎。可作为首版候选，后台是否持续更新必须实测，不能只靠关闭节流配置就宣称可靠。

两条路线都需要本机登录授权与会话过期处理。优先使用独立登录，不导出现有 Chrome 的 Cookie，不把凭据写入源码或控制台，不上传第三方。

状态模型至少分离：

- 传输：连接中 / 在线 / 重连中 / 鉴权失效 / 离线。
- 同步可信度：未初始化 / 最新 / 断流后待补齐 / 过期未知。
- 工作：空闲 / 回复 / 工作 / 制作 / 等待子智能体 / 等待用户 / 待审批 / 用量耗尽 / 未知。
- 作用域：当前聊天、不同根智能体、后台任务；聚合规则要显式定义。

验收：Chrome 最小化、标签页被冻结 / 丢弃、Chrome 完全退出；任务由其他设备或定时器启动；网络断开重连；任务状态乱序 / 重放；多任务交错；登录过期；Mac 睡眠后唤醒。Mac 自身睡眠时不能保证本机持续收事件，恢复后必须先重建同步，不能继续展示旧状态作为实时结果。

## 6. 证据来源

所有源码链接均为调查时实际加载的公开前端 bundle；文件名随部署变化。

- 头像回退资源与状态映射：<https://muse.ai/_next/static/chunks/1jkhtttl3w27y.js>，`getBaseHatchAvatarVisualState`、`resolveLoopingHatchAvatarMedia`。
- 头像渲染与状态文字：<https://muse.ai/_next/static/chunks/45a70twgyv9zs.js>，`HatchAvatarMedia`、`useHatchStatusChromeState`。
- 事件处理与重放：<https://muse.ai/_next/static/chunks/1h_zcsjbwfo70.js>，`agent.status`、`task.status`、`chat.subscribe`。
- RPC 路由：<https://muse.ai/_next/static/chunks/0lh1ox4rbfrfu.js>。
- 令牌与网关地址构造：<https://muse.ai/_next/static/chunks/2fxwxd8abjofv.js>。
- Noise 密码学实现：<https://muse.ai/_next/static/chunks/3v3h8u5gphw1m.js>。
- 连接生命周期：<https://muse.ai/_next/static/chunks/11qbbeqlkqufw.js>。
- Muse2API 参考实现：<https://github.com/czg86389-hub/muse2api/blob/main/engine.py>。它使用 CDP 页面 / 热连接，不是已证明独立于 Web 引擎的状态客户端。

现有仓库是 SSH WebSocket 中继。其 `/health` 仅说明中继代理是否在线，不能说明 Muse 智能体是否正在工作。本调查没有修改现有中继实现、部署或凭据。
