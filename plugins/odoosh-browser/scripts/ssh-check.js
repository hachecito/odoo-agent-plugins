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
    return { ok: true, code: 'OK', hint: 'Acceso SSH correcto.' };
  }
  if (/Permission denied \(publickey/i.test(stderr)) {
    return { ok: false, code: 'PUBLICKEY', hint: 'La clave no está en el perfil de Odoo.sh (Profile → importar desde GitHub o "Add a key manually") o el usuario no es colaborador del proyecto.' };
  }
  if (/exec request failed on channel/i.test(stderr)) {
    return { ok: false, code: 'EXEC_INTERMITTENT', hint: 'Autenticación correcta pero el build rechazó el comando (fallo intermitente de Odoo.sh). Reintentar; si persiste, usar el terminal del editor web.' };
  }
  if (/timed out|Connection refused|No route to host|Connection closed/i.test(stderr)) {
    return { ok: false, code: 'NETWORK', hint: 'IP no autorizada en Odoo.sh o aún no aplicada; esperar unos minutos y reintentar.' };
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return { ok: false, code: 'HOST', hint: 'Host incorrecto: copiar el comando SSH de la rama en Odoo.sh (el build id cambia con cada build).' };
  }
  if (/Host key verification failed/i.test(stderr)) {
    return { ok: false, code: 'HOSTKEY', hint: 'Clave de host cambiada o desconocida; revisar ~/.ssh/known_hosts.' };
  }
  return { ok: false, code: 'UNKNOWN', hint: 'Error no reconocido; revisar la salida de ssh.' };
}

/** Entry point: ssh-check.js <build_id>@<build_domain> [--key path]. */
function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => a.includes('@'));
  const keyIdx = args.indexOf('--key');
  const key = keyIdx >= 0 ? args[keyIdx + 1] : path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (!target) {
    console.error('Uso: ssh-check.js <build_id>@<build_domain> [--key ruta_clave_privada]');
    process.exit(2);
  }
  if (!/\.dev\.odoo\.com$/i.test(target)) {
    console.error('Solo se comprueban builds de desarrollo/staging (*.dev.odoo.com).');
    process.exit(2);
  }
  if (!fs.existsSync(key) || !fs.existsSync(`${key}.pub`)) {
    console.log(JSON.stringify({ ok: false, code: 'NOKEY', hint: `No existe ${key}(.pub). Generar con: ssh-keygen -t ed25519` }, null, 2));
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
