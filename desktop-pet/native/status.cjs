'use strict';
const BUSY = new Set(['working','responding','composing','compacting','making_something','waiting_for_subagents']);
const KNOWN = new Set([...BUSY,'online','needs_approval','waiting_for_user','out_of_credits']);
const TERMINAL = new Set(['succeeded','failed','cancelled','canceled','skipped','timed_out','completed']);
class NativeStatus {
  constructor() { this.reset('connecting'); }
  reset(phase) {
    this.phase = phase; this.pingAt = 0; this.pollAt = 0; this.primaryId = null;
    this.agents = new Map(); this.runs = new Map(); this.presentRunIds = new Set(); this.missingRuns = false;
    this.scheduleCount = 0; this.subagents = 0; this.nextRunAt = null;
    this.runCount = 0; this.runCodesKnown = true;
  }
  heartbeat(now = Date.now()) { this.pingAt = now; this.phase = 'connected'; }
  agent(payload, meta = {}) {
    if (!payload || typeof payload.agent_id !== 'string' || !payload.agent_id || payload.agent_id.length > 512) return;
    if (this.agents.size > 1024) { this.phase = 'unknown'; return; }
    if (!this.primaryId && meta.source === 'chat.subscribe' && payload.is_thread !== true) this.primaryId = payload.agent_id;
    const old = this.agents.get(payload.agent_id);
    if (Number.isSafeInteger(meta.seq) && old?.seq != null && meta.seq <= old.seq) return;
    this.agents.set(payload.agent_id, { code: KNOWN.has(payload.activity_code) ? payload.activity_code : 'unknown', seq: meta.seq });
  }
  polls({ runs, schedules, subagents }, now = Date.now()) {
    if (!Array.isArray(runs?.runs) || !Array.isArray(schedules?.schedules) || !Number.isSafeInteger(subagents?.active_count) || subagents.active_count < 0) throw new Error('status_schema_changed');
    const incoming = new Set(); this.runCodesKnown = true;
    for (const run of runs.runs) {
      if (typeof run.run_id !== 'string' || typeof run.status !== 'string') throw new Error('status_schema_changed');
      incoming.add(run.run_id);
      this.runs.set(run.run_id, run.status);
      if (!TERMINAL.has(run.status) && !['running','pending','queued'].includes(run.status)) this.runCodesKnown = false;
    }
    // Never silently erase a previously running job just because a capped
    // recent-history page no longer includes it.
    this.missingRuns = [...this.runs].some(([id, status]) => status === 'running' && !incoming.has(id));
    this.presentRunIds = incoming;
    for (const [id, status] of this.runs) if (!incoming.has(id) && TERMINAL.has(status)) this.runs.delete(id);
    if (this.runs.size > 2000) throw new Error('status_capacity');
    this.scheduleCount = schedules.schedules.filter(s => s.enabled === true).length;
    const dates = schedules.schedules.filter(s => s.enabled === true && Number.isFinite(s.next_run_at_utc))
      .map(s => s.next_run_at_utc < 1e12 ? s.next_run_at_utc * 1000 : s.next_run_at_utc).filter(t => t >= now);
    this.nextRunAt = dates.length ? Math.min(...dates) : null;
    this.subagents = subagents.active_count; this.runCount = runs.runs.length; this.pollAt = now;
  }
  view(now = Date.now()) {
    const codes = [...this.agents.values()].map(a => a.code);
    const base = { mode: 'native', variant: 'static', scope: '主会话、子任务及最近任务运行记录；不是全量历史保证',
      requiresApproval: codes.includes('needs_approval'), limited: codes.includes('out_of_credits'),
      schedules: this.scheduleCount, recentRuns: this.runCount,
      nextRunInSeconds: this.nextRunAt ? Math.max(0, Math.ceil((this.nextRunAt-now)/1000)) : null };
    const state = (kind, label, detail, variant = 'static') => ({ ...base, kind, label, detail, variant });
    if (this.phase === 'authorization_required') return state('login','需要重新授权','本机会话已过期；不会自动启动浏览器');
    if (this.phase === 'identity_error') return state('unknown','服务器身份待核验','公钥或 VM 分配变化；连接已停止');
    if (this.phase === 'suspended') return state('unknown','等待唤醒后同步','电脑休眠期间不显示旧状态');
    if (this.phase !== 'connected' || !this.pingAt || now-this.pingAt > 45000 || now < this.pingAt) {
      return state('unknown',this.phase === 'connecting' ? '原生连接中' : '原生连接已断开','云端任务可能仍在运行');
    }
    const freshPoll = this.pollAt > 0 && now >= this.pollAt && now-this.pollAt < 35000;
    const activeRuns = freshPoll ? [...this.runs].filter(([id, status]) => this.presentRunIds.has(id) && status === 'running').length : 0;
    const busy = codes.some(code => BUSY.has(code));
    if (busy || activeRuns || (freshPoll && this.subagents > 0)) {
      const detail = activeRuns ? `原生 · ${activeRuns} 个定时任务运行中` : '原生事件 · 已发现运行中的活动';
      return state('working', codes.includes('making_something') ? '正在制作' : '正在工作', detail,
        codes.includes('making_something') ? 'making_something' : 'working');
    }
    if (codes.includes('needs_approval')) return state('approval','需要你的批准','原生事件 · 请在 Muse 中处理');
    if (codes.includes('waiting_for_user')) return state('waiting','等你回应','原生事件 · 当前活动等待输入');
    if (codes.includes('out_of_credits')) return state('limited','用量已耗尽','原生事件 · 不代表任务成功结束');
    if (!freshPoll || !this.primaryId || this.agents.get(this.primaryId)?.code !== 'online' ||
        codes.includes('unknown') || this.missingRuns || !this.runCodesKnown) {
      return state('syncing','正在同步任务状态','缺少新快照时不推断空闲');
    }
    const queued = [...this.runs.values()].some(s => ['pending','queued'].includes(s));
    if (queued) return state('waiting','有任务等待执行',`原生 · ${this.scheduleCount} 个循环计划`);
    return state('idle','当前未见运行任务',`原生 · ${this.scheduleCount} 个循环计划 / 最近记录`, 'default');
  }
}
module.exports = { NativeStatus };
