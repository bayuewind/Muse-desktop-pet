'use strict';
// safeStorage-compatible encryption for headless servers, where Electron's OS
// keychain is unavailable. CredentialVault (desktop-pet/native/vault.cjs) only
// needs isEncryptionAvailable / encryptString / decryptString, so the vault
// file format, permission checks and atomic writes stay exactly as on desktop.
//
// AES-256-GCM, 32-byte key from MUSE_VAULT_KEY (base64). Ciphertext layout:
//   "SRV1" | 12-byte IV | 16-byte auth tag | encrypted UTF-8 plaintext
const crypto = require('node:crypto');

const PREFIX = Buffer.from('SRV1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(keyBase64) {
  if (typeof keyBase64 !== 'string' || !keyBase64.trim()) return { key: null, problem: 'vault_key_missing' };
  const key = Buffer.from(keyBase64.trim(), 'base64');
  if (key.length !== 32) return { key: null, problem: 'vault_key_invalid' };
  return { key, problem: null };
}

function createServerSafeStorage(keyBase64 = process.env.MUSE_VAULT_KEY) {
  const { key, problem } = parseKey(keyBase64);
  return {
    // Reported by the bridge so a misconfigured key is obvious in the logs.
    problem,
    isEncryptionAvailable: () => key !== null,
    getSelectedStorageBackend: () => (key ? 'server_aes_256_gcm' : 'basic_text'),
    encryptString(plaintext) {
      if (!key) throw new Error(problem);
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return Buffer.concat([PREFIX, iv, cipher.getAuthTag(), body]);
    },
    decryptString(buffer) {
      if (!key) throw new Error(problem);
      const data = Buffer.from(buffer);
      if (data.length < PREFIX.length + IV_BYTES + TAG_BYTES || !data.subarray(0, PREFIX.length).equals(PREFIX)) {
        throw new Error('invalid_ciphertext');
      }
      const iv = data.subarray(PREFIX.length, PREFIX.length + IV_BYTES);
      const tag = data.subarray(PREFIX.length + IV_BYTES, PREFIX.length + IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(PREFIX.length + IV_BYTES + TAG_BYTES)), decipher.final()])
        .toString('utf8');
    },
  };
}

function generateVaultKey() { return crypto.randomBytes(32).toString('base64'); }

module.exports = { createServerSafeStorage, generateVaultKey };
