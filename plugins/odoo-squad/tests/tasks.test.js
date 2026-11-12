'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slugify, newTask, setStatus, readIndex, migrate } = require('../scripts/tasks');

/**
 * Create a temp repo with an .oap folder.
 * @returns {string} repo root
 */
function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-squad-'));
  fs.mkdirSync(path.join(root, '.oap'));
  return root;
}

test('slugify: accents, symbols and length', () => {
  assert.strictEqual(slugify('Vistas y menús: corrección #2'), 'vistas-y-menus-correccion-2');
  assert.strictEqual(slugify('!!!'), 'tarea');
  assert.ok(slugify('x'.repeat(80)).length <= 40);
});

test('newTask: folder with task, findings and index line; unique ids; status updates', () => {
  const root = tmpRepo();
  const date = new Date('2026-01-02T10:00:00Z');
  const a = newTask(root, { title: 'Campo nuevo', body: '# Tarea\ntexto', date });
  const b = newTask(root, { title: 'Campo nuevo', date });
  assert.strictEqual(a.id, '20260102-campo-nuevo');
  assert.strictEqual(b.id, '20260102-campo-nuevo-2');
  assert.strictEqual(fs.readFileSync(path.join(a.dir, 'task.md'), 'utf8'), '# Tarea\ntexto');
  assert.ok(fs.existsSync(path.join(a.dir, 'hallazgos.md')));
  assert.strictEqual(setStatus(root, a.id, 'completada'), true);
  assert.strictEqual(setStatus(root, a.id, 'hecha'), false);
  assert.strictEqual(setStatus(root, 'no-existe', 'completada'), false);
  assert.deepStrictEqual(readIndex(root).map((e) => [e.id, e.status]), [[a.id, 'completada'], [b.id, 'en-curso']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrate: 0.1.0 flat tasks and shared plan.md move into task folders', () => {
  const root = tmpRepo();
  const dir = path.join(root, '.oap', 'odoo-squad', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '20260101-uno.md'), 'uno');
  fs.writeFileSync(path.join(dir, '20260105-dos.md'), 'dos');
  fs.writeFileSync(path.join(root, '.oap', 'odoo-squad', 'plan.md'), 'plan');
  const res = migrate(root);
  assert.deepStrictEqual(res.moved, ['20260101-uno', '20260105-dos']);
  assert.strictEqual(fs.readFileSync(path.join(dir, '20260105-dos', 'plan.md'), 'utf8'), 'plan');
  assert.strictEqual(fs.readFileSync(path.join(dir, '20260101-uno', 'task.md'), 'utf8'), 'uno');
  assert.deepStrictEqual(readIndex(root).map((e) => e.status), ['migrada', 'migrada']);
  assert.deepStrictEqual(migrate(root), { moved: [], plan: null }); // idempotent
  fs.rmSync(root, { recursive: true, force: true });
});
