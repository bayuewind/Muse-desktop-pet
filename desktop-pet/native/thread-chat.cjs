'use strict';
const { EventEmitter } = require('node:events');
const { ReplyStore } = require('./replies.cjs');
const { OutgoingTasks } = require('./outgoing.cjs');
const { sessionId, threadIdentity } = require('./conversations.cjs');
const { visible } = require('./replies.cjs');
const KNOWN = new Set(['online', 'working', 'responding', 'composing', 'compacting', 'making_something',
  'waiting_for_subagents', 'needs_approval', 'waiting_for_user', 'out_of_credits']);
class ThreadChat extends EventEmitter {
  constructor(id, connect) {
    super(); this.id = sessionId(id); this.connect = connect; this.generation = 0;
    this.phase = 'disconnected'; this.client = null; this.timer = null; this.busy = false;
    this.activities = new Map();
    this.replies = new ReplyStore(() => this.emit('replies'), { sessionId: this.id });
    this.outgoing = new OutgoingTasks();
  }
  get restriction() {
    const codes = [...this.activities.values()].map(value => value.code);
    return codes.includes('needs_approval') ? 'approval' : codes.includes('out_of_credits') ? 'limited'
      : codes.includes('unknown') ? 'unknown' : null;
  }
  async start() {
    this.stop();
    const generation = this.generation, current = () => generation === this.generation;
    this.phase = 'connecting'; this.emit('state');
    let client;
    try {
      client = await this.connect(current);
      if (!current()) { client.close(); return false; }
      this.client = client;
      client.on('chat-event', (type, payload, meta) => {
        if (current() && this.client === client) this.replies.ingest(type, payload, { ...meta, epoch: generation });
      });
      client.on('status-event', (type, payload, meta = {}) => {
        if (!current() || type !== 'agent.status' || !visible(payload, this.id)) return;
        const key = payload.agent_id;
        if (typeof key !== 'string' || key.length > 512 || this.activities.size >= 200 && !this.activities.has(key)) return;
        const previous = this.activities.get(key);
        if (Number.isSafeInteger(meta.seq) && Number.isSafeInteger(previous?.seq) && meta.seq <= previous.seq) return;
        this.activities.set(key, { code: KNOWN.has(payload.activity_code) ? payload.activity_code : 'unknown', seq: meta.seq });
        this.emit('state');
      });
      client.on('closed', () => {
        if (!current()) return;
        clearInterval(this.timer); this.timer = null; this.phase = 'disconnected';
        this.replies.interrupted(); this.emit('state');
      });
      const detail = await client.request('sessions.get', { id: this.id });
      if (!current() || !threadIdentity(detail, this.id)) throw new Error('thread_identity_changed');
      await client.request('chat.subscribe', { session_id: this.id });
      const loaded = await this.history(client, current);
      if (!loaded || !current() || client.closed) throw new Error('thread_history_failed');
      this.phase = 'ready'; this.emit('state');
      this.timer = setInterval(() => { void this.heartbeat(client, current); }, 15000);
      return true;
    } catch {
      client?.close();
      if (current()) { this.phase = 'disconnected'; this.emit('state'); }
      return false;
    }
  }
  async heartbeat(client, current) {
    if (this.busy || !current()) return;
    this.busy = true;
    try { await client.request('connection.ping'); }
    catch { client.close('heartbeat_failed'); }
    finally { if (current()) this.busy = false; }
  }
  async history(client, current) {
    const startedAt = Date.now();
    try {
      const response = await client.request('chat.history', { session_id: this.id, transcript_mode: 'messages', limit: 20 });
      if (!current() || this.client !== client || client.closed) return false;
      if (response?.session_id != null && response.session_id !== this.id) return false;
      this.replies.history(response, startedAt); return true;
    } catch (error) {
      // The official client treats a registered, empty thread with no history as empty.
      return current() && this.client === client && !client.closed && error.httpStatus === 404 && !this.replies.rows.size;
    }
  }
  async refresh() {
    if (this.phase !== 'ready' || !this.client || this.client.closed) return { ok: await this.start() };
    const generation = this.generation;
    return { ok: await this.history(this.client, () => generation === this.generation) };
  }
  async submit(draft, canSend) {
    const client = this.client, generation = this.generation;
    if (!client || this.phase !== 'ready' || this.restriction || !canSend()) return { status: 'not_sent', reason: 'not_connected' };
    try {
      const identity = await client.request('sessions.get', { id: this.id });
      if (!threadIdentity(identity, this.id)) return { status: 'not_sent', reason: 'session_changed' };
    } catch { return { status: 'not_sent', reason: 'session_unverified' }; }
    return this.outgoing.submit({ ...draft, sessionId: this.id }, {
      canSend: () => generation === this.generation && this.client === client && this.phase === 'ready' &&
        !this.restriction && !client.closed && canSend(),
      dispatch: payload => client.sendChat(payload),
    });
  }
  stop() {
    this.generation++; clearInterval(this.timer); this.timer = null; this.busy = false;
    this.client?.close(); this.client = null; this.phase = 'disconnected';
    this.activities.clear();
    this.replies.interrupted();
  }
  clear() {
    this.stop(); this.replies.rows.clear(); this.replies.unreadIds.clear(); this.replies.unread = 0;
    this.outgoing.receipts.clear(); this.removeAllListeners();
  }
}
module.exports = { ThreadChat };
