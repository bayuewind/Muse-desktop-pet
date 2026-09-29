'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { OutgoingTasks } = require('../native/outgoing.cjs');
const { NativeGateway } = require('../native/gateway-client.cjs');
test('duplicate clicks dispatch once; only an actual message ID is accepted', async () => {
  const queue = new OutgoingTasks(), draft = { id: randomUUID(), text: 'local test only' }; let calls = 0;
  const options = { canSend: () => true, dispatch: async body => { calls++; assert.deepEqual(body, { message: draft.text, capabilities: [] }); return { message_id: 'fixture' }; } };
  const result = await Promise.all([queue.submit(draft, options), queue.submit(draft, options)]);
  assert.equal(calls, 1); assert.equal(result[0].status, 'accepted'); assert.equal(result[1].status, 'accepted');
  assert.equal((await queue.submit({ ...draft, text: 'different' }, options)).status, 'not_sent');
});
test('lost ACK is uncertain and is never retried; no connection is safely not-sent', async () => {
  const queue = new OutgoingTasks(), draft = { id: randomUUID(), text: 'never sent to a server' }; let calls = 0;
  const options = { canSend: () => true, dispatch: async () => { calls++; throw new Error('socket closed'); } };
  assert.equal((await queue.submit(draft, options)).status, 'uncertain');
  assert.equal((await queue.submit(draft, options)).status, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await queue.submit({ id: randomUUID(), text: 'x' }, { ...options, canSend: () => false })).status, 'not_sent');
  assert.equal(calls, 1);
});
test('task stream does not treat HTTP 200 as message acceptance or disconnect monitoring on completion', async () => {
  const client = new NativeGateway(); client.ready = true;
  client.wire = { request: () => ({ streamId: 1, frames: [] }), destroy() {} }; client.socket = { terminate() {} };
  let settled = false;
  const promise = client.sendChat({ message: 'fixture' }).then(value => { settled = true; return value; });
  client.dispatch({ streamId: 1, kind: 'response', value: { status: 200, body: [], endBody: false } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  client.dispatch({ streamId: 1, kind: 'bodyChunk', value: { data: Buffer.from('{"type":"res","status":"ok","payload":{"message_id":"fixture-id"}}\n'), endBody: true } });
  assert.equal((await promise).message_id, 'fixture-id'); assert.equal(client.closed, false); assert.equal(client.pending.size, 0);
  client.close();
});
test('read-only entry point still rejects message sending and task cancellation', async () => {
  const client = new NativeGateway();
  await assert.rejects(client.request('chat.stream', { message: 'x' }), /read_only/);
  await assert.rejects(client.request('chat.cancel', {}), /read_only/);
});
