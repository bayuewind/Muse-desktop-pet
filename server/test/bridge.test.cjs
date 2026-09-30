'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerSafeStorage, generateVaultKey } = require('../server-safe-storage.cjs');
const { CredentialVault } = require('../../desktop-pet/native/vault.cjs');
const { toDeviceState, DEVICE_STATES } = require('../state-map.cjs');
const { DevicePusher } = require('../device-pusher.cjs');

const bundle = () => ({ version: 1, origin: 'https://muse.ai', target: { vmId: 'vm-test', gatewayUrl: 'wss://x', vmName: 'n' },
  cookieJar: { cookies: [] }, peerPolicy: { vmType: 'standard' } });

test('server storage round-trips through the real CredentialVault', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const vault = new CredentialVault(dir, createServerSafeStorage(generateVaultKey()));
  vault.save(bundle());
  assert.equal((fs.statSync(vault.filename).mode & 0o777), 0o600);
  assert.deepEqual(vault.load(), bundle());
  assert.equal(fs.readFileSync(vault.filename).includes('vm-test'), false, 'plaintext must not hit disk');
});

test('wrong key or tampered ciphertext fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  new CredentialVault(dir, createServerSafeStorage(generateVaultKey())).save(bundle());
  assert.throws(() => new CredentialVault(dir, createServerSafeStorage(generateVaultKey())).load(),
    /credential_decryption_failed/);
  const storage = createServerSafeStorage(generateVaultKey());
  const ciphertext = storage.encryptString('secret');
  ciphertext[ciphertext.length - 1] ^= 1;
  assert.throws(() => storage.decryptString(ciphertext));
});

test('missing or malformed key makes the vault unavailable', () => {
  for (const [key, problem] of [[undefined, 'vault_key_missing'], ['', 'vault_key_missing'],
    [Buffer.alloc(16).toString('base64'), 'vault_key_invalid']]) {
    const storage = createServerSafeStorage(key);
    assert.equal(storage.isEncryptionAvailable(), false);
    assert.equal(storage.problem, problem);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    assert.throws(() => new CredentialVault(dir, storage).save(bundle()), /os_encryption_unavailable/);
  }
});

test('every NativeStatus view maps to a device state, never idle when unsure', () => {
  const cases = [
    [{ kind: 'idle' }, 0, { state: 'default' }],
    [{ kind: 'working', variant: 'working' }, 0, { state: 'working' }],
    [{ kind: 'working', variant: 'working' }, 3, { state: 'working', subagents: 3 }],
    [{ kind: 'working', variant: 'making_something' }, 2, { state: 'making_something' }],
    [{ kind: 'approval' }, 0, { state: 'approval' }],
    [{ kind: 'waiting' }, 0, { state: 'waiting' }],
    [{ kind: 'limited' }, 0, { state: 'limited' }],
    [{ kind: 'syncing' }, 0, { state: 'syncing' }],
    [{ kind: 'unknown', label: '原生连接中' }, 0, { state: 'syncing' }],
    [{ kind: 'unknown', label: '原生连接已断开' }, 0, { state: 'offline' }],
    [{ kind: 'unknown', label: '服务器身份待核验' }, 0, { state: 'unknown' }],
    [{ kind: 'login' }, 0, { state: 'unknown' }],
    [{ kind: 'brand_new_kind' }, 0, { state: 'unknown' }],
    [null, 0, { state: 'unknown' }],
  ];
  for (const [view, subagents, expected] of cases) {
    const { reason, ...result } = toDeviceState(view, subagents);
    assert.deepEqual(result, expected, JSON.stringify(view));
    assert.ok(DEVICE_STATES.has(result.state));
    assert.equal(typeof reason, 'string');
  }
});

function fakeGateway() {
  const calls = [];
  let fail = false;
  const fetchImpl = async url => {
    calls.push(Object.fromEntries(new URL(url).searchParams));
    if (fail) throw new Error('connect ECONNREFUSED');
    return { ok: true, json: async () => ({ ws: 0, mqtt: 1 }) };
  };
  return { calls, fetchImpl, setFail: value => { fail = value; } };
}

test('pusher sends changes immediately, dedupes, and resyncs on schedule', async () => {
  let now = 1_000_000;
  const gw = fakeGateway();
  const pusher = new DevicePusher({ gatewayUrl: 'http://gw/', fetchImpl: gw.fetchImpl, now: () => now, resyncMs: 60_000 });
  await pusher.update({ state: 'working', subagents: 2 });
  await pusher.update({ state: 'working', subagents: 2 });
  assert.deepEqual(gw.calls, [{ state: 'working', subagents: '2' }]);
  now += 30_000; await pusher.tick();
  assert.equal(gw.calls.length, 1, 'no resync before the interval');
  now += 30_000; await pusher.tick();
  assert.equal(gw.calls.length, 2, 'resync after the interval');
  await pusher.update({ state: 'default' });
  assert.deepEqual(gw.calls.at(-1), { state: 'default' });
});

test('pusher retries after gateway failures without losing the latest state', async () => {
  const gw = fakeGateway();
  const pusher = new DevicePusher({ gatewayUrl: 'http://gw', fetchImpl: gw.fetchImpl, log: () => {} });
  gw.setFail(true);
  assert.equal(await pusher.update({ state: 'approval' }), false);
  assert.equal(pusher.snapshot().lastError, 'connect ECONNREFUSED');
  gw.setFail(false);
  assert.equal(await pusher.tick(), true);
  assert.deepEqual(gw.calls.at(-1), { state: 'approval' });
  assert.equal(pusher.snapshot().lastError, null);
});

test('detail line: elapsed working time, sub-tasks, next scheduled run', () => {
  const { detailFor } = require('../state-map.cjs');
  const now = Date.UTC(2026, 8, 30, 6, 0, 0);
  assert.equal(detailFor({ state: 'working' }, {}, { now, workingSince: now - 20_000 }), '刚开始');
  assert.equal(detailFor({ state: 'working', subagents: 2 }, {}, { now, workingSince: now - 3.5 * 60_000 }),
    '已 3 分钟 · 2 个子任务');
  assert.equal(detailFor({ state: 'default' }, { nextRunInSeconds: 3600 }, { now, timeZone: 'Asia/Shanghai' }),
    '下个任务 15:00');
  assert.equal(detailFor({ state: 'default' }, { nextRunInSeconds: 3 * 24 * 3600 }, { now }), '');
  assert.equal(detailFor({ state: 'approval' }, {}, { now }), '');
});

test('pusher treats a changed detail line as a new state', async () => {
  const gw = fakeGateway();
  const pusher = new DevicePusher({ gatewayUrl: 'http://gw', fetchImpl: gw.fetchImpl });
  await pusher.update({ state: 'working', detail: '刚开始' });
  await pusher.update({ state: 'working', detail: '已 1 分钟' });
  assert.deepEqual(gw.calls.map(c => c.detail), ['刚开始', '已 1 分钟']);
});
