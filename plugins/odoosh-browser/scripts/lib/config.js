'use strict';
const fs = require('fs');
const path = require('path');

// Per-repo files live under .oap/ (shared by all Odoo agent plugins). memory.md is shared; the rest is per plugin.
// Older locations (.claude/odoosh-browser*.json, .claude/odoo-agent*.json) are still read until "config.js migrate".
const OAP_DIR = '.oap';
const PLUGIN_DIR = 'odoosh-browser';
const AGENT_FILES = {
  config: path.join(OAP_DIR, PLUGIN_DIR, 'config.json'),
  run: path.join(OAP_DIR, PLUGIN_DIR, 'run.json'),
  throttle: path.join(OAP_DIR, PLUGIN_DIR, 'throttle.json'),
  memory: path.join(OAP_DIR, 'memory.md'),
};
const LEGACY_FILES = {
  config: ['.claude/odoosh-browser.json', '.claude/odoo-agent.json'],
  run: ['.claude/odoosh-browser-run.json', '.claude/odoo-agent-run.json'],
  throttle: ['.claude/odoosh-browser-throttle.json', '.claude/odoo-agent-throttle.json'],
  notes: ['.claude/odoosh-browser-notes.json', '.claude/odoo-agent-notes.json'],
};
const CONFIG_REL = AGENT_FILES.config;

/**
 * First existing legacy file of a kind in a repo.
 * @param {string} root - repo root
 * @param {string} kind - config | run | throttle | notes
 * @returns {string|null} absolute path, or null
 */
function legacyFile(root, kind) {
  const hit = (LEGACY_FILES[kind] || []).map((rel) => path.join(root, rel)).find((p) => fs.existsSync(p));
  return hit || null;
}

/**
 * Resolve a plugin file in a repo, falling back to a legacy location when only that one exists.
 * @param {string} root - repo root containing .oap/
 * @param {string} kind - config | run | throttle | memory
 * @returns {string} absolute file path
 */
function agentFile(root, kind) {
  const current = path.join(root, AGENT_FILES[kind]);
  if (fs.existsSync(current)) return current;
  return legacyFile(root, kind) || current;
}

const DEFAULTS = {
  odoo_sh_project: null,
  staging_branch: null,
  production_branches: ['main', 'master', 'production'],
  odoo_version: null,
  ssh: { enabled: false, key: null },
  // push_staging: "confirm" asks before every push to the staging branch; "auto" skips that question (staging only).
  autonomy: { push_staging: 'confirm' },
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
  const config = { ...DEFAULTS, ...raw, ssh: { ...DEFAULTS.ssh, ...(raw.ssh || {}) }, autonomy: { ...DEFAULTS.autonomy, ...(raw.autonomy || {}) } };
  const legacy = !configPath.endsWith(AGENT_FILES.config);
  const up = legacy ? 2 : 3;
  let root = configPath;
  for (let i = 0; i < up; i++) root = path.dirname(root);
  return { path: configPath, root, config, legacy };
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
  if (!['confirm', 'auto'].includes(config.autonomy && config.autonomy.push_staging)) {
    problems.push('autonomy.push_staging debe ser "confirm" o "auto".');
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
 * Add .oap/ to .git/info/exclude (local exclusion; the client's .gitignore is not touched).
 * @param {string} root - repo root
 * @returns {{excluded: string[], excludeFile: string|null}} summary
 */
function ensureExcluded(root) {
  const result = { excluded: [], excludeFile: null };
  // Only a plain .git directory is handled; worktrees/submodules get a manual hint from the CLI.
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return result;
  const excludeFile = path.join(gitDir, 'info', 'exclude');
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  result.excludeFile = excludeFile;
  if (lines.includes('.oap/') || lines.includes('.oap')) return result;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(excludeFile, `${existing && !existing.endsWith('\n') ? '\n' : ''}.oap/\n`, 'utf8');
  result.excluded = ['.oap/'];
  return result;
}

/**
 * Move legacy .claude files into .oap/, convert legacy JSON notes to memory.md and exclude .oap/ from git.
 * @param {string} root - repo root
 * @returns {{moved: string[], skipped: string[], notes: number, excluded: string[], excludeFile: string|null}} summary
 */
function migrateLegacy(root) {
  const result = { moved: [], skipped: [], notes: 0 };
  for (const kind of ['config', 'run', 'throttle']) {
    const target = path.join(root, AGENT_FILES[kind]);
    for (const rel of LEGACY_FILES[kind]) {
      const legacy = path.join(root, rel);
      if (!fs.existsSync(legacy)) continue;
      if (fs.existsSync(target)) { result.skipped.push(rel); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      result.moved.push(`${rel} -> ${AGENT_FILES[kind]}`);
    }
  }
  // Lazy require: notes.js depends on this module.
  const { migrateLegacyNotes } = require('./notes');
  result.notes = migrateLegacyNotes(root);
  return { ...result, ...ensureExcluded(root) };
}

module.exports = { migrateLegacy, ensureExcluded, legacyFile, OAP_DIR, AGENT_FILES, LEGACY_FILES, CONFIG_REL, agentFile, DEFAULTS, findConfigPath, loadConfig, validateConfig, saveConfig };
