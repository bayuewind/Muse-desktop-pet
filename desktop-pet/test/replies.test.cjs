'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ReplyStore, blocks } = require('../native/replies.cjs');
const { attachmentPath, extractAttachments, readAttachment, sniffMime, MAX_FILE } = require('../native/attachments.cjs');
const file = { path:'sandbox://workspace/test/hello.py', byte_len:20 };
const presentation = { message_id:'a', transcript_surface:'main_chat', data:{file} };
const done = text => ({ message_id:'a', transcript_surface:'main_chat', transcript:{messages:[{role:'assistant',content:[{type:'text',text}]}]} });

test('real presentation shape does not terminate streaming; final transcript replaces deltas', () => {
  const store = new ReplyStore();
  store.ingest('delta.message_start',{message_id:'a'},{seq:1});
  store.ingest('delta.text_append',{message_id:'a',text:'hello'},{seq:2});
  store.ingest('delta.presentation',presentation,{seq:3});
  store.ingest('delta.text_append',{message_id:'a',text:' world'},{seq:4});
  assert.equal(store.snapshot().messages[0].text,'hello world');
  assert.equal(store.snapshot().messages[0].state,'streaming');
  assert.equal(store.snapshot().unread,1);
  store.ingest('delta.message_done',done('final\n```python\nprint(1)\n```'),{seq:5});
  assert.equal(store.code('a',0),'print(1)\n');
  const row=store.snapshot().messages[0];
  assert.equal(row.state,'done');
  assert.equal(row.attachments.length,1);
  assert.equal(row.attachments[0].path,undefined);
  assert.equal(store.asset('a',row.attachments[0].id).path,'workspace/test/hello.py');
  store.read(); assert.equal(store.snapshot().unread,0);
});
test('duplicate and out-of-order deltas cannot corrupt text or unread count', () => {
  const store = new ReplyStore();
  store.ingest('delta.text_append',{message_id:'a',text:'one'},{seq:2,epoch:1});
  assert.equal(store.ingest('delta.text_append',{message_id:'a',text:'duplicate'},{seq:2,epoch:1}),false);
  assert.equal(store.ingest('delta.text_append',{message_id:'a',text:'old'},{seq:1,epoch:1}),false);
  assert.equal(store.snapshot().messages[0].text,'one');
  store.interrupted();
  assert.equal(store.snapshot().messages[0].state,'interrupted');
});
test('hidden, reasoning, thread, and other-agent messages are omitted', () => {
  const store = new ReplyStore();
  for(const extra of [{visibility:'hidden'},{stream_lane:'reasoning'},{is_thread:true},{subagent_id:'other'},{transcript_surface:'subagent'},{payload:{visibility:'internal'}}]) {
    assert.equal(store.ingest('message.assistant',{message_id:'a',text:'private',...extra}),false);
  }
  assert.equal(store.snapshot().messages.length,0);
});
test('history combines text and multiple presentations in one batch and preserves newer live data', () => {
  const store = new ReplyStore();
  const event=(event_name,payload,seq)=>({event_name,message_id:'a',payload,seq,occurred_at_ms:1});
  store.history({chat_events:[event('delta.presentation',presentation,1),event('message.assistant',done('final'),2),event('delta.presentation',{...presentation,data:{images:[{path:'sandbox://workspace/test/a.png'}]}},3)]},0);
  assert.equal(store.snapshot().messages[0].text,'final');
  assert.equal(store.snapshot().messages[0].attachments.length,2);
  assert.equal(store.snapshot().unread,0);
  store.ingest('delta.text_append',{message_id:'b',text:'new live'});
  store.history({chat_events:[{event_name:'message.assistant',message_id:'b',payload:{text:'old'}}]},0);
  assert.equal(store.snapshot().messages.find(row=>row.id==='b').text,'new live');
});
test('sandbox paths reject traversal, encoded controls, external URLs, and protected locations', () => {
  assert.equal(attachmentPath('sandbox://workspace/test/a.png'),'workspace/test/a.png');
  assert.equal(attachmentPath('sandbox:/mnt/data/a.py'),'mnt/data/a.py');
  for(const value of ['https://example.com/a.png','sandbox://workspace/../a','workspace/%2e%2e/a','workspace/%252e%252e/a','workspace/a%00.py','workspace/a%5cb.py','workspace/.ssh/id_rsa','workspace/.env','workspace/.env.local','/etc/passwd','workspace/a?token=x']) assert.equal(attachmentPath(value),null,value);
});
test('attachments are extracted from observed image/audio/file shapes, never from fenced code', () => {
  const result=extractAttachments({data:{file,images:[{path:'sandbox://workspace/a.png'}],audio:{path:'sandbox://workspace/beep.wav'}}},'```md\n![fake](sandbox://workspace/fake.png)\n```');
  assert.deepEqual(result.map(a=>a.kind).sort(),['audio','code','image']);
  assert.equal(blocks('<script>alert(1)</script>')[0].kind,'text');
});
test('bounded native attachment reads verify size and canonical base64', async () => {
  const asset={path:'workspace/test/a.py',name:'a.py',kind:'code',size:3};
  const client={request:async(method,params)=>{
    assert.equal(params.path,asset.path);
    return method==='fs.stat'?{kind:'file',size:3}:{data_base64:'YWJj',len:3,eof:true};
  }};
  assert.equal((await readAttachment(client,asset)).bytes.toString(),'abc');
  await assert.rejects(readAttachment(client,{...asset,size:4}),/changed_since/);
  await assert.rejects(readAttachment({request:async()=>({kind:'file',size:MAX_FILE+1})},asset),/size_or_type/);
  await assert.rejects(readAttachment({request:async method=>method==='fs.stat'?{kind:'file',size:3}:{data_base64:'@@@@',len:3,eof:true}},asset),/read_invalid/);
  await assert.rejects(readAttachment({request:async method=>method==='fs.stat'?{kind:'file',size:3}:{data_base64:'YQ==',len:1,eof:true}},asset),/changed_during/);
});
test('media type is checked from bytes; HTML disguised as PNG is not previewed', () => {
  assert.equal(sniffMime(Buffer.from('<html>bad</html>'),'bad.png'),'application/octet-stream');
  const png=Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);
  assert.equal(sniffMime(png,'a.png'),'image/png');
  png.writeUInt32BE(999999,16); assert.throws(()=>sniffMime(png,'a.png'),/dimensions_limit/);
  assert.equal(sniffMime(Buffer.from('RIFFxxxxWAVE'),'beep.wav'),'audio/wav');
});
