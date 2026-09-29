'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DEFAULTS = Object.freeze({ notifications: true, quietUntil: 0 });
function normalize(value, now = Date.now()) {
  return { notifications: typeof value?.notifications === 'boolean' ? value.notifications : DEFAULTS.notifications,
    quietUntil: Number.isFinite(value?.quietUntil) && value.quietUntil > now && value.quietUntil <= now + 86400000
      ? value.quietUntil : 0 };
}
class Preferences {
  constructor(directory) {
    this.file = path.join(directory, 'desktop-preferences.json');
    try { this.value = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { this.value = { ...DEFAULTS }; }
  }
  snapshot() { return normalize(this.value); }
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key)) ||
        Object.hasOwn(patch, 'notifications') && typeof patch.notifications !== 'boolean' ||
        Object.hasOwn(patch, 'quietUntil') && (!Number.isFinite(patch.quietUntil) || patch.quietUntil < 0 || patch.quietUntil > Date.now() + 86400000))
      throw new Error('invalid_preferences');
    const next = normalize({ ...this.value, ...patch });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.value = next;
    return this.snapshot();
  }
}
module.exports = { Preferences, normalize };
