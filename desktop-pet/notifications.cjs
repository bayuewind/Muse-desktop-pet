'use strict';
const SUCCESS = new Set(['succeeded', 'completed']);
const FAILURE = new Set(['failed', 'timed_out']);
const ATTENTION = new Set(['needs_approval', 'waiting_for_user', 'out_of_credits']);
class NotificationPolicy {
  constructor() { this.reset(); }
  reset() { this.runs = new Map(); this.attention = new Set(); this.baselineAt = 0; }
  consume(snapshot, { enabled = true, quietUntil = 0, focused = false, now = Date.now() } = {}) {
    if (!snapshot?.fresh) return [];
    const events = [], first = !this.baselineAt;
    if (first) this.baselineAt = now;
    let completed = 0, failed = 0;
    for (const run of snapshot.runs) {
      const old = this.runs.get(run.id);
      const changed = old !== run.status;
      const eligible = !first && changed && (old != null || run.scheduledAt >= this.baselineAt);
      if (eligible && SUCCESS.has(run.status)) completed++;
      if (eligible && FAILURE.has(run.status)) failed++;
      this.runs.set(run.id, run.status);
    }
    while (this.runs.size > 1000) this.runs.delete(this.runs.keys().next().value);
    const attention = new Set(snapshot.agents.filter(agent => ATTENTION.has(agent.code)).map(agent => `${agent.id}:${agent.code}`));
    const newAttention = [...attention].some(key => !this.attention.has(key));
    this.attention = attention;
    if (newAttention) events.push({ kind: 'attention', count: attention.size });
    if (failed) events.push({ kind: 'failed', count: failed });
    if (completed) events.push({ kind: 'completed', count: completed });
    return enabled && quietUntil <= now && !focused ? events : [];
  }
}
module.exports = { NotificationPolicy };
