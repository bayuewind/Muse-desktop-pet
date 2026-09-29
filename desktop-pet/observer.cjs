'use strict';

// Runs only in the exact https://muse.ai top frame. No cookies, tokens, messages,
// private asset URLs, account IDs or gateway URLs cross this boundary.
function observeMusePage(forceReset = false) {
  if (location.origin !== 'https://muse.ai') return { sourceReady: false };
  const key = '__MUSE_DESKTOP_PET_OBSERVER_V1__';
  // The global debug store can be an unused default store. Inspect only the
  // avatar's provider ancestry, never enumerate chat content or auth state.
  let providerStore = null;
  const avatar = document.querySelector('[data-hatch-avatar-host]');
  const fiberKey = avatar && Object.keys(avatar).find(name => name.startsWith('__reactFiber$'));
  let fiber = fiberKey ? avatar[fiberKey] : null;
  for (let depth = 0; fiber && depth < 200; depth++, fiber = fiber.return) {
    const value = fiber.memoizedProps?.value;
    if (value && typeof value.getState === 'function' && typeof value.subscribe === 'function') {
      try {
        if (value.getState()?.activity) { providerStore = value; break; }
      } catch {}
    }
  }
  const requireFresh = forceReset && Boolean(window[key]);
  if ((forceReset || window[key]?.version !== 3) && window[key]) {
    window[key].dispose();
    delete window[key];
  }
  const normalizeId = value => typeof value === 'string' ? value.trim() || null
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (!window[key]) {
    const obs = {
      version: 3, store: null, storeUnsubscribe: null,
      runtime: null, unsubscribe: null, connectionUnsubscribe: null,
      connected: false, everConnected: false, generation: 0, code: null, hasEvent: false, hasSnapshot: false,
      snapshotBlocked: requireFresh, evidence: null, snapshotSignature: null, snapshotRef: null,
      rawEvents: 0, filteredEvents: 0,
      eventAt: null, subagents: 0, seq: null, root: null, route: null,
      pingAt: null, pingOk: false, pingPending: false, pingTimer: null, pingSerial: 0,
      resetActivity() {
        this.code = null; this.hasEvent = false; this.hasSnapshot = false; this.evidence = null; this.eventAt = null;
        this.subagents = 0; this.seq = null;
      },
      scope() {
        const activity = this.store?.getState?.()?.activity;
        const root = normalizeId(activity?.currentChatRootAgentId);
        const route = activity?.currentChatRouteKey ?? null;
        if (root !== this.root || route !== this.route) {
          this.root = root; this.route = route; this.resetActivity();
          this.snapshotSignature = null; this.snapshotRef = null;
        }
      },
      connection() {
        const connected = this.runtime?.getSnapshot?.()?.isConnected === true;
        if (connected !== this.connected) {
          if (this.everConnected) this.snapshotBlocked = true;
          if (connected) this.everConnected = true;
          this.connected = connected; this.generation++;
          this.resetActivity(); this.pingAt = null; this.pingOk = false;
          this.pingPending = false; clearTimeout(this.pingTimer);
        }
      },
      readSnapshot(fromSubscription = false) {
        this.connection(); this.scope();
        if (!this.connected) return;
        const activity = this.store?.getState?.()?.activity;
        if (!activity) return;
        const root = normalizeId(activity.currentChatRootAgentId);
        const activityRoot = normalizeId(activity.agentActivityRootAgentId);
        const scoped = root && Object.hasOwn(activity.agentActivitiesByRootAgentId ?? {}, root)
          ? activity.agentActivitiesByRootAgentId[root] : null;
        const entry = scoped ?? ((root == null || root === activityRoot) ? activity : null);
        const code = typeof entry?.agentActivityCode === 'string' ? entry.agentActivityCode.slice(0, 64) : null;
        const signature = JSON.stringify([root, this.route, code]);
        const changed = this.snapshotSignature != null && signature !== this.snapshotSignature;
        const scopedUpdate = fromSubscription && scoped != null && this.snapshotRef != null && scoped !== this.snapshotRef;
        this.snapshotSignature = signature; this.snapshotRef = entry;
        // A newly observed explicit store value is useful as a LABELLED snapshot.
        // After an actual gap, old unchanged cache remains blocked.
        if (code == null || (this.snapshotBlocked && !changed && !scopedUpdate)) return;
        if (this.hasEvent && this.code === code) return;
        if (this.hasEvent && !changed && !scopedUpdate) return;
        if (this.hasSnapshot && this.code === code && !changed && !scopedUpdate) return;
        this.snapshotBlocked = false; this.hasSnapshot = true; this.hasEvent = false;
        this.code = code; this.evidence = fromSubscription || changed ? 'store_update' : 'store_snapshot';
        this.eventAt = Date.now();
        this.subagents = Number.isInteger(entry.agentSubagentCount)
          ? Math.max(0, Math.min(999, entry.agentSubagentCount)) : 0;
      },
      dispose() {
        this.generation++;
        try { this.unsubscribe?.(); } catch {}
        try { this.connectionUnsubscribe?.(); } catch {}
        try { this.storeUnsubscribe?.(); } catch {}
        clearTimeout(this.pingTimer);
      },
    };
    window[key] = obs;
  }
  const obs = window[key];
  const runtime = window.__hatchEarlyGatewayRuntimeState?.activeRuntime;
  if (runtime !== obs.runtime) {
    if (obs.everConnected) obs.snapshotBlocked = true;
    obs.dispose(); obs.runtime = runtime;
    obs.unsubscribe = null; obs.connectionUnsubscribe = null;
    obs.store = null; obs.storeUnsubscribe = null;
    obs.connected = false; obs.pingAt = null; obs.pingOk = false;
    obs.pingPending = false; obs.resetActivity();
    if (runtime?.getSnapshot && runtime?.subscribe) {
      obs.connection(); obs.scope();
      obs.connectionUnsubscribe = runtime.subscribe(() => obs.connection());
      const snapshot = runtime.getSnapshot();
      if (typeof snapshot.onEvent === 'function') {
        obs.unsubscribe = snapshot.onEvent('agent.status', (event, metadata) => {
          if (obs.runtime !== runtime) return;
          obs.rawEvents++;
          obs.connection(); obs.scope();
          if (!obs.connected || !event || typeof event.activity_code !== 'string') return;
          // Do not combine another chat's last activity with this chat's state.
          const eventRoot = normalizeId(event.agent_id);
          if (eventRoot != null && (obs.root == null || eventRoot !== obs.root)) { obs.filteredEvents++; return; }
          const seq = Number.isSafeInteger(metadata?.seq) ? metadata.seq : null;
          if (seq != null && obs.seq != null && seq <= obs.seq) return;
          obs.seq = seq; obs.code = event.activity_code.slice(0, 64);
          obs.hasEvent = true; obs.hasSnapshot = false; obs.snapshotBlocked = false;
          obs.evidence = 'gateway_event'; obs.eventAt = Date.now();
          obs.subagents = Number.isInteger(event.count) ? Math.max(0, Math.min(999, event.count)) : 0;
        });
      }
    }
  }
  const store = providerStore ?? window.__hatch_store__;
  if (store !== obs.store) {
    try { obs.storeUnsubscribe?.(); } catch {}
    obs.store = store; obs.storeUnsubscribe = null;
    if (typeof store?.subscribe === 'function') {
      obs.storeUnsubscribe = store.subscribe(() => obs.readSnapshot(true));
    }
  }
  obs.connection(); obs.scope();
  obs.readSnapshot();
  const snapshot = runtime?.getSnapshot?.();
  const sourceReady = Boolean(snapshot && store?.getState);
  if (obs.connected && typeof snapshot?.sendRequest === 'function' && !obs.pingPending &&
      (obs.pingAt == null || Date.now() - obs.pingAt >= 15000)) {
    const generation = obs.generation;
    const serial = ++obs.pingSerial;
    obs.pingPending = true;
    const settle = (ok) => {
      if (obs.generation !== generation || obs.runtime !== runtime || obs.pingSerial !== serial || !obs.pingPending) return;
      clearTimeout(obs.pingTimer); obs.pingPending = false;
      obs.pingOk = ok; obs.pingAt = Date.now();
      // A broken round trip invalidates old task status until a new event arrives.
      if (!ok) { obs.snapshotBlocked = true; obs.resetActivity(); }
    };
    obs.pingTimer = setTimeout(() => settle(false), 8000);
    try {
      Promise.resolve(snapshot.sendRequest('connection.ping', {})).then(() => settle(true), () => settle(false));
    } catch { settle(false); }
  }
  const activity = store?.getState?.()?.activity;
  return {
    sourceReady, connected: obs.connected, pingOk: obs.pingOk, pingAt: obs.pingAt,
    hasEvent: obs.hasEvent, hasSnapshot: obs.hasSnapshot, evidence: obs.evidence,
    code: obs.code, eventAt: obs.eventAt, subagents: obs.subagents,
    rawEvents: obs.rawEvents, filteredEvents: obs.filteredEvents,
    diagnostic: {
      rootPresent: normalizeId(activity?.currentChatRootAgentId) != null,
      activityRootPresent: normalizeId(activity?.agentActivityRootAgentId) != null,
      sameRoot: normalizeId(activity?.currentChatRootAgentId) === normalizeId(activity?.agentActivityRootAgentId),
      routePresent: activity?.currentChatRouteKey != null,
      globalCode: typeof activity?.agentActivityCode === 'string' ? activity.agentActivityCode.slice(0, 64) : null,
      scopedCount: Object.keys(activity?.agentActivitiesByRootAgentId ?? {}).length,
      storeSource: providerStore ? 'avatar_provider' : 'global_fallback',
    },
  };
}

function observerScript(reset = false) {
  return `(${observeMusePage.toString()})(${reset ? 'true' : 'false'})`;
}
module.exports = { observerScript };
