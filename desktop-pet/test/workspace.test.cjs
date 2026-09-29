'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceModel, timestamp } = require('../native/workspace.cjs');
const { NativeSource } = require('../native/source.cjs');
const now = 1800000000000;
const connection = { phase: 'connected', pingAt: now, pollAt: now };
function fixture() {
  return { schedules: { schedules: [{ id: 'job', title: 'Synthetic plan', enabled: true,
    is_heartbeat: false, next_run_at_utc: now / 1000 + 60, timezone: 'Asia/Shanghai',
    path: '/private/never-export', schedule_key: 'never-export' }], invalid: [] },
  runs: { runs: [{ run_id: 'run', job_id: 'job', status: 'running', scheduled_for_utc: now / 1000,
    result_summary: 'Synthetic result', error_text: null, private_field: 'never-export' }] }, subagents: { active_count: 2 } };
}
test('workspace maps the observed wire shape to a bounded UI model without raw fields', () => {
  const model = new WorkspaceModel(); model.polls(fixture(), now);
  const result = model.snapshot(connection, now);
  assert.equal(result.fresh, true); assert.equal(result.runs[0].title, 'Synthetic plan');
  assert.equal(result.schedules[0].nextRunAt, now + 60000); assert.equal(result.subagents, 2);
  assert.equal(JSON.stringify(result).includes('never-export'), false);
  result.runs[0].title = 'changed'; assert.equal(model.snapshot(connection, now).runs[0].title, 'Synthetic plan');
});
test('workspace never labels stale, backward-clock, sleeping or disconnected data fresh', () => {
  const model = new WorkspaceModel(); model.polls(fixture(), now);
  for (const [state, at] of [[connection, now + 35000], [connection, now - 1],
    [{ ...connection, phase: 'suspended' }, now], [{ ...connection, pollAt: 0 }, now],
    [{ ...connection, missingRuns: true }, now], [{ ...connection, runCodesKnown: false }, now],
    [{ ...connection, pingAt: now - 46000 }, now]]) assert.equal(model.snapshot(state, at).fresh, false);
  model.reconnect();
  const result = model.snapshot(connection, now);
  assert.equal(result.fresh, false); assert.equal(result.runs.length, 1); assert.equal(result.agents.length, 0);
});
test('invalid workspace schema cannot partially replace previous validated data', () => {
  const model = new WorkspaceModel(); model.polls(fixture(), now);
  const input = fixture(); input.schedules.schedules[0].title = 'changed'; input.runs.runs[0].status = null;
  assert.throws(() => model.polls(input, now + 1), /schema/);
  assert.equal(model.snapshot(connection, now).schedules[0].title, 'Synthetic plan');
});
test('workspace activity drops details and unbounded content, marks failed refresh stale', () => {
  const model = new WorkspaceModel();
  model.activity({ days: [{ activities: [{ message_id: 'm', title: 'x'.repeat(5000), status_title: 'done',
    status: 'completed', timestamp: '2026-09-30T01:00:00Z', details: { credentials: 'never-export' } }] }] }, now);
  let result = model.snapshot(connection, now);
  assert.equal(result.activities[0].title.length, 200); assert.equal(result.activityFresh, true);
  assert.equal(JSON.stringify(result).includes('never-export'), false);
  model.activityFailed = true; assert.equal(model.snapshot(connection, now).activityFresh, false);
  assert.throws(() => model.activity({ days: [{}] }, now + 1), /schema/);
});
test('workspace preserves multiple agents and ignores replayed status events', () => {
  const model = new WorkspaceModel();
  model.agent({ agent_id: 'a', activity_code: 'needs_approval', activity_text: 'Confirm' }, { seq: 5 });
  model.agent({ agent_id: 'a', activity_code: 'online' }, { seq: 4 });
  model.agent({ agent_id: 'b', activity_code: 'working' }, { seq: 3 });
  const agents = model.snapshot().agents;
  assert.equal(agents.length, 2); assert.equal(agents[0].code, 'needs_approval');
  model.reset(); assert.equal(model.snapshot().agents.length, 0);
});
test('workspace caps rows and tolerates missing optional titles and dates', () => {
  const model = new WorkspaceModel(), input = fixture();
  input.schedules.schedules[0].title = null; input.schedules.schedules[0].is_heartbeat = true;
  input.runs.runs = Array.from({ length: 300 }, (_, i) => ({ run_id: `r${i}`, status: 'new_status' }));
  model.polls(input, now);
  assert.equal(model.runs.length, 200); assert.equal(model.schedules[0].title, '定期守望');
  assert.equal(model.runs[0].scheduledAt, null);
  assert.equal(timestamp(Infinity), null); assert.equal(timestamp(1e100), null);
  assert.equal(timestamp('not a date'), null);
});
test('account disposal also clears workspace private data', () => {
  const source = new NativeSource({});
  source.workspace.polls(fixture(), now); source.clearAccountData();
  assert.equal(source.workspace.snapshot().runs.length, 0);
  assert.equal(source.workspace.snapshot().schedules.length, 0);
});
