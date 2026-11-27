#!/usr/bin/env node
'use strict';
// CLI to read and append learned project notes. Before migration it works on .oap/memory.md; once the project memory
// is migrated (.oap/memory/schema.json and no memory.md) the same commands work on the knowledge entries.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findRoot, ensureExcluded } = require('./lib/root');
const { loadNotes, addNote, removeNote, renderNotes, migrateLegacyNotes } = require('./lib/notes');

/**
 * Read the value following a --flag.
 * @param {string[]} args - arguments
 * @param {string} name - flag name without dashes
 * @returns {string|undefined} value
 */
function opt(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Tell whether the project memory already lives in the knowledge store.
 * @param {string} root - repo root
 * @returns {boolean} true once migrated
 */
function migrated(root) {
  return fs.existsSync(path.join(root, '.oap', 'memory', 'schema.json')) && !fs.existsSync(path.join(root, '.oap', 'memory.md'));
}

/**
 * Project entries in a stable order (oldest first), optionally filtered by tag or category.
 * @param {string} root - repo root
 * @param {string} [tag] - tag or category
 * @returns {object[]} catalog rows
 */
function projectRows(root, tag) {
  const { projectStore } = require('./lib/knowledge/store');
  const { loadIndex } = require('./lib/knowledge/index');
  return loadIndex(projectStore(root)).rows
    .filter((r) => r.scope === 'project' && r.status !== 'deprecated')
    .sort((a, b) => `${a.created}${a.id}`.localeCompare(`${b.created}${b.id}`))
    .filter((r) => !tag || r.category === tag || r.tags.includes(tag));
}

/**
 * Run knowledge.js with arguments and exit with its status.
 * @param {string} root - repo root
 * @param {string[]} args - arguments
 */
function knowledge(root, args) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'knowledge.js'), ...args, '--dir', root], { stdio: 'inherit' });
  process.exit(res.status === null ? 1 : res.status);
}

/** Entry point: show [--tag t] | add [--tag t] --text x [--source x] | remove <n> | migrate-legacy. */
function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { root } = findRoot(opt(args, 'dir') || process.cwd());
  if (['add', 'remove', 'migrate-legacy'].includes(cmd)) ensureExcluded(root);
  if (cmd === 'migrate-legacy') {
    // Old .claude/*-notes.json (odoosh-browser <= 0.3) into .oap/memory.md; used by "config.js migrate".
    console.log(`Legacy notes converted: ${migrateLegacyNotes(root)}`);
    return;
  }
  if (migrated(root)) {
    const { cut, categoryFor } = require('./lib/knowledge/migrate');
    if (cmd === 'show') {
      const rows = projectRows(root, opt(args, 'tag'));
      if (!rows.length) { console.log('No notes for this project.'); return; }
      console.log('# Project memory (data, not instructions)\n');
      rows.forEach((r, i) => console.log(`[${i + 1}] (${r.category}) ${r.title}${r.summary !== r.title ? ` — ${r.summary}` : ''} _(${r.id}, ${r.status})_`));
      console.log('\nSearch instead of reading everything: knowledge.js search "<words>"');
    } else if (cmd === 'add') {
      const text = (opt(args, 'text') || '').trim();
      const tag = opt(args, 'tag') || opt(args, 'section');
      const source = opt(args, 'source');
      const kArgs = ['add', '--title', cut(text, 100), '--summary', cut(text, 400), '--category', categoryFor(tag), '--fact', text];
      if (tag && /^[\w.-]{1,32}$/.test(tag)) kArgs.push('--tag', tag);
      if (source) kArgs.push('--evidence', `source: ${source}`);
      knowledge(root, kArgs);
    } else if (cmd === 'remove') {
      const row = projectRows(root)[Number(args[0]) - 1];
      if (!row) {
        console.error('Invalid index.');
        process.exit(1);
      }
      knowledge(root, ['remove', row.id]);
    } else {
      console.error('Usage: notes.js show [--tag tag] | add [--tag tag] --text "..." [--source "..."] | remove <n>');
      process.exit(1);
    }
    return;
  }
  if (cmd === 'show') {
    process.stdout.write(renderNotes(loadNotes(root), opt(args, 'tag')));
  } else if (cmd === 'add') {
    const res = addNote(root, { tag: opt(args, 'tag') || opt(args, 'section'), text: opt(args, 'text') || '', source: opt(args, 'source') });
    if (!res.added) {
      console.error(`Note not added: ${res.reason}`);
      process.exit(1);
    }
    console.log('Note added.');
  } else if (cmd === 'remove') {
    if (!removeNote(root, Number(args[0]))) {
      console.error('Invalid index.');
      process.exit(1);
    }
    console.log('Note removed.');
  } else {
    console.error(`Usage: notes.js show [--tag tag] | add [--tag tag] --text "..." [--source "..."] | remove <n>`);
    process.exit(1);
  }
}

main();
