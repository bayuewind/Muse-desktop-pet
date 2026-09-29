'use strict';
const { spawn } = require('node:child_process');

// Public Puppeteer ConnectionTransport contract over Chromium's private,
// NUL-delimited CDP pipes. No TCP listener or access to other browser profiles.
class BrowserPipeTransport {
  constructor(write, read, maxBytes = 32 * 1024 * 1024) {
    this.write = write; this.read = read; this.maxBytes = maxBytes;
    this.closed = false; this.parts = []; this.size = 0;
    this.data = chunk => this.receive(chunk);
    this.end = () => this.close();
    read.on('data', this.data);
    read.on('close', this.end); read.on('error', this.end);
    write.on('error', this.end);
  }
  receive(chunk) {
    if (this.closed) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const part = chunk.subarray(start, end === -1 ? chunk.length : end);
      this.size += part.length;
      if (this.size > this.maxBytes) { this.close(); return; }
      this.parts.push(part);
      if (end === -1) return;
      const message = Buffer.concat(this.parts, this.size).toString('utf8');
      this.parts = []; this.size = 0;
      // Dispatch after connect() has installed its callbacks, preserving order.
      setImmediate(() => { if (!this.closed) this.onmessage?.(message); });
      start = end + 1;
    }
  }
  send(message) {
    if (this.closed) throw new Error('browser_pipe_closed');
    this.write.write(message + '\0');
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.parts = []; this.size = 0;
    this.read.off('data', this.data);
    this.read.destroy(); this.write.destroy();
    this.onclose?.();
  }
}

async function bounded(promise, timeoutMs, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

async function launchVisibleBrowser(puppeteer, executablePath, args, { spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  if (!args.includes('--remote-debugging-pipe') || args.some(arg => arg.startsWith('--remote-debugging-port'))) {
    throw new Error('private_browser_pipe_required');
  }
  // Puppeteer's own launcher hardcodes windowsHide:true. Our Windows A/B test
  // found that it also hides this GUI process. The login window is intentional.
  const child = spawnImpl(executablePath, args, {
    windowsHide: false, detached: false, shell: false,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const transport = new BrowserPipeTransport(child.stdio[3], child.stdio[4]);
  let browser, ended = false, closing;
  let markExited;
  const exited = new Promise(resolve => { markExited = resolve; });
  const onParentExit = () => { if (!ended) child.kill(); };
  const finish = () => {
    ended = true; transport.close(); markExited();
    process.off('exit', onParentExit);
  };
  child.once('exit', finish);
  const failed = new Promise((_, reject) => child.once('error', () => {
    finish(); reject(new Error('browser_spawn_failed'));
  }));
  process.once('exit', onParentExit);
  function close() {
    if (closing) return closing;
    closing = (async () => {
      if (!ended && browser) await bounded(browser.close(), 5000, 'browser_close_timeout').catch(() => {});
      if (!ended) child.kill(); // Exact owned child only; never kill by name.
      await bounded(exited, 5000, 'browser_process_still_running');
      transport.close();
    })().catch(error => { closing = null; throw error; });
    return closing;
  }
  try {
    browser = await bounded(Promise.race([
      puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: timeoutMs }), failed,
    ]), timeoutMs, 'browser_connect_timeout');
    return { browser, process: child, close };
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { BrowserPipeTransport, launchVisibleBrowser };
