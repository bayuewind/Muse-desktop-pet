'use strict';
// Real visible login-window smoke. Never reads cookies or submits a login.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ChromeEngine, chromeCandidates } = require('../chrome-engine.cjs');
async function main() {
  const edge = process.argv.includes('--edge');
  const executablePath = chromeCandidates().find(candidate => (!edge || /msedge\.exe$/i.test(candidate)) && fs.existsSync(candidate));
  if (!executablePath) throw new Error('requested_browser_missing');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-browser-smoke-'));
  const engine = new ChromeEngine(directory, () => {}, { executablePath });
  try {
    await engine.start();
    await engine.page.waitForFunction(() => document.body?.innerText.trim().length > 30 && document.querySelector('input,button'), { timeout: 20000 });
    if (engine.httpError || engine.origin !== 'https://muse.ai') throw new Error('login_document_not_ready');
    const processId = engine.ownedBrowser?.process.pid ?? engine.browser.process()?.pid;
    // DOM-ready is not proof that Windows is showing the browser. Read the
    // exact owned process's main-window handle as a separate regression check.
    if (process.platform === 'win32') {
      if (!Number.isSafeInteger(processId)) throw new Error('browser_pid_missing');
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
        `(Get-Process -Id ${processId}).MainWindowHandle.ToInt64()`], { windowsHide: true, timeout: 10000 });
      if (!/^[1-9][0-9]*$/.test(stdout.trim())) throw new Error('browser_window_not_visible');
    }
    console.log(JSON.stringify({ status: 'LOGIN_WINDOW_READY', browser: edge ? 'Edge' : 'Chrome', processId,
      title: await engine.page.title(), transport: 'private-pipe' }));
    if (process.argv.includes('--hold')) await new Promise(resolve => setTimeout(resolve, 45000));
  } finally {
    await engine.stop();
    // Delete only the unique directory this test created, after browser exit.
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('muse-browser-smoke-')) throw new Error('unsafe_test_directory');
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log('BROWSER_SMOKE_PASS: loaded Muse, closed exact child, removed its temporary profile; no credentials read');
}
main().catch(error => { console.error('BROWSER_SMOKE_FAIL:', error.name); process.exitCode = 1; });
