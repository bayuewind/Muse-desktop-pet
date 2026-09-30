'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { SystemNetwork } = require('../system-network.cjs');
const { LoginDiagnostics } = require('../diagnostics.cjs');
const { NativeGateway } = require('../native/gateway-client.cjs');

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}
test('real loopback proxy integration: TLS, HTTP CONNECT, SOCKS5, WSS and fail-closed behavior', { timeout: 30000 }, async t => {
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  try { execFileSync(openssl, ['version'], { windowsHide: true, stdio: 'ignore' }); }
  catch { t.skip('OpenSSL required to generate temporary test-only certificates'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-proxy-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '2', '-subj', '/CN=localhost', '-addext',
    'subjectAltName=DNS:localhost,DNS:muse.ai,DNS:hatch.metaaivm.com,IP:127.0.0.1'],
  { windowsHide: true, stdio: 'ignore' });
  const cert = fs.readFileSync(certPath), key = fs.readFileSync(keyPath);
  let originRequests = 0, upgrades = 0, noiseFrames = 0;
  const origin = https.createServer({ key, cert }, (request, response) => {
    originRequests++;
    if (request.url === '/large') { response.end(Buffer.alloc(1024 * 1024 + 1)); return; }
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://must-not-follow.invalid/' }); response.end(); return; }
    response.setHeader('Set-Cookie', ['hatch_sess=synthetic-new; Secure; Path=/', 'hatch_other=synthetic; Secure; Path=/']);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, cookieReceived: request.headers.cookie === 'hatch_sess=synthetic' }));
  });
  const originPort = await listen(t, origin);
  const wss = new WebSocketServer({ server: origin });
  t.after(() => wss.close());
  wss.on('connection', (socket, request) => {
    upgrades++; assert.equal(request.headers.origin, 'https://muse.ai');
    socket.once('message', () => { noiseFrames++; socket.close(); });
  });
  const connects = [];
  const proxy = http.createServer();
  proxy.on('connect', (request, client, head) => {
    connects.push({ target: request.url, headers: request.headers });
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(t, proxy);
  const log = new LoginDiagnostics({ version: '0.2.2' });
  const network = new SystemNetwork({
    resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}; DIRECT`, diagnostic: event => log.record(event),
    requestImpl: (url, options, callback) => https.request(url, { ...options, ca: cert }, callback),
  });
  await t.test('HTTPS request actually uses CONNECT and preserves session cookies over verified TLS', async () => {
    const response = await network.fetch('https://muse.ai/api/session',
      { headers: { Cookie: 'hatch_sess=synthetic' }, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); assert.equal((await response.json()).cookieReceived, true);
    assert.equal(response.headers.getSetCookie().length, 2);
    assert.equal(connects[0].target, 'muse.ai:443');
    assert.equal(connects[0].headers.cookie, undefined);
    assert.equal(connects[0].headers.authorization, undefined);
  });
  await t.test('actual NativeGateway WebSocket connects through the same system-proxy adapter', async () => {
    const client = new NativeGateway({ connection: async (url, signal) => {
      const choice = await network.connection(url, 'wss', signal);
      choice.agent.options.ca = cert; // Trust only this temporary fixture, never disable TLS validation.
      return choice;
    } });
    try {
      await assert.rejects(client.connect({ vmId: 'fixture', authToken: 'synthetic-token' }, async () => true), /gateway_closed|handshake_failed/);
      assert.equal(upgrades, 1); assert.equal(noiseFrames, 1);
      assert.equal(connects[1].target, 'hatch.metaaivm.com:443');
      assert.doesNotMatch(JSON.stringify(log.report()), /synthetic-token|127\.0\.0\.1|hatch\.metaaivm/);
    } finally { client.close(); }
  });
  await t.test('certificate verification is not disabled for proxy traffic', async () => {
    const untrusted = new SystemNetwork({ resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}` });
    await assert.rejects(untrusted.fetch('https://muse.ai/api/session', { signal: AbortSignal.timeout(3000) }),
      error => error.message === 'auth_network_error' && /SELF_SIGNED/.test(error.networkCode));
  });
  await t.test('redirects remain manual, response sizes are bounded', async () => {
    const before = originRequests;
    const response = await network.fetch('https://muse.ai/redirect', { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 302); assert.equal(originRequests, before + 1);
    await assert.rejects(network.fetch('https://muse.ai/large', { signal: AbortSignal.timeout(3000) }), /network_response_limit/);
  });
  await t.test('refused proxy never falls back to reachable direct origin', async () => {
    const refused = net.createServer(); const refusedPort = await new Promise(resolve => refused.listen(0, '127.0.0.1', () => resolve(refused.address().port)));
    await new Promise(resolve => refused.close(resolve));
    const broken = new SystemNetwork({ resolveProxy: async () => `PROXY 127.0.0.1:${refusedPort}; DIRECT`,
      requestImpl: (url, options, callback) => https.request(url, { ...options, ca: cert }, callback) });
    const before = originRequests;
    await assert.rejects(broken.fetch(`https://127.0.0.1:${originPort}/`, { signal: AbortSignal.timeout(3000) }), /auth_network_error/);
    assert.equal(originRequests, before);
  });
  await t.test('aborting a stalled CONNECT closes its pending proxy socket', async () => {
    let closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const stalled = http.createServer();
    stalled.on('connect', (_request, socket) => {
      socket.resume();
      // Upgraded HTTP server sockets allow half-open connections; close on the client's FIN.
      socket.on('end', () => socket.end());
      socket.on('close', closed);
    });
    const port = await listen(t, stalled);
    const transport = new SystemNetwork({ resolveProxy: async () => `PROXY 127.0.0.1:${port}` });
    await assert.rejects(transport.fetch('https://muse.ai/api/session', { signal: AbortSignal.timeout(100) }), /auth_network_error/);
    let timer;
    try { await Promise.race([disconnected, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('proxy_socket_not_closed')), 1000);
    })]); } finally { clearTimeout(timer); }
  });
  await t.test('proxy authentication rejection returns 407 and never exposes the origin cookie to proxy', async () => {
    let headers;
    const rejected = http.createServer();
    rejected.on('connect', (request, socket) => {
      headers = request.headers;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    });
    const port = await listen(t, rejected);
    const transport = new SystemNetwork({ resolveProxy: async () => `PROXY 127.0.0.1:${port}` });
    const response = await transport.fetch('https://muse.ai/api/session',
      { headers: { Cookie: 'PRIVATE_COOKIE' }, signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 407); assert.equal(headers.cookie, undefined);
  });
  await t.test('SOCKS5 sends destination hostname to proxy instead of resolving locally', async () => {
    let destination;
    const socks = net.createServer(client => {
      let state = 0, buffer = Buffer.alloc(0);
      client.on('error', () => {});
      const received = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (state === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]); state = 1; client.write(Buffer.from([5, 0]));
        }
        if (state !== 1 || buffer.length < 5) return;
        assert.equal(buffer[3], 3);
        const length = buffer[4];
        if (buffer.length < 7 + length) return;
        destination = buffer.subarray(5, 5 + length).toString();
        state = 2; client.removeListener('data', received);
        const pending = buffer.subarray(7 + length);
        const upstream = net.connect(originPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          if (pending.length) upstream.write(pending);
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
      };
      client.on('data', received);
    });
    const port = await listen(t, socks);
    const transport = new SystemNetwork({ resolveProxy: async () => `SOCKS5 127.0.0.1:${port}`,
      requestImpl: (url, options, callback) => https.request(url, { ...options, ca: cert }, callback) });
    assert.equal((await transport.fetch('https://muse.ai/api/session', { signal: AbortSignal.timeout(3000) })).status, 200);
    assert.equal(destination, 'muse.ai');
  });
});
