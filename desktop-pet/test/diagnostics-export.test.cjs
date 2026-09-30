'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LoginDiagnostics, networkCode, safeFailure } = require('../diagnostics.cjs');
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const exportSource = source.slice(source.indexOf('async function exportLoginDiagnostics()'),
  source.indexOf('async function runAccountAction(action)'));
function fixture({ canceled = false, writeError, save } = {}) {
  const writes = [], messages = [];
  const context = vm.createContext({ exportingDiagnostics: false, quitting: false, path,
    app: { getPath: () => 'downloads' }, accounts: { phase: 'awaiting_login', loginDetection: 'verification_failed' },
    loginDiagnostics: new LoginDiagnostics({ version: '0.2.1' }),
    fs: { promises: { writeFile: async (...args) => { if (writeError) throw writeError; writes.push(args); } } },
    dialog: { showSaveDialog: save ?? (async () => ({ canceled, filePath: 'chosen-report.json' })),
      showMessageBox: async value => { messages.push(value); } } });
  vm.runInContext(exportSource, context);
  return { context, writes, messages, run: () => context.exportLoginDiagnostics() };
}
test('export serializes a sanitized report only to the user-selected file with exclusive creation', async () => {
  const { run, writes, messages, context } = fixture();
  await run();
  assert.equal(writes.length, 1); assert.equal(writes[0][0], 'chosen-report.json');
  assert.equal(writes[0][2].flag, 'wx');
  assert.equal(JSON.parse(writes[0][1]).runtime.appVersion, '0.2.1');
  assert.equal(messages[0].type, 'info'); assert.equal(context.exportingDiagnostics, false);
});
test('cancel, existing files, and write failures never report successful export or expose raw errors', async () => {
  const cancel = fixture({ canceled: true }); await cancel.run();
  assert.equal(cancel.writes.length, 0); assert.equal(cancel.messages.length, 0);
  for (const code of ['EEXIST', 'EACCES']) {
    const result = fixture({ writeError: Object.assign(new Error('PRIVATE_PATH'), { code }) });
    await result.run();
    assert.equal(result.writes.length, 0); assert.equal(result.messages[0].type, 'error');
    assert.equal(JSON.stringify(result.messages).includes('PRIVATE_PATH'), false);
    assert.equal(result.context.exportingDiagnostics, false);
  }
});
test('concurrent export clicks create only one save dialog', async () => {
  let resolve, dialogs = 0;
  const result = fixture({ save: () => { dialogs++; return new Promise(done => { resolve = done; }); } });
  const pending = result.run(); await result.run();
  assert.equal(dialogs, 1);
  resolve({ canceled: true }); await pending;
  assert.equal(result.context.exportingDiagnostics, false);
});
test('network codes retain useful DNS and TLS failures, never arbitrary messages', () => {
  assert.equal(networkCode({ cause: { code: 'ENOTFOUND' } }), 'ENOTFOUND');
  assert.equal(networkCode({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(networkCode({ name: 'TimeoutError' }), 'TimeoutError');
  assert.equal(networkCode({ code: 'PRIVATE_TOKEN' }), undefined);
  assert.equal(safeFailure('session', { message: 'auth_network_error', networkCode: 'PRIVATE_TOKEN' }).networkCode, undefined);
  assert.equal(safeFailure('session', { message: 'auth_network_error', networkCode: 'ENOTFOUND' }).networkCode, 'ENOTFOUND');
});
