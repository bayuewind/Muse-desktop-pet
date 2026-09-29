'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, powerMonitor, safeStorage, globalShortcut, systemPreferences } = require('electron');
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
const nativeMode = !smoke && !process.argv.includes('--browser') &&
  (process.argv.includes('--native') || fs.existsSync(path.join(app.getPath('userData'), 'native-session.enc')));
// No relaxed TLS, CSP or same-origin policy. Only scheduling/occlusion switches.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let petWindow, engine, tray, timer, quitting = false, polling = false, suspended = false;
let composerWindow, shortcutAvailable = false, microphoneAllowedUntil = 0, voiceLease = null;
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
async function showComposer() {
  if (quitting) return;
  if (!composerWindow || composerWindow.isDestroyed()) await createComposer();
  if (composerWindow.isMinimized()) composerWindow.restore();
  const anchor = petWindow?.getBounds() ?? { x: 300, y: 300, width: 256, height: 306 };
  const area = screen.getDisplayMatching(anchor).workArea;
  const width = 460, height = 410;
  let x = anchor.x - width - 14;
  if (x < area.x) x = anchor.x + anchor.width + 14;
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(anchor.y, area.y + area.height - height - 8));
  composerWindow.setBounds({ x, y, width, height });
  composerWindow.show(); composerWindow.focus();
  composerWindow.webContents.send('pet:state', composerState());
  composerWindow.webContents.send('composer:focus');
}
async function createComposer() {
  composerWindow = new BrowserWindow({ width: 460, height: 410, title: '给 Muse 下达任务', frame: false,
    backgroundColor: '#fcfcf6', resizable: false, show: false, alwaysOnTop: true,
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
  if (nativeMode) { void engine?.reload().catch(() => {}); return; }
  void engine?.show().catch(() => { sample = { error: true }; receivedAt = Date.now(); publish(); });
}
function showPet() {
  if (quitting) return;
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.show(); petWindow.focus();
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '下达任务（文字 / 语音）', accelerator: COMPOSER_SHORTCUT, click: () => { void showComposer(); } },
    { label: '显示桌宠', click: showPet },
    { label: nativeMode ? '原生重连（不打开浏览器）' : '打开 Muse / 登录', click: showMuse },
    { label: '隐藏桌宠', click: () => petWindow.hide() },
    { type: 'separator' },
    { label: nativeMode ? '重新连接云端' : '重新连接（刷新独立页面）', click: () => { invalidate(); void engine?.reload().catch(() => invalidate()); } },
    { label: '退出桌宠', click: () => app.quit() },
  ]));
  tray.on('double-click', showPet);
  if (!smoke) shortcutAvailable = globalShortcut.register(COMPOSER_SHORTCUT, () => {
    if (composerWindow?.isVisible() && composerWindow.isFocused()) hideComposer(); else void showComposer();
  });

  if (smoke) return runSmoke();
  if (nativeMode) {
    const { CredentialVault } = require('./native/vault.cjs');
    const { NativeSource } = require('./native/source.cjs');
    engine = new NativeSource(new CredentialVault(app.getPath('userData'), safeStorage));
    engine.on('state', state => { nativeState = state; publish(); });
    await engine.start(); return;
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
    console.log('SMOKE_PASS: pet states + composer + audio worklet; no microphone opened; no message sent; sandbox/isolation enabled');
    app.quit();
  } catch { console.error('SMOKE_FAIL'); app.exit(1); }
}

ipcMain.handle('pet:get-state', event => isPet(event) ? currentState : null);
ipcMain.on('pet:open-muse', event => { if (isPet(event)) showMuse(); });
ipcMain.on('pet:hide', event => { if (isPet(event)) petWindow.hide(); });
ipcMain.on('pet:compose', event => { if (isPet(event)) void showComposer(); });
ipcMain.handle('composer:state', event => isComposer(event) ? composerState() : null);
ipcMain.on('composer:hide', event => { if (isComposer(event)) hideComposer(); });
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Muse 桌宠', submenu: [{ label: nativeMode ? '原生重连' : '打开 Muse / 登录', click: showMuse },
        { label: '下达任务（文字 / 语音）', accelerator: COMPOSER_SHORTCUT, click: () => { void showComposer(); } },
        { label: '显示桌宠', click: showPet }, { type: 'separator' }, { role: 'quit', label: '退出桌宠' }] },
      { role: 'editMenu', label: '编辑' },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
    powerMonitor.on('suspend', () => { suspended = true; cancelVoice(); if (nativeMode) void engine?.pause(); else invalidate(); });
    powerMonitor.on('resume', () => { suspended = false; if (nativeMode) void engine?.reload(); else { invalidate(); void poll(); } });
    return createWindows();
  }).catch(() => { console.error('START_FAILED: 请检查本机运行环境'); app.exit(1); });
  app.on('activate', () => { showPet(); if (composerWindow?.isVisible()) composerWindow.focus(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; clearInterval(timer); cancelVoice(); globalShortcut.unregisterAll(); tray?.destroy();
    if (engine) { event.preventDefault(); void engine.stop().then(() => app.exit(0), () => app.exit(1)); }
  });
}
