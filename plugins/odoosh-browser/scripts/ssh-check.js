#!/usr/bin/env node
'use strict';
// Diagnose SSH access to an Odoo.sh build: key present, IP allowed, key registered.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Classify ssh stderr/exit into a diagnosis.
 * @param {number|null} status - ssh exit code
 * @param {string} stdout - ssh stdout
 * @param {string} stderr - ssh stderr
 * @returns {{ok: boolean, code: string, hint: string}} diagnosis
 */
function classify(status, stdout, stderr) {
  if (status === 0 && stdout.includes('odoosh-browser-ok')) {
    return { ok: true, code: 'OK', hint: 'SSH access works.' };
  }
  if (/Permission denied \(publickey/i.test(stderr)) {
    return { ok: false, code: 'PUBLICKEY', hint: 'The key is not in the Odoo.sh profile (Profile → import from GitHub or "Add a key manually") or the user is not a project collaborator.' };
  }
  if (/exec request failed on channel/i.test(stderr)) {
    return { ok: false, code: 'EXEC_INTERMITTENT', hint: 'Authentication worked but the build refused the command (intermittent Odoo.sh failure). Retry once; if it persists, use the web editor terminal.' };
  }
  if (/timed out|Connection refused|No route to host|Connection closed/i.test(stderr)) {
    return { ok: false, code: 'NETWORK', hint: 'IP not allowed in Odoo.sh or not applied yet; wait a few minutes and retry, or use the web editor terminal.' };
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return { ok: false, code: 'HOST', hint: 'Wrong host: copy the SSH command from the branch page in Odoo.sh.' };
  }
  if (/Host key verification failed/i.test(stderr)) {
    return { ok: false, code: 'HOSTKEY', hint: 'Host key changed or unknown; check ~/.ssh/known_hosts.' };
  }
  return { ok: false, code: 'UNKNOWN', hint: 'Unrecognised error; check the ssh output.' };
}

/** Entry point: ssh-check.js <build_id>@<build_domain> [--key path]. */
function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => a.includes('@'));
  const keyIdx = args.indexOf('--key');
  const key = keyIdx >= 0 ? args[keyIdx + 1] : path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (!target) {
    console.error('Usage: ssh-check.js <build_id>@<build_domain> [--key private_key_path]');
    process.exit(2);
  }
  if (!/\.dev\.odoo\.com$/i.test(target)) {
    console.error('Only development/staging builds (*.dev.odoo.com) are checked.');
    process.exit(2);
  }
  if (!fs.existsSync(key) || !fs.existsSync(`${key}.pub`)) {
    console.log(JSON.stringify({ ok: false, code: 'NOKEY', hint: `${key}(.pub) does not exist. Generate it with: ssh-keygen -t ed25519` }, null, 2));
    process.exit(1);
  }
  const res = spawnSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'IdentitiesOnly=yes', '-i', key, target, 'echo odoosh-browser-ok',
  ], { encoding: 'utf8', timeout: 30000 });
  const diag = classify(res.status, res.stdout || '', res.stderr || (res.error ? String(res.error.message) : ''));
  console.log(JSON.stringify({ target, key, ...diag }, null, 2));
  process.exit(diag.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { classify };
