'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, powerMonitor, safeStorage, globalShortcut, systemPreferences, dialog, clipboard } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let observerFactory = null;
const observerFile = path.join(__dirname, 'observer.cjs');
let observerMtime = 0;
const { deriveState } = require('./state.cjs');

const smoke = process.argv.includes('--smoke-test');
app.setName('Muse 桌宠');
app.setPath('userData', path.join(app.getPath('appData'), smoke ? 'MuseDesktopPet-Smoke' : 'MuseDesktopPet'));
const nativeMode = !smoke && !process.argv.includes('--browser');
// No relaxed TLS, CSP or same-origin policy. Only scheduling/occlusion switches.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let petWindow, engine, tray, timer, quitting = false, polling = false, suspended = false;
let composerWindow, shortcutAvailable = false, microphoneAllowedUntil = 0, voiceLease = null;
let accounts, accountAction = false;
let petOrbit = null;
let resetNeeded = false, lifecycle = 0, sample = null, receivedAt = 0;
let currentState = deriveState({ sourceReady: false });
let nativeState = { kind: 'unknown', label: '原生连接中', detail: '不启动浏览器 · 正在恢复本机会话', variant: 'static', mode: 'native' };
let lastDiagnostic = '';
const petURL = pathToFileURL(path.join(__dirname, 'pet.html')).href;
const composerURL = pathToFileURL(path.join(__dirname, 'composer.html')).href;
const COMPOSER_SHORTCUT = 'CommandOrControl+Shift+M';

function isPet(event) {
  return petWindow && event.sender === petWindow.webContents && event.senderFrame?.url === petURL;
}
function isComposer(event) {
  return composerWindow && event.sender === composerWindow.webContents && event.senderFrame?.url === composerURL;
}
function composerState() { return { ...currentState, shortcutAvailable }; }
function cancelVoice() {
  microphoneAllowedUntil = 0; voiceLease = null; engine?.cancelDictation?.();
  if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:hidden');
}
function hideComposer() { cancelVoice(); composerWindow?.hide(); }
function setPetOrbit(expanded) {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const bounds = petWindow.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const layout = require('./pet-layout.cjs');
  if (expanded && !petOrbit) {
    const opened = layout.expand(bounds, area); petOrbit = { original:bounds, opened };
    petWindow.setBounds(opened);
  } else if (!expanded && petOrbit) {
    petWindow.setBounds(layout.collapse(bounds, petOrbit.original, petOrbit.opened, area)); petOrbit = null;
  }
  petWindow.webContents.send('pet:orbit', Boolean(petOrbit));
  return Boolean(petOrbit);
}
async function showComposer() {
  if (quitting) return;
  setPetOrbit(false);
  if (!composerWindow || composerWindow.isDestroyed()) await createComposer();
  if (composerWindow.isMinimized()) composerWindow.restore();
  const anchor = petWindow?.getBounds() ?? { x: 300, y: 300, width: 256, height: 306 };
  const area = screen.getDisplayMatching(anchor).workArea;
  const width = Math.min(580, area.width-16), height = Math.min(730, area.height-16);
  let x = anchor.x - width - 14;
  if (x < area.x) x = anchor.x + anchor.width + 14;
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(anchor.y, area.y + area.height - height - 8));
  composerWindow.setBounds({ x, y, width, height });
  composerWindow.show(); composerWindow.focus();
  composerWindow.webContents.send('pet:state', composerState());
  composerWindow.webContents.send('composer:replies', engine?.replies?.snapshot() ?? { messages: [], unread: 0 });
  composerWindow.webContents.focus();
  composerWindow.webContents.send('composer:focus');
}
async function createComposer() {
  composerWindow = new BrowserWindow({ width: 580, height: 730, minWidth: 440, minHeight: 540, title: 'Muse 会话', frame: false,
    backgroundColor: '#fcfcf6', resizable: true, show: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'composer-preload.cjs'), partition: 'muse-local-composer',
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  composerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  composerWindow.webContents.on('will-navigate', event => event.preventDefault());
  const localSession = composerWindow.webContents.session;
  const allowed = wc => wc === composerWindow?.webContents && wc.getURL() === composerURL &&
    composerWindow.isVisible() && Date.now() < microphoneAllowedUntil;
  localSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
    permission === 'media' && allowed(wc) && details?.mediaType !== 'video');
  localSession.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(permission === 'media' && allowed(wc) && Array.isArray(details.mediaTypes) &&
      details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio')));
  composerWindow.on('close', event => { cancelVoice(); if (!quitting) { event.preventDefault(); composerWindow.hide(); } });
  composerWindow.on('minimize', cancelVoice);
  composerWindow.webContents.on('render-process-gone', cancelVoice);
  await composerWindow.loadFile(path.join(__dirname, 'composer.html'));
}
function publish() {
  if (quitting) return;
  currentState = nativeMode ? nativeState : suspended
    ? deriveState({ suspended: true }, Date.now(), Date.now())
    : deriveState(sample, Date.now(), receivedAt);
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:state', currentState);
  if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('pet:state', composerState());
  if (tray && !tray.isDestroyed()) tray.setToolTip(`Muse 桌宠 · ${currentState.label}`);
}
function invalidate() {
  lifecycle++; sample = null; receivedAt = 0; resetNeeded = true; publish();
}
function showMuse() {
  if (quitting) return;
  if (nativeMode) {
    if (accounts?.phase === 'signed_out') void runAccountAction('login');
    else if (accounts?.phase === 'connected') void engine?.reload().catch(() => {});
    return;
  }
  void engine?.show().catch(() => { sample = { error: true }; receivedAt = Date.now(); publish(); });
}
function showPet() {
  if (quitting) return;
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.show(); petWindow.focus();
}
function accountItems() {
  const phase = accounts?.phase, ready = nativeMode && !accountAction;
  return [
    { label: '登录 Muse…', enabled: ready && phase === 'signed_out', click: () => void runAccountAction('login') },
    { label: '登录完成，连接此账号', enabled: ready && phase === 'awaiting_login', click: () => void runAccountAction('complete') },
    { label: '取消登录', enabled: ready && phase === 'awaiting_login', click: () => void runAccountAction('cancel') },
    { type: 'separator' },
    { label: '切换账号…', enabled: ready && phase === 'connected', click: () => void runAccountAction('switch') },
    { label: phase === 'cleanup_failed' ? '重试清除本机授权…' : '登出当前账号…', enabled: ready && ['connected','cleanup_failed'].includes(phase), click: () => void runAccountAction('logout') },
  ];
}
function updateMenus() {
  if (quitting) return;
  const common = [
    { label: '下达任务（文字 / 语音）', accelerator: COMPOSER_SHORTCUT, click: () => void showComposer() },
    { label: '账号', submenu: accountItems() },
    { label: '显示桌宠', click: showPet },
    { label: nativeMode ? '原生重连 / 登录' : '打开 Muse / 登录', enabled: !nativeMode || accounts?.phase === 'connected' || accounts?.phase === 'signed_out', click: showMuse },
    { label: '隐藏桌宠', click: () => petWindow?.hide() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(common));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Muse 桌宠', submenu: common }, { role: 'editMenu', label: '编辑' },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
}
async function runAccountAction(action) {
  if (!nativeMode || !accounts || quitting || accountAction) return;
  accountAction = true; updateMenus();
  try {
    if (['logout','switch','cancel'].includes(action)) {
      const result = await dialog.showMessageBox({ type: 'warning', title: action === 'switch' ? '切换 Muse 账号' : '退出本机 Muse 登录',
        message: action === 'switch' ? '登出当前账号并登录另一个账号？' : '清除这台桌宠的登录状态？',
        detail: '将停止本机连接和录音，清除本机授权、专用登录浏览器资料、会话缓存及未发送草稿。已保存的附件不删除；不会删除云端聊天、停止云端循环任务或登出日常 Chrome。此操作不是服务端会话撤销。',
        buttons: ['取消', action === 'switch' ? '登出并切换' : '确认退出'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1 || quitting) return;
      await accounts.logout();
    }
    if (['login','switch'].includes(action)) {
      const result = await dialog.showMessageBox({ type: 'info', title: '登录 Muse', message: '使用新的专用窗口登录 Muse',
        detail: '不会读取日常 Chrome 或复用旧账号。请在新窗口完成登录，再从桌宠菜单「账号 → 登录完成，连接此账号」确认。仅导入该窗口的 Muse 会话并加密保存在本机；验证成功后关闭登录窗口，日常运行仍不依赖浏览器。',
        buttons: ['取消', '打开专用登录窗口'], defaultId: 1, cancelId: 0 });
      if (result.response === 1 && !quitting) await accounts.login();
    }
    if (action === 'complete') await accounts.complete();
  } catch {
    if (!quitting) await dialog.showMessageBox({ type: 'error', title: '账号操作未完成', message: accounts.phase === 'cleanup_failed' ? '本机授权或专用登录资料未能完全清除。' : '尚未完成登录或原生身份验证。',
      detail: accounts.phase === 'cleanup_failed' ? '连接已停止；请从账号菜单重试清除，不会自动恢复连接。' : '请确认专用窗口已登录并进入 Muse 聊天，再点击「登录完成，连接此账号」。不支持的 VM 身份验证不会被跳过；也可取消后重试。' });
  } finally { accountAction = false; updateMenus(); }
}
async function poll() {
  if (nativeMode) return;
  publish();
  if (suspended || polling || !engine?.page || engine.page.isClosed()) return;
  if (engine.loading) return;
  const origin = engine.origin;
  if (engine.httpError) { sample = { error: true }; receivedAt = Date.now(); publish(); return; }
  if (origin !== 'https://muse.ai') {
    sample = { sourceReady: false }; receivedAt = Date.now(); publish(); return;
  }
  polling = true;
  const generation = lifecycle;
  const shouldReset = resetNeeded;
  let timeout;
  try {
    // Development adapter hot reload, restricted to this one local source file.
    // Updating state extraction need not close the logged-in browser again.
    const mtime = fs.statSync(observerFile).mtimeMs;
    if (mtime !== observerMtime) {
      delete require.cache[observerFile];
      observerFactory = require(observerFile).observerScript;
      observerMtime = mtime;
    }
    const result = await Promise.race([
      engine.evaluate(observerFactory(shouldReset)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('sample_timeout')), 6000); }),
    ]);
    if (generation !== lifecycle || suspended) return;
    // Only expected scalar fields are retained, never arbitrary page objects.
    sample = {
      sourceReady: result?.sourceReady === true, connected: result?.connected === true,
      pingOk: result?.pingOk === true, pingAt: result?.pingAt,
      hasEvent: result?.hasEvent === true, code: typeof result?.code === 'string' ? result.code.slice(0, 64) : null,
      hasSnapshot: result?.hasSnapshot === true,
      eventAt: result?.eventAt, subagents: result?.subagents,
    };
    receivedAt = Date.now(); resetNeeded = false;
    const diagnostic = JSON.stringify({ connected: sample.connected, pingOk: sample.pingOk,
      code: sample.code, source: typeof result?.evidence === 'string' ? result.evidence : null,
      rawEvents: result?.rawEvents, filteredEvents: result?.filteredEvents,
      diagnostic: result?.diagnostic });
    if (diagnostic !== lastDiagnostic) { lastDiagnostic = diagnostic; console.log(`PET_STATE ${diagnostic}`); }
  } catch {
    if (generation === lifecycle) { sample = { error: true }; receivedAt = Date.now(); resetNeeded = true; }
  } finally {
    clearTimeout(timeout); polling = false; publish();
  }
}

async function createWindows() {
  const { workArea } = screen.getPrimaryDisplay();
  petWindow = new BrowserWindow({
    width: 256, height: 306, x: workArea.x + workArea.width - 288, y: workArea.y + workArea.height - 344,
    title: 'Muse 桌宠', frame: false, transparent: true, resizable: false,
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, backgroundThrottling: false, webSecurity: true },
  });
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  petWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); petWindow.hide(); } });
  await petWindow.loadFile(path.join(__dirname, 'pet.html'));
  petWindow.showInactive();

  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle('◉');
  updateMenus();
  tray.on('double-click', showPet);
  if (!smoke) shortcutAvailable = globalShortcut.register(COMPOSER_SHORTCUT, () => {
    if (composerWindow?.isVisible() && composerWindow.isFocused()) hideComposer(); else void showComposer();
  });

  if (smoke) return runSmoke();
  if (nativeMode) {
    const { CredentialVault } = require('./native/vault.cjs');
    const { NativeSource } = require('./native/source.cjs');
    const { Accounts } = require('./native/accounts.cjs');
    const directory = app.getPath('userData'), vault = new CredentialVault(directory, safeStorage);
    accounts = new Accounts({ vault, makePairing: () => new (require('./native/account-pairing.cjs').AccountPairing)(directory),
      makeSource: () => {
        const source = new NativeSource(vault);
        source.on('state', state => { if (accounts.source === source) { nativeState = state; publish(); } });
        source.on('replies', replies => {
          if (quitting || accounts.source !== source) return;
          if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:unread', replies.unread);
          if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:replies', replies);
        });
        return source;
      },
      resetViews: () => {
        cancelVoice();
        if (composerWindow && !composerWindow.isDestroyed()) composerWindow.destroy();
        composerWindow = null;
        petWindow?.webContents.send('pet:unread', 0);
      },
      clearLegacy: async () => {
        const profile = path.join(directory, 'ChromeLogin');
        if (fs.existsSync(profile)) {
          if (!fs.lstatSync(profile).isDirectory() || fs.lstatSync(profile).isSymbolicLink()) throw new Error('unsafe_login_profile');
          await fs.promises.rm(profile, { recursive: true, force: true });
        }
      },
      changed: account => {
        engine = account.source;
        if (account.phase !== 'connected') {
          const labels = { signed_out: '尚未登录 Muse', clearing: '正在清除本机登录', cleanup_failed: '本机登出未完成',
            opening_login: '正在打开登录窗口', awaiting_login: '请完成 Muse 登录', verifying_login: '正在验证新账号' };
          nativeState = { kind: 'login', label: labels[account.phase] ?? '尚未登录 Muse', detail: account.phase === 'signed_out' ? '点「登录 Muse」或从账号菜单登录' : '菜单「账号」管理登录 · 云端任务不受影响',
            variant: 'static', mode: 'native', accountPhase: account.phase };
          publish();
        }
        updateMenus();
      },
    });
    await accounts.restore(); return;
  }
  const { ChromeEngine } = require('./chrome-engine.cjs');
  engine = new ChromeEngine(path.join(app.getPath('userData'), 'ChromeLogin'), invalidate);
  // A real installed Chrome, not a spoofed user-agent or a connection to existing tabs.
  void engine.start().then(() => poll()).catch(() => {
    sample = { error: true }; receivedAt = Date.now(); publish();
    console.error('MUSE_LOGIN_START_FAILED');
  });
  timer = setInterval(() => void poll(), 2000);
}

async function runSmoke() {
  try {
    const statuses = [
      { sourceReady: false },
      { sourceReady: true, connected: true, pingOk: true, pingAt: Date.now(), hasEvent: true, code: 'working' },
      { sourceReady: true, connected: false },
    ];
    for (const fixture of statuses) {
      sample = fixture; receivedAt = Date.now(); publish();
      await new Promise(resolve => setTimeout(resolve, 200));
      const label = await petWindow.webContents.executeJavaScript('document.querySelector("#status").textContent');
      if (label !== currentState.label) throw new Error('smoke_state_not_rendered');
    }
    // Report flags, not session data, and do not launch a remote login in smoke mode.
    const preferences = petWindow.webContents.getLastWebPreferences();
    if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration) throw new Error('unsafe_preferences');
    await petWindow.webContents.executeJavaScript('window.pet.setOrbit(true)');
    const orbitChecks = await petWindow.webContents.executeJavaScript(`({
      expanded:document.body.dataset.orbit==='true',
      four:document.querySelectorAll('#orbit .bubble').length===4,
      empty:document.querySelectorAll('#orbit .empty-bubble:disabled').length===3,
      account:!!document.querySelector('#orbit-account'),
    })`);
    if (!Object.values(orbitChecks).every(Boolean)) throw new Error('orbit_not_rendered');
    await petWindow.webContents.executeJavaScript('window.pet.setOrbit(false)');
    await createComposer();
    const composerChecks = await composerWindow.webContents.executeJavaScript(`(async () => {
      const draft=document.querySelector('#draft');
      const noInitialAudio=!document.querySelector('#recording').checkVisibility();
      const denied=await window.composer.microphone();
      const submission=await window.composer.send({id:crypto.randomUUID(),text:'local smoke fixture; never transmitted'});
      const context=new AudioContext();
      await context.audioWorklet.addModule('./pcm-worklet.js');
      await context.close();
      return {hasDraft:!!draft,noInitialAudio,micDenied:!denied.allowed,notSent:submission.status==='not_sent',workletLoaded:true};
    })()`);
    if (!Object.values(composerChecks).every(Boolean)) throw new Error('unsafe_composer');
    composerWindow.webContents.send('composer:replies', { unread: 1, messages: [{
      id: 'smoke-reply', role: 'assistant', state: 'done', text: '<img src=x onerror=alert(1)>\n```python\nprint(1)\n```',
      attachments: ['image','audio','code','file'].map((kind,index) => ({ id: String(index).padStart(24,'0'), kind, name: `fixture-${kind}`, size: 20 })),
    }] });
    await new Promise(resolve => setTimeout(resolve, 200));
    const repliesSafe = await composerWindow.webContents.executeJavaScript(`(() => {
      const feed=document.querySelector('#replies');
      return feed.querySelectorAll('.reply').length===1 && feed.querySelectorAll('.attachment').length===4 &&
        feed.querySelectorAll('.code-box').length===1 && !feed.querySelector('img,script,audio,iframe') &&
        feed.textContent.includes('<img src=x onerror=alert(1)>');
    })()`);
    if (!repliesSafe) throw new Error('unsafe_reply_rendering');
    console.log('SMOKE_PASS: pet + composer + reply/file cards + safe code rendering + audio worklet; no microphone opened; no message sent; sandbox/isolation enabled');
    app.quit();
  } catch { console.error('SMOKE_FAIL'); app.exit(1); }
}

ipcMain.handle('pet:get-state', event => isPet(event) ? currentState : null);
ipcMain.on('pet:open-muse', event => { if (isPet(event)) showMuse(); });
ipcMain.on('pet:hide', event => { if (isPet(event)) { setPetOrbit(false); petWindow.hide(); } });
ipcMain.on('pet:compose', event => { if (isPet(event)) void showComposer(); });
ipcMain.handle('pet:orbit', (event, expanded) => isPet(event) && typeof expanded === 'boolean' ? setPetOrbit(expanded) : false);
ipcMain.on('pet:account-menu', event => {
  if (isPet(event) && petWindow.isVisible() && petOrbit) Menu.buildFromTemplate(accountItems()).popup({ window: petWindow });
});
ipcMain.on('composer:account-menu', event => {
  if (isComposer(event) && composerWindow.isVisible()) Menu.buildFromTemplate(accountItems()).popup({ window: composerWindow });
});
ipcMain.handle('composer:state', event => isComposer(event) ? composerState() : null);
ipcMain.on('composer:hide', event => { if (isComposer(event)) hideComposer(); });
ipcMain.handle('composer:replies', event => isComposer(event) ? engine?.replies?.snapshot() ?? { messages: [], unread: 0 } : null);
ipcMain.handle('composer:refresh-replies', async event => isComposer(event) && nativeMode && !smoke && engine ? engine.refreshReplies() : { ok: false });
ipcMain.on('composer:read-replies', event => { if (isComposer(event) && composerWindow.isVisible() && composerWindow.isFocused()) engine?.replies?.read(); });
function validAssetRequest(event, request) {
  return isComposer(event) && composerWindow.isVisible() && nativeMode && !smoke &&
    typeof request?.messageId === 'string' && request.messageId.length <= 512 &&
    typeof request.assetId === 'string' && /^[a-f0-9]{24}$/.test(request.assetId);
}
ipcMain.handle('composer:attachment', async (event, request) => {
  if (!validAssetRequest(event, request)) return { ok: false, reason: 'unavailable' };
  try {
    const value = await engine.attachment(request.messageId, request.assetId);
    if (value.kind === 'image' && !value.mime.startsWith('image/')) return { ok: false, reason: 'invalid_media' };
    if (value.kind === 'audio' && !value.mime.startsWith('audio/')) return { ok: false, reason: 'invalid_media' };
    if (value.kind === 'code') {
      if (value.size > 512*1024) return { ok: false, reason: 'preview_size_limit' };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes);
      if (text.includes('\0')) return { ok: false, reason: 'not_text' };
      return { ok: true, kind: 'code', name: value.name, text, size: value.size };
    }
    if (value.kind === 'file') return { ok: false, reason: 'download_only' };
    return { ok: true, kind: value.kind, mime: value.mime, bytes: value.bytes, name: value.name, size: value.size };
  } catch { return { ok: false, reason: 'attachment_unavailable' }; }
});
ipcMain.handle('composer:save-attachment', async (event, request) => {
  if (!validAssetRequest(event, request) || !composerWindow.isFocused()) return { ok: false, reason: 'unavailable' };
  const source = engine;
  try {
    const value = await source.attachment(request.messageId, request.assetId);
    if (engine !== source || !validAssetRequest(event, request)) return { ok: false, reason: 'cancelled' };
    const result = await dialog.showSaveDialog(composerWindow, { title: '保存 Muse 附件（不会执行）',
      defaultPath: path.join(app.getPath('downloads'), path.basename(value.name)), buttonLabel: '保存' });
    if (result.canceled || !result.filePath || engine !== source || !validAssetRequest(event, request)) return { ok: false, reason: 'cancelled' };
    await fs.promises.writeFile(result.filePath, value.bytes, { flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.code === 'EEXIST' ? 'already_exists' : 'save_failed' }; }
});
ipcMain.handle('composer:copy-code', (event, request) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() || !Number.isInteger(request?.index) || request.index < 0 || request.index > 100) return { ok: false };
  const text = engine?.replies?.code(request.messageId, request.index);
  if (typeof text !== 'string' || text.length > 128*1024) return { ok: false };
  clipboard.writeText(text); return { ok: true };
});
ipcMain.handle('composer:send', async (event, draft) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() || !nativeMode || !engine?.submitTask || smoke) return { status: 'not_sent', reason: 'unavailable' };
  try { return await engine.submitTask(draft); } catch { return { status: 'uncertain', reason: 'delivery_unconfirmed' }; }
});
ipcMain.handle('composer:microphone', async event => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() || !nativeMode || smoke) return { allowed: false };
  try {
    const granted = process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted' ||
      await systemPreferences.askForMediaAccess('microphone');
    if (!granted || !composerWindow?.isVisible()) return { allowed: false };
    microphoneAllowedUntil = Date.now() + 30000;
    voiceLease = { id: randomUUID(), expiresAt: Date.now() + 120000 };
    return { allowed: true, id: voiceLease.id };
  } catch { return { allowed: false }; }
});
ipcMain.handle('composer:transcribe', async (event, audio) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !nativeMode || smoke || !voiceLease ||
      audio?.permissionId !== voiceLease.id || Date.now() > voiceLease.expiresAt) return { status: 'error', reason: 'voice_not_authorized' };
  voiceLease = null; microphoneAllowedUntil = 0;
  try { return await engine.transcribeAudio(audio); } catch { return { status: 'error', reason: 'dictation_failed' }; }
});

const gotLock = smoke || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.on('second-instance', () => { showPet(); void showComposer(); });
  app.whenReady().then(() => {
    powerMonitor.on('suspend', () => { suspended = true; cancelVoice(); if (nativeMode) void engine?.pause(); else invalidate(); });
    powerMonitor.on('resume', () => { suspended = false; if (nativeMode) void engine?.reload(); else { invalidate(); void poll(); } });
    return createWindows();
  }).catch(() => { console.error('START_FAILED: 请检查本机运行环境'); app.exit(1); });
  app.on('activate', () => { showPet(); if (composerWindow?.isVisible()) composerWindow.focus(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; clearInterval(timer); cancelVoice(); globalShortcut.unregisterAll(); tray?.destroy();
    if (accounts || engine) { event.preventDefault(); void (accounts ? accounts.stop() : engine.stop()).then(() => app.exit(0), () => app.exit(1)); }
  });
}
