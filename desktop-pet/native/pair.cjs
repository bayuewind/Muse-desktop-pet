'use strict';
// One-time user-approved migration. Never prints cookie values or tokens.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const { ChromeEngine } = require('../chrome-engine.cjs');
const { CredentialVault } = require('./vault.cjs');
const { importDedicatedCookies, validateTarget, NativeAuth } = require('./auth.cjs');
app.setName('Muse 桌宠');
const directory = path.join(app.getPath('appData'), 'MuseDesktopPet');
app.setPath('userData', directory);
let engine;
async function pair() {
  if (!process.argv.includes('--approved-session-export')) throw new Error('explicit_authorization_required');
  const vault = new CredentialVault(directory, safeStorage); vault.ensureAvailable();
  engine = new ChromeEngine(path.join(directory, 'ChromeLogin'), () => {});
  await engine.start();
  await engine.page.waitForFunction(() => location.origin === 'https://muse.ai' &&
    Boolean(document.querySelector('[data-hatch-avatar-host]')), { timeout: 45000 });
  const metadata = await engine.evaluate(`(() => {
    const host=document.querySelector('[data-hatch-avatar-host]');
    const key=host&&Object.keys(host).find(k=>k.startsWith('__reactFiber$'));
    let fiber=key?host[key]:null,target=null;const policyHints={};
    for(let depth=0;fiber&&depth<220;depth++,fiber=fiber.return){
      const value=fiber.memoizedProps?.value;if(!value||typeof value!=='object')continue;
      if(typeof value.gatewayUrl==='string'&&typeof value.vmId==='string')target={gatewayUrl:value.gatewayUrl,vmId:value.vmId,vmName:value.vmName};
      for(const field of ['attestationTier','attestationEnforcementTier','cvmEnabled','cvmRolloutStatus','rolloutStatus','vmType']){
        if(typeof value[field]==='boolean'||typeof value[field]==='string')policyHints[field]=value[field];
      }
      if(value.cvmBootstrap&&typeof value.cvmBootstrap==='object'){
        policyHints.cvmBootstrapKeys=Object.keys(value.cvmBootstrap);
        for(const field of ['rolloutStatus','attestationTier','vmType'])if(typeof value.cvmBootstrap[field]==='string')policyHints['bootstrap_'+field]=value.cvmBootstrap[field];
      }
    }
    return {target,policyHints};
  })()`);
  const target = validateTarget(metadata.target);
  const cookies = await engine.browser.defaultBrowserContext().cookies();
  const { jar, count } = importDedicatedCookies(cookies);
  for (const cookie of cookies) cookie.value = '';
  vault.save({ version: 1, origin: 'https://muse.ai', target,
    cookieJar: jar.serializeSync(), policyHints: metadata.policyHints, pairedAt: Date.now(),
    authorization: { scope: 'dedicated_muse_session_only', nativeRenewal: true } });
  const loaded = vault.load();
  console.log(JSON.stringify({ step: 'encrypted_session_saved', cookieCount: count,
    encryption: 'os_safe_storage', roundTrip: loaded.target.vmId === target.vmId,
    policyHints: metadata.policyHints }));
  // End the one-time browser before validating the native HTTP path.
  await engine.stop(); engine = null;
  const auth = new NativeAuth(vault);
  const renewal = await auth.renewSession();
  console.log(JSON.stringify({ step: 'native_session_renewal', ...renewal }));
  const token = await auth.credentials();
  console.log(JSON.stringify({ step: 'native_token_received', present: Boolean(token.authToken),
    hasNotary: Boolean(token.notaryToken), expiresInSeconds: Math.max(0, Math.floor((token.expiresAt-Date.now())/1000)) }));
}
app.whenReady().then(pair).then(() => app.exit(0)).catch(async error => {
  // Error.message is NEVER printed: browser/HTTP errors may contain credentials.
  const known = new Set(['os_encryption_unavailable','muse_session_cookie_missing','vm_identity_missing',
    'invalid_gateway_target','authorization_required','auth_network_error','auth_service_error',
    'auth_invalid_response','vm_assignment_unavailable','vm_assignment_changed','vm_identity_unverified','gateway_token_missing']);
  console.log(JSON.stringify({ step: 'pairing_stopped', reason: known.has(error.message) ? error.message : 'pairing_failed' }));
  try { await engine?.stop(); } catch {}
  app.exit(1);
});
app.on('window-all-closed', () => {});
