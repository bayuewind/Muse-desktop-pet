'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
async function main() {
  const asar = await import('@electron/asar');
  const directory = path.resolve(__dirname, '../dist');
  const packageInfo = require('../package.json');
  const executable = path.join(directory, 'win-unpacked', 'MuseDesktopPet.exe');
  const archive = path.join(directory, 'win-unpacked', 'resources', 'app.asar');
  const entries = asar.listPackage(archive).map(value => value.replace(/\\/g, '/'));
  for (const required of ['/main.cjs', '/pet.html', '/composer.html', '/pcm-worklet.js', '/visible-browser.cjs', '/assets/muse.png', '/assets/muse.ico',
    '/native/accounts.cjs', '/native/source.cjs', '/native/vault.cjs', '/native/wire.cjs',
    '/workspace-ui.js', '/workspace.css', '/sessions-ui.js', '/audio-player.js', '/input-ui.js',
    '/capture-ui.js', '/crop-geometry.js', '/capture-screen.cjs', '/input-attachments.cjs', '/notifications.cjs', '/preferences.cjs',
    '/native/workspace.cjs', '/native/spaces.cjs', '/native/conversations.cjs', '/native/thread-chat.cjs', '/native/chat-input.cjs',
    '/node_modules/lucide/dist/umd/lucide.min.js',
    '/node_modules/puppeteer-core/package.json', '/node_modules/protobufjs/package.json',
    '/node_modules/tough-cookie/package.json', '/node_modules/ws/package.json']) {
    if (!entries.includes(required)) throw new Error(`Missing packaged file: ${required}`);
  }
  const firstParty = entries.filter(entry => /^\/[^/]+\.(?:cjs|js|html|css)$/.test(entry) || /^\/native\/[^/]+\.cjs$/.test(entry));
  for (const entry of firstParty) {
    const packaged = asar.extractFile(archive, entry.slice(1));
    const source = fs.readFileSync(path.join(__dirname, '..', entry.slice(1)));
    if (!packaged.equals(source)) throw new Error(`Stale packaged source: ${entry}`);
  }
  const packagedInfo = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packagedInfo.version !== packageInfo.version) throw new Error('packaged_version_mismatch');
  const trayIcon = path.join(directory, 'win-unpacked', 'resources', 'app.asar.unpacked', 'assets', 'muse.ico');
  if (!fs.existsSync(trayIcon) || !fs.readFileSync(trayIcon).equals(fs.readFileSync(path.resolve(__dirname, '../assets/muse.ico')))) {
    throw new Error('packaged_tray_icon_missing_or_stale');
  }
  for (const entry of entries) {
    if (/^\/(test|scripts|\.git|\.test-output)\//.test(entry) ||
      /^\/native\/(test-|probe\.|pair\.|complete-pair\.|contract-check\.|ssh\.|relay-proxy\.|script-manifest\.)/.test(entry) ||
      /(?:^|\/)(?:native-session\.(?:enc|disabled)|AccountLogin-[^/]*|ChromeLogin|electron-builder)(?:\/|$)/.test(entry)) {
      throw new Error(`Unexpected runtime/private/development file in package: ${entry}`);
    }
  }
  console.log(`PACKAGE_CONTENTS_PASS: ${firstParty.length} first-party runtime files match tested source; runtime dependencies present; no account data, dev scripts or tests`);
  const { stdout } = await promisify(execFile)(executable, ['--smoke-test'], {
    timeout: 60000, windowsHide: false, maxBuffer: 1024 * 1024,
  });
  if (!stdout.includes('SMOKE_PASS:')) throw new Error('packaged_smoke_did_not_pass');
  console.log(stdout.trim());
  const name = `Muse-Desktop-Pet-${packageInfo.version}-win-x64-setup.exe`;
  const installer = path.join(directory, name), bytes = fs.readFileSync(installer);
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('installer_not_windows_executable');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(directory, `${name}.sha256`), `${sha256}  ${name}\n`);
  console.log(JSON.stringify({ installer, bytes: bytes.length, sha256, signing: 'unsigned' }));
}
main().catch(error => { console.error('PACKAGE_VERIFY_FAIL:', error.message); process.exitCode = 1; });
