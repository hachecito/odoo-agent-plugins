'use strict';
// Repo root for the project memory: the nearest folder with a .oap/ of its own (never the global store in the
// home folder), else the top-level git project (the superproject when called inside a submodule), else the folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Home folder that holds the global store (OAP_HOME overrides it, e.g. in tests).
 * @returns {string} absolute path
 */
function homeDir() {
  return path.resolve(process.env.OAP_HOME || os.homedir());
}

/**
 * Global knowledge folder (<home>/.oap/knowledge).
 * @returns {string} absolute path
 */
function globalDir() {
  return path.join(homeDir(), '.oap', 'knowledge');
}

/**
 * Tell whether a folder has a project .oap/ (the home folder's .oap/ holds global knowledge, not a project).
 * @param {string} dir - candidate repo folder
 * @returns {boolean} true for a project .oap
 */
function isProjectOap(dir) {
  try {
    if (!fs.statSync(path.join(dir, '.oap')).isDirectory()) return false;
  } catch {
    return false;
  }
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(dir) !== norm(homeDir()) && norm(dir) !== norm(os.homedir());
}

/**
 * Run git in a folder and return its trimmed output.
 * @param {string} dir - folder
 * @param {string[]} args - git arguments
 * @returns {string} output, empty on error
 */
function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 });
  return res.status === 0 ? String(res.stdout || '').trim() : '';
}

/**
 * Nearest folder with a project .oap/ (cheap: no git call; used by the hooks, which run in every session).
 * @param {string} [startDir] - folder to start from
 * @returns {string|null} folder, or null
 */
function findOapRoot(startDir) {
  for (let dir = path.resolve(startDir || process.cwd()); ; dir = path.dirname(dir)) {
    if (isProjectOap(dir)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Find the repo root the memory belongs to.
 * @param {string} [startDir] - folder to start from (default: cwd)
 * @returns {{root: string, found: string}} root and how it was found (oap | git | cwd)
 */
function findRoot(startDir) {
  const start = path.resolve(startDir || process.cwd());
  const oap = findOapRoot(start);
  if (oap) return { root: oap, found: 'oap' };
  const top = git(start, ['rev-parse', '--show-superproject-working-tree']) || git(start, ['rev-parse', '--show-toplevel']);
  if (top) return { root: path.resolve(top), found: 'git' };
  return { root: start, found: 'cwd' };
}

/**
 * Add .oap/ to .git/info/exclude (local exclusion; the client's .gitignore is not touched).
 * @param {string} root - repo root
 * @returns {boolean} true if the line was added
 */
function ensureExcluded(root) {
  const gitDir = path.join(root, '.git');
  try {
    if (!fs.statSync(gitDir).isDirectory()) return false;
  } catch {
    return false;
  }
  const file = path.join(gitDir, 'info', 'exclude');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split(/\r?\n/).some((l) => ['.oap/', '.oap'].includes(l.trim()))) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}.oap/\n`, 'utf8');
  return true;
}

module.exports = { findRoot, findOapRoot, homeDir, isProjectOap, globalDir, ensureExcluded };
