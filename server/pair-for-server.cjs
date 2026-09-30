'use strict';
// One-time pairing for the server bridge. Run on the Mac (needs a desktop
// Chrome/Edge and the VPN):
//
//   cd desktop-pet && npm ci --omit=dev && cd ..
//   node server/pair-for-server.cjs --approved-session-export
//
// Opens a dedicated Chrome window with a fresh temporary profile; the user
// logs in to Muse themselves. The resulting session is independent from the
// desktop pet's own session (it never reads the desktop keychain vault). The
// verified credential envelope is encrypted with MUSE_VAULT_KEY into
// server/data/native-session.enc; the key lives in server/.env (0600). Cookie
// values and tokens are never printed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountPairing } = require('../desktop-pet/native/account-pairing.cjs');
const { CredentialVault } = require('../desktop-pet/native/vault.cjs');
const { createServerSafeStorage, generateVaultKey } = require('./server-safe-storage.cjs');

const SERVER_DIR = __dirname;
const DATA_DIR = path.join(SERVER_DIR, 'data');
const ENV_FILE = path.join(SERVER_DIR, '.env');
const POLL_MS = 2000;
const TIMEOUT_MS = 15 * 60 * 1000;

function loadOrCreateKey() {
  if (fs.existsSync(ENV_FILE)) {
    const match = fs.readFileSync(ENV_FILE, 'utf8').match(/^MUSE_VAULT_KEY=(.+)$/m);
    if (match) return { key: match[1].trim(), created: false };
  }
  const key = generateVaultKey();
  fs.writeFileSync(ENV_FILE, `MUSE_VAULT_KEY=${key}\n`, { mode: 0o600, flag: fs.existsSync(ENV_FILE) ? 'a' : 'wx' });
  fs.chmodSync(ENV_FILE, 0o600);
  return { key, created: true };
}

async function pair() {
  if (!process.argv.includes('--approved-session-export')) throw new Error('explicit_authorization_required');
  const { key, created } = loadOrCreateKey();
  const storage = createServerSafeStorage(key);
  const vault = new CredentialVault(DATA_DIR, storage);
  vault.ensureAvailable();
  if (vault.isDisabled()) vault.finishClear();
  console.log(JSON.stringify({ step: 'vault_key', created, file: path.relative(process.cwd(), ENV_FILE) }));

  // Temporary login profiles live outside the repository and are removed by stop().
  const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-server-pair-'));
  const pairing = new AccountPairing(profiles);
  try {
    await pairing.start();
    console.log(JSON.stringify({ step: 'login_window_opened', detail: 'log in to Muse in the dedicated Chrome window' }));
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const readiness = await pairing.readiness();
      if (readiness === 'ready') break;
      if (readiness === 'closed') throw new Error('login_window_closed');
      if (Date.now() > deadline) throw new Error('login_timeout');
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    const bundle = await pairing.complete();
    vault.save(bundle);
    const loaded = vault.load();
    console.log(JSON.stringify({ step: 'server_session_saved', vmMatched: loaded.target.vmId === bundle.target.vmId,
      peerPolicy: Boolean(loaded.peerPolicy), encryption: storage.getSelectedStorageBackend(),
      file: path.relative(process.cwd(), vault.filename) }));
  } finally {
    await pairing.stop().catch(() => {});
    fs.rmSync(profiles, { recursive: true, force: true });
  }
}

pair().then(() => process.exit(0)).catch(error => {
  // Error messages from the browser/HTTP layer may contain credentials: only
  // print known, credential-free codes.
  const known = new Set(['explicit_authorization_required', 'login_window_closed', 'login_timeout',
    'supported_browser_missing', 'attestation_verifier_required', 'assignment_unverified', 'muse_session_cookie_missing',
    'vm_identity_missing', 'invalid_gateway_target', 'authorization_required', 'auth_network_error',
    'auth_service_error', 'vm_assignment_changed', 'gateway_token_missing', 'handshake_failed', 'request_timeout',
    'vault_key_missing', 'vault_key_invalid', 'os_encryption_unavailable']);
  console.log(JSON.stringify({ step: 'pairing_failed', reason: known.has(error?.message) ? error.message : 'pairing_error' }));
  process.exit(1);
});
