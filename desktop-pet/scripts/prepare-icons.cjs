'use strict';
// Format/size conversion only: reuse the exact avatar already used by pet.html.
// No cropping, retouching, background replacement or generated artwork.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const directory = path.resolve(__dirname, '../assets');
  const original = nativeImage.createFromPath(path.join(directory, 'muse-avatar.jpg'));
  if (original.isEmpty()) throw new Error('avatar_asset_missing');
  fs.writeFileSync(path.join(directory, 'muse.png'), original.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const frames = sizes.map(size => original.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  fs.writeFileSync(path.join(directory, 'muse.ico'), Buffer.concat([header, ...frames]));
  console.log('ICON_ASSETS_READY: original avatar, PNG + 9 ICO resolutions');
  app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
