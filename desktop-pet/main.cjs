'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { observerScript } = require('./observer.cjs');
let observerFactory = observerScript;
const observerFile = require.resolve('./observer.cjs');
let observerMtime = fs.statSync(observerFile).mtimeMs;
const { deriveState } = require('./state.cjs');
const { ChromeEngine } = require('./chrome-engine.cjs');

const smoke = process.argv.includes('--smoke-test');
app.setName('Muse 桌宠');
app.setPath('userData', path.join(app.getPath('appData'), smoke ? 'MuseDesktopPet-Smoke' : 'MuseDesktopPet'));
// No relaxed TLS, CSP or same-origin policy. Only scheduling/occlusion switches.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let petWindow, engine, tray, timer, quitting = false, polling = false, suspended = false;
let resetNeeded = false, lifecycle = 0, sample = null, receivedAt = 0;
let currentState = deriveState({ sourceReady: false });
let lastDiagnostic = '';
const petURL = pathToFileURL(path.join(__dirname, 'pet.html')).href;

function isPet(event) {
  return petWindow && event.sender === petWindow.webContents && event.senderFrame?.url === petURL;
}
function publish() {
  currentState = suspended
    ? deriveState({ suspended: true }, Date.now(), Date.now())
    : deriveState(sample, Date.now(), receivedAt);
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:state', currentState);
  tray?.setToolTip(`Muse 桌宠 · ${currentState.label}`);
}
function invalidate() {
  lifecycle++; sample = null; receivedAt = 0; resetNeeded = true; publish();
}
function showMuse() {
  void engine?.show().catch(() => { sample = { error: true }; receivedAt = Date.now(); publish(); });
}
function showPet() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.show(); petWindow.focus();
}
async function poll() {
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
    { label: '显示桌宠', click: showPet },
    { label: '打开 Muse / 登录', click: showMuse },
    { label: '隐藏桌宠', click: () => petWindow.hide() },
    { type: 'separator' },
    { label: '重新连接（刷新独立页面）', click: () => { invalidate(); void engine?.reload().catch(() => invalidate()); } },
    { label: '退出桌宠', click: () => app.quit() },
  ]));
  tray.on('double-click', showPet);

  if (smoke) return runSmoke();
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
    console.log('SMOKE_PASS: login/working/disconnected rendered; sandbox and isolation enabled');
    app.quit();
  } catch { console.error('SMOKE_FAIL'); app.exit(1); }
}

ipcMain.handle('pet:get-state', event => isPet(event) ? currentState : null);
ipcMain.on('pet:open-muse', event => { if (isPet(event)) showMuse(); });
ipcMain.on('pet:hide', event => { if (isPet(event)) petWindow.hide(); });

const gotLock = smoke || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.on('second-instance', () => { showPet(); showMuse(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Muse 桌宠', submenu: [{ label: '打开 Muse / 登录', click: showMuse },
        { label: '显示桌宠', click: showPet }, { type: 'separator' }, { role: 'quit', label: '退出桌宠' }] },
      { role: 'editMenu', label: '编辑' },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
    powerMonitor.on('suspend', () => { suspended = true; invalidate(); });
    powerMonitor.on('resume', () => { suspended = false; invalidate(); void poll(); });
    return createWindows();
  }).catch(() => { console.error('START_FAILED: 请检查本机运行环境'); app.exit(1); });
  app.on('activate', showMuse);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; clearInterval(timer); tray?.destroy();
    if (engine) { event.preventDefault(); void engine.stop().finally(() => app.quit()); }
  });
}
