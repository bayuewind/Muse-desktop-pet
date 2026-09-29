'use strict';
const BUSY = new Set(['working', 'responding', 'composing', 'compacting', 'making_something', 'waiting_for_subagents']);
const KNOWN = new Set([...BUSY, 'online', 'waiting_for_user', 'needs_approval', 'out_of_credits']);
class NativeActivityModel {
  constructor() { this.connected = false; this.heartbeatAt = 0; this.epoch = 0; this.agents = new Map(); this.completeSnapshot = false; }
  disconnect() { this.connected = false; this.heartbeatAt = 0; this.agents.clear(); this.completeSnapshot = false; this.epoch++; }
  heartbeat(now = Date.now()) { this.connected = true; this.heartbeatAt = now; }
  event(payload, metadata = {}, now = Date.now()) {
    if (!this.connected || !payload || typeof payload.agent_id !== 'string') return false;
    const id = payload.agent_id;
    if (!id || id.length > 512 || (!this.agents.has(id) && this.agents.size >= 1024)) return false;
    const old = this.agents.get(id), seq = Number.isSafeInteger(metadata.seq) ? metadata.seq : null;
    if (seq != null && old?.seq != null && seq <= old.seq) return false;
    const code = KNOWN.has(payload.activity_code) ? payload.activity_code : 'unknown';
    if (code === 'unknown') this.completeSnapshot = false;
    this.agents.set(id, { code, seq, updatedAt: now }); return true;
  }
  // Only a validated, authoritative ALL-agent snapshot may enable a global idle
  // claim. No current response schema has yet been verified, so the live adapter
  // MUST NOT call this until that schema and its coverage are established.
  authoritativeSnapshot(agents, now = Date.now()) {
    if (!this.connected || !Array.isArray(agents) || agents.length > 1024 || agents.some(a => !a || typeof a.agent_id !== 'string' || !a.agent_id || a.agent_id.length > 512 || !KNOWN.has(a.activity_code))) throw new Error('invalid_snapshot');
    const next = new Map();
    for (const agent of agents) {
      if (next.has(agent.agent_id)) throw new Error('duplicate_snapshot_agent');
      next.set(agent.agent_id, { code: agent.activity_code, seq: null, updatedAt: now });
    }
    this.agents = next; this.completeSnapshot = true;
  }
  snapshot(now = Date.now()) {
    if (!this.connected || now - this.heartbeatAt > 45000 || now < this.heartbeatAt) return { state: 'unknown', reason: 'connection_unverified' };
    const codes = [...this.agents.values()].map(a => a.code);
    const active = codes.filter(c => BUSY.has(c)).length;
    if (codes.includes('needs_approval')) return { state: 'needs_approval', active, coverage: this.completeSnapshot ? 'all' : 'observed' };
    if (active) return { state: codes.includes('making_something') ? 'making_something' : 'working', active, coverage: this.completeSnapshot ? 'all' : 'observed' };
    if (codes.includes('waiting_for_user')) return { state: 'waiting_for_user', active: 0 };
    if (codes.includes('out_of_credits')) return { state: 'out_of_credits', active: 0 };
    return this.completeSnapshot ? { state: 'online', active: 0, coverage: 'all' }
      : { state: 'unknown', reason: 'global_coverage_unverified', active: 0 };
  }
}
module.exports = { NativeActivityModel };
