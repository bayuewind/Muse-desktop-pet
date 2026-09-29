'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Conversations, sessionId, threadIdentity } = require('../native/conversations.cjs');
const { ThreadChat } = require('../native/thread-chat.cjs');
const { ReplyStore } = require('../native/replies.cjs');
const { NativeGateway } = require('../native/gateway-client.cjs');
const { NativeSource } = require('../native/source.cjs');
const { validateChatPayload } = require('../native/chat-input.cjs');
const { AttachmentSessions } = require('../input-attachments.cjs');
const identity = (id = 'thread-a') => ({ session_id: id, is_primary: false, is_thread: true, status: 'active', archived: false });
const history = (id = 'thread-a') => ({ session_id: id, messages: [
  { id: 'reply', role: 'assistant', session_id: id, is_thread: true, text: 'Synthetic thread reply' },
] });
class Client extends EventEmitter {
  constructor() { super(); this.ready = true; this.closed = false; this.calls = []; this.sends = []; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'sessions.get') return { session: identity(params.id) };
    if (method === 'chat.history') return history(params.session_id);
    return { accepted: true };
  }
  async sendChat(payload) { this.sends.push(payload); return { message_id: 'ack', session_id: payload.session_id }; }
  close() { if (!this.closed) { this.closed = true; this.emit('closed'); } }
}
test('session list is bounded, copied, normalized and only active threads are selectable', () => {
  const model = new Conversations();
  model.update({ sessions: [{ ...identity(), title: 'a'.repeat(300), private: 'never-export' },
    { ...identity('primary'), is_primary: true, is_thread: false },
    { ...identity('archived'), archived: true }] }, 1000);
  assert.equal(model.selectable(null), true); assert.equal(model.selectable('thread-a'), true);
  assert.equal(model.selectable('primary'), false); assert.equal(model.selectable('archived'), false);
  assert.equal(model.selectable('unknown'), false); assert.equal(model.rows[0].title.length, 200);
  assert.equal(JSON.stringify(model.snapshot(1000)).includes('never-export'), false);
  assert.equal(model.snapshot(121000).fresh, false);
  assert.throws(() => model.update({ sessions: [identity(), {}] }), /schema/);
  assert.equal(model.rows.length, 3);
  model.update({ sessions: Array.from({ length: 201 }, (_, i) => identity(`s${i}`)) });
  assert.equal(model.rows.length, 200); assert.equal(model.partial, true);
});
test('thread identities and path interpolation reject main sessions, mismatches and traversal', async () => {
  assert.equal(threadIdentity({ session: identity() }, 'thread-a'), true);
  assert.equal(threadIdentity(identity('other'), 'thread-a'), false);
  assert.equal(threadIdentity({ ...identity(), is_primary: true }, 'thread-a'), false);
  for (const value of ['', '.', '..', '../x', 'a/b', '%2e', 'a?b', 'a b', null]) assert.throws(() => sessionId(value));
  const gateway = new NativeGateway(); let args;
  gateway.requestRoute = (...values) => { args = values; return Promise.resolve({}); };
  await gateway.request('sessions.get', { id: 'thread-a' });
  assert.deepEqual(args, ['sessions.get', ['GET', '/api/session/list/thread-a'], {}]);
  await assert.rejects(gateway.request('sessions.get', { id: '../x' }), /invalid_session/);
});
test('reply stores isolate main, thread and private payloads including nested history', () => {
  const main = new ReplyStore(), thread = new ReplyStore(() => {}, { sessionId: 'thread-a' });
  const own = { id: 'same-id', role: 'assistant', session_id: 'thread-a', is_thread: true, text: 'own' };
  assert.equal(main.ingest('message.assistant', own), false);
  assert.equal(thread.ingest('message.assistant', own), true);
  for (const change of [{ session_id: 'other' }, { is_thread: false }, { thread_id: 'other' },
    { subagent_id: 'private' }, { visibility: 'reasoning' }, { payload: { session_id: 'other' } }]) {
    assert.equal(thread.ingest('message.assistant', { ...own, ...change }), false);
  }
  thread.history({ messages: [{ ...own, session_id: 'other', text: 'crossed' }] });
  assert.equal(thread.snapshot().messages[0].text, 'own');
  assert.equal(main.snapshot().messages.length, 0);
});
test('thread subscription history and send use one verified scope, never default main', async t => {
  const client = new Client(), thread = new ThreadChat('thread-a', async () => client);
  t.after(() => thread.clear());
  assert.equal(await thread.start(), true); assert.equal(thread.phase, 'ready');
  assert.deepEqual(client.calls.find(call => call.method === 'chat.subscribe').params, { session_id: 'thread-a' });
  assert.deepEqual(client.calls.find(call => call.method === 'chat.history').params,
    { session_id: 'thread-a', transcript_mode: 'messages', limit: 20 });
  const result = await thread.submit({ id: randomUUID(), text: 'Synthetic', attachments: [] }, () => true);
  assert.equal(result.status, 'accepted'); assert.equal(client.sends[0].session_id, 'thread-a');
  assert.equal(client.calls.filter(call => call.method === 'sessions.get').length, 2);
  client.emit('chat-event', 'message.assistant', { id: 'late', session_id: 'other', is_thread: true, text: 'crossed' }, {});
  assert.equal(thread.replies.rows.has('late'), false);
});
test('changed thread classification prevents subscription and sending', async t => {
  const client = new Client(), thread = new ThreadChat('thread-a', async () => client);
  t.after(() => thread.clear());
  const request = client.request.bind(client);
  client.request = async (method, params) => method === 'sessions.get' ? { ...identity(), is_thread: false } : request(method, params);
  assert.equal(await thread.start(), false); assert.equal(thread.phase, 'disconnected');
  assert.equal(client.calls.some(call => call.method === 'chat.subscribe'), false);
  assert.equal((await thread.submit({ id: randomUUID(), text: 'Never sent' }, () => true)).status, 'not_sent');
  assert.equal(client.sends.length, 0);
});
test('late scoped history cannot refill a cleared or replaced conversation', async t => {
  const client = new Client(); let release;
  const request = client.request.bind(client);
  client.request = (method, params) => method === 'chat.history'
    ? new Promise(resolve => { release = resolve; }) : request(method, params);
  const thread = new ThreadChat('thread-a', async () => client); t.after(() => thread.clear());
  const pending = thread.start(); await new Promise(resolve => setImmediate(resolve));
  thread.clear(); release(history());
  assert.equal(await pending, false); assert.equal(thread.replies.rows.size, 0);
  client.emit('chat-event', 'message.assistant', history().messages[0], {});
  assert.equal(thread.replies.rows.size, 0);
});
test('connection finishing after switch closes itself without subscribing', async () => {
  const client = new Client(); let release;
  const thread = new ThreadChat('thread-a', () => new Promise(resolve => { release = resolve; }));
  const pending = thread.start(); thread.clear(); release(client);
  assert.equal(await pending, false); assert.equal(client.closed, true); assert.equal(client.calls.length, 0);
});
test('scoped payloads include valid session IDs and reject malformed IDs for text and files', () => {
  for (const payload of [{ message: 'Synthetic' }, { items: [{ type: 'text', text: 'Synthetic' }] }]) {
    assert.equal(validateChatPayload({ ...payload, session_id: 'thread-a' }).session_id, 'thread-a');
    assert.equal(Object.hasOwn(validateChatPayload(payload), 'session_id'), false);
    assert.throws(() => validateChatPayload({ ...payload, session_id: '../main' }));
  }
});
test('attachment drafts remain isolated when switching and all retained bytes are wiped on logout', () => {
  const sessions = new AttachmentSessions();
  const main = sessions.active, file = main.stage('main.txt', Buffer.from('main'));
  const bytes = main.rows.get(file.id).bytes;
  const side = sessions.select('thread-a'); side.stage('side.txt', Buffer.from('side'));
  assert.throws(() => side.resolve([file.id]), /expired/);
  assert.equal(sessions.select(null).list()[0].name, 'main.txt');
  assert.equal(sessions.select('thread-a').list()[0].name, 'side.txt');
  sessions.clear();
  assert.equal(bytes.every(value => value === 0), true); assert.equal(side.rows.size, 0);
  assert.equal(sessions.activeId, null); assert.equal(sessions.active.rows.size, 0);
});
test('retained attachment sessions are bounded without silently discarding files', () => {
  const sessions = new AttachmentSessions();
  for (let i = 0; i < 8; i++) sessions.select(`s${i}`).stage('keep.txt', Buffer.from('keep'));
  assert.throws(() => sessions.select('ninth'), /capacity/);
  const store = sessions.active; store.clear();
  assert.equal(sessions.select('ninth').rows.size, 0); assert.equal(sessions.stores.size, 8);
  sessions.clear();
});
test('main source rejects unknown session selection without changing active replies', async () => {
  const source = new NativeSource({}); source.running = true;
  source.replies.ingest('message.assistant', { id: 'main', text: 'Main' });
  assert.equal((await source.selectSession('unregistered')).ok, false);
  assert.equal(source.activeSessionId, null); assert.equal(source.replySnapshot().messages[0].text, 'Main');
  await source.stop(); source.clearAccountData();
});
test('side approval events prevent dispatch even when main monitoring is ready', async t => {
  const client = new Client(), thread = new ThreadChat('thread-a', async () => client);
  t.after(() => thread.clear()); await thread.start();
  client.emit('status-event', 'agent.status', { agent_id: 'side-agent', session_id: 'thread-a', is_thread: true,
    activity_code: 'needs_approval' }, { seq: 2 });
  assert.equal(thread.restriction, 'approval');
  const draft = { id: randomUUID(), text: 'Never sent' };
  assert.equal((await thread.submit(draft, () => true)).status, 'not_sent'); assert.equal(client.sends.length, 0);
  client.emit('status-event', 'agent.status', { agent_id: 'side-agent', activity_code: 'online' }, { seq: 1 });
  assert.equal(thread.restriction, 'approval');
  client.emit('status-event', 'agent.status', { agent_id: 'side-agent', activity_code: 'future-code' }, { seq: 3 });
  assert.equal(thread.restriction, 'unknown');
  client.emit('status-event', 'agent.status', { agent_id: 'side-agent', activity_code: 'online' }, { seq: 4 });
  assert.equal(thread.restriction, null);
});
test('source preserves main replies while switching threads and discards old side events', async t => {
  const start = ThreadChat.prototype.start;
  ThreadChat.prototype.start = async function () { this.phase = 'ready'; return true; };
  t.after(() => { ThreadChat.prototype.start = start; });
  const source = new NativeSource({}); source.running = true;
  source.conversations.update({ sessions: [identity('thread-a'), identity('thread-b')] });
  source.replies.ingest('message.assistant', { id: 'same', text: 'Main kept' });
  await source.selectSession('thread-a'); const old = source.thread;
  old.replies.ingest('message.assistant', { id: 'same', session_id: 'thread-a', is_thread: true, text: 'Side A' });
  assert.equal(source.replySnapshot().messages[0].text, 'Side A');
  await source.selectSession('thread-b');
  assert.equal(source.replySnapshot().messages.length, 0);
  assert.equal(old.replies.rows.size, 0); assert.equal(old.listenerCount('replies'), 0);
  assert.equal(source.replies.snapshot().messages[0].text, 'Main kept');
  await source.selectSession(null);
  assert.equal(source.replySnapshot().messages[0].text, 'Main kept');
  assert.equal(source.replySnapshot().selection, 3);
  await source.stop(); source.clearAccountData();
});
test('a mismatched session acknowledgement stays uncertain and never automatically resends', async t => {
  const client = new Client(), thread = new ThreadChat('thread-a', async () => client);
  t.after(() => thread.clear()); await thread.start();
  client.sendChat = async payload => { client.sends.push(payload); return { message_id: 'ack', session_id: 'other' }; };
  const draft = { id: randomUUID(), text: 'Synthetic' };
  assert.equal((await thread.submit(draft, () => true)).status, 'uncertain');
  assert.equal((await thread.submit(draft, () => true)).status, 'uncertain');
  assert.equal(client.sends.length, 1);
});
test('main source cannot be redirected by a draft field and rechecks scope at dispatch time', async () => {
  const source = new NativeSource({}); source.running = true;
  const now = Date.now(); source.state.heartbeat(now);
  source.state.agent({ agent_id: 'main', activity_code: 'online' }, { source: 'chat.subscribe' });
  source.state.polls({ runs: { runs: [] }, schedules: { schedules: [] }, subagents: { active_count: 0 } }, now);
  const sent = [];
  source.client = { ready: true, closed: false, close() { this.closed = true; },
    async sendChat(payload) { sent.push(payload); return { message_id: 'ack' }; } };
  const result = await source.submitTask({ id: randomUUID(), text: 'Synthetic', sessionId: 'other' });
  assert.equal(result.status, 'accepted'); assert.equal(Object.hasOwn(sent[0], 'session_id'), false);
  const pending = source.submitTask({ id: randomUUID(), text: 'Cancelled before dispatch' });
  await source.stop(); source.clearAccountData();
  assert.equal((await pending).status, 'not_sent'); assert.equal(sent.length, 1);
});
