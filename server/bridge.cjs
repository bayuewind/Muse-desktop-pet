'use strict';
// Headless Muse → AI Passport bridge.
//
// Reuses the desktop pet's native Muse connection unchanged (NativeSource:
// renewal, gateway token, Noise channel, heartbeat, polling, reconnect) with a
// server-side vault, maps its status view to avatar states and pushes them to
// the device gateway. No browser, no Electron. Never logs cookies, tokens or
// chat content: NativeSource itself only prints redacted NATIVE_STATE lines.
//
// Env: MUSE_VAULT_KEY (base64, 32 bytes), DATA_DIR (default /data),
//      DEVICE_GATEWAY_URL (e.g. http://host.docker.internal:8003), PORT (8787).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { CredentialVault } = require('../desktop-pet/native/vault.cjs');
const { NativeSource } = require('../desktop-pet/native/source.cjs');
const { createServerSafeStorage } = require('./server-safe-storage.cjs');
const { toDeviceState } = require('./state-map.cjs');
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

  if (storage.problem) log({ step: 'vault_unavailable', reason: storage.problem });
  if (!vault.exists()) log({ step: 'authorization_required', detail: 'run server/pair-for-server.cjs on the Mac' });

  source.on('state', next => {
    view = next;
    const result = toDeviceState(next, source.state?.subagents ?? 0);
    if (mapped?.state !== result.state || mapped?.subagents !== result.subagents) {
      log({ step: 'muse_state', kind: next.kind, label: next.label, device: result.state,
        subagents: result.subagents ?? 0, reason: result.reason });
    }
    mapped = result;
    void pusher.update(result);
  });
  // Chat and replies are not forwarded anywhere; drop them without buffering.
  source.on('replies', () => {});
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
    const body = req.url === '/healthz' ? { ok: true }
      : req.url === '/state' ? {
        muse: view && { kind: view.kind, label: view.label, detail: view.detail, schedules: view.schedules,
          recentRuns: view.recentRuns },
        device: mapped, push: pusher.snapshot(), vaultPresent: vault.exists(), vaultProblem: storage.problem,
      } : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body ?? { error: 'not_found' }));
  });
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

function stamp(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
}

if (require.main === module) main();
