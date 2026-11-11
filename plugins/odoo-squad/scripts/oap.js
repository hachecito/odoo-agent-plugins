#!/usr/bin/env node
'use strict';
// Runs a script of the odoosh-browser plugin (run-state.js, notes.js, config.js, report.js) from odoo-squad.
// Usage: node oap.js <script> [args...]   |   node oap.js --where
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Locate the scripts folder of odoosh-browser: env override, installed plugin, or sibling folder (monorepo checkout).
 * @param {object} env - environment variables
 * @param {string} home - user home directory
 * @param {string} here - directory of this script
 * @returns {string|null} absolute scripts directory, or null
 */
function findScriptsDir(env = process.env, home = os.homedir(), here = __dirname) {
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
  const hit = candidates.find((c) => c && fs.existsSync(path.join(c, 'scripts', 'run-state.js')));
  return hit ? path.join(hit, 'scripts') : null;
}

/** Entry point. */
function main() {
  const [script, ...args] = process.argv.slice(2);
  const dir = findScriptsDir();
  if (!dir) {
    console.error('odoosh-browser no está instalado: claude plugin install odoosh-browser@odoo-agent-plugins');
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

module.exports = { findScriptsDir };
