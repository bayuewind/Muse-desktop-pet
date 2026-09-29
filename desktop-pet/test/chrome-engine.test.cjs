'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromeCandidates, findChrome, browserLaunchArgs } = require('../chrome-engine.cjs');

test('Windows browser discovery supports Chrome and Edge system/user installs', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
  const candidates = chromeCandidates('win32', env);
  assert.deepEqual(candidates, [
    path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]);
  assert.equal(findChrome({ platform: 'win32', env, existsSync: candidate => candidate === candidates[2] }), candidates[2]);
  assert.equal(findChrome({ platform: 'win32', env, existsSync: candidate => candidate === candidates[3] }), candidates[3]);
});

test('login opens Muse in a normal isolated browser window, not app mode', () => {
  const args = browserLaunchArgs('C:\\isolated-profile');
  assert.ok(args.includes('about:blank'));
  assert.ok(args.some(value => value.startsWith('--user-data-dir=')));
  assert.equal(args.some(value => value.startsWith('--app=')), false);
  assert.equal(args.includes('--use-mock-keychain'), false);
  assert.equal(args.includes('--password-store=basic'), false);
  assert.equal(args.some(value => value.startsWith('--disable-features=')), false);
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(args.includes('--enable-automation'));
  for (const forbidden of ['--remote-debugging-port', '--headless', '--no-sandbox', '--disable-web-security',
    '--ignore-certificate-errors', '--disable-client-side-phishing-detection', '--disable-popup-blocking']) {
    assert.equal(args.some(value => value.startsWith(forbidden)), false);
  }
});
