'use strict';
const { Cookie, CookieJar } = require('tough-cookie');
const ORIGIN = 'https://muse.ai';
const ALLOWED_PATHS = new Set(['/api/session', '/api/hatch/token']);
const cookieAllowed = name => /^(?:(?:__Host|__Secure)-)?hatch[_-]/.test(name);
function importDedicatedCookies(cookies) {
  const jar = new CookieJar(); let count = 0;
  for (const item of cookies) {
    if (!['muse.ai', '.muse.ai'].includes(item.domain) || !cookieAllowed(item.name)) continue;
    if (!item.secure || typeof item.value !== 'string' || item.value.length > 32768) continue;
    try {
      const cookie = new Cookie({ key: item.name, value: item.value, domain: 'muse.ai',
        path: item.path || '/', secure: true, httpOnly: item.httpOnly === true,
        hostOnly: item.domain === 'muse.ai',
        expires: item.expires > 0 ? new Date(item.expires * 1000) : 'Infinity',
        sameSite: item.sameSite?.toLowerCase() });
      jar.setCookieSync(cookie, ORIGIN + cookie.path); count++;
    } catch { throw new Error('cookie_import_failed'); }
  }
  if (!count || !jar.getCookiesSync(ORIGIN).some(cookie => cookie.key === 'hatch_sess')) throw new Error('muse_session_cookie_missing');
  return { jar, count };
}
function validateTarget(target) {
  if (!target || typeof target.vmId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(target.vmId)) throw new Error('vm_identity_missing');
  const url = new URL(target.gatewayUrl);
  if (!['wss:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.metaaivm.com') || url.username || url.password || url.search || url.hash || url.port) throw new Error('invalid_gateway_target');
  return { vmId: target.vmId, vmName: target.vmName || target.vmId, gatewayUrl: url.toString() };
}
class NativeAuth {
  constructor(vault, { fetchImpl = fetch } = {}) {
    this.vault = vault; this.bundle = vault.load(); this.target = validateTarget(this.bundle.target);
    this.jar = CookieJar.deserializeSync(this.bundle.cookieJar); this.fetch = fetchImpl;
    this.token = null; this.lastSessionRenewal = 0;
  }
  persist() {
    const latest = this.vault.load();
    if (latest.pairedAt !== this.bundle.pairedAt) throw new Error('credentials_repaired');
    if (latest.target.vmId !== this.target.vmId) throw new Error('vm_assignment_changed');
    latest.cookieJar = this.jar.serializeSync(); latest.updatedAt = Date.now();
    this.vault.save(latest); this.bundle = latest;
  }
  async request(path, body) {
    if (!ALLOWED_PATHS.has(path)) throw new Error('auth_endpoint_not_allowed');
    const url = ORIGIN + path;
    const headers = { Accept: 'application/json', Origin: ORIGIN, Referer: ORIGIN + '/',
      'User-Agent': 'MuseDesktopPet/0.2 (native status client)', Cookie: this.jar.getCookieStringSync(url) };
    // Match the authenticated first-party request contract, without copying
    // a browser fingerprint/User-Agent or relaxing TLS/origin restrictions.
    headers['Sec-Fetch-Site'] = 'same-origin';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['Sec-Fetch-Dest'] = 'empty';
    if (!headers.Cookie) throw new Error('authorization_required');
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetch(url, { method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('auth_network_error'); }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      const error = new Error('authorization_required');
      error.httpStatus = response.status;
      error.responseType = response.headers.get('content-type')?.split(';')[0];
      let hint = '';
      try {
        const data = await response.json(); hint = JSON.stringify(data).slice(0, 3000).toLowerCase();
        error.responseKeys = data && typeof data === 'object' ? Object.keys(data) : [];
        const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
        if (typeof code === 'string' && /^[a-zA-Z_ -]{1,100}$/.test(code)) error.serviceCode = code;
      } catch {}
      error.category = /csrf|cross.site|origin|fetch.metadata/.test(hint) ? 'request_origin_check'
        : /expir/.test(hint) ? 'expired_session' : /session|auth|login/.test(hint) ? 'session_rejected' : 'unspecified_rejection';
      throw error;
    }
    if (!response.ok) throw new Error('auth_service_error');
    let changed = false;
    for (const raw of response.headers.getSetCookie()) {
      try {
        const cookie = Cookie.parse(raw);
        if (cookie && cookieAllowed(cookie.key)) { this.jar.setCookieSync(cookie, url); changed = true; }
      } catch { throw new Error('invalid_session_cookie_update'); }
    }
    if (changed) this.persist();
    try { return await response.json(); } catch { throw new Error('auth_invalid_response'); }
  }
  async renewSession() {
    const session = await this.request('/api/session');
    // Fail closed if assignment changes; pairing must verify the new VM identity.
    if (session.status !== 'assigned') throw new Error('vm_assignment_unavailable');
    if (typeof session.vm_id !== 'string') throw new Error('vm_identity_unverified');
    if (session.vm_id !== this.target.vmId) throw new Error('vm_assignment_changed');
    this.lastSessionRenewal = Date.now();
    return { assigned: true, vmIdentityMatched: session.vm_id === this.target.vmId,
      vmNameMatches: session.vm_name === this.target.vmName,
      endpointMatches: session.endpoint_url === this.target.gatewayUrl,
      responseKeys: Object.keys(session), vmState: typeof session.vm_state === 'string' ? session.vm_state : null };
  }
  async credentials({ force = false } = {}) {
    if (!force && this.token && this.token.expiresAt > Date.now() + 90000) return this.token;
    if (Date.now() - this.lastSessionRenewal > 10 * 60 * 1000) await this.renewSession();
    const reply = await this.request('/api/hatch/token', { vmAddress: this.target.gatewayUrl, vmName: this.target.vmName });
    if (typeof reply.token !== 'string' || !reply.token) throw new Error('gateway_token_missing');
    let expiresAt = Date.now() + 60000;
    try {
      const payload = JSON.parse(Buffer.from(reply.token.split('.')[1], 'base64url').toString());
      if (Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
    } catch {} // exp is only a cache hint; the server validates the opaque token.
    this.token = { vmId: this.target.vmId, authToken: reply.token, notaryToken: reply.notary_token ?? undefined, expiresAt };
    return this.token;
  }
}
module.exports = { NativeAuth, importDedicatedCookies, validateTarget };
