'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NotificationPolicy } = require('../notifications.cjs');
const snapshot = (runs = [], agents = []) => ({ fresh: true, runs, agents });
const run = (id, status, scheduledAt = 1000) => ({ id, status, scheduledAt });
test('notifications suppress initial history and emit one completion per observed transition', () => {
  const policy = new NotificationPolicy();
  assert.deepEqual(policy.consume(snapshot([run('old', 'completed'), run('r', 'running')]), { now: 1000 }), []);
  assert.deepEqual(policy.consume(snapshot([run('old', 'completed'), run('r', 'completed')]), { now: 2000 }), [{ kind: 'completed', count: 1 }]);
  assert.deepEqual(policy.consume(snapshot([run('r', 'completed')]), { now: 3000 }), []);
});
test('notifications coalesce tasks between polls but do not replay older history', () => {
  const policy = new NotificationPolicy(); policy.consume(snapshot(), { now: 1000 });
  assert.deepEqual(policy.consume(snapshot([run('a', 'completed', 2000), run('b', 'succeeded', 2000),
    run('c', 'failed', 2000), run('old', 'completed', 1)]), { now: 3000 }),
  [{ kind: 'failed', count: 1 }, { kind: 'completed', count: 2 }]);
});
test('mute, quiet and focused states consume events without replaying them later', () => {
  for (const setting of [{ enabled: false }, { quietUntil: 5000 }, { focused: true }]) {
    const policy = new NotificationPolicy(); policy.consume(snapshot([run('r', 'running')]), { now: 1000 });
    assert.deepEqual(policy.consume(snapshot([run('r', 'completed')]), { now: 2000, ...setting }), []);
    assert.deepEqual(policy.consume(snapshot([run('r', 'completed')]), { now: 6000 }), []);
  }
});
test('attention is distinct from busy, de-duplicated, and never exposes private text', () => {
  const policy = new NotificationPolicy(), agents = [{ id: 'a', code: 'needs_approval', title: 'private' }, { id: 'b', code: 'working' }];
  assert.deepEqual(policy.consume(snapshot([], agents), { now: 1000 }), [{ kind: 'attention', count: 1 }]);
  assert.deepEqual(policy.consume(snapshot([], agents), { now: 2000 }), []);
  policy.consume(snapshot(), { now: 3000 });
  assert.deepEqual(policy.consume(snapshot([], agents), { now: 4000 }), [{ kind: 'attention', count: 1 }]);
});
test('disconnect does not erase known running jobs, reset clears old-account notifications', () => {
  const policy = new NotificationPolicy(); policy.consume(snapshot([run('r', 'running')]), { now: 1000 });
  assert.deepEqual(policy.consume({ ...snapshot([run('r', 'completed')]), fresh: false }, { now: 2000 }), []);
  assert.deepEqual(policy.consume(snapshot([run('r', 'failed')]), { now: 3000 }), [{ kind: 'failed', count: 1 }]);
  policy.reset();
  assert.deepEqual(policy.consume(snapshot([run('r', 'failed')]), { now: 4000 }), []);
});
