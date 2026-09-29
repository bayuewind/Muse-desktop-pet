'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeSource } = require('../native/source.cjs');
const { NativeAuth, importDedicatedCookies } = require('../native/auth.cjs');
const { NativeGateway } = require('../native/gateway-client.cjs');
function vault() {
  const jar = importDedicatedCookies([{ name: 'hatch_sess', value: 'test-only', domain: 'muse.ai', path: '/', secure: true }]).jar;
  return { load: () => ({ version: 1, origin: 'https://muse.ai', target: { vmId: 'test', gatewayUrl: 'wss://test.metaaivm.com/' },
    peerPolicy: { vmType: 'standard', attestationTier: 'off', serverKeyHex: '0'.repeat(64) }, cookieJar: jar.serializeSync() }) };
}
test('cancelling during credential wait prevents audio connection/upload and does not clear a newer operation', async t => {
  const original = NativeAuth.prototype.credentials, pending = [];
  NativeAuth.prototype.credentials = () => new Promise(resolve => pending.push(resolve));
  t.after(() => { NativeAuth.prototype.credentials = original; });
  const source = new NativeSource(vault()); source.running = true; source.client = { ready: true };
  const audio = () => ({ samples: new Float32Array(24000).buffer, sampleRate: 24000 });
  const first = source.transcribeAudio(audio()); assert.equal(pending.length, 1);
  source.cancelDictation(); const second = source.transcribeAudio(audio()); assert.equal(pending.length, 2);
  pending[0]({}); assert.equal((await first).reason, 'cancelled'); assert.equal(source.voiceInProgress, true);
  assert.equal(source.voiceClient, null);
  source.cancelDictation(); pending[1]({}); assert.equal((await second).reason, 'cancelled');
  assert.equal(source.voiceInProgress, false); assert.equal(source.voiceClient, null);
});
test('late successful dictation cannot escape cancellation and its owned bytes are wiped', async t => {
  const original = { credentials: NativeAuth.prototype.credentials, connect: NativeGateway.prototype.connect,
    transcribe: NativeGateway.prototype.transcribePCM };
  let finish, uploaded;
  NativeAuth.prototype.credentials = async () => ({});
  NativeGateway.prototype.connect = async () => {};
  NativeGateway.prototype.transcribePCM = function (pcm) {
    uploaded = pcm; return new Promise(resolve => { finish = resolve; });
  };
  t.after(() => {
    NativeAuth.prototype.credentials = original.credentials;
    NativeGateway.prototype.connect = original.connect;
    NativeGateway.prototype.transcribePCM = original.transcribe;
  });
  const source = new NativeSource(vault()); source.running = true; source.client = { ready: true };
  const samples = new Float32Array(24000).fill(0.2);
  const result = source.transcribeAudio({ samples: samples.buffer, sampleRate: 24000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  source.cancelDictation(); finish('Synthetic late transcript');
  assert.equal((await result).reason, 'cancelled');
  assert.equal(uploaded.every(value => value === 0), true);
  assert.equal(samples.every(value => value === 0), true);
});
