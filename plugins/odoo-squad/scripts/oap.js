#!/usr/bin/env node
'use strict';
// Runs a script of the odoosh-browser plugin (run-state.js, notes.js, config.js, report.js) from odoo-squad.
// Usage: node oap.js <script> [args...]   |   node oap.js --where
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// odoo-squad relies on .oap/, autonomy (yolo) and the subagent rules of this odoosh-browser version.
const MIN_VERSION = '0.8.0';

/**
 * Read the version of a plugin folder.
 * @param {string} dir - plugin root
 * @returns {string|null} version from .claude-plugin/plugin.json
 */
function pluginVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
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
 * Locate the scripts folder of odoosh-browser (>= MIN_VERSION): env override, installed plugin, or sibling folder.
 * @param {object} env - environment variables
 * @param {string} home - user home directory
 * @param {string} here - directory of this script
 * @returns {{dir: string|null, old: string|null}} scripts directory, or the version of an outdated install found
 */
function locate(env = process.env, home = os.homedir(), here = __dirname) {
  const candidates = [];
  if (env.OAP_ODOOSH_BROWSER) candidates.push(env.OAP_ODOOSH_BROWSER);
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(installed.plugins || {})) {
      if (key.startsWith('odoosh-browser@')) for (const e of entries) candidates.push(e.installPath);
    }
  } catch {
    // Not installed through the marketplace: fall through to the sibling folder.
  }
  candidates.push(path.resolve(here, '..', '..', 'odoosh-browser'));
  const found = candidates.filter((c) => c && fs.existsSync(path.join(c, 'scripts', 'run-state.js')));
  const hit = found.find((c) => compareVersions(pluginVersion(c) || '0', MIN_VERSION) >= 0);
  return { dir: hit ? path.join(hit, 'scripts') : null, old: !hit && found.length ? (pluginVersion(found[0]) || 'desconocida') : null };
}

/**
 * Locate the scripts folder of odoosh-browser.
 * @param {object} env - environment variables
 * @param {string} home - user home directory
 * @param {string} here - directory of this script
 * @returns {string|null} absolute scripts directory, or null
 */
function findScriptsDir(env, home, here) {
  return locate(env, home, here).dir;
}

/** Entry point. */
function main() {
  const [script, ...args] = process.argv.slice(2);
  const { dir, old } = locate();
  if (!dir) {
    console.error(old
      ? `odoosh-browser ${old} es anterior a la ${MIN_VERSION} que necesita odoo-squad: claude plugin marketplace update odoo-agent-plugins y claude plugin update odoosh-browser@odoo-agent-plugins`
      : 'odoosh-browser no está instalado: claude plugin install odoosh-browser@odoo-agent-plugins');
    process.exit(2);
  }
  if (script === '--where') {
    console.log(dir);
    return;
  }
  if (!/^[a-z-]+\.js$/.test(script || '') || !fs.existsSync(path.join(dir, script))) {
    console.error('Uso: oap.js <run-state|notes|config|report|ssh-check>.js [args...]');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [path.join(dir, script), ...args], { stdio: 'inherit' });
  process.exit(res.status === null ? 1 : res.status);
}

if (require.main === module) main();

module.exports = { findScriptsDir, locate, compareVersions, MIN_VERSION };
