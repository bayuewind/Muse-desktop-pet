'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('avatar clips images and video independently of its badge, status dot and outer shadow', () => {
  const html = fs.readFileSync(path.join(__dirname, '../pet.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../pet.css'), 'utf8');
  assert.match(html, /<span class="portrait-media">[\s\S]*?<img id="still"[\s\S]*?<video id="avatar"[\s\S]*?<\/span>\s*<span id="unread"/);
  assert.match(css, /\.portrait-media \{[^}]*overflow: hidden;[^}]*clip-path: circle\(50% at 50% 50%\);[^}]*isolation: isolate;/);
  assert.match(css, /\.portrait-media video, \.portrait-media img \{[^}]*clip-path: circle\(50% at 50% 50%\);/);
  assert.doesNotMatch(css, /\.portrait \{[^}]*overflow:\s*hidden/);
});
