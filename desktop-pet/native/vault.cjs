'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAGIC = Buffer.from('MUSE-NATIVE-VAULT-V1\n');
class CredentialVault {
  constructor(directory, safeStorage) {
    this.directory = directory; this.storage = safeStorage;
    this.filename = path.join(directory, 'native-session.enc');
  }
  ensureAvailable() {
    if (!this.storage.isEncryptionAvailable()) throw new Error('os_encryption_unavailable');
    if (this.storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('os_encryption_unavailable');
  }
  save(bundle) {
    this.ensureAvailable();
    if (bundle?.version !== 1 || bundle.origin !== 'https://muse.ai' || !bundle.cookieJar || !bundle.target) throw new Error('invalid_credential_envelope');
    const plaintext = JSON.stringify(bundle);
    if (Buffer.byteLength(plaintext) > 1024 * 1024) throw new Error('credential_envelope_limit');
    let ciphertext;
    try { ciphertext = this.storage.encryptString(plaintext); }
    catch { throw new Error('credential_encryption_failed'); }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.filename) && fs.lstatSync(this.filename).isSymbolicLink()) throw new Error('unsafe_vault_path');
    const temp = path.join(this.directory, `.native-session-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, Buffer.concat([MAGIC, ciphertext])); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined; fs.renameSync(temp, this.filename);
    } finally {
      if (fd != null) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      ciphertext.fill(0);
    }
  }
  load() {
    this.ensureAvailable();
    if (!fs.existsSync(this.filename)) throw new Error('authorization_required');
    const stat = fs.lstatSync(this.filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error('unsafe_vault_file');
    const bytes = fs.readFileSync(this.filename);
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid_vault_format');
    try {
      const bundle = JSON.parse(this.storage.decryptString(bytes.subarray(MAGIC.length)));
      if (bundle?.version !== 1 || bundle.origin !== 'https://muse.ai' || !bundle.cookieJar || !bundle.target) throw new Error('invalid');
      return bundle;
    } catch { throw new Error('credential_decryption_failed'); }
    finally { bytes.fill(0); }
  }
}
module.exports = { CredentialVault };
