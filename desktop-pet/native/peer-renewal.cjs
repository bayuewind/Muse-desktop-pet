'use strict';
const { NativeGateway, pinnedStandardVerifier } = require('./gateway-client.cjs');
async function reauthenticateStandardPeer(vault, auth, candidateKeyHex, { makeClient = () => new NativeGateway(), current = () => true } = {}) {
  const original = vault.load(), policy = original.peerPolicy;
  if (original.authorization?.scope !== 'dedicated_muse_session_only' || !original.authorization.nativeRenewal ||
      original.policyHints?.bootstrap_rolloutStatus !== 'disabled' || policy?.vmType !== 'standard' ||
      policy.attestationTier !== 'off' || policy.binding !== 'standard-nonce-v1' ||
      policy.trustSource !== 'authenticated-vm-assignment+official-tls+noise-nonce-binding' ||
      !/^[a-f0-9]{64}$/.test(candidateKeyHex ?? '')) throw new Error('peer_reauthentication_not_allowed');
  const assignment = await auth.renewSession();
  if (!current() || !assignment.vmIdentityMatched || !assignment.vmNameMatches || !assignment.endpointMatches) throw new Error('assignment_unverified');
  const credentials = await auth.credentials({ force: true });
  if (!current() || credentials.vmId !== original.target.vmId) throw new Error('assignment_unverified');
  const candidate = { ...policy, serverKeyHex: candidateKeyHex };
  const client = makeClient();
  try {
    // A NEW authenticated connection must prove the SAME candidate key and a
    // NEW nonce, and then pass an application ping. A mismatch is never ignored.
    await client.connect(credentials, pinnedStandardVerifier(candidate));
    await client.request('connection.ping');
    if (!current()) throw new Error('pairing_cancelled');
    const latest = vault.load();
    if (latest.pairedAt !== original.pairedAt || latest.target.vmId !== original.target.vmId ||
        latest.peerPolicy?.serverKeyHex !== policy.serverKeyHex) throw new Error('pairing_changed');
    latest.peerPolicy = { ...candidate, reauthenticatedAt: Date.now(),
      reauthentication: 'fresh-official-assignment+fresh-token+second-noise-binding+application-ping' };
    delete latest.unverifiedPeerCandidate;
    vault.save(latest);
  } finally { client.close(); }
}
module.exports = { reauthenticateStandardPeer };
