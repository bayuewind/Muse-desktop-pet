'use strict';
const draft = document.querySelector('#draft'), send = document.querySelector('#send'), voice = document.querySelector('#voice');
const feedback = document.querySelector('#feedback'), recordingStrip = document.querySelector('#recording');
const shortcutLabel = navigator.userAgent.includes('Windows') ? 'Ctrl' : '⌘';
document.querySelector('#shortcut').textContent = `${shortcutLabel}⇧M 快速呼出`;
document.querySelector('#account').addEventListener('click', () => window.composer.accountMenu());
let connected = false, sending = false, transcribing = false, requestingMic = false, recording = null, attaching = false;
let revision = 0, operation = 0, currentDraftId = crypto.randomUUID();
const uncertainDrafts = new Set();
function draftKey() { return JSON.stringify([draft.value, window.draftFiles?.ids() ?? []]); }
async function deadline(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('audio_setup_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
function note(text, level = '') { feedback.textContent = text; feedback.dataset.level = level; }
function update() {
  document.querySelector('#count').textContent = `${draft.value.length} / 8000`;
  send.disabled = !connected || sending || transcribing || requestingMic || !!recording || attaching ||
    (!draft.value.trim() && !window.draftFiles?.ids().length) || uncertainDrafts.has(draftKey());
  send.innerHTML = sending ? '<i data-lucide="loader-circle"></i><span>发送中</span>' : '<i data-lucide="arrow-up"></i><span>发送</span>';
  send.title = `发送 (${shortcutLabel}+Enter)`;
  voice.disabled = sending || transcribing || requestingMic || attaching || (!connected && !recording);
  document.querySelector('#capture').disabled = sending || transcribing || requestingMic || attaching || !!recording;
  window.draftFiles?.setDisabled(sending || transcribing || requestingMic || !!recording);
  const voiceLabel = recording ? '停止并转写' : transcribing ? '转写中' : requestingMic ? '等待麦克风' : '语音输入';
  voice.innerHTML = `<i data-lucide="${recording ? 'square' : transcribing || requestingMic ? 'loader-circle' : 'mic'}"></i>`;
  voice.title = voiceLabel; voice.setAttribute('aria-label', voiceLabel);
  window.lucide?.createIcons();
  document.body.dataset.recording = String(!!recording);
  recordingStrip.hidden = !recording && !transcribing && !requestingMic;
  if (!recording) document.querySelector('#recording-label').textContent = transcribing ? '正在转写' : requestingMic ? '等待麦克风' : '';
}
function render(state) {
  connected = state?.mode === 'native' && !state.requiresApproval && !state.limited &&
    !['unknown','login','syncing','approval','limited'].includes(state.kind);
  document.body.dataset.connected = String(connected);
  document.querySelector('#connection').textContent = state?.label || '等待原生连接';
  if (state?.shortcutAvailable === false) document.querySelector('#shortcut').textContent = '快捷键被占用，可从菜单栏打开';
  update();
}
draft.addEventListener('input', () => { revision++; currentDraftId = crypto.randomUUID(); update(); });
document.addEventListener('composer:attachments-changed', () => { revision++; currentDraftId = crypto.randomUUID(); update(); });
document.addEventListener('composer:input-busy', event => { attaching = event.detail; update(); });
document.addEventListener('composer:input-note', event => note(event.detail.text, event.detail.level));
window.museDraft = Object.freeze({
  appendContext(text) {
    if (sending || transcribing || requestingMic || recording || attaching) return { ok: false, reason: 'busy' };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'invalid' };
    const next = draft.value + (draft.value ? '\n\n' : '') + text;
    if (next.length > 8000) return { ok: false, reason: 'length' };
    draft.value = next; draft.dispatchEvent(new Event('input', { bubbles: true }));
    note('已加入草稿，尚未发送。', 'success');
    return { ok: true };
  },
});
async function submit() {
  if (send.disabled) return;
  const text = draft.value, id = currentDraftId, atRevision = revision, key = draftKey();
  const attachmentIds = window.draftFiles?.ids() ?? [];
  sending = true; note('正在发送到 Muse 主会话…'); update();
  try {
    const result = await window.composer.send({ id, text, attachmentIds });
    if (result?.status === 'accepted') {
      if (revision === atRevision) { draft.value = ''; currentDraftId = crypto.randomUUID(); revision++; }
      await window.draftFiles?.sync();
      note('Muse 已确认收到任务。可查看桌宠的工作状态。', 'success');
    } else if (result?.status === 'uncertain') {
      uncertainDrafts.add(key);
      note('送达状态不确定，请先到 Muse 检查；不会自动重发，草稿已保留。', 'error');
    } else note(result?.reason === 'cancelled' ? '已取消发送，草稿和附件已保留。' : result?.status === 'rejected' ? 'Muse 拒绝了请求，草稿已保留，请检查账号或审批状态。' : '本次没有发送，请检查连接和输入后再试。', 'error');
  } catch { uncertainDrafts.add(key); note('未能确认送达，请先到 Muse 检查，勿重复提交。', 'error'); }
  finally { sending = false; update(); }
}
function clearSamples(capture) { for (const samples of capture.chunks) samples.fill(0); capture.chunks.length = 0; }
async function stopRecording(transcribe) {
  const capture = recording; if (!capture) return;
  recording = null; clearInterval(capture.timer); capture.stream.getTracks().forEach(track => track.stop());
  const op = operation;
  if (transcribe) { transcribing = true; note('录音已停止，正在交给 Muse 转成文字…'); }
  update();
  try {
    await new Promise(resolve => { capture.flushed = resolve; capture.node.port.postMessage('flush'); setTimeout(resolve, 180); });
    capture.node.disconnect(); capture.source.disconnect(); await capture.context.close();
    capture.node.port.onmessage = null; capture.node.port.close();
    if (!transcribe || op !== operation) { clearSamples(capture); return; }
    const total = capture.chunks.reduce((sum, chunk) => sum+chunk.length, 0);
    const samples = new Float32Array(Math.min(total, capture.context.sampleRate*60));
    let offset = 0;
    for (const chunk of capture.chunks) { const take = Math.min(chunk.length, samples.length-offset); if (take > 0) samples.set(chunk.subarray(0, take), offset); offset += take; }
    clearSamples(capture);
    let result;
    try { result = await window.composer.transcribe({ id: crypto.randomUUID(), permissionId: capture.permissionId, samples: samples.buffer, sampleRate: capture.context.sampleRate }); }
    finally { samples.fill(0); }
    if (op !== operation) return;
    if (result?.status === 'transcribed' && typeof result.text === 'string' && result.text.trim()) {
      const text = result.text.trim();
      if (draft.value.length + text.length + 1 > 8000) { note('转写后将超出 8000 字限制，请缩短原草稿后再录。', 'error'); return; }
      draft.value += (draft.value && !/\s$/.test(draft.value) ? '\n' : '') + text;
      revision++; currentDraftId = crypto.randomUUID();
      note('已转成文字。请检查、编辑后点击“发送任务”。', 'success'); draft.focus();
    } else note(result?.status === 'transcribed' ? '没有识别到语音，请再试一次。' : 'Muse 转写暂不可用，请重连后再试；没有发送任何任务。', 'error');
  } catch { if (op === operation) note('录音或转写失败，没有发送任务。', 'error'); }
  finally { clearSamples(capture); if (op === operation) transcribing = false; update(); }
}
async function beginRecording() {
  if (!connected || sending || transcribing || recording || requestingMic) return;
  const op = ++operation; requestingMic = true; note('首次使用会请求麦克风权限。录音仅用于 Muse 转写。'); update();
  let stream, context, capture;
  try {
    const permission = await window.composer.microphone();
    if (op !== operation) return;
    if (!permission?.allowed) { note('麦克风未授权。请在系统设置 → 隐私与安全性 → 麦克风中允许 Electron。', 'error'); return; }
    if (op !== operation || !document.hasFocus()) { note('已获得权限，请回到输入框再点录音。'); return; }
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (op !== operation || !document.hasFocus()) { stream.getTracks().forEach(track => track.stop()); return; }
    context = new AudioContext();
    await deadline(context.audioWorklet.addModule('./pcm-worklet.js'), 5000);
    const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'muse-pcm-capture', { channelCount: 1 });
    capture = { stream, context, source, node, chunks: [], permissionId: permission.id, started: Date.now(), timer: null, flushed: null };
    node.port.onmessage = event => {
      if (event.data.samples && (recording === capture || capture.flushed)) capture.chunks.push(event.data.samples);
      if (event.data.flushed) capture.flushed?.();
      if (event.data.limit && recording === capture) void stopRecording(true);
    };
    if (op !== operation || !document.hasFocus()) { stream.getTracks().forEach(track => track.stop()); await context.close(); return; }
    recording = capture;
    document.querySelector('#recording-label').textContent = '正在录音 0s / 60s';
    source.connect(node); node.connect(context.destination); await deadline(context.resume(), 5000);
    if (op !== operation || recording !== capture) return;
    capture.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now()-capture.started)/1000);
      document.querySelector('#recording-label').textContent = `正在录音 ${elapsed}s / 60s`;
      if (elapsed >= 60) void stopRecording(true);
    }, 250);
    note('点击“停止并转写”结束。最长 60 秒；切换窗口会取消录音。');
  } catch {
    if (capture) { clearInterval(capture.timer); capture.node.port.onmessage = null; capture.node.port.close(); clearSamples(capture); }
    stream?.getTracks().forEach(track => track.stop()); if (context && context.state !== 'closed') await context.close();
    if (op === operation) { recording = null; note('无法开启麦克风，请检查系统授权或设备。', 'error'); }
  } finally { if (op === operation) requestingMic = false; update(); }
}
function cancelAudio(notify = true) {
  operation++; requestingMic = false; transcribing = false;
  void stopRecording(false); update();
  if (notify) window.composer.cancelVoice();
}
voice.addEventListener('click', () => { if (recording) void stopRecording(true); else void beginRecording(); });
document.querySelector('#cancel-recording').addEventListener('click', () => {
  const wasTranscribing = transcribing;
  cancelAudio();
  note(wasTranscribing ? '转写已取消，不会采用返回结果；已上传的音频无法撤回。' : '录音已取消，没有上传或发送任务。');
});
send.addEventListener('click', () => void submit());
document.querySelector('#close').addEventListener('click', () => { cancelAudio(); window.composer.hide(); });
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); cancelAudio(); window.composer.hide(); }
  if (document.querySelector('dialog[open]')) return;
  if (document.body.dataset.view === 'chat' && event.key === 'Enter' &&
      (navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey)) { event.preventDefault(); void submit(); }
});
window.addEventListener('blur', () => { if (recording) { cancelAudio(); note('切换窗口已取消录音，没有上传。'); } });
window.addEventListener('beforeunload', cancelAudio);
window.composer.onHidden(() => cancelAudio(false));
window.composer.onFocus(() => { if (document.body.dataset.view === 'chat') draft.focus(); });
document.addEventListener('composer:view-change', event => {
  if (event.detail !== 'chat') cancelAudio();
  else draft.focus();
});
window.composer.onState(render);
void window.composer.state().then(render);
draft.focus(); update();
