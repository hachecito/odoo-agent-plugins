'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findScriptsDir } = require('../scripts/oap');

const OAP = path.join(__dirname, '..', 'scripts', 'oap.js');
const AGENTS = path.join(__dirname, '..', 'agents');

/**
 * Create a fake odoosh-browser install folder.
 * @param {string} base - parent directory
 * @returns {string} install path
 */
function fakePlugin(base) {
  const dir = path.join(base, 'odoosh-browser');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'run-state.js'), '');
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

test('oap.js: runs odoosh-browser scripts, rejects anything else', () => {
  const ok = spawnSync(process.execPath, [OAP, 'notes.js', 'show'], { cwd: os.tmpdir(), encoding: 'utf8' });
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
