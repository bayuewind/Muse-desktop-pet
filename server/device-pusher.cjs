'use strict';
// Pushes the mapped avatar state to the device gateway. The gateway turns it
// into the MCP call self.avatar.set_state on every connected Passport
// (folo-ai-passport-xiaozhi scripts/sim-test/server.py: GET /avatar?state=&subagents=).
//
// A device that reboots or reconnects falls back to "syncing", so the current
// state is re-sent every resyncMs even when it has not changed. Gateway errors
// are recorded and retried on the next tick; they never touch the Muse link.

class DevicePusher {
  constructor({ gatewayUrl, fetchImpl = fetch, now = Date.now, resyncMs = 60_000, timeoutMs = 10_000,
    log = () => {} } = {}) {
    if (!gatewayUrl) throw new Error('device_gateway_url_required');
    Object.assign(this, { gatewayUrl: gatewayUrl.replace(/\/+$/, ''), fetchImpl, now, resyncMs, timeoutMs, log });
    this.current = null;   // latest mapped state from the bridge
    this.lastSent = null;  // last state the gateway accepted
    this.lastSentAt = 0;
    this.lastError = null;
    this.inFlight = null;
  }

  update(mapped) {
    this.current = mapped;
    return this.flush();
  }

  // Called periodically: retries failures and performs the resync push.
  tick() { return this.flush(); }

  due() {
    if (!this.current) return false;
    if (!this.lastSent || !sameState(this.current, this.lastSent)) return true;
    return this.now() - this.lastSentAt >= this.resyncMs;
  }

  async flush() {
    if (this.inFlight) return this.inFlight;
    if (!this.due()) return false;
    const target = this.current;
    this.inFlight = this.send(target).finally(() => { this.inFlight = null; });
    const sent = await this.inFlight;
    // A newer state may have arrived while the request was in flight.
    if (sent && !sameState(this.current, target)) return this.flush();
    return sent;
  }

  async send(target) {
    const url = new URL(`${this.gatewayUrl}/avatar`);
    url.searchParams.set('state', target.state);
    if (target.subagents) url.searchParams.set('subagents', String(target.subagents));
    if (target.detail) url.searchParams.set('detail', target.detail);
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new Error(`gateway_http_${response.status}`);
      const body = await response.json().catch(() => ({}));
      const changed = !this.lastSent || !sameState(this.lastSent, target);
      this.lastSent = target; this.lastSentAt = this.now(); this.lastError = null;
      if (changed) this.log({ step: 'device_state_pushed', state: target.state, subagents: target.subagents ?? 0,
        detail: target.detail ?? '', reason: target.reason, devices: { ws: body.ws ?? null, mqtt: body.mqtt ?? null } });
      return true;
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? 'gateway_timeout' : String(error?.message ?? error);
      if (message !== this.lastError) this.log({ step: 'device_push_failed', state: target.state, error: message });
      this.lastError = message;
      return false;
    }
  }

  snapshot() {
    return { current: this.current, lastSent: this.lastSent,
      lastSentAt: this.lastSentAt ? new Date(this.lastSentAt).toISOString() : null, lastError: this.lastError };
  }
}

function sameState(a, b) {
  return a?.state === b?.state && (a?.subagents ?? 0) === (b?.subagents ?? 0) && (a?.detail ?? '') === (b?.detail ?? '');
}

module.exports = { DevicePusher };
