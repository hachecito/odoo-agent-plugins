'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { verdict, REQUIRED_EVIDENCE } = require('../scripts/lib/run');
const { classify } = require('../scripts/ssh-check');
const { render } = require('../scripts/report');
const { validateConfig, DEFAULTS } = require('../scripts/lib/config');

const ev = (kind, status) => ({ kind, status, detail: 'x' });

test('verdict: all required evidence passing is COMPLETE', () => {
  const run = { state: 'FINAL_VERIFICATION', evidence: REQUIRED_EVIDENCE.map((k) => ev(k, 'pass')) };
  assert.strictEqual(verdict(run).verdict, 'COMPLETE');
});

test('verdict: missing or skipped evidence is partial', () => {
  const run = { state: 'FINAL_VERIFICATION', evidence: REQUIRED_EVIDENCE.slice(1).map((k) => ev(k, 'pass')) };
  assert.strictEqual(verdict(run).verdict, 'PARTIALLY VERIFIED');
  run.evidence.push(ev('local_checks', 'skipped'));
  assert.strictEqual(verdict(run).verdict, 'PARTIALLY VERIFIED');
});

test('verdict: latest failing evidence wins, later pass overrides', () => {
  const run = { state: 'REMOTE_BUILD', evidence: [...REQUIRED_EVIDENCE.map((k) => ev(k, 'pass')), ev('remote_build', 'fail')] };
  assert.strictEqual(verdict(run).verdict, 'FAILED');
  run.evidence.push(ev('remote_build', 'pass'));
  assert.strictEqual(verdict(run).verdict, 'COMPLETE');
});

test('verdict: BLOCKED state', () => {
  assert.strictEqual(verdict({ state: 'BLOCKED', evidence: [] }).verdict, 'BLOCKED');
});

test('report renders missing evidence', () => {
  const md = render({ task: 't', staging_branch: 's', fix_cycles: 0, state: 'X', history: [], evidence: [ev('commit', 'pass')] });
  assert.match(md, /PARTIALLY VERIFIED/);
  assert.match(md, /\[MISSING\] remote_tests/);
});

test('ssh classify', () => {
  assert.strictEqual(classify(0, 'odoosh-browser-ok\n', '').code, 'OK');
  assert.strictEqual(classify(255, '', 'x@y: Permission denied (publickey).').code, 'PUBLICKEY');
  assert.strictEqual(classify(255, '', 'ssh: connect to host x port 22: Connection timed out').code, 'NETWORK');
  assert.strictEqual(classify(255, '', 'ssh: Could not resolve hostname x').code, 'HOST');
  assert.strictEqual(classify(255, '', 'exec request failed on channel 0').code, 'EXEC_INTERMITTENT');
});

test('throttle: browser calls spaced while waiting for build', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { computeWaitMs, throttleBrowser } = require('../scripts/lib/throttle');
  assert.strictEqual(computeWaitMs(null, 1000, 60), 0);
  assert.strictEqual(computeWaitMs(0, 1000, 60), 0);
  assert.strictEqual(computeWaitMs(10000, 40000, 60), 30000);
  assert.strictEqual(computeWaitMs(10000, 90000, 60), 0);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.oap', 'odoosh-browser'), { recursive: true });
  const loaded = { root, config: { ...DEFAULTS, build_poll_seconds: 60 } };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const setState = (state) => fs.writeFileSync(path.join(root, '.oap', 'odoosh-browser', 'run.json'), JSON.stringify({ state }));

  const nav = 'mcp__claude-in-chrome__navigate';
  setState('IMPLEMENTATION');
  assert.strictEqual(await throttleBrowser(loaded, sleep, nav), 0);
  setState('REMOTE_BUILD');
  await throttleBrowser(loaded, sleep, nav);            // first call: no previous timestamp
  const waited = await throttleBrowser(loaded, sleep, 'mcp__claude-in-chrome__get_page_text'); // immediate second poll waits ~60 s
  assert.ok(waited > 55000 && waited <= 60000, String(waited));
  // Terminal work during the build state is never delayed
  for (const t of ['computer', 'form_input', 'javascript_tool', 'tabs_context_mcp']) {
    assert.strictEqual(await throttleBrowser(loaded, sleep, `mcp__claude-in-chrome__${t}`), 0, t);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('run activity: closed, finished or stale runs are inactive', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { isRunActive } = require('../scripts/lib/run');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.claude'));
  const write = (run) => fs.writeFileSync(path.join(root, '.claude', 'odoosh-browser-run.json'), JSON.stringify(run));
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.strictEqual(isRunActive(root, now), false);
  write({ state: 'IMPLEMENTATION', history: [{ at: '2026-10-26T11:00:00Z' }] });
  assert.strictEqual(isRunActive(root, now), true);
  write({ state: 'BLOCKED', history: [{ at: '2026-10-26T11:00:00Z' }] });
  assert.strictEqual(isRunActive(root, now), true);
  write({ state: 'COMPLETED', history: [{ at: '2026-10-26T11:00:00Z' }] });
  assert.strictEqual(isRunActive(root, now), false);
  write({ state: 'IMPLEMENTATION', closed: true, history: [{ at: '2026-10-26T11:00:00Z' }] });
  assert.strictEqual(isRunActive(root, now), false);
  write({ state: 'IMPLEMENTATION', history: [{ at: '2026-10-24T11:00:00Z' }] });
  assert.strictEqual(isRunActive(root, now), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config validation', () => {
  assert.ok(validateConfig({ ...DEFAULTS }).length > 0);
  assert.deepStrictEqual(validateConfig({ ...DEFAULTS, staging_branch: 'stg' }), []);
  assert.ok(validateConfig({ ...DEFAULTS, staging_branch: 'main' }).length > 0);
  assert.ok(validateConfig({ ...DEFAULTS, staging_branch: 'stg', autonomy: { push_staging: 'yes' } }).length > 0);
  assert.strictEqual(DEFAULTS.autonomy.push_staging, 'confirm');
  assert.strictEqual(DEFAULTS.autonomy.yolo, false);
  assert.ok(validateConfig({ ...DEFAULTS, staging_branch: 'stg', autonomy: { push_staging: 'auto', yolo: 'si' } }).length > 0);
});

test('run-state: COMPLETED only from FINAL_VERIFICATION', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'scripts', 'run-state.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.oap', 'odoosh-browser'), { recursive: true });
  fs.writeFileSync(path.join(root, '.oap', 'odoosh-browser', 'config.json'), JSON.stringify({ staging_branch: 'stg', production_branches: ['main'] }));
  const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--dir', root], { encoding: 'utf8' });
  run('init', '--task', 't');
  for (const k of REQUIRED_EVIDENCE) run('evidence', '--kind', k, '--status', 'pass', '--detail', 'x');
  run('state', 'REMOTE_TESTING');
  assert.notStrictEqual(run('state', 'COMPLETED').status, 0);
  run('state', 'FINAL_VERIFICATION');
  assert.strictEqual(run('state', 'COMPLETED').status, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy .claude files: still loaded and protected, migrate moves them to .oap and excludes it', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { loadConfig, migrateLegacy } = require('../scripts/lib/config');
  const { spawnSync } = require('child_process');
  const { loadNotes } = require('../../oap-memory/scripts/lib/notes');
  const { evaluate } = require('../scripts/lib/policy');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '# local\n.claude/odoo-agent.json');
  fs.writeFileSync(path.join(root, '.claude', 'odoo-agent.json'), JSON.stringify({ staging_branch: 'stg', production_branches: ['main'] }));
  fs.writeFileSync(path.join(root, '.claude', 'odoosh-browser-run.json'), JSON.stringify({ state: 'COMPLETED' }));
  fs.writeFileSync(path.join(root, '.claude', 'odoo-agent-notes.json'), JSON.stringify({ notes: [{ at: '2026-01-02', section: 'tests', text: 'Tests de x tardan 6 min', source: 'old' }] }));

  const legacy = loadConfig(root);
  assert.strictEqual(legacy.legacy, true);
  assert.strictEqual(legacy.root, root);
  const d = { loadConfig: () => legacy, branchOf: () => 'stg', runActive: () => true };
  assert.strictEqual(evaluate({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: root }, d).decision, 'deny');
  assert.strictEqual(evaluate({ tool_name: 'Edit', tool_input: { file_path: path.join(root, '.claude', 'odoo-agent.json') } }, d).decision, 'ask');
  assert.strictEqual(evaluate({ tool_name: 'Bash', tool_input: { command: 'node C:/x/scripts/config.js migrate' } }, d).decision, 'ask');

  const res = migrateLegacy(root);
  assert.strictEqual(res.moved.length, 2);
  // The old JSON notes are converted by oap-memory (config.js migrate runs this through mem.js).
  assert.ok(fs.existsSync(path.join(root, '.claude', 'odoo-agent-notes.json')));
  const conv = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'mem.js'), 'notes', 'migrate-legacy', '--dir', root], { encoding: 'utf8' });
  assert.match(conv.stdout, /Legacy notes converted: 1/, conv.stderr);
  assert.ok(fs.existsSync(path.join(root, '.oap', 'odoosh-browser', 'config.json')));
  assert.ok(fs.existsSync(path.join(root, '.oap', 'odoosh-browser', 'run.json')));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'odoo-agent-notes.json')));
  const migrated = loadConfig(root);
  assert.strictEqual(migrated.legacy, false);
  assert.strictEqual(migrated.root, root);
  const [note] = loadNotes(root).notes;
  assert.deepStrictEqual([note.tag, note.text, note.at], ['tests', 'Tests de x tardan 6 min', '2026-01-02']);
  assert.ok(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.oap/'));
  assert.strictEqual(migrateLegacy(root).excluded.length, 0); // idempotent
  fs.rmSync(root, { recursive: true, force: true });
});

test('run-state: --help never acts and close is idempotent', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'scripts', 'run-state.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.oap', 'odoosh-browser'), { recursive: true });
  fs.writeFileSync(path.join(root, '.oap', 'odoosh-browser', 'config.json'), JSON.stringify({ staging_branch: 'stg', production_branches: ['main'] }));
  const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--dir', root], { encoding: 'utf8' });
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.oap', 'odoosh-browser', 'run.json'), 'utf8'));
  run('init', '--task', 't');
  assert.ok(run('close', '--help').stdout.includes('Usage:'));
  assert.ok(!read().closed);
  run('close');
  run('close');
  assert.strictEqual(read().history.filter((h) => /closed/.test(h.note || '')).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hotpatch: patch against the build commit reproduces local files on a clean checkout', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { prepare } = require('../scripts/hotpatch');
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-hotpatch-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'mod', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mod', 'a.py'), 'x = 1\n');
  fs.writeFileSync(path.join(root, 'mod', 'old.py'), 'gone = True\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD').stdout.trim();
  // An unpushed local commit plus uncommitted, new and deleted files all belong to the patch.
  fs.writeFileSync(path.join(root, 'mod', 'a.py'), 'x = 2\n');
  git(root, 'commit', '-qam', 'local');
  fs.appendFileSync(path.join(root, 'mod', 'a.py'), 'y = 3\n');
  git(root, 'config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(root, 'mod', 'tests', 'test_a.py'), 'def test():\r\n    assert True\r\n');
  fs.rmSync(path.join(root, 'mod', 'old.py'));
  const m = prepare({ root, base });
  assert.deepStrictEqual(m.files.map((f) => f.status + ' ' + f.path).sort(), ['D mod/old.py', 'M mod/a.py', 'A mod/tests/test_a.py'].sort());
  assert.strictEqual(git(root, 'status', '--porcelain', '--', 'mod/tests').stdout.trim(), '?? mod/tests/', 'intent-to-add entry removed');
  const only = prepare({ root, base, only: ['mod/tests'] });
  assert.deepStrictEqual(only.files.map((f) => f.path), ['mod/tests/test_a.py']);
  // Fresh checkout of the base, as on the build: the full patch applies and hashes match.
  const m2 = prepare({ root, base });
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-build-'));
  git(build, 'clone', '-q', root, '.');
  git(build, 'checkout', '-q', base);
  const b64 = fs.readFileSync(path.join(m2.dir, 'patch.b64'), 'utf8');
  fs.writeFileSync(path.join(build, 'p.patch'), Buffer.from(b64, 'base64'));
  const applied = git(build, 'apply', 'p.patch');
  assert.strictEqual(applied.status, 0, applied.stderr);
  for (const f of m2.files) {
    if (f.status === 'D') assert.ok(!fs.existsSync(path.join(build, f.path)));
    else assert.strictEqual(git(build, 'hash-object', f.path).stdout.trim(), f.hash);
  }
  assert.strictEqual(git(build, 'apply', '-R', 'p.patch').status, 0);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(build, { recursive: true, force: true });
});

test('hotpatch: unknown base and --help do nothing', () => {
  const path = require('path');
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'scripts', 'hotpatch.js');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.ok(help.stdout.includes('Usage:'));
  const bad = spawnSync(process.execPath, [cli, 'prepare', '--base', 'deadbeefdeadbeef', '--dir', __dirname], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /Commit \S+ not found locally/);
});

test('hotpatch: untracked files are flagged and the apply line uses forward slashes', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { prepare, instructions } = require('../scripts/hotpatch');
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-hotpatch-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.py'), 'x = 1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(root, 'a.py'), 'x = 2\n');
  fs.writeFileSync(path.join(root, 'scratch.txt'), 'local only\n');
  const m = prepare({ root, base: 'HEAD' });
  assert.deepStrictEqual(m.files.map((f) => [f.path, f.untracked]), [['a.py', false], ['scratch.txt', true]]);
  const text = instructions(m);
  assert.match(text, /New files not tracked[^\n]*\n {2}A scratch\.txt/);
  assert.ok(!/< "[^"]*\\/.test(text), 'no backslashes in the redirected path');
  fs.rmSync(root, { recursive: true, force: true });
});

test('diag: script is checked, gets an explicit rollback and one-line commands', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { prepare } = require('../scripts/diag');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-diag-'));
  const ok = path.join(root, 'ok.py');
  fs.writeFileSync(ok, "print(env['res.partner'].search_count([]))\r\n");
  const r = prepare({ root, file: ok });
  const decoded = Buffer.from(r.b64, 'base64').toString('utf8');
  assert.ok(decoded.includes(`exec(compile(${JSON.stringify("print(env['res.partner'].search_count([]))\n")}`));
  assert.ok(decoded.includes('traceback.print_exc(file=sys.stdout)') && decoded.trimEnd().endsWith('env.cr.rollback()'));
  assert.ok(!r.editor.includes('\n') && r.editor.includes(r.b64));
  assert.ok(r.ssh.includes('StrictHostKeyChecking=accept-new') && r.ssh.startsWith('ssh '));
  assert.ok(fs.existsSync(path.join(root, '.oap', 'odoosh-browser', 'diag', 'script.b64')));
  const bad = path.join(root, 'bad.py');
  fs.writeFileSync(bad, 'env.cr.commit()\n');
  assert.throws(() => prepare({ root, file: bad }), /commit/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config.js migrate and validate reach oap-memory through mem.js (old notes converted, old memory warned)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'scripts', 'config.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'odoo-agent.json'), JSON.stringify({ staging_branch: 'stg', production_branches: ['main'] }));
  fs.writeFileSync(path.join(root, '.claude', 'odoo-agent-notes.json'), JSON.stringify({ notes: [{ at: '2026-01-02', section: 'tests', text: 'Tests de x tardan 6 min' }] }));
  const mig = spawnSync(process.execPath, [cli, 'migrate', '--dir', root], { encoding: 'utf8' });
  assert.match(mig.stdout, /Notes converted to \.oap\/memory\.md: 1/, mig.stderr);
  const val = spawnSync(process.execPath, [cli, 'validate', '--dir', root], { encoding: 'utf8' });
  assert.strictEqual(val.status, 0);
  assert.match(val.stdout, /project memory in the old format/);
  fs.rmSync(root, { recursive: true, force: true });
});
