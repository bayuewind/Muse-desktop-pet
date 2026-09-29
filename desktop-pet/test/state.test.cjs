'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveState } = require('../state.cjs');
const now = 100000;
const healthy = { sourceReady: true, connected: true, pingOk: true, pingAt: now, hasEvent: true, code: 'working' };
test('known activity codes select expected states', () => {
  for (const [code, kind] of Object.entries({ online: 'idle', working: 'working', responding: 'working', composing: 'working',
    compacting: 'working', making_something: 'making', waiting_for_subagents: 'working', needs_approval: 'approval',
    waiting_for_user: 'waiting', out_of_credits: 'limited' })) {
    assert.equal(deriveState({ ...healthy, code }, now).kind, kind);
  }
});
test('missing, unknown and cached-only codes never imply idle', () => {
  for (const code of [null, undefined, 'brand_new_status', '__proto__', 'constructor', 4]) {
    assert.equal(deriveState({ ...healthy, code }, now).kind, 'unknown');
  }
  assert.equal(deriveState({ ...healthy, hasEvent: false, code: 'online' }, now).kind, 'syncing');
});
test('connection loss, ping failure and stale samples override cached busy/idle', () => {
  for (const code of ['working', 'online']) {
    assert.equal(deriveState({ ...healthy, code, connected: false }, now).kind, 'disconnected');
    assert.equal(deriveState({ ...healthy, code, pingOk: false }, now).kind, 'unknown');
    assert.equal(deriveState({ ...healthy, code, pingAt: now - 46000 }, now).kind, 'unknown');
    assert.equal(deriveState({ ...healthy, code }, now, now - 13000).kind, 'unknown');
  }
});
test('initial login, renderer failure and sleep recovery are distinct', () => {
  assert.equal(deriveState({ sourceReady: false }, now).kind, 'login');
  assert.equal(deriveState({ ...healthy, suspended: true }, now).kind, 'unknown');
  assert.equal(deriveState({ error: true }, now).kind, 'unknown');
  assert.equal(deriveState(null, now).kind, 'unknown');
});
test('verified explicit snapshots can render status without pretending an event arrived', () => {
  const state = deriveState({ ...healthy, hasEvent: false, hasSnapshot: true }, now);
  assert.equal(state.kind, 'working'); assert.match(state.detail, /快照/);
  assert.equal(deriveState({ ...healthy, hasEvent: false, hasSnapshot: true, connected: false }, now).kind, 'disconnected');
});
