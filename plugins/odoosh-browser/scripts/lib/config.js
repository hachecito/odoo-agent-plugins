'use strict';
const fs = require('fs');
const path = require('path');

// Per-repo files of the plugin. Legacy names (plugin <= 0.3) are still read until "config.js migrate".
const AGENT_FILES = {
  config: 'odoosh-browser.json',
  run: 'odoosh-browser-run.json',
  notes: 'odoosh-browser-notes.json',
  throttle: 'odoosh-browser-throttle.json',
};
const LEGACY_FILES = {
  config: 'odoo-agent.json',
  run: 'odoo-agent-run.json',
  notes: 'odoo-agent-notes.json',
  throttle: 'odoo-agent-throttle.json',
};
const CONFIG_REL = path.join('.claude', AGENT_FILES.config);

/**
 * Resolve a plugin file in a repo, falling back to its legacy name when only that one exists.
 * @param {string} root - repo root containing .claude/
 * @param {string} kind - config | run | notes | throttle
 * @returns {string} absolute file path
 */
function agentFile(root, kind) {
  const current = path.join(root, '.claude', AGENT_FILES[kind]);
  const legacy = path.join(root, '.claude', LEGACY_FILES[kind]);
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

const DEFAULTS = {
  odoo_sh_project: null,
  staging_branch: null,
  production_branches: ['main', 'master', 'production'],
  odoo_version: null,
  ssh: { enabled: false, key: null },
  allowed_domains: ['odoo.sh', 'odoo.com', 'github.com'],
  // Odoo.sh build waiting: minimum seconds between browser checks and maximum wait.
  build_poll_seconds: 60,
  build_timeout_minutes: 60,
};

/**
 * Walk up from a directory looking for the plugin config (current or legacy name).
 * @param {string} startDir - directory to start from
 * @returns {string|null} absolute path to the config file, or null
 */
function findConfigPath(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = agentFile(dir, 'config');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load and normalize the project config.
 * @param {string} startDir - directory to search from
 * @returns {{path: string, root: string, config: object, legacy: boolean}|null} null if no config exists
 */
function loadConfig(startDir) {
  const configPath = findConfigPath(startDir);
  if (!configPath) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = { ...DEFAULTS, ...raw, ssh: { ...DEFAULTS.ssh, ...(raw.ssh || {}) } };
  const legacy = path.basename(configPath) === LEGACY_FILES.config;
  return { path: configPath, root: path.dirname(path.dirname(configPath)), config, legacy };
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

/**
 * Rename legacy plugin files to the current names and add the new names to .git/info/exclude.
 * @param {string} root - repo root
 * @returns {{renamed: string[], skipped: string[], excluded: string[], excludeFile: string|null}} summary
 */
function migrateLegacy(root) {
  const result = { renamed: [], skipped: [], excluded: [], excludeFile: null };
  for (const kind of Object.keys(AGENT_FILES)) {
    const legacy = path.join(root, '.claude', LEGACY_FILES[kind]);
    const current = path.join(root, '.claude', AGENT_FILES[kind]);
    if (!fs.existsSync(legacy)) continue;
    if (fs.existsSync(current)) { result.skipped.push(LEGACY_FILES[kind]); continue; }
    fs.renameSync(legacy, current);
    result.renamed.push(`${LEGACY_FILES[kind]} -> ${AGENT_FILES[kind]}`);
  }
  // Only a plain .git directory is handled; worktrees/submodules get a manual hint from the CLI.
  const gitDir = path.join(root, '.git');
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    const missing = Object.values(AGENT_FILES).map((f) => `.claude/${f}`).filter((l) => !lines.includes(l));
    if (missing.length) {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludeFile, `${sep}${missing.join('\n')}\n`, 'utf8');
    }
    result.excluded = missing;
    result.excludeFile = excludeFile;
  }
  return result;
}

module.exports = { migrateLegacy, AGENT_FILES, LEGACY_FILES, CONFIG_REL, agentFile, DEFAULTS, findConfigPath, loadConfig, validateConfig, saveConfig };
