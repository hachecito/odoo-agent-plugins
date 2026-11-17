#!/usr/bin/env node
'use strict';
// Prepare a temporary patch of the local changes to try on an Odoo.sh staging build before a push.
// It never connects to the build: the ssh or editor commands it prints run apart, so the guard sees them.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REMOTE_PATCH = '~/oap-hotpatch.patch';
const USAGE = `Uso: hotpatch.js prepare --base <sha> [--only <ruta> ...] [--dir <repo>]
  Genera .oap/odoosh-browser/hotpatch/ (patch.diff, patch.b64, manifest.json) con los cambios
  locales respecto a <sha>, el commit que corre el build. --only limita el parche a esas rutas
  (por ejemplo solo los tests, para ver el test de regresión en rojo antes del arreglo).
  No se conecta al build: imprime los comandos para SSH y para el terminal del editor.`;

/**
 * Run git in a repo.
 * @param {string} root - repository root
 * @param {string[]} args - git arguments
 * @param {object} [env] - environment (defaults to the current one)
 * @returns {{status: number, stdout: string, stderr: string}} result
 */
function git(root, args, env = process.env) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Write the patch, its base64 copy and the manifest of the changes against the build commit.
 * @param {{root: string, base: string, only?: string[]}} opts - repo root, build commit, optional paths
 * @returns {{base: string, files: Array<{path: string, status: string, hash: string|null}>, bytes: number, dir: string}} manifest
 */
function prepare({ root, base, only = [] }) {
  const rb = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (rb.status !== 0) throw new Error(`No existe el commit ${base} en local: hacer git fetch o revisar el SHA del build.`);
  const sha = rb.stdout.trim();
  // The plugin's own .oap/ folder is never part of a whole-repo patch, even where it is not excluded.
  // (observed with git 2.47 on Windows: it stages nothing when an exclude is combined with a narrower path, so only here.)
  const scope = only.length ? only : ['.', ':(exclude).oap'];
  const dir = path.join(root, '.oap', 'odoosh-browser', 'hotpatch');
  fs.mkdirSync(dir, { recursive: true });
  const patch = path.join(dir, 'patch.diff');
  // Stage everything (new files included) in a throwaway index, so the user's index is never touched.
  const realIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).stdout.trim());
  const tmpIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'oap-hotpatch.index']).stdout.trim());
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  let diff;
  let names;
  try {
    git(root, ['add', '-A', '--', ...scope], env);
    diff = git(root, ['diff', '--cached', '--binary', '--full-index', '--no-renames', `--output=${patch}`, sha, '--', ...scope], env);
    names = git(root, ['diff', '--cached', '--name-status', '--no-renames', sha, '--', ...scope], env);
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
  if (diff.status !== 0) throw new Error(diff.stderr.trim() || 'git diff falló');
  const files = names.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, file] = line.split('\t');
    return { path: file, status: status[0], hash: null };
  });
  if (!files.length) throw new Error(`No hay cambios respecto a ${sha.slice(0, 12)}.`);
  const present = files.filter((f) => f.status !== 'D');
  if (present.length) {
    // hash-object applies the same line-ending filters as git, so CRLF copies on Windows match the build.
    const hashes = git(root, ['hash-object', '--', ...present.map((f) => f.path)]).stdout.split('\n').filter(Boolean);
    present.forEach((f, i) => { f.hash = hashes[i] || null; });
  }
  const raw = fs.readFileSync(patch);
  fs.writeFileSync(path.join(dir, 'patch.b64'), raw.toString('base64').replace(/.{1,76}/g, '$&\n'), 'utf8');
  const manifest = { base: sha, created_at: new Date().toISOString(), only, files, bytes: raw.length, dir };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

/**
 * Human summary with the commands to apply, check and revert the patch on the build.
 * @param {object} m - manifest from prepare()
 * @returns {string} text
 */
function instructions(m) {
  const present = m.files.filter((f) => f.status !== 'D').map((f) => f.path).join(' ');
  const patch = path.join(m.dir, 'patch.diff');
  const lines = [
    `Parche: ${m.files.length} archivo(s), ${m.bytes} bytes, base ${m.base.slice(0, 12)}.`,
    ...m.files.map((f) => `  ${f.status} ${f.path}${f.hash ? '  ' + f.hash.slice(0, 12) : '  (borrado)'}`),
    '',
    'SSH (preferente). Antes, el build debe correr la base y ~/src/user estar limpio:',
    '  ssh <build> "cd ~/src/user && git rev-parse HEAD && git status --porcelain"',
    `  ssh <build> "cat > ${REMOTE_PATCH} && cd ~/src/user && git apply --check ${REMOTE_PATCH} && git apply ${REMOTE_PATCH}" < "${patch}"`,
    present ? `  ssh <build> "cd ~/src/user && git hash-object ${present} | cut -c1-12"` : '',
    '',
    `Editor (terminal web): escribir ${path.join(m.dir, 'patch.b64')} entre las dos líneas:`,
    `  base64 -d > ${REMOTE_PATCH} <<'OAP_EOF'`,
    '  ...',
    '  OAP_EOF',
    `  cd ~/src/user && git apply --check ${REMOTE_PATCH} && git apply ${REMOTE_PATCH}`,
    present ? `  git hash-object ${present} | cut -c1-12` : '',
    '',
    `Revertir (antes del push y al cerrar): cd ~/src/user && git apply -R ${REMOTE_PATCH}`,
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

/**
 * Read the value of a --flag, or all values when repeated.
 * @param {string[]} args - CLI arguments
 * @param {string} name - flag name without dashes
 * @returns {string[]} values
 */
function opts(args, name) {
  const out = [];
  args.forEach((a, i) => { if (a === `--${name}` && args[i + 1]) out.push(args[i + 1]); });
  return out;
}

function main(args) {
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || args.includes('--help') || cmd !== 'prepare') {
    console.log(USAGE);
    if (cmd && cmd !== 'prepare' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
    return;
  }
  const base = opts(args, 'base')[0];
  if (!base) { console.error(USAGE); process.exitCode = 1; return; }
  const start = opts(args, 'dir')[0] || process.cwd();
  const top = git(start, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) { console.error('No es un repositorio git.'); process.exitCode = 1; return; }
  try {
    console.log(instructions(prepare({ root: top.stdout.trim(), base, only: opts(args, 'only') })));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { prepare, instructions };
