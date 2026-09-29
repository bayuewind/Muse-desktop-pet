'use strict';
// Completes the explicitly approved native pairing over the official TLS origin.
// This process imports NO browser module and opens NO Muse webpage.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const { CredentialVault } = require('./vault.cjs');
const { NativeAuth } = require('./auth.cjs');
const { NativeGateway, pinnedStandardVerifier, verifyStandardBinding } = require('./gateway-client.cjs');
app.setName('Muse 桌宠');
const directory = path.join(app.getPath('appData'), 'MuseDesktopPet');
app.setPath('userData', directory);
let client;
function shape(value, depth = 0) {
  if (Array.isArray(value)) return { type: 'array', length: value.length, first: depth < 3 && value.length ? shape(value[0], depth + 1) : undefined };
  if (value && typeof value === 'object') return depth < 4 ? Object.fromEntries(Object.entries(value).slice(0, 35).map(([key, v]) => [key, shape(v, depth + 1)])) : 'object';
  return value === null ? 'null' : typeof value;
}
async function run() {
  if (!process.argv.includes('--approved-session-export')) throw new Error('explicit_authorization_required');
  const vault = new CredentialVault(directory, safeStorage), auth = new NativeAuth(vault);
  const assignment = await auth.renewSession();
  if (!assignment.vmIdentityMatched || !assignment.vmNameMatches || !assignment.endpointMatches) throw new Error('assignment_unverified');
  const credentials = await auth.credentials();
  let bundle = vault.load();
  if (bundle.authorization?.scope !== 'dedicated_muse_session_only' || bundle.authorization.nativeRenewal !== true) throw new Error('explicit_authorization_required');
  client = new NativeGateway();
  client.on('diagnostic', value => console.log(JSON.stringify(value)));
  client.on('status-event', (event, payload) => {
    const safeCode = ['online','working','responding','composing','making_something','waiting_for_subagents','compacting','needs_approval','waiting_for_user','out_of_credits'].includes(payload?.activity_code) ? payload.activity_code : undefined;
    console.log(JSON.stringify({ step: 'native_event', event, activityCode: safeCode, fields: Object.keys(payload ?? {}).slice(0, 25) }));
  });
  await client.connect(credentials, async peer => {
    if (bundle.peerPolicy) return pinnedStandardVerifier(bundle.peerPolicy)(peer);
    if (bundle.policyHints?.bootstrap_rolloutStatus !== 'disabled') throw new Error('attestation_verifier_required');
    verifyStandardBinding(peer.payload, peer.serverKey, peer.clientNonce);
    // Initial trust is anchored by the authenticated, VM-matched /api/session
    // result and the fixed official WSS/TLS endpoint, NOT an arbitrary host or
    // an unauthenticated key. Future connections must match this exact pin.
    bundle = vault.load();
    bundle.peerPolicy = { vmType: 'standard', attestationTier: 'off', binding: 'standard-nonce-v1',
      serverKeyHex: peer.serverKey.toString('hex'),
      trustSource: 'authenticated-vm-assignment+official-tls+noise-nonce-binding', pairedAt: Date.now() };
    delete bundle.unverifiedPeerCandidate;
    vault.save(bundle);
    console.log(JSON.stringify({ step: 'standard_peer_paired', nonceVerified: true, vmMatched: true, pinSaved: true }));
    return true;
  });
  console.log(JSON.stringify({ step: 'native_noise_connected', browserUsed: false }));
  const ping = await client.request('connection.ping');
  console.log(JSON.stringify({ step: 'native_ping', resultShape: shape(ping) }));
  for (const method of ['subagents.list','tasks.runs','tasks.list']) {
    try {
      const result = await client.request(method);
      console.log(JSON.stringify({ step: 'native_read', method, resultShape: shape(result) }));
      const rows = result?.runs ?? result?.subagents;
      if (Array.isArray(rows)) console.log(JSON.stringify({ step: 'native_status_counts', method,
        counts: rows.reduce((out, row) => { const key = typeof row.status === 'string' && /^[a-zA-Z_ -]{1,40}$/.test(row.status) ? row.status : 'other'; out[key] = (out[key] ?? 0) + 1; return out; }, {}) }));
    } catch (error) {
      console.log(JSON.stringify({ step: 'native_read_unavailable', method, httpStatus: error.httpStatus, requiredFields: error.requiredFields }));
      if (client.closed) throw error;
    }
  }
  for (const method of ['chat.subscribe','activity.subscribe','tasks.subscribe']) {
    try {
      const ack = await client.request(method);
      console.log(JSON.stringify({ step: 'native_subscribed', method, ackShape: shape(ack) }));
    } catch (error) {
      console.log(JSON.stringify({ step: 'native_subscription_unavailable', method, httpStatus: error.httpStatus }));
      if (client.closed) throw error;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 15000));
  await client.request('connection.ping');
  console.log(JSON.stringify({ step: 'native_post_subscription_ping', ok: true }));
  client.close();
}
app.whenReady().then(run).then(() => app.exit(0)).catch(error => {
  const known = new Set(['assignment_unverified','explicit_authorization_required','authorization_required','auth_network_error',
    'server_identity_mismatch','attestation_verifier_required','handshake_failed','request_timeout','subscription_ended',
    'rpc_rejected','gateway_protocol_error','gateway_closed']);
  console.log(JSON.stringify({ step: 'native_pair_stopped', reason: known.has(error.message) ? error.message : 'native_pair_failed', httpStatus: error.httpStatus, method: error.method }));
  client?.close(); app.exit(1);
});
app.on('window-all-closed', () => {});
