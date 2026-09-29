'use strict';
// Owns account lifecycle. No new credential is persisted until pairing succeeds.
class Accounts {
  constructor({ vault, makeSource, makePairing, resetViews = () => {}, changed = () => {}, clearLegacy = async () => {} }) {
    Object.assign(this, { vault, makeSource, makePairing, resetViews, changed, clearLegacy });
    this.source = null; this.pairing = null; this.phase = 'signed_out'; this.epoch = 0;
  }
  setPhase(phase) { this.phase = phase; this.changed(this); }
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
    } catch {
      if (epoch === this.epoch) this.setPhase('cleanup_failed');
      throw new Error('account_cleanup_failed');
    }
  }
  async login() {
    if (this.phase !== 'signed_out') throw new Error('account_not_signed_out');
    const epoch = ++this.epoch, pairing = this.makePairing(); this.pairing = pairing;
    this.setPhase('opening_login');
    try {
      await pairing.start();
      if (epoch === this.epoch) this.setPhase('awaiting_login');
    } catch {
      try { await pairing.stop(); }
      catch { if (epoch === this.epoch) this.setPhase('cleanup_failed'); throw new Error('login_cleanup_failed'); }
      if (epoch === this.epoch) { this.pairing = null; this.setPhase('signed_out'); }
      throw new Error('login_window_failed');
    }
  }
  async complete() {
    if (this.phase !== 'awaiting_login') throw new Error('login_not_ready');
    const epoch = this.epoch, pairing = this.pairing; this.setPhase('verifying_login');
    try {
      const bundle = await pairing.complete();
      if (epoch !== this.epoch) return;
      // Close and clear the temporary browser profile before activating native mode.
      await pairing.stop();
      if (epoch !== this.epoch) return;
      this.vault.save(bundle); this.pairing = null;
      await this.activate();
    } catch {
      if (epoch === this.epoch) this.setPhase(pairing.active ? 'awaiting_login' : 'cleanup_failed');
      throw new Error('account_pairing_failed');
    }
  }
  async stop() {
    ++this.epoch;
    await Promise.all([this.source?.stop(), this.pairing?.stop()]);
  }
}
module.exports = { Accounts };
