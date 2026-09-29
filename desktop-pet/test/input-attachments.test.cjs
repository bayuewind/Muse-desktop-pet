'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InputAttachments } = require('../input-attachments.cjs');
const { MAX_BYTES, attachmentItems, validateChatPayload } = require('../native/chat-input.cjs');
const { OutgoingTasks } = require('../native/outgoing.cjs');
const { NativeGateway } = require('../native/gateway-client.cjs');
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1EAAAAASUVORK5CYII=', 'base64');
test('staged attachments are copied, bounded, and expose opaque IDs not local paths', () => {
  const input = new InputAttachments(), original = Buffer.from('Synthetic file');
  const file = input.stage('notes.md', original); original.fill(0);
  assert.equal(input.resolve([file.id])[0].bytes.toString(), 'Synthetic file');
  assert.equal(input.list()[0].name, 'notes.md');
  assert.deepEqual(Object.keys(input.list()[0]).sort(), ['id','kind','mime','name','size']);
  assert.throws(() => input.resolve([file.id, file.id]), /invalid_attachment_selection/);
  assert.throws(() => input.resolve(['unregistered']), /expired/);
  assert.equal(input.preview(file.id), null);
});
test('attachment removal and account reset wipe owned byte buffers', () => {
  const input = new InputAttachments(), a = input.stage('a.txt', Buffer.from('a')), b = input.stage('b.png', png());
  const references = input.resolve([a.id, b.id]);
  const preview = input.preview(b.id); preview.bytes.fill(0);
  assert.ok(references[1].bytes.some(byte => byte !== 0));
  input.remove(a.id); assert.ok(references[0].bytes.every(byte => byte === 0));
  input.clear(); assert.ok(references[1].bytes.every(byte => byte === 0));
  assert.equal(input.bytes, 0); assert.deepEqual(input.list(), []);
});
test('attachment checks reject traversal, disguised images, executables and oversized data', () => {
  const input = new InputAttachments();
  for (const name of ['../a.txt', 'C:\\secret.txt', '\u202efake.png', 'payload.exe'])
    assert.throws(() => input.stage(name, Buffer.from('payload')));
  assert.throws(() => input.stage('fake.png', Buffer.from('<script>alert(1)</script>')), /image_invalid/);
  assert.throws(() => input.stage('empty.txt', Buffer.alloc(0)), /capacity/);
  assert.throws(() => input.stage('huge.txt', Buffer.alloc(MAX_BYTES + 1)), /capacity/);
  for (let i = 0; i < 4; i++) input.stage(`${i}.txt`, Buffer.from('a'));
  assert.throws(() => input.stage('fifth.txt', Buffer.from('a')), /capacity/);
});
test('selected local file reads are bounded and only retained in memory', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-input-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic.txt'); fs.writeFileSync(file, 'Synthetic fixture');
  const input = new InputAttachments(); await input.selectFile(file);
  assert.equal(input.list()[0].name, 'synthetic.txt');
  await assert.rejects(input.selectFile(directory), /size_limit/);
  assert.deepEqual(fs.readdirSync(directory), ['synthetic.txt']);
  input.clear();
});
test('inline contract matches official image/file/text items and excludes arbitrary refs', () => {
  const items = attachmentItems([{ name: 'cover.png', bytes: png() }, { name: 'notes.md', bytes: Buffer.from('Notes') }]);
  const payload = validateChatPayload({ items: [...items, { type: 'text', text: 'Please review' }], capabilities: ['unsafe'] });
  assert.deepEqual(payload.capabilities, []); assert.equal(payload.items[0].type, 'image'); assert.equal(payload.items[1].type, 'file');
  assert.equal(Object.hasOwn(payload, 'session_id'), false);
  assert.throws(() => validateChatPayload({ items: [{ type: 'file_ref', path: '/etc/passwd' }] }));
  assert.throws(() => validateChatPayload({ items: [{ ...items[1], data_base64: '%%%%' }] }));
  assert.throws(() => validateChatPayload({ items: [{ ...items[1], mime_type: 'image/png' }] }));
});
test('full 8 MB payload validates without unsafe regex recursion and aggregate limits hold', () => {
  const items = attachmentItems([{ name: 'large.txt', bytes: Buffer.alloc(MAX_BYTES, 65) }]);
  assert.equal(validateChatPayload({ items }).items.length, 1);
  assert.throws(() => attachmentItems([{ name: 'large.txt', bytes: Buffer.alloc(MAX_BYTES) }, { name: 'small.txt', bytes: Buffer.from('x') }]), /total_limit/);
});
test('attachment-only messages dedupe content and keep uncertain submissions from retrying', async () => {
  const queue = new OutgoingTasks(), attachments = [{ name: 'notes.txt', bytes: Buffer.from('synthetic') }];
  const draft = { id: randomUUID(), text: '', attachments }; let calls = 0;
  const options = { canSend: () => true, dispatch: async payload => {
    calls++; assert.equal(payload.items[0].filename, 'notes.txt'); throw new Error('lost_ack');
  } };
  assert.equal((await queue.submit(draft, options)).status, 'uncertain');
  assert.equal((await queue.submit(draft, options)).status, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await queue.submit({ ...draft, attachments: [{ name: 'notes.txt', bytes: Buffer.from('changed') }] }, options)).reason, 'draft_id_reused');
});
test('gateway allows inline items only through explicit send and still requires a message ACK', async () => {
  const client = new NativeGateway(); client.ready = true;
  let sent;
  client.wire = { request: (verb, route, payload) => { sent = { verb, route, payload }; return { streamId: 1, frames: [] }; }, destroy() {} };
  client.socket = { terminate() {} };
  const promise = client.sendChat({ items: attachmentItems([{ name: 'test.txt', bytes: Buffer.from('x') }]) });
  assert.equal(sent.route, '/chat/stream'); assert.equal(sent.payload.items[0].type, 'file');
  client.dispatch({ streamId: 1, kind: 'response', value: { status: 200, body: [], endBody: false } });
  client.dispatch({ streamId: 1, kind: 'bodyChunk', value: { data: Buffer.from('{"type":"res","status":"ok","payload":{"message_id":"fixture"}}\n'), endBody: true } });
  assert.equal((await promise).message_id, 'fixture');
  await assert.rejects(client.request('fs.write', { path: '/workspace/test' }), /read_only/);
  client.close();
});
