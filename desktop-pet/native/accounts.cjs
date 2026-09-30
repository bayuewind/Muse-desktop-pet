'use strict';
const { safeFailure } = require('../diagnostics.cjs');
// Owns account lifecycle. No new credential is persisted until pairing succeeds.
class Accounts {
  constructor({ vault, makeSource, makePairing, resetViews = () => {}, changed = () => {}, clearLegacy = async () => {},
    loginPollMs = 2000, loginTimeoutMs = 15 * 60 * 1000, loginProbeTimeoutMs = 5000, now = Date.now, diagnostic = () => {} }) {
    Object.assign(this, { vault, makeSource, makePairing, resetViews, changed, clearLegacy,
      loginPollMs, loginTimeoutMs, loginProbeTimeoutMs, now, diagnostic });
    this.lastFailure = null;
    this.source = null; this.pairing = null; this.phase = 'signed_out'; this.epoch = 0;
    this.loginWatch = null; this.loginDetection = 'idle';
  }
  setPhase(phase) { this.phase = phase; this.changed(this); }
  failure(stage, error, pairing) {
    const detail = pairing?.lastFailure;
    this.lastFailure = detail ? safeFailure(detail.stage,
      { message: detail.code, httpStatus: detail.httpStatus, networkCode: detail.networkCode }) : safeFailure(stage, error);
    try { this.diagnostic({ ...this.lastFailure, status: 'failed' }); } catch {}
  }
  stopLoginWatch(status = 'idle') {
    const watch = this.loginWatch;
    this.loginWatch = null; this.loginDetection = status;
    if (watch) { clearTimeout(watch.timer); watch.cancelProbe?.(); }
  }
  watchIsCurrent(watch) {
    return !!watch && this.loginWatch === watch && this.epoch === watch.epoch &&
      this.pairing === watch.pairing && this.phase === 'awaiting_login';
  }
  scheduleLoginCheck(watch) {
    if (!this.watchIsCurrent(watch)) return;
    watch.timer = setTimeout(() => { void this.pollLogin(watch); }, this.loginPollMs);
    watch.timer.unref?.();
  }
  startLoginWatch() {
    this.stopLoginWatch();
    if (typeof this.pairing?.readiness !== 'function') return;
    const watch = this.loginWatch = { epoch: this.epoch, pairing: this.pairing,
      deadline: this.now() + this.loginTimeoutMs, checking: false };
    this.loginDetection = 'watching'; this.changed(this);
    this.scheduleLoginCheck(watch);
  }
  async pollLogin(watch = this.loginWatch) {
    if (!this.watchIsCurrent(watch) || watch.checking) return;
    clearTimeout(watch.timer);
    if (this.now() >= watch.deadline) {
      this.stopLoginWatch('timed_out'); this.changed(this); return;
    }
    watch.checking = true;
    let timeout;
    try {
      const readiness = await Promise.race([
        Promise.resolve().then(() => this.watchIsCurrent(watch) ? watch.pairing.readiness() : 'cancelled'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('login_probe_timeout')),
          Math.min(this.loginProbeTimeoutMs, Math.max(1, watch.deadline - this.now()))); }),
        new Promise(resolve => { watch.cancelProbe = () => resolve('cancelled'); }),
      ]);
      if (!this.watchIsCurrent(watch)) return;
      if (this.now() >= watch.deadline) {
        this.stopLoginWatch('timed_out'); this.changed(this); return;
      }
      if (readiness === 'ready') {
        // complete() changes phase synchronously before its first await: a
        // simultaneous manual check cannot start a second credential import.
        await this.complete();
      } else if (readiness === 'closed') {
        this.stopLoginWatch('window_closed'); this.changed(this);
      }
    } catch (error) {
      // complete() already reports verification_failed. Never retry it in a
      // loop, and never publish errors from an obsolete login generation.
      if (this.watchIsCurrent(watch)) {
        this.failure('login_probe', error);
        this.stopLoginWatch(this.now() >= watch.deadline ? 'timed_out' : 'check_failed'); this.changed(this);
      }
    } finally {
      clearTimeout(timeout); watch.cancelProbe = null; watch.checking = false;
      this.scheduleLoginCheck(watch);
    }
  }
  async restore() {
    if (this.vault.isDisabled()) this.setPhase('cleanup_failed');
    else if (this.vault.exists()) await this.activate();
    else this.setPhase('signed_out');
  }
  async activate() {
    this.source = this.makeSource(); this.setPhase('connected');
    await this.source.start();
  }
  async logout() {
    this.stopLoginWatch();
    this.lastFailure = null;
    const epoch = ++this.epoch, source = this.source, pairing = this.pairing;
    this.source = null; this.pairing = null; this.setPhase('clearing'); this.resetViews();
    try {
      // The persistent tombstone blocks startup/late renewal even if cleanup fails.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.vault.clear()), source?.stop(), pairing?.stop(), this.clearLegacy(),
      ]);
      source?.clearAccountData();
      if (results.some(result => result.status === 'rejected')) throw new Error('cleanup_failed');
      this.vault.finishClear();
      if (epoch === this.epoch) this.setPhase('signed_out');
    } catch (error) {
      if (epoch === this.epoch) { this.failure('browser_cleanup', error); this.setPhase('cleanup_failed'); }
      throw new Error('account_cleanup_failed');
    }
  }
  async login() {
    if (this.phase !== 'signed_out') throw new Error('account_not_signed_out');
    this.stopLoginWatch();
    this.lastFailure = null;
    const epoch = ++this.epoch, pairing = this.makePairing(); this.pairing = pairing;
    this.setPhase('opening_login');
    try {
      await pairing.start();
      if (epoch === this.epoch) { this.setPhase('awaiting_login'); this.startLoginWatch(); }
    } catch (error) {
      if (epoch === this.epoch) this.failure('browser_start', error, pairing);
      try { await pairing.stop(); }
      catch { if (epoch === this.epoch) this.setPhase('cleanup_failed'); throw new Error('login_cleanup_failed'); }
      if (epoch === this.epoch) { this.pairing = null; this.setPhase('signed_out'); }
      throw new Error('login_window_failed');
    }
  }
  async complete() {
    if (this.phase !== 'awaiting_login') throw new Error('login_not_ready');
    this.stopLoginWatch('verifying');
    const epoch = this.epoch, pairing = this.pairing; this.setPhase('verifying_login');
    let stage = 'account';
    this.lastFailure = null;
    try {
      const bundle = await pairing.complete();
      if (epoch !== this.epoch) return;
      // Close and clear the temporary browser profile before activating native mode.
      stage = 'browser_cleanup'; await pairing.stop();
      if (epoch !== this.epoch) return;
      stage = 'vault_save'; this.vault.save(bundle); this.pairing = null;
      this.loginDetection = 'idle';
      stage = 'source_start'; await this.activate();
    } catch (error) {
      if (epoch === this.epoch) {
        this.failure(stage, error, stage === 'account' ? pairing : null);
        this.loginDetection = 'verification_failed';
        this.setPhase(pairing.active ? 'awaiting_login' : 'cleanup_failed');
      }
      throw new Error('account_pairing_failed');
    }
  }
  async stop() {
    this.stopLoginWatch();
    ++this.epoch;
    await Promise.all([this.source?.stop(), this.pairing?.stop()]);
  }
}
module.exports = { Accounts };
