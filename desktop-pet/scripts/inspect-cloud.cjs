'use strict';
// Read-only schema inspection through the existing verified native session.
// Values (including titles, prompts, IDs, and credentials) are never printed.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const { CredentialVault } = require('../native/vault.cjs');
const { NativeSource } = require('../native/source.cjs');
app.setName('Muse 桌宠');
app.setPath('userData', path.join(app.getPath('appData'), 'MuseDesktopPet'));
let source;
function shape(value, depth = 0) {
  if (value == null) return 'null';
  if (Array.isArray(value)) return { type: 'array', count: value.length, items: value.slice(0, 2).map(item => shape(item, depth + 1)) };
  if (typeof value !== 'object') return typeof value;
  if (depth > 4) return 'object';
  return Object.fromEntries(Object.keys(value).slice(0, 60).map(key => [key, shape(value[key], depth + 1)]));
}
app.whenReady().then(async () => {
  source = new NativeSource(new CredentialVault(app.getPath('userData'), safeStorage));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { source.off('state', check); reject(new Error('connection_timeout')); }, 65000);
    function check() {
      if (source.state.pollAt) { clearTimeout(timeout); source.off('state', check); resolve(); }
    }
    source.on('state', check);
  });
  await source.start();
  await ready;
  const methods = process.argv.includes('--spaces') ? ['goals.list', 'ideas.list', 'sessions.list']
    : ['tasks.list', 'tasks.runs', 'subagents.list', 'activity.list'];
  for (const method of methods) {
    const response = await source.client.request(method, method === 'tasks.runs' ? { limit: 10 } : {});
    console.log(JSON.stringify({ method, shape: shape(response) }));
  }
  if (process.argv.includes('--spaces')) {
    const result = await source.refreshSpaces();
    const snapshot = source.spaces.snapshot(source.state);
    if (!result.ok || !snapshot.goals.fresh || !snapshot.ideas.fresh) throw new Error('spaces_integration_failed');
    console.log(JSON.stringify({ step: 'normalized_spaces_verified', goals: snapshot.goals.rows.length,
      ideas: snapshot.ideas.rows.length, goalsFresh: snapshot.goals.fresh, ideasFresh: snapshot.ideas.fresh,
      goalsPartial: snapshot.goals.partial, ideasPartial: snapshot.ideas.partial }));
  }
  await source.stop();
  app.exit(0);
}).catch(async () => {
  console.error('READ_ONLY_SCHEMA_INSPECTION_FAILED');
  await source?.stop();
  app.exit(1);
});
app.on('window-all-closed', () => {});
