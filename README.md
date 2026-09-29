# Muse 桌宠

把 Muse 放在桌面上：陪你工作的小人，随时打开的会话，以及看得见的任务状态。

基于 Electron 的桌面伴侣，支持 Windows / macOS。完成首次授权后，通过 Node 原生加密通道连接 Muse；日常查看状态、发送文字与接收回复不需要常驻浏览器。

**Windows 下载：** [v0.1.1 安装包（x64）](https://github.com/bayuewind/Muse-desktop-pet/releases/download/v0.1.1/Muse-Desktop-Pet-0.1.1-win-x64-setup.exe) · [发布说明与校验文件](https://github.com/bayuewind/Muse-desktop-pet/releases/tag/v0.1.1)

当前为未签名测试版，Windows 可能提示未知发布者；macOS DMG 暂未提供。

## 界面预览

### 桌面小人 · 随时查看状态

<p align="center">
  <img src="docs/images/pet-status.png" alt="Muse 桌宠悬浮窗口：小人、连接指示灯和当前任务状态" width="220">
</p>

拖动顶部短横线移动小人，点击小人展开或收起聊天，点击右下角圆点管理账号。

### Muse 会话 · 在桌面直接交流

![Muse 会话窗口与桌宠同屏，支持文字、代码、图片、音频及语音转文字](docs/images/chat-window.png)

会话窗口支持独立拖动；拖动小人时，已展开的会话窗口会跟随移动。

## 能做什么

- **查看任务状态**：汇总当前可观察到的会话、子任务与近期运行记录；断线或数据不足时明确显示未知，不把断线当成空闲。
- **文字下达任务**：向 Muse 主会话发送文字，只有收到服务器消息编号才提示已接收；结果不确定时保留草稿，不自动重发。
- **接收回复和附件**：显示文字、可复制的代码块；按需预览图片、加载音频、保存文件，不执行附件内容。
- **语音转文字**：点击后才请求麦克风，转写结果先回填输入框，由你检查并确认发送。
- **登录后自动连接**：每 2 秒检查专用登录窗口，发现登录完成后验证身份、保存授权并关闭窗口；手动检查入口保留为备用。
- **账号管理**：支持切换账号与本机登出，不影响日常浏览器登录，也不会停止云端任务。

## 快速开始

Windows 普通用户可从上方链接下载 EXE，退出正在运行的旧桌宠后安装，无需额外安装 Node.js。安装完成页可以独立勾选“启动 Muse 桌宠”和“创建桌面快捷方式”；程序、托盘与快捷方式使用同一小人头像。覆盖升级无需先登出账号。

以下是开发者的源码运行方式，需要：

- Node.js **22.12.0 或更高版本**，以及 npm。
- 一个可用的 Muse 账号；当前原生验证实现支持 standard VM，暂不支持 CVM / SNP。
- 首次授权使用独立浏览器窗口：Windows 支持 **Chrome 或 Edge**，macOS 使用 Google Chrome。已有有效本机授权后，日常运行不需要浏览器。

```sh
git clone https://github.com/bayuewind/Muse-desktop-pet.git
cd Muse-desktop-pet/desktop-pet
npm ci
npm start
```

Windows 也可以在下载代码后双击 [`desktop-pet/启动桌宠-Windows.cmd`](desktop-pet/启动桌宠-Windows.cmd)。首次运行会安装依赖，因此仍需先安装 Node.js。

### 构建 Windows 安装包

在 Windows x64 上，从 `desktop-pet` 目录执行：

```sh
npm ci
npm run dist:win
npm run verify:win
```

生成 `desktop-pet/dist/Muse-Desktop-Pet-0.1.1-win-x64-setup.exe` 与同名 `.sha256` 校验文件。EXE 自带 Electron / Node 运行环境，终端用户不需要另外安装 Node.js。安装向导支持选择目录、在完成页选择是否创建桌面快捷方式，并创建开始菜单入口。卸载默认保留本机授权；需要清除授权时应先在应用内登出。

当前配置明确生成**未签名测试包**，Windows 下载或安装时可能提示未知发布者。正式公开发布前应配置可信代码签名；不要通过关闭系统防护来解决提示。构建命令不会自动上传 GitHub，也不包含自动更新功能。首次 Muse 授权仍需 Chrome / Edge。

`verify:win` 检查安装包对应的 `app.asar` 文件清单，确认不含测试脚本、浏览器资料或本机凭据，并启动打包后的程序执行隔离冒烟测试（包括生产依赖加载、窗口交互和 Windows 加密往返）。它不会安装软件或改动你的现有登录。DMG 构建与 macOS 签名 / 公证尚未配置。

### 首次登录

1. 点击桌宠的「登录 Muse」，或「圆点 → 账号 → 登录 Muse…」。
2. 在新开的专用 Chrome / Edge 窗口中自行完成账号、密码和验证码操作。
3. 进入 Muse 聊天后，桌宠会自动验证账号与连接。成功后关闭专用窗口，切换到原生连接，无需再点击“我已登录”。

自动检测最多等待 15 分钟。检测超时或验证失败会显示提示，可在账号菜单选择「手动检查并连接（备用）」；不会跳过身份验证。普通启动不会自动弹出登录窗口，也可显式运行：

```sh
npm start -- --login
```

### 快捷键

| 操作 | Windows | macOS |
| --- | --- | --- |
| 展开 / 收起会话 | `Ctrl+Shift+M` | `⌘⇧M` |
| 发送文字 | `Ctrl+Enter` | `⌘Enter` |
| 换行 | `Enter` | `Enter` |
| 收起会话或气泡菜单 | `Esc` | `Esc` |

点击 × 是隐藏桌宠。彻底退出请使用托盘 / 菜单栏中的「退出桌宠」，而非「登出当前账号」。

## Windows 适配与本次修复

- 修复 Windows 下将 Unix `0600` 权限位误当成文件安全依据的问题；凭据仍由 Electron `safeStorage` / Windows DPAPI 加密保护。
- 支持发现系统级与当前用户安装的 Chrome / Edge。
- 修复专用浏览器隐藏启动的问题：Windows 显式创建可见子进程，再通过私有管道控制，仅管理自己的隔离登录窗口。
- 增加自动登录检测、取消与账号切换的竞态保护、超时提示，以及 Windows 快捷键提示与启动脚本。

窗口可用性不再只看 HTTP 200：浏览器冒烟测试同时检查页面内容与 Windows 可见主窗口句柄。

## 隐私与安全边界

- 不读取日常 Chrome / Edge 的 Cookie、历史记录或已有标签页；授权只来自桌宠本次创建的专用会话。
- Windows 凭据保存在 `%APPDATA%\MuseDesktopPet`，macOS 保存在 `~/Library/Application Support/MuseDesktopPet`，不进入仓库。
- 浏览器使用私有调试管道，不开放调试 TCP 端口；不伪造 User-Agent，不关闭 TLS 校验、浏览器沙箱或站点隔离。
- 登录完成后，由 Node 直接连接 Muse 网关；本地 Electron 页面保持沙箱与上下文隔离。
- 聊天与未保存附件仅在进程内缓存；附件必须手动保存，语音必须主动录制并确认后才发送任务。
- 本机登出不等于撤销全部服务端会话，也不会删除云端聊天或停止云端任务。

## 验证与已知限制

```sh
cd desktop-pet
npm test
npm run smoke
# 以下两项会打开并自动关闭无账号测试窗口，不提交登录
npm run smoke:browser
npm run smoke:browser -- --edge
```

2026-09-29 在 Windows 上通过 **98 项自动测试**与打包后 Electron 窗口冒烟测试；Chrome、Edge 专用可见窗口均已实测。自动登录检测的取消、并发和失败路径通过模拟测试，未为测试自动流程而登出已有账号。

请注意：

- 依赖当前 Muse 私有协议及配对页面结构，服务更新可能需要适配；这不是完整的 Muse 网页替代品。
- “当前未见运行任务”只描述当前可观察范围，不是全账号、无限历史的空闲保证。
- 电脑休眠时本地程序会暂停；全天候、真实断网与睡眠恢复仍需长时间验收。
- 实际麦克风录入与语音识别尚未完成实机验收；语音功能不是持续监听或实时通话。
- `npm start -- --browser` 是显式旧版兼容模式，需要专用浏览器持续运行；原生失败不会自动切换到它。

## 更多说明

- [完整使用说明与测试记录](desktop-pet/README.md)
- [原生连接、授权和验证边界](desktop-pet/native/README.md)

项目主体位于 [`desktop-pet/`](desktop-pet/)，展示截图位于 [`docs/images/`](docs/images/)。
