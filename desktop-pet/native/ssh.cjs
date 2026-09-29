'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const project = path.resolve(__dirname, '../..');
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function startSSH(command, { env = process.env } = {}) {
  const sshConfig = env.MUSE_SSH_CONFIG || path.join(project, 'ssh_config');
  const proxy = `${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'relay-proxy.cjs'))}`;
  return spawn('/usr/bin/ssh', ['-T', '-F', sshConfig,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '-o', `ProxyCommand=${proxy}`, 'muse', command], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function runSSH(command, { input = '', timeoutMs = 25000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = startSSH(command, { env }); let output = '', errors = '', failure = null;
    const timer = setTimeout(() => { failure = new Error('ssh_timeout'); child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) { failure = new Error('ssh_output_limit'); child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => { if (errors.length < 8000) errors += chunk.toString(); });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure); else resolve({ code, stdout: output, stderr: errors });
    });
    child.stdin.end(input);
  });
}
module.exports = { runSSH, startSSH };
