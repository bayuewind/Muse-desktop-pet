(() => {
  'use strict';
  const dialog = document.querySelector('#capture-dialog'), canvas = document.querySelector('#capture-canvas');
  const context = canvas.getContext('2d'), fields = ['x','y','width','height'];
  const inputs = Object.fromEntries(fields.map(key => [key, document.querySelector(`#crop-${key}`)]));
  const button = document.querySelector('#capture'), add = document.querySelector('#capture-add');
  let image = null, imageUrl = null, selection = null, anchor = null, operation = 0, adding = false;
  const note = (text, level = '') => document.dispatchEvent(new CustomEvent('composer:input-note', { detail: { text, level } }));
  function draw() {
    if (!image || !selection) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const { x, y, width, height } = selection;
    context.fillStyle = 'rgba(16,24,32,.5)';
    context.fillRect(0, 0, canvas.width, y); context.fillRect(0, y + height, canvas.width, canvas.height - y - height);
    context.fillRect(0, y, x, height); context.fillRect(x + width, y, canvas.width - x - width, height);
    context.strokeStyle = '#34bda1'; context.lineWidth = Math.max(2, canvas.width / 500);
    context.strokeRect(x, y, width, height);
    for (const key of fields) inputs[key].value = selection[key];
    document.querySelector('#capture-size').textContent = `${width} × ${height} px`;
  }
  function reset() {
    if (!image) return;
    selection = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }; draw();
  }
  function release() {
    operation++; anchor = null; selection = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null; if (image) image.src = ''; image = null;
    canvas.width = 1; canvas.height = 1; adding = false; add.disabled = false;
  }
  button.onclick = async () => {
    if (button.disabled) return;
    const op = ++operation;
    button.disabled = true;
    document.dispatchEvent(new CustomEvent('composer:input-busy', { detail: true }));
    note('正在截取当前显示器…');
    try {
      const result = await window.composer.capture();
      if (op !== operation) return;
      if (!result?.ok) { note('截图未完成，请检查屏幕录制权限后重试。', 'error'); return; }
      imageUrl = URL.createObjectURL(new Blob([result.bytes], { type: 'image/png' }));
      image = new Image(); image.src = imageUrl; await image.decode();
      if (op !== operation) return;
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      inputs.x.max = canvas.width - 1; inputs.y.max = canvas.height - 1;
      inputs.width.max = canvas.width; inputs.height.max = canvas.height;
      reset(); dialog.showModal(); note('截图仅在本地预览。');
    } catch { release(); note('截图预览失败。', 'error'); }
    finally {
      document.dispatchEvent(new CustomEvent('composer:input-busy', { detail: false }));
      button.disabled = false;
    }
  };
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) / rect.width * canvas.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) / rect.height * canvas.height)) };
  }
  canvas.onpointerdown = event => {
    if (event.button !== 0 || !image || adding) return;
    anchor = point(event); canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (!anchor || !image || adding) return;
    selection = window.museCrop.fromPoints(anchor, point(event), canvas.width, canvas.height); draw();
  };
  canvas.onpointerup = event => {
    if (!anchor) return;
    selection = window.museCrop.fromPoints(anchor, point(event), canvas.width, canvas.height);
    anchor = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (selection.width < 3 || selection.height < 3) reset(); else draw();
  };
  canvas.onpointercancel = () => { anchor = null; };
  for (const key of fields) inputs[key].onchange = () => {
    if (!image) return;
    selection = window.museCrop.cropBounds(Object.fromEntries(fields.map(field => [field, inputs[field].value])), canvas.width, canvas.height);
    draw();
  };
  document.querySelector('#capture-reset').onclick = reset;
  document.querySelector('#capture-cancel').onclick = () => dialog.close();
  dialog.addEventListener('close', release);
  add.onclick = async () => {
    if (!image || !selection || adding) return;
    adding = true; add.disabled = true; const op = operation;
    const output = document.createElement('canvas');
    output.width = selection.width; output.height = selection.height;
    output.getContext('2d').drawImage(image, selection.x, selection.y, selection.width, selection.height, 0, 0, output.width, output.height);
    try {
      const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
      if (!blob || op !== operation) return;
      const name = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      const staged = await window.draftFiles.stageFiles([new File([blob], name, { type: 'image/png' })]);
      if (op === operation && staged) dialog.close();
    } catch { note('截图未能加入消息。', 'error'); }
    finally { output.width = 1; output.height = 1; adding = false; add.disabled = false; }
  };
  window.composer.onHidden(() => { if (dialog.open) dialog.close(); });
  window.addEventListener('beforeunload', release);
})();
