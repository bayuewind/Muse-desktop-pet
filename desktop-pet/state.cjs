'use strict';

const LABELS = Object.freeze({
  online: ['idle', '空闲中', 'default'],
  responding: ['working', '正在回复', 'working'],
  composing: ['working', '正在组织回复', 'working'],
  working: ['working', '正在工作', 'working'],
  compacting: ['working', '正在整理上下文', 'working'],
  making_something: ['making', '正在制作', 'making_something'],
  waiting_for_subagents: ['working', '等待子智能体', 'working'],
  waiting_for_user: ['waiting', '等你回应', 'static'],
  needs_approval: ['approval', '需要你的批准', 'static'],
  out_of_credits: ['limited', '用量已耗尽', 'static'],
});

function model(kind, label, detail, extra = {}) {
  return { kind, label, detail, variant: 'static', scope: 'Muse 当前订阅会话', ...extra };
}

function deriveState(sample, now = Date.now(), receivedAt = now) {
  if (!sample || !Number.isFinite(receivedAt) || now - receivedAt > 12000) {
    return model('unknown', '状态未知', '状态采集已中断，请打开 Muse 检查');
  }
  if (sample.suspended) return model('unknown', '等待重新同步', '电脑刚刚唤醒，旧状态不作为实时结果');
  if (sample.error) return model('unknown', '连接检查失败', '没有把失联当作空闲或完成');
  if (!sample.sourceReady) return model('login', '请先登录 Muse', '点下方按钮打开独立登录窗口');
  if (!sample.connected) return model('disconnected', '连接已中断', '任务可能仍在云端运行');
  if (!sample.pingOk || !Number.isFinite(sample.pingAt) || now - sample.pingAt > 45000 || sample.pingAt > now + 5000) {
    return model('unknown', '正在核验连接', '等待云端保活确认，不猜测任务状态');
  }
  if (!sample.hasEvent && !sample.hasSnapshot) return model('syncing', '已连接 · 等待状态', '尚未取得当前连接的有效活动状态');
  const entry = typeof sample.code === 'string' && Object.hasOwn(LABELS, sample.code) ? LABELS[sample.code] : null;
  if (!entry) return model('unknown', '未知活动状态', 'Muse 返回了尚未适配的活动类型');
  const [kind, label, variant] = entry;
  const detail = sample.hasEvent ? '实时活动事件 · 仅当前订阅会话'
    : '网页状态快照 · 仅当前订阅会话';
  return model(kind, label, detail, {
    variant,
    eventAt: Number.isFinite(sample.eventAt) ? sample.eventAt : null,
    subagents: Number.isInteger(sample.subagents) ? Math.max(0, Math.min(999, sample.subagents)) : 0,
  });
}

module.exports = { deriveState };
