'use strict';
const fs = require('node:fs');

// An owned Chrome process with its OWN profile and a private debugging PIPE.
// Never connect to the user's existing Chrome, use its profile, or expose a port.
class ChromeEngine {
  constructor(profileDirectory, onInvalidate) {
    this.profileDirectory = profileDirectory;
    this.onInvalidate = onInvalidate;
    this.browser = null; this.page = null; this.starting = null;
    this.loading = true; this.httpError = false; this.stopping = false;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async launch() {
    const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (!fs.existsSync(executablePath)) throw new Error('supported_chrome_missing');
    fs.mkdirSync(this.profileDirectory, { recursive: true, mode: 0o700 });
    const { default: puppeteer } = await import('puppeteer-core');
    this.browser = await puppeteer.launch({
      executablePath, userDataDir: this.profileDirectory,
      headless: false, pipe: true, defaultViewport: null,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      // Avoid Puppeteer's testing defaults (mock keychain/basic password store,
      // disabled phishing protection and iframe isolation). Keep automation disclosed.
      ignoreDefaultArgs: true,
      args: [`--user-data-dir=${this.profileDirectory}`, '--enable-automation', '--no-first-run', '--no-default-browser-check',
        '--app=https://muse.ai/', '--window-size=1120,820',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'],
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
    if (!this.browser) await this.start();
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
module.exports = { ChromeEngine };
