#!/usr/bin/env node
'use strict';
// Prepare a read-only diagnostic script for odoo-bin shell on an Odoo.sh staging build.
// It never connects to the build: it prints one-line commands (script inline in base64) for SSH and
// for the editor terminal, so the guard can decode and check the script before it runs.
const fs = require('fs');
const path = require('path');

const REMOTE_OUT = 'oap-diag.txt';
const MAX_SCRIPT_BYTES = 6000;
const USAGE = `Uso: diag.js prepare <script.py> [--dir <repo>]
  Revisa un script de diagnóstico de solo lectura para odoo-bin shell (sin commit ni SQL de
  escritura), le añade env.cr.rollback() y guarda .oap/odoosh-browser/diag/script.b64.
  No se conecta al build: imprime el comando para SSH y para el terminal del editor, y la URL
  para leer la salida por la API del editor.`;

/**
 * Reject scripts that would persist changes or run destructive SQL.
 * @param {string} code - python source
 * @returns {string|null} reason to reject, null when acceptable
 */
function checkScript(code) {
  if (/\bcommit\s*\(|auto_commit\s*=\s*True/.test(code)) return 'el script hace commit; el diagnóstico es solo lectura.';
  if (/\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b|\bALTER\s+TABLE\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b/i.test(code)) {
    return 'el script lleva SQL de escritura.';
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) return `el script pasa de ${MAX_SCRIPT_BYTES} bytes; dividirlo.`;
  return null;
}

/**
 * Build the base64 payload and the remote commands for a diagnostic script.
 * @param {{root: string, file: string}} opts - repo root and local script path
 * @returns {{b64: string, ssh: string, editor: string, read: string, cleanup: string, out: string}} commands
 */
function prepare({ root, file }) {
  const code = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const reason = checkScript(code);
  if (reason) throw new Error(`Script rechazado: ${reason}`);
  // Script errors go to stdout (stderr is full of module warnings). The shell already rolls back at
  // the end (odoo/cli/shell.py, 15.0-19.0); the finally keeps it explicit.
  const wrapped = [
    'import sys, traceback',
    'try:',
    `    exec(compile(${JSON.stringify(code)}, 'oap-diag', 'exec'), globals())`,
    'except Exception:',
    '    traceback.print_exc(file=sys.stdout)',
    'finally:',
    '    env.cr.rollback()',
    '',
  ].join('\n');
  const b64 = Buffer.from(wrapped, 'utf8').toString('base64');
  const dir = path.join(root, '.oap', 'odoosh-browser', 'diag');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'script.b64');
  fs.writeFileSync(out, `${b64}\n`);
  const run = `echo ${b64} | base64 -d | odoo-bin shell -d "$PGDATABASE" --no-http --log-level=error`;
  return {
    b64,
    out,
    ssh: `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <build> '${run} >/tmp/oap-diag.out 2>/tmp/oap-diag.err; echo EXIT=$?; head -c 20000 /tmp/oap-diag.out; tail -n 3 /tmp/oap-diag.err; rm /tmp/oap-diag.out /tmp/oap-diag.err'`,
    editor: `${run} 2>/tmp/oap-diag.err | head -c 20000 > ~/${REMOTE_OUT}; echo EXIT=\${PIPESTATUS[2]}; tail -n 3 /tmp/oap-diag.err; rm /tmp/oap-diag.err`,
    read: `https://<build>/odoo-sh/editor/api/contents/${REMOTE_OUT}?content=1&format=text&type=file`,
    cleanup: `rm ~/${REMOTE_OUT}`,
  };
}

/**
 * CLI entry point.
 * @param {string[]} args - command line arguments
 */
function main(args) {
  if (args[0] !== 'prepare' || !args[1] || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
  }
  const di = args.indexOf('--dir');
  const root = path.resolve(di >= 0 ? args[di + 1] : process.cwd());
  try {
    const r = prepare({ root, file: path.resolve(args[1]) });
    console.log(`Guardado: ${path.relative(root, r.out).replace(/\\/g, '/')}`);
    console.log('\nPor SSH (herramienta Bash, comillas simples para que $PGDATABASE se expanda en el build):');
    console.log(r.ssh);
    console.log('\nPor el terminal del editor (escribirlo en una sola línea):');
    console.log(r.editor);
    console.log(`Leer la salida como texto: ${r.read}`);
    console.log(`Al terminar: ${r.cleanup}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { prepare, checkScript };

if (require.main === module) main(process.argv.slice(2));
