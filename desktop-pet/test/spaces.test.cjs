'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SpacesModel } = require('../native/spaces.cjs');
const { NativeSource } = require('../native/source.cjs');
const now = 1800000000000;
const connection = { phase: 'connected', pingAt: now };
const goals = () => ({ goals: [{ goal_id: 'g1', title: 'Synthetic goal', summary: 'Summary',
  description: 'Details', status: 'active', source: 'user_goal', updated_at: now,
  private_field: 'never-export' }], pagination: { has_next_page: false }, warnings: [] });
const ideas = () => ({ sections: [{ title: 'Suggested', cards: [{ id: 'i1', title: 'Synthetic idea',
  summary: 'Idea summary', buildStatus: 'new', content: { private: 'never-export' } }] }],
pagination: { hasNextPage: false } });
test('spaces normalize verified schemas without exposing raw objects', () => {
  const model = new SpacesModel(); model.update('goals', goals(), now); model.update('ideas', ideas(), now);
  const snapshot = model.snapshot(connection, now);
  assert.equal(snapshot.goals.fresh, true); assert.equal(snapshot.ideas.fresh, true);
  assert.equal(snapshot.goals.rows[0].updatedAt, now);
  assert.equal(snapshot.ideas.rows[0].section, 'Suggested');
  assert.equal(JSON.stringify(snapshot).includes('never-export'), false);
  snapshot.goals.rows[0].title = 'mutated';
  assert.equal(model.snapshot(connection, now).goals.rows[0].title, 'Synthetic goal');
});
test('spaces retain old data on independent errors and invalidate on reconnect', () => {
  const model = new SpacesModel(); model.update('goals', goals(), now); model.update('ideas', ideas(), now);
  model.failed('ideas');
  assert.equal(model.snapshot(connection, now).ideas.fresh, false);
  assert.equal(model.snapshot(connection, now).goals.fresh, true);
  assert.equal(model.snapshot(connection, now).ideas.rows.length, 1);
  for (const [state, at] of [[connection, now - 1], [{ ...connection, pingAt: now + 120000 }, now + 120000],
    [{ phase: 'disconnected', pingAt: now }, now], [connection, now + 46000]]) {
    assert.equal(model.snapshot(state, at).goals.fresh, false);
  }
  model.reconnect();
  assert.equal(model.snapshot(connection, now).goals.fresh, false);
  assert.equal(model.snapshot(connection, now).goals.rows.length, 1);
});
test('spaces reject malformed rows atomically, bound text, and report truncation', () => {
  const model = new SpacesModel(); model.update('goals', goals(), now);
  const invalid = goals(); invalid.goals.push({ goal_id: null });
  assert.throws(() => model.update('goals', invalid, now + 1), /schema/);
  assert.equal(model.snapshot(connection, now).goals.updatedAt, now);
  assert.throws(() => model.update('ideas', { sections: [{}] }), /schema/);
  const large = goals(); large.goals = Array.from({ length: 201 }, (_, index) => ({
    goal_id: `g${index}`, title: '\0' + 'a'.repeat(300), summary: 'b'.repeat(5000),
  }));
  model.update('goals', large, now);
  const snapshot = model.snapshot(connection, now).goals;
  assert.equal(snapshot.rows.length, 200); assert.equal(snapshot.partial, true);
  assert.equal(snapshot.rows[0].title.length, 200); assert.equal(snapshot.rows[0].summary.length, 2000);
  assert.equal(snapshot.rows[0].title.includes('\0'), false);
  const largeIdeas = ideas(); largeIdeas.sections[0].cards = Array.from({ length: 220 }, (_, i) => ({ id: `i${i}` }));
  model.update('ideas', largeIdeas, now);
  assert.equal(model.ideas.length, 200); assert.equal(model.snapshot(connection, now).ideas.partial, true);
});
test('missing pagination, warning and duplicate IDs never claim a complete list', () => {
  const model = new SpacesModel(), response = goals(); delete response.pagination;
  model.update('goals', response, now); assert.equal(model.meta.goals.partial, true);
  response.pagination = { has_next_page: false }; response.warnings = ['Synthetic warning'];
  model.update('goals', response, now); assert.equal(model.meta.goals.partial, true);
  response.warnings = []; response.goals.push(response.goals[0]);
  model.update('goals', response, now);
  assert.equal(model.goals.length, 1); assert.equal(model.meta.goals.partial, true);
});
test('space refreshes coalesce and preserve successful category on partial failure', async () => {
  const source = new NativeSource({}); source.running = true;
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  source.client = { ready: true, closed: false, request: async method => {
    calls++; await gate;
    if (method === 'ideas.list') throw new Error('unavailable');
    return goals();
  } };
  const first = source.refreshSpaces(), second = source.refreshSpaces();
  release();
  assert.equal((await first).ok, false); assert.equal((await second).ok, false);
  assert.equal(calls, 2); assert.equal(source.spaces.goals.length, 1);
  assert.equal(source.spaces.meta.ideas.failed, true); assert.equal(source.spacesRequest, null);
});
test('old connection and signed-out space responses cannot repopulate the model', async () => {
  for (const mode of ['reconnect', 'logout']) {
    const source = new NativeSource({}); source.running = true;
    let release; const gate = new Promise(resolve => { release = resolve; });
    source.client = { ready: true, closed: false, request: async method => {
      await gate; return method === 'goals.list' ? goals() : ideas();
    }, close() { this.closed = true; } };
    const pending = source.refreshSpaces();
    if (mode === 'reconnect') source.client = { ready: true };
    else { await source.stop(); source.clearAccountData(); }
    release();
    assert.equal((await pending).ok, false);
    assert.equal(source.spaces.goals.length, 0); assert.equal(source.spaces.ideas.length, 0);
  }
});
