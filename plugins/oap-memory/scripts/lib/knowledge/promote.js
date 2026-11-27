'use strict';
// Automatic promotion of verified, reusable project knowledge to the global store. No question to the user: the
// final task report lists what was promoted and how to remove it.
const fs = require('fs');
const path = require('path');
const { tokenize, loadIndex } = require('./index');
const { globalProblems } = require('./validate');
const { today, newId, storeLock, writeEntry, findEntryFile, readEntryFile, withLock } = require('./store');

const SIMILAR = 0.6;
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'static', 'i18n', 'tests', 'migrations']);
// Evidence that can travel to other projects as is: public Odoo/OCA code references and URLs.
const PUBLIC_EVIDENCE = /^(odoo\/(odoo|enterprise)@|OCA\/|https?:\/\/)/;

/**
 * Jaccard similarity of the title + summary terms of two entries.
 * @param {object} a - entry data or catalog row
 * @param {object} b - entry data or catalog row
 * @returns {number} 0..1
 */
function similarity(a, b) {
  const sa = new Set(tokenize(`${a.title} ${a.summary}`));
  const sb = new Set(tokenize(`${b.title} ${b.summary}`));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Most similar row to an entry, if above the duplicate threshold.
 * @param {object[]} rows - catalog rows
 * @param {object} data - entry data
 * @param {string} [skipId] - id to ignore (the entry itself)
 * @returns {object|null} row
 */
function findSimilar(rows, data, skipId) {
  let best = null;
  let bestScore = SIMILAR;
  for (const r of rows) {
    if (r.id === skipId || r.status === 'deprecated' || r.scope === 'task') continue;
    const s = similarity(r, data);
    if (s >= bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

// Names too common to identify a project (a branch called "staging" must not block every Odoo.sh lesson).
const GENERIC_TERMS = new Set(['staging', 'stage', 'dev', 'develop', 'development', 'main', 'master', 'production', 'prod',
  'test', 'tests', 'odoo', 'addons', 'custom', 'custom-addons', 'src', 'repo', 'modules']);

/**
 * Folders that are git submodules (listed in .gitmodules); vendored OCA or third-party repos are not the client's own.
 * @param {string} root - repo root
 * @returns {Set<string>} absolute submodule paths
 */
function submodulePaths(root) {
  const out = new Set();
  try {
    const text = fs.readFileSync(path.join(root, '.gitmodules'), 'utf8');
    for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) out.add(path.resolve(root, m[1]));
  } catch {
    // No submodules.
  }
  return out;
}

/**
 * Words that identify this project and must not reach global knowledge: own module names (folders with a
 * __manifest__.py, up to 3 levels, outside git submodules), the repo folder name and the names the plugins declare
 * (e.g. Odoo.sh project and staging branch). Generic words are left out.
 * @param {string} root - repo root
 * @param {string[]} [declared] - project names read through the plugins' memory.json
 * @returns {string[]} terms
 */
function projectTerms(root, declared = []) {
  const terms = new Set([path.basename(root), ...declared].filter(Boolean));
  const submodules = submodulePaths(root);
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // A nested repo (submodule checkout, with its own .git file or folder) holds vendored modules, not own ones.
    if (depth > 0 && (submodules.has(path.resolve(dir)) || items.some((i) => i.name === '.git'))) return;
    if (items.some((i) => i.isFile() && i.name === '__manifest__.py')) {
      terms.add(path.basename(dir));
      return;
    }
    if (depth >= 3) return;
    for (const i of items) {
      if (i.isDirectory() && !i.name.startsWith('.') && !SKIP_DIRS.has(i.name)) walk(path.join(dir, i.name), depth + 1);
    }
  };
  walk(root, 0);
  return [...terms].filter((t) => !GENERIC_TERMS.has(String(t).toLowerCase()));
}

/**
 * Promote a verified project entry to global knowledge when it passes the global rules. A similar global entry
 * gets the confirmation added instead of a duplicate. The caller records promoted_to on the project entry.
 * @param {object} globalStore - global store descriptor
 * @param {object} data - project entry data
 * @param {string} body - project entry body
 * @param {{projectTerms: string[]}} ctx - project-specific words
 * @returns {{promoted?: string, merged?: string, skipped?: string[]}} outcome
 */
function promote(globalStore, data, body, ctx) {
  const problems = globalProblems(data, body, ctx);
  if (problems.length) return { skipped: problems };
  return withLock(storeLock(globalStore), () => {
    const { rows } = loadIndex(globalStore, { locked: true });
    const date = today();
    const similar = findSimilar(rows, data);
    if (similar) {
      const file = findEntryFile(globalStore, similar.id);
      const existing = file && readEntryFile(file);
      if (existing) {
        const note = `confirmed in another project (${date})`;
        const evidence = [...new Set([...(existing.data.evidence || []), note])];
        writeEntry(globalStore, { ...existing.data, evidence, updated: date }, existing.body);
        loadIndex(globalStore, { locked: true });
        return { merged: similar.id };
      }
    }
    const id = newId(globalStore);
    const pub = publicVersion(data, body, [`verified in a project task (${date})`]);
    const { no_promote: _local, ...shared } = data;
    writeEntry(globalStore, {
      ...shared, id, scope: 'global', evidence: pub.evidence, superseded_by: null, promoted_to: null, created: date, updated: date,
    }, pub.body);
    loadIndex(globalStore, { locked: true });
    return { promoted: id };
  });
}

/**
 * Global version of a project entry: only public evidence, and the body's Evidence section (which names the
 * project's tasks) rewritten from it.
 * @param {object} data - project entry data
 * @param {string} body - project entry body
 * @param {string[]} extra - evidence to keep or add (e.g. what the global copy already had)
 * @returns {{evidence: string[], body: string}} public evidence and body
 */
function publicVersion(data, body, extra) {
  const evidence = [...new Set([...(data.evidence || []).filter((e) => PUBLIC_EVIDENCE.test(String(e))), ...extra])];
  const text = `${body.replace(/(^|\n)## Evidence\n[\s\S]*?(?=\n## |\s*$)/, '').trimEnd()}\n\n## Evidence\n${evidence.map((e) => `- ${e}`).join('\n')}\n`;
  return { evidence, body: text };
}

/**
 * Carry an update of a promoted project entry to its global copy, if the new text still passes the global rules.
 * @param {object} globalStore - global store descriptor
 * @param {string} gid - global entry id (promoted_to)
 * @param {object} data - updated project entry data
 * @param {string} body - updated project entry body
 * @param {{projectTerms: string[]}} ctx - project-specific words
 * @returns {{updated?: string, skipped?: string[], missing?: boolean}} outcome
 */
function updateGlobalCopy(globalStore, gid, data, body, ctx) {
  const problems = globalProblems(data, body, ctx);
  if (problems.length) return { skipped: problems };
  return withLock(storeLock(globalStore), () => {
    const file = findEntryFile(globalStore, gid);
    const existing = file && readEntryFile(file);
    if (!existing) return { missing: true };
    const pub = publicVersion(data, body, existing.data.evidence || []);
    writeEntry(globalStore, {
      ...existing.data, title: data.title, summary: data.summary, type: data.type, category: data.category, tags: data.tags,
      odoo_versions: data.odoo_versions, evidence: pub.evidence, updated: today(),
    }, pub.body);
    loadIndex(globalStore, { locked: true });
    return { updated: gid };
  });
}

module.exports = { similarity, findSimilar, projectTerms, promote, updateGlobalCopy, SIMILAR };
