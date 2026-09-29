'use strict';
const { StringDecoder } = require('node:string_decoder');
const STATUS_EVENTS = new Set(['agent.status', 'task.status', 'approvals.snapshot']);
class SubscriptionDecoder {
  constructor({ onAck = () => {}, onEvent = () => {} } = {}) {
    this.decoder = new StringDecoder('utf8'); this.pending = ''; this.acked = false;
    this.dead = false; this.onAck = onAck; this.onEvent = onEvent;
  }
  record(text) {
    if (!text.trim()) return;
    const record = JSON.parse(text);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid_subscription_record');
    if (record.type === 'event') {
      if (typeof record.event !== 'string' || !('payload' in record)) throw new Error('invalid_event');
      if (!this.acked) { this.acked = true; this.onAck({}); }
      // Discard chat text, tool output and other unrelated event bodies immediately.
      if (STATUS_EVENTS.has(record.event)) this.onEvent(record.event, record.payload, {
        seq: Number.isSafeInteger(record.seq) ? record.seq : null,
        ts_ms: Number.isFinite(record.ts_ms) ? record.ts_ms : null,
      });
    } else {
      if (this.acked || record.ok === false || record.error) throw new Error('subscription_rejected');
      this.acked = true; this.onAck(record.result ?? record);
    }
  }
  push(bytes, end = false) {
    if (this.dead) throw new Error('subscription_dead');
    try {
      this.pending += this.decoder.write(bytes);
      if (end) this.pending += this.decoder.end();
      let index;
      while ((index = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, index); this.pending = this.pending.slice(index + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('record_too_large');
        this.record(line);
      }
      if (Buffer.byteLength(this.pending) > 1024 * 1024) throw new Error('record_too_large');
      if (end && this.pending.trim()) { this.record(this.pending); this.pending = ''; }
    } catch { this.dead = true; this.pending = ''; throw new Error('subscription_protocol_error'); }
  }
}
module.exports = { SubscriptionDecoder };
