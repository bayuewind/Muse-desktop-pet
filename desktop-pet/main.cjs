'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, powerMonitor, safeStorage, globalShortcut, systemPreferences, dialog, clipboard, shell, Notification, desktopCapturer } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let observerFactory = null;
const observerFile = path.join(__dirname, 'observer.cjs');
let observerMtime = 0;
const { deriveState } = require('./state.cjs');
const { NotificationPolicy } = require('./notifications.cjs');
const { Preferences } = require('./preferences.cjs');
const { WorkspaceModel } = require('./native/workspace.cjs');
const { SpacesModel } = require('./native/spaces.cjs');
const { AttachmentSessions } = require('./input-attachments.cjs');
const attachmentSessions = new AttachmentSessions();
let inputAttachments = attachmentSessions.active, sessionSwitchBusy = false, inputSelecting = false;
let activeSubmission = null;
let captureOperation = null;
const notificationPolicy = new NotificationPolicy();
const activeNotifications = new Set();
let preferences;
const OFFICIAL_PAGES = Object.freeze({ chat: 'https://muse.ai/', goals: 'https://muse.ai/goals',
  ideas: 'https://muse.ai/ideas', library: 'https://muse.ai/library/artifacts' });

const smoke = process.argv.includes('--smoke-test');
app.setName('Muse 桌宠');
if (process.platform === 'win32') app.setAppUserModelId('com.bayuewind.muse-desktop-pet');
app.setPath('userData', path.join(app.getPath('appData'), smoke ? 'MuseDesktopPet-Smoke' : 'MuseDesktopPet'));
const nativeMode = !smoke && !process.argv.includes('--browser');
// No relaxed TLS, CSP or same-origin policy. Only scheduling/occlusion switches.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let petWindow, engine, tray, timer, quitting = false, polling = false, suspended = false;
let composerWindow, shortcutAvailable = false, microphoneAllowedUntil = 0, voiceLease = null;
let voicePermissionGeneration = 0;
let accounts, accountAction = false;
let petOrbit = null;
let windowFollower = null;
let composerCreating = null, composerOrigin = { x:100, y:30 };
let resetNeeded = false, lifecycle = 0, sample = null, receivedAt = 0;
let currentState = deriveState({ sourceReady: false });
let nativeState = { kind: 'unknown', label: '原生连接中', detail: '不启动浏览器 · 正在恢复本机会话', variant: 'static', mode: 'native' };
let lastDiagnostic = '';
const petURL = pathToFileURL(path.join(__dirname, 'pet.html')).href;
const composerURL = pathToFileURL(path.join(__dirname, 'composer.html')).href;
const appIconPath = path.join(__dirname, 'assets', 'muse.png');
const trayIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'muse.ico')
  : path.join(__dirname, 'assets', 'muse.ico');
const COMPOSER_SHORTCUT = 'CommandOrControl+Shift+M';

function isPet(event) {
  return petWindow && event.sender === petWindow.webContents && event.senderFrame?.url === petURL;
}
function isComposer(event) {
  return composerWindow && event.sender === composerWindow.webContents && event.senderFrame?.url === composerURL;
}
function composerState() { return { ...currentState, shortcutAvailable }; }
function workspaceSnapshot() { return engine?.workspace?.snapshot(engine.state) ?? new WorkspaceModel().snapshot(); }
function spacesSnapshot() { return engine?.spaces?.snapshot(engine.state) ?? new SpacesModel().snapshot(); }
function sessionSnapshot() {
  return engine?.sessionSnapshot?.() ?? { rows: [], activeId: null, title: '主会话', ready: smoke, phase: smoke ? 'ready' : 'disconnected', fresh: false };
}
function replySnapshot() { return engine?.replySnapshot?.() ?? { sessionId: null, messages: [], unread: 0 }; }
async function showWorkspace(view = 'chat') {
  if (!['chat', 'tasks', 'spaces', 'library', 'settings'].includes(view)) return;
  await showComposer();
  if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:view', view);
}
function clearNotifications() {
  for (const notification of activeNotifications) notification.close();
  activeNotifications.clear(); notificationPolicy.reset();
}
function notifyWorkspace(snapshot) {
  const events = notificationPolicy.consume(snapshot, { enabled: preferences?.snapshot().notifications ?? false,
    quietUntil: preferences?.snapshot().quietUntil ?? 0, focused: composerWindow?.isVisible() && composerWindow?.isFocused() });
  if (smoke || !Notification.isSupported()) return;
  for (const event of events) {
    if (activeNotifications.size >= 3) { const oldest = activeNotifications.values().next().value; oldest.close(); activeNotifications.delete(oldest); }
    const title = event.kind === 'attention' ? 'Muse 需要你处理' : event.kind === 'failed' ? 'Muse 任务未完成' : 'Muse 任务已完成';
    const notification = new Notification({ title, body: event.kind === 'attention'
      ? '有活动等待回应、批准或用量处理。' : `${event.count} 项任务有新结果。打开任务中心查看。`,
      icon: appIconPath, silent: true });
    notification.on('click', () => { void showWorkspace('tasks'); });
    notification.on('close', () => activeNotifications.delete(notification));
    activeNotifications.add(notification); notification.show();
  }
}
function revokeVoice() {
  voicePermissionGeneration++;
  microphoneAllowedUntil = 0; voiceLease = null; engine?.cancelDictation?.();
}
function cancelVoice() {
  revokeVoice();
  if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:hidden');
}
const { ComposerVisibility } = require('./composer-visibility.cjs');
const composerVisibility = new ComposerVisibility({
  ensure: async open => {
    if (!open) return composerWindow && !composerWindow.isDestroyed() ? composerWindow : null;
    if (!composerWindow || composerWindow.isDestroyed()) {
      if (!composerCreating) composerCreating = createComposer().finally(() => { composerCreating = null; });
      await composerCreating;
    } else if (composerCreating) await composerCreating;
    return composerWindow;
  },
  show: window => prepareComposer(window),
  animate: (window, transition) => window.webContents.send('composer:transition', { ...transition, origin: composerOrigin }),
  hide: window => window.hide(),
  focus: window => {
    window.focus(); window.webContents.focus(); window.webContents.send('composer:focus');
  },
  closing: cancelVoice,
});
function hideComposer() { void composerVisibility.set(false).catch(() => {}); }
function toggleComposer() {
  if (composerVisibility.open && !composerWindow?.isMinimized()) hideComposer();
  else void showComposer();
}
function setPetOrbit(expanded) {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const bounds = petWindow.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const layout = require('./pet-layout.cjs');
  if (expanded && !petOrbit) {
    const opened = layout.expand(bounds, area); petOrbit = { original:bounds, opened };
    if (windowFollower) windowFollower.moveSilently(() => petWindow.setBounds(opened));
    else petWindow.setBounds(opened);
  } else if (!expanded && petOrbit) {
    const closed = layout.collapse(bounds, petOrbit.original, petOrbit.opened, area);
    if (windowFollower) windowFollower.moveSilently(() => petWindow.setBounds(closed));
    else petWindow.setBounds(closed);
    petOrbit = null;
  }
  petWindow.webContents.send('pet:orbit', Boolean(petOrbit));
  return Boolean(petOrbit);
}
async function showComposer() {
  if (quitting) return;
  setPetOrbit(false);
  await composerVisibility.set(true);
}
function prepareComposer(window) {
  if (window.isMinimized()) window.restore();
  const anchor = petWindow?.getBounds() ?? { x: 300, y: 300, width: 256, height: 306 };
  const area = screen.getDisplayMatching(anchor).workArea;
  const width = Math.min(580, area.width-16), height = Math.min(730, area.height-16);
  let x = anchor.x - width - 14;
  if (x < area.x) x = anchor.x + anchor.width + 14;
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(anchor.y, area.y + area.height - height - 8));
  composerOrigin = { x: anchor.x + anchor.width/2 >= x + width/2 ? 100 : 0,
    y: Math.max(8, Math.min(92, (anchor.y + 100 - y) / height * 100)) };
  window.setBounds({ x, y, width, height });
  window.show(); window.focus();
  window.webContents.send('pet:state', composerState());
  window.webContents.send('composer:sessions', sessionSnapshot());
  window.webContents.send('composer:replies', replySnapshot());
  window.webContents.send('composer:workspace', workspaceSnapshot());
  window.webContents.send('composer:spaces', spacesSnapshot());
}
async function createComposer() {
  composerWindow = new BrowserWindow({ width: 580, height: 730, minWidth: 440, minHeight: 540, title: 'Muse 会话', frame: false,
    transparent: true, backgroundColor: '#00000000', resizable: true, show: false, alwaysOnTop: true, icon: appIconPath,
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
  composerWindow.on('close', event => { if (!quitting) { event.preventDefault(); hideComposer(); } });
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
    { label: '手动检查并连接（备用）', enabled: ready && phase === 'awaiting_login', click: () => void runAccountAction('complete') },
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
    { label: '任务中心', click: () => void showWorkspace('tasks') },
    { label: '近期成果', click: () => void showWorkspace('library') },
    { label: '桌面设置', click: () => void showWorkspace('settings') },
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
      // Opening an isolated, ephemeral login window is non-destructive; avoid
      // an extra native dialog that can be mistaken for the login surface.
      if (!quitting) await accounts.login();
    }
    if (action === 'complete') await accounts.complete();
  } catch {
    if (!quitting) await dialog.showMessageBox({ type: 'error', title: '账号操作未完成', message: accounts.phase === 'cleanup_failed' ? '本机授权或专用登录资料未能完全清除。' : '尚未完成登录或原生身份验证。',
      detail: accounts.phase === 'cleanup_failed' ? '连接已停止；请从账号菜单重试清除，不会自动恢复连接。' : '请确认专用窗口已登录并进入 Muse 聊天。正常情况下会自动连接；也可从账号菜单「手动检查并连接（备用）」重试。不支持的 VM 身份验证不会被跳过。' });
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
  if (nativeImage.createFromPath(appIconPath).isEmpty()) throw new Error('app_icon_missing');
  const { workArea } = screen.getPrimaryDisplay();
  petWindow = new BrowserWindow({
    width: 256, height: 306, x: workArea.x + workArea.width - 288, y: workArea.y + workArea.height - 344,
    title: 'Muse 桌宠', frame: false, transparent: true, resizable: false, icon: appIconPath,
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, backgroundThrottling: false, webSecurity: true },
  });
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const { WindowFollower } = require('./window-follower.cjs');
  windowFollower = new WindowFollower({ anchor: () => petWindow, follower: () => composerWindow,
    enabled: () => !quitting && composerVisibility.open });
  petWindow.on('move', () => windowFollower.moved());
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  petWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); petWindow.hide(); } });
  await petWindow.loadFile(path.join(__dirname, 'pet.html'));
  petWindow.showInactive();

  // Ship the real avatar instead of extracting an OS-cached generic EXE icon.
  // ICO is unpacked so Windows can select a native small/high-DPI resource.
  const icon = process.platform === 'win32' ? trayIconPath
    : nativeImage.createFromPath(appIconPath).resize({ width: 20, height: 20 });
  if (process.platform === 'win32' && nativeImage.createFromPath(trayIconPath).isEmpty()) throw new Error('tray_icon_missing');
  tray = new Tray(icon);
  updateMenus();
  tray.on('double-click', showPet);
  if (!smoke) shortcutAvailable = globalShortcut.register(COMPOSER_SHORTCUT, () => {
    toggleComposer();
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
          if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:unread', replies.totalUnread ?? replies.unread);
          if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:replies', replies);
        });
        source.on('workspace', snapshot => {
          if (quitting || accounts.source !== source) return;
          notifyWorkspace(snapshot);
          if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:workspace', snapshot);
        });
        source.on('spaces', snapshot => {
          if (quitting || accounts.source !== source) return;
          if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:spaces', snapshot);
        });
        source.on('sessions', snapshot => {
          if (quitting || accounts.source !== source) return;
          if (composerWindow && !composerWindow.isDestroyed()) composerWindow.webContents.send('composer:sessions', snapshot);
        });
        return source;
      },
      resetViews: () => {
        cancelVoice();
        clearNotifications();
        attachmentSessions.clear(); inputAttachments = attachmentSessions.active; activeSubmission = null;
        sessionSwitchBusy = false; inputSelecting = false;
        composerVisibility.reset();
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
          const detectionHints = { watching: '登录后将自动验证并连接 · 每 2 秒检测',
            timed_out: '自动检测已超时；可在账号菜单手动检查或取消后重试',
            window_closed: '登录窗口已关闭；请在账号菜单取消后重新登录',
            check_failed: '自动检测未完成；可在账号菜单手动检查或取消后重试',
            verification_failed: '身份或连接验证未通过；可在账号菜单手动重试，不会跳过验证' };
          const detail = account.phase === 'signed_out' ? '点「登录 Muse」或从账号菜单登录'
            : account.phase === 'awaiting_login' ? detectionHints[account.loginDetection] ?? '登录后将自动验证并连接'
            : account.phase === 'verifying_login' ? '已检测到登录 · 正在验证身份与连接'
            : '菜单「账号」管理登录 · 云端任务不受影响';
          nativeState = { kind: 'login', label: labels[account.phase] ?? '尚未登录 Muse', detail,
            variant: 'static', mode: 'native', accountPhase: account.phase };
          publish();
        }
        updateMenus();
      },
    });
    await accounts.restore();
    // Explicit one-shot convenience for a user-requested login. Normal startup
    // still never opens a login browser without an action from the user.
    if (process.argv.includes('--login') && accounts.phase === 'signed_out') await runAccountAction('login');
    return;
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
    // Also exercise production imports inside app.asar. Renderer-only smoke
    // would miss missing native-client modules and dynamic Puppeteer imports.
    const { Accounts } = require('./native/accounts.cjs');
    const { AccountPairing } = require('./native/account-pairing.cjs');
    const { NativeSource } = require('./native/source.cjs');
    const { CredentialVault } = require('./native/vault.cjs');
    const { default: browserDriver } = await import('puppeteer-core');
    if ([Accounts, AccountPairing, NativeSource, CredentialVault, browserDriver.connect].some(value => typeof value !== 'function')) throw new Error('missing_packaged_dependencies');
    if (process.platform === 'win32') {
      const fixture = 'Muse smoke: synthetic local encryption fixture';
      const encrypted = safeStorage.encryptString(fixture);
      try { if (safeStorage.decryptString(encrypted) !== fixture) throw new Error('os_encryption_roundtrip_failed'); }
      finally { encrypted.fill(0); }
    }
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
    await createComposer();
    await petWindow.webContents.executeJavaScript('document.querySelector("#menu-dot").click()');
    await new Promise(resolve => setTimeout(resolve, 250));
    const orbitChecks = await petWindow.webContents.executeJavaScript(`(() => {
      const portrait=document.querySelector('#portrait'), bubbles=[...document.querySelectorAll('#orbit .bubble')];
      const boxes=bubbles.map(bubble=>bubble.getBoundingClientRect());
      return {
      expanded:document.body.dataset.orbit==='true',
      four:document.querySelectorAll('#orbit .bubble').length===4,
      destinations:document.querySelectorAll('#orbit [data-workspace]:enabled').length===3,
      account:!!document.querySelector('#orbit-account'),
      separate:!portrait.contains(document.querySelector('#menu-dot')),
      rightSide:boxes.every(box=>box.left>portrait.getBoundingClientRect().right),
      crescent:boxes[1].x>boxes[0].x && boxes[2].x>boxes[3].x && boxes.every((box,i)=>i===0||box.y>boxes[i-1].y),
    }; })()`);
    if (!Object.values(orbitChecks).every(Boolean)) throw new Error('orbit_not_rendered');
    if (composerWindow.isVisible()) throw new Error('dot_opened_chat');
    await petWindow.webContents.executeJavaScript('document.querySelector("#portrait").click()');
    await new Promise(resolve => setTimeout(resolve, 350));
    if (!composerWindow.isVisible() || petOrbit) throw new Error('portrait_did_not_open_chat');
    await composerWindow.webContents.executeJavaScript(`document.querySelector('#draft').value='retained local fixture'`);
    await petWindow.webContents.executeJavaScript('document.querySelector("#portrait").click()');
    await new Promise(resolve => setTimeout(resolve, 350));
    if (composerWindow.isVisible()) throw new Error('second_click_did_not_hide_chat');
    await petWindow.webContents.executeJavaScript('document.querySelector("#portrait").click()');
    await new Promise(resolve => setTimeout(resolve, 350));
    const preserved = await composerWindow.webContents.executeJavaScript(`document.querySelector('#draft').value==='retained local fixture' && getComputedStyle(document.querySelector('main')).opacity==='1'`);
    if (!composerWindow.isVisible() || !preserved) throw new Error('reopen_lost_draft_or_animation');
    const originalPet = petWindow.getBounds(), originalChat = composerWindow.getBounds();
    composerWindow.setPosition(originalChat.x-8, originalChat.y, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    const independentChat = composerWindow.getBounds();
    if (petWindow.getBounds().x !== originalPet.x || petWindow.getBounds().y !== originalPet.y) throw new Error('chat_moved_pet');
    petWindow.setPosition(originalPet.x-16, originalPet.y-8, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    const movedPet = petWindow.getBounds(), followedChat = composerWindow.getBounds();
    if (followedChat.x-independentChat.x !== movedPet.x-originalPet.x || followedChat.y-independentChat.y !== movedPet.y-originalPet.y) throw new Error('chat_did_not_follow_pet');
    setPetOrbit(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterOrbit = composerWindow.getBounds();
    if (afterOrbit.x !== followedChat.x || afterOrbit.y !== followedChat.y) throw new Error('orbit_shifted_chat');
    setPetOrbit(false);
    windowFollower.moveSilently(() => petWindow.setBounds(originalPet));
    composerWindow.setBounds(originalChat);
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
    if (process.argv.includes('--workspace-test')) await require('./scripts/workspace-smoke.cjs').runWorkspaceSmoke(composerWindow);
    console.log('SMOKE_PASS: pet + composer toggle/motion + native window following + reply/file cards + audio worklet; no microphone opened; no message sent; sandbox/isolation enabled');
    app.quit();
  } catch (error) { console.error('SMOKE_FAIL', error.code === 'ERR_ASSERTION' ? error.message : /^[a-z_]+$/.test(error.message) ? error.message : 'unexpected_error'); app.exit(1); }
}

ipcMain.handle('pet:get-state', event => isPet(event) ? currentState : null);
ipcMain.on('pet:open-muse', event => { if (isPet(event)) showMuse(); });
ipcMain.on('pet:hide', event => { if (isPet(event)) { setPetOrbit(false); petWindow.hide(); } });
ipcMain.on('pet:compose', event => { if (isPet(event)) toggleComposer(); });
ipcMain.on('pet:workspace', (event, view) => {
  if (isPet(event) && petWindow.isVisible()) void showWorkspace(view);
});
ipcMain.handle('pet:orbit', (event, expanded) => isPet(event) && typeof expanded === 'boolean' ? setPetOrbit(expanded) : false);
ipcMain.on('pet:account-menu', event => {
  if (isPet(event) && petWindow.isVisible() && petOrbit) Menu.buildFromTemplate(accountItems()).popup({ window: petWindow });
});
ipcMain.on('composer:account-menu', event => {
  if (isComposer(event) && composerWindow.isVisible()) Menu.buildFromTemplate(accountItems()).popup({ window: composerWindow });
});
ipcMain.handle('composer:state', event => isComposer(event) ? composerState() : null);
ipcMain.handle('composer:workspace', event => isComposer(event) ? workspaceSnapshot() : null);
ipcMain.handle('composer:sessions', event => isComposer(event) ? sessionSnapshot() : null);
ipcMain.handle('composer:refresh-sessions', event =>
  isComposer(event) && composerWindow.isVisible() && nativeMode && !smoke && engine
    ? engine.refreshConversations() : { ok: false });
ipcMain.handle('composer:select-session', async (event, id) => {
  if (!inputAllowed(event) || inputSelecting || captureOperation || sessionSwitchBusy || !nativeMode || smoke || !engine) return { ok: false };
  const source = engine, window = composerWindow, previousId = source.activeSessionId;
  if (id !== null && typeof id !== 'string') return { ok: false };
  sessionSwitchBusy = true;
  try {
    if (id !== null && !(await source.refreshConversations()).ok) return { ok: false };
    if (engine !== source || composerWindow !== window || !source.conversations.selectable(id) || quitting) return { ok: false };
    inputAttachments = attachmentSessions.select(id);
    cancelVoice();
    const result = await source.selectSession(id);
    if (engine !== source || composerWindow !== window || quitting) return { ok: false };
    if (!result.ok && source.activeSessionId === previousId) inputAttachments = attachmentSessions.select(previousId);
    return { ...result, session: sessionSnapshot(), replies: replySnapshot(), files: inputAttachments.list() };
  } catch (error) {
    return { ok: false, reason: error.message === 'attachment_session_capacity' ? 'attachment_session_capacity' : 'unavailable' };
  } finally { if (engine === source && composerWindow === window) sessionSwitchBusy = false; }
});
ipcMain.handle('composer:spaces', event => isComposer(event) ? spacesSnapshot() : null);
ipcMain.handle('composer:refresh-spaces', event =>
  isComposer(event) && composerWindow.isVisible() && nativeMode && !smoke && engine
    ? engine.refreshSpaces() : { ok: false });
ipcMain.handle('composer:refresh-workspace', event =>
  isComposer(event) && composerWindow.isVisible() && nativeMode && !smoke && engine
    ? engine.refreshWorkspace() : { ok: false });
ipcMain.handle('composer:preferences', event => isComposer(event) ? preferences.snapshot() : null);
ipcMain.handle('composer:set-preferences', (event, patch) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused()) return { ok: false };
  try {
    const value = preferences.update(patch);
    if (!value.notifications || value.quietUntil > Date.now()) {
      for (const notification of activeNotifications) notification.close();
      activeNotifications.clear();
    }
    return { ok: true, value };
  } catch { return { ok: false }; }
});
ipcMain.handle('composer:official-page', async (event, key) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() ||
      typeof key !== 'string' || !Object.hasOwn(OFFICIAL_PAGES, key) || smoke) return { ok: false };
  try { await shell.openExternal(OFFICIAL_PAGES[key]); return { ok: true }; }
  catch { return { ok: false }; }
});
ipcMain.on('composer:hide', event => { if (isComposer(event)) hideComposer(); });
ipcMain.on('composer:cancel-voice', event => { if (isComposer(event)) revokeVoice(); });
ipcMain.on('composer:transition-done', (event, id) => { if (isComposer(event) && Number.isSafeInteger(id)) composerVisibility.complete(id); });
ipcMain.handle('composer:replies', event => isComposer(event) ? replySnapshot() : null);
ipcMain.handle('composer:refresh-replies', async event => isComposer(event) && nativeMode && !smoke && engine ? engine.refreshReplies() : { ok: false });
ipcMain.on('composer:read-replies', event => { if (isComposer(event) && composerWindow.isVisible() && composerWindow.isFocused()) engine?.displayReplies?.read(); });
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
  const source = engine, selection = engine?.sessionGeneration;
  try {
    const value = await source.attachment(request.messageId, request.assetId);
    if (engine !== source || source.sessionGeneration !== selection || !validAssetRequest(event, request)) return { ok: false, reason: 'cancelled' };
    const result = await dialog.showSaveDialog(composerWindow, { title: '保存 Muse 附件（不会执行）',
      defaultPath: path.join(app.getPath('downloads'), path.basename(value.name)), buttonLabel: '保存' });
    if (result.canceled || !result.filePath || engine !== source || source.sessionGeneration !== selection || !validAssetRequest(event, request)) return { ok: false, reason: 'cancelled' };
    await fs.promises.writeFile(result.filePath, value.bytes, { flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.code === 'EEXIST' ? 'already_exists' : 'save_failed' }; }
});
ipcMain.handle('composer:copy-code', (event, request) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() || !Number.isInteger(request?.index) || request.index < 0 || request.index > 100) return { ok: false };
  const text = engine?.displayReplies?.code(request.messageId, request.index);
  if (typeof text !== 'string' || text.length > 128*1024) return { ok: false };
  clipboard.writeText(text); return { ok: true };
});
function inputAllowed(event) {
  return isComposer(event) && composerWindow.isVisible() && composerWindow.isFocused() && !activeSubmission && !sessionSwitchBusy;
}
ipcMain.handle('composer:capture', async event => {
  if (!inputAllowed(event) || captureOperation || smoke && !process.argv.includes('--workspace-test')) return { ok: false };
  if (smoke) {
    const width = 640, height = 360, bitmap = Buffer.alloc(width * height * 4);
    for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 180; bitmap[i + 1] = 150; bitmap[i + 2] = i < bitmap.length / 2 ? 40 : 210; bitmap[i + 3] = 255; }
    const bytes = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG(); bitmap.fill(0);
    return { ok: true, bytes, width, height };
  }
  const operation = {}, generation = inputAttachments.generation, window = composerWindow;
  captureOperation = operation; cancelVoice();
  const owned = () => !quitting && generation === inputAttachments.generation &&
    captureOperation === operation && composerWindow === window && !window.isDestroyed();
  const current = () => owned() && composerVisibility.open;
  try {
    return await require('./capture-screen.cjs').captureScreen({ desktopCapturer, screen, composer: window, pet: petWindow, current, canRestore: owned,
      restore: wasPetVisible => {
        if (wasPetVisible && petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
        if (composerVisibility.open) { window.show(); window.focus(); }
      } });
  } catch { return { ok: false }; }
  finally { if (captureOperation === operation) captureOperation = null; }
});
ipcMain.handle('composer:input-list', event => isComposer(event) ? inputAttachments.list() : []);
ipcMain.handle('composer:input-select', async event => {
  if (!inputAllowed(event) || inputSelecting || smoke) return { ok: false, reason: 'unavailable' };
  const store = inputAttachments, generation = store.generation;
  inputSelecting = true;
  try {
    const result = await dialog.showOpenDialog(composerWindow, { title: '选择待发送给 Muse 的附件',
      properties: ['openFile', 'multiSelections'], buttonLabel: '加入消息' });
    if (result.canceled || store !== inputAttachments || generation !== store.generation) return { ok: false, reason: 'cancelled' };
    if (result.filePaths.length + inputAttachments.rows.size > 4) return { ok: false, reason: 'attachment_capacity' };
    let reason = null;
    for (const file of result.filePaths) {
      if (store !== inputAttachments || generation !== store.generation || quitting) return { ok: false, reason: 'cancelled' };
      try { await store.selectFile(file); } catch (error) { reason = safeInputReason(error); break; }
    }
    return { ok: !reason, reason, files: inputAttachments.list() };
  } catch { return { ok: false, reason: 'file_unavailable' }; }
  finally { if (store === inputAttachments) inputSelecting = false; }
});
function safeInputReason(error) {
  return ['attachment_capacity', 'attachment_size_limit', 'attachment_type_unsupported', 'attachment_image_invalid', 'invalid_filename', 'file_changed']
    .includes(error?.message) ? error.message : 'file_unavailable';
}
ipcMain.handle('composer:input-stage', (event, file) => {
  if (!inputAllowed(event)) return { ok: false, reason: 'unavailable' };
  try { inputAttachments.stage(file?.name, file?.bytes); return { ok: true, files: inputAttachments.list() }; }
  catch (error) { return { ok: false, reason: safeInputReason(error) }; }
});
ipcMain.handle('composer:input-remove', (event, id) => {
  if (!inputAllowed(event) || typeof id !== 'string') return { ok: false };
  inputAttachments.remove(id); return { ok: true, files: inputAttachments.list() };
});
ipcMain.handle('composer:input-preview', (event, id) =>
  isComposer(event) && composerWindow.isVisible() && typeof id === 'string' ? inputAttachments.preview(id) : null);
ipcMain.handle('composer:send', async (event, draft) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() || !nativeMode || !engine?.submitTask || smoke) return { status: 'not_sent', reason: 'unavailable' };
  if (activeSubmission || sessionSwitchBusy || draft?.sessionId !== engine.activeSessionId ||
      typeof draft?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(draft.id) ||
      typeof draft.text !== 'string' || draft.text.length > 8000) return { status: 'not_sent', reason: 'invalid_draft' };
  const source = engine, generation = inputAttachments.generation, operation = {};
  activeSubmission = operation;
  let dispatched = false;
  try {
    const ids = draft.attachmentIds ?? [];
    let attachments = inputAttachments.resolve(ids);
    if (attachments.length) {
      const result = await dialog.showMessageBox(composerWindow, { type: 'question', title: '发送附件给 Muse',
        message: `将 ${attachments.length} 个附件发送到 Muse 云端「${source.sessionSnapshot().title}」？`,
        detail: attachments.map(file => `${file.name} (${(file.bytes.length / 1024).toFixed(1)} KB)`).join('\n'),
        buttons: ['取消', '确认发送'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return { status: 'not_sent', reason: 'cancelled' };
      if (generation !== inputAttachments.generation || source !== engine || quitting ||
          !isComposer(event) || !composerWindow.isVisible()) return { status: 'not_sent', reason: 'account_changed' };
      attachments = inputAttachments.resolve(ids);
    }
    dispatched = true;
    const result = await source.submitTask({ id: draft.id, text: draft.text, attachments });
    if (source !== engine || generation !== inputAttachments.generation) return { status: 'uncertain', reason: 'account_changed' };
    if (result?.status === 'accepted') for (const id of ids) inputAttachments.remove(id);
    return result;
  } catch { return { status: dispatched ? 'uncertain' : 'not_sent', reason: dispatched ? 'delivery_unconfirmed' : 'attachment_expired' }; }
  finally { if (activeSubmission === operation) activeSubmission = null; }
});
ipcMain.handle('composer:microphone', async event => {
  if (!isComposer(event) || !composerWindow.isVisible() || !composerWindow.isFocused() || !nativeMode || smoke) return { allowed: false };
  const permissionGeneration = ++voicePermissionGeneration, window = composerWindow, source = engine;
  try {
    const granted = process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted' ||
      await systemPreferences.askForMediaAccess('microphone');
    if (!granted || permissionGeneration !== voicePermissionGeneration || source !== engine ||
        composerWindow !== window || window.isDestroyed() || !window.isVisible()) return { allowed: false };
    microphoneAllowedUntil = Date.now() + 30000;
    voiceLease = { id: randomUUID(), expiresAt: Date.now() + 120000 };
    return { allowed: true, id: voiceLease.id };
  } catch { return { allowed: false }; }
});
ipcMain.handle('composer:transcribe', async (event, audio) => {
  if (!isComposer(event) || !composerWindow.isVisible() || !nativeMode || smoke || !voiceLease ||
      audio?.permissionId !== voiceLease.id || Date.now() > voiceLease.expiresAt) {
    if (audio?.samples instanceof ArrayBuffer) new Uint8Array(audio.samples).fill(0);
    return { status: 'error', reason: 'voice_not_authorized' };
  }
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
    preferences = new Preferences(app.getPath('userData'));
    powerMonitor.on('suspend', () => { suspended = true; cancelVoice(); if (nativeMode) void engine?.pause(); else invalidate(); });
    powerMonitor.on('resume', () => { suspended = false; if (nativeMode) void engine?.reload(); else { invalidate(); void poll(); } });
    return createWindows();
  }).catch(() => { console.error('START_FAILED: 请检查本机运行环境'); app.exit(1); });
  app.on('activate', () => { showPet(); if (composerWindow?.isVisible()) composerWindow.focus(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; clearInterval(timer); cancelVoice(); globalShortcut.unregisterAll(); tray?.destroy();
    clearNotifications();
    attachmentSessions.clear();
    composerVisibility.reset();
    if (accounts || engine) { event.preventDefault(); void (accounts ? accounts.stop() : engine.stop()).then(() => app.exit(0), () => app.exit(1)); }
  });
}
