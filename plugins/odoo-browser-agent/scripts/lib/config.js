'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_REL = path.join('.claude', 'odoo-agent.json');
const RUN_STATE_REL = path.join('.claude', 'odoo-agent-run.json');

const DEFAULTS = {
  odoo_sh_project: null,
  staging_branch: null,
  production_branches: ['main', 'master', 'production'],
  odoo_version: null,
  ssh: { enabled: false, key: null },
  allowed_domains: ['odoo.sh', 'odoo.com', 'github.com'],
};

/**
 * Walk up from a directory looking for .claude/odoo-agent.json.
 * @param {string} startDir - directory to start from
 * @returns {string|null} absolute path to the config file, or null
 */
function findConfigPath(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = path.join(dir, CONFIG_REL);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load and normalize the project config.
 * @param {string} startDir - directory to search from
 * @returns {{path: string, root: string, config: object}|null} null if no config exists
 */
function loadConfig(startDir) {
  const configPath = findConfigPath(startDir);
  if (!configPath) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = { ...DEFAULTS, ...raw, ssh: { ...DEFAULTS.ssh, ...(raw.ssh || {}) } };
  return { path: configPath, root: path.dirname(path.dirname(configPath)), config };
}

/**
 * Validate a config object.
 * @param {object} config - normalized config
 * @returns {string[]} list of problems (empty when valid)
 */
function validateConfig(config) {
  const problems = [];
  if (!config.staging_branch) problems.push('staging_branch no definida: preguntar al usuario.');
  if (!Array.isArray(config.production_branches) || !config.production_branches.length) {
    problems.push('production_branches debe ser una lista no vacía.');
  }
  if (config.staging_branch && (config.production_branches || []).includes(config.staging_branch)) {
    problems.push('staging_branch no puede ser una rama de producción.');
  }
  return problems;
}

/**
 * Write a config object to disk (pretty JSON).
 * @param {string} configPath - file path
 * @param {object} config - config to write
 */
function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

module.exports = { CONFIG_REL, RUN_STATE_REL, DEFAULTS, findConfigPath, loadConfig, validateConfig, saveConfig };
