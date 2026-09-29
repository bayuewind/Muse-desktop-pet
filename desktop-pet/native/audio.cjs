'use strict';
const { StringDecoder } = require('node:string_decoder');
const RATE = 24000, MAX_SECONDS = 60;
function toDictationPCM(audio) {
  if (!audio || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 96000 ||
      !(audio.samples instanceof ArrayBuffer)) throw new Error('invalid_audio');
  const bytes = Buffer.from(audio.samples);
  if (bytes.length % 4 || bytes.length < audio.sampleRate * 0.15 * 4 || bytes.length > audio.sampleRate * MAX_SECONDS * 4) throw new Error('invalid_audio');
  const count = bytes.length / 4, ratio = audio.sampleRate / RATE;
  const result = Buffer.alloc(Math.floor(count / ratio) * 2);
  for (let i = 0; i < count; i++) if (!Number.isFinite(bytes.readFloatLE(i*4))) throw new Error('invalid_audio');
  for (let i = 0; i < result.length/2; i++) {
    let value;
    if (ratio >= 1) {
      const start = Math.floor(i*ratio), end = Math.min(count, Math.floor((i+1)*ratio));
      let sum = 0; for (let j = start; j < end; j++) sum += bytes.readFloatLE(j*4);
      value = sum / Math.max(1, end-start);
    } else {
      const at = i*ratio, left = Math.floor(at), right = Math.min(count-1, left+1);
      value = bytes.readFloatLE(left*4)*(1-(at-left)) + bytes.readFloatLE(right*4)*(at-left);
    }
    value = Math.max(-1, Math.min(1, value));
    result.writeInt16LE(Math.trunc(value < 0 ? value*32768 : value*32767), i*2);
  }
  bytes.fill(0); return result;
}
class DictationDecoder {
  constructor(onFinal) { this.onFinal = onFinal; this.decoder = new StringDecoder('utf8'); this.pending = ''; this.final = false; }
  push(bytes, end = false) {
    this.pending += this.decoder.write(Buffer.from(bytes ?? []));
    if (end) this.pending += this.decoder.end();
    if (Buffer.byteLength(this.pending) > 1024*1024) throw new Error('dictation_response_limit');
    const lines = this.pending.split('\n'); this.pending = lines.pop();
    if (end && this.pending.trim()) { lines.push(this.pending); this.pending = ''; }
    for (const line of lines) {
      if (!line.trim() || this.final) continue;
      let value; try { value = JSON.parse(line); } catch { throw new Error('dictation_protocol_error'); }
      if (value.type === 'error') throw new Error('dictation_rejected');
      if (value.type === 'final') {
        const text = value.text ?? '';
        if (typeof text !== 'string' || text.length > 8000) throw new Error('dictation_protocol_error');
        this.final = true; this.onFinal(text.trim());
      }
      // Partial transcripts are intentionally not treated as confirmed input.
    }
    if (end && !this.final) throw new Error('dictation_missing_final');
  }
}
module.exports = { toDictationPCM, DictationDecoder, RATE, MAX_SECONDS };
