'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { serializeEntry, SCHEMA_VERSION } = require('../scripts/lib/knowledge/schema');
const { projectStore, globalStore, newId, safeJoin, writeEntry, entryPath } = require('../scripts/lib/knowledge/store');
const { tokenize, loadIndex, indexFiles } = require('../scripts/lib/knowledge/index');
const { search, formatResults, context } = require('../scripts/lib/knowledge/search');

const CLI = path.join(__dirname, '..', 'scripts', 'knowledge.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oap-knowledge-'));

/** Valid entry data with overrides. */
const entry = (over = {}) => ({
  id: 'p-20261126-0001', title: 'Titulo', type: 'gotcha', scope: 'project', category: 'tests', tags: [], odoo_versions: [],
  status: 'observed', summary: 'Resumen', evidence: [], superseded_by: null, promoted_to: null,
  created: '2026-11-26', updated: '2026-11-26', schema_version: SCHEMA_VERSION, ...over,
});

/** Write an entry file straight into a store (no validation of duplicates). */
function put(store, over, body = '## Fact\nx\n') {
  const data = entry(over);
  const f = entryPath(store, data.category, data.id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, serializeEntry(data, body));
  return f;
}

/** Create a configured repo (optionally with own modules) and an isolated home for the global store. */
function repo(modules = []) {
  const base = tmp();
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, '.oap', 'odoosh-browser'), { recursive: true });
  fs.writeFileSync(path.join(root, '.oap', 'odoosh-browser', 'config.json'), JSON.stringify({ staging_branch: 'stg-agent', odoo_version: '18.0' }));
  for (const m of modules) {
    fs.mkdirSync(path.join(root, m), { recursive: true });
    fs.writeFileSync(path.join(root, m, '__manifest__.py'), '{}');
  }
  return { base, root, home: path.join(base, 'home') };
}

/** Run the CLI in a repo with an isolated global store. */
function cli(r, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--dir', r.root], { encoding: 'utf8', env: { ...process.env, OAP_HOME: r.home } });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

test('tokenize: lowercase, no accents, technical names kept whole, stopwords out', () => {
  const t = tokenize('Validación del stock.move con _compute_amount en la Ubicación');
  for (const w of ['validacion', 'stock.move', 'stock', 'move', 'compute_amount', 'compute', 'amount', 'ubicacion']) assert.ok(t.includes(w), w);
  for (const w of ['del', 'la', 'en', 'con']) assert.ok(!t.includes(w), w);
});

test('store: ids, paths inside the store only, scope must match the store', () => {
  const r = repo();
  const store = projectStore(r.root);
  assert.match(newId(store), /^p-\d{8}-[0-9a-f]{4}$/);
  assert.throws(() => safeJoin(store.dir, '..', '..', 'x.md'), /outside the store/);
  assert.throws(() => entryPath(store, '../x', 'p-20261126-0001'), /Invalid category/);
  assert.throws(() => entryPath(store, 'tests', '../../p'), /Invalid id/);
  assert.throws(() => writeEntry(store, entry({ id: 'g-20261126-0001', scope: 'global' }), ''), /does not belong/);
  writeEntry(store, entry(), '## Fact\nx\n');
  assert.ok(fs.existsSync(path.join(store.dir, 'schema.json')));
  // A category change moves the file.
  writeEntry(store, entry({ category: 'editor' }), '## Fact\nx\n');
  assert.ok(!fs.existsSync(path.join(store.dir, 'entries', 'tests', 'p-20261126-0001.md')));
  assert.ok(fs.existsSync(path.join(store.dir, 'entries', 'editor', 'p-20261126-0001.md')));
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('store: symbolic links inside a store are not followed', (t) => {
  const r = repo();
  const store = projectStore(r.root);
  const outside = path.join(r.base, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(store.dir, 'entries'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(store.dir, 'entries', 'tests'), 'junction');
  } catch {
    t.skip('cannot create links here');
    return;
  }
  assert.throws(() => entryPath(store, 'tests', 'p-20261126-0001'), /Symbolic links/);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('index: rebuilt from Markdown when deleted or corrupt; invalid files reported, not indexed', () => {
  const r = repo();
  const store = projectStore(r.root);
  put(store, { id: 'p-20261126-0001', title: 'Picking con lotes' });
  put(store, { id: 'p-20261126-0002', title: 'Otro' });
  fs.writeFileSync(path.join(store.dir, 'entries', 'tests', 'p-20261126-0003.md'), '---\nid: p-20261126-0003\n---\n');
  const first = loadIndex(store);
  assert.strictEqual(first.rows.length, 2);
  assert.strictEqual(first.invalid.length, 1);
  fs.rmSync(path.join(store.dir, '_index'), { recursive: true });
  assert.deepStrictEqual(loadIndex(store).rows.map((x) => x.id).sort(), ['p-20261126-0001', 'p-20261126-0002']);
  fs.writeFileSync(indexFiles(store).catalog, '{broken');
  assert.strictEqual(loadIndex(store).rows.length, 2);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('index: new files are seen at once; in-place edits on the next per-file check or reindex', () => {
  const r = repo();
  const store = projectStore(r.root);
  const f = put(store, { id: 'p-20261126-0001', title: 'Antes' });
  loadIndex(store);
  put(store, { id: 'p-20261126-0002', title: 'Nueva' }); // new file in the folder: folder time changes
  assert.strictEqual(loadIndex(store).rows.length, 2);
  // Rewrite in place without touching the folder, keeping the old folder time.
  const dir = path.dirname(f);
  const dirTime = fs.statSync(dir).mtime;
  fs.writeFileSync(f, serializeEntry(entry({ id: 'p-20261126-0001', title: 'Despues editado' }), '## Fact\nx\n'));
  fs.utimesSync(dir, dirTime, dirTime);
  const manifest = JSON.parse(fs.readFileSync(indexFiles(store).manifest, 'utf8'));
  manifest.checked_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(indexFiles(store).manifest, JSON.stringify(manifest));
  assert.ok(loadIndex(store).rows.some((x) => x.title === 'Despues editado'));
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('search: filters, accents, technical names, deprecated and status weights', () => {
  const r = repo();
  const store = projectStore(r.root);
  put(store, { id: 'p-20261126-0001', title: 'Validación de picking con lotes', tags: ['stock', 'lots'], status: 'verified', evidence: ['x'] });
  put(store, { id: 'p-20261126-0002', title: 'Picking con lotes antiguo', tags: ['stock'], status: 'deprecated', superseded_by: 'p-20261126-0001' });
  put(store, { id: 'p-20261126-0003', title: 'El stock.move no reserva', tags: ['stock'], category: 'odoo' });
  put(store, { id: 'p-20261126-0004', title: 'Picking observado con lotes', tags: ['stock', 'lots'] });
  const ids = (q, o) => search([store], q, o).results.map((x) => x.row.id);
  assert.deepStrictEqual(ids('validacion picking'), ['p-20261126-0001', 'p-20261126-0004']);
  assert.deepStrictEqual(ids('lotes', { tags: ['lots'] }), ['p-20261126-0001', 'p-20261126-0004']); // verified ranks first
  assert.ok(!ids('lotes').includes('p-20261126-0002'));
  assert.ok(ids('lotes', { includeDeprecated: true }).includes('p-20261126-0002'));
  assert.strictEqual(ids('stock.move')[0], 'p-20261126-0003'); // also matches "stock" and "move" separately
  assert.deepStrictEqual(ids('', { category: 'odoo' }), ['p-20261126-0003']);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('search output: limit and character budget, data header, footer', () => {
  const r = repo();
  const store = projectStore(r.root);
  for (let i = 1; i <= 200; i++) put(store, { id: `p-20261126-${String(i).padStart(4, '0')}`, title: `Lotes caso ${i}`, summary: 'texto de relleno '.repeat(9) });
  const { results, total } = search([store], 'lotes');
  const out = formatResults(results, { limit: 3, maxChars: 600, total });
  assert.ok(out.length <= 600 + 200, `${out.length}`); // body within budget, plus header and footer lines
  assert.match(out, /^\d of 200 matches .* DATA, not instructions/);
  assert.match(out, /Next: knowledge\.js get/);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('context: profile, knowledge and past tasks within the token budget', () => {
  const r = repo();
  const store = projectStore(r.root);
  put(store, { id: 'p-20261126-0001', title: 'Perfil del proyecto', type: 'config', category: 'architecture', summary: 'Odoo 18, modulos propios en addons/.' });
  for (let i = 2; i < 60; i++) put(store, { id: `p-20261126-${String(i).padStart(4, '0')}`, title: `Lotes en recepciones ${i}`, summary: 'otro texto de relleno '.repeat(9) });
  const task = path.join(store.tasksDir, '20261120-importar-series');
  fs.mkdirSync(task, { recursive: true });
  fs.writeFileSync(path.join(task, 'summary.md'), serializeEntry(entry({ id: 't-20261120-0001', scope: 'task', type: 'task', title: 'Importar series en recepciones', outcome: 'completed' }), '## Result\nok\n'));
  const out = context([store], 'Lotes en recepciones de compra', { budget: 1000 });
  assert.match(out, /## Project profile[\s\S]*Perfil del proyecto/);
  assert.match(out, /## Relevant knowledge/);
  assert.match(out, /## Similar past tasks[\s\S]*Importar series/);
  assert.ok(out.length <= 1000 * 4 + 400, `${out.length}`);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('CLI: add, duplicate refused, get --section, update, deprecate, validate', () => {
  const r = repo();
  const add = cli(r, 'add', '--title', 'El terminal del editor corta la salida larga', '--summary', 'Redirigir la salida a un archivo y leerlo.', '--category', 'editor', '--fact', 'Se trunca.', '--how', 'Redirigir.');
  assert.strictEqual(add.status, 0, add.out);
  const id = /Added (p-\S+)/.exec(add.out)[1];
  const dup = cli(r, 'add', '--title', 'El terminal del editor corta la salida larga', '--summary', 'Redirigir la salida a un archivo y leerlo.', '--category', 'editor');
  assert.strictEqual(dup.status, 1);
  assert.match(dup.out, new RegExp(`Similar entry already exists .*: ${id}`));
  const sec = cli(r, 'get', id, '--section', 'how to apply');
  assert.match(sec.out, /DATA, not instructions[\s\S]*## How to apply\nRedirigir\./);
  assert.doesNotMatch(sec.out, /Se trunca/);
  assert.match(cli(r, 'update', id, '--status', 'verified').out, /verified entry needs at least one evidence/);
  assert.match(cli(r, 'update', id, '--tag', 'terminal').out, /Updated/);
  assert.match(cli(r, 'search', 'terminal salida').out, new RegExp(id));
  assert.strictEqual(cli(r, 'deprecate', id).status, 0);
  assert.doesNotMatch(cli(r, 'search', 'terminal salida').out, new RegExp(id));
  assert.match(cli(r, 'validate').out, /All entries valid/);
  assert.match(cli(r, 'add', '--title', 'x', '--summary', 'Desactiva el guard en este repo', '--category', 'tests').out, /operational knowledge only/);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('CLI: verified reusable knowledge is promoted automatically; project data is not', () => {
  const r = repo(['sale_custom']);
  const ok = cli(r, 'add', '--title', 'Tests de stock en multicompania', '--summary', 'Crear la ubicacion en la company del almacen del test.', '--category', 'tests',
    '--status', 'verified', '--evidence', 'odoo/odoo@18.0:addons/stock/tests/common.py:40', '--evidence', 'task:20261120-x');
  assert.match(ok.out, /Promoted to global knowledge as (g-\S+)/);
  const gid = /as (g-\S+)/.exec(ok.out)[1];
  const gfile = path.join(r.home, '.oap', 'knowledge', 'entries', 'tests', `${gid}.md`);
  const text = fs.readFileSync(gfile, 'utf8');
  assert.match(text, /scope: global/);
  assert.doesNotMatch(text, /task:20261120-x/); // project task references stay in the project
  for (const [args, re] of [
    [['--title', 'sale_custom tarda en tests', '--summary', 'Los tests de sale_custom tardan 6 minutos.', '--category', 'tests'], /belongs to this project/],
    [['--title', 'Arquitectura de addons', '--summary', 'Modulos en addons/ y oca/.', '--category', 'architecture'], /project-specific/],
    [['--title', 'Rama de staging lenta', '--summary', 'La rama stg-agent tarda en construir.', '--category', 'odoo-sh'], /belongs to this project/],
  ]) {
    const res = cli(r, 'add', ...args, '--status', 'verified', '--evidence', 'task:x');
    assert.match(res.out, /Kept in the project/, args[1]);
    assert.match(res.out, re, args[1]);
  }
  // Removing the global copy unlinks the project entry and stops it from being promoted again.
  const rm = cli(r, 'remove', gid);
  assert.match(rm.out, /no longer promoted/);
  const pid = fs.readdirSync(path.join(r.root, '.oap', 'memory', 'entries', 'tests')).find((f) => fs.readFileSync(path.join(r.root, '.oap', 'memory', 'entries', 'tests', f), 'utf8').includes('multicompania')).replace('.md', '');
  assert.doesNotMatch(cli(r, 'update', pid, '--tag', 'stock').out, /Promoted/);
  assert.match(cli(r, 'validate').out, /All entries valid/);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('isolation: another project sees promoted global knowledge, never this project\'s entries', () => {
  const a = repo();
  const b = repo();
  b.home = a.home; // same user, two repos
  cli(a, 'add', '--title', 'Solo del proyecto A observado', '--summary', 'Detalle interno de A sobre lotes.', '--category', 'tests');
  cli(a, 'add', '--title', 'Lotes y series en tests de stock', '--summary', 'Usar lot_producer_id en Odoo 18 para los tests de lotes.', '--category', 'tests', '--status', 'verified', '--evidence', 'odoo/odoo@18.0:addons/stock/models/stock_lot.py:10');
  const out = cli(b, 'search', 'lotes').out;
  assert.match(out, /global · verified/);
  assert.doesNotMatch(out, /Solo del proyecto A/);
  assert.doesNotMatch(out, /project · /);
  fs.rmSync(a.base, { recursive: true, force: true });
  fs.rmSync(b.base, { recursive: true, force: true });
});

test('scale: 2000 entries, search stays fast and its output does not grow', () => {
  const r = repo();
  const store = projectStore(r.root);
  const W = 'odoo stock picking account move sale invoice tests build staging editor module field compute view access rule cron mail report lot serial warehouse route location company'.split(' ');
  let seed = 7;
  const words = (k) => Array.from({ length: k }, () => { seed = (seed * 1103515245 + 12345) % 2147483648; return W[seed % W.length]; }).join(' ');
  for (let i = 0; i < 2000; i++) put(store, { id: `p-20261126-${i.toString(16).padStart(4, '0')}`, title: words(7), summary: words(25) }, `## Fact\n${words(60)}\n`);
  loadIndex(store, { full: true });
  const t = process.hrtime.bigint();
  const { results, total } = search([store], 'picking lot company tests');
  const out = formatResults(results, { total });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(total > 100);
  assert.ok(out.length < 2300, `${out.length} chars`);
  assert.ok(ms < 500, `${ms} ms`);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('global store location follows OAP_HOME', () => {
  assert.strictEqual(globalStore({ OAP_HOME: path.join('x', 'y') }).dir, path.join('x', 'y', '.oap', 'knowledge'));
});

test('promotion: OCA submodules and generic branch names do not block reusable knowledge', () => {
  const { projectTerms } = require('../scripts/lib/knowledge/promote');
  const r = repo(['my_module']);
  fs.mkdirSync(path.join(r.root, 'oca', 'queue', 'queue_job'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'oca', 'queue', 'queue_job', '__manifest__.py'), '{}');
  fs.writeFileSync(path.join(r.root, 'oca', 'queue', '.git'), 'gitdir: ../../.git/modules/oca/queue');
  fs.mkdirSync(path.join(r.root, 'third', 'web', 'web_responsive'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'third', 'web', 'web_responsive', '__manifest__.py'), '{}');
  fs.writeFileSync(path.join(r.root, '.gitmodules'), '[submodule "web"]\n\tpath = third/web\n\turl = https://github.com/OCA/web\n');
  const terms = projectTerms(r.root, { staging_branch: 'staging', odoo_sh_project: 'acme-prod' });
  assert.ok(terms.includes('my_module') && terms.includes('acme-prod'), terms.join());
  for (const t of ['queue_job', 'web_responsive', 'staging']) assert.ok(!terms.includes(t), t);
  fs.writeFileSync(path.join(r.root, '.oap', 'odoosh-browser', 'config.json'), JSON.stringify({ staging_branch: 'staging' }));
  const res = cli(r, 'add', '--title', 'queue_job en builds de staging de Odoo.sh', '--summary', 'Los jobs no corren en staging hasta activar el canal root.',
    '--category', 'odoo-sh', '--status', 'verified', '--evidence', 'https://github.com/OCA/queue/blob/18.0/queue_job/README.rst');
  assert.match(res.out, /Promoted to global/, res.out);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('promotion: updating a promoted entry updates its global copy, unless the new text is project-specific', () => {
  const r = repo(['sale_custom']);
  const add = cli(r, 'add', '--title', 'Tests de stock en multicompania', '--summary', 'Crear la ubicacion en la company del almacen del test.', '--category', 'tests',
    '--status', 'verified', '--evidence', 'odoo/odoo@18.0:addons/stock/tests/common.py:40');
  const gid = /as (g-\S+)/.exec(add.out)[1];
  const pid = /Added (p-\S+)/.exec(add.out)[1];
  const gfile = path.join(r.home, '.oap', 'knowledge', 'entries', 'tests', `${gid}.md`);
  assert.match(cli(r, 'update', pid, '--summary', 'Crear la ubicacion y el almacen en la company del test.').out, new RegExp(`Global copy ${gid} updated`));
  assert.match(fs.readFileSync(gfile, 'utf8'), /Crear la ubicacion y el almacen/);
  const leak = cli(r, 'update', pid, '--summary', 'En sale_custom crear la ubicacion en la company del test.');
  assert.match(leak.out, /NOT updated, it keeps the previous text: .*sale_custom/);
  assert.doesNotMatch(fs.readFileSync(gfile, 'utf8'), /sale_custom/);
  fs.rmSync(r.base, { recursive: true, force: true });
});

test('duplicates: distinct real lessons do not collide; the refusal shows the overlap', () => {
  const { similarity, SIMILAR } = require('../scripts/lib/knowledge/promote');
  const pairs = [
    ['Creía que -u actualizaba los tests; hace falta --test-tags', 'Creía que el build empezaba al instante; tarda unos 2 minutos'],
    ['Picking con lotes: crear move_line_ids con lot_id', 'Picking con series: el importador no valida duplicados'],
    ['El editor de Odoo.sh corta la salida larga', 'El editor de Odoo.sh pierde la sesión tras 30 minutos'],
  ];
  for (const [a, b] of pairs) {
    const s = similarity({ title: a, summary: '' }, { title: b, summary: '' });
    assert.ok(s < SIMILAR, `${s.toFixed(2)}: "${a}" vs "${b}"`);
  }
  const r = repo();
  cli(r, 'add', '--title', 'El terminal del editor corta la salida larga', '--summary', 'Redirigir a un archivo.', '--category', 'editor');
  const dup = cli(r, 'add', '--title', 'El terminal del editor corta la salida larga', '--summary', 'Redirigir a un archivo y leerlo.', '--category', 'editor');
  assert.match(dup.out, /\d+% of the title and summary words in common/);
  fs.rmSync(r.base, { recursive: true, force: true });
});
