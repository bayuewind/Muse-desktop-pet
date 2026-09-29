'use strict';
// Reads only the three artifacts from the explicitly authorized synthetic test.
// Does not execute code, autoplay audio, or print private session data.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { CredentialVault } = require('./vault.cjs');
const { NativeSource } = require('./source.cjs');
const { extractAttachments, readAttachment } = require('./attachments.cjs');
const { ReplyStore } = require('./replies.cjs');
app.setName('Muse 桌宠'); const directory=path.join(app.getPath('appData'),'MuseDesktopPet'); app.setPath('userData',directory);
let source;
app.whenReady().then(async () => {
  const reportFile = process.argv.find(arg => arg.endsWith('.json'));
  if (!reportFile || !path.resolve(reportFile).startsWith(path.resolve(__dirname,'../.test-output')+path.sep)) throw new Error('test_report_required');
  const report = JSON.parse(fs.readFileSync(reportFile,'utf8'));
  const assets=new Map(); for(const event of report.events)for(const asset of extractAttachments(event.payload))assets.set(asset.id,asset);
  source=new NativeSource(new CredentialVault(directory,safeStorage)); await source.start();
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('connection')),60000);const check=state=>{if(!['unknown','syncing','login','approval','limited'].includes(state.kind)){clearTimeout(timer);source.off('state',check);resolve();}};source.on('state',check);check(source.state.view());});
  const history = await source.client.request('chat.history', { limit: 20 });
  const rows = history.chat_events ?? history.messages ?? [];
  const replies = new ReplyStore(); replies.history(history, 0);
  const correlated = replies.snapshot().messages.filter(row => row.text.includes(report.marker) || row.attachments.some(asset => assets.has(asset.id)));
  console.log(JSON.stringify({step:'test_history_merge', messages:correlated.length,
    attachmentKinds:[...new Set(correlated.flatMap(row=>row.attachments.map(asset=>asset.kind)))],
    hasCompletedText:correlated.some(row=>row.text.includes('测试结束'))}));
  console.log(JSON.stringify({ step:'history_shape', keys:Object.keys(history), count:rows.length,
    eventNames:[...new Set(rows.map(row=>row.event_name??row.event??row.role))],
    firstFields:rows[0]?Object.keys(rows[0]):[], firstPayloadFields:rows[0]?.payload?Object.keys(rows[0].payload):[] }));
  const results=[];
  for(const asset of assets.values()){
    if(!asset.path.includes(report.marker))continue;
    try {
      const result=await readAttachment(source.client,asset);
      results.push({name:asset.name,kind:asset.kind,size:result.size,mime:result.mime,ok:true});
    } catch(error) { results.push({name:asset.name,ok:false,httpStatus:error.httpStatus,reason:/^[a-z_]{1,60}$/.test(error.message)?error.message:'read_failed'}); }
  }
  console.log(JSON.stringify({step:'test_attachment_readback',results}));
  await source.stop();app.exit(results.length===3&&results.every(r=>r.ok)?0:1);
}).catch(async()=>{console.log('TEST_ASSET_READBACK_FAILED');await source?.stop();app.exit(1);});
app.on('window-all-closed',()=>{});
