'use strict';
// Experimental browser-free CLI. No credential files are discovered/read, and
// no browser is launched. A future explicitly approved pairing flow supplies
// a short-lived credential envelope via stdin; stdout contains status only.
const { NativeGateway, pinnedStandardVerifier } = require('./gateway-client.cjs');
const { NativeActivityModel } = require('./activity-model.cjs');
async function main() {
  if (!process.argv.includes('--credentials-stdin')) {
    console.log(JSON.stringify({ state: 'authorization_required', browserRequiredForRuntime: false,
      detail: 'Native protocol implemented; real-account pairing and subscription coverage not verified.' }));
    process.exitCode = 2; return;
  }
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk.toString(); if (Buffer.byteLength(buffer) > 32768) throw new Error('invalid_credentials');
  }
  const credentials = JSON.parse(buffer); buffer = '';
  const verify = pinnedStandardVerifier(credentials.peerPolicy);
  const model = new NativeActivityModel(); let stopping = false, active, retry = 1000;
  const stop = () => { stopping = true; active?.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  while (!stopping) {
    const client = new NativeGateway(); active = client;
    let heartbeat, display;
    const closed = new Promise(resolve => client.once('closed', resolve));
    client.on('status-event', (type, payload, meta) => { if (type === 'agent.status') model.event(payload, meta); });
    try {
      await client.connect(credentials, verify);
      await client.request('connection.ping'); model.heartbeat();
      await Promise.all(['chat.subscribe', 'activity.subscribe', 'tasks.subscribe'].map(method => client.request(method)));
      // No raw task-run schema has been verified yet; never assert global idle.
      retry = 1000;
      heartbeat = setInterval(() => {
        void client.request('connection.ping').then(() => model.heartbeat()).catch(() => client.close('heartbeat_failed'));
      }, 15000);
      display = setInterval(() => console.log(JSON.stringify(model.snapshot())), 3000);
      const reason = await closed;
      if (reason === 'authorization_required') { console.log(JSON.stringify({ state: reason })); break; }
    } catch (error) {
      const terminal = ['authorization_required', 'server_identity_mismatch', 'attestation_verifier_required'].includes(error.message);
      console.log(JSON.stringify({ state: terminal ? error.message : 'connection_failed' }));
      if (terminal) break;
    } finally {
      clearInterval(heartbeat); clearInterval(display); client.close(); model.disconnect();
    }
    if (!stopping) { await new Promise(resolve => setTimeout(resolve, retry)); retry = Math.min(30000, retry * 2); }
  }
}
if (require.main === module) main().catch(() => { console.log(JSON.stringify({ state: 'authorization_or_protocol_configuration_required' })); process.exitCode = 1; });
