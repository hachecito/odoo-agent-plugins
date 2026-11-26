'use strict';
// Migration of the old memory (.oap/memory.md and odoo-squad task folders) to the knowledge store.
// Dry-run writes nothing. Apply backs up, writes, verifies, reports and only then renames memory.md (never deletes).
// Idempotent: every migrated note carries the hash of its original line; a second run skips what is already there.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, readFileStable, withLock } = require('../fsatomic');
const { agentFile, legacyFile } = require('../config');
const { parseMemory } = require('../notes');
const { SCHEMA_VERSION, serializeEntry } = require('./schema');
const { validateEntry } = require('./validate');
const { projectStore, storeLock, writeEntry, listSources, readEntryFile, CATEGORY_RE } = require('./store');
const { loadIndex } = require('./index');
const { search } = require('./search');
const { similarity } = require('./promote');

const HEADER_RE = /^(#\s|Findings that turned out|Hallazgos que resultaron|Lo que resultó)/i;
// Old task statuses (Spanish ones too) as task outcomes.
const OUTCOMES = {
  'in-progress': 'in-progress', completed: 'completed', blocked: 'blocked', abandoned: 'abandoned', migrated: 'migrated',
  'en-curso': 'in-progress', completada: 'completed', bloqueada: 'blocked', abandonada: 'abandoned', migrada: 'migrated',
};

/**
 * Short hash of a normalized text.
 * @param {string} text - text
 * @returns {string} 40 hex chars
 */
function hashText(text) {
  return crypto.createHash('sha1').update(String(text).trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
}

/**
 * Cut text at a word boundary.
 * @param {string} text - text
 * @param {number} max - maximum length
 * @returns {string} text, with "..." when cut
 */
function cut(text, max) {
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  const head = s.slice(0, max - 3);
  const sp = head.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.-]+$/, '')}...`;
}

/**
 * Category for an old note tag (lowercase, safe characters); "general" when there is none.
 * @param {string} tag - old tag
 * @returns {string} category
 */
function categoryFor(tag) {
  const c = String(tag || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return CATEGORY_RE.test(c) ? c : 'general';
}

/**
 * Legacy hashes and migration stamps of the entries already in the project store.
 * @param {object} store - project store
 * @returns {Map<string, {id: string, migration: string}>} legacy hash -> entry
 */
function migratedHashes(store) {
  const out = new Map();
  for (const src of listSources(store)) {
    try {
      const { data } = readEntryFile(src.file) || {};
      if (data && data.legacy) out.set(String(data.legacy), { id: data.id, migration: data.migration || '' });
    } catch {
      // An unreadable entry is reported by validate, not here.
    }
  }
  return out;
}

/**
 * Entry built from one old memory.md note.
 * @param {object} note - {tag, text, at, source}
 * @param {string} stamp - migration timestamp
 * @returns {{data: object, body: string, legacy: string}} entry
 */
function noteEntry(note, stamp) {
  const h = hashText(note.text);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(note.at) ? note.at : stamp.slice(0, 10);
  const data = {
    id: `p-${date.replace(/-/g, '')}-${h.slice(0, 6)}`, title: cut(note.text, 100), type: 'gotcha', scope: 'project',
    category: categoryFor(note.tag), tags: note.tag && /^[\w.-]{1,32}$/.test(note.tag) ? [note.tag] : [], odoo_versions: [],
    status: 'observed', summary: cut(note.text, 400), evidence: note.source ? [`legacy: ${cut(note.source, 120)}`] : [],
    superseded_by: null, promoted_to: null, created: date, updated: date, schema_version: SCHEMA_VERSION,
    legacy: `memory.md#sha1:${h}`, migration: stamp,
  };
  const body = `## Fact\n${note.text.trim()}\n\n## Evidence\nMigrated from .oap/memory.md${note.source ? ` (source: ${note.source})` : ''}.\n`;
  return { data, body, legacy: data.legacy };
}

/**
 * Summary entry for an old task folder.
 * @param {string} tasksDir - .oap/odoo-squad/tasks
 * @param {{id: string, status: string, title: string}} task - index line
 * @param {string} stamp - migration timestamp
 * @returns {{data: object, body: string, legacy: string, file: string}} entry
 */
function taskEntry(tasksDir, task, stamp) {
  const dir = path.join(tasksDir, task.id);
  const read = (f) => readFileStable(path.join(dir, f)) || '';
  const taskText = read('task.md');
  const findings = read('hallazgos.md').split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l)).join('\n');
  const firstPara = taskText.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#')) || task.title;
  const m = /^(\d{8})/.exec(task.id);
  const date = m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : stamp.slice(0, 10);
  const h = hashText(`task:${task.id}`);
  const files = ['task.md', 'aclaraciones.md', 'plan.md', 'hallazgos.md'].filter((f) => fs.existsSync(path.join(dir, f)));
  const data = {
    id: `t-${date.replace(/-/g, '')}-${h.slice(0, 6)}`, title: cut(task.title, 120), type: 'task', scope: 'task', category: 'task',
    tags: [], odoo_versions: [], status: 'observed', summary: cut(firstPara, 400), evidence: [], superseded_by: null,
    promoted_to: null, created: date, updated: date, schema_version: SCHEMA_VERSION,
    outcome: OUTCOMES[task.status] || 'migrated', legacy: `task#sha1:${h}`, migration: stamp,
  };
  const body = [
    `## Task\n${cut(taskText.replace(/^#.*$/m, ''), 1200)}`,
    findings ? `## Findings\n${cut(findings, 800)}` : '',
    `## Files\n${files.join(', ')} in .oap/odoo-squad/tasks/${task.id}/`,
  ].filter(Boolean).join('\n\n');
  return { data, body: `${body}\n`, legacy: data.legacy, file: path.join(dir, 'summary.md') };
}

/**
 * Read the old task index (Spanish or English header, same line format).
 * @param {string} tasksDir - tasks folder
 * @returns {Array<{id: string, status: string, title: string}>} tasks
 */
function oldTasks(tasksDir) {
  const text = readFileStable(path.join(tasksDir, 'index.md'));
  const listed = text ? text.split(/\r?\n/).map((l) => /^- (\S+) · (\S+) · (.*)$/.exec(l)).filter(Boolean).map((m) => ({ id: m[1], status: m[2], title: m[3] })) : [];
  // Folders missing from the index still count, so no task is left out.
  if (fs.existsSync(tasksDir)) {
    for (const d of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (d.isDirectory() && !listed.some((t) => t.id === d.name) && fs.existsSync(path.join(tasksDir, d.name, 'task.md'))) {
        listed.push({ id: d.name, status: 'migrated', title: d.name.replace(/^\d{8}-/, '').replace(/-/g, ' ') });
      }
    }
  }
  return listed.filter((t) => /^[\w.-]+$/.test(t.id) && fs.existsSync(path.join(tasksDir, t.id)));
}

/**
 * Work out what a migration would do. Writes nothing.
 * @param {string} root - repo root
 * @param {string} [stamp] - migration timestamp (YYYYMMDD-HHMMSS)
 * @returns {object} plan: {stamp, memoryFile, notes, tasks, unparsed, legacyJson, similar, totals}
 */
function planMigration(root, stamp = timestamp()) {
  const store = projectStore(root);
  const memoryFile = agentFile(root, 'memory');
  const existing = migratedHashes(store);
  const plan = { stamp, memoryFile: fs.existsSync(memoryFile) ? memoryFile : null, notes: [], tasks: [], unparsed: [], legacyJson: legacyFile(root, 'notes'), similar: [] };
  if (plan.memoryFile) {
    const text = readFileStable(memoryFile) || '';
    const notes = parseMemory(text);
    // Everything before the first note is the file header (its wording changed across versions); a non-note line
    // after it is reported, and kept in memory.md.migrated.
    let seenNote = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('- ')) seenNote = true;
      else if (seenNote && line.trim() && !HEADER_RE.test(line.trim())) plan.unparsed.push(line.trim());
    }
    for (const note of notes) {
      const e = noteEntry(note, stamp);
      const item = { note, entry: e };
      if (existing.has(e.legacy)) item.action = 'already-migrated';
      else {
        const problems = validateEntry(e.data, e.body);
        if (problems.length) { item.action = 'skip'; item.reason = problems.join(' '); } else item.action = 'migrate';
      }
      plan.notes.push(item);
    }
    const ok = plan.notes.filter((n) => n.action === 'migrate');
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const s = similarity(ok[i].entry.data, ok[j].entry.data);
        if (s >= 0.6) plan.similar.push({ a: ok[i].entry.data.id, b: ok[j].entry.data.id, score: s });
      }
    }
  }
  for (const task of oldTasks(store.tasksDir)) {
    const e = taskEntry(store.tasksDir, task, stamp);
    const item = { task, entry: e };
    if (fs.existsSync(e.file) || existing.has(e.legacy)) item.action = 'already-migrated';
    else {
      const problems = validateEntry(e.data, e.body);
      if (problems.length) { item.action = 'skip'; item.reason = problems.join(' '); } else item.action = 'migrate';
    }
    plan.tasks.push(item);
  }
  const count = (list, a) => list.filter((x) => x.action === a).length;
  plan.totals = {
    notes: plan.notes.length, notesToMigrate: count(plan.notes, 'migrate'), notesSkipped: count(plan.notes, 'skip'), notesDone: count(plan.notes, 'already-migrated'),
    tasks: plan.tasks.length, tasksToMigrate: count(plan.tasks, 'migrate'), tasksSkipped: count(plan.tasks, 'skip'), tasksDone: count(plan.tasks, 'already-migrated'),
  };
  return plan;
}

/**
 * Render a plan (or an applied migration) as Markdown for the user.
 * @param {object} plan - result of planMigration
 * @param {string} title - heading
 * @returns {string} report
 */
function renderPlan(plan, title) {
  const t = plan.totals;
  const lines = [`# ${title}`, '', `Migration ${plan.stamp}.`, ''];
  if (plan.legacyJson) lines.push(`Old notes file found (${path.basename(plan.legacyJson)}): run "config.js migrate" first.`, '');
  lines.push(`- Notes in memory.md: ${t.notes} (to migrate ${t.notesToMigrate}, already migrated ${t.notesDone}, skipped ${t.notesSkipped})`);
  lines.push(`- Task folders: ${t.tasks} (to migrate ${t.tasksToMigrate}, already migrated ${t.tasksDone}, skipped ${t.tasksSkipped})`);
  if (plan.unparsed.length) lines.push(`- Lines in memory.md that are not notes (kept in memory.md.migrated, not migrated): ${plan.unparsed.length}`);
  lines.push('');
  if (plan.notes.length) {
    lines.push('## Notes', '', '| Action | New id | Category | Title | Reason |', '| --- | --- | --- | --- | --- |');
    for (const n of plan.notes) lines.push(`| ${n.action} | ${n.entry.data.id} | ${n.entry.data.category} | ${n.entry.data.title.replace(/\|/g, '/')} | ${(n.reason || '').replace(/\|/g, '/')} |`);
    lines.push('');
  }
  if (plan.tasks.length) {
    lines.push('## Tasks', '', '| Action | Folder | Outcome | Reason |', '| --- | --- | --- | --- |');
    for (const x of plan.tasks) lines.push(`| ${x.action} | ${x.task.id} | ${x.entry.data.outcome} | ${(x.reason || '').replace(/\|/g, '/')} |`);
    lines.push('');
  }
  if (plan.similar.length) {
    lines.push('## Similar notes (all migrated; merge them later if they are the same lesson)', '');
    for (const s of plan.similar) lines.push(`- ${s.a} and ${s.b}: ${Math.round(s.score * 100)}% of words in common`);
    lines.push('');
  }
  if (plan.unparsed.length) {
    lines.push('## Lines that are not notes', '', ...plan.unparsed.map((l) => `- ${l.replace(/^-\s*/, '')}`), '');
  }
  return lines.join('\n');
}

/**
 * Current time as a migration stamp.
 * @param {Date} [d] - date
 * @returns {string} YYYYMMDD-HHMMSS
 */
function timestamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Append a record to migrations.jsonl.
 * @param {object} store - project store
 * @param {object} rec - record
 */
function logMigration(store, rec) {
  const f = path.join(store.dir, 'migrations.jsonl');
  const prev = readFileStable(f) || '';
  writeFileAtomic(f, `${prev}${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
}

/**
 * Records of migrations.jsonl.
 * @param {string} root - repo root
 * @returns {object[]} records in order
 */
function migrationLog(root) {
  const text = readFileStable(path.join(projectStore(root).dir, 'migrations.jsonl')) || '';
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Copy a file into the backup folder (same relative path) and return its checksum.
 * @param {string} root - repo root
 * @param {string} backup - backup folder
 * @param {string} file - absolute file path
 * @returns {string} sha1 of the content
 */
function backupFile(root, backup, file) {
  const rel = path.relative(root, file);
  const target = path.join(backup, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Remove what a migration created and restore its backup (used by rollback and after a failed verification).
 * @param {string} root - repo root
 * @param {string} stamp - migration timestamp
 * @returns {{removed: number, restored: number}} counts
 */
function undo(root, stamp) {
  const store = projectStore(root);
  let removed = 0;
  for (const src of listSources(store)) {
    let data;
    try { ({ data } = readEntryFile(src.file) || {}); } catch { continue; }
    if (data && data.migration === stamp) {
      fs.unlinkSync(src.file);
      removed++;
    }
  }
  let restored = 0;
  const backup = path.join(root, '.oap', 'backups', `migration-${stamp}`);
  const manifest = readFileStable(path.join(backup, 'checksums.json'), JSON.parse) || {};
  for (const rel of Object.keys(manifest)) {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(backup, rel), target);
      restored++;
    }
  }
  return { removed, restored };
}

/**
 * Apply a migration: backup, write entries and task summaries, verify, report, rename memory.md.
 * @param {string} root - repo root
 * @returns {{ok: boolean, stamp: string, plan: object, report: string, errors: string[]}} outcome
 */
function applyMigration(root) {
  const store = projectStore(root);
  fs.mkdirSync(store.dir, { recursive: true });
  return withLock(storeLock(store), () => {
    // A stamp is unique per repo: two runs within the same second must not share a backup folder.
    const used = new Set(migrationLog(root).map((r) => r.stamp));
    let stamp = timestamp();
    for (let n = 2; used.has(stamp) || fs.existsSync(path.join(root, '.oap', 'backups', `migration-${stamp}`)); n++) stamp = `${timestamp()}-${n}`;
    const plan = planMigration(root, stamp);
    const errors = [];
    if (plan.legacyJson) return { ok: false, stamp, plan, report: renderPlan(plan, 'Migration not started'), errors: ['Run "config.js migrate" first: an old .claude notes file exists.'] };
    const todo = plan.totals.notesToMigrate + plan.totals.tasksToMigrate;
    if (!todo && !plan.memoryFile) return { ok: true, stamp, plan, report: 'Nothing to migrate.', errors, nothing: true };
    const backup = path.join(root, '.oap', 'backups', `migration-${stamp}`);
    const checksums = {};
    if (plan.memoryFile) checksums[path.relative(root, plan.memoryFile).split(path.sep).join('/')] = backupFile(root, backup, plan.memoryFile);
    const index = path.join(store.tasksDir, 'index.md');
    if (fs.existsSync(index)) checksums[path.relative(root, index).split(path.sep).join('/')] = backupFile(root, backup, index);
    writeFileAtomic(path.join(backup, 'checksums.json'), `${JSON.stringify(checksums, null, 2)}\n`);
    logMigration(store, { stamp, status: 'started', backup: path.relative(root, backup).split(path.sep).join('/') });

    for (const n of plan.notes.filter((x) => x.action === 'migrate')) {
      try { writeEntry(store, n.entry.data, n.entry.body); } catch (err) { errors.push(`${n.entry.data.id}: ${err.message}`); }
    }
    for (const x of plan.tasks.filter((t) => t.action === 'migrate')) {
      try { writeFileAtomic(x.entry.file, serializeEntry(x.entry.data, x.entry.body)); } catch (err) { errors.push(`${x.task.id}: ${err.message}`); }
    }
    const { rows } = loadIndex(store, { locked: true, full: true });

    // Verification: every note is either an indexed entry or skipped with a reason, and can be found by its text.
    const ids = new Set(rows.map((r) => r.id));
    const indexes = new Map([[store, { rows }]]);
    for (const n of plan.notes) {
      if (n.action === 'skip') continue;
      const id = n.action === 'migrate' ? n.entry.data.id : null;
      if (id && !ids.has(id)) errors.push(`note not indexed after migration: ${id}`);
      if (id && !search([store], n.note.text, { indexes, includeDeprecated: true }).results.slice(0, 3).some((r) => r.row.id === id)) {
        errors.push(`note not found by its own text: ${id}`);
      }
    }
    for (const x of plan.tasks.filter((t) => t.action === 'migrate')) if (!ids.has(x.entry.data.id)) errors.push(`task summary not indexed: ${x.task.id}`);
    const accounted = plan.notes.length === plan.totals.notesToMigrate + plan.totals.notesSkipped + plan.totals.notesDone;
    if (!accounted) errors.push('note count mismatch');

    if (errors.length) {
      undo(root, stamp);
      loadIndex(store, { locked: true, full: true });
      logMigration(store, { stamp, status: 'failed', errors });
      return { ok: false, stamp, plan, report: renderPlan(plan, 'Migration failed and was undone'), errors };
    }
    let renamed = null;
    if (plan.memoryFile) {
      renamed = path.join(root, '.oap', fs.existsSync(path.join(root, '.oap', 'memory.md.migrated')) ? `memory.md.migrated-${stamp}` : 'memory.md.migrated');
      fs.renameSync(plan.memoryFile, renamed);
    }
    const report = `${renderPlan(plan, 'Memory migration')}\nBackup: ${path.relative(root, backup)}. ${renamed ? `memory.md renamed to ${path.basename(renamed)}.` : ''} Undo with: knowledge.js migrate --rollback ${stamp}\n`;
    writeFileAtomic(path.join(store.dir, 'migrations', `${stamp}.md`), report);
    logMigration(store, { stamp, status: 'done', notes: plan.totals.notesToMigrate, tasks: plan.totals.tasksToMigrate, renamed: renamed && path.basename(renamed) });
    return { ok: true, stamp, plan, report, errors };
  });
}

/**
 * Undo a migration: remove the entries and task summaries it created and bring memory.md back.
 * @param {string} root - repo root
 * @param {string} stamp - migration timestamp
 * @returns {{ok: boolean, message: string}} outcome
 */
function rollbackMigration(root, stamp) {
  const store = projectStore(root);
  const rec = migrationLog(root).filter((r) => r.stamp === stamp);
  if (!rec.length) return { ok: false, message: `No migration ${stamp} in .oap/memory/migrations.jsonl.` };
  if (rec.some((r) => r.status === 'rolled-back')) return { ok: false, message: `Migration ${stamp} was already rolled back.` };
  return withLock(storeLock(store), () => {
    const done = rec.find((r) => r.status === 'done');
    const memory = path.join(root, '.oap', 'memory.md');
    if (done && done.renamed) {
      const renamed = path.join(root, '.oap', done.renamed);
      if (fs.existsSync(memory)) return { ok: false, message: 'memory.md exists again: move it aside before rolling back.' };
      if (fs.existsSync(renamed)) fs.renameSync(renamed, memory);
    }
    const res = undo(root, stamp);
    // Entries added after the migration go back into memory.md too, so the old format holds everything again.
    let moved = 0;
    if (done && done.renamed && fs.existsSync(memory)) {
      const lines = [];
      for (const src of listSources(store)) {
        let entry;
        try { entry = readEntryFile(src.file); } catch { continue; }
        if (!entry || entry.data.scope !== 'project' || entry.data.status === 'deprecated') continue;
        const tag = /^[\w.-]{1,24}$/.test(entry.data.category) && entry.data.category !== 'general' ? `**${entry.data.category}** ` : '';
        lines.push(`- ${tag}${entry.data.summary.replace(/[\r\n]+/g, ' ')} _(${entry.data.created}, ${entry.data.id})_`);
        fs.unlinkSync(src.file);
        moved++;
      }
      if (lines.length) {
        const text = readFileStable(memory) || '';
        writeFileAtomic(memory, `${text}${text.endsWith('\n') || !text ? '' : '\n'}${lines.join('\n')}\n`);
      }
    }
    removeEmptyDirs(path.join(store.dir, 'entries'));
    loadIndex(store, { locked: true, full: true });
    logMigration(store, { stamp, status: 'rolled-back', removed: res.removed, moved_back: moved });
    return {
      ok: true,
      message: `Rolled back ${stamp}: ${res.removed} entries and summaries removed${done && done.renamed ? ', memory.md restored' : ''}`
        + `${moved ? `, ${moved} entries added after the migration moved back into memory.md` : ''}.`,
    };
  });
}

/**
 * Remove empty category folders left behind (the entries folder itself stays).
 * @param {string} dir - entries folder
 */
function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && !fs.readdirSync(p).length) fs.rmdirSync(p);
  }
}

/**
 * Tell whether a repo still has memory in the old format.
 * @param {string} root - repo root
 * @returns {boolean} true if memory.md or task folders without summary exist
 */
function needsMigration(root) {
  const store = projectStore(root);
  if (fs.existsSync(path.join(root, '.oap', 'memory.md')) || legacyFile(root, 'notes')) return true;
  return oldTasks(store.tasksDir).some((t) => !fs.existsSync(path.join(store.tasksDir, t.id, 'summary.md')));
}

module.exports = { planMigration, renderPlan, applyMigration, rollbackMigration, migrationLog, needsMigration, hashText, noteEntry, taskEntry, timestamp, cut, categoryFor };
