'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeStatus } = require('../native/status.cjs');
const { NativeSource } = require('../native/source.cjs');
const { randomUUID } = require('node:crypto');
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
test('new unknown activity clears idle knowledge while old replay does not', () => {
  const s = fixture(); s.polls(poll([]), 1000);
  assert.equal(s.view(1000).kind, 'idle');
  s.agent({ agent_id: 'main', activity_code: 'future_code' }, { seq: 0 });
  assert.equal(s.view(1000).kind, 'idle');
  s.agent({ agent_id: 'main', activity_code: 'future_code' }, { seq: 2 });
  assert.equal(s.view(1000).kind, 'syncing');
  s.agent({ agent_id: 'main', activity_code: 'online' }, { seq: 3 });
  s.agent({ agent_id: 'other', activity_code: null }, { seq: 1 });
  assert.equal(s.view(1000).kind, 'syncing');
});
test('busy remains visible without losing approval or credit restrictions', () => {
  const s = fixture(); s.polls(poll([{ run_id: 'r', status: 'running' }]), 1000);
  s.agent({ agent_id: 'main', activity_code: 'needs_approval' }, { seq: 2 });
  assert.equal(s.view(1000).kind, 'working'); assert.equal(s.view(1000).requiresApproval, true);
  s.agent({ agent_id: 'other', activity_code: 'out_of_credits' }, { seq: 1 });
  assert.equal(s.view(1000).limited, true);
});
test('a clock moving backwards cannot mark future polls fresh', () => {
  const s = fixture(); s.polls(poll([]), 2000);
  assert.equal(s.view(1500).kind, 'syncing');
});
test('native sender refuses approval and credit restrictions even with parallel work', async () => {
  for (const code of ['needs_approval', 'out_of_credits']) {
    const source = new NativeSource({}), now = Date.now();
    source.running = true; let dispatched = false;
    source.client = { ready: true, closed: false, sendChat() { dispatched = true; } };
    source.state.heartbeat(now);
    source.state.polls(poll([{ run_id: 'r', status: 'running' }]), now);
    source.state.agent({ agent_id: 'main', activity_code: code }, { source: 'chat.subscribe', seq: 1 });
    const result = await source.submitTask({ id: randomUUID(), text: 'Synthetic draft' });
    assert.equal(result.status, 'not_sent'); assert.equal(dispatched, false);
  }
});
