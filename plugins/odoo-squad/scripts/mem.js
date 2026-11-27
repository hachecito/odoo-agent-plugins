#!/usr/bin/env node
'use strict';
// Memory launcher of an Odoo Agent Plugin: runs knowledge.js (or notes.js with "mem.js notes ...") of oap-memory.
// Identical copy in every plugin that uses the memory (a repo test checks it); the minimum version is read from
// the plugin's memory.json. Usage: node mem.js <knowledge command> [args...] | notes <command> ... | --where
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Read a JSON file.
 * @param {string} file - path
 * @returns {object|null} parsed content, or null
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compare two x.y.z versions.
 * @param {string} a - version
 * @param {string} b - version
 * @returns {number} negative, zero or positive
 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/**
 * Locate the scripts folder of oap-memory: OAP_MEMORY env, marketplace install (installed_plugins.json of
 * CLAUDE_CONFIG_DIR or ~/.claude), sibling folder (repo checkout) or the plugin cache next to this plugin.
 * @param {string} min - minimum version
 * @param {object} [env] - environment variables
 * @param {string} [home] - user home
 * @param {string} [here] - directory of this script
 * @returns {{dir: string|null, old: string|null}} scripts folder, or the version of an outdated install found
 */
function locate(min, env = process.env, home = os.homedir(), here = __dirname) {
  const candidates = [];
  if (env.OAP_MEMORY) candidates.push(env.OAP_MEMORY);
  const installed = readJson(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json'));
  for (const [key, entries] of Object.entries((installed && installed.plugins) || {})) {
    if (key.startsWith('oap-memory@')) for (const e of entries) candidates.push(e.installPath);
  }
  candidates.push(path.resolve(here, '..', '..', 'oap-memory'));
  // Marketplace cache: <cache>/<marketplace>/<plugin>/<version>/scripts, oap-memory beside this plugin's folder.
  const version = (c) => (readJson(path.join(c, '.claude-plugin', 'plugin.json')) || {}).version || '0';
  const cached = path.resolve(here, '..', '..', '..', 'oap-memory');
  try {
    const dirs = fs.readdirSync(cached).map((v) => path.join(cached, v));
    candidates.push(...dirs.sort((a, b) => compareVersions(version(b), version(a))));
  } catch {
    // Not a cache layout.
  }
  const found = candidates.filter((c) => c && fs.existsSync(path.join(c, 'scripts', 'knowledge.js')));
  const hit = found.find((c) => compareVersions(version(c), min) >= 0);
  return { dir: hit ? path.join(hit, 'scripts') : null, old: !hit && found.length ? version(found[0]) : null };
}

/** Entry point. */
function main() {
  const args = process.argv.slice(2);
  const decl = readJson(path.join(__dirname, '..', 'memory.json')) || {};
  const min = decl.min_memory_version || '1.0.0';
  const { dir, old } = locate(min);
  if (!dir) {
    // Memory never blocks a task: say how to fix it and let the caller go on without memory.
    console.error(old
      ? `oap-memory ${old} is older than ${min}: claude plugin marketplace update odoo-agent-plugins, then claude plugin update oap-memory@odoo-agent-plugins. Continue without memory.`
      : 'oap-memory is not installed: claude plugin install oap-memory@odoo-agent-plugins. Continue without memory.');
    process.exit(3);
  }
  if (args[0] === '--where') {
    console.log(dir);
    return;
  }
  const script = args[0] === 'notes' ? 'notes.js' : 'knowledge.js';
  const rest = args[0] === 'notes' ? args.slice(1) : args;
  const res = spawnSync(process.execPath, [path.join(dir, script), ...rest], { stdio: 'inherit' });
  process.exit(res.status === null ? 1 : res.status);
}

if (require.main === module) main();

module.exports = { locate, compareVersions };
