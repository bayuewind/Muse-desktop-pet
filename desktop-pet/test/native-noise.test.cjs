'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NoiseXXInitiator, CipherState } = require('../native/noise-xx.cjs');
const hex = value => Buffer.from(value, 'hex');
// Public noise-c vector, Noise_XX_25519_AESGCM_SHA256:
// https://github.com/rweather/noise-c/blob/master/tests/vector/noise-c-basic.txt
test('Noise XX handshake and bidirectional transport match independent noise-c vector byte for byte', () => {
  const peer = new NoiseXXInitiator({ prologue: hex('50726f6c6f677565313233'),
    staticPrivate: hex('e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1'),
    ephemeralPrivate: hex('893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a') });
  assert.equal(peer.writeMessage1(hex('4c756477696720766f6e204d69736573')).toString('hex'),
    'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573');
  const response = peer.readMessage2(hex('95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843757117acceb05bd7a45733bc22015c97a9d0cbaf41b80446d5988ff5127235d78c9ea8b1c117179204c8a49f9a83a7f640d01e028ba793fc059f2724a83af08e993c1d87032f536390f1d612be65f7'));
  assert.equal(response.payload.toString('hex'), '4d757272617920526f746862617264');
  assert.equal(peer.writeMessage3(hex('462e20412e20486179656b')).toString('hex'),
    'c90f1cf77eba4e50edb038991565e36c9758943a989229b6051244dc4fbecb6928dadfe5492c3bf6aab568b11ddc6ebdcb6a328ececc9ce6ce84c336e421a792bc6eaca1d9d2c93636f8ff');
  const { send, receive, handshakeHash } = peer.split();
  assert.equal(handshakeHash.toString('hex'), 'b1fee4b75a0da34a3d1e338b093de8e46801eeafd1af0a7185b020cd27007ce4');
  assert.equal(receive.decrypt(hex('bc3fa77f6aca3e8466d7dc6bea10013e88a6a29add5132b461806c')).toString('hex'), '4361726c204d656e676572');
  assert.equal(send.encrypt(hex('4a65616e2d426170746973746520536179')).toString('hex'), '250b01074cdfe0df2ecf8ccbf1737b15a2ddb5b52fd9a396604e9c793cee3b3bb9');
  assert.equal(receive.decrypt(hex('449d4d433b3cdc3d02bf6fc881774b9df54366ebcffb9689bb13f14709822cd7ef42bcdb4d')).toString('hex'), '457567656e2042f6686d20766f6e2042617765726b');
});
test('tamper poisons cipher and invalid handshake ordering fails closed', () => {
  const cipher = new CipherState(Buffer.alloc(32, 4));
  assert.throws(() => cipher.decrypt(Buffer.alloc(16)), /authentication/);
  assert.throws(() => cipher.decrypt(Buffer.alloc(16)), /dead/);
  const peer = new NoiseXXInitiator(); assert.throws(() => peer.split(), /phase/);
  peer.writeMessage1(); assert.throws(() => peer.readMessage2(Buffer.alloc(40)), /message2/);
  assert.throws(() => peer.writeMessage3(), /phase/);
});
