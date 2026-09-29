'use strict';
const MAX_ROWS = 200;
function text(value, limit = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit) : '';
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return ms <= 8640000000000000 ? ms : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}
class WorkspaceModel {
  constructor() { this.reset(); }
  reset() {
    this.schedules = []; this.runs = []; this.activities = []; this.agents = new Map();
    this.updatedAt = 0; this.activityAt = 0; this.activityFailed = false; this.invalidSchedules = 0;
    this.subagents = 0;
  }
  agent(payload, meta = {}) {
    if (typeof payload?.agent_id !== 'string' || typeof payload.activity_code !== 'string') return;
    const id = text(payload.agent_id, 512), previous = this.agents.get(id);
    if (Number.isSafeInteger(meta.seq) && Number.isSafeInteger(previous?.seq) && meta.seq <= previous.seq) return;
    if (!previous && this.agents.size >= MAX_ROWS) return;
    this.agents.set(id, { id, code: text(payload.activity_code, 64), title: text(payload.activity_text, 200),
      seq: Number.isSafeInteger(meta.seq) ? meta.seq : null });
  }
  reconnect() { this.agents.clear(); this.updatedAt = 0; this.activityAt = 0; }
  polls({ schedules, runs, subagents }, now = Date.now()) {
    if (!Array.isArray(schedules?.schedules) || !Array.isArray(runs?.runs) ||
        !Number.isSafeInteger(subagents?.active_count) || subagents.active_count < 0) throw new Error('workspace_schema_changed');
    const nextSchedules = schedules.schedules.slice(0, MAX_ROWS).map(row => {
      if (typeof row?.id !== 'string' || typeof row.enabled !== 'boolean') throw new Error('workspace_schema_changed');
      return { id: text(row.id, 512), title: text(row.title, 200) || (row.is_heartbeat === true ? '定期守望' : '未命名计划'),
        enabled: row.enabled, heartbeat: row.is_heartbeat === true, nextRunAt: timestamp(row.next_run_at_utc),
        timezone: text(row.timezone, 80) };
    });
    const names = new Map(nextSchedules.map(row => [row.id, row.title]));
    const nextRuns = runs.runs.slice(0, MAX_ROWS).map(row => {
      if (typeof row?.run_id !== 'string' || typeof row.status !== 'string') throw new Error('workspace_schema_changed');
      return { id: text(row.run_id, 512), title: names.get(row.job_id) || '任务运行',
        status: text(row.status, 64), scheduledAt: timestamp(row.scheduled_for_utc),
        summary: text(row.result_summary, 2000), error: text(row.error_text, 1000) };
    });
    this.schedules = nextSchedules; this.runs = nextRuns;
    this.invalidSchedules = Array.isArray(schedules.invalid) ? schedules.invalid.length : 0;
    this.subagents = subagents.active_count; this.updatedAt = now;
  }
  activity(response, now = Date.now()) {
    if (!Array.isArray(response?.days)) throw new Error('activity_schema_changed');
    const rows = [];
    for (const day of response.days.slice(0, MAX_ROWS)) {
      if (!Array.isArray(day?.activities)) throw new Error('activity_schema_changed');
      for (const row of day.activities.slice(0, MAX_ROWS)) {
        if (!row || typeof row !== 'object') continue;
        rows.push({ id: text(row.message_id, 512), title: text(row.title, 200) || 'Muse 活动',
          summary: text(row.status_title, 1000), status: text(row.status, 64), at: timestamp(row.timestamp) });
        if (rows.length >= MAX_ROWS) break;
      }
      if (rows.length >= MAX_ROWS) break;
    }
    this.activities = rows; this.activityAt = now; this.activityFailed = false;
  }
  snapshot(connection = {}, now = Date.now()) {
    const online = connection.phase === 'connected' && connection.pingAt > 0 &&
      now >= connection.pingAt && now - connection.pingAt <= 45000;
    const fresh = online && this.updatedAt > 0 && now >= this.updatedAt && now - this.updatedAt < 35000 &&
      connection.pollAt > 0 && !connection.missingRuns && connection.runCodesKnown !== false;
    return { online, fresh, updatedAt: this.updatedAt, activityAt: this.activityAt,
      activityFresh: online && !this.activityFailed && this.activityAt > 0 && now >= this.activityAt && now - this.activityAt < 65000,
      invalidSchedules: this.invalidSchedules, subagents: this.subagents,
      schedules: this.schedules.map(row => ({ ...row })), runs: this.runs.map(row => ({ ...row })),
      activities: this.activities.map(row => ({ ...row })),
      agents: [...this.agents.values()].map(({ seq, ...row }) => row) };
  }
}
module.exports = { WorkspaceModel, text, timestamp };
