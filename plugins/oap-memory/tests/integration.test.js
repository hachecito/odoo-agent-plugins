'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findRoot, ensureExcluded } = require('../scripts/lib/root');
const { normalize, loadDeclarations, projectFacts, globalCategories } = require('../scripts/lib/plugins');

const PLUGINS = path.resolve(__dirname, '..', '..');
const KNOWLEDGE = path.join(__dirname, '..', 'scripts', 'knowledge.js');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oap-int-')));

/**
 * Run git quietly in a folder.
 * @param {string} dir - folder
 * @param {...string} args - git arguments
 * @returns {object} spawn result
 */
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' });

test('root: nearest project .oap, never the home .oap; else the git superproject from inside a submodule', () => {
  const base = tmp();
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.oap', 'knowledge'), { recursive: true });
  const prev = process.env.OAP_HOME;
  process.env.OAP_HOME = home;
  try {
    // A folder under the home without its own .oap and outside git: the folder itself, not the home.
    const loose = path.join(home, 'work', 'loose');
    fs.mkdirSync(loose, { recursive: true });
    assert.notStrictEqual(findRoot(loose).root, home);
    // Git repo with a submodule: from inside the submodule the root is the superproject.
    const lib = path.join(base, 'lib');
    fs.mkdirSync(lib);
    git(lib, 'init', '-q');
    fs.writeFileSync(path.join(lib, 'README'), 'x');
    git(lib, 'add', '.');
    git(lib, 'commit', '-qm', 'x');
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    const add = git(repo, 'submodule', 'add', '-q', lib, 'oca/lib');
    assert.strictEqual(add.status, 0, add.stderr);
    const inSub = path.join(repo, 'oca', 'lib');
    assert.deepStrictEqual(findRoot(inSub), { root: repo, found: 'git' });
    // Once the project has .oap/ that wins (no git call), also from the submodule.
    fs.mkdirSync(path.join(repo, '.oap'));
    assert.deepStrictEqual(findRoot(inSub), { root: repo, found: 'oap' });
    assert.strictEqual(ensureExcluded(repo), true);
    assert.strictEqual(ensureExcluded(repo), false);
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.oap\/$/m);
  } finally {
    if (prev === undefined) delete process.env.OAP_HOME; else process.env.OAP_HOME = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('declarations: invalid parts dropped; project names and Odoo version read from the files they point to', () => {
  assert.strictEqual(normalize({ source: 'Bad Name' }), null);
  const d = normalize({ source: 'x-env', global_categories: ['docker', 'Bad Cat'], project_terms: [{ file: '../outside.json', keys: ['a'] }, { file: '.oap/x/config.json', keys: ['db_name'] }] });
  assert.deepStrictEqual(d.global_categories, ['docker']);
  assert.deepStrictEqual(d.project_terms, [{ file: '.oap/x/config.json', keys: ['db_name'] }]);
  const root = tmp();
  fs.mkdirSync(path.join(root, '.oap', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.oap', 'x', 'config.json'), JSON.stringify({ db_name: 'acme_db', odoo: '17.0' }));
  const facts = projectFacts(root, [{ ...d, odoo_version: { file: '.oap/x/config.json', key: 'odoo' } }]);
  assert.deepStrictEqual(facts, { terms: ['acme_db'], odoo: '17.0' });
  assert.deepStrictEqual(globalCategories(['odoo'], [d]), ['odoo', 'docker']);
  // The real plugins of this repo declare themselves (sibling folders).
  const sources = loadDeclarations({}, path.join(root, 'no-home')).map((x) => x.source);
  for (const s of ['odoosh-browser', 'odoo-squad']) assert.ok(sources.includes(s), sources.join());
  fs.rmSync(root, { recursive: true, force: true });
});

test('a plugin category is promoted to global only when some plugin declares it', () => {
  const base = tmp();
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, '.oap'), { recursive: true });
  const decl = path.join(base, 'plugin');
  fs.mkdirSync(decl);
  const run = (plugins, ...args) => spawnSync(process.execPath, [KNOWLEDGE, ...args, '--dir', root], {
    encoding: 'utf8', env: { ...process.env, OAP_HOME: path.join(base, 'home'), OAP_MEMORY_PLUGINS: plugins },
  });
  const add = (plugins, title, summary) => run(plugins, 'add', '--title', title, '--summary', summary, '--category', 'local-env',
    '--status', 'verified', '--evidence', 'medido: 40 s frente a 6 min');
  fs.writeFileSync(path.join(decl, 'memory.json'), JSON.stringify({ source: 'odoo-localenv' }));
  const kept = add(decl, 'Volumenes de Docker en WSL', 'Montar el volumen con cached acelera los tests.');
  assert.match(kept.stdout, /Kept in the project.*project-specific/, kept.stderr);
  fs.writeFileSync(path.join(decl, 'memory.json'), JSON.stringify({ source: 'odoo-localenv', global_categories: ['local-env'] }));
  const promoted = add(decl, 'Postgres en contenedor tarda en aceptar conexiones', 'Esperar a pg_isready antes de lanzar Odoo.');
  assert.match(promoted.stdout, /Promoted to global knowledge as g-/, promoted.stderr);
  fs.rmSync(base, { recursive: true, force: true });
});

test('shared files are identical in every plugin that carries a copy', () => {
  const same = (rel, plugins) => {
    const texts = plugins.map((p) => fs.readFileSync(path.join(PLUGINS, p, rel), 'utf8'));
    for (const t of texts) assert.strictEqual(t, texts[0], `${rel} differs between ${plugins.join(', ')}`);
  };
  same(path.join('scripts', 'mem.js'), ['odoosh-browser', 'odoo-squad']);
  same(path.join('scripts', 'lib', 'fsatomic.js'), ['oap-memory', 'odoosh-browser']);
  same(path.join('scripts', 'lib', 'shell.js'), ['oap-memory', 'odoosh-browser']);
});

test('mem.js finds oap-memory next to it, forwards commands and says so when it is missing', () => {
  const mem = path.join(PLUGINS, 'odoosh-browser', 'scripts', 'mem.js');
  // Isolated from a real marketplace install of oap-memory on this machine (it would win over the sibling).
  const noInstall = tmp();
  const where = spawnSync(process.execPath, [mem, '--where'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: noInstall, OAP_MEMORY: '' } });
  assert.strictEqual(path.resolve(where.stdout.trim()), path.join(PLUGINS, 'oap-memory', 'scripts'));
  fs.rmSync(noInstall, { recursive: true, force: true });
  assert.match(spawnSync(process.execPath, [mem, '--help'], { encoding: 'utf8' }).stdout, /Usage: knowledge\.js/);
  // A copy of the launcher in a plugin with no oap-memory next to it and no install: exit 3 with the install command.
  const base = tmp();
  fs.mkdirSync(path.join(base, 'plug', 'scripts'), { recursive: true });
  fs.copyFileSync(mem, path.join(base, 'plug', 'scripts', 'mem.js'));
  const r = spawnSync(process.execPath, [path.join(base, 'plug', 'scripts', 'mem.js'), 'stats'], {
    encoding: 'utf8', env: { ...process.env, HOME: base, USERPROFILE: base, OAP_MEMORY: '' },
  });
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /claude plugin install oap-memory@odoo-agent-plugins/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('no skill, agent or README still points to the old memory scripts of odoosh-browser', () => {
  const stale = /odoosh-browser[\\/]scripts[\\/](knowledge|notes)\.js|oap (knowledge|notes)\b|oap\.js"? (knowledge|notes)\b/;
  const files = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && !['node_modules', 'tests', '.git'].includes(d.name)) walk(p);
      else if (/\.md$/.test(d.name)) files.push(p);
    }
  };
  for (const p of ['odoosh-browser', 'odoo-squad', 'oap-memory']) walk(path.join(PLUGINS, p));
  walk(path.join(PLUGINS, '..', 'docs'));
  files.push(path.join(PLUGINS, '..', 'README.md'));
  const hits = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l])).filter(([, , l]) => stale.test(l));
  assert.deepStrictEqual(hits.map(([f, n]) => `${path.relative(PLUGINS, f)}:${n}`), []);
});

test('mem.js in a marketplace cache finds the newest oap-memory beside it, also with CLAUDE_CONFIG_DIR', () => {
  const { locate } = require(path.join(PLUGINS, 'odoosh-browser', 'scripts', 'mem.js'));
  const base = tmp();
  const cache = path.join(base, 'cache', 'odoo-agent-plugins');
  const fake = (dir, version) => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'knowledge.js'), '');
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  };
  fake(path.join(cache, 'oap-memory', '0.9.0'), '0.9.0');
  fake(path.join(cache, 'oap-memory', '1.2.0'), '1.2.0');
  const here = path.join(cache, 'odoosh-browser', '0.14.0', 'scripts');
  assert.strictEqual(locate('1.0.0', {}, path.join(base, 'nohome'), here).dir, path.join(cache, 'oap-memory', '1.2.0', 'scripts'));
  assert.deepStrictEqual(locate('2.0.0', {}, path.join(base, 'nohome'), here), { dir: null, old: '1.2.0' });
  // installed_plugins.json read from CLAUDE_CONFIG_DIR.
  const cfg = path.join(base, 'cfg');
  fake(path.join(base, 'elsewhere'), '1.0.0');
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'oap-memory@odoo-agent-plugins': [{ installPath: path.join(base, 'elsewhere') }] } }));
  assert.strictEqual(locate('1.0.0', { CLAUDE_CONFIG_DIR: cfg }, path.join(base, 'nohome'), path.join(base, 'x', 'y', 'scripts')).dir, path.join(base, 'elsewhere', 'scripts'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('declarations: found in the marketplace cache layout even without installed_plugins.json', () => {
  const base = tmp();
  const mkt = path.join(base, 'cache', 'odoo-agent-plugins');
  const mem = path.join(mkt, 'oap-memory', '1.0.0');
  fs.mkdirSync(path.join(mem, 'scripts', 'lib'), { recursive: true });
  for (const f of ['plugins.js']) fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'lib', f), path.join(mem, 'scripts', 'lib', f));
  for (const [v, decl] of [['0.13.0', null], ['0.14.0', { source: 'odoosh-browser', project_terms: [{ file: 'c.json', keys: ['k'] }] }]]) {
    fs.mkdirSync(path.join(mkt, 'odoosh-browser', v), { recursive: true });
    if (decl) fs.writeFileSync(path.join(mkt, 'odoosh-browser', v, 'memory.json'), JSON.stringify(decl));
  }
  const { loadDeclarations } = require(path.join(mem, 'scripts', 'lib', 'plugins.js'));
  assert.deepStrictEqual(loadDeclarations({}, path.join(base, 'nohome')).map((d) => d.source), ['odoosh-browser']);
  fs.rmSync(base, { recursive: true, force: true });
});
