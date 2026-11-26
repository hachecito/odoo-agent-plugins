'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, readFileStable, withLock } = require('../fsatomic');
const { SCHEMA_VERSION, ID_RE, parseEntry, serializeEntry } = require('./schema');
const { validateEntry } = require('./validate');

const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Project store: <repo>/.oap/memory (entries) plus task summaries in .oap/odoo-squad/tasks/<id>/summary.md.
 * @param {string} root - repo root
 * @returns {{kind: string, prefix: string, dir: string, tasksDir: string}} store descriptor
 */
function projectStore(root) {
  return { kind: 'project', prefix: 'p', dir: path.join(root, '.oap', 'memory'), tasksDir: path.join(root, '.oap', 'odoo-squad', 'tasks') };
}

/**
 * Global store shared by every project: ~/.oap/knowledge (OAP_HOME overrides the home folder, e.g. in tests).
 * @param {object} [env] - environment variables
 * @returns {{kind: string, prefix: string, dir: string, tasksDir: null}} store descriptor
 */
function globalStore(env = process.env) {
  return { kind: 'global', prefix: 'g', dir: path.join(env.OAP_HOME || os.homedir(), '.oap', 'knowledge'), tasksDir: null };
}

/**
 * Today's date as YYYY-MM-DD.
 * @param {Date} [d] - date
 * @returns {string} ISO date
 */
function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Generate a new entry id that does not exist yet in the store.
 * @param {object} store - store descriptor
 * @param {Date} [date] - creation date
 * @returns {string} id like p-20261126-7f3a
 */
function newId(store, date = new Date()) {
  for (;;) {
    const id = `${store.prefix}-${today(date).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
    if (!findEntryFile(store, id)) return id;
  }
}

/**
 * Resolve a path inside a base folder, refusing traversal and symbolic links.
 * @param {string} base - folder the path must stay in
 * @param {...string} parts - path parts
 * @returns {string} absolute path
 */
function safeJoin(base, ...parts) {
  const abs = path.resolve(base, ...parts);
  const rel = path.relative(path.resolve(base), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path outside the store: ${parts.join('/')}`);
  let cur = path.resolve(base);
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(`Symbolic links are not followed: ${cur}`);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
  }
  return abs;
}

/**
 * Path of an entry file from its category and id.
 * @param {object} store - store descriptor
 * @param {string} category - entry category
 * @param {string} id - entry id
 * @returns {string} absolute path
 */
function entryPath(store, category, id) {
  if (!ID_RE.test(id)) throw new Error(`Invalid id: ${id}`);
  if (!CATEGORY_RE.test(category)) throw new Error(`Invalid category: ${category}`);
  return safeJoin(store.dir, 'entries', category, `${id}.md`);
}

/**
 * List every Markdown source of a store: entries/<category>/*.md and, for a project, tasks/<id>/summary.md.
 * @param {object} store - store descriptor
 * @returns {Array<{file: string, rel: string}>} files with their store-relative path
 */
function listSources(store) {
  const out = [];
  const entries = path.join(store.dir, 'entries');
  if (fs.existsSync(entries)) {
    for (const cat of fs.readdirSync(entries, { withFileTypes: true })) {
      if (!cat.isDirectory() || !CATEGORY_RE.test(cat.name)) continue;
      for (const f of fs.readdirSync(path.join(entries, cat.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.md')) out.push({ file: path.join(entries, cat.name, f.name), rel: `entries/${cat.name}/${f.name}` });
      }
    }
  }
  if (store.tasksDir && fs.existsSync(store.tasksDir)) {
    for (const t of fs.readdirSync(store.tasksDir, { withFileTypes: true })) {
      const f = path.join(store.tasksDir, t.name, 'summary.md');
      if (t.isDirectory() && fs.existsSync(f)) out.push({ file: f, rel: `tasks/${t.name}/summary.md` });
    }
  }
  return out;
}

/**
 * Absolute path of a store-relative source path (as kept in the index).
 * @param {object} store - store descriptor
 * @param {string} rel - relative path (entries/... or tasks/...)
 * @returns {string} absolute path
 */
function sourcePath(store, rel) {
  if (rel.startsWith('tasks/')) {
    if (!store.tasksDir) throw new Error(`No tasks in the ${store.kind} store`);
    return safeJoin(store.tasksDir, rel.slice('tasks/'.length));
  }
  return safeJoin(store.dir, rel);
}

/**
 * Find an entry file by id without the index (scans entries/<category>/).
 * @param {object} store - store descriptor
 * @param {string} id - entry id
 * @returns {string|null} absolute path, or null
 */
function findEntryFile(store, id) {
  if (!ID_RE.test(id)) return null;
  const entries = path.join(store.dir, 'entries');
  if (!fs.existsSync(entries)) return null;
  for (const cat of fs.readdirSync(entries)) {
    if (!CATEGORY_RE.test(cat)) continue;
    const f = path.join(entries, cat, `${id}.md`);
    if (fs.existsSync(f)) return safeJoin(store.dir, 'entries', cat, `${id}.md`);
  }
  return null;
}

/**
 * Read and parse an entry file.
 * @param {string} file - absolute path
 * @returns {{data: object, body: string}|null} entry, or null if missing
 */
function readEntryFile(file) {
  const text = readFileStable(file);
  return text === null ? null : parseEntry(text);
}

/**
 * Lock file of a store (one writer at a time per store).
 * @param {object} store - store descriptor
 * @returns {string} lock path
 */
function storeLock(store) {
  return path.join(store.dir, '.lock');
}

/**
 * Create schema.json the first time a store is written.
 * @param {object} store - store descriptor
 */
function ensureStore(store) {
  const f = path.join(store.dir, 'schema.json');
  if (!fs.existsSync(f)) writeFileAtomic(f, `${JSON.stringify({ schema_version: SCHEMA_VERSION }, null, 2)}\n`);
}

/**
 * Validate and write an entry (caller holds the store lock). A category change moves the file.
 * @param {object} store - store descriptor
 * @param {object} data - frontmatter
 * @param {string} body - Markdown body
 * @returns {string} absolute path written
 */
function writeEntry(store, data, body) {
  const problems = validateEntry(data, body);
  if (data.scope !== store.kind) problems.push(`scope "${data.scope}" does not belong in the ${store.kind} store.`);
  if (problems.length) throw new Error(`Invalid entry ${data.id || ''}: ${problems.join(' ')}`);
  ensureStore(store);
  const target = entryPath(store, data.category, data.id);
  const previous = findEntryFile(store, data.id);
  writeFileAtomic(target, serializeEntry(data, body));
  if (previous && path.resolve(previous) !== path.resolve(target)) fs.unlinkSync(previous);
  return target;
}

/**
 * Delete an entry file (caller holds the store lock).
 * @param {object} store - store descriptor
 * @param {string} id - entry id
 * @returns {boolean} true if removed
 */
function deleteEntry(store, id) {
  const f = findEntryFile(store, id);
  if (!f) return false;
  fs.unlinkSync(f);
  return true;
}

module.exports = {
  projectStore, globalStore, today, newId, safeJoin, entryPath, listSources, sourcePath, findEntryFile,
  readEntryFile, storeLock, ensureStore, writeEntry, deleteEntry, withLock, CATEGORY_RE,
};
