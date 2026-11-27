'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalize, loadDeclarations, projectFacts } = require('../scripts/lib/plugins');

const PLUGINS = path.resolve(__dirname, '..', '..');
const KNOWLEDGE = path.join(__dirname, '..', 'scripts', 'knowledge.js');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oap-bound-')));
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

test('declarations: plugins of other marketplaces are ignored; project names of all declarations are joined', () => {
  const base = tmp();
  const own = path.join(base, 'own');
  const foreign = path.join(base, 'foreign');
  fs.mkdirSync(own);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(own, 'memory.json'), JSON.stringify({ source: 'odoosh-browser', project_terms: [{ file: 'c.json', keys: ['staging_branch'] }] }));
  fs.writeFileSync(path.join(foreign, 'memory.json'), JSON.stringify({ source: 'odoosh-browser', global_categories: ['client-data'] }));
  const cfg = path.join(base, 'cfg');
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'odoosh-browser@other-market': [{ installPath: foreign }], 'odoosh-browser@odoo-agent-plugins': [{ installPath: own }],
  } }));
  const decls = loadDeclarations({ CLAUDE_CONFIG_DIR: cfg }, path.join(base, 'nohome'));
  assert.ok(!decls.some((d) => d.global_categories.includes('client-data')), JSON.stringify(decls));
  assert.ok(decls.some((d) => d.project_terms.length), JSON.stringify(decls));
  // Two declarations of the same source: the names of both count.
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'c.json'), JSON.stringify({ staging_branch: 'acme-stg', odoo_sh_project: 'acme' }));
  const facts = projectFacts(root, [
    normalize({ source: 'x', project_terms: [{ file: 'c.json', keys: ['staging_branch'] }] }),
    normalize({ source: 'x', project_terms: [{ file: 'c.json', keys: ['odoo_sh_project'] }] }),
  ]);
  assert.deepStrictEqual(facts.terms.sort(), ['acme', 'acme-stg']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the first write of any kind keeps .oap/ out of git status', () => {
  const base = tmp();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  const r = spawnSync(process.execPath, [KNOWLEDGE, 'session', 'start', '--source', 'odoo-localenv', '--dir', repo], {
    encoding: 'utf8', env: { ...process.env, OAP_HOME: path.join(base, 'home') },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.oap\/$/m);
  assert.strictEqual(git(repo, 'status', '--porcelain').stdout.trim(), '');
  fs.rmSync(base, { recursive: true, force: true });
});

test('run-state close and COMPLETED/FAILED close the memory session (odoosh-browser)', () => {
  const runState = path.join(PLUGINS, 'odoosh-browser', 'scripts', 'run-state.js');
  const { isSessionActive } = require('../scripts/lib/session');
  const base = tmp();
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, '.oap', 'odoosh-browser'), { recursive: true });
  fs.writeFileSync(path.join(root, '.oap', 'odoosh-browser', 'config.json'), JSON.stringify({ staging_branch: 'stg', production_branches: ['main'] }));
  const env = { ...process.env, OAP_HOME: path.join(base, 'home'), OAP_MEMORY: path.join(PLUGINS, 'oap-memory') };
  const k = (...a) => spawnSync(process.execPath, [KNOWLEDGE, ...a, '--dir', root], { encoding: 'utf8', env });
  const rs = (...a) => spawnSync(process.execPath, [runState, ...a, '--dir', root], { encoding: 'utf8', env });
  const { loadSession } = require('../scripts/lib/session');
  // init opens the memory session by itself (no "session start" from the skill)...
  rs('init', '--task', 't');
  assert.strictEqual(isSessionActive(root), true);
  assert.strictEqual(loadSession(root).task, 't');
  // ...and a new init replaces a session left open by an earlier, unfinished task.
  k('add', '--title', 'Leccion de la tarea vieja', '--summary', 'Algo visto en la tarea anterior.', '--category', 'odoo');
  rs('init', '--task', 'nueva');
  assert.deepStrictEqual([loadSession(root).task, loadSession(root).items.length], ['nueva', 0]);
  // The skill's own "session start" right after init still wins (squad names itself).
  k('session', 'start', '--source', 'odoo-squad', '--task', 'nueva');
  assert.strictEqual(loadSession(root).source, 'odoo-squad');
  rs('state', 'PLANNING');
  assert.strictEqual(isSessionActive(root), true);
  rs('close');
  assert.strictEqual(isSessionActive(root), false);
  rs('init', '--task', 't2');
  k('session', 'start', '--source', 'odoosh-browser');
  rs('state', 'FAILED');
  assert.strictEqual(isSessionActive(root), false);
  fs.rmSync(base, { recursive: true, force: true });
});
