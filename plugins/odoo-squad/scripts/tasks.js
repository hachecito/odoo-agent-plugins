#!/usr/bin/env node
'use strict';
// Task folders of odoo-squad: .oap/odoo-squad/tasks/<AAAAMMDD-slug>/{task,plan,hallazgos}.md plus a one-line-per-task index.
// Usage: node tasks.js new --title "..." [--from tarea.md] | status <id> <estado> | list | migrate   [--dir ruta]
const fs = require('fs');
const path = require('path');

const STATUSES = ['en-curso', 'completada', 'bloqueada', 'abandonada', 'migrada'];
const INDEX_HEADER = '# Tareas del squad\n\nUna línea por tarea: id · estado · título. La carpeta de cada tarea guarda task.md, plan.md y hallazgos.md.\n\n';
const LINE_RE = /^- (\S+) · (\S+) · (.*)$/;
const FINDINGS_HEADER = '# Hallazgos de la tarea\n\nDetalles que solo valen para esta tarea. Lo reutilizable va a .oap/memory.md.\n\n';

/**
 * Find the repo root that holds .oap/, walking up from a directory.
 * @param {string} start - starting directory
 * @returns {string|null} root, or null
 */
function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.oap'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Tasks directory of a repo.
 * @param {string} root - repo root
 * @returns {string} absolute path
 */
function tasksDir(root) {
  return path.join(root, '.oap', 'odoo-squad', 'tasks');
}

/**
 * Turn a title into a short folder slug.
 * @param {string} title - task title
 * @returns {string} slug (a-z, 0-9, dashes; max 40)
 */
function slugify(title) {
  const s = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'tarea';
}

/**
 * Read the index entries.
 * @param {string} root - repo root
 * @returns {Array<{id: string, status: string, title: string}>} entries in file order
 */
function readIndex(root) {
  const p = path.join(tasksDir(root), 'index.md');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => LINE_RE.exec(l)).filter(Boolean)
    .map((m) => ({ id: m[1], status: m[2], title: m[3] }));
}

/**
 * Write the index entries.
 * @param {string} root - repo root
 * @param {Array<object>} entries - index entries
 */
function writeIndex(root, entries) {
  fs.mkdirSync(tasksDir(root), { recursive: true });
  const lines = entries.map((e) => `- ${e.id} · ${e.status} · ${e.title.replace(/[\r\n]+/g, ' ')}`);
  fs.writeFileSync(path.join(tasksDir(root), 'index.md'), `${INDEX_HEADER}${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

/**
 * Create a task folder and register it in the index.
 * @param {string} root - repo root
 * @param {{title: string, body?: string, date?: Date}} task - title, task text and creation date
 * @returns {{id: string, dir: string}} new task id and folder
 */
function newTask(root, task) {
  const date = (task.date || new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${date}-${slugify(task.title)}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(tasksDir(root), id)); n++) id = `${base}-${n}`;
  const dir = path.join(tasksDir(root), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), task.body || `# ${task.title}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'hallazgos.md'), FINDINGS_HEADER, 'utf8');
  writeIndex(root, [...readIndex(root), { id, status: 'en-curso', title: task.title }]);
  return { id, dir };
}

/**
 * Change the status of an indexed task.
 * @param {string} root - repo root
 * @param {string} id - task id
 * @param {string} status - one of STATUSES
 * @returns {boolean} true if updated
 */
function setStatus(root, id, status) {
  const entries = readIndex(root);
  const hit = entries.find((e) => e.id === id);
  if (!hit || !STATUSES.includes(status)) return false;
  hit.status = status;
  writeIndex(root, entries);
  return true;
}

/**
 * Move the 0.1.0 layout (tasks/*.md and a shared plan.md) into task folders.
 * @param {string} root - repo root
 * @returns {{moved: string[], plan: string|null}} moved task ids and where plan.md went
 */
function migrate(root) {
  const dir = tasksDir(root);
  const entries = readIndex(root);
  const moved = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && x !== 'index.md').sort()) {
      const id = f.replace(/\.md$/, '');
      if (fs.existsSync(path.join(dir, id))) continue;
      fs.mkdirSync(path.join(dir, id));
      fs.renameSync(path.join(dir, f), path.join(dir, id, 'task.md'));
      if (!entries.some((e) => e.id === id)) entries.push({ id, status: 'migrada', title: id.replace(/^\d{8}-/, '').replace(/-/g, ' ') });
      moved.push(id);
    }
  }
  let plan = null;
  const oldPlan = path.join(root, '.oap', 'odoo-squad', 'plan.md');
  const last = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => fs.statSync(path.join(dir, x)).isDirectory()).sort().pop() : null;
  if (fs.existsSync(oldPlan) && last) {
    const target = path.join(dir, last, fs.existsSync(path.join(dir, last, 'plan.md')) ? 'plan-anterior.md' : 'plan.md');
    fs.renameSync(oldPlan, target);
    plan = path.relative(root, target);
  }
  writeIndex(root, entries);
  return { moved, plan };
}

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

/** Entry point. */
function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const root = findRoot(opt(args, 'dir') || process.cwd());
  if (!root) {
    console.error('No hay carpeta .oap/: ejecutar primero /odoosh-browser:odoo-project-setup.');
    process.exit(1);
  }
  if (cmd === 'new') {
    const title = opt(args, 'title');
    if (!title) {
      console.error('Uso: tasks.js new --title "..." [--from tarea.md]');
      process.exit(1);
    }
    const from = opt(args, 'from');
    const { id, dir } = newTask(root, { title, body: from ? fs.readFileSync(path.resolve(from), 'utf8') : undefined });
    console.log(JSON.stringify({ id, dir: path.relative(root, dir).split(path.sep).join('/') }));
  } else if (cmd === 'status') {
    if (!setStatus(root, args[0], args[1])) {
      console.error(`Tarea o estado inválido. Estados: ${STATUSES.join(', ')}`);
      process.exit(1);
    }
    console.log(`${args[0]}: ${args[1]}`);
  } else if (cmd === 'list') {
    const entries = readIndex(root);
    console.log(entries.length ? entries.map((e) => `${e.id} · ${e.status} · ${e.title}`).join('\n') : 'Sin tareas.');
  } else if (cmd === 'migrate') {
    const res = migrate(root);
    res.moved.forEach((id) => console.log(`Movida a carpeta: ${id}`));
    if (res.plan) console.log(`plan.md movido a ${res.plan}`);
    if (!res.moved.length && !res.plan) console.log('Nada que migrar.');
  } else {
    console.error('Uso: tasks.js new --title "..." [--from tarea.md] | status <id> <estado> | list | migrate  [--dir ruta]');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { slugify, newTask, setStatus, readIndex, migrate, findRoot, STATUSES };
