'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_FILE = 16*1024*1024;
function attachmentPath(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\\\x00-\x1f]/.test(input)) return null;
  let decoded; try { decoded = decodeURIComponent(input); } catch { return null; }
  if (/[\\\x00-\x1f]/.test(decoded)) return null;
  if (/%[a-f0-9]{2}/i.test(decoded) || /(^|\/)\.\.(\/|$)/.test(decoded)) return null;
  if (decoded.startsWith('sandbox://')) {
    try { const u = new URL(decoded); if (u.search || u.hash) return null; decoded = u.host + decodeURIComponent(u.pathname); }
    catch { return null; }
  }
  else if (decoded.startsWith('sandbox:/')) decoded = decoded.slice('sandbox:'.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || /[?#]/.test(decoded)) return null;
  decoded = decoded.replace(/^\/+/, '');
  if (!decoded.startsWith('workspace/') && !decoded.startsWith('mnt/data/')) return null;
  if (decoded.split('/').some(part => ['.ssh','.aws','.gnupg','id_rsa','id_ed25519','credentials.json'].includes(part) || /^\.env(?:$|\.)/.test(part) && !part.endsWith('.example'))) return null;
  const normalized = path.posix.normalize(decoded);
  return normalized === decoded && !decoded.endsWith('/') ? decoded : null;
}
function kindFor(name) {
  const extension = path.posix.extname(name).toLowerCase();
  if (['.png','.jpg','.jpeg','.gif','.webp'].includes(extension)) return 'image';
  if (['.wav','.mp3','.m4a','.ogg','.opus'].includes(extension)) return 'audio';
  if (['.py','.js','.ts','.jsx','.tsx','.json','.md','.txt','.csv','.sh','.html','.css','.svg','.xml','.yaml','.yml','.sql','.c','.h','.cpp','.rs','.go'].includes(extension)) return 'code';
  return 'file';
}
function normalizeAttachment(resource) {
  if (!resource || typeof resource !== 'object') return null;
  const filePath = attachmentPath(resource.path ?? resource.file_path ?? resource.image_path);
  if (!filePath) return null;
  const name = path.posix.basename(filePath).slice(0, 240);
  return { id: createHash('sha256').update(filePath).digest('hex').slice(0, 24), path: filePath, name,
    kind: kindFor(name), size: Number.isSafeInteger(resource.byte_len ?? resource.size) ? (resource.byte_len ?? resource.size) : null };
}
function extractAttachments(payload, content = '') {
  const output = new Map();
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => walk(item, depth+1)); return; }
    const attachment = normalizeAttachment(value); if (attachment) output.set(attachment.id, attachment);
    for (const key of ['data','file','files','images','audio','media','resources','attachments','payload','presentations','widgets','delivery','voiceover','transcript','messages','content']) if (value[key]) walk(value[key], depth+1);
  }
  walk(payload);
  const visibleText = content.replace(/```[\s\S]*?```/g, '');
  for (const match of visibleText.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const attachment = normalizeAttachment({ path: match[1].trim() }); if (attachment) output.set(attachment.id, attachment);
  }
  return [...output.values()].slice(0, 30);
}
function sniffMime(bytes, name) {
  const ext = path.posix.extname(name).toLowerCase();
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) {
    const width=bytes.readUInt32BE(16), height=bytes.readUInt32BE(20);
    if (!width || !height || width*height > 32*1024*1024) throw new Error('image_dimensions_limit');
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())) return 'image/gif';
  if (bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') return 'image/webp';
  if (bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WAVE') return 'audio/wav';
  if (ext === '.mp3' && (bytes.subarray(0,3).toString()==='ID3' || bytes[0]===255 && (bytes[1]&224)===224)) return 'audio/mpeg';
  if (['.ogg','.opus'].includes(ext) && bytes.subarray(0,4).toString()==='OggS') return 'audio/ogg';
  if (ext === '.m4a' && bytes.subarray(4,8).toString()==='ftyp') return 'audio/mp4';
  return 'application/octet-stream';
}
async function readAttachment(client, attachment) {
  const filePath = attachmentPath(attachment?.path);
  if (!filePath) throw new Error('attachment_path_not_allowed');
  const stat = await client.request('fs.stat', { path: filePath });
  if (stat.kind !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FILE) throw new Error('attachment_size_or_type_limit');
  if (Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size !== stat.size) throw new Error('attachment_changed_since_reply');
  const parts = []; let offset = 0, eof = false;
  while (!eof) {
    const len = Math.min(512*1024, Math.max(1, stat.size-offset+1));
    const data = await client.request('fs.read', { path: filePath, offset, len });
    if (!Number.isSafeInteger(data.len) || data.len < 0 || data.len > len || offset+data.len > stat.size ||
      typeof data.data_base64 !== 'string' || data.data_base64.length !== 4*Math.ceil(data.len/3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data_base64)) throw new Error('attachment_read_invalid');
    const part = Buffer.from(data.data_base64, 'base64');
    if (part.length !== data.len || part.toString('base64') !== data.data_base64) throw new Error('attachment_read_invalid');
    parts.push(part); offset += part.length; eof = data.eof === true;
    if (!eof && part.length === 0) throw new Error('attachment_read_stalled');
  }
  if (offset !== stat.size) throw new Error('attachment_changed_during_read');
  const bytes = Buffer.concat(parts), mime = sniffMime(bytes, attachment.name);
  return { bytes, mime, size: bytes.length, name: attachment.name, kind: attachment.kind };
}
module.exports = { attachmentPath, normalizeAttachment, extractAttachments, readAttachment, sniffMime, kindFor, MAX_FILE };
