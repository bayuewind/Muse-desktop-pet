'use strict';
const { EventEmitter } = require('node:events');
const { NativeAuth } = require('./auth.cjs');
const { NativeGateway, pinnedStandardVerifier } = require('./gateway-client.cjs');
const { NativeStatus } = require('./status.cjs');
const { reauthenticateStandardPeer } = require('./peer-renewal.cjs');
class NativeSource extends EventEmitter {
  constructor(vault) {
    super(); this.vault = vault; this.state = new NativeStatus(); this.generation = 0;
    this.client = null; this.timers = new Set(); this.retryTimer = null; this.running = false; this.lastLog = '';
  }
  publish() {
    const view = this.state.view(); this.emit('state', view);
    const log = JSON.stringify({ kind: view.kind, label: view.label, detail: view.detail, schedules: view.schedules, recentRuns: view.recentRuns });
    if (log !== this.lastLog) { this.lastLog = log; console.log(`NATIVE_STATE ${log}`); }
  }
  async start() {
    this.running = true; const generation = ++this.generation;
    this.state.reset('connecting'); this.publish();
    void this.connect(generation, 1000);
  }
  interval(fn, ms) { const timer = setInterval(fn, ms); this.timers.add(timer); return timer; }
  clearTimers() { for (const timer of this.timers) clearInterval(timer); this.timers.clear(); clearTimeout(this.retryTimer); }
  async connect(generation, retry) {
    if (!this.running || generation !== this.generation) return;
    const client = new NativeGateway(); this.client = client;
    let auth, closedReason = 'connection_failed';
    const closed = new Promise(resolve => client.once('closed', reason => { closedReason = reason; resolve(); }));
    const current = () => this.running && generation === this.generation;
    let pollBusy = false, pingBusy = false;
    client.on('status-event', (event, payload, meta) => {
      if (!current()) return;
      if (event === 'agent.status') this.state.agent(payload, meta);
      this.publish();
    });
    try {
      auth = new NativeAuth(this.vault);
      const policy = auth.bundle.peerPolicy;
      const credentials = await auth.credentials();
      if (!current()) return;
      await client.connect(credentials, pinnedStandardVerifier(policy));
      if (!current()) return;
      const ping = async () => {
        if (!current() || pingBusy) return; pingBusy = true;
        try { await client.request('connection.ping'); if (current()) this.state.heartbeat(); }
        catch { client.close('heartbeat_failed'); }
        finally { pingBusy = false; if (current()) this.publish(); }
      };
      await ping();
      const poll = async () => {
        if (!current() || pollBusy) return; pollBusy = true;
        try {
          const [runs, schedules, subagents] = await Promise.all([
            client.request('tasks.runs', { limit: 100 }), client.request('tasks.list'), client.request('subagents.list'),
          ]);
          if (current()) {
            this.state.polls({ runs, schedules, subagents });
            if (!this.scheduleLogged) {
              this.scheduleLogged = true;
              const view = this.state.view();
              console.log(JSON.stringify({ step: 'native_schedule_snapshot', enabled: view.schedules,
                recentRuns: view.recentRuns, nextRunInSeconds: view.nextRunInSeconds }));
            }
          }
        } catch { if (current()) this.state.pollAt = 0; }
        finally { pollBusy = false; if (current()) this.publish(); }
      };
      await Promise.all(['chat.subscribe','activity.subscribe','tasks.subscribe'].map(method => client.request(method)));
      await poll();
      if (!current()) return;
      this.interval(() => void ping(), 15000);
      this.interval(() => void poll(), 10000);
      this.interval(() => { if (current()) this.publish(); }, 2000);
      // Renewal is ordinary native HTTPS and never opens a browser.
      this.interval(() => { void auth.renewSession().catch(error => {
        if (error.message === 'authorization_required') client.close('authorization_required');
        else if (error.message === 'vm_assignment_changed') client.close('server_identity_mismatch');
        else if (error.message === 'credentials_repaired') client.close('credentials_repaired');
      }); }, 10 * 60 * 1000);
      await closed;
    } catch (error) {
      closedReason = error.message;
      if (current() && error.message === 'server_identity_mismatch' && error.candidateKeyHex && auth) {
        this.state.reset('identity_error'); this.publish();
        try {
          await reauthenticateStandardPeer(this.vault, auth, error.candidateKeyHex, { current });
          closedReason = 'peer_reauthenticated';
          console.log(JSON.stringify({ step: 'standard_vm_reauthenticated', vmMatched: true, freshToken: true, freshChallenge: true, pingVerified: true }));
        } catch { closedReason = 'server_identity_mismatch'; }
      }
    }
    finally { client.close(closedReason); if (current()) this.clearTimers(); }
    if (!current()) return;
    const safeReasons = new Set(['server_identity_mismatch','verified_peer_policy_required','attestation_verifier_required',
      'vm_assignment_changed','authorization_required','credential_decryption_failed','os_encryption_unavailable',
      'auth_network_error','gateway_closed','request_timeout','handshake_failed','gateway_protocol_error','peer_reauthenticated']);
    console.log(JSON.stringify({ step: 'native_connection_stopped', reason: safeReasons.has(closedReason) ? closedReason : 'connection_error' }));
    const identity = ['server_identity_mismatch','verified_peer_policy_required','attestation_verifier_required','vm_assignment_changed'].includes(closedReason);
    const authRequired = ['authorization_required','credential_decryption_failed','os_encryption_unavailable'].includes(closedReason);
    this.state.reset(identity ? 'identity_error' : authRequired ? 'authorization_required' : closedReason === 'peer_reauthenticated' ? 'connecting' : 'disconnected'); this.publish();
    if (!identity && !authRequired) this.retryTimer = setTimeout(() => void this.connect(generation, Math.min(30000, retry*2)), retry);
  }
  async reload() { await this.stop(); return this.start(); }
  async pause() { await this.stop(); this.state.reset('suspended'); this.publish(); }
  async stop() {
    this.running = false; this.generation++; this.clearTimers(); this.client?.close(); this.client = null;
  }
}
module.exports = { NativeSource };
