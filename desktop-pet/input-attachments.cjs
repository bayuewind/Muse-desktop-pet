'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_FILES, MAX_BYTES, fileInfo } = require('./native/chat-input.cjs');
class InputAttachments {
  constructor() { this.rows = new Map(); this.bytes = 0; this.generation = 0; }
  stage(name, input) {
    const length = input?.byteLength;
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BYTES ||
        this.rows.size >= MAX_FILES || this.bytes + length > MAX_BYTES) throw new Error('attachment_capacity');
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) throw new Error('invalid_attachment');
    const bytes = Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input);
    try {
      const info = fileInfo(name, bytes), id = randomUUID();
      this.rows.set(id, { id, name, bytes, ...info }); this.bytes += bytes.length;
      return this.view(id);
    } catch (error) { bytes.fill(0); throw error; }
  }
  async selectFile(file) {
    const generation = this.generation;
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_BYTES) throw new Error('attachment_size_limit');
    const handle = await fs.open(file, 'r');
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== before.size || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('file_changed');
      bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || generation !== this.generation)
        throw new Error('file_changed');
      return this.stage(path.basename(file), bytes.subarray(0, offset));
    } finally { bytes?.fill(0); await handle.close(); }
  }
  view(id) {
    const row = this.rows.get(id); if (!row) return null;
    return { id: row.id, name: row.name, size: row.size, kind: row.kind, mime: row.mime_type };
  }
  preview(id) {
    const row = this.rows.get(id);
    return row?.kind === 'image' ? { ...this.view(id), bytes: Buffer.from(row.bytes) } : null;
  }
  list() { return [...this.rows.keys()].map(id => this.view(id)); }
  resolve(ids) {
    if (!Array.isArray(ids) || ids.length > MAX_FILES || new Set(ids).size !== ids.length) throw new Error('invalid_attachment_selection');
    return ids.map(id => {
      const row = this.rows.get(id); if (!row) throw new Error('attachment_expired');
      return { name: row.name, bytes: row.bytes };
    });
  }
  remove(id) {
    const row = this.rows.get(id); if (!row) return;
    row.bytes.fill(0); this.bytes -= row.size; this.rows.delete(id);
  }
  clear() { this.generation++; for (const id of this.rows.keys()) this.remove(id); }
}
module.exports = { InputAttachments };
