#!/usr/bin/env node
'use strict';
// Prepare a read-only diagnostic script for odoo-bin shell on an Odoo.sh staging build.
// It never connects to the build: it prints one-line commands (script inline in base64) for SSH and
// for the editor terminal, so the guard can decode and check the script before it runs.
const fs = require('fs');
const path = require('path');

const REMOTE_OUT = 'oap-diag.txt';
const MAX_SCRIPT_BYTES = 6000;
const USAGE = `Usage: diag.js prepare <script.py> [--dir <repo>]
  Checks a read-only diagnostic script for odoo-bin shell (no commit, no write SQL), wraps it
  with env.cr.rollback() and saves .oap/odoosh-browser/diag/script.b64.
  It never connects to the build: it prints the command for SSH and for the editor terminal,
  and the URL to read the output through the editor API.`;

/**
 * Reject scripts that would persist changes or run destructive SQL.
 * @param {string} code - python source
 * @returns {string|null} reason to reject, null when acceptable
 */
function checkScript(code) {
  if (/\bcommit\s*\(|auto_commit\s*=\s*True/.test(code)) return 'the script commits; diagnostics are read-only.';
  if (/\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b|\bALTER\s+TABLE\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b/i.test(code)) {
    return 'the script contains write SQL.';
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) return `the script is over ${MAX_SCRIPT_BYTES} bytes; split it.`;
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
  if (reason) throw new Error(`Script rejected: ${reason}`);
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
    console.log(`Saved: ${path.relative(root, r.out).replace(/\\/g, '/')}`);
    console.log('\nVia SSH (Bash tool; single quotes so $PGDATABASE expands on the build):');
    console.log(r.ssh);
    console.log('\nVia the editor terminal (type it as one line):');
    console.log(r.editor);
    console.log(`Read the output as text: ${r.read}`);
    console.log(`When done: ${r.cleanup}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { prepare, checkScript };

if (require.main === module) main(process.argv.slice(2));
