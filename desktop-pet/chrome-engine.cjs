'use strict';
const fs = require('node:fs');
const path = require('node:path');

function chromeCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (platform === 'win32') return [
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function findChrome(options = {}) {
  const exists = options.existsSync ?? fs.existsSync;
  return chromeCandidates(options.platform, options.env).find(candidate => exists(candidate)) ?? null;
}

function browserLaunchArgs(profileDirectory) {
  // Keep normal OS credential storage, site isolation and phishing protection.
  // Do not import Puppeteer's testing-only default arguments.
  return [`--user-data-dir=${profileDirectory}`, '--enable-automation', '--no-first-run',
    '--no-default-browser-check', '--window-size=1120,820', '--remote-debugging-pipe',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank'];
}

// An owned Chromium browser (Chrome or Edge) with its OWN profile and a private
// debugging PIPE. Never connect to the user's existing browser/profile.
class ChromeEngine {
  constructor(profileDirectory, onInvalidate = () => {}, { executablePath } = {}) {
    this.profileDirectory = profileDirectory;
    this.onInvalidate = onInvalidate;
    this.browser = null; this.page = null; this.starting = null;
    this.loading = true; this.httpError = false; this.stopping = false;
    this.executablePath = executablePath; this.ownedBrowser = null;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.browser) return this.show();
    this.stopping = false;
    this.starting = this.launch();
    try { return await this.starting; }
    catch (error) { await this.closeBrowser(); throw error; }
    finally { this.starting = null; }
  }
  async launch() {
    const executablePath = this.executablePath ?? findChrome();
    if (!executablePath) throw new Error('supported_browser_missing');
    fs.mkdirSync(this.profileDirectory, { recursive: true, mode: 0o700 });
    const { default: puppeteer } = await import('puppeteer-core');
    const args = browserLaunchArgs(this.profileDirectory);
    if (process.platform === 'win32') {
      this.ownedBrowser = await require('./visible-browser.cjs').launchVisibleBrowser(puppeteer, executablePath, args);
      this.browser = this.ownedBrowser.browser;
    } else this.browser = await puppeteer.launch({
      executablePath, userDataDir: this.profileDirectory,
      headless: false, pipe: true, defaultViewport: null,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      // Avoid Puppeteer's testing defaults (mock keychain/basic password store,
      // disabled phishing protection and iframe isolation). Keep automation disclosed.
      ignoreDefaultArgs: true,
      args,
    });
    this.browser.on('disconnected', () => {
      this.page = null; this.browser = null;
      if (!this.stopping) this.onInvalidate();
    });
    let pages = await this.browser.pages();
    if (!pages.length) {
      const target = await this.browser.waitForTarget(t => t.type() === 'page', { timeout: 20000 });
      const page = await target.page(); pages = page ? [page] : [];
    }
    const page = pages.find(p => p.url().startsWith('https://muse.ai/')) ?? pages[0] ?? await this.browser.newPage();
    await this.attach(page);
    if (!page.url().startsWith('https://muse.ai/')) await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    this.loading = false;
    // Focus the real window; this does not substitute for a visible spawn.
    await this.show();
  }
  async attach(page) {
    this.page = page; this.httpError = false;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.onInvalidate();
    });
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.loading = true; this.httpError = false;
      }
    });
    page.on('response', response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.httpError = response.status() >= 400;
        // Only a numeric HTTP result; never log URLs, headers or response bodies.
        console.log(`MUSE_DOCUMENT_HTTP_STATUS=${response.status()}`);
      }
    });
    page.on('domcontentloaded', () => { this.loading = false; });
    page.on('error', () => this.onInvalidate());
    page.on('close', () => { if (this.page === page) { this.page = null; this.onInvalidate(); } });
    // A fast initial response may have arrived before handlers were attached.
    const readiness = await page.evaluate(() => document.readyState).catch(() => 'loading');
    this.loading = readiness === 'loading';
    this.httpError = await page.evaluate(() => /^4xx Client Error$/.test(document.title)).catch(() => false);
  }
  get origin() { try { return this.page && new URL(this.page.url()).origin; } catch { return null; } }
  async evaluate(script) {
    if (!this.page || this.page.isClosed() || this.origin !== 'https://muse.ai') throw new Error('source_unavailable');
    return this.page.evaluate(script);
  }
  async show() {
    if (!this.browser) return this.start();
    if (!this.page || this.page.isClosed()) {
      const page = await this.browser.newPage(); await this.attach(page);
      await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const cdp = await this.page.createCDPSession();
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    } finally { await cdp.detach(); }
    await this.page.bringToFront();
  }
  async reload() {
    if (!this.page || this.page.isClosed()) return this.show();
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  async stop() {
    this.stopping = true;
    if (this.starting) await this.starting.catch(() => {});
    await this.closeBrowser();
  }
  async closeBrowser() {
    if (this.ownedBrowser) {
      await this.ownedBrowser.close();
      this.ownedBrowser = null; this.browser = null; this.page = null;
      return;
    }
    const browser = this.browser;
    if (!browser) return;
    const ownedProcess = browser.process();
    let timeout;
    try {
      await Promise.race([browser.close(), new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]);
    } finally {
      clearTimeout(timeout);
      // Only the exact child we launched, never a broad process-name kill.
      if (ownedProcess && ownedProcess.exitCode == null && !ownedProcess.killed) ownedProcess.kill('SIGTERM');
    }
  }
}
module.exports = { ChromeEngine, chromeCandidates, findChrome, browserLaunchArgs };
