#!/usr/bin/env node
'use strict';
// Knowledge Manager CLI (oap-memory): project memory (.oap/memory), global knowledge (~/.oap/knowledge), task
// summaries and the memory session of a plugin task. Reading commands are free; writing ones are for the
// orchestrator only (mem-guard denies them to subagents during a session).
const fs = require('fs');
const path = require('path');
const { findRoot, ensureExcluded } = require('./lib/root');
const { loadDeclarations, projectFacts, globalCategories } = require('./lib/plugins');
const { startSession, endSession, loadSession, isSessionActive, recordInSession, renderKnowledge } = require('./lib/session');
const { getSection, ID_RE, SCHEMA_VERSION, SCOPES, STATUSES, GLOBAL_CATEGORIES } = require('./lib/knowledge/schema');
const {
  projectStore, globalStore, today, newId, findEntryFile, readEntryFile, storeLock, writeEntry, deleteEntry,
  sourcePath, withLock,
} = require('./lib/knowledge/store');
const { loadIndex } = require('./lib/knowledge/index');
const { search, formatResults, context, displayPath } = require('./lib/knowledge/search');
const { findSimilar, similarity, projectTerms, promote, updateGlobalCopy } = require('./lib/knowledge/promote');
const { validateEntry } = require('./lib/knowledge/validate');

const USAGE = `Usage: knowledge.js <command> [options]
  search "<text>" [--tag t]... [--category c] [--scope global|project|task|all] [--odoo 18.0] [--status s,s]
         [--since YYYY-MM-DD] [--include-deprecated] [--limit 8] [--max-chars 2000]
  get <id> [--section "How to apply"] [--max-chars 4000]
  context (--task <task.md> | --text "...") [--budget 1500] [--odoo 18.0]
  add --title "..." --summary "..." --category c [--type gotcha] [--tag t]... [--odoo 18.0]... [--status observed|verified]
      [--evidence "..."]... [--fact "..."] [--how "..."] [--body-file f.md] [--force-new] [--source <plugin>]
  update <id> [--title|--summary|--category|--type|--status "..."] [--tag t]... [--odoo v]... [--evidence "..."]... [--body-file f.md]
  deprecate <id> [--by <id>]
  remove <id>
  validate [<id>]
  task-summary --folder <task folder> --summary "..." [--outcome completed|blocked|abandoned|in-progress] [--modules a,b] [--files a,b]
  migrate [--dry-run] | --apply | --history | --rollback <stamp> | --needed
  reindex [--full]
  stats
  session start --source <plugin> [--task <id or title>] | session end | session status | session report [--json]
Options valid everywhere: --dir <repo path>`;

/**
 * Parse arguments: positionals plus --flags; repeated flags accumulate.
 * @param {string[]} argv - arguments after the command
 * @returns {{pos: string[], flags: object}} parsed arguments
 */
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const BOOL = new Set(['include-deprecated', 'force-new', 'full', 'json', 'apply', 'dry-run', 'history', 'needed']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    const v = BOOL.has(k) ? true : argv[++i];
    if (v === undefined) throw new Error(`Missing value for --${k}`);
    (flags[k] = flags[k] || []).push(v);
  }
  return { pos, flags };
}

/** First value of a flag. */
const one = (flags, k) => (flags[k] ? flags[k][0] : undefined);
/** All values of a repeatable flag, also split on commas. */
const many = (flags, k) => (flags[k] || []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);

/**
 * Print an error and exit with status 1.
 * @param {string} msg - message
 */
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * Store an id belongs to, from its prefix.
 * @param {string} id - entry id
 * @param {object} stores - {project, global}
 * @returns {object} store descriptor
 */
function storeOf(id, stores) {
  if (!ID_RE.test(id)) fail(`Invalid id: ${id}`);
  return id[0] === 'g' ? stores.global : stores.project;
}

/**
 * Locate an entry (entries, or a task summary through the index).
 * @param {string} id - entry id
 * @param {object} stores - {project, global}
 * @returns {{store: object, file: string, rel: string}|null} location
 */
function locate(id, stores) {
  const store = storeOf(id, stores);
  if (id[0] === 't') {
    const row = loadIndex(store).rows.find((r) => r.id === id);
    return row ? { store, file: sourcePath(store, row.path), rel: row.path } : null;
  }
  const file = findEntryFile(store, id);
  if (!file) return null;
  return { store, file, rel: path.relative(store.dir, file).split(path.sep).join('/') };
}

/**
 * Build the Markdown body of a new entry from flags.
 * @param {object} flags - parsed flags
 * @returns {string} body
 */
function bodyFrom(flags) {
  const file = one(flags, 'body-file');
  if (file) return fs.readFileSync(path.resolve(file), 'utf8');
  const parts = [];
  if (one(flags, 'fact')) parts.push(`## Fact\n${one(flags, 'fact')}`);
  if (one(flags, 'how')) parts.push(`## How to apply\n${one(flags, 'how')}`);
  const ev = many(flags, 'evidence');
  if (ev.length) parts.push(`## Evidence\n${ev.map((e) => `- ${e}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Record a knowledge action in the open memory session, so the task report lists it. No session: nothing.
 * @param {object} loaded - project context {root}
 * @param {object} item - {action, id, title, global?, reason?}
 */
function recordInRun(loaded, item) {
  recordInSession(loaded.root, item);
}

/**
 * Promote a verified project entry if it qualifies, record promoted_to, and describe the outcome.
 * @param {object} stores - {project, global}
 * @param {object} loaded - project context {root, decls, facts}
 * @param {object} data - project entry data (already written)
 * @param {string} body - entry body
 * @returns {string|null} line for the user, or null when nothing applies
 */
function autoPromote(stores, loaded, data, body) {
  if (data.scope !== 'project' || data.status !== 'verified' || data.promoted_to || data.no_promote) return null;
  const res = promote(stores.global, data, body, promoteCtx(loaded));
  const gid = res.promoted || res.merged;
  if (!gid) {
    recordInRun(loaded, { action: 'kept-in-project', id: data.id, title: data.title, reason: res.skipped.join(' ') });
    return `Kept in the project (not promoted to global): ${res.skipped.join(' ')}`;
  }
  recordInRun(loaded, { action: res.promoted ? 'promoted' : 'confirmed-global', id: data.id, title: data.title, global: gid });
  withLock(storeLock(stores.project), () => {
    const file = findEntryFile(stores.project, data.id);
    const cur = readEntryFile(file);
    writeEntry(stores.project, { ...cur.data, promoted_to: gid }, cur.body);
    loadIndex(stores.project, { locked: true });
  });
  return res.promoted
    ? `Promoted to global knowledge as ${gid} (remove with: knowledge.js remove ${gid})`
    : `Already in global knowledge as ${gid}: confirmation added.`;
}

/**
 * Words and categories the global checks use for this project.
 * @param {object} loaded - project context {root, decls, facts}
 * @returns {{projectTerms: string[], globalCategories: string[]}} promotion context
 */
function promoteCtx(loaded) {
  return { projectTerms: projectTerms(loaded.root, loaded.facts.terms), globalCategories: globalCategories(GLOBAL_CATEGORIES, loaded.decls) };
}

/**
 * Handle "session start|end|status|report".
 * @param {object} loaded - project context
 * @param {string[]} pos - positionals
 * @param {object} flags - flags
 */
function sessionCmd(loaded, pos, flags) {
  const sub = pos[0];
  if (sub === 'start') {
    const source = one(flags, 'source');
    if (!source || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) fail('session start needs --source <plugin name>');
    startSession(loaded.root, { source, task: one(flags, 'task') });
    console.log(`Memory session open for ${source}: lessons noted now appear in the task report. Close it with: session end`);
  } else if (sub === 'end') {
    console.log(endSession(loaded.root) ? 'Memory session closed.' : 'No open memory session.');
  } else if (sub === 'status') {
    const s = loadSession(loaded.root);
    console.log(s ? `${isSessionActive(loaded.root) ? 'open' : 'closed'} · ${s.source} · ${s.task || '-'} · ${(s.items || []).length} item(s) · started ${s.started_at}` : 'No memory session.');
  } else if (sub === 'report') {
    const s = loadSession(loaded.root);
    if (one(flags, 'json')) console.log(JSON.stringify({ items: (s && s.items) || [] }));
    else process.stdout.write(renderKnowledge(s));
  } else {
    fail('Usage: session start --source <plugin> [--task <id>] | session end | session status | session report [--json]');
  }
}

/** Entry point. */
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === 'help') { console.log(USAGE); return; }
  let args;
  try { args = parseArgs(rest); } catch (err) { fail(err.message); }
  const { pos, flags } = args;
  const { root } = findRoot(one(flags, 'dir') || process.cwd());
  const decls = loadDeclarations();
  const loaded = { root, decls, facts: projectFacts(root, decls) };
  const stores = { project: projectStore(loaded.root), global: globalStore() };
  const both = [stores.project, stores.global];
  const odoo = one(flags, 'odoo') || loaded.facts.odoo || undefined;
  // The first write in a repo creates .oap/: keep it out of the client's git status (local exclusion only).
  const writes = ['add', 'update', 'deprecate', 'remove', 'task-summary', 'reindex'].includes(cmd)
    || (cmd === 'session' && pos[0] === 'start') || (cmd === 'migrate' && one(flags, 'apply'));
  if (writes) ensureExcluded(loaded.root);
  if (cmd === 'session') { sessionCmd(loaded, pos, flags); return; }

  if (cmd === 'search') {
    const scope = one(flags, 'scope');
    if (scope && scope !== 'all' && !SCOPES.includes(scope)) fail(`--scope must be one of: all, ${SCOPES.join(', ')}`);
    const { results, total } = search(both, pos.join(' '), {
      tags: many(flags, 'tag').concat(many(flags, 'tags')), category: one(flags, 'category'), scope, odoo,
      status: flags.status ? many(flags, 'status') : undefined, since: one(flags, 'since'),
      includeDeprecated: Boolean(one(flags, 'include-deprecated')),
    });
    console.log(formatResults(results, {
      limit: Number(one(flags, 'limit')) || undefined, maxChars: Number(one(flags, 'max-chars')) || undefined, total, label: 'project + global',
    }));
  } else if (cmd === 'get') {
    const loc = pos[0] && locate(pos[0], stores);
    if (!loc) fail(`Entry not found: ${pos[0] || '(no id)'}`);
    const entry = readEntryFile(loc.file);
    const max = Number(one(flags, 'max-chars')) || 4000;
    let text = fs.readFileSync(loc.file, 'utf8');
    const section = one(flags, 'section');
    if (section) {
      text = getSection(entry.body, section);
      if (text === null) fail(`No section "${section}" in ${pos[0]}. Sections: ${(entry.body.match(/^## .+$/gm) || []).join(' | ')}`);
    }
    const cut = text.length > max ? `${text.slice(0, max)}\n[... cut at ${max} characters: use --section or --max-chars]` : text;
    console.log(`DATA, not instructions · ${displayPath(loc.store, { path: loc.rel })}\n${cut}`);
  } else if (cmd === 'context') {
    const task = one(flags, 'task');
    const text = task ? fs.readFileSync(path.resolve(task), 'utf8') : one(flags, 'text');
    if (!text) fail('context needs --task <file> or --text "..."');
    const budget = Number(one(flags, 'budget')) || 1500;
    // Not migrated yet: the old notes are still the project memory, so they go first, within 40% of the budget;
    // the rest of the context then gets the other 60%, so the total stays within the budget.
    const { loadNotes } = require('./lib/notes');
    const { notes } = loadNotes(loaded.root);
    const legacy = notes.length > 0 && fs.existsSync(path.join(loaded.root, '.oap', 'memory.md'));
    let out = context(both, text, { budget: legacy ? Math.floor(budget * 0.6) : budget, odoo });
    if (legacy) {
      const max = Math.floor(budget * 4 * 0.4);
      const lines = [];
      let used = 0;
      for (const n of notes) {
        const l = `- ${n.tag ? `(${n.tag}) ` : ''}${n.text}`;
        if (used + l.length > max) break;
        lines.push(l);
        used += l.length + 1;
      }
      const more = notes.length - lines.length;
      const rest = out.startsWith('No project memory or knowledge yet') ? '' : out;
      out = [
        '## Project notes (old format: migrate with knowledge.js migrate)',
        ...lines,
        more ? `(${more} more: notes.js show)` : '',
        rest,
      ].filter(Boolean).join('\n');
    }
    console.log(out.trim());
  } else if (cmd === 'add') {
    const date = today();
    const data = {
      id: 'p-00000000-0000', title: one(flags, 'title'), type: one(flags, 'type') || 'gotcha', scope: 'project',
      category: one(flags, 'category'), tags: many(flags, 'tag').concat(many(flags, 'tags')), odoo_versions: many(flags, 'odoo'),
      status: one(flags, 'status') || 'observed', summary: one(flags, 'summary'), evidence: many(flags, 'evidence'),
      superseded_by: null, promoted_to: null, created: date, updated: date, schema_version: SCHEMA_VERSION,
    };
    const source = one(flags, 'source') || (isSessionActive(loaded.root) ? loadSession(loaded.root).source : null);
    if (source && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) data.source = source;
    const body = bodyFrom(flags);
    const problems = validateEntry(data, body);
    if (problems.length) fail(`Entry not added: ${problems.join(' ')}`);
    const added = withLock(storeLock(stores.project), () => {
      if (!one(flags, 'force-new')) {
        const dup = findSimilar(loadIndex(stores.project, { locked: true }).rows, data);
        if (dup) return { dup };
      }
      data.id = newId(stores.project);
      writeEntry(stores.project, data, body);
      loadIndex(stores.project, { locked: true });
      return { id: data.id };
    });
    if (added.dup) {
      const pct = Math.round(similarity(added.dup, data) * 100);
      fail(`Similar entry already exists (${pct}% of the title and summary words in common): ${added.dup.id} "${added.dup.title}" vs new "${data.title}". `
        + `Update it (knowledge.js update ${added.dup.id} ...) or, if they are different topics, pass --force-new.`);
    }
    console.log(`Added ${added.id} (${data.status}) in .oap/memory/entries/${data.category}/`);
    recordInRun(loaded, { action: 'added', id: added.id, title: data.title, status: data.status });
    const note = autoPromote(stores, loaded, data, body);
    if (note) console.log(note);
  } else if (cmd === 'update' || cmd === 'deprecate') {
    const id = pos[0];
    if (id && id[0] === 't') fail('Task summaries are written with knowledge.js task-summary.');
    const store = storeOf(id, stores);
    const res = withLock(storeLock(store), () => {
      const file = findEntryFile(store, id);
      if (!file) return { error: `Entry not found: ${id}` };
      const { data, body } = readEntryFile(file);
      const next = { ...data, updated: today() };
      let nextBody = body;
      if (cmd === 'deprecate') {
        const by = one(flags, 'by');
        if (by && !findEntryFile(storeOf(by, stores), by)) return { error: `Replacement not found: ${by}` };
        next.status = 'deprecated';
        next.superseded_by = by || null;
      } else {
        for (const k of ['title', 'summary', 'category', 'type', 'status']) if (one(flags, k) !== undefined) next[k] = one(flags, k);
        if (flags.tag || flags.tags) next.tags = many(flags, 'tag').concat(many(flags, 'tags'));
        if (flags.odoo) next.odoo_versions = many(flags, 'odoo');
        if (flags.evidence) next.evidence = [...new Set([...(data.evidence || []), ...many(flags, 'evidence')])];
        if (one(flags, 'body-file')) nextBody = bodyFrom(flags);
        if (next.status && !STATUSES.includes(next.status)) return { error: `status must be one of: ${STATUSES.join(', ')}` };
      }
      try {
        writeEntry(store, next, nextBody);
      } catch (err) {
        return { error: err.message };
      }
      loadIndex(store, { locked: true });
      return { data: next, body: nextBody };
    });
    if (res.error) fail(res.error);
    console.log(`Updated ${id} (${res.data.status})`);
    if (cmd === 'deprecate' && res.data.promoted_to) {
      console.log(`Its global copy ${res.data.promoted_to} is still active: deprecate it too if it no longer holds anywhere.`);
    } else if (res.data.promoted_to) {
      const g = updateGlobalCopy(stores.global, res.data.promoted_to, res.data, res.body, promoteCtx(loaded));
      if (g.updated) {
        console.log(`Global copy ${g.updated} updated too.`);
        recordInRun(loaded, { action: 'global-updated', id, title: res.data.title, global: g.updated });
      }
      else if (g.missing) console.log(`Global copy ${res.data.promoted_to} not found (removed?): run knowledge.js validate.`);
      else console.log(`Global copy ${res.data.promoted_to} NOT updated, it keeps the previous text: ${g.skipped.join(' ')}`);
    }
    const note = autoPromote(stores, loaded, res.data, res.body);
    if (note) console.log(note);
  } else if (cmd === 'remove') {
    const id = pos[0];
    if (!id || id[0] === 't') fail('remove takes a project (p-) or global (g-) entry id.');
    const store = storeOf(id, stores);
    const removed = withLock(storeLock(store), () => {
      const ok = deleteEntry(store, id);
      if (ok) loadIndex(store, { locked: true });
      return ok;
    });
    if (!removed) fail(`Entry not found: ${id}`);
    console.log(`Removed ${id}`);
    if (id[0] === 'g') {
      // The project entry it came from stays, unlinked and marked so the next update does not promote it again.
      const unlinked = withLock(storeLock(stores.project), () => {
        const rows = loadIndex(stores.project, { locked: true }).rows.filter((r) => r.promoted_to === id);
        for (const r of rows) {
          const cur = readEntryFile(sourcePath(stores.project, r.path));
          writeEntry(stores.project, { ...cur.data, promoted_to: null, no_promote: true }, cur.body);
        }
        if (rows.length) loadIndex(stores.project, { locked: true });
        return rows.map((r) => r.id);
      });
      if (unlinked.length) console.log(`Kept in this project and no longer promoted: ${unlinked.join(', ')}`);
    }
  } else if (cmd === 'validate') {
    let bad = 0;
    const indexes = both.map((store) => ({ store, ...loadIndex(store) }));
    const ids = new Set(indexes.flatMap((x) => x.rows.map((r) => r.id)));
    for (const { store, rows, invalid } of indexes) {
      for (const inv of invalid) {
        if (pos[0] && !inv.path.includes(pos[0])) continue;
        bad++;
        console.log(`INVALID ${store.kind} ${inv.path}: ${inv.error}`);
      }
      for (const r of rows) {
        if (pos[0] && r.id !== pos[0]) continue;
        for (const k of ['superseded_by', 'promoted_to']) {
          if (r[k] && !ids.has(r[k])) { bad++; console.log(`BROKEN LINK ${r.id}: ${k} ${r[k]} not found`); }
        }
      }
    }
    console.log(bad ? `${bad} problem(s).` : 'All entries valid.');
    if (bad) process.exit(1);
  } else if (cmd === 'task-summary') {
    const { hashText, cut } = require('./lib/knowledge/migrate');
    const { safeJoin } = require('./lib/knowledge/store');
    const { parseEntry, serializeEntry } = require('./lib/knowledge/schema');
    const { writeFileAtomic } = require('./lib/fsatomic');
    const name = path.basename(String(one(flags, 'folder') || '').replace(/[\\/]+$/, ''));
    if (!name) fail('task-summary needs --folder <.oap/odoo-squad/tasks/<id>>');
    const dir = safeJoin(stores.project.tasksDir, name);
    if (!fs.existsSync(path.join(dir, 'task.md'))) fail(`No task.md in ${dir}`);
    const outcome = one(flags, 'outcome') || 'completed';
    if (!['in-progress', 'completed', 'blocked', 'abandoned'].includes(outcome)) fail('--outcome must be in-progress, completed, blocked or abandoned');
    const summary = one(flags, 'summary');
    if (!summary) fail('task-summary needs --summary "what was done and the result"');
    const file = path.join(dir, 'summary.md');
    const prev = fs.existsSync(file) ? parseEntry(fs.readFileSync(file, 'utf8')).data : {};
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(name);
    const created = prev.created || (m ? `${m[1]}-${m[2]}-${m[3]}` : today());
    const heading = /^#\s+(.+?)\s*$/m.exec(fs.readFileSync(path.join(dir, 'task.md'), 'utf8'));
    const docs = ['task.md', 'aclaraciones.md', 'plan.md', 'hallazgos.md'].filter((f) => fs.existsSync(path.join(dir, f)));
    const data = {
      ...prev, id: prev.id || `t-${created.replace(/-/g, '')}-${hashText(`task:${name}`).slice(0, 6)}`,
      title: cut(one(flags, 'title') || prev.title || (heading && heading[1]) || name, 120), type: 'task', scope: 'task', category: 'task',
      tags: flags.tag ? many(flags, 'tag') : (prev.tags || []), odoo_versions: flags.odoo ? many(flags, 'odoo') : (prev.odoo_versions || (odoo ? [odoo] : [])),
      status: 'observed', summary: cut(summary, 400), evidence: prev.evidence || [], superseded_by: null, promoted_to: null,
      created, updated: today(), schema_version: SCHEMA_VERSION, outcome,
      modules: flags.modules ? many(flags, 'modules') : (prev.modules || []), files: flags.files ? many(flags, 'files') : (prev.files || []),
    };
    const body = one(flags, 'body-file') ? fs.readFileSync(path.resolve(one(flags, 'body-file')), 'utf8')
      : `## Result\n${summary}\n\n## Files\n${docs.join(', ')} in .oap/odoo-squad/tasks/${name}/\n`;
    const problems = validateEntry(data, body);
    if (problems.length) fail(`Summary not written: ${problems.join(' ')}`);
    withLock(storeLock(stores.project), () => {
      writeFileAtomic(file, serializeEntry(data, body));
      loadIndex(stores.project, { locked: true });
    });
    console.log(`Task summary ${data.id} (${outcome}) written to .oap/odoo-squad/tasks/${name}/summary.md`);
  } else if (cmd === 'migrate') {
    const { planMigration, renderPlan, applyMigration, rollbackMigration, migrationLog, needsMigration } = require('./lib/knowledge/migrate');
    if (one(flags, 'needed')) {
      // Quiet check for other tools (config.js validate): one warning line, or nothing.
      if (needsMigration(loaded.root)) console.log('Warning: project memory in the old format. Review "knowledge.js migrate" (dry-run) and apply it with "knowledge.js migrate --apply".');
    } else if (one(flags, 'rollback')) {
      const res = rollbackMigration(loaded.root, one(flags, 'rollback'));
      if (!res.ok) fail(res.message);
      console.log(res.message);
    } else if (one(flags, 'apply')) {
      const res = applyMigration(loaded.root);
      console.log(res.report);
      if (!res.ok) fail(`Migration not applied: ${res.errors.join(' | ')}`);
      if (!res.nothing) console.log(`Migration ${res.stamp} applied.`);
    } else if (one(flags, 'history')) {
      const log = migrationLog(loaded.root);
      console.log(log.length ? log.map((r) => `${r.stamp} ${r.status}${r.notes !== undefined ? ` · notes ${r.notes} · tasks ${r.tasks}` : ''}`).join('\n') : 'No migrations yet.');
    } else {
      console.log(renderPlan(planMigration(loaded.root), 'Memory migration: dry-run (nothing written)'));
      console.log('Apply with: knowledge.js migrate --apply (asks for confirmation)');
    }
  } else if (cmd === 'reindex') {
    for (const store of both) {
      const { rows, invalid, changed } = loadIndex(store, { full: Boolean(one(flags, 'full')) });
      console.log(`${store.kind}: ${rows.length} entries, ${invalid.length} invalid, ${changed} re-read`);
    }
  } else if (cmd === 'stats') {
    for (const store of both) {
      const { rows, invalid } = loadIndex(store);
      const by = (k) => Object.entries(rows.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] || 0) + 1 }), {})).map(([a, n]) => `${a} ${n}`).join(', ');
      console.log(`${store.kind}: ${rows.length} entries${rows.length ? ` · status: ${by('status')} · scope: ${by('scope')}` : ''}${invalid.length ? ` · ${invalid.length} invalid` : ''}`);
    }
  } else {
    fail(USAGE);
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
