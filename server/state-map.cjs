'use strict';
// Maps the desktop pet's NativeStatus view (desktop-pet/native/status.cjs) to
// the AI Passport avatar states accepted by the MCP tool self.avatar.set_state
// (folo-ai-passport-xiaozhi: scripts/muse_avatar/README.md).
//
// Uncertain states never map to "default": a device showing idle while Muse is
// actually working is worse than showing "unknown".

const DEVICE_STATES = new Set(['default', 'working', 'making_something', 'waiting', 'approval', 'limited',
  'syncing', 'offline', 'unknown', 'level_up', 'achievement']);

// Labels emitted by NativeStatus.view() for the connection phases.
const LABEL_CONNECTING = '原生连接中';
const LABEL_DISCONNECTED = '原生连接已断开';

function toDeviceState(view, subagents = 0) {
  if (!view || typeof view.kind !== 'string') return { state: 'unknown', reason: 'no_view' };
  switch (view.kind) {
    case 'idle':
      return { state: 'default', reason: 'idle' };
    case 'working': {
      if (view.variant === 'making_something') return { state: 'making_something', reason: 'making_something' };
      const count = Number.isSafeInteger(subagents) && subagents > 0 ? Math.min(subagents, 999) : 0;
      return count ? { state: 'working', subagents: count, reason: 'working' } : { state: 'working', reason: 'working' };
    }
    case 'approval':
    case 'waiting':
    case 'limited':
    case 'syncing':
      return { state: view.kind, reason: view.kind };
    case 'unknown':
      if (view.label === LABEL_CONNECTING) return { state: 'syncing', reason: 'connecting' };
      if (view.label === LABEL_DISCONNECTED) return { state: 'offline', reason: 'disconnected' };
      return { state: 'unknown', reason: 'unknown' };
    case 'login':
      // The device has no dedicated "re-authorise" state yet.
      return { state: 'unknown', reason: 'authorization_required' };
    default:
      return { state: 'unknown', reason: `unmapped_kind:${view.kind}` };
  }
}

// Second line under the state on the device (it never scrolls: keep it short).
// `workingSince` is when the current busy spell started (ms), `now` the clock.
function detailFor(mapped, view, { now = Date.now(), workingSince = null, timeZone } = {}) {
  if (mapped.state === 'working' || mapped.state === 'making_something') {
    const minutes = workingSince ? Math.floor((now - workingSince) / 60_000) : 0;
    const elapsed = minutes >= 1 ? `已 ${minutes} 分钟` : '刚开始';
    return mapped.subagents ? `${elapsed} · ${mapped.subagents} 个子任务` : elapsed;
  }
  if (mapped.state === 'default' && Number.isFinite(view?.nextRunInSeconds) && view.nextRunInSeconds < 24 * 3600) {
    const at = new Date(now + view.nextRunInSeconds * 1000);
    const hhmm = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
    return `下个任务 ${hhmm}`;
  }
  return '';
}

module.exports = { toDeviceState, detailFor, DEVICE_STATES };
