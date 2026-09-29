'use strict';
const protobuf = require('protobufjs');
const { randomBytes } = require('node:crypto');
// Wire field numbers observed in Muse's public noise_envelope/transport schema.
const root = protobuf.parse(`syntax="proto3";
message Chunk { optional int64 chunk_id=1; optional uint32 chunk_index=2; optional uint32 total_chunks=3; optional bytes payload=4; }
message Header { string key=1; string value=2; }
message Request { string verb=1; string path=2; repeated Header headers=3; bytes body=4; bool end_body=5; }
message Response { int32 status=1; repeated Header headers=2; bytes body=3; bool end_body=4; }
message Body { bytes data=1; bool end_body=2; }
message Reset { int32 code=1; string reason=2; }
message Frame { int64 stream_id=1; oneof kind { Request request=2; Response response=3; Body body_chunk=4; Reset reset=5; } }
message ServiceRequest { int32 service=1; bytes payload=2; }
message ServiceResponse { bytes payload=1; }
message ClientNonce { bytes nonce=1; }
`).root;
function encode(type, value) { const schema = root.lookupType(type); return Buffer.from(schema.encode(schema.create(value)).finish()); }
function decode(type, bytes) { return root.lookupType(type).decode(bytes); }
function chunks(payload) {
  if (payload.length > 16 * 1024 * 1024) throw new Error('frame_too_large');
  const totalChunks = Math.max(1, Math.ceil(payload.length / 65489));
  if (totalChunks > 256) throw new Error('too_many_chunks');
  const chunkId = randomBytes(8).readBigInt64LE().toString();
  return Array.from({ length: totalChunks }, (_, index) => encode('Chunk', {
    chunkId, chunkIndex: index, totalChunks, payload: payload.subarray(index * 65489, (index + 1) * 65489),
  }));
}
class ChunkAssembler {
  constructor() { this.pending = new Map(); this.dead = false; this.bytes = 0; }
  accept(bytes, now = Date.now()) {
    if (this.dead) throw new Error('assembler_dead');
    try {
      if (bytes.length > 65535) throw new Error('frame_too_large');
      for (const item of this.pending.values()) if (now - item.startedAt > 60000) throw new Error('chunk_timeout');
      const value = decode('Chunk', bytes);
      const total = Object.hasOwn(value, 'totalChunks') ? value.totalChunks : 1;
      const index = value.chunkIndex ?? 0, id = String(value.chunkId ?? 0);
      if (total < 1 || total > 256 || index >= total || value.payload.length > 65489) throw new Error('invalid_chunk');
      let pending = this.pending.get(id);
      if (!pending) {
        if (this.pending.size >= 16) throw new Error('chunk_capacity');
        pending = { total, parts: new Map(), bytes: 0, startedAt: now }; this.pending.set(id, pending);
      }
      if (pending.total !== total || pending.parts.has(index)) throw new Error('duplicate_or_inconsistent_chunk');
      pending.bytes += value.payload.length; this.bytes += value.payload.length;
      if (pending.bytes > 16 * 1024 * 1024 || this.bytes > 32 * 1024 * 1024) throw new Error('chunk_byte_limit');
      pending.parts.set(index, Buffer.from(value.payload));
      if (pending.parts.size !== total) return null;
      this.pending.delete(id); this.bytes -= pending.bytes;
      return Buffer.concat(Array.from({ length: total }, (_, i) => pending.parts.get(i)));
    } catch { this.dead = true; this.pending.clear(); this.bytes = 0; throw new Error('invalid_transport_frame'); }
  }
}
class NoiseWire {
  constructor(send, receive) { this.send = send; this.receive = receive; this.assembler = new ChunkAssembler(); this.nextId = 1; }
  request(verb, path, params = {}) {
    if (this.nextId > Number.MAX_SAFE_INTEGER) throw new Error('stream_id_exhausted');
    const streamId = this.nextId++;
    const body = verb === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(params));
    if (verb === 'GET' && Object.keys(params).length) path += '?' + new URLSearchParams(params).toString();
    const headers = [{ key: 'x-app-id', value: 'hatch-web' }, { key: 'Accept-Language', value: 'en-US' }];
    if (verb !== 'GET') headers.push({ key: 'Content-Type', value: 'application/json' });
    const payload = encode('Frame', { streamId, request: { verb, path, headers, body, endBody: true } });
    const frames = chunks(encode('ServiceRequest', { service: 0, payload })).map(bytes => this.send.encrypt(bytes));
    return { streamId, frames };
  }
  accept(ciphertext) {
    const assembled = this.assembler.accept(this.receive.decrypt(ciphertext));
    if (!assembled) return null;
    const service = decode('ServiceResponse', assembled);
    if (!service.payload.length) throw new Error('empty_service_response');
    const frame = decode('Frame', service.payload);
    const kinds = ['response', 'bodyChunk', 'reset', 'request'].filter(key => Object.hasOwn(frame, key));
    const streamId = Number(frame.streamId);
    if (kinds.length !== 1 || kinds[0] === 'request' || !Number.isSafeInteger(streamId) || streamId < 1) throw new Error('invalid_service_response');
    return { streamId, kind: kinds[0], value: frame[kinds[0]] };
  }
  destroy() { this.send.destroy(); this.receive.destroy(); this.assembler.dead = true; this.assembler.pending.clear(); }
}
module.exports = { encode, decode, chunks, ChunkAssembler, NoiseWire };
