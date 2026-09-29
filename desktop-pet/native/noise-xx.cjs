'use strict';
// Noise XX / X25519 / AES-256-GCM / SHA-256; only Node's crypto primitives.
// Conformance is checked against the independent noise-c reference vector.
const crypto = require('node:crypto');
const EMPTY = Buffer.alloc(0);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function hkdf2(key, input) {
  const temp = hmac(key, input);
  const first = hmac(temp, Buffer.from([1]));
  const second = hmac(temp, Buffer.concat([first, Buffer.from([2])]));
  temp.fill(0); return [first, second];
}
function keypair(rawPrivate) {
  const privateKey = rawPrivate
    ? crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), rawPrivate]), format: 'der', type: 'pkcs8' })
    : crypto.generateKeyPairSync('x25519').privateKey;
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey };
}
function dh(privateKey, publicBytes) {
  if (publicBytes.length !== 32) throw new Error('invalid_x25519_key');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), publicBytes]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  if (shared.every(byte => byte === 0)) throw new Error('invalid_x25519_shared_secret');
  return shared;
}
class CipherState {
  constructor(key = null) { this.key = key ? Buffer.from(key) : null; this.nonce = 0n; this.dead = false; }
  crypt(data, ad, decrypt) {
    if (this.dead) throw new Error('cipher_dead');
    if (!this.key) return Buffer.from(data);
    try {
      if (this.nonce >= BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('nonce_exhausted');
      const iv = Buffer.alloc(12); iv.writeBigUInt64BE(this.nonce++, 4);
      if (decrypt && data.length < 16) throw new Error('truncated_ciphertext');
      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', this.key, iv)
        : crypto.createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(ad);
      if (decrypt) cipher.setAuthTag(data.subarray(-16));
      const output = Buffer.concat([cipher.update(decrypt ? data.subarray(0, -16) : data), cipher.final()]);
      return decrypt ? output : Buffer.concat([output, cipher.getAuthTag()]);
    } catch { this.destroy(); throw new Error('cipher_authentication_failed'); }
  }
  encrypt(data, ad = EMPTY) { return this.crypt(data, ad, false); }
  decrypt(data, ad = EMPTY) { return this.crypt(data, ad, true); }
  destroy() { this.dead = true; this.key?.fill(0); }
}
class NoiseXXInitiator {
  constructor({ prologue = EMPTY, ephemeralPrivate, staticPrivate } = {}) {
    const name = Buffer.from('Noise_XX_25519_AESGCM_SHA256');
    this.h = Buffer.alloc(32); name.copy(this.h); this.ck = Buffer.from(this.h);
    this.cipher = new CipherState(); this.mixHash(prologue); this.phase = 0;
    this.ephemeralPrivate = ephemeralPrivate; this.staticPrivate = staticPrivate;
  }
  guard(phase) { if (this.phase !== phase) throw new Error('invalid_noise_phase'); }
  mixHash(data) { const old = this.h; this.h = hash(Buffer.concat([old, data])); old.fill(0); }
  mixKey(input) {
    const [ck, key] = hkdf2(this.ck, input); this.ck.fill(0); this.ck = ck;
    this.cipher.destroy(); this.cipher = new CipherState(key); key.fill(0); input.fill(0);
  }
  encryptAndHash(data) { const result = this.cipher.encrypt(data, this.h); this.mixHash(result); return result; }
  decryptAndHash(data) { const result = this.cipher.decrypt(data, this.h); this.mixHash(data); return result; }
  writeMessage1(payload = EMPTY) {
    this.guard(0);
    try {
      this.e = keypair(this.ephemeralPrivate); this.mixHash(this.e.publicKey);
      const result = Buffer.concat([this.e.publicKey, this.encryptAndHash(payload)]);
      this.phase = 1; return result;
    } catch (error) { this.destroy(); throw error; }
  }
  readMessage2(message) {
    this.guard(1);
    try {
      if (message.length < 96 || message.length > 65535) throw new Error('invalid_noise_message2');
      this.re = Buffer.from(message.subarray(0, 32)); this.mixHash(this.re);
      this.mixKey(dh(this.e.privateKey, this.re));
      this.rs = this.decryptAndHash(message.subarray(32, 80));
      this.mixKey(dh(this.e.privateKey, this.rs));
      const payload = this.decryptAndHash(message.subarray(80));
      this.phase = 2; return { payload, serverKey: Buffer.from(this.rs), handshakeHash: Buffer.from(this.h) };
    } catch (error) { this.destroy(); throw error; }
  }
  writeMessage3(payload = EMPTY) {
    this.guard(2);
    try {
      this.s = keypair(this.staticPrivate);
      const first = this.encryptAndHash(this.s.publicKey);
      this.mixKey(dh(this.s.privateKey, this.re));
      const result = Buffer.concat([first, this.encryptAndHash(payload)]);
      this.phase = 3; return result;
    } catch (error) { this.destroy(); throw error; }
  }
  split() {
    this.guard(3);
    const [tx, rx] = hkdf2(this.ck, EMPTY);
    const result = { send: new CipherState(tx), receive: new CipherState(rx), handshakeHash: Buffer.from(this.h) };
    tx.fill(0); rx.fill(0); this.destroy(); return result;
  }
  destroy() {
    this.phase = -1; this.cipher.destroy(); this.ck.fill(0); this.h.fill(0);
    this.e = null; this.s = null; this.rs?.fill(0); this.re?.fill(0);
    this.ephemeralPrivate = null; this.staticPrivate = null;
  }
}
module.exports = { NoiseXXInitiator, CipherState };
