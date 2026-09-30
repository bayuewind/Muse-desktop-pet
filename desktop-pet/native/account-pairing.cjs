'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ChromeEngine } = require('../chrome-engine.cjs');
const { NativeAuth, importDedicatedCookies, validateTarget } = require('./auth.cjs');
const { NativeGateway, verifyStandardBinding } = require('./gateway-client.cjs');
const { safeFailure } = require('../diagnostics.cjs');

class AccountPairing {
  constructor(directory, { makeBrowser = profile => new ChromeEngine(profile, () => {}),
    makeAuth = vault => new NativeAuth(vault), makeClient = () => new NativeGateway(), diagnostic = () => {} } = {}) {
    Object.assign(this, { directory, makeBrowser, makeAuth, makeClient, diagnostic }); this.active = true; this.profile = null;
    this.lastFailure = null;
  }
  report(value) { if (this.active) { try { this.diagnostic(value); } catch {} } }
  async step(stage, action) {
    this.check();
    this.report({ stage, status: 'started' });
    try {
      const result = await action();
      this.report({ stage, status: 'passed' }); return result;
    } catch (error) {
      if (this.active) {
        // Preserve a nested identity failure instead of replacing it with gateway failure.
        this.lastFailure ??= safeFailure(stage, error);
        this.report({ ...safeFailure(stage, error), status: 'failed' });
      }
      throw error;
    }
  }
  async start() {
    return this.step('browser_start', async () => {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.profile = fs.mkdtempSync(path.join(this.directory, 'AccountLogin-'));
      this.browser = this.makeBrowser(this.profile);
      await this.browser.start();
      try {
        const version = await this.browser.browser.version();
        const name = path.basename(this.browser.executablePath ?? '').toLowerCase();
        this.report({ stage: 'browser_start', status: 'state',
          browser: name === 'msedge.exe' ? 'edge' : /chrome/.test(name) ? 'chrome' : 'other',
          browserVersion: version.split('/').pop() });
      } catch {}
    });
  }
  check() { if (!this.active) throw new Error('pairing_cancelled'); }
  async readMetadata() {
    this.check();
    return this.browser.evaluate(`(() => {
      const host=document.querySelector('[data-hatch-avatar-host]');
      const key=host&&Object.keys(host).find(k=>k.startsWith('__reactFiber$'));
      let fiber=key?host[key]:null,target=null;const policyHints={};
      for(let depth=0;fiber&&depth<220;depth++,fiber=fiber.return){
        const value=fiber.memoizedProps?.value;if(!value||typeof value!=='object')continue;
        if(typeof value.gatewayUrl==='string'&&typeof value.vmId==='string')target={gatewayUrl:value.gatewayUrl,vmId:value.vmId,vmName:value.vmName};
        if(value.cvmBootstrap&&typeof value.cvmBootstrap==='object'&&typeof value.cvmBootstrap.rolloutStatus==='string')policyHints.bootstrap_rolloutStatus=value.cvmBootstrap.rolloutStatus;
      }
      return {target,policyHints};
    })()`);
  }
  async readiness() {
    this.check();
    const browser = this.browser;
    const waiting = readiness => { this.report({ stage: 'readiness', status: 'state', readiness }); return readiness === 'closed' ? 'closed' : 'waiting'; };
    if (!browser?.browser || !browser.page || browser.page.isClosed()) return waiting('closed');
    if (browser.httpError) return waiting('http_error');
    if (browser.origin !== 'https://muse.ai') return waiting('other_origin');
    if (browser.loading) return waiting('loading');
    try {
      const metadata = await this.readMetadata();
      this.check();
      validateTarget(metadata?.target);
      // This is only a readiness hint from our own page, not authorization.
      // Cookies, official assignment, Noise binding and ping are checked once
      // by complete(). In particular, CVM policies are never bypassed here.
      if (typeof metadata?.policyHints?.bootstrap_rolloutStatus !== 'string') return waiting('policy_missing');
      this.report({ stage: 'readiness', status: 'state', readiness: 'ready' }); return 'ready';
    } catch {
      this.check();
      // A navigating/loading React page may not yet have an assigned VM.
      return waiting('metadata_missing');
    }
  }
  async complete() {
    this.lastFailure = null;
    const metadata = await this.step('metadata', () => this.readMetadata());
    this.check();
    const target = await this.step('target', () => validateTarget(metadata?.target));
    // Unknown / confidential VM policies remain blocked, never silently bypassed.
    await this.step('vm_policy', () => {
      const policy = metadata?.policyHints?.bootstrap_rolloutStatus;
      this.report({ stage: 'vm_policy', status: 'state', policy: policy === 'disabled' ? 'standard' : typeof policy === 'string' ? 'unsupported' : 'missing' });
      if (policy !== 'disabled') throw new Error('attestation_verifier_required');
    });
    const jar = await this.step('cookies', async () => {
      const cookies = await this.browser.browser.defaultBrowserContext().cookies();
      try { return importDedicatedCookies(cookies).jar; }
      finally { for (const cookie of cookies) cookie.value = ''; }
    });
    this.check();
    let bundle = { version: 1, origin: 'https://muse.ai', target, cookieJar: jar.serializeSync(),
      policyHints: metadata.policyHints, pairedAt: Date.now(),
      authorization: { scope: 'dedicated_muse_session_only', nativeRenewal: true } };
    // Session refresh writes only this in-memory candidate until all checks pass.
    const candidate = { load: () => { this.check(); return structuredClone(bundle); },
      save: value => { this.check(); bundle = structuredClone(value); } };
    const auth = this.makeAuth(candidate), assignment = await this.step('session', () => auth.renewSession());
    this.check();
    await this.step('assignment', () => {
      this.report({ stage: 'assignment', status: 'state', vmIdentityMatched: assignment.vmIdentityMatched,
        vmNameMatches: assignment.vmNameMatches, endpointMatches: assignment.endpointMatches });
      if (!assignment.vmIdentityMatched || !assignment.vmNameMatches || !assignment.endpointMatches) throw new Error('assignment_unverified');
    });
    const credentials = await this.step('token', () => auth.credentials()); this.check();
    const client = this.client = this.makeClient();
    try {
      await this.step('gateway', () => client.connect(credentials, peer => this.step('peer_identity', () => {
        this.check(); verifyStandardBinding(peer.payload, peer.serverKey, peer.clientNonce);
        bundle.peerPolicy = { vmType: 'standard', attestationTier: 'off', binding: 'standard-nonce-v1',
          serverKeyHex: peer.serverKey.toString('hex'),
          trustSource: 'authenticated-vm-assignment+official-tls+noise-nonce-binding', pairedAt: Date.now() };
        return true;
      })));
      await this.step('ping', () => client.request('connection.ping')); this.check();
      return bundle;
    } finally { client.close(); this.client = null; }
  }
  stop() {
    this.active = false; this.client?.close();
    return this.stopping ??= this.cleanup().catch(error => { this.stopping = null; throw error; });
  }
  async cleanup() {
    await this.browser?.stop();
    if (this.profile) {
      const target = this.profile;
      if (path.dirname(target) !== this.directory || !path.basename(target).startsWith('AccountLogin-') || fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('unsafe_login_profile');
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); this.profile = null;
    }
  }
}
module.exports = { AccountPairing };
