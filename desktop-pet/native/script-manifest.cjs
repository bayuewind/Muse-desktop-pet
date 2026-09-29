'use strict';
// Development-only protocol inspection. Never executes the fetched webpage;
// emits only public static-script paths, not the authenticated HTML or tokens.
const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { CredentialVault } = require('./vault.cjs');
const { NativeAuth } = require('./auth.cjs');
app.setName('Muse 桌宠');
const directory = path.join(app.getPath('appData'), 'MuseDesktopPet');
app.setPath('userData', directory);
app.whenReady().then(async () => {
  const auth = new NativeAuth(new CredentialVault(directory, safeStorage));
  const response = await fetch('https://muse.ai/', { redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Cookie: auth.jar.getCookieStringSync('https://muse.ai/'), 'User-Agent': 'MuseDesktopPet/0.3 (protocol inspection)' } });
  if (!response.ok) throw new Error('manifest_unavailable');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > 8*1024*1024) throw new Error('manifest_limit'); chunks.push(chunk); }
  const html = Buffer.concat(chunks).toString();
  const paths = [...new Set([...html.matchAll(/<script[^>]+src="([^\"]+)"/g)].map(match => match[1].split('?')[0])
    .filter(value => /^\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js$/.test(value)))];
  console.log(JSON.stringify({ scripts: paths }));
  if (process.argv.includes('--save-public-scripts')) {
    const output = path.resolve(__dirname, '../.test-output/public-scripts');
    await fs.mkdir(output, { recursive: true });
    let total = 0;
    for (const script of paths.slice(0, 100)) {
      const response = await fetch(new URL(script, 'https://muse.ai'), { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('public_script_unavailable');
      const bytes = Buffer.from(await response.arrayBuffer());
      total += bytes.length;
      if (bytes.length > 8*1024*1024 || total > 48*1024*1024) throw new Error('public_script_limit');
      await fs.writeFile(path.join(output, path.basename(script)), bytes);
    }
    console.log(JSON.stringify({ step: 'public_scripts_saved', count: paths.length, bytes: total }));
  }
  app.exit(0);
}).catch(() => { console.log('MANIFEST_UNAVAILABLE'); app.exit(1); });
app.on('window-all-closed', () => {});
