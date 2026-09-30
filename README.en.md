<p align="center">
  <img src="desktop-pet/assets/muse.png" width="112" height="112" alt="Muse desktop companion">
</p>

<h1 align="center">Muse Desktop Pet</h1>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <strong>Give Meta's Muse a place on your desktop.</strong><br>
  See what it is doing, start a conversation, and keep a little companion by your side.<br>
  <sub>An unofficial desktop companion for Muse by Meta.</sub>
</p>

<p align="center">
  <a href="https://github.com/bayuewind/Muse-desktop-pet/releases/tag/v0.1.1"><img src="https://img.shields.io/badge/release-v0.1.1%20preview-7C956B?style=flat-square" alt="Release v0.1.1 preview"></a>
  <a href="#download"><img src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square" alt="Windows x64"></a>
  <a href="#development"><img src="https://img.shields.io/badge/macOS-source%20build-555555?style=flat-square" alt="macOS source build"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/built%20with-Electron-47848F?style=flat-square" alt="Built with Electron"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7C956B?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/bayuewind/Muse-desktop-pet/releases/download/v0.1.1/Muse-Desktop-Pet-0.1.1-win-x64-setup.exe"><strong>Download for Windows</strong></a>
  · <a href="https://muse.ai/">Sign up / Log in to Muse</a>
  · <a href="#getting-started">Get started</a>
  · <a href="https://github.com/bayuewind/Muse-desktop-pet/issues">Report an issue</a>
</p>

---

**Muse Desktop Pet is an unofficial, MIT-licensed desktop companion for [Meta's Muse personal AI agent](https://ai.meta.com/muse/).** Muse provides the cloud-based agent capabilities; this project adds a lightweight desktop character, activity status, and a chat window. It is neither a separate AI model nor an offline version of Muse.

> [!IMPORTANT]
> This is an independent project, not published or maintained by Meta, and not an official Meta client. A working Muse account is required. The current Windows installer is an **unsigned preview build**. A macOS DMG is not available yet.

This page is available in English. The application UI, screenshots, and linked in-depth documentation are currently primarily in Simplified Chinese; relevant menu labels are included below to help you find them.

<p align="center">
  <a href="#preview">Preview</a> · <a href="#features">Features</a> · <a href="#download">Download</a> · <a href="#getting-started">Setup</a> · <a href="#privacy">Privacy</a> · <a href="#development">Development</a> · <a href="#faq">FAQ</a>
</p>

<a id="preview"></a>

## A little companion for your desktop

<table>
  <tr>
    <td align="center" width="27%"><strong>Activity at a glance</strong></td>
    <td align="center" width="73%"><strong>Click to keep talking</strong></td>
  </tr>
  <tr>
    <td align="center" valign="middle"><a href="docs/images/pet-status.png"><img src="docs/images/pet-status.png" width="220" alt="Floating Muse character with a connection indicator and activity status"></a></td>
    <td align="center" valign="middle"><a href="docs/images/chat-window.png"><img src="docs/images/chat-window.png" width="760" alt="Muse chat window beside the desktop character, with text, code, image, and audio support"></a></td>
  </tr>
</table>

Drag the small bar above the character to move it. Click the character to open or close chat, and use the dot at the lower right to manage accounts. The chat window can be moved independently, or follow the character as you drag it. Click either screenshot to view the original image.

<a id="features"></a>

## More than an animated avatar

| Feature | What you get |
| --- | --- |
| Desktop companion | A floating character, activity animations, unread-reply indicators, and matching application / tray icons. |
| Activity status | Visibility into currently observable chat activity, subagents, and recent task runs, with explicit disconnected, syncing, and unknown states. |
| Quick conversations | Send text to your main Muse conversation. A task is marked received only after server confirmation; uncertain delivery preserves the draft without automatically resending it. |
| Replies and attachments | Read text and code blocks, preview images, load audio, and save files on demand. Attachment code is never executed. |
| Automatic connection | Detects completed login in the dedicated browser, verifies the session, and closes that window once pairing succeeds. Everyday use then relies on the native connection. |
| Account management | Sign out locally or switch accounts without sharing your everyday Chrome / Edge profile. |
| Voice drafts · Experimental | Transcription is inserted into the composer for review before sending. Real microphone capture and end-to-end transcription still need hands-on validation. |

<a id="download"></a>

## Download

| Platform | Get it | Current status |
| --- | --- | --- |
| Windows x64 | **[Download the installer](https://github.com/bayuewind/Muse-desktop-pet/releases/download/v0.1.1/Muse-Desktop-Pet-0.1.1-win-x64-setup.exe)** | v0.1.1 · Unsigned preview · Runtime included |
| macOS | [Run from source](#development) | No DMG yet; packaging, signing, and notarization are not configured |
| Other platforms / architectures | — | No installers or completed validation yet |

[Release notes](https://github.com/bayuewind/Muse-desktop-pet/releases/tag/v0.1.1) · [SHA-256 checksum](https://github.com/bayuewind/Muse-desktop-pet/releases/download/v0.1.1/Muse-Desktop-Pet-0.1.1-win-x64-setup.exe.sha256) · [All releases](https://github.com/bayuewind/Muse-desktop-pet/releases)

> [!NOTE]
> Windows users only need the `.exe`; you do not need to install Node.js or run npm. The `Source code` archives on the Releases page are for developers, not application installers.

Unsigned builds may trigger an unknown-publisher warning on Windows. Confirm that the download comes from this repository and check its checksum; do not disable system protection to dismiss a warning. In-app automatic updates are not implemented: download a newer installer to upgrade.

<a id="getting-started"></a>

## Get started in three steps

### 1. Set up your Muse account

**Official Muse sign-up / login entry point: [muse.ai](https://muse.ai/)**

Visit the official site, follow its instructions to create an account or log in, and confirm that you can access Muse chat. Account availability, supported regions, eligibility, and subscription requirements are determined by the official service. This project does not provide accounts, invitation codes, or extra service credits.

New to Muse? Read [Meta's product introduction](https://ai.meta.com/muse/) or the [official announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/). If you want Meta's official app instead, use the [official Muse download page](https://ai.meta.com/muse/download/); its downloads are separate from this project's installer.

### 2. Install and launch the companion

Download and run the Windows installer, then choose an installation directory. The final page has two independent checkboxes:

- **Launch Muse Desktop Pet** (`启动 Muse 桌宠`)
- **Create a desktop shortcut** (`创建桌面快捷方式`)

Before upgrading, quit the running companion from its tray menu; you do not need to sign out first. A Start menu entry is also created. Uninstalling preserves local authorization by default; sign out inside the app first if you want to clear it.

### 3. Pair once, then connect natively

1. Click **Log in to Muse** (`登录 Muse`), or open **Dot → Account → Log in to Muse** (`小圆点 → 账号 → 登录 Muse…`).
2. Complete login and any verification yourself in the new **dedicated browser window**. Windows supports Chrome / Edge; macOS uses Google Chrome.
3. Once you enter Muse chat, the companion checks every 2 seconds. After identity and connection verification succeeds, it saves authorization, closes the dedicated window, and connects automatically. No extra “I have logged in” click is needed.

This session is separate from your everyday browser. Even if you are already logged in on the website, initial pairing requires login in the dedicated window. With valid local authorization saved, later launches restore the native connection directly.

> [!TIP]
> Automatic detection waits for up to 15 minutes. If it times out or verification fails, check the companion's status message or use **Account → Manually check and connect (fallback)** (`账号 → 手动检查并连接（备用）`). Only the implemented **standard VM** verification path is currently supported; CVM / SNP verification is not bypassed.

### Everyday controls

| Action | Windows | macOS |
| --- | --- | --- |
| Open / close chat | `Ctrl+Shift+M` | `⌘⇧M` |
| Send text | `Ctrl+Enter` | `⌘Enter` |
| Insert a line break | `Enter` | `Enter` |
| Close chat or the bubble menu | `Esc` | `Esc` |

The × button **hides** the companion. To exit completely, use **Quit companion** (`退出桌宠`) in the tray / menu bar. **Sign out of current account** (`登出当前账号`) is a different action that clears local authorization.

<a id="privacy"></a>

## Connection model and privacy

**Electron provides the desktop UI, Node handles the native connection, and Chrome / Edge is used for initial authorization.** After pairing, activity, chat, and attachments travel through the native encrypted connection to Muse, without a continuously open web page. See the [native connection documentation](desktop-pet/native/README.md) (Chinese) for details.

- **Isolated session:** does not read your everyday browser's cookies, history, or existing tabs. Only Muse authorization from the dedicated pairing session is imported.
- **OS-backed encryption:** credentials are encrypted with Electron `safeStorage`, using DPAPI on Windows and system-keychain protection on macOS. They are not stored in the repository.
- **Security boundaries preserved:** the login browser uses a private debugging pipe, not a TCP debugging port. The app does not spoof the User-Agent or disable TLS validation, sandboxing, or site isolation.
- **Content stays under your control:** chat and unsaved attachment previews are held in process memory. Files require a manual save, audio does not autoplay, and a voice transcript must be reviewed and submitted before becoming a task.
- **Local sign-out does not stop cloud tasks:** quitting or signing out locally does not stop Muse's cloud tasks, delete cloud conversations, or revoke every server-side session.

Local authorization is stored under `%APPDATA%\MuseDesktopPet` on Windows and `~/Library/Application Support/MuseDesktopPet` on macOS. **Never upload these directories, cookies, or tokens to an issue.** Muse's server-side data handling is governed by its official policies. This companion is not an entirely offline application.

<a id="server-bridge"></a>

## Experimental: server bridge and AI Passport

[`server/`](server/README.md) runs the pet's native Muse connection as a headless Docker service
and pushes the task state to the Muse avatar on a [FoloToy AI Passport](https://github.com/FoloToy/ai-passport)
(device firmware: branch `feature/muse-avatar` of [`bayuewind/folo-ai-passport-xiaozhi`](https://github.com/bayuewind/folo-ai-passport-xiaozhi/tree/feature/muse-avatar)).

- Reuses `desktop-pet/native` without a browser; the session is AES-256-GCM encrypted in `server/data/` with the key in `server/.env`, neither of which enters Git or the image.
- Log in once on the Mac with a fresh temporary browser profile (independent from the pet's own session), then `docker compose -f server/docker-compose.yml up -d`.
- Verified so far with local Docker and the browser simulator: when a scheduled Muse task starts or ends, the avatar switches to "working" / "idle" within about a second. Not yet verified on hardware or a cloud host.

<a id="development"></a>

## Development and validation

Running from source requires **Node.js ≥ 22.12.0**, npm, and the Muse account and initial-authorization browser described above.

~~~sh
git clone https://github.com/bayuewind/Muse-desktop-pet.git
cd Muse-desktop-pet/desktop-pet
npm ci
npm start
~~~

To explicitly open a login window on startup, use `npm start -- --login`. On Windows, the source checkout also includes [启动桌宠-Windows.cmd](desktop-pet/启动桌宠-Windows.cmd). Unlike the self-contained EXE installer, this script still requires Node.js.

<details>
<summary><strong>Run tests and build the Windows installer</strong></summary>

From the `desktop-pet` directory:

~~~sh
npm test                          # Unit tests
npm run smoke                     # Local UI, isolation, and runtime dependency checks
npm run smoke:browser             # Dedicated visible Chrome window check
npm run smoke:browser -- --edge    # Dedicated visible Edge window check
npm run dist:win                  # Build a Windows x64 installer
npm run verify:win                # Check contents, smoke-test the packaged app, and generate SHA-256
~~~

Browser tests open and automatically close an isolated test window without reading cookies or submitting a login. Package verification checks the UI, dependencies, icons, and Windows encryption round-trip; it does not install the app or clear existing authorization.

Build outputs are written to `desktop-pet/dist/`: `Muse-Desktop-Pet-<version>-win-x64-setup.exe` and its `.sha256` file. Build commands **do not publish to GitHub** automatically. The current configuration produces an unsigned preview build; subsequent builds include this project's MIT license file.

</details>

<details>
<summary><strong>Project structure and technical documentation</strong></summary>

| Location | Contents |
| --- | --- |
| [desktop-pet/](desktop-pet/) | Electron main process, companion, and chat UI |
| [desktop-pet/native/](desktop-pet/native/) | Native authorization, Noise transport, activity, messages, and attachments |
| [desktop-pet/test/](desktop-pet/test/) | Protocol, lifecycle, concurrency, and packaging tests |
| [desktop-pet/build/](desktop-pet/build/) | Windows installer finish-page configuration |
| [desktop-pet/assets/](desktop-pet/assets/) | Character icons and asset attribution |
| [docs/](docs/) | Screenshots, release notes, and research records |

Further reading (Chinese): [Complete usage guide](desktop-pet/README.md) · [Native verification boundaries](desktop-pet/native/README.md) · [v0.1.1 release notes](docs/releases/v0.1.1.md)

</details>

**Verified:** on September 29, 2026, 98 automated tests, the packaged-app smoke test, and Chrome / Edge visible-window checks passed on Windows. Automatic-login cancellation, concurrency, and failure paths were tested with simulations; an existing real account was not signed out solely for these tests.

**Still to validate:** real microphone transcription, continuous long-running use, real network outages, and sleep / wake recovery. The implementation depends on Muse's current private protocol and pairing-page structure, which may need adaptation after service updates.

<a id="faq"></a>

## Frequently asked questions

<details>
<summary><strong>Is this an official Meta desktop pet?</strong></summary>

No. Muse is a Meta product; this repository is an independent, unofficial desktop companion for it. It does not provide or replace the official account service. See “Set up your Muse account” above for the official product and account links.

</details>

<details>
<summary><strong>Why do I need Chrome / Edge if the app uses Electron?</strong></summary>

Electron renders the desktop companion. The current login integration uses an isolated session in a real browser because embedded login returned 4xx responses during testing. Once authorization succeeds, the dedicated browser closes. Everyday operation does not require Chrome / Edge to stay open and does not reuse your everyday browser account.

</details>

<details>
<summary><strong>Does “No running tasks currently observed” mean every task has finished?</strong></summary>

No. It describes only currently observable conversations, subagents, and recent task runs; it is not a guarantee covering every account session or unlimited history. Disconnection, stale data, or incomplete coverage produces an unknown / syncing state. The local app also pauses while your computer sleeps.

</details>

<details>
<summary><strong>Does voice input send everything I say directly as a task?</strong></summary>

No. Transcription first fills the composer so you can edit and confirm it. Recording starts only when you request it; it is neither continuous listening nor a real-time voice call. Real microphone capture and transcription still need hands-on validation.

</details>

<details>
<summary><strong>Is the legacy browser-observation mode still available?</strong></summary>

Use `npm start -- --browser` to explicitly select the legacy compatibility mode, which requires its dedicated browser to remain running. The default native mode does not silently fall back to browser observation on failure. See the [complete usage guide](desktop-pet/README.md) (Chinese) for limitations and troubleshooting.

</details>

## Feedback and contributions

Bug reports and suggestions are welcome through [Issues](https://github.com/bayuewind/Muse-desktop-pet/issues), as are pull requests improving the code or documentation.

Include your OS and architecture, app version, reproduction steps, expected versus actual behavior, and **redacted** screenshots or error messages where useful. Do not attach raw session directories, cookies, tokens, private conversations, or unreviewed full logs.

## Credits and license

- **[Muse by Meta](https://ai.meta.com/muse/):** the connected agent service and source of the character artwork. The official account entry point is [muse.ai](https://muse.ai/).
- **Electron, Puppeteer, and related dependencies:** power the desktop runtime and dedicated login window. Each dependency retains its own license.
- **Project source code is licensed under the [MIT License](LICENSE)**, Copyright © 2026 bayuewind.
- **Brands and assets:** the Muse name, character artwork, and third-party assets remain the property of their respective rights holders. This project's MIT license does not change their ownership or imply Meta's endorsement or authorization. See the [asset attribution](desktop-pet/assets/README.md).

<p align="center"><sub>Made for your desktop. Powered by your Muse.</sub></p>
