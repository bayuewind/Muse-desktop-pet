'use strict';
const { text, timestamp } = require('./workspace.cjs');
function sessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 ||
      /[\s/\\?#%\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..') throw new Error('invalid_session');
  return value;
}
function threadIdentity(response, expected) {
  const row = response?.session ?? response;
  return row?.session_id === expected && row.is_thread === true && row.is_primary === false &&
    row.archived !== true && typeof row.status === 'string';
}
class Conversations {
  constructor() { this.reset(); }
  reset() { this.rows = []; this.updatedAt = 0; this.failed = false; this.partial = false; }
  update(response, now = Date.now()) {
    if (!Array.isArray(response?.sessions)) throw new Error('sessions_schema_changed');
    const rows = response.sessions.slice(0, 200).map(row => {
      if (typeof row?.is_primary !== 'boolean' || typeof row?.is_thread !== 'boolean') throw new Error('sessions_schema_changed');
      return { id: sessionId(row.session_id), title: text(row.title, 200) || (row.is_primary ? '主会话' : '未命名会话'),
        primary: row.is_primary, thread: row.is_thread, archived: row.archived === true,
        updatedAt: timestamp(row.updated_at_ms), unread: Number.isSafeInteger(row.unread_count) ? Math.max(0, Math.min(99, row.unread_count)) : 0 };
    });
    const unique = new Map(rows.map(row => [row.id, row]));
    this.rows = [...unique.values()]; this.updatedAt = now; this.failed = false;
    this.partial = response.sessions.length > 200 || unique.size !== rows.length;
  }
  selectable(id) { return id === null || this.rows.some(row => row.id === id && row.thread && !row.primary && !row.archived); }
  snapshot(now = Date.now()) {
    return { rows: this.rows.map(row => ({ ...row })), updatedAt: this.updatedAt, partial: this.partial,
      fresh: !this.failed && this.updatedAt > 0 && now >= this.updatedAt && now - this.updatedAt < 120000 };
  }
}
module.exports = { Conversations, sessionId, threadIdentity };
