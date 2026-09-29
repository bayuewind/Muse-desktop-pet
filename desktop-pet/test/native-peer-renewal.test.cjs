'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reauthenticateStandardPeer } = require('../native/peer-renewal.cjs');
function setup() {
  let bundle = { pairedAt: 1, target: { vmId: 'test' }, authorization: { scope: 'dedicated_muse_session_only', nativeRenewal: true },
    policyHints: { bootstrap_rolloutStatus: 'disabled' }, peerPolicy: { serverKeyHex: '11'.repeat(32), vmType: 'standard',
      attestationTier: 'off', binding: 'standard-nonce-v1', trustSource: 'authenticated-vm-assignment+official-tls+noise-nonce-binding' } };
  const calls = [];
  const vault = { load: () => structuredClone(bundle), save: value => { calls.push('save'); bundle = structuredClone(value); } };
  const auth = { renewSession: async () => { calls.push('assignment'); return { vmIdentityMatched: true, vmNameMatches: true, endpointMatches: true }; },
    credentials: async options => { assert.equal(options.force, true); calls.push('token'); return { vmId: 'test' }; } };
  const makeClient = () => ({ connect: async (_credentials, verify) => {
    calls.push('second_handshake'); const key = Buffer.alloc(32, 34), nonce = Buffer.alloc(32, 33);
    await verify({ serverKey: key, clientNonce: nonce, payload: Buffer.concat([Buffer.from([18,68,10,32]),key,Buffer.from([18,32]),nonce]) });
  }, request: async method => { assert.equal(method, 'connection.ping'); calls.push('ping'); }, close: () => calls.push('close') });
  return { vault, auth, makeClient, calls };
}
test('standard VM key changes require fresh identity, token, second handshake and ping before saving', async () => {
  const f = setup(); await reauthenticateStandardPeer(f.vault, f.auth, '22'.repeat(32), { makeClient: f.makeClient });
  assert.deepEqual(f.calls, ['assignment','token','second_handshake','ping','save','close']);
  assert.equal(f.vault.load().peerPolicy.serverKeyHex, '22'.repeat(32));
});
test('different VM, mismatched candidate and confidential policies cannot rotate a pin', async () => {
  const wrongVm = setup(); wrongVm.auth.renewSession = async () => ({ vmIdentityMatched: false });
  await assert.rejects(reauthenticateStandardPeer(wrongVm.vault, wrongVm.auth, '22'.repeat(32), { makeClient: wrongVm.makeClient }));
  assert.equal(wrongVm.calls.includes('save'), false);
  const wrongKey = setup();
  await assert.rejects(reauthenticateStandardPeer(wrongKey.vault, wrongKey.auth, '33'.repeat(32), { makeClient: wrongKey.makeClient }), /identity/);
  assert.equal(wrongKey.calls.includes('save'), false);
  const confidential = setup(); const value = confidential.vault.load(); value.peerPolicy.vmType = 'confidential'; confidential.vault.save(value); confidential.calls.length = 0;
  await assert.rejects(reauthenticateStandardPeer(confidential.vault, confidential.auth, '22'.repeat(32), { makeClient: confidential.makeClient }), /not_allowed/);
  assert.deepEqual(confidential.calls, []);
});
