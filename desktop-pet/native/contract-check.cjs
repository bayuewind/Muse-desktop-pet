'use strict';
// One-time pairing diagnostic; output contains header NAMES and public request
// metadata only. This is not a runtime bridge or token-refresh fallback.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const { CredentialVault } = require('./vault.cjs');
const { ChromeEngine } = require('../chrome-engine.cjs');
app.setName('Muse 桌宠');
const directory = path.join(app.getPath('appData'), 'MuseDesktopPet');
app.setPath('userData', directory);
let engine;
app.whenReady().then(async () => {
  const bundle = new CredentialVault(directory, safeStorage).load();
  engine = new ChromeEngine(path.join(directory, 'ChromeLogin'), () => {});
  await engine.start();
  await engine.page.waitForFunction(() => location.origin === 'https://muse.ai' &&
    Boolean(document.querySelector('[data-hatch-avatar-host]')), { timeout: 45000 });
  const cdp = await engine.page.createCDPSession();
  await cdp.send('Network.enable');
  const selected = new Set(), summaries = new Map();
  const emitSummary = id => {
    if (selected.has(id) && summaries.has(id)) {
      console.log(JSON.stringify({ step: 'official_network_metadata', ...summaries.get(id) }));
      selected.delete(id); summaries.delete(id);
    }
  };
  cdp.on('Network.requestWillBeSent', event => {
    if (event.request.url === 'https://muse.ai/api/hatch/token') { selected.add(event.requestId); emitSummary(event.requestId); }
  });
  cdp.on('Network.requestWillBeSentExtraInfo', event => {
    const headers = Object.fromEntries(Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value]));
    summaries.set(event.requestId, { headerNames: Object.keys(headers), origin: headers.origin,
      fetchSite: headers['sec-fetch-site'], fetchMode: headers['sec-fetch-mode'], fetchDest: headers['sec-fetch-dest'] });
    emitSummary(event.requestId);
    if (summaries.size > 100) summaries.delete(summaries.keys().next().value);
  });
  engine.page.on('request', request => {
    if (request.url() !== 'https://muse.ai/api/hatch/token') return;
    const headers = request.headers();
    console.log(JSON.stringify({ step: 'official_request_contract', headerNames: Object.keys(headers),
      origin: headers.origin, fetchSite: headers['sec-fetch-site'], fetchMode: headers['sec-fetch-mode'], fetchDest: headers['sec-fetch-dest'] }));
  });
  const result = await engine.page.evaluate(async target => {
    if (location.origin !== 'https://muse.ai') return { status: 0 };
    const response = await fetch('/api/hatch/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vmAddress: target.gatewayUrl, vmName: target.vmName }) });
    const data = await response.json();
    return { status: response.status, responseKeys: Object.keys(data), tokenPresent: typeof data.token === 'string' };
  }, bundle.target);
  console.log(JSON.stringify({ step: 'official_contract_result', ...result }));
  await cdp.detach();
  await engine.stop(); app.exit(0);
}).catch(async () => { console.log(JSON.stringify({ step: 'contract_check_failed' })); try { await engine?.stop(); } catch {} app.exit(1); });
app.on('window-all-closed', () => {});
