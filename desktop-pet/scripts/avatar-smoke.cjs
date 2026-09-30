'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function runAvatarSmoke(window) {
  const output = path.resolve(__dirname, '../.test-output/avatar-clip');
  fs.mkdirSync(output, { recursive: true });
  const originalBounds = window.getBounds();
  const originalZoom = window.webContents.getZoomFactor();
  try {
    await window.webContents.executeJavaScript(`(async () => {
      const video = document.querySelector('#avatar');
      video.pause(); video.removeAttribute('src'); video.load();
      document.querySelector('.caption').style.visibility = 'hidden';
      document.querySelector('#menu-dot').style.visibility = 'hidden';
      const still = document.querySelector('#still');
      still.src = './assets/muse.png'; still.hidden = false;
      await still.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 160;
      const context = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        context.fillStyle = 'white'; context.fillRect(0, 0, 160, 160);
        context.fillStyle = frame++ % 2 ? '#e94b35' : '#3c78d8';
        context.fillRect(45, 45, 70, 70);
      };
      draw();
      window.avatarFixture = { canvas, timer: setInterval(draw, 40), stream: canvas.captureStream(25) };
    })()`);
    for (const zoom of [1, 1.25, 1.5]) {
      window.setSize(Math.ceil(256 * zoom), Math.ceil(306 * zoom));
      window.webContents.setZoomFactor(zoom);
      for (const mode of ['still', 'video']) {
        const rect = await window.webContents.executeJavaScript(`(async () => {
          const video = document.querySelector('#avatar');
          if (${JSON.stringify(mode)} === 'video') {
            video.srcObject = window.avatarFixture.stream; await video.play();
            video.classList.add('ready');
          } else { video.pause(); video.srcObject = null; video.classList.remove('ready'); }
          await new Promise(resolve => setTimeout(resolve, 400));
          const rect = document.querySelector('.portrait-media').getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`);
        const image = await window.webContents.capturePage();
        const size = image.getSize(), bitmap = image.toBitmap();
        const viewport = await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
        const sx = size.width / viewport.width, sy = size.height / viewport.height;
        const alpha = (x, y) => bitmap[(Math.floor(y * sy) * size.width + Math.floor(x * sx)) * 4 + 3];
        for (const [x, y] of [[3, 3], [rect.width - 3, 3], [3, rect.height - 3], [rect.width - 3, rect.height - 3]]) {
          assert.ok(alpha(rect.x + x, rect.y + y) < 64, `opaque ${mode} corner at zoom ${zoom}`);
        }
        assert.ok(alpha(rect.x + rect.width / 2, rect.y + rect.height / 2) > 240, 'avatar center must remain visible');
        fs.writeFileSync(path.join(output, `${mode}-${zoom}.png`), image.toPNG());
      }
    }
    console.log('AVATAR_CLIP_PASS: static image + playing video corners transparent at 100%, 125%, 150%; center visible');
  } finally {
    await window.webContents.executeJavaScript(`(() => {
      const fixture = window.avatarFixture;
      if (fixture) { clearInterval(fixture.timer); fixture.stream.getTracks().forEach(track => track.stop()); }
      const video = document.querySelector('#avatar');
      video.pause(); video.srcObject = null; video.classList.remove('ready');
      document.querySelector('.caption').style.visibility = '';
      document.querySelector('#menu-dot').style.visibility = '';
      delete window.avatarFixture;
    })()`);
    window.webContents.setZoomFactor(originalZoom);
    window.setBounds(originalBounds);
  }
  if (process.argv.includes('--avatar-preview')) {
    window.setTitle('Muse 头像裁剪测试');
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#status').textContent = '头像裁剪测试';
      document.querySelector('#detail').textContent = '本机测试画面 · 未连接账号';
      document.querySelector('#unread').hidden = false;
      document.querySelector('#unread').textContent = '2';
    })()`);
    await new Promise(resolve => setTimeout(resolve, 45000));
  }
}
module.exports = { runAvatarSmoke };
