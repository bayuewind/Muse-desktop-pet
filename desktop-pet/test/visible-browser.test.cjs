'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { BrowserPipeTransport, launchVisibleBrowser } = require('../visible-browser.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('CDP pipe preserves UTF-8 across fragmented and multiple NUL-delimited messages', async () => {
  const write = new PassThrough(), read = new PassThrough();
  const transport = new BrowserPipeTransport(write, read);
  const messages = []; transport.onmessage = value => messages.push(value);
  const first = JSON.stringify({ title: '测试 Muse' }), second = JSON.stringify({ id: 2 });
  const bytes = Buffer.from(first + '\0' + second + '\0');
  for (const byte of bytes) read.write(Buffer.from([byte]));
  await tick(); assert.deepEqual(messages, [first, second]);
  let output = ''; write.on('data', chunk => { output += chunk; });
  transport.send(second); assert.equal(output, second + '\0');
  transport.close();
});

test('pipe close/error is idempotent and oversized messages fail closed', async () => {
  const write = new PassThrough(), read = new PassThrough();
  const transport = new BrowserPipeTransport(write, read, 8);
  let closed = 0, messages = 0;
  transport.onclose = () => closed++;
  transport.onmessage = () => messages++;
  read.write(Buffer.from('123456789'));
  read.emit('error', new Error('fixture')); transport.close();
  await tick();
  assert.equal(closed, 1); assert.equal(messages, 0);
  assert.throws(() => transport.send('{}'), /pipe_closed/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  child.exitCode = null; child.kills = 0;
  child.kill = () => { child.kills++; child.exitCode = 0; child.emit('exit', 0); return true; };
  return child;
}

test('Windows login is explicitly visible and uses only owned private pipe handles', async () => {
  const child = fakeChild(); let spawnCall, connectCall, closes = 0;
  const browser = { close: async () => { closes++; child.exitCode = 0; child.emit('exit', 0); } };
  const owned = await launchVisibleBrowser({ connect: async opts => { connectCall = opts; return browser; } },
    'fixture-chrome.exe', ['--remote-debugging-pipe', '--user-data-dir=fixture'], {
      spawnImpl: (...args) => { spawnCall = args; return child; },
    });
  assert.equal(spawnCall[2].windowsHide, false);
  assert.equal(spawnCall[2].shell, false);
  assert.deepEqual(spawnCall[2].stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  assert.equal(connectCall.defaultViewport, null);
  assert.ok(connectCall.transport instanceof BrowserPipeTransport);
  assert.equal(owned.process, child);
  await Promise.all([owned.close(), owned.close()]);
  assert.equal(closes, 1); assert.equal(child.kills, 0);
  assert.equal(connectCall.transport.closed, true);
});

test('failed/timed-out CDP connection kills only the owned child before returning', async () => {
  for (const connect of [async () => { throw new Error('fixture'); }, () => new Promise(() => {})]) {
    const child = fakeChild();
    await assert.rejects(launchVisibleBrowser({ connect }, 'fixture.exe', ['--remote-debugging-pipe'], {
      spawnImpl: () => child, timeoutMs: 10,
    }));
    assert.equal(child.kills, 1);
    assert.ok(child.stdio[3].destroyed && child.stdio[4].destroyed);
  }
});

test('spawn errors are handled without orphaning a process or exit listener', async () => {
  const count = process.listenerCount('exit'), child = fakeChild();
  await assert.rejects(launchVisibleBrowser({ connect: () => new Promise(() => {}) }, 'missing.exe', ['--remote-debugging-pipe'], {
    spawnImpl: () => { setImmediate(() => child.emit('error', new Error('ENOENT'))); return child; }, timeoutMs: 100,
  }), /browser_spawn_failed/);
  assert.equal(process.listenerCount('exit'), count);
  assert.equal(child.kills, 0);
});

test('launcher refuses a TCP debug port or missing private pipe', async () => {
  for (const args of [[], ['--remote-debugging-pipe', '--remote-debugging-port=0']]) {
    await assert.rejects(launchVisibleBrowser({}, 'fixture.exe', args, {
      spawnImpl: () => { throw new Error('must_not_spawn'); },
    }), /private_browser_pipe_required/);
  }
});
