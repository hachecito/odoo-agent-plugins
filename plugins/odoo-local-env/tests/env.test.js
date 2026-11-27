'use strict';
// Tests of the pure helpers of odoo-local-env (no Docker needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../scripts/lib/env');

const CLI = path.join(__dirname, '..', 'scripts', 'localenv.js');

/**
 * Build a fake Odoo.sh-like repo: modules at the root, a submodule-like OCA folder and a non-module folder.
 * @returns {string} repo path
 */
function fakeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oaple-'));
  const mod = (rel, req) => {
    fs.mkdirSync(path.join(repo, rel), { recursive: true });
    fs.writeFileSync(path.join(repo, rel, '__manifest__.py'), "{'name': 'x'}");
    if (req) fs.writeFileSync(path.join(repo, rel, 'requirements.txt'), req);
  };
  mod('my_module');
  mod('my_connector', 'phonenumbers\n');
  mod('OCA/l10n-xx/l10n_xx_base');
  fs.writeFileSync(path.join(repo, 'OCA', 'l10n-xx', 'requirements.txt'), '# comment\nzeep\nphonenumbers\n');
  fs.mkdirSync(path.join(repo, 'specs', 'feature'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  return repo;
}

test('findAddonsDirs finds the root and nested addons folders, not module folders or skipped ones', () => {
  const repo = fakeRepo();
  assert.deepStrictEqual(E.findAddonsDirs(repo), ['', 'OCA/l10n-xx']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('collectRequirements merges root, addons and module requirements without duplicates or comments', () => {
  const repo = fakeRepo();
  const reqs = E.collectRequirements(repo, E.findAddonsDirs(repo));
  assert.deepStrictEqual(reqs.trim().split('\n').sort(), ['phonenumbers', 'zeep']);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('slug, normVersion and parseArgs', () => {
  assert.strictEqual(E.slug('Client Mig/19 Task!'), 'client-mig-19-task');
  assert.strictEqual(E.normVersion('19'), '19.0');
  assert.strictEqual(E.normVersion('16.0'), '16.0');
  assert.strictEqual(E.normVersion('master'), null);
  assert.deepStrictEqual(E.parseArgs(['up', '--name', 'a', '--yes', '--port', '8070']), { _: ['up'], name: 'a', yes: true, port: '8070' });
});

test('generated files: read-only code, data in volumes, localhost port, labels, no repo writes', () => {
  const e = {
    name: 'demo-task', version: '19.0', repo: path.join(os.tmpdir(), 'work', 'repo'), addons: ['', 'OCA/l10n-xx'], enterprise: '/ent/19.0', extra: ['/themes'],
    pg: '16', db: 'demo_task', port: 8071, db_password: 'p1', admin_passwd: 'p2', build: true,
  };
  const conf = E.renderConf(e);
  assert.match(conf, /addons_path = \/mnt\/enterprise,\/mnt\/repo,\/mnt\/repo\/OCA\/l10n-xx,\/mnt\/extra0/);
  assert.match(conf, /dbfilter = \^demo_task\$/);
  assert.match(conf, /list_db = False/);
  assert.match(conf, /max_cron_threads = 0/);
  const yml = E.renderCompose(e);
  assert.ok(yml.includes(`"${E.hostPath(e.repo)}:/mnt/repo:ro"`), yml);
  assert.ok(yml.includes(`"${E.hostPath('/ent/19.0')}:/mnt/enterprise:ro"`), yml);
  assert.ok(!yml.includes('\\'), 'no backslashes in compose paths');
  assert.match(yml, /"127.0.0.1:8071:8069"/);
  assert.match(yml, /- db:\/var\/lib\/postgresql\/data/);
  assert.match(yml, /image: pgvector\/pgvector:pg16/);
  assert.match(yml, /- data:\/var\/lib\/odoo/);
  assert.match(yml, /oap.local-env: "demo-task"/);
  assert.match(yml, /build: \./);
  assert.match(E.renderDockerfile(e), /^FROM odoo:19.0/);
  assert.doesNotMatch(E.renderCompose({ ...e, enterprise: null, build: false }), /mnt\/enterprise|build:/);
});

test('baseDir honours OAP_HOME', () => {
  assert.strictEqual(E.baseDir({ OAP_HOME: '/x' }), path.join(path.resolve('/x'), '.oap', 'local-env'));
});

test('CLI: help, keep/release and down refuse without --yes, unknown environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oaple-home-'));
  const env = { ...process.env, OAP_HOME: home };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  assert.match(cli('--help').stdout, /Usage: localenv\.js/);
  assert.match(cli('list').stdout, /No local environments/);
  assert.match(cli('status', '--name', 'nope').stderr, /No environment "nope"/);
  const dir = path.join(home, '.oap', 'local-env', 'envs', 'a1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ name: 'a1', version: '19.0', keep: true, port: 8069, db_password: 's' }));
  assert.match(cli('release', '--name', 'a1').stdout, /released/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')).keep, false);
  const down = cli('down', '--name', 'a1');
  assert.strictEqual(down.status, 1);
  assert.match(down.stderr, /repeat with --yes/);
  assert.ok(fs.existsSync(dir));
  assert.doesNotMatch(cli('status', '--name', 'a1').stdout, /"db_password"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('reset refuses an environment without snapshot (before touching Docker)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oaple-home-'));
  const dir = path.join(home, '.oap', 'local-env', 'envs', 'b1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ name: 'b1', version: '19.0', keep: true, port: 8069, db: 'b1' }));
  const r = spawnSync(process.execPath, [CLI, 'reset', '--name', 'b1'], { encoding: 'utf8', env: { ...process.env, OAP_HOME: home } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /has no snapshot/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('fromOdoosh: only pg_dump and tar run on the build, version mismatch refused, files downloaded', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oaple-home-'));
  const fake = path.join(home, 'fake-ssh.js');
  const log = path.join(home, 'ssh.log');
  // Fake ssh: logs the remote command and answers like the build would.
  fs.writeFileSync(fake, `const fs=require('fs');const cmd=process.argv[process.argv.length-1];fs.appendFileSync(${JSON.stringify(log)},cmd+String.fromCharCode(10));
if(cmd.includes('latest_version'))process.stdout.write(process.env.FAKE_VERSION);
else if(cmd.includes('pg_dump'))process.stdout.write('PGDMP');else if(cmd.includes('tar -cf'))process.stdout.write('TAR');`);
  const run = (version, target = '123@proj-staging-123.dev.odoo.com') => spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(CLI)}).fromOdoosh(${JSON.stringify(target)}, 'c1', '19.0'); console.log('OK')`],
  { encoding: 'utf8', env: { ...process.env, OAP_HOME: home, OAP_LOCALENV_SSH: fake, FAKE_VERSION: version } });
  assert.match(run('19.0', 'bad target; rm -rf /').stderr, /expects the SSH target/);
  const old = run('16.0.1.3');
  assert.strictEqual(old.status, 1);
  assert.match(old.stderr, /runs Odoo 16.0.1.3 but the environment is 19.0/);
  const ok = run('19.0.1.3');
  assert.match(ok.stdout, /OK/, ok.stderr);
  const out = path.join(home, '.oap', 'local-env', 'downloads', 'c1');
  assert.strictEqual(fs.readFileSync(path.join(out, 'dump.dump'), 'utf8'), 'PGDMP');
  assert.strictEqual(fs.readFileSync(path.join(out, 'filestore.tar'), 'utf8'), 'TAR');
  for (const cmd of fs.readFileSync(log, 'utf8').trim().split('\n')) {
    assert.match(cmd, /^DB=\$\(psql -tAc "select current_database\(\)"\); (psql -tAc "select latest_version|pg_dump -Fc|cd "\$HOME\/data\/filestore\/\$DB" && tar -cf - \.)/, cmd);
  }
  fs.rmSync(home, { recursive: true, force: true });
});
