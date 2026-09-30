'use strict';
// Headless Muse → AI Passport bridge.
//
// Reuses the desktop pet's native Muse connection unchanged (NativeSource:
// renewal, gateway token, Noise channel, heartbeat, polling, reconnect) with a
// server-side vault, maps its status view to avatar states and pushes them to
// the device gateway. No browser, no Electron. Never logs cookies, tokens or
// chat content: NativeSource itself only prints redacted NATIVE_STATE lines.
//
// It also carries the all-voice loop for the device gateway: POST /transcribe
// (Muse's own dictation) and POST /send (a chat message to Muse), and it
// forwards each finished Muse reply to the gateway (POST /muse-reply), which
// speaks it and updates the device's reply card.
//
// Env: MUSE_VAULT_KEY (base64, 32 bytes), DATA_DIR (default /data),
//      DEVICE_GATEWAY_URL (e.g. http://host.docker.internal:8003), PORT (8787),
//      BRIDGE_TOKEN (optional bearer token required on POST routes),
//      TZ (time zone of the "下个任务 HH:MM" line).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CredentialVault } = require('../desktop-pet/native/vault.cjs');
const { NativeSource } = require('../desktop-pet/native/source.cjs');
const { createServerSafeStorage } = require('./server-safe-storage.cjs');
const { toDeviceState, detailFor } = require('./state-map.cjs');
const { DevicePusher } = require('./device-pusher.cjs');

const log = entry => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

function main() {
  const dataDir = process.env.DATA_DIR || '/data';
  const port = Number(process.env.PORT || 8787);
  const storage = createServerSafeStorage();
  const vault = new CredentialVault(dataDir, storage);
  const pusher = new DevicePusher({ gatewayUrl: process.env.DEVICE_GATEWAY_URL, log });
  const source = new NativeSource(vault);
  let view = null;
  let mapped = null;
  let workingSince = null;
  const startedAt = Date.now();
  const gatewayUrl = process.env.DEVICE_GATEWAY_URL.replace(/\/+$/, '');
  const token = process.env.BRIDGE_TOKEN || '';

  if (storage.problem) log({ step: 'vault_unavailable', reason: storage.problem });
  if (!vault.exists()) log({ step: 'authorization_required', detail: 'run server/pair-for-server.cjs on the Mac' });

  source.on('state', next => {
    view = next;
    const result = toDeviceState(next, source.state?.subagents ?? 0);
    const busy = result.state === 'working' || result.state === 'making_something';
    workingSince = busy ? (workingSince ?? Date.now()) : null;
    const detail = detailFor(result, next, { workingSince });
    if (detail) result.detail = detail;
    if (mapped?.state !== result.state || mapped?.subagents !== result.subagents) {
      log({ step: 'muse_state', kind: next.kind, label: next.label, device: result.state,
        subagents: result.subagents ?? 0, reason: result.reason });
    }
    mapped = result;
    void pusher.update(result);
  });
  // Forward each finished assistant reply once. Replies older than the bridge
  // (chat history loaded on connect) are never spoken.
  const forwarded = new Set();
  source.on('replies', snapshot => {
    for (const message of snapshot?.messages ?? []) {
      if (message.role !== 'assistant' || message.state !== 'done' || forwarded.has(message.id)) continue;
      if (!(message.createdAt >= startedAt)) { forwarded.add(message.id); continue; }
      forwarded.add(message.id);
      const attachments = (message.attachments ?? []).map(({ kind, name, mime, size }) => ({ kind, name, mime, size }));
      void fetch(`${gatewayUrl}/muse-reply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: message.id, text: message.text ?? '', attachments, createdAt: message.createdAt }),
        signal: AbortSignal.timeout(15_000),
      }).then(r => log({ step: 'reply_forwarded', ok: r.ok, chars: (message.text ?? '').length,
        attachments: attachments.length }))
        .catch(error => log({ step: 'reply_forward_failed', error: String(error?.message ?? error) }));
    }
  });
  source.on('chat-event', () => {});

  // NativeSource stops retrying after authorization / server identity errors.
  // Re-pairing writes a new vault file: reconnect when it changes instead of
  // requiring a container restart. The running session also rewrites the
  // vault (cookie rotation on connect and renewal), so only reload while the
  // source has given up; otherwise that write would trigger a reconnect loop.
  const vaultFile = path.join(dataDir, 'native-session.enc');
  let vaultStamp = stamp(vaultFile);
  const stopped = () => view?.kind === 'login' || view?.label === '服务器身份待核验';
  const watch = setInterval(() => {
    const next = stamp(vaultFile);
    if (next === vaultStamp) return;
    vaultStamp = next;
    if (stopped()) {
      log({ step: 'vault_changed', present: next !== null });
      void source.reload();
    }
  }, 30_000);
  const resync = setInterval(() => void pusher.tick(), 15_000);

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') { void handlePost(req, res); return; }
    const body = req.url === '/healthz' ? { ok: true }
      : req.url === '/state' ? {
        muse: view && { kind: view.kind, label: view.label, detail: view.detail, schedules: view.schedules,
          recentRuns: view.recentRuns },
        device: mapped, push: pusher.snapshot(), vaultPresent: vault.exists(), vaultProblem: storage.problem,
      } : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body ?? { error: 'not_found' }));
  });
  // POST /transcribe {sample_rate, pcm16: base64 LE} -> Muse dictation text.
  // POST /send {text} -> one chat message to Muse (never retried automatically).
  async function handlePost(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req, 4 * 1024 * 1024)); } catch { return reply(400, { error: 'bad_request' }); }
    if (req.url === '/transcribe') {
      const pcm = Buffer.from(String(body.pcm16 ?? ''), 'base64');
      const rate = Number(body.sample_rate);
      if (!pcm.length || pcm.length % 2 || !Number.isInteger(rate)) return reply(400, { error: 'bad_audio' });
      const floats = new Float32Array(pcm.length / 2);
      for (let i = 0; i < floats.length; i += 1) floats[i] = pcm.readInt16LE(i * 2) / 32768;
      pcm.fill(0);
      const result = await source.transcribeAudio({ sampleRate: rate, samples: floats.buffer });
      log({ step: 'dictation', status: result.status, reason: result.reason, chars: result.text?.length ?? 0 });
      return reply(200, result.status === 'transcribed' && !result.text?.trim()
        ? { status: 'error', reason: 'no_text' } : result);
    }
    if (req.url === '/send') {
      const text = String(body.text ?? '').trim();
      if (!text) return reply(400, { error: 'empty_text' });
      const result = await source.submitTask({ id: randomUUID(), text });
      log({ step: 'chat_sent', status: result.status, reason: result.reason, chars: text.length });
      return reply(200, result);
    }
    return reply(404, { error: 'not_found' });
  }

  server.listen(port, () => log({ step: 'bridge_listening', port }));

  const shutdown = async () => {
    clearInterval(watch); clearInterval(resync); server.close();
    await source.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  void source.start();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function stamp(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
}

if (require.main === module) main();
