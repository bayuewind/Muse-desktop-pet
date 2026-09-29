'use strict';
const { extractAttachments } = require('./attachments.cjs');
const LIMIT = 128*1024;
function visible(payload) {
  if (!payload || typeof payload !== 'object' || payload.subagent_id || payload.is_thread === true) return false;
  if (payload.transcript_surface && payload.transcript_surface !== 'main_chat') return false;
  if (payload.stream_lane && !['main','primary','assistant','visible','output'].includes(payload.stream_lane)) return false;
  if (['hidden','internal','reasoning'].includes(payload.visibility)) return false;
  return true;
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  return value.filter(part => part && ['text','output_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
}
function canonicalText(payload) {
  const transcript = payload.transcript?.messages;
  if (Array.isArray(transcript)) {
    const parts = transcript.filter(message => message.role === 'assistant' && visible(message)).map(message => contentText(message.content)).filter(text => text != null);
    if (parts.length) return parts.join('\n');
  }
  for (const value of [payload.content, payload.payload?.content, payload.text, payload.payload?.text]) {
    const text = contentText(value); if (text != null) return text;
  }
  for (const value of [payload.display_text, payload.payload?.display_text]) if (typeof value === 'string') return value;
  return null;
}
function blocks(text) {
  const result = []; let at = 0;
  for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
    if (match.index > at) result.push({ kind: 'text', text: text.slice(at, match.index) });
    result.push({ kind: 'code', language: match[1].trim().slice(0, 30), text: match[2] });
    at = match.index + match[0].length;
  }
  if (at < text.length) result.push({ kind: 'text', text: text.slice(at) });
  return result;
}
class ReplyStore {
  constructor(onChange = () => {}) { this.rows = new Map(); this.onChange = onChange; this.unread = 0; this.unreadIds = new Set(); }
  row(id, role, time) {
    if (typeof id !== 'string' || !id || id.length > 512) return null;
    let row = this.rows.get(id);
    if (!row) {
      row = { id, role, text: '', state: 'streaming', createdAt: Number.isFinite(time) ? time : Date.now(),
        attachments: new Map(), seen: new Set(), lastDelta: new Map(), version: 0 };
      this.rows.set(id, row);
      while (this.rows.size > 60) { const oldest = this.rows.keys().next().value; this.rows.delete(oldest); this.unreadIds.delete(oldest); }
    }
    return row;
  }
  ingest(type, payload, meta = {}, { history = false } = {}) {
    if (!visible(payload) || payload.payload && !visible(payload.payload)) return false;
    if (type === 'delta.message_removed') {
      for (const id of payload.message_ids ?? []) { this.rows.delete(id); this.unreadIds.delete(id); }
      this.unread = Math.min(99, this.unreadIds.size);
      this.onChange(); return true;
    }
    const id = payload.host_message_id ?? payload.message_id ?? payload.id;
    const role = type === 'message.user' || payload.role === 'user' ? 'user' : 'assistant';
    const row = this.row(id, role, meta.ts_ms ?? payload.occurred_at_ms ?? payload.created_at_ms);
    if (!row) return false;
    const seq = Number.isSafeInteger(meta.seq) ? meta.seq : Number.isSafeInteger(payload.seq) ? payload.seq : null;
    const epoch = meta.epoch ?? 0;
    const dedupe = seq == null ? null : `${epoch}:${type}:${seq}`;
    if (dedupe && row.seen.has(dedupe)) return false;
    if (dedupe) { row.seen.add(dedupe); if (row.seen.size > 1024) row.seen.delete(row.seen.values().next().value); }
    if (type === 'delta.message_start') {
      if (row.state !== 'done') { row.text = ''; row.state = 'streaming'; }
    } else if (type === 'delta.text_append') {
      if (row.state === 'done' || row.state === 'interrupted') return false;
      const last = row.lastDelta.get(epoch);
      if (seq != null && last != null && seq <= last) return false;
      if (seq != null) row.lastDelta.set(epoch, seq);
      if (typeof payload.text === 'string') row.text += payload.text;
    } else if (type === 'delta.presentation') {
      // A presentation can arrive between text deltas; it is not completion.
      if (history && !row.text) row.state = 'done';
    } else {
      const text = canonicalText(payload);
      if (text != null) row.text = text;
      const status = payload.status ?? payload.transcript?.status;
      row.state = status === 'interrupted' ? 'interrupted' : status === 'error' ? 'error'
        : payload.is_streaming === true || ['streaming','in_progress'].includes(status) ? 'streaming' : 'done';
    }
    if (Buffer.byteLength(row.text) > LIMIT) { row.text = Buffer.from(row.text).subarray(0,LIMIT).toString(); row.truncated = true; }
    for (const attachment of extractAttachments(payload, row.text)) {
      const existing = row.attachments.get(attachment.id);
      if (existing || row.attachments.size < 30) row.attachments.set(attachment.id, { ...attachment, size: attachment.size ?? existing?.size ?? null });
    }
    row.version++;
    row.updatedAt = Date.now();
    if (!history && role === 'assistant') this.unreadIds.add(id);
    this.unread = Math.min(99, this.unreadIds.size);
    this.onChange(); return true;
  }
  history(response, startedAt = Date.now()) {
    // Capture live conflicts before the batch: earlier history rows must not
    // prevent later presentation/text rows in this same response from merging.
    const liveIds = new Set([...this.rows.values()].filter(row => row.updatedAt >= startedAt).map(row => row.id));
    const events = response?.chat_events;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (!visible(event) || event.payload && !visible(event.payload)) continue;
        const type = event.event_name ?? event.event ?? (event.role === 'user' ? 'message.user' : 'message.assistant');
        if (['message.user','message.assistant','delta.presentation','delta.message_done'].includes(type)) {
          const payload = { ...event, ...(event.payload ?? {}) };
          if (liveIds.has(payload.host_message_id ?? payload.message_id ?? payload.id)) continue;
          this.ingest(type, payload, { ts_ms: event.occurred_at_ms, seq: event.seq, epoch: 'history' }, { history: true });
        }
      }
    } else if (Array.isArray(response?.messages)) {
      for (const message of response.messages) if (['user','assistant'].includes(message.role) && !liveIds.has(message.message_id ?? message.id)) this.ingest(`message.${message.role}`, message, { epoch: 'history' }, { history: true });
    } else throw new Error('chat_history_schema_changed');
    this.onChange();
  }
  interrupted() { for (const row of this.rows.values()) if (row.state === 'streaming') { row.state = 'interrupted'; row.version++; } this.onChange(); }
  read() { if (this.unread) { this.unread = 0; this.unreadIds.clear(); this.onChange(); } }
  asset(messageId, assetId) { return this.rows.get(messageId)?.attachments.get(assetId) ?? null; }
  code(messageId, index) { return blocks(this.rows.get(messageId)?.text ?? '').filter(block => block.kind === 'code')[index]?.text ?? null; }
  snapshot() {
    return { unread: this.unread, messages: [...this.rows.values()].sort((a,b) => a.createdAt-b.createdAt).map(row => ({
      id: row.id, role: row.role, text: row.text, state: row.state, version: row.version,
      createdAt: row.createdAt, truncated: row.truncated === true,
      attachments: [...row.attachments.values()].map(({ path, ...safe }) => safe),
    })) };
  }
}
module.exports = { ReplyStore, canonicalText, contentText, visible, blocks };
