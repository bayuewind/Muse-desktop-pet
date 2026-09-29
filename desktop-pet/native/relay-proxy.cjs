'use strict';
// SSH ProxyCommand: WebSocket carries encrypted SSH bytes, never terminal logs.
// Credentials are inherited via the environment, not argv or query strings.
const WebSocket = require('ws');

function run() {
  const token = process.env.RELAY_TOKEN;
  let url;
  try { url = new URL(process.env.MUSE_RELAY_URL); } catch { process.stderr.write('relay_config_missing\n'); process.exit(1); }
  if (!token || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    process.stderr.write('relay_config_invalid\n'); process.exit(1);
  }
  url.protocol = 'wss:'; url.pathname = '/client';
  let paired = false, stopped = false;
  process.stdin.pause();
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 12000, maxPayload: 2 * 1024 * 1024, followRedirects: false });
  const deadline = setTimeout(() => stop(1, 'relay_pair_timeout'), 25000);
  const heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30000);
  const drain = setInterval(() => { if (paired && ws.bufferedAmount < 65536) process.stdin.resume(); }, 50);
  function stop(code, reason) {
    if (stopped) return;
    stopped = true; clearTimeout(deadline); clearInterval(heartbeat); clearInterval(drain);
    if (reason) process.stderr.write(`${reason}\n`);
    ws.terminate(); process.exit(code);
  }
  ws.on('message', (data, binary) => {
    if (!paired) {
      if (binary) return stop(1, 'relay_pair_protocol_error');
      try { if (JSON.parse(data.toString()).type !== 'paired') return stop(1, 'relay_pair_protocol_error'); }
      catch { return stop(1, 'relay_pair_protocol_error'); }
      paired = true; clearTimeout(deadline); process.stdin.resume(); return;
    }
    if (!binary) return stop(1, 'relay_unexpected_text');
    if (!process.stdout.write(data)) { ws.pause(); process.stdout.once('drain', () => ws.resume()); }
  });
  ws.on('error', () => stop(1, 'relay_transport_error'));
  ws.on('close', () => stop(0));
  process.stdin.on('data', chunk => {
    if (!paired || ws.readyState !== WebSocket.OPEN) return stop(1, 'relay_not_ready');
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > 262144) process.stdin.pause();
  });
  process.stdin.on('end', () => stop(0));
  process.stdin.on('error', () => stop(1)); process.stdout.on('error', () => stop(1));
  process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
}
if (require.main === module) run();
