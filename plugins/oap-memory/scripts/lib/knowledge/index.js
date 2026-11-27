'use strict';
// Derived index of a store: _index/catalog.jsonl (one line per entry: properties, summary and weighted term
// frequencies) and _index/manifest.json (mtime and size of every source). Markdown stays the source of truth:
// deleting _index/ loses nothing, the next search rebuilds it.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readFileStable, withLock } = require('../fsatomic');
const { SCHEMA_VERSION } = require('./schema');
const { listSources, readEntryFile, storeLock } = require('./store');
const { validateEntry } = require('./validate');

// Bump when the catalog row format or the tokenizer changes: a different version forces a full rebuild.
const INDEX_VERSION = 1;
const FIELD_WEIGHTS = { title: 3, tags: 3, summary: 2, body: 1 };
const STOPWORDS = new Set((
  'a al algo como con de del el en es esta este esto la las lo los no o para pero por que se si sin su sus un una uno y ya '
  + 'an and are as at be but by for from has have if in into is it its not of on or so than that the then there these this '
  + 'to was were when which while with you your'
).split(' '));

/**
 * Split text into search terms: lowercase, no accents; dotted or underscored names are kept whole and also split.
 * @param {string} text - text
 * @returns {string[]} terms (with repetitions)
 */
function tokenize(text) {
  const norm = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out = [];
  for (const raw of norm.match(/[a-z0-9_.]+/g) || []) {
    const tok = raw.replace(/^[._]+|[._]+$/g, '');
    if (!tok) continue;
    const parts = tok.split(/[._]+/).filter(Boolean);
    if (parts.length > 1) out.push(tok);
    for (const p of parts) if (p.length > 1 && !STOPWORDS.has(p)) out.push(p);
  }
  return out;
}

/**
 * Weighted term frequencies of an entry (title and tags count 3, summary 2, body 1).
 * @param {object} data - frontmatter
 * @param {string} body - Markdown body
 * @returns {{tf: object, len: number}} term -> weight, and total weight
 */
function termFrequencies(data, body) {
  const tf = {};
  let len = 0;
  const add = (text, w) => {
    for (const t of tokenize(text)) {
      tf[t] = (tf[t] || 0) + w;
      len += w;
    }
  };
  add(data.title, FIELD_WEIGHTS.title);
  add((data.tags || []).join(' '), FIELD_WEIGHTS.tags);
  add(data.summary, FIELD_WEIGHTS.summary);
  add(body, FIELD_WEIGHTS.body);
  return { tf, len };
}

/**
 * Build the catalog row of one source file.
 * @param {object} src - {file, rel}
 * @returns {{row?: object, error?: string}} row, or why the file was skipped
 */
function rowFor(src) {
  let entry;
  try {
    entry = readEntryFile(src.file);
  } catch (err) {
    return { error: err.message };
  }
  if (!entry) return { error: 'file disappeared' };
  const { data, body } = entry;
  const problems = validateEntry(data, body);
  if (problems.length) return { error: problems.join(' ') };
  const { tf, len } = termFrequencies(data, body);
  const row = {
    id: data.id, scope: data.scope, type: data.type, category: data.category, tags: data.tags || [],
    odoo_versions: data.odoo_versions || [], status: data.status, title: data.title, summary: data.summary,
    updated: data.updated, superseded_by: data.superseded_by || null, promoted_to: data.promoted_to || null,
    path: src.rel, len, tf,
  };
  if (data.outcome) row.outcome = data.outcome;
  return { row };
}

// How long the fast path (folder times only) is trusted before every file's mtime and size is checked again.
const RECHECK_MS = 10 * 60 * 1000;

/**
 * Modification times of the folders that hold a store's sources (entries/<category>/ and tasks/<id>/).
 * @param {object} store - store descriptor
 * @returns {object} relative folder -> mtime in ms
 */
function folderTimes(store) {
  const out = {};
  const stamp = (abs, rel) => {
    try { out[rel] = Math.floor(fs.statSync(abs).mtimeMs); } catch { /* absent */ }
  };
  const entries = path.join(store.dir, 'entries');
  stamp(entries, 'entries');
  if (out.entries !== undefined) {
    for (const c of fs.readdirSync(entries, { withFileTypes: true })) if (c.isDirectory()) stamp(path.join(entries, c.name), `entries/${c.name}`);
  }
  if (store.tasksDir) {
    stamp(store.tasksDir, 'tasks');
    if (out.tasks !== undefined) {
      for (const t of fs.readdirSync(store.tasksDir, { withFileTypes: true })) if (t.isDirectory()) stamp(path.join(store.tasksDir, t.name), `tasks/${t.name}`);
    }
  }
  return out;
}

/**
 * Tell whether two flat objects hold the same keys and values.
 * @param {object} a - first
 * @param {object} b - second
 * @returns {boolean} true if equal
 */
function sameMap(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Paths of the index files of a store.
 * @param {object} store - store descriptor
 * @returns {{catalog: string, manifest: string}} absolute paths
 */
function indexFiles(store) {
  const dir = path.join(store.dir, '_index');
  return { catalog: path.join(dir, 'catalog.jsonl'), manifest: path.join(dir, 'manifest.json') };
}

/**
 * Read the stored index, or null if missing, from another version or unreadable.
 * @param {object} store - store descriptor
 * @returns {{manifest: object, rows: object[]}|null} index
 */
function readIndex(store) {
  const f = indexFiles(store);
  try {
    const manifest = readFileStable(f.manifest, JSON.parse);
    if (!manifest || manifest.index_version !== INDEX_VERSION || manifest.schema_version !== SCHEMA_VERSION) return null;
    const text = readFileStable(f.catalog);
    if (text === null) return null;
    // One JSON.parse over the whole file is about twice as fast as one per line.
    const body = text.trimEnd();
    const rows = body ? JSON.parse(`[${body.split('\n').join(',')}]`) : [];
    if (rows.length !== manifest.count) return null;
    return { manifest, rows };
  } catch {
    return null; // corrupt index: rebuilt from the Markdown
  }
}

/**
 * Bring a store's index up to date with its Markdown files and return it. Only changed files are parsed again.
 * @param {object} store - store descriptor
 * @param {{full?: boolean, locked?: boolean}} [opts] - full=true re-parses every file; locked=true when the caller
 *   already holds the store lock (a writer reindexing after its change)
 * @returns {{rows: object[], invalid: Array<{path: string, error: string}>, changed: number}} index
 */
function loadIndex(store, opts = {}) {
  if (!fs.existsSync(store.dir) && !(store.tasksDir && fs.existsSync(store.tasksDir))) return { rows: [], invalid: [], changed: 0 };
  const current = opts.full ? null : readIndex(store);
  const dirs = folderTimes(store);
  // Fast path: no folder changed (every write here renames a file into its folder) and the last per-file check is
  // recent. In-place edits by an external editor are caught by the per-file check every RECHECK_MS, or by reindex.
  if (current && !opts.locked && sameMap(current.manifest.dirs, dirs) && Date.now() - Date.parse(current.manifest.checked_at || 0) < RECHECK_MS) {
    return { rows: current.rows, invalid: current.manifest.invalid || [], changed: 0 };
  }
  const sources = listSources(store);
  const stats = new Map(sources.map((s) => {
    const st = fs.statSync(s.file);
    return [s.rel, { src: s, mtimeMs: Math.floor(st.mtimeMs), size: st.size }];
  }));
  const f = indexFiles(store);
  const writeManifest = (count, files, invalid) => writeFileAtomic(f.manifest, `${JSON.stringify({
    index_version: INDEX_VERSION, schema_version: SCHEMA_VERSION, built_at: new Date().toISOString(),
    checked_at: new Date().toISOString(), count, files, dirs: folderTimes(store), invalid,
  })}\n`);
  if (current) {
    const files = current.manifest.files || {};
    const same = Object.keys(files).length === stats.size
      && [...stats].every(([rel, s]) => files[rel] && files[rel].mtimeMs === s.mtimeMs && files[rel].size === s.size);
    if (same) {
      const refresh = () => writeManifest(current.rows.length, files, current.manifest.invalid || []);
      if (opts.locked) refresh(); else withLock(storeLock(store), refresh);
      return { rows: current.rows, invalid: current.manifest.invalid || [], changed: 0 };
    }
  }
  const rebuild = () => {
    const prev = new Map(((current && current.rows) || []).map((r) => [r.path, r]));
    const prevFiles = (current && current.manifest.files) || {};
    const rows = [];
    const invalid = [];
    const files = {};
    let changed = 0;
    for (const [rel, s] of stats) {
      const old = prevFiles[rel];
      let row = old && old.mtimeMs === s.mtimeMs && old.size === s.size ? prev.get(rel) : null;
      if (!row) {
        changed++;
        const res = rowFor(s.src);
        if (res.error) invalid.push({ path: rel, error: res.error });
        row = res.row;
      }
      if (row) rows.push(row);
      files[rel] = { mtimeMs: s.mtimeMs, size: s.size };
    }
    changed += Object.keys(prevFiles).filter((rel) => !stats.has(rel)).length;
    // Keep invalid files that did not change reported until they are fixed.
    for (const inv of (current && current.manifest.invalid) || []) {
      if (stats.has(inv.path) && !invalid.some((x) => x.path === inv.path) && !rows.some((r) => r.path === inv.path)) invalid.push(inv);
    }
    writeFileAtomic(f.catalog, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    writeManifest(rows.length, files, invalid);
    return { rows, invalid, changed };
  };
  return opts.locked ? rebuild() : withLock(storeLock(store), rebuild);
}

module.exports = { tokenize, termFrequencies, loadIndex, readIndex, indexFiles, INDEX_VERSION };
