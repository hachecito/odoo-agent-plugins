#!/usr/bin/env node
'use strict';
// CLI to read and append learned project notes (.oap/memory.md).
const { loadConfig } = require('./lib/config');
const { loadNotes, addNote, removeNote, renderNotes } = require('./lib/notes');

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

/** Entry point: show [--tag t] | add [--tag t] --text x [--source x] | remove <n>. */
function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const loaded = loadConfig(opt(args, 'dir') || process.cwd());
  if (!loaded) {
    console.error('No hay .oap/odoosh-browser/config.json: ejecutar primero la skill odoo-project-setup.');
    process.exit(1);
  }
  const root = loaded.root;
  if (cmd === 'show') {
    process.stdout.write(renderNotes(loadNotes(root), opt(args, 'tag')));
  } else if (cmd === 'add') {
    const res = addNote(root, { tag: opt(args, 'tag') || opt(args, 'section'), text: opt(args, 'text') || '', source: opt(args, 'source') });
    if (!res.added) {
      console.error(`Nota no añadida: ${res.reason}`);
      process.exit(1);
    }
    console.log('Nota añadida.');
  } else if (cmd === 'remove') {
    if (!removeNote(root, Number(args[0]))) {
      console.error('Índice inválido.');
      process.exit(1);
    }
    console.log('Nota eliminada.');
  } else {
    console.error(`Uso: notes.js show [--tag etiqueta] | add [--tag etiqueta] --text "..." [--source "..."] | remove <n>`);
    process.exit(1);
  }
}

main();
