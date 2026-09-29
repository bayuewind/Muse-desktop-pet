'use strict';
const { EventEmitter } = require('node:events');
const { NativeAuth } = require('./auth.cjs');
const { NativeGateway, pinnedStandardVerifier } = require('./gateway-client.cjs');
const { NativeStatus } = require('./status.cjs');
const { reauthenticateStandardPeer } = require('./peer-renewal.cjs');
const { OutgoingTasks } = require('./outgoing.cjs');
const { toDictationPCM } = require('./audio.cjs');
const { ReplyStore } = require('./replies.cjs');
const { readAttachment } = require('./attachments.cjs');
class NativeSource extends EventEmitter {
  constructor(vault) {
    super(); this.vault = vault; this.state = new NativeStatus(); this.generation = 0;
    this.client = null; this.timers = new Set(); this.retryTimer = null; this.running = false; this.lastLog = '';
    this.outgoing = new OutgoingTasks();
    this.replies = new ReplyStore(() => {
      if (this.replyTimer) return;
      this.replyTimer = setTimeout(() => { this.replyTimer = null; this.emit('replies', this.replies.snapshot()); }, 100);
    });
    this.assetCache = new Map(); this.assetCacheBytes = 0;
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
    const epoch = this.connectionEpoch = (this.connectionEpoch ?? 0) + 1;
    let auth, closedReason = 'connection_failed';
    const closed = new Promise(resolve => client.once('closed', reason => { closedReason = reason; resolve(); }));
    const current = () => this.running && generation === this.generation;
    let pollBusy = false, pingBusy = false;
    client.on('chat-event', (type, payload, meta) => {
      if (current()) {
        const context = { ...meta, epoch };
        this.replies.ingest(type, payload, context);
        this.emit('chat-event', type, payload, context);
      }
    });
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
      try { const startedAt = Date.now(); const history = await client.request('chat.history', { limit: 20 }); if (current()) this.replies.history(history, startedAt); } catch {}
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
    this.replies.interrupted();
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
  async refreshReplies() {
    const client = this.client, generation = this.generation;
    if (!client?.ready || client.closed) return { ok: false };
    try { const startedAt = Date.now(); const history = await client.request('chat.history', { limit: 20 });
      if (generation !== this.generation) return { ok: false };
      this.replies.history(history, startedAt); return { ok: true };
    } catch { return { ok: false }; }
  }
  async attachment(messageId, assetId) {
    const attachment = this.replies.asset(messageId, assetId);
    if (!attachment) throw new Error('attachment_not_registered');
    const key = `${messageId}:${assetId}`, cached = this.assetCache.get(key);
    if (cached && Date.now()-cached.at < 60000) return cached.value;
    if (!this.client?.ready || this.client.closed) throw new Error('not_connected');
    const generation = this.generation;
    const value = await readAttachment(this.client, attachment);
    if (generation !== this.generation) throw new Error('connection_changed');
    if (cached) { this.assetCacheBytes -= cached.value.size; this.assetCache.delete(key); }
    while (this.assetCache.size >= 8 || this.assetCacheBytes + value.size > 32*1024*1024) {
      const oldest = this.assetCache.keys().next().value;
      if (!oldest) break;
      this.assetCacheBytes -= this.assetCache.get(oldest).value.size; this.assetCache.delete(oldest);
    }
    this.assetCache.set(key, { value, at: Date.now() }); this.assetCacheBytes += value.size;
    return value;
  }
  submitTask(draft) {
    const client = this.client, generation = this.generation;
    return this.outgoing.submit(draft, {
      canSend: () => this.running && generation === this.generation && client?.ready && !client.closed && this.state.phase === 'connected' &&
        !['unknown','login','syncing','approval','limited'].includes(this.state.view().kind),
      dispatch: payload => client.sendChat(payload),
    });
  }
  async transcribeAudio(audio) {
    if (!this.running || !this.client?.ready || this.voiceInProgress) {
      if (audio?.samples instanceof ArrayBuffer) new Uint8Array(audio.samples).fill(0);
      return { status: 'error', reason: 'not_connected_or_busy' };
    }
    this.voiceInProgress = true;
    const voiceGeneration = this.voiceGeneration = (this.voiceGeneration ?? 0) + 1;
    const generation = this.generation; let pcm, voice;
    try {
      pcm = toDictationPCM(audio);
      const auth = new NativeAuth(this.vault), credentials = await auth.credentials();
      if (!this.running || generation !== this.generation || voiceGeneration !== this.voiceGeneration) return { status: 'error', reason: 'cancelled' };
      voice = new NativeGateway(); this.voiceClient = voice;
      await voice.connect(credentials, pinnedStandardVerifier(this.vault.load().peerPolicy));
      if (!this.running || generation !== this.generation || voiceGeneration !== this.voiceGeneration) return { status: 'error', reason: 'cancelled' };
      const text = await voice.transcribePCM(pcm);
      return { status: 'transcribed', text };
    } catch { return { status: 'error', reason: 'dictation_failed' }; }
    finally {
      voice?.close(); pcm?.fill(0);
      if (audio?.samples instanceof ArrayBuffer) new Uint8Array(audio.samples).fill(0);
      if (this.voiceClient === voice) this.voiceClient = null;
      if (voiceGeneration === this.voiceGeneration) this.voiceInProgress = false;
    }
  }
  cancelDictation() {
    this.voiceGeneration = (this.voiceGeneration ?? 0) + 1;
    this.voiceClient?.close('dictation_cancelled'); this.voiceClient = null; this.voiceInProgress = false;
  }
  async pause() { await this.stop(); this.state.reset('suspended'); this.publish(); }
  async stop() {
    this.running = false; this.generation++; this.clearTimers(); this.client?.close(); this.client = null;
    this.cancelDictation();
    this.replies.interrupted();
  }
}
module.exports = { NativeSource };
