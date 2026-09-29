'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('native state source loads no browser automation or DOM observer module', () => {
  const { NativeSource } = require('../native/source.cjs');
  assert.equal(typeof NativeSource, 'function');
  const loaded = Object.keys(require.cache);
  assert.equal(loaded.some(file => /puppeteer|chrome-engine\.cjs|observer\.cjs/.test(file)), false);
});
