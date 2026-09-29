'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../electron-builder.json');
const pkg = require('../package.json');
const root = path.resolve(__dirname, '..');

test('Windows package identity and executable match the runtime and verification script', () => {
  assert.equal(config.appId, 'com.bayuewind.muse-desktop-pet');
  assert.equal(config.executableName, 'MuseDesktopPet');
  assert.ok(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8').includes(`app.setAppUserModelId('${config.appId}')`));
  assert.equal(config.win.target[0].target, 'nsis');
  assert.deepEqual(config.win.target[0].arch, ['x64']);
});

test('installer defaults to per-user and preserves existing local authorization on uninstall', () => {
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.selectPerMachineByDefault, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
});

test('builds are explicitly unsigned and never publish automatically', () => {
  assert.equal(config.win.signExecutable, false);
  assert.match(pkg.scripts['dist:win'], /--publish never/);
  assert.match(pkg.scripts['pack:win'], /--publish never/);
  assert.equal(config.publish, undefined);
});

test('installer, app and tray share the bundled real-avatar icon with high-DPI sizes', () => {
  assert.equal(config.win.icon, 'assets/muse.ico');
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  assert.ok(config.files.includes('assets/*.ico'));
  assert.ok(config.files.includes('assets/*.png'));
  assert.ok(config.asarUnpack.includes('assets/*.ico'));
  const ico = fs.readFileSync(path.join(root, config.win.icon));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4), sizes = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16, size = ico[entry] || 256;
    sizes.push(size);
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + length <= ico.length);
    assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
  assert.doesNotMatch(main, /app\.getFileIcon\(process\.execPath/);
  assert.match(main, /tray_icon_missing/);
});

test('finish page offers an opt-out desktop checkbox; default early creation is disabled only for installer', () => {
  assert.equal(config.nsis.include, 'build/installer.nsh');
  assert.equal(config.nsis.createDesktopShortcut, true); // Preserve uninstaller's shortcut removal.
  const script = fs.readFileSync(path.join(root, config.nsis.include), 'utf8');
  assert.match(script, /!ifndef BUILD_UNINSTALLER[\s\S]*!define DO_NOT_CREATE_DESKTOP_SHORTCUT/);
  assert.match(script, /MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"/);
  assert.match(script, /MUI_FINISHPAGE_SHOWREADME_FUNCTION MuseFinishShortcut/);
  assert.match(script, /MUI_FINISHPAGE_RUN_TEXT "启动 Muse 桌宠"/);
  const writes = script.match(/CreateShortCut/g) ?? [];
  assert.equal(writes.length, 1);
  assert.match(script, /Function MuseFinishShortcut[\s\S]*CreateShortCut/);
});

test('package includes only explicit native runtime files, not diagnostics or private profiles', () => {
  assert.equal(config.asar, true);
  assert.equal(config.files.includes('**/*'), false);
  const nativePattern = config.files.find(value => value.startsWith('native/{'));
  const modules = nativePattern.slice('native/{'.length, -'}\.cjs'.length).split(',');
  for (const name of modules) assert.ok(fs.existsSync(path.join(root, 'native', `${name}.cjs`)), name);
  for (const name of ['accounts', 'account-pairing', 'source', 'vault', 'wire', 'gateway-client']) assert.ok(modules.includes(name));
  for (const name of ['pair', 'probe', 'test-assets', 'test-roundtrip', 'ssh']) assert.equal(modules.includes(name), false);
  assert.equal(config.files.some(value => /AccountLogin|ChromeLogin|native-session|\.test-output/.test(value)), false);
});
