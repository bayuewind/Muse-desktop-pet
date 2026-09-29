'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeActivityModel } = require('../native/activity-model.cjs');
test('one idle agent cannot conceal another running recurring task', () => {
  const model = new NativeActivityModel(); model.heartbeat(1000);
  model.event({ agent_id: 'recurring-task', activity_code: 'working' }, { seq: 2 }, 1000);
  model.event({ agent_id: 'main-chat', activity_code: 'online' }, { seq: 3 }, 1000);
  assert.equal(model.snapshot(1000).state, 'working');
  model.event({ agent_id: 'recurring-task', activity_code: 'online' }, { seq: 1 }, 1000);
  assert.equal(model.snapshot(1000).state, 'working');
  model.event({ agent_id: 'recurring-task', activity_code: 'online' }, { seq: 4 }, 1000);
  assert.equal(model.snapshot(1000).state, 'unknown'); // no global snapshot yet
});
test('global idle requires a complete snapshot; gaps and expired heartbeats erase certainty', () => {
  const model = new NativeActivityModel(); model.heartbeat(1000);
  assert.equal(model.snapshot(1000).state, 'unknown');
  model.authoritativeSnapshot([{ agent_id: 'a', activity_code: 'online' }], 1000);
  assert.equal(model.snapshot(1000).state, 'online');
  assert.equal(model.snapshot(50000).state, 'unknown');
  model.disconnect(); model.heartbeat(51000);
  assert.equal(model.snapshot(51000).state, 'unknown');
});
test('new unknown activity invalidates previously complete idle knowledge', () => {
  const model = new NativeActivityModel(); model.heartbeat(1000);
  model.authoritativeSnapshot([{ agent_id: 'a', activity_code: 'online' }], 1000);
  model.event({ agent_id: 'a', activity_code: 'new_server_state' }, { seq: 4 }, 1001);
  assert.equal(model.snapshot(1001).state, 'unknown');
  model.disconnect(); assert.throws(() => model.authoritativeSnapshot([], 1002), /invalid/);
});
