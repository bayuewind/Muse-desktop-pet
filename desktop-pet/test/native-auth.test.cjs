'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialVault } = require('../native/vault.cjs');
const { NativeAuth, importDedicatedCookies } = require('../native/auth.cjs');
const target = { vmId: 'test-vm', vmName: 'test-vm', gatewayUrl: 'wss://test-vm.metaaivm.com/' };
const cookies = [
  { domain: '.muse.ai', name: 'hatch_sess', value: 'test-only-session', secure: true, httpOnly: true, path: '/', expires: -1 },
  { domain: '.other.example', name: 'hatch_sess', value: 'exclude-other-site', secure: true, path: '/' },
  { domain: '.muse.ai', name: 'analytics', value: 'exclude-tracker', secure: true, path: '/' },
];
function bundle() { return { version: 1, origin: 'https://muse.ai', target, cookieJar: importDedicatedCookies(cookies).jar.serializeSync() }; }
test('pairing imports only secure Muse session cookies', () => {
  const { jar, count } = importDedicatedCookies(cookies);
  assert.equal(count, 1); assert.equal(jar.getCookieStringSync('https://muse.ai/'), 'hatch_sess=test-only-session');
  assert.equal(jar.getCookieStringSync('https://other.example/'), '');
  assert.throws(() => importDedicatedCookies([{ ...cookies[0], secure: false }]), /missing/);
});
test('vault refuses unavailable encryption and writes only opaque data with mode 600', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-vault-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => new CredentialVault(directory, { isEncryptionAvailable: () => false }).save(bundle()), /unavailable/);
  // Mock verifies boundaries only; OS-backed cryptography is verified separately on Mac.
  let captured;
  const vault = new CredentialVault(directory, { isEncryptionAvailable: () => true,
    encryptString: value => { captured = value; return Buffer.from('opaque-test-ciphertext'); },
    decryptString: () => captured });
  vault.save(bundle()); assert.equal(vault.load().target.vmId, target.vmId);
  assert.equal(fs.statSync(vault.filename).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(vault.filename, 'utf8'), /test-only-session|exclude/);
});
test('native renewal pins the VM, updates cookie jar, and sends secrets only to allowed official endpoints', async () => {
  let data = bundle(); const requests = [];
  const auth = new NativeAuth({ load: () => data, save: value => { data = value; } }, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/session')) return new Response(JSON.stringify({ status: 'assigned', vm_id: 'test-vm', vm_state: 'RUNNING' }),
      { headers: { 'set-cookie': 'hatch_sess=test-renewed; Path=/; Secure; HttpOnly' } });
    return new Response(JSON.stringify({ token: 'opaque-test-token' }));
  } });
  await auth.renewSession(); const token = await auth.credentials();
  assert.equal(token.authToken, 'opaque-test-token');
  assert.equal(requests[1].options.headers.Cookie, 'hatch_sess=test-renewed');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.match(requests[0].options.headers['User-Agent'], /native status client/);
  assert.equal(requests[0].options.headers['Sec-Fetch-Site'], 'same-origin');
  assert.equal(requests.every(r => r.url.startsWith('https://muse.ai/api/')), true);
  await assert.rejects(auth.request('https://other.example/'), /not_allowed/);
});
test('session renewal preserves newer trust metadata and refuses a replaced login generation', () => {
  let data = { ...bundle(), pairedAt: 1 };
  const vault = { load: () => structuredClone(data), save: value => { data = structuredClone(value); } };
  const auth = new NativeAuth(vault);
  data.peerPolicy = { serverKeyHex: 'public-test-pin' };
  auth.persist(); assert.equal(data.peerPolicy.serverKeyHex, 'public-test-pin');
  data.pairedAt = 2;
  assert.throws(() => auth.persist(), /credentials_repaired/);
  assert.equal(data.pairedAt, 2);
});
test('native auth rejects redirects and VM assignment changes without requesting a token', async () => {
  for (const response of [new Response('', { status: 302 }), new Response(JSON.stringify({ status: 'assigned', vm_id: 'different' }))]) {
    const auth = new NativeAuth({ load: bundle }, { fetchImpl: async () => response });
    await assert.rejects(auth.renewSession(), /authorization_required|assignment_changed/);
  }
});
