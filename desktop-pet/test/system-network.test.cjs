'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SystemNetwork, proxyChoice } = require('../system-network.cjs');
const { LoginDiagnostics } = require('../diagnostics.cjs');
const { NativeGateway } = require('../native/gateway-client.cjs');

test('system proxy routes support direct, HTTP(S), IPv6 and SOCKS, honoring only first route', () => {
  for (const [input, expected] of [
    ['DIRECT', 'direct'], ['PROXY 127.0.0.1:7890; DIRECT', 'http_proxy'],
    ['HTTPS proxy.example:443', 'https_proxy'], ['HTTP [::1]:7890', 'http_proxy'],
    ['SOCKS5 localhost:1080', 'socks_proxy'], ['SOCKS proxy.example:1080', 'socks_proxy'],
  ]) {
    const { route, agent } = proxyChoice(input); assert.equal(route, expected); agent.destroy();
  }
  for (const invalid of ['', 'PROXY user:secret@host:8080', 'PROXY host:0', 'PROXY host:99999',
    'PROXY host:8080/path', 'QUIC host:443; DIRECT', 'PRIVATE_SECRET']) {
    assert.throws(() => proxyChoice(invalid), /proxy_(configuration_invalid|type_unsupported)/);
  }
});

test('PAC resolver receives no gateway token, logs only route enums and refreshes each request', async () => {
  const inputs = [], log = new LoginDiagnostics();
  let response = 'PROXY private-host:7890';
  const network = new SystemNetwork({ resolveProxy: async url => { inputs.push(url); return response; },
    diagnostic: event => log.record(event) });
  const first = await network.connection('wss://hatch.metaaivm.com/v1/noise?auth_token=SECRET&vm_id=PRIVATE', 'wss');
  assert.equal(first.route, 'http_proxy'); first.agent.destroy();
  response = 'DIRECT';
  const second = await network.connection('https://muse.ai/api/session', 'https'); second.agent.destroy();
  assert.equal(second.route, 'direct');
  assert.equal(inputs[0], 'wss://hatch.metaaivm.com/v1/noise');
  const output = JSON.stringify(log.report());
  assert.doesNotMatch(output, /SECRET|PRIVATE|private-host|7890|metaaivm|muse.ai/);
  assert.match(output, /http_proxy/);
});

test('failed, timed out and cancelled proxy resolution never sends a direct request', async () => {
  let requests = 0;
  for (const resolveProxy of [async () => { throw new Error('SECRET'); }, () => new Promise(() => {})]) {
    const network = new SystemNetwork({ resolveProxy, resolveTimeoutMs: 10, requestImpl: () => requests++ });
    await assert.rejects(network.fetch('https://muse.ai/api/session'), /proxy_resolution_(failed|timeout)/);
  }
  const controller = new AbortController();
  const network = new SystemNetwork({ resolveProxy: () => new Promise(() => {}), requestImpl: () => requests++ });
  const pending = network.fetch('https://muse.ai/api/session', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /proxy_resolution_failed/);
  assert.equal(requests, 0);
});

test('HTTP adapter preserves duplicate cookies, method/body and returns redirects without following', async () => {
  let calls = 0, body, captured;
  const network = new SystemNetwork({ resolveProxy: async () => 'DIRECT', requestImpl: (url, options, callback) => {
    calls++; captured = options;
    const request = new EventEmitter();
    request.end = value => {
      body = value;
      const response = new EventEmitter();
      response.statusCode = 302; response.rawHeaders = ['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Location', 'https://other.test'];
      callback(response); response.emit('end');
    };
    return request;
  } });
  const response = await network.fetch('https://muse.ai/api/hatch/token',
    { method: 'POST', headers: { Cookie: 'synthetic' }, body: '{"test":true}' });
  assert.equal(calls, 1); assert.equal(captured.method, 'POST');
  assert.equal(body, '{"test":true}'); assert.equal(response.status, 302);
  assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2']);
});

test('closing gateway while PAC is pending cannot create a late socket', async () => {
  let resolve, destroyed = false;
  const client = new NativeGateway({ connection: () => new Promise(done => { resolve = done; }) });
  const pending = client.connect({ vmId: 'fixture', authToken: 'synthetic' }, async () => true);
  await assert.rejects(client.connect({ vmId: 'fixture', authToken: 'synthetic' }, async () => true), /already_started/);
  client.close();
  resolve({ route: 'http_proxy', agent: { destroy: () => { destroyed = true; } } });
  await assert.rejects(pending, /gateway_closed/);
  assert.equal(destroyed, true); assert.equal(client.socket, null);
});

test('diagnostic report rejects arbitrary proxy addresses, credentials and route strings', () => {
  const log = new LoginDiagnostics();
  log.record({ stage: 'proxy_resolve', status: 'passed', transport: 'PRIVATE',
    route: 'http://user:SECRET@private:7890', proxySource: 'PRIVATE', proxy: 'SECRET' });
  assert.doesNotMatch(JSON.stringify(log.report()), /PRIVATE|SECRET|7890/);
});
