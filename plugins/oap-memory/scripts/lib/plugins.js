'use strict';
// Memory declarations (memory.json) of the plugins that use oap-memory: extra global categories, where each plugin
// keeps project names that must never reach global knowledge, and where the project's Odoo version is.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Only plugins of this marketplace declare memory: another marketplace's plugin cannot shadow or widen the rules.
const MARKETPLACE = 'odoo-agent-plugins';
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Candidate plugin folders: OAP_MEMORY_PLUGINS (path list), marketplace installs (CLAUDE_CONFIG_DIR or ~/.claude),
 * siblings of oap-memory (repo checkout) and, as a fallback, the marketplace cache next to it (<plugin>/<version>).
 * @param {object} [env] - environment variables
 * @param {string} [home] - user home
 * @returns {string[]} absolute folders
 */
function pluginDirs(env = process.env, home = os.homedir()) {
  if (env.OAP_MEMORY_PLUGINS) return env.OAP_MEMORY_PLUGINS.split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const dirs = [];
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(installed.plugins || {})) {
      if (key.endsWith(`@${MARKETPLACE}`)) for (const e of entries) if (e.installPath) dirs.push(path.resolve(e.installPath));
    }
  } catch {
    // No marketplace install: siblings only.
  }
  const subdirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  dirs.push(...subdirs(path.resolve(__dirname, '..', '..', '..')));
  // Marketplace cache: <cache>/<marketplace>/<plugin>/<version>; newest version first.
  const newest = (a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true });
  for (const plugin of subdirs(path.resolve(__dirname, '..', '..', '..', '..'))) dirs.push(...subdirs(plugin).sort(newest));
  return [...new Set(dirs)];
}

/**
 * Parse and check one memory.json; invalid parts are dropped.
 * @param {object} raw - parsed JSON
 * @returns {object|null} {source, global_categories, project_terms, odoo_version} or null
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !NAME_RE.test(String(raw.source || ''))) return null;
  const rel = (f) => typeof f === 'string' && f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..');
  const spec = (s) => s && rel(s.file);
  return {
    source: raw.source,
    min_memory_version: typeof raw.min_memory_version === 'string' ? raw.min_memory_version : null,
    global_categories: (Array.isArray(raw.global_categories) ? raw.global_categories : []).filter((c) => CATEGORY_RE.test(String(c))),
    project_terms: (Array.isArray(raw.project_terms) ? raw.project_terms : [])
      .filter(spec).map((s) => ({ file: s.file, keys: (Array.isArray(s.keys) ? s.keys : []).filter((k) => typeof k === 'string') })),
    odoo_version: spec(raw.odoo_version) && typeof raw.odoo_version.key === 'string' ? { file: raw.odoo_version.file, key: raw.odoo_version.key } : null,
  };
}

/**
 * Load the declarations of every plugin folder found. All are kept (several versions may be cached): project names
 * are joined, so a declaration can only add names that block promotion, never remove them.
 * @param {object} [env] - environment variables
 * @param {string} [home] - user home
 * @returns {object[]} declarations
 */
function loadDeclarations(env = process.env, home = os.homedir()) {
  const out = [];
  for (const dir of pluginDirs(env, home)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
    } catch {
      continue;
    }
    const d = normalize(raw);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Read a top-level value from a JSON file inside the repo.
 * @param {string} root - repo root
 * @param {string} file - path relative to the root
 * @param {string} key - key
 * @returns {*} value, or undefined
 */
function readKey(root, file, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))[key];
  } catch {
    return undefined;
  }
}

/**
 * Project facts the declarations point to: names that identify the project and its Odoo version.
 * @param {string} root - repo root
 * @param {object[]} decls - declarations
 * @returns {{terms: string[], odoo: string|null}} facts
 */
function projectFacts(root, decls) {
  const terms = new Set();
  let odoo = null;
  for (const d of decls) {
    for (const s of d.project_terms) {
      for (const k of s.keys) {
        const v = readKey(root, s.file, k);
        for (const t of Array.isArray(v) ? v : [v]) if (typeof t === 'string' && t.trim()) terms.add(t.trim());
      }
    }
    if (!odoo && d.odoo_version) {
      const v = readKey(root, d.odoo_version.file, d.odoo_version.key);
      if (typeof v === 'string' && v.trim()) odoo = v.trim();
    }
  }
  return { terms: [...terms], odoo };
}

/**
 * Global categories: the built-in ones plus those the plugins declare.
 * @param {string[]} builtIn - built-in categories
 * @param {object[]} decls - declarations
 * @returns {string[]} categories
 */
function globalCategories(builtIn, decls) {
  return [...new Set([...builtIn, ...decls.flatMap((d) => d.global_categories)])];
}

module.exports = { pluginDirs, normalize, loadDeclarations, projectFacts, globalCategories, readKey };
