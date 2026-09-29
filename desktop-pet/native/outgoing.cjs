'use strict';
const { createHash } = require('node:crypto');
function validateDraft(request) {
  if (!request || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.id) || typeof request.text !== 'string') throw new Error('invalid_draft');
  const text = request.text.trim();
  if (!text || text.length > 8000 || Buffer.byteLength(text) > 32768) throw new Error('invalid_draft');
  return { id: request.id, text };
}
class OutgoingTasks {
  constructor() { this.receipts = new Map(); }
  async submit(request, { canSend, dispatch }) {
    let draft;
    try { draft = validateDraft(request); } catch { return { status: 'not_sent', reason: 'invalid_draft' }; }
    const hash = createHash('sha256').update(draft.text).digest('hex');
    const previous = this.receipts.get(draft.id);
    if (previous) return previous.hash === hash ? previous.promise : { status: 'not_sent', reason: 'draft_id_reused' };
    if (!canSend()) return { status: 'not_sent', reason: 'not_connected' };
    if (this.receipts.size >= 512) return { status: 'not_sent', reason: 'receipt_capacity' };
    const entry = { hash, promise: null };
    // The UUID is local deduplication only. No unsupported server idempotency
    // guarantee is invented; uncertain deliveries are NEVER auto-retried.
    entry.promise = Promise.resolve().then(async () => {
      try {
        const result = await dispatch({ message: draft.text, capabilities: [] });
        if (typeof result?.message_id !== 'string' || !result.message_id || result.message_id.length > 512) return { status: 'uncertain', reason: 'ack_missing' };
        return { status: 'accepted', messageId: result.message_id };
      } catch (error) {
        if (error.deliveryState === 'not_sent') {
          this.receipts.delete(draft.id); return { status: 'not_sent', reason: 'not_connected' };
        }
        if (Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500) {
          this.receipts.delete(draft.id); return { status: 'rejected', reason: 'server_rejected' };
        }
        return { status: 'uncertain', reason: 'delivery_unconfirmed' };
      }
    });
    this.receipts.set(draft.id, entry);
    return entry.promise;
  }
}
module.exports = { OutgoingTasks, validateDraft };
