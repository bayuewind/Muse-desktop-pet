(() => {
  'use strict';
  const list = document.querySelector('#input-files'), strip = document.querySelector('#input-strip');
  const attach = document.querySelector('#attach'), previews = new Map();
  let files = [], busy = false, disabled = false, epoch = 0, dragDepth = 0;
  const note = (text, level = '') => document.dispatchEvent(new CustomEvent('composer:input-note', { detail: { text, level } }));
  const reasons = { attachment_capacity: '最多 4 个附件，总大小不超过 8 MB。',
    attachment_size_limit: '附件不能为空，且总大小不能超过 8 MB。',
    attachment_type_unsupported: '暂不支持此文件类型。支持常用图片、文档、代码、音频和 MP4。',
    attachment_image_invalid: '图片格式与文件名不一致，未加入消息。',
    file_changed: '文件读取期间发生变化，请重新选择。',
    invalid_filename: '文件名无效，请重命名后再选择。',
    file_unavailable: '文件暂时无法读取。' };
  function releasePreviews() {
    epoch++;
    for (const url of previews.values()) URL.revokeObjectURL(url);
    previews.clear();
    const dialog = document.querySelector('#input-preview-dialog');
    if (dialog.open) dialog.close();
    document.querySelector('#input-preview-image').removeAttribute('src');
  }
  function busyState(value) {
    busy = value; render();
    document.dispatchEvent(new CustomEvent('composer:input-busy', { detail: value }));
  }
  async function preview(id) {
    if (previews.has(id)) return previews.get(id);
    const at = epoch, result = await window.composer.inputPreview(id);
    if (at !== epoch || !files.some(file => file.id === id) || !result?.bytes) return null;
    const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
    if (previews.has(id)) URL.revokeObjectURL(previews.get(id));
    previews.set(id, url); return url;
  }
  function accept(value) {
    if (!Array.isArray(value)) return;
    const before = JSON.stringify(files.map(file => file.id));
    files = value;
    for (const [id, url] of previews) if (!files.some(file => file.id === id)) { URL.revokeObjectURL(url); previews.delete(id); }
    render();
    if (before !== JSON.stringify(files.map(file => file.id))) document.dispatchEvent(new CustomEvent('composer:attachments-changed'));
  }
  function render() {
    strip.hidden = !files.length;
    attach.disabled = disabled || busy;
    document.querySelector('#input-summary').textContent = `本地附件 · ${files.length}/4 · ${(files.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)}/8 MB`;
    list.replaceChildren();
    for (const file of files) {
      const chip = document.createElement('div'); chip.className = 'input-file';
      const icon = document.createElement('i'); icon.dataset.lucide = file.kind === 'image' ? 'image' : 'file';
      const name = document.createElement('button'); name.className = 'input-file-name';
      name.textContent = file.name; name.title = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
      name.disabled = file.kind !== 'image' || busy;
      name.onclick = async () => {
        try {
          const url = await preview(file.id); if (!url) return;
          document.querySelector('#input-preview-image').src = url;
          document.querySelector('#input-preview-title').textContent = file.name;
          document.querySelector('#input-preview-dialog').showModal();
        } catch { note('图片预览失败。', 'error'); }
      };
      const remove = document.createElement('button'); remove.className = 'icon-button';
      remove.title = `移除 ${file.name}`; remove.setAttribute('aria-label', remove.title);
      remove.innerHTML = '<i data-lucide="x"></i>'; remove.disabled = disabled || busy;
      remove.onclick = async () => {
        busyState(true);
        try { const result = await window.composer.inputRemove(file.id); if (result?.ok) accept(result.files); }
        finally { busyState(false); }
      };
      chip.append(icon, name, remove); list.append(chip);
    }
    window.lucide?.createIcons();
  }
  async function stageFiles(selected) {
    if (disabled || busy || !selected.length) return false;
    if (selected.length + files.length > 4 || selected.some(file => file.size < 1 || file.size > 8388608) ||
        [...selected, ...files].reduce((sum, file) => sum + file.size, 0) > 8388608) {
      note(reasons.attachment_capacity, 'error'); return false;
    }
    busyState(true);
    try {
      for (const file of selected) {
        const bytes = await file.arrayBuffer();
        let result;
        try { result = await window.composer.inputStage({ name: file.name, bytes }); }
        finally { new Uint8Array(bytes).fill(0); }
        if (!result?.ok) { note(reasons[result?.reason] || '附件未加入消息。', 'error'); return false; }
        accept(result.files); note('附件已加入本地草稿，尚未发送。');
      }
      return true;
    } catch { note('附件读取失败。', 'error'); return false; }
    finally { busyState(false); }
  }
  attach.onclick = async () => {
    if (disabled || busy) return;
    busyState(true);
    try {
      const result = await window.composer.inputSelect();
      if (result?.files) accept(result.files);
      if (result?.ok) note('附件已加入本地草稿，尚未发送。');
      else if (result?.reason !== 'cancelled') note(reasons[result?.reason] || '附件选择未完成。', 'error');
    } catch { note('附件选择未完成。', 'error'); }
    finally { busyState(false); }
  };
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) document.addEventListener(type, event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (type === 'dragenter') dragDepth++;
    if (type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
    if (type === 'drop') {
      dragDepth = 0;
      if (!disabled && !busy) { document.querySelector('#tab-chat').click(); void stageFiles([...event.dataTransfer.files]); }
    }
    document.body.dataset.fileDrag = String(dragDepth > 0 && !disabled && !busy);
  });
  document.addEventListener('paste', event => {
    if (document.body.dataset.view !== 'chat' || !event.clipboardData?.files.length) return;
    event.preventDefault(); void stageFiles([...event.clipboardData.files]);
  });
  document.querySelector('#input-preview-close').onclick = () => document.querySelector('#input-preview-dialog').close();
  document.querySelector('#input-preview-dialog').addEventListener('close', () => document.querySelector('#input-preview-image').removeAttribute('src'));
  window.addEventListener('blur', () => { dragDepth = 0; document.body.dataset.fileDrag = 'false'; });
  window.addEventListener('beforeunload', releasePreviews);
  window.composer.onHidden(releasePreviews);
  window.draftFiles = Object.freeze({
    ids: () => files.map(file => file.id),
    sync: async () => { const at = epoch, value = await window.composer.inputList(); if (at === epoch) accept(value); },
    setDisabled(value) { if (disabled !== value) { disabled = value; render(); } },
    stageFiles,
  });
  document.addEventListener('composer:session-change', () => { releasePreviews(); accept([]); void window.draftFiles.sync(); });
  void window.draftFiles.sync();
})();
