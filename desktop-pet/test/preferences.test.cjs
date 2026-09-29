'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Preferences, normalize } = require('../preferences.cjs');
test('preferences persist only validated non-sensitive settings and ignore corrupt input', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-preferences-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefs = new Preferences(directory);
  assert.deepEqual(prefs.snapshot(), { notifications: true, quietUntil: 0 });
  prefs.update({ notifications: false, quietUntil: Date.now() + 3600000 });
  assert.equal(new Preferences(directory).snapshot().notifications, false);
  for (const bad of [{ token: 'secret' }, { notifications: 1 }, { quietUntil: Infinity }, { quietUntil: -1 }, { quietUntil: Date.now() + 172800000 }, []])
    assert.throws(() => prefs.update(bad), /invalid_preferences/);
  fs.writeFileSync(prefs.file, '{invalid');
  assert.equal(new Preferences(directory).snapshot().notifications, true);
});
test('quiet hours expire and never survive a far-future clock change', () => {
  assert.equal(normalize({ quietUntil: 1000 }, 2000).quietUntil, 0);
  assert.equal(normalize({ quietUntil: 1000000000 }, 2000).quietUntil, 0);
  assert.equal(normalize({ quietUntil: 3000 }, 2000).quietUntil, 3000);
});
