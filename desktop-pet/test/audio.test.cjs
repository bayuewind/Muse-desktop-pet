'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { toDictationPCM, DictationDecoder } = require('../native/audio.cjs');
const { NoiseWire, ChunkAssembler, decode } = require('../native/wire.cjs');
const { CipherState } = require('../native/noise-xx.cjs');
test('audio resampling produces mono 24k signed little-endian PCM and wipes the transferred float buffer', () => {
  const samples = new Float32Array(48000/2).fill(0.5);
  const pcm = toDictationPCM({ sampleRate: 48000, samples: samples.buffer });
  assert.equal(pcm.length, 24000); assert.equal(pcm.readInt16LE(0), 16383);
  assert.equal(samples.every(value => value === 0), true);
  assert.throws(() => toDictationPCM({ sampleRate: 1, samples: new ArrayBuffer(4) }), /invalid/);
  const bad = new Float32Array(24000); bad[0] = NaN;
  assert.throws(() => toDictationPCM({ sampleRate: 24000, samples: bad.buffer }), /invalid/);
});
test('dictation parses split UTF-8 but does not accept partial transcripts as final', () => {
  const transcripts = [], decoder = new DictationDecoder(text => transcripts.push(text));
  decoder.push([]);
  const bytes = Buffer.from('{"type":"partial","text":"测试"}\n{"type":"final","text":"本地测试"}\n');
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(transcripts, ['本地测试']);
  assert.throws(() => new DictationDecoder(() => {}).push(Buffer.from('{"type":"partial","text":"x"}\n'), true), /missing_final/);
});
test('voice uses the inspected PCM streaming route, not JSON or a chat task', () => {
  const key = randomBytes(32), wire = new NoiseWire(new CipherState(key), new CipherState(randomBytes(32)));
  const receiver = new CipherState(key), assembler = new ChunkAssembler();
  const request = wire.startDictation();
  const unpack = frames => decode('Frame', decode('ServiceRequest', assembler.accept(receiver.decrypt(frames[0]))).payload);
  const frame = unpack(request.frames);
  assert.equal(frame.request.path, '/api/voice/dictation?sample_rate_hz=24000'); assert.equal(frame.request.endBody, false);
  const audio = unpack(wire.bodyChunk(request.streamId, Buffer.from([0, 1, 2, 3])));
  assert.deepEqual(Buffer.from(audio.bodyChunk.data), Buffer.from([0, 1, 2, 3]));
  const finish = unpack(wire.bodyChunk(request.streamId, Buffer.alloc(0), true)); assert.equal(finish.bodyChunk.endBody, true);
});
