'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts } = require('../native/accounts.cjs');
const { AccountPairing } = require('../native/account-pairing.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup(t, options = {}) {
  const calls = { probes: 0, verified: 0, saved: [], starts: 0, closes: 0 };
  const pairing = { active: true, start: async () => {},
    readiness: async () => { calls.probes++; return 'waiting'; },
    complete: async () => { calls.verified++; return { verifiedFixture: true }; },
    stop: async () => { calls.closes++; pairing.active = false; } };
  const vault = { save: value => calls.saved.push(value), clear: () => {}, finishClear: () => {},
    exists: () => false, isDisabled: () => false };
  const accounts = new Accounts({ vault, makePairing: () => pairing,
    makeSource: () => ({ start: async () => { calls.starts++; }, stop: async () => {}, clearAccountData: () => {} }), ...options });
  t.after(() => accounts.stop());
  return { accounts, pairing, calls };
}

test('timer detects login and completes once without any manual click', { timeout: 3000 }, async t => {
  const connected = deferred();
  const { accounts, pairing, calls } = setup(t, { loginPollMs: 10,
    changed: value => { if (value.phase === 'connected') connected.resolve(); } });
  pairing.readiness = async () => ++calls.probes === 1 ? 'waiting' : 'ready';
  await accounts.login(); assert.equal(accounts.loginDetection, 'watching');
  // Poll timers are deliberately unref'ed, so the test owns its timeout handle.
  let timer;
  try { await Promise.race([connected.promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('auto_connect_not_observed')), 1500);
  })]); } finally { clearTimeout(timer); }
  assert.equal(accounts.phase, 'connected'); assert.equal(accounts.loginWatch, null);
  assert.equal(calls.verified, 1); assert.equal(calls.saved.length, 1);
  assert.equal(calls.closes, 1); assert.equal(calls.starts, 1);
});

test('loading login pages only get local readiness probes; no credentials imported', async t => {
  const { accounts, calls } = setup(t);
  await accounts.login(); await accounts.pollLogin(); await accounts.pollLogin();
  assert.equal(calls.probes, 2); assert.equal(calls.verified, 0); assert.equal(calls.saved.length, 0);
  assert.equal(accounts.phase, 'awaiting_login');
});

test('polls never overlap; manual completion invalidates a pending automatic check', async t => {
  const { accounts, pairing, calls } = setup(t), ready = deferred();
  pairing.readiness = () => { calls.probes++; return ready.promise; };
  await accounts.login();
  const pending = accounts.pollLogin(); await tick();
  await accounts.pollLogin(); assert.equal(calls.probes, 1);
  await accounts.complete(); ready.resolve('ready'); await pending;
  assert.equal(calls.verified, 1); assert.equal(calls.saved.length, 1); assert.equal(calls.starts, 1);
});

test('automatic verification excludes simultaneous manual completion', async t => {
  const { accounts, pairing, calls } = setup(t), verified = deferred();
  pairing.readiness = async () => 'ready';
  pairing.complete = () => { calls.verified++; return verified.promise; };
  await accounts.login(); const pending = accounts.pollLogin(); await tick();
  assert.equal(accounts.phase, 'verifying_login');
  await assert.rejects(accounts.complete(), /login_not_ready/);
  verified.resolve({ verifiedFixture: true }); await pending;
  assert.equal(calls.verified, 1); assert.equal(calls.saved.length, 1);
});

test('logout/stop during readiness prevents late authorization or scheduling', async t => {
  for (const action of ['logout', 'stop']) {
    const { accounts, pairing, calls } = setup(t), ready = deferred();
    pairing.readiness = () => ready.promise;
    await accounts.login(); const pending = accounts.pollLogin(); await tick();
    await accounts[action](); ready.resolve('ready'); await pending;
    assert.equal(accounts.loginWatch, null); assert.equal(calls.verified, 0); assert.equal(calls.saved.length, 0);
  }
});

test('late result from previous login cannot complete a newer login', async t => {
  const { accounts, pairing, calls } = setup(t), oldReady = deferred();
  pairing.readiness = () => oldReady.promise;
  await accounts.login(); const oldWatch = accounts.loginWatch;
  const pending = accounts.pollLogin(); await tick(); await accounts.logout();
  const next = { ...pairing, active: true, readiness: async () => 'waiting', stop: async () => {} };
  accounts.makePairing = () => next; await accounts.login();
  oldReady.resolve('ready'); await pending; await accounts.pollLogin(oldWatch);
  assert.equal(accounts.pairing, next); assert.equal(accounts.loginDetection, 'watching');
  assert.equal(calls.verified, 0); assert.equal(calls.saved.length, 0);
});

test('cancel during automatic verification discards late bundle', async t => {
  const { accounts, pairing, calls } = setup(t), verified = deferred();
  pairing.readiness = async () => 'ready'; pairing.complete = () => verified.promise;
  await accounts.login(); const pending = accounts.pollLogin(); await tick();
  await accounts.logout(); verified.resolve({ mustNotPersist: true }); await pending;
  assert.equal(accounts.phase, 'signed_out'); assert.equal(calls.saved.length, 0); assert.equal(calls.starts, 0);
});

test('failed identity verification stops polling, remains unsigned, allows manual retry', async t => {
  const { accounts, pairing, calls } = setup(t);
  pairing.readiness = async () => 'ready';
  pairing.complete = async () => { calls.verified++; throw new Error('attestation_verifier_required'); };
  await accounts.login(); await accounts.pollLogin(); await accounts.pollLogin();
  assert.equal(accounts.phase, 'awaiting_login'); assert.equal(accounts.loginDetection, 'verification_failed');
  assert.equal(accounts.loginWatch, null); assert.equal(calls.verified, 1); assert.equal(calls.saved.length, 0);
  pairing.complete = async () => ({ verifiedFixture: true });
  await accounts.complete(); assert.equal(accounts.phase, 'connected'); assert.equal(calls.saved.length, 1);
});

test('closed window, deadline, and stuck probe stop detection with an explicit state', async t => {
  for (const outcome of ['window_closed', 'timed_out', 'check_failed']) {
    let now = 0;
    const { accounts, pairing, calls } = setup(t, { now: () => now, loginTimeoutMs: 1000, loginProbeTimeoutMs: 10 });
    pairing.readiness = outcome === 'check_failed' ? () => new Promise(() => {}) : async () => 'closed';
    await accounts.login();
    if (outcome === 'timed_out') now = 1000;
    await accounts.pollLogin();
    assert.equal(accounts.loginDetection, outcome); assert.equal(accounts.loginWatch, null);
    assert.equal(calls.verified, 0); assert.equal(calls.saved.length, 0);
  }
});

test('readiness checks only the owned Muse page metadata, never cookies or a gateway', async () => {
  let metadata = null, reads = 0;
  const pairing = new AccountPairing('unused-fixture-directory');
  pairing.browser = { browser: {}, page: { isClosed: () => false }, origin: 'https://muse.ai',
    loading: false, httpError: false, evaluate: async () => { reads++; return metadata; } };
  assert.equal(await pairing.readiness(), 'waiting');
  metadata = { target: { vmId: 'test', gatewayUrl: 'https://test.metaaivm.com/' }, policyHints: {} };
  assert.equal(await pairing.readiness(), 'waiting');
  metadata.policyHints.bootstrap_rolloutStatus = 'disabled';
  assert.equal(await pairing.readiness(), 'ready');
  metadata.policyHints.bootstrap_rolloutStatus = 'enabled';
  assert.equal(await pairing.readiness(), 'ready'); // complete() must still reject unsupported CVM.
  await assert.rejects(pairing.complete(), /attestation_verifier_required/);
  const before = reads;
  pairing.browser.origin = 'https://other.example'; assert.equal(await pairing.readiness(), 'waiting');
  pairing.browser.page.isClosed = () => true; assert.equal(await pairing.readiness(), 'closed');
  assert.equal(reads, before);
  pairing.active = false; await assert.rejects(pairing.readiness(), /pairing_cancelled/);
});
