'use strict';
const https = require('node:https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { networkCode } = require('./diagnostics.cjs');
const PROXY_ERRORS = new Set(['proxy_resolution_failed', 'proxy_resolution_timeout', 'proxy_configuration_invalid',
  'proxy_type_unsupported', 'network_response_limit']);
function proxyChoice(result, signal) {
  if (typeof result !== 'string' || result.length > 8192) throw new Error('proxy_configuration_invalid');
  // Honor the first route. A failed proxy must never silently fall back to DIRECT.
  const first = result.split(';')[0].trim();
  if (first === 'DIRECT') return { route: 'direct', agent: new https.Agent({ keepAlive: false }) };
  const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+([^\s]+)$/.exec(first);
  if (!match) throw new Error('proxy_type_unsupported');
  const [, type, authority] = match;
  if (!/^(?:[a-zA-Z0-9._-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(authority)) throw new Error('proxy_configuration_invalid');
  const scheme = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5h' }[type];
  let url;
  try { url = new URL(`${scheme}://${authority}`); } catch { throw new Error('proxy_configuration_invalid'); }
  const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new Error('proxy_configuration_invalid');
  return { route: scheme === 'http' ? 'http_proxy' : scheme === 'https' ? 'https_proxy' : 'socks_proxy',
    agent: scheme.startsWith('socks') ? new SocksProxyAgent(url, { socketOptions: { signal } }) : new HttpsProxyAgent(url, { signal }) };
}
function boundedResolve(resolveProxy, url, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve(value);
    };
    const aborted = () => finish(signal.reason ?? new Error('proxy_resolution_failed'));
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('proxy_resolution_timeout')), timeoutMs);
    Promise.resolve().then(() => resolveProxy(url)).then(value => finish(null, value),
      () => finish(new Error('proxy_resolution_failed')));
  });
}
class SystemNetwork {
  constructor({ resolveProxy, diagnostic = () => {}, resolveTimeoutMs = 10000, requestImpl = https.request }) {
    Object.assign(this, { resolveProxy, diagnostic, resolveTimeoutMs, requestImpl });
  }
  record(value) { try { this.diagnostic(value); } catch {} }
  async connection(url, transport, signal) {
    const target = new URL(url);
    if (!['https:', 'wss:'].includes(target.protocol) || target.username || target.password) throw new Error('proxy_configuration_invalid');
    // Tokens in gateway query strings must never be disclosed to a PAC script.
    target.search = ''; target.hash = '';
    this.record({ stage: 'proxy_resolve', status: 'started', transport, proxySource: 'system' });
    try {
      const choice = proxyChoice(await boundedResolve(this.resolveProxy, target.href, signal, this.resolveTimeoutMs), signal);
      if (signal?.aborted) { choice.agent.destroy(); throw new Error('proxy_resolution_failed'); }
      this.record({ stage: 'proxy_resolve', status: 'passed', transport, proxySource: 'system', route: choice.route });
      return choice;
    } catch (error) {
      const safe = new Error(PROXY_ERRORS.has(error.message) ? error.message : 'proxy_resolution_failed');
      safe.networkCode = networkCode(error);
      this.record({ stage: 'proxy_resolve', status: 'failed', transport, proxySource: 'system',
        code: safe.message, networkCode: safe.networkCode });
      throw safe;
    }
  }
  async fetch(url, options = {}) {
    const { agent, route } = await this.connection(url, 'https', options.signal);
    try {
      return await new Promise((resolve, reject) => {
        const request = this.requestImpl(url, { method: options.method ?? 'GET', headers: options.headers,
          agent, signal: options.signal }, response => {
          const chunks = []; let bytes = 0;
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('auth_network_error')));
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) { request.destroy(new Error('network_response_limit')); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const headers = new Headers();
              for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
              const status = response.statusCode;
              this.record({ stage: 'network_request', status: 'passed', transport: 'https', route, httpStatus: status });
              resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
            } catch (error) { reject(error); }
          });
        });
        request.on('error', reject);
        // Node https.request does not follow redirects or use a browser cookie store.
        request.end(options.body);
      });
    } catch (error) {
      const safe = new Error(PROXY_ERRORS.has(error.message) ? error.message : 'auth_network_error');
      safe.networkCode = networkCode(error);
      this.record({ stage: 'network_request', status: 'failed', transport: 'https', route,
        code: safe.message, networkCode: safe.networkCode });
      throw safe;
    } finally { agent.destroy(); }
  }
}
let configured;
function configureSystemNetwork(options) { configured = new SystemNetwork(options); return configured; }
// Standalone Node diagnostics retain their existing behavior; the desktop app configures this before starting accounts.
function nativeFetch(url, options) { return configured ? configured.fetch(url, options) : fetch(url, options); }
function gatewayConnection(url, signal) {
  return configured ? configured.connection(url, 'wss', signal) : Promise.resolve({ route: 'direct', agent: undefined });
}
function networkEvent(value) { configured?.record(value); }
module.exports = { SystemNetwork, configureSystemNetwork, nativeFetch, gatewayConnection, networkEvent, proxyChoice, PROXY_ERRORS };
