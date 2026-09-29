'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Accounts } = require('../native/accounts.cjs');
const { CredentialVault } = require('../native/vault.cjs');
const { NativeAuth } = require('../native/auth.cjs');
const { NativeSource } = require('../native/source.cjs');
const { AccountPairing } = require('../native/account-pairing.cjs');
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-accounts-test-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const vault = new CredentialVault(directory, { isEncryptionAvailable:()=>true,
    encryptString:text=>Buffer.from(text), decryptString:bytes=>bytes.toString() });
  const bundle = id => ({version:1,origin:'https://muse.ai',target:{vmId:id,vmName:id,gatewayUrl:`https://${id}.metaaivm.com/`},
    cookieJar:{version:'tough-cookie@6.0.0',storeType:'MemoryCookieStore',cookies:[]},pairedAt:id});
  let starts=0, resets=0, wiped=0, stopped=0;
  const pairing = {active:true,start:async()=>{},complete:async()=>bundle('new-account'),stop:async()=>{pairing.active=false;}};
  const accounts = new Accounts({vault,makePairing:()=>pairing,resetViews:()=>resets++,
    makeSource:()=>({start:async()=>{starts++;},stop:async()=>{stopped++;},clearAccountData:()=>wiped++})});
  return {vault,bundle,accounts,pairing,counts:()=>({starts,resets,wiped,stopped})};
}
test('logout clears local credentials and views; restart never restores old account', async t => {
  const {vault,bundle,accounts,counts}=setup(t);vault.save(bundle('old-account'));
  await accounts.restore();assert.equal(accounts.phase,'connected');
  const oldAuth=new NativeAuth(vault);
  await accounts.logout();
  assert.equal(accounts.phase,'signed_out');assert.equal(accounts.source,null);assert.equal(vault.exists(),false);
  assert.deepEqual(counts(),{starts:1,resets:1,wiped:1,stopped:1});
  assert.throws(()=>oldAuth.persist(),/authorization_required/);
  await accounts.restore();assert.equal(counts().starts,1);
});
test('fresh login saves only verified candidate and old renewal cannot overwrite new account', async t => {
  const {vault,bundle,accounts,pairing}=setup(t);vault.save(bundle('old-account'));
  const oldAuth=new NativeAuth(vault);await accounts.restore();await accounts.logout();
  pairing.active=true;await accounts.login();assert.equal(vault.exists(),false);
  await accounts.complete();assert.equal(accounts.phase,'connected');
  assert.equal(vault.load().target.vmId,'new-account');assert.equal(pairing.active,false);
  assert.throws(()=>oldAuth.persist(),/credentials_repaired/);
  assert.equal(vault.load().target.vmId,'new-account');
});
test('pairing failure leaves credentials absent and allows user retry', async t => {
  const {vault,accounts,pairing}=setup(t);
  pairing.complete=async()=>{throw new Error('identity mismatch');};
  await accounts.login();await assert.rejects(accounts.complete(),/pairing_failed/);
  assert.equal(accounts.phase,'awaiting_login');assert.equal(vault.exists(),false);
  await accounts.logout();assert.equal(accounts.phase,'signed_out');
});
test('cancel during verification prevents late result from storing credentials or starting source', async t => {
  const {vault,bundle,accounts,pairing,counts}=setup(t);let resolve;
  pairing.complete=()=>new Promise(done=>{resolve=done;});
  await accounts.login();const pending=accounts.complete();await accounts.logout();
  resolve(bundle('too-late'));await pending;
  assert.equal(vault.exists(),false);assert.equal(counts().starts,0);assert.equal(accounts.phase,'signed_out');
});
test('failed profile cleanup persists a fail-closed tombstone across restart', async t => {
  const {vault,bundle,accounts}=setup(t);vault.save(bundle('old-account'));
  await accounts.restore();accounts.clearLegacy=async()=>{throw new Error('locked');};
  await assert.rejects(accounts.logout(),/cleanup_failed/);
  assert.equal(accounts.phase,'cleanup_failed');assert.equal(vault.isDisabled(),true);
  assert.throws(()=>vault.load(),/authorization_required/);
  assert.throws(()=>vault.save(bundle('late')),/authorization_required/);
  await accounts.restore();assert.equal(accounts.phase,'cleanup_failed');assert.equal(accounts.source,null);
  accounts.clearLegacy=async()=>{};await accounts.logout();assert.equal(vault.isDisabled(),false);
  assert.equal(accounts.phase,'signed_out');
});
test('account cache disposal wipes binary previews, messages, unread state and listeners', async () => {
  const source=new NativeSource({});
  source.replies.ingest('message.assistant',{message_id:'old',text:'private fixture'});
  const bytes=Buffer.from('sensitive');source.assetCache.set('old',{value:{bytes,size:bytes.length}});
  source.on('replies',()=>{});await source.stop();source.clearAccountData();
  assert.deepEqual(source.replies.snapshot(),{messages:[],unread:0});
  assert.ok(bytes.every(byte=>byte===0));assert.equal(source.assetCache.size,0);assert.equal(source.listenerCount('replies'),0);
});
function pairingFixture(t, {policy='disabled',mismatch=false,badNonce=false}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'muse-pair-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const profiles=[],calls=[];
  const pairing=new AccountPairing(directory,{
    makeBrowser:profile=>{profiles.push(profile);return {start:async()=>{},stop:async()=>{},
      evaluate:async()=>({target:{vmId:'test',vmName:'test',gatewayUrl:'https://test.metaaivm.com/'},policyHints:{bootstrap_rolloutStatus:policy}}),
      browser:{defaultBrowserContext:()=>({cookies:async()=>[{name:'hatch_sess',value:'synthetic-test-only',domain:'muse.ai',secure:true,path:'/'}]})}};},
    makeAuth:vault=>({renewSession:async()=>{
      calls.push('assignment');const bundle=vault.load();bundle.updatedAt=1;vault.save(bundle);
      return {vmIdentityMatched:!mismatch,vmNameMatches:true,endpointMatches:true};
    },credentials:async()=>{calls.push('token');return {};}}),
    makeClient:()=>({connect:async(_credentials,verify)=>{
      calls.push('handshake');const key=Buffer.alloc(32,1),nonce=Buffer.alloc(32,2);
      await verify({serverKey:key,clientNonce:badNonce?Buffer.alloc(32,3):nonce,payload:Buffer.concat([Buffer.from([18,68,10,32]),key,Buffer.from([18,32]),nonce])});
    },request:async method=>{assert.equal(method,'connection.ping');calls.push('ping');},close:()=>{}}),
  });
  return {pairing,profiles,calls,directory};
}
test('new login uses a fresh profile and validates assignment, binding and ping before returning a memory-only bundle', async t=>{
  const {pairing,profiles,calls,directory}=pairingFixture(t);
  await pairing.start();const bundle=await pairing.complete();
  assert.equal(bundle.peerPolicy.serverKeyHex,'01'.repeat(32));
  assert.deepEqual(calls,['assignment','token','handshake','ping']);
  assert.equal(fs.existsSync(path.join(directory,'native-session.enc')),false);
  assert.ok(path.basename(profiles[0]).startsWith('AccountLogin-'));
  await Promise.all([pairing.stop(),pairing.stop()]);assert.equal(fs.existsSync(profiles[0]),false);
});
test('new login rejects confidential policy, mismatched assignment and wrong freshness binding', async t=>{
  for(const options of [{policy:'enabled'},{mismatch:true},{badNonce:true}]) {
    const {pairing,calls}=pairingFixture(t,options);await pairing.start();
    await assert.rejects(pairing.complete());assert.equal(calls.includes('ping'),false);await pairing.stop();
  }
});
