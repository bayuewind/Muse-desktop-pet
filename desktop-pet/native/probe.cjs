'use strict';
// Read-only protocol diagnostics. Does not import or start a browser.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const { CredentialVault } = require('./vault.cjs');
const { NativeAuth } = require('./auth.cjs');
const { NativeGateway } = require('./gateway-client.cjs');
const crypto = require('node:crypto');
app.setName('Muse 桌宠');
const directory = path.join(app.getPath('appData'), 'MuseDesktopPet');
app.setPath('userData', directory);
let client;
async function run() {
  const vault = new CredentialVault(directory, safeStorage);
  const auth = new NativeAuth(vault);
  if (process.argv.includes('--vault-only')) {
    const policy = auth.bundle.peerPolicy;
    console.log(JSON.stringify({ step: 'vault_policy_check', policyPresent: Boolean(policy),
      vmType: policy?.vmType, tier: policy?.attestationTier, binding: policy?.binding,
      fingerprint: policy?.serverKeyHex ? crypto.createHash('sha256').update(Buffer.from(policy.serverKeyHex, 'hex')).digest('base64') : null }));
    return;
  }
  console.log(JSON.stringify({ step: 'vault_loaded', cookieNames: auth.jar.getCookiesSync('https://muse.ai/').map(c => c.key) }));
  console.log(JSON.stringify({ step: 'native_renewal', ...await auth.renewSession() }));
  const gatewayCookie = auth.jar.getCookiesSync('https://muse.ai/').find(c => c.key === 'hatch_gw');
  let cookieShape = 'opaque', cookieKeys = [];
  if (gatewayCookie) {
    for (const [format, decode] of [
      ['json', s => JSON.parse(decodeURIComponent(s))],
      ['jwt', s => JSON.parse(Buffer.from(s.split('.')[1], 'base64url').toString())],
      ['base64json', s => JSON.parse(Buffer.from(s, 'base64url').toString())],
    ]) { try { const value = decode(gatewayCookie.value); cookieKeys = Object.keys(value); cookieShape = format; break; } catch {} }
  }
  console.log(JSON.stringify({ step: 'gateway_credential_shape', format: cookieShape, fields: cookieKeys }));
  const credentials = await auth.credentials();
  console.log(JSON.stringify({ step: 'native_token', acquired: true, hasNotary: Boolean(credentials.notaryToken),
    expiresInSeconds: Math.floor((credentials.expiresAt-Date.now())/1000) }));
  client = new NativeGateway();
  // Deliberately stop after decrypting Message 2: an observed key is NOT an
  // approved pin, and no attestation requirement is silently disabled.
  await client.connect(credentials, async peer => {
    const Reader = require('protobufjs').Reader;
    const fields = [];
    try {
      const reader = Reader.create(peer.payload);
      while (reader.pos < reader.len && fields.length < 20) {
        const tag = reader.uint32(), field = tag >>> 3, wire = tag & 7;
        if (wire === 2) fields.push({ field, wire, byteLength: reader.bytes().length });
        else if (wire === 0) { const value = reader.uint32(); fields.push({ field, wire, smallValue: value < 1000 ? value : 'large' }); }
        else { reader.skipType(wire); fields.push({ field, wire }); }
      }
    } catch {}
    let jsonKeys = null;
    try { const value = JSON.parse(peer.payload.toString()); if (value && typeof value === 'object') jsonKeys = Object.keys(value); } catch {}
    const bundle = vault.load();
    const nestedFields = [];
    try {
      const outer = Reader.create(peer.payload); const tag = outer.uint32();
      if ((tag & 7) === 2) {
        const nested = Reader.create(outer.bytes());
        while (nested.pos < nested.len && nestedFields.length < 12) {
          const innerTag = nested.uint32();
          if ((innerTag & 7) !== 2) { nested.skipType(innerTag & 7); continue; }
          const value = Buffer.from(nested.bytes());
          nestedFields.push({ field: innerTag >>> 3, length: value.length,
            equalsServerKey: value.equals(peer.serverKey), equalsClientNonce: value.equals(peer.clientNonce) });
        }
      }
    } catch {}
    bundle.unverifiedPeerCandidate = { serverKeyHex: peer.serverKey.toString('hex'),
      message2Base64: peer.payload.toString('base64'), clientNonceBase64: peer.clientNonce.toString('base64'), observedAt: Date.now(), trusted: false };
    vault.save(bundle);
    console.log(JSON.stringify({ step: 'native_noise_message2', payloadBytes: peer.payload.length,
      serverFingerprint: crypto.createHash('sha256').update(peer.serverKey).digest('base64'),
      fields, nestedFields, jsonKeys, identityVerified: false }));
    return false;
  });
}
app.whenReady().then(run).then(() => app.exit(0)).catch(error => {
  const known = new Set(['authorization_required','auth_network_error','auth_service_error','vm_assignment_changed',
    'vm_identity_unverified','vm_assignment_unavailable','handshake_failed','credential_decryption_failed','os_encryption_unavailable']);
  console.log(JSON.stringify({ step: 'probe_stopped', reason: known.has(error.message) ? error.message : 'native_probe_failed',
    httpStatus: error.httpStatus, category: error.category,
    responseType: error.responseType, responseKeys: error.responseKeys, serviceCode: error.serviceCode }));
  client?.close(); app.exit(1);
});
app.on('window-all-closed', () => {});
