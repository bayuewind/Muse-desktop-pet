'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeStatus } = require('../native/status.cjs');
function fixture() {
  const status = new NativeStatus(); status.heartbeat(1000);
  status.agent({ agent_id: 'main', is_thread: false, activity_code: 'online' }, { source: 'chat.subscribe', seq: 1 });
  return status;
}
const poll = runs => ({ runs: { runs }, schedules: { schedules: [{ id: 'job', enabled: true, next_run_at_utc: 10 }] }, subagents: { active_count: 0 } });
test('native recurring runs override an idle chat, then clear on explicit terminal status', () => {
  const s = fixture(); s.polls(poll([{ run_id: 'r', status: 'running' }]), 1000);
  assert.equal(s.view(1000).kind, 'working'); assert.match(s.view(1000).detail, /定时任务/);
  s.polls(poll([{ run_id: 'r', status: 'succeeded' }]), 2000);
  assert.equal(s.view(2000).kind, 'idle'); assert.equal(s.view(2000).mode, 'native');
});
test('no event, stale polling and unknown run states never report idle', () => {
  const s = fixture(); assert.notEqual(s.view(1000).kind, 'idle');
  s.polls(poll([{ run_id: 'r', status: 'succeeded' }]), 1000);
  assert.notEqual(s.view(40000).kind, 'idle');
  s.polls(poll([{ run_id: 'r', status: 'new_state' }]), 2000);
  assert.notEqual(s.view(2000).kind, 'idle');
  s.reset('disconnected'); assert.notEqual(s.view(2000).kind, 'idle');
});
test('active subagents are visible even with no running scheduled jobs', () => {
  const s = fixture(); s.polls({ ...poll([]), subagents: { active_count: 2 } }, 1000);
  assert.equal(s.view(1000).kind, 'working');
});
test('truncated recent history cannot clear a previously observed running job', () => {
  const s = fixture(); s.polls(poll([{ run_id: 'old', status: 'running' }]), 1000);
  s.polls(poll([{ run_id: 'new', status: 'succeeded' }]), 2000);
  assert.equal(s.view(2000).kind, 'syncing');
});
