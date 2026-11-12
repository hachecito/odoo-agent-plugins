'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findScriptsDir, locate, compareVersions, MIN_VERSION } = require('../scripts/oap');

const OAP = path.join(__dirname, '..', 'scripts', 'oap.js');
const AGENTS = path.join(__dirname, '..', 'agents');

/**
 * Create a fake odoosh-browser install folder.
 * @param {string} base - parent directory
 * @param {string} version - plugin version
 * @returns {string} install path
 */
function fakePlugin(base, version = '0.8.0') {
  const dir = path.join(base, 'odoosh-browser');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'run-state.js'), '');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return dir;
}

test('findScriptsDir: env override, then installed plugin, then sibling, else null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-'));
  const viaEnv = fakePlugin(path.join(tmp, 'env'));
  assert.strictEqual(findScriptsDir({ OAP_ODOOSH_BROWSER: viaEnv }, tmp, tmp), path.join(viaEnv, 'scripts'));

  const home = path.join(tmp, 'home');
  const installed = fakePlugin(path.join(tmp, 'cache'));
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'odoosh-browser@odoo-agent-plugins': [{ installPath: installed }], 'other@x': [{ installPath: '/nope' }] } }));
  assert.strictEqual(findScriptsDir({}, home, tmp), path.join(installed, 'scripts'));

  const sibling = path.join(tmp, 'plugins');
  fakePlugin(sibling);
  assert.strictEqual(findScriptsDir({}, path.join(tmp, 'nohome'), path.join(sibling, 'odoo-squad', 'scripts')), path.join(sibling, 'odoosh-browser', 'scripts'));
  assert.strictEqual(findScriptsDir({}, path.join(tmp, 'nohome'), path.join(tmp, 'a', 'b', 'c')), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('locate: skips odoosh-browser versions older than the minimum', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-'));
  const old = fakePlugin(path.join(tmp, 'old'), '0.4.0');
  assert.deepStrictEqual(locate({ OAP_ODOOSH_BROWSER: old }, tmp, tmp), { dir: null, old: '0.4.0' });
  const sibling = path.join(tmp, 'plugins');
  fakePlugin(sibling, '0.10.0');
  const res = locate({ OAP_ODOOSH_BROWSER: old }, tmp, path.join(sibling, 'odoo-squad', 'scripts'));
  assert.strictEqual(res.dir, path.join(sibling, 'odoosh-browser', 'scripts'));
  assert.ok(compareVersions('0.10.0', MIN_VERSION) > 0 && compareVersions('0.7.9', MIN_VERSION) < 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('oap.js: runs odoosh-browser scripts, rejects anything else', () => {
  // Pin the sibling checkout so the result does not depend on the odoosh-browser installed on this machine.
  const env = { ...process.env, OAP_ODOOSH_BROWSER: path.join(__dirname, '..', '..', 'odoosh-browser') };
  const ok = spawnSync(process.execPath, [OAP, 'notes.js', 'show'], { cwd: os.tmpdir(), encoding: 'utf8', env });
  assert.strictEqual(ok.status, 1); // no config in a temp dir: the script ran and reported it
  assert.ok(/No hay \.oap/.test(ok.stderr), ok.stderr);
  for (const bad of ['../x.js', 'a/b.js', 'notes', 'nonexistent.js']) {
    assert.notStrictEqual(spawnSync(process.execPath, [OAP, bad], { encoding: 'utf8' }).status, 0, bad);
  }
});

test('agents: valid frontmatter, expected models, advisor/writer/planner are read-only', () => {
  const expected = { planner: 'sonnet', implementer: 'sonnet', tester: 'sonnet', fixer: 'sonnet', advisor: 'opus', writer: 'haiku' };
  for (const [role, model] of Object.entries(expected)) {
    const text = fs.readFileSync(path.join(AGENTS, `squad-${role}.md`), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    assert.ok(fm, role);
    assert.ok(new RegExp(`^name: squad-${role}$`, 'm').test(fm[1]), role);
    assert.ok(new RegExp(`^model: ${model}$`, 'm').test(fm[1]), role);
    assert.ok(/^description: .{40,}/m.test(fm[1]), role);
    const tools = /^tools: (.*)$/m.exec(fm[1]);
    if (['planner', 'advisor', 'writer'].includes(role)) {
      assert.ok(tools && !/Write|Edit|Bash/.test(tools[1]), `${role} must be read-only`);
    }
  }
});
