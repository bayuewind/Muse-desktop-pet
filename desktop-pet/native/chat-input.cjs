'use strict';
const MAX_FILES = 4, MAX_BYTES = 8 * 1024 * 1024;
const MIME = Object.freeze({
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  py: 'text/plain', js: 'text/plain', ts: 'text/plain', css: 'text/plain', html: 'text/html',
  log: 'text/plain', yaml: 'text/plain', yml: 'text/plain', xml: 'application/xml',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', zip: 'application/zip',
});
function filename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 ||
      /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) || ['.', '..'].includes(value))
    throw new Error('invalid_filename');
  return value;
}
function fileInfo(name, bytes) {
  filename(name);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error('attachment_size_limit');
  const extension = name.split('.').pop().toLowerCase(), mime = MIME[extension];
  if (!mime) throw new Error('attachment_type_unsupported');
  if (mime.startsWith('image/')) {
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw new Error('attachment_image_invalid');
  }
  return { filename: name, mime_type: mime, kind: mime.startsWith('image/') ? 'image' : 'file', size: bytes.length };
}
function attachmentItems(attachments) {
  if (!Array.isArray(attachments) || attachments.length > MAX_FILES) throw new Error('invalid_attachments');
  let total = 0;
  return attachments.map(attachment => {
    const info = fileInfo(attachment?.name, attachment?.bytes);
    total += info.size; if (total > MAX_BYTES) throw new Error('attachment_total_limit');
    return { type: info.kind, filename: info.filename, mime_type: info.mime_type, data_base64: attachment.bytes.toString('base64') };
  });
}
function validateChatPayload(params) {
  if (!params || typeof params !== 'object') throw new Error('invalid_message');
  if (!params.items) {
    if (typeof params.message !== 'string' || !params.message.trim() || Buffer.byteLength(params.message) > 32768)
      throw new Error('invalid_message');
    return { message: params.message, capabilities: [] };
  }
  if (!Array.isArray(params.items) || !params.items.length || params.items.length > MAX_FILES + 1) throw new Error('invalid_message');
  let total = 0, files = 0, texts = 0;
  const items = params.items.map(item => {
    if (item?.type === 'text') {
      if (++texts > 1 || typeof item.text !== 'string' || !item.text.trim() || Buffer.byteLength(item.text) > 32768) throw new Error('invalid_message');
      return { type: 'text', text: item.text };
    }
    if (!['image', 'file'].includes(item?.type) || ++files > MAX_FILES || typeof item.data_base64 !== 'string' ||
        item.data_base64.length > Math.ceil(MAX_BYTES / 3) * 4 || item.data_base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.data_base64))
      throw new Error('invalid_attachment');
    const bytes = Buffer.from(item.data_base64, 'base64');
    try {
      const info = fileInfo(item.filename, bytes);
      if (bytes.toString('base64') !== item.data_base64 || info.kind !== item.type || info.mime_type !== item.mime_type) throw new Error('invalid_attachment');
      total += bytes.length; if (total > MAX_BYTES) throw new Error('attachment_total_limit');
      return { type: info.kind, filename: info.filename, mime_type: info.mime_type, data_base64: item.data_base64 };
    } finally { bytes.fill(0); }
  });
  return { items, capabilities: [] };
}
module.exports = { MAX_FILES, MAX_BYTES, MIME, filename, fileInfo, attachmentItems, validateChatPayload };
