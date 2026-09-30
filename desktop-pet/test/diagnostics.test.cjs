'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LoginDiagnostics, safeFailure } = require('../diagnostics.cjs');
const { Accounts } = require('../native/accounts.cjs');
const { AccountPairing } = require('../native/account-pairing.cjs');

test('report uses strict field/value allowlists and never serializes arbitrary errors or account data', () => {
  const secret = 'SECRET_COOKIE_TOKEN_VM_CHAT_PATH';
  const log = new LoginDiagnostics({ version: '0.2.1', electron: secret });
  log.record({ stage: secret, status: secret, code: `https://example.test/?token=${secret}`,
    httpStatus: secret, phase: secret, detection: secret, readiness: secret, policy: secret,
    browser: secret, browserVersion: secret, vmIdentityMatched: secret, cookie: secret, stack: secret });
  const report = log.report({ phase: secret, loginDetection: secret, cookieJar: secret,
    lastFailure: { stage: secret, code: secret, httpStatus: 403, cause: secret } });
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(report.account.lastFailure, { stage: 'account', code: 'unknown_error', httpStatus: 403 });
  assert.equal(report.runtime.appVersion, '0.2.1');
  assert.equal(report.runtime.electron, 'unknown');
  assert.deepEqual(safeFailure('cookies', new Error('muse_session_cookie_missing')),
    { stage: 'cookies', code: 'muse_session_cookie_missing' });
});

test('diagnostics are deduplicated, bounded, and reports are detached snapshots', () => {
  const log = new LoginDiagnostics();
  for (let i = 0; i < 900; i++) log.record({ stage: 'readiness', readiness: 'metadata_missing' });
  assert.equal(log.report().events.length, 1);
  for (let i = 0; i < 300; i++) log.record({ stage: i % 2 ? 'cookies' : 'metadata', status: 'passed' });
  const first = log.report();
  assert.equal(first.events.length, 150);
  first.events[0].stage = 'modified';
  assert.notEqual(log.report().events[0].stage, 'modified');
});

function fixture({ failAt, policy = 'disabled' } = {}) {
  const log = new LoginDiagnostics({ version: '0.2.1' });
  const failure = Object.assign(new Error(failAt === 'session' ? 'authorization_required' : 'request_timeout'),
    { httpStatus: 403, stack: 'PRIVATE_STACK', token: 'PRIVATE_TOKEN' });
  const action = (stage, value) => async () => { if (stage === failAt) throw failure; return value; };
  const pairing = new AccountPairing('unused', {
    diagnostic: value => log.record(value),
    makeAuth: () => ({ renewSession: action('session', { vmIdentityMatched: true, vmNameMatches: true, endpointMatches: true }),
      credentials: action('token', {}) }),
    makeClient: () => ({
      connect: async (_credentials, verify) => {
        if (failAt === 'gateway') throw failure;
        const key = Buffer.alloc(32, 1), nonce = Buffer.alloc(32, 2);
        await verify({ serverKey: key, clientNonce: nonce, payload: failAt === 'peer_identity' ? Buffer.from('bad')
          : Buffer.concat([Buffer.from([18, 68, 10, 32]), key, Buffer.from([18, 32]), nonce]) });
      }, request: action('ping', {}), close: () => {},
    }),
  });
  pairing.browser = {
    browser: { defaultBrowserContext: () => ({ cookies: action('cookies', [
      { name: 'hatch_sess', value: 'PRIVATE_COOKIE', domain: 'muse.ai', secure: true, path: '/' },
    ]) }) },
    evaluate: action('metadata', { target: { vmId: 'PRIVATE_VM', vmName: 'PRIVATE_VM', gatewayUrl: 'https://test.metaaivm.com/' },
      policyHints: { bootstrap_rolloutStatus: policy } }),
    stop: async () => {},
  };
  return { log, pairing };
}

test('each pairing failure records the precise stage without leaking candidate credentials', async () => {
  for (const stage of ['metadata', 'cookies', 'session', 'token', 'gateway', 'peer_identity', 'ping']) {
    const { pairing, log } = fixture({ failAt: stage });
    await assert.rejects(pairing.complete());
    assert.equal(pairing.lastFailure.stage, stage);
    const report = JSON.stringify(log.report());
    assert.equal(report.includes('PRIVATE_'), false);
    assert.equal(report.includes('metaaivm.com'), false);
    assert.ok(log.events.some(event => event.stage === stage && event.status === 'failed'));
    await pairing.stop();
  }
});

test('unsupported VM policy remains blocked before cookie import', async () => {
  const { pairing, log } = fixture({ policy: 'enabled' });
  await assert.rejects(pairing.complete(), /attestation_verifier_required/);
  assert.deepEqual(pairing.lastFailure, { stage: 'vm_policy', code: 'attestation_verifier_required' });
  assert.equal(log.events.some(event => event.stage === 'cookies'), false);
});

test('successful pairing records ping and a throwing diagnostic callback cannot break login', async () => {
  const { pairing, log } = fixture();
  await pairing.complete();
  assert.ok(log.events.some(event => event.stage === 'ping' && event.status === 'passed'));
  assert.equal(JSON.stringify(log.report()).includes('PRIVATE_'), false);
  pairing.diagnostic = () => { throw new Error('logger failed'); };
  await pairing.complete();
});

test('automatic failure survives account wrapper; successful retry clears last failure', async t => {
  const { pairing, log } = fixture({ failAt: 'session' });
  pairing.start = async () => {};
  pairing.readiness = async () => 'ready';
  let saves = 0;
  const accounts = new Accounts({ makePairing: () => pairing, diagnostic: value => log.record(value),
    vault: { save: () => saves++ }, makeSource: () => ({ start: async () => {}, stop: async () => {} }) });
  t.after(() => accounts.stop());
  await accounts.login(); await accounts.pollLogin();
  assert.deepEqual(accounts.lastFailure, { stage: 'session', code: 'authorization_required', httpStatus: 403 });
  assert.equal(accounts.loginDetection, 'verification_failed');
  assert.equal(accounts.loginWatch, null);
  assert.equal(saves, 0);
  assert.equal(JSON.stringify(log.report(accounts)).includes('PRIVATE_'), false);
  pairing.complete = async () => ({});
  await accounts.complete();
  assert.equal(accounts.lastFailure, null); assert.equal(saves, 1);
});

test('vault failure and stale cancelled attempt do not misattribute diagnostics', async t => {
  const { pairing } = fixture();
  pairing.start = async () => {};
  const accounts = new Accounts({ makePairing: () => pairing,
    vault: { save: () => { throw new Error('os_encryption_unavailable'); } }, makeSource: () => ({}) });
  t.after(() => accounts.stop());
  await accounts.login();
  await assert.rejects(accounts.complete(), /account_pairing_failed/);
  assert.deepEqual(accounts.lastFailure, { stage: 'vault_save', code: 'os_encryption_unavailable' });
  const { pairing: other } = fixture({ failAt: 'session' });
  other.active = false;
  await assert.rejects(other.complete());
  assert.equal(other.lastFailure, null);
});
