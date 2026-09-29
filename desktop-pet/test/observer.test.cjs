'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { observerScript } = require('../observer.cjs');

function setup(deferPings = false) {
  let connected = true, listener, connectionListener, storeListener, code = 'working', route = 'main', root = 'root1', activityRoot = 'root1';
  const requests = [], pings = [], timers = new Map(); let nextTimer = 1, now = 100000;
  const runtime = {
    subscribe(fn) { connectionListener = fn; return () => { connectionListener = null; }; },
    getSnapshot() { return { isConnected: connected,
      onEvent(name, fn) { assert.equal(name, 'agent.status'); listener = fn; return () => { listener = null; }; },
      sendRequest(method, params) {
        requests.push({ method, params });
        return deferPings ? new Promise(resolve => pings.push(resolve)) : Promise.resolve({ ok: true });
      },
    }; },
  };
  const context = vm.createContext({ location: { origin: 'https://muse.ai' }, document: { querySelector: () => null }, Date: { now: () => now },
    setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    window: { __hatchEarlyGatewayRuntimeState: { activeRuntime: runtime }, __hatch_store__: {
      subscribe(fn) { storeListener = fn; return () => { storeListener = null; }; },
      getState: () => ({ activity: { currentChatRootAgentId: root, currentChatRouteKey: route,
        agentActivityRootAgentId: activityRoot, agentActivityCode: code },
        identity: { secret: 'must-not-leak' }, chat: { messages: ['private'] } }),
    } },
  });
  return {
    sample: reset => vm.runInContext(observerScript(reset), context), context, requests, pings,
    advance(ms) { now += ms; },
    emit: (event, seq) => listener?.(event, { seq }),
    disconnect() { connected = false; connectionListener?.(); },
    reconnect() { connected = true; connectionListener?.(); },
    changeRoute() { route = 'other'; root = 'root2'; },
    setStoreCode(value) { code = value; activityRoot = root; storeListener?.(); },
    expirePing() { for (const fn of [...timers.values()]) fn(); },
  };
}
test('labels initial explicit store state as snapshot, not a newly received event; only pings', async () => {
  const fixture = setup(); const first = fixture.sample();
  assert.equal(first.hasEvent, false);
  assert.equal(first.hasSnapshot, true); assert.equal(first.evidence, 'store_snapshot');
  await new Promise(resolve => setImmediate(resolve));
  const afterPing = fixture.sample();
  assert.equal(afterPing.pingOk, true); assert.equal(afterPing.hasEvent, false);
  assert.deepEqual(fixture.requests.map(r => r.method), ['connection.ping']);
});
test('store updates work even when raw gateway status events were missed', async () => {
  const f = setup(); f.sample();
  await new Promise(resolve => setImmediate(resolve));
  f.setStoreCode('making_something');
  const next = f.sample();
  assert.equal(next.code, 'making_something'); assert.equal(next.hasEvent, false);
  assert.equal(next.hasSnapshot, true); assert.equal(next.evidence, 'store_update');
  f.setStoreCode('online'); assert.equal(f.sample().code, 'online');
});
test('unchanged pre-disconnect snapshots stay blocked until a genuine update', async () => {
  const f = setup(); f.sample();
  await new Promise(resolve => setImmediate(resolve));
  f.disconnect(); f.reconnect();
  assert.equal(f.sample().hasSnapshot, false);
  f.setStoreCode('online'); assert.equal(f.sample().hasSnapshot, true);
  assert.equal(f.sample().code, 'online');
});
test('accepts scoped fresh events, ignores other agents and out-of-order delivery', () => {
  const f = setup(); f.sample();
  f.emit({ agent_id: 'root1', activity_code: 'working', activity_text: 'private' }, 10);
  assert.equal(f.sample().code, 'working');
  f.emit({ agent_id: 'root1', activity_code: 'online' }, 9);
  f.emit({ agent_id: 'other', activity_code: 'online' }, 11);
  assert.equal(f.sample().code, 'working');
  f.emit({ agent_id: 'root1', activity_code: 'online' }, 12);
  assert.equal(f.sample().code, 'online');
  assert.doesNotMatch(JSON.stringify(f.sample()), /private|root1|must-not-leak/);
});
test('disconnect invalidates task data; reconnect requires a new event', () => {
  const f = setup(); f.sample(); f.emit({ activity_code: 'working' }, 10);
  f.disconnect(); assert.equal(f.sample().hasEvent, false);
  f.reconnect(); assert.equal(f.sample().hasEvent, false);
  f.emit({ activity_code: 'online' }, 1); assert.equal(f.sample().code, 'online');
});
test('route changes and wake/reset drop prior activity', () => {
  const f = setup(); f.sample(); f.emit({ activity_code: 'working' }, 1);
  f.changeRoute(); assert.equal(f.sample().hasEvent, false);
  f.emit({ agent_id: 'root1', activity_code: 'working' }, 2); assert.equal(f.sample().hasEvent, false);
  f.emit({ agent_id: 'root2', activity_code: 'online' }, 3); assert.equal(f.sample().hasEvent, true);
  assert.equal(f.sample(true).hasEvent, false);
});
test('wrong origin never reads state or invokes gateway', () => {
  const f = setup(); f.context.location.origin = 'https://login.example.org';
  assert.equal(f.sample().sourceReady, false); assert.equal(f.requests.length, 0);
});
test('uses the real avatar provider store instead of the empty global debug store', () => {
  const f = setup();
  const realStore = f.context.window.__hatch_store__;
  f.context.window.__hatch_store__ = { getState: () => ({ activity: {} }), subscribe: () => () => {} };
  let fiber = { memoizedProps: { value: realStore }, return: null };
  // Real provider ancestry exceeded the initial diagnostic's 70-fiber bound.
  for (let depth = 0; depth < 95; depth++) fiber = { memoizedProps: {}, return: fiber };
  f.context.document.querySelector = () => ({ '__reactFiber$test': fiber });
  const snapshot = f.sample();
  assert.equal(snapshot.diagnostic.storeSource, 'avatar_provider');
  assert.equal(snapshot.code, 'working'); assert.equal(snapshot.hasSnapshot, true);
  f.emit({ agent_id: 'root1', activity_code: 'making_something' }, 1);
  const live = f.sample();
  assert.equal(live.code, 'making_something'); assert.equal(live.hasEvent, true);
  assert.equal(live.filteredEvents, 0);
  assert.doesNotMatch(JSON.stringify(live), /private|must-not-leak|root1/);
});
test('late successful heartbeat cannot validate a newer in-flight request', async () => {
  const f = setup(true); f.sample(); f.emit({ activity_code: 'working' }, 1);
  f.expirePing(); assert.equal(f.sample().hasEvent, false);
  f.advance(16000); f.sample(); assert.equal(f.requests.length, 2);
  f.pings[0]({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sample().pingOk, false);
  f.pings[1]({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sample().pingOk, true);
  assert.equal(f.sample().hasEvent, false);
});
test('late heartbeat from the old connection cannot validate a new connection', async () => {
  const f = setup(true); f.sample(); f.disconnect(); f.reconnect(); f.sample();
  f.pings[0]({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sample().pingOk, false);
  f.pings[1]({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sample().pingOk, true);
});
