'use strict';
// Explicitly user-requested live test. Exactly one benign prompt, no retries,
// microphone, local code execution, or changes to existing remote files.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { CredentialVault } = require('./vault.cjs');
const { NativeSource } = require('./source.cjs');
app.setName('Muse 桌宠');
const directory = path.join(app.getPath('appData'), 'MuseDesktopPet'); app.setPath('userData', directory);
const marker = `MUSE_DESKTOP_TEST_${Date.now()}`;
let source, finished = false, receipt, started = false;
const events = [], knownIds = new Set();
function selected() {
  for (let pass = 0; pass < 3; pass++) for (const e of events) {
    const p = e.payload ?? {};
    if (JSON.stringify(p).includes(marker) || [p.reply_to_message_id,p.host_message_id].some(id => id && knownIds.has(id))) {
      if (p.message_id) knownIds.add(p.message_id);
    }
  }
  return events.filter(e => knownIds.has(e.payload?.message_id) || knownIds.has(e.payload?.host_message_id));
}
async function finish(reason, code) {
  if (finished) return; finished = true;
  const output = selected();
  const folder = path.join(__dirname, '../.test-output'); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${marker}.json`);
  fs.writeFileSync(file, JSON.stringify({ marker, reason, receipt, events: output }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ step: 'live_test_result', reason, selectedEvents: output.length,
    eventTypes: [...new Set(output.map(e => e.type))], report: file }));
  await source?.stop(); app.exit(code);
}
app.whenReady().then(async () => {
  source = new NativeSource(new CredentialVault(directory, safeStorage));
  source.on('chat-event', (type, payload, meta) => {
    if (!started || payload?.subagent_id || (payload?.transcript_surface && payload.transcript_surface !== 'main_chat')) return;
    if (events.length < 1000) events.push({ type, payload, meta });
    const match = selected();
    const ended = match.some(e => ['message.assistant','delta.message_done'].includes(e.type) &&
      JSON.stringify(e.payload).includes(marker) && JSON.stringify(e.payload).includes('测试结束'));
    if (ended) setTimeout(() => void finish('reply_received', 0), 2500);
  });
  await source.start();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('not_ready')), 60000);
    const check = state => { if (!['unknown','login','syncing','approval','limited'].includes(state.kind)) { clearTimeout(timeout); source.off('state', check); resolve(); } };
    source.on('state', check); check(source.state.view());
  });
  started = true;
  const text = `这是桌宠收发功能的无副作用联调测试，标记 ${marker}。请只完成这个小测试，不联网、不安装软件、不读取私密文件、不修改或删除已有文件，也不要改变循环任务。\n1. 回复一段中文确认文字，并给一个不超过5行的 Python 代码块。\n2. 在你可写工作区新建专用目录 muse-desktop-test-${marker}，返回三个真实附件：hello_muse.py（仅包含 print('Hello Muse')，不要执行此文件）；green_dot.png（用已有代码能力生成64×64绿色圆点，不调用付费图像生成服务）；beep.wav（用已有代码能力生成0.3秒轻提示音，作为音频回复测试，不需真人录音或付费语音服务）。不支持的格式请明确说，不能伪造附件。\n最后一条回复请包含“${marker} 测试结束”，并提供附件链接。`;
  receipt = await source.submitTask({ id: randomUUID(), text });
  console.log(JSON.stringify({ step: 'live_test_submission', status: receipt.status, hasMessageId: Boolean(receipt.messageId) }));
  if (receipt.messageId) knownIds.add(receipt.messageId);
  if (receipt.status !== 'accepted') return finish('submission_not_confirmed_no_retry', 1);
  setTimeout(() => void finish('reply_timeout', 1), 180000);
}).catch(() => void finish('test_failed_no_retry', 1));
app.on('window-all-closed', () => {});
