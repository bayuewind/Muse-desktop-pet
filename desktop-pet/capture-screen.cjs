'use strict';
async function captureScreen({ desktopCapturer, screen, composer, pet, current, canRestore = current, restore, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const display = screen.getDisplayMatching(composer.getBounds());
  const wasPetVisible = pet && !pet.isDestroyed() && pet.isVisible();
  let timeout;
  try {
    composer.hide(); if (wasPetVisible) pet.hide();
    await wait(180);
    if (!current()) throw new Error('capture_cancelled');
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 4096, height: 4096 }, fetchWindowIcons: false }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('capture_timeout')), 15000); }),
    ]);
    if (!current()) throw new Error('capture_cancelled');
    const source = sources.find(item => item.display_id === String(display.id)) ??
      (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty()) throw new Error('capture_unavailable');
    let image = source.thumbnail, bytes = image.toPNG();
    if (bytes.length > 8 * 1024 * 1024) {
      const size = image.getSize(), ratio = Math.min(2048 / size.width, 2048 / size.height, 1);
      bytes.fill(0);
      image = image.resize({ width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) });
      bytes = image.toPNG();
    }
    if (bytes.length > 8 * 1024 * 1024) { bytes.fill(0); throw new Error('capture_size_limit'); }
    return { ok: true, bytes, ...image.getSize() };
  } finally {
    clearTimeout(timeout);
    if (canRestore()) restore(wasPetVisible);
  }
}
module.exports = { captureScreen };
