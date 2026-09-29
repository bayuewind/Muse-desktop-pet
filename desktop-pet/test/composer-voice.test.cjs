'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
class Element extends EventTarget {
  constructor() { super(); this.dataset = {}; this.value = ''; this.textContent = ''; this.hidden = true; }
  setAttribute() {}
  focus() {}
}
function fixture() {
  const elements = new Map();
  const document = new EventTarget();
  document.body = { dataset: { view: 'chat' } };
  document.hasFocus = () => true;
  document.querySelector = selector => {
    if (selector === 'dialog[open]') return null;
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  let cancelled = 0, hidden;
  const api = {
    state: async () => ({ mode: 'native', kind: 'idle' }), onState() {}, onFocus() {},
    onHidden(fn) { hidden = fn; }, cancelVoice() { cancelled++; },
    microphone: async () => ({ allowed: true, id: 'synthetic' }),
    transcribe: async () => ({ status: 'transcribed', text: 'Synthetic transcript' }),
  };
  const window = new EventTarget();
  window.composer = api;
  const context = vm.createContext({ window, document, navigator: { userAgent: 'Windows' },
    crypto: { randomUUID }, Event, setTimeout, clearTimeout, setInterval, clearInterval });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(__dirname, '../composer.js'), 'utf8'));
  const get = selector => document.querySelector(selector);
  return { context, run, api, get, cancelled: () => cancelled, hidden: () => hidden() };
}
test('transcribing exposes cancellation and does not overwrite a draft after a late response', async () => {
  const f = fixture(); await Promise.resolve();
  f.get('#draft').value = 'Existing draft';
  let finish, stopped = 0, sentSamples;
  f.api.transcribe = audio => { sentSamples = audio.samples; return new Promise(resolve => { finish = resolve; }); };
  f.context.captureFixture = {
    chunks: [new Float32Array(2400).fill(0.4)], timer: null, permissionId: 'synthetic',
    stream: { getTracks: () => [{ stop() { stopped++; } }] },
    source: { disconnect() {} }, context: { sampleRate: 24000, close: async () => {} },
    node: { disconnect() {}, port: { postMessage() { f.context.captureFixture.flushed(); }, close() {} } },
  };
  const result = f.run('recording = captureFixture; stopRecording(true)');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1); assert.equal(f.get('#recording').hidden, false);
  assert.equal(f.get('#recording-label').textContent, '正在转写');
  f.get('#cancel-recording').dispatchEvent(new Event('click'));
  assert.equal(f.cancelled(), 1); assert.equal(f.get('#recording').hidden, true);
  assert.match(f.get('#feedback').textContent, /无法撤回/);
  finish({ status: 'transcribed', text: 'Late transcript' }); await result;
  assert.equal(f.get('#draft').value, 'Existing draft');
  assert.equal(new Float32Array(sentSamples).every(value => value === 0), true);
});
test('old permission completion cannot clear a newer microphone request', async () => {
  const f = fixture(); await Promise.resolve();
  const pending = [];
  f.api.microphone = () => new Promise(resolve => pending.push(resolve));
  const first = f.run('beginRecording()');
  f.run('cancelAudio()');
  const second = f.run('beginRecording()');
  pending[0]({ allowed: false }); await first;
  assert.equal(f.run('requestingMic'), true);
  assert.equal(f.get('#recording').hidden, false);
  f.run('cancelAudio()'); pending[1]({ allowed: false }); await second;
  assert.equal(f.run('requestingMic'), false);
});
test('hidden callback cancels locally without echoing IPC and busy approval disables send', async () => {
  const f = fixture(); await Promise.resolve();
  f.hidden(); assert.equal(f.cancelled(), 0);
  f.get('#draft').value = 'Synthetic draft';
  f.run('render({mode:"native",kind:"working",requiresApproval:true})');
  assert.equal(f.get('#send').disabled, true);
  f.run('render({mode:"native",kind:"working",limited:true})');
  assert.equal(f.get('#send').disabled, true);
  f.run('render({mode:"native",kind:"working"})');
  assert.equal(f.get('#send').disabled, false);
});
