#!/usr/bin/env node
'use strict';
// CLI of odoo-local-env: local Odoo environments on Docker (Docker Desktop on Windows/macOS, Docker Engine on Linux).
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./lib/env');

const USAGE = `Usage: localenv.js <command> [options]
  doctor                                   check Docker is running
  enterprise --version 19.0 [--path dir]   clone odoo/enterprise once per version (or register an existing folder)
  addons --repo dir                        show the addons folders found in a repo
  up --name n --repo dir --version 19.0 [--backup file.zip|.dump|.sql] [--modules a,b] [--port 8069]
     [--enterprise dir|none] [--extra-addons d1,d2] [--pip pkg1,pkg2] [--pg 16] [--no-neutralize] [--no-snapshot]
  up ... --from-odoosh <build>@<host>      take database and filestore from an Odoo.sh build over SSH (instead of --backup)
  snapshot --name n | reset --name n       save the current database as the reset point / go back to it (taken after a restore)
  list | status --name n | start --name n | stop --name n | logs --name n [--tail 200]
  restart --name n                         restart Odoo (reload Python code changes)
  rebuild --name n [--repo dir] [--pip p] re-detect addons and requirements (or point to another repo folder), keep the data
  update --name n --modules a,b            upgrade modules (-u) and restart
  install --name n --modules a,b           install modules (-i) and restart
  test --name n --modules a,b [--tags t]   run the tests of the modules
  keep --name n | release --name n         keep the environment until released / allow removing it
  down --name n [--yes]                    delete the environment (containers, database, filestore)
  clean [--version 16.0] [--yes]           list (or delete with --yes) released environments, images and plugin Enterprise`;

const BASE = E.baseDir();
const ENVS = path.join(BASE, 'envs');
const ENT = path.join(BASE, 'enterprise');
const CONFIG = path.join(BASE, 'config.json');

/**
 * Print an error and exit.
 * @param {string} msg - message
 * @param {number} [code] - exit code
 */
function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/**
 * Run a command, streaming its output, and return its exit status.
 * @param {string} cmd - executable
 * @param {string[]} args - arguments
 * @param {object} [opts] - spawn options
 * @returns {number} exit status
 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  return r.status;
}

/**
 * Run a command and capture stdout.
 * @param {string} cmd - executable
 * @param {string[]} args - arguments
 * @returns {{status: number, out: string, err: string}} result
 */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.error ? -1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error || '').trim() };
}

/**
 * Read JSON or return a fallback.
 * @param {string} file - path
 * @param {*} fallback - value when missing
 * @returns {*} parsed content
 */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON, creating folders.
 * @param {string} file - path
 * @param {*} data - content
 */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Exit with code 2 and a clear message when the Docker engine does not answer. */
function requireDocker() {
  const r = capture('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (r.status !== 0) {
    die('Docker is not running (or not installed). Ask the user to start Docker Desktop (Windows/macOS) or the docker service (Linux), then retry. Do not start it yourself.', 2);
  }
  return r.out;
}

/**
 * Folder of an environment.
 * @param {string} name - environment name
 * @returns {string} folder
 */
function envDir(name) {
  return path.join(ENVS, E.slug(name));
}

/**
 * Load an environment record or exit.
 * @param {string} name - environment name
 * @returns {object} record
 */
function loadEnv(name) {
  if (!name || name === true) die('Missing --name.');
  const e = readJson(path.join(envDir(name), 'env.json'), null);
  if (!e) die(`No environment "${E.slug(name)}". Use "list".`);
  return e;
}

/**
 * Save an environment record.
 * @param {object} e - record
 */
function saveEnv(e) {
  writeJson(path.join(envDir(e.name), 'env.json'), e);
}

/**
 * All environment records.
 * @returns {object[]} records
 */
function allEnvs() {
  let names = [];
  try {
    names = fs.readdirSync(ENVS);
  } catch {
    return [];
  }
  return names.map((n) => readJson(path.join(ENVS, n, 'env.json'), null)).filter(Boolean);
}

/**
 * Run docker compose for an environment.
 * @param {object} e - record
 * @param {string[]} args - compose arguments
 * @returns {number} exit status
 */
function compose(e, args) {
  return run('docker', ['compose', '--project-directory', envDir(e.name), '-f', path.join(envDir(e.name), 'compose.yaml'), ...args]);
}

/**
 * Check a TCP port on 127.0.0.1 is free.
 * @param {number} port - port
 * @returns {Promise<boolean>} free
 */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/**
 * First free port from 8069 not taken by another environment.
 * @returns {Promise<number>} port
 */
async function pickPort() {
  const used = new Set(allEnvs().map((e) => e.port));
  for (let p = 8069; p < 8200; p++) if (!used.has(p) && (await portFree(p))) return p;
  return die('No free port between 8069 and 8199.');
}

/**
 * Enterprise folder for a version: registered path, plugin clone, or null.
 * @param {string} version - Odoo version
 * @returns {string|null} folder
 */
function enterpriseFor(version) {
  const reg = (readJson(CONFIG, {}).enterprise || {})[version];
  if (reg && fs.existsSync(reg)) return reg;
  const own = path.join(ENT, version);
  return fs.existsSync(path.join(own, 'web_enterprise')) ? own : null;
}

/**
 * Clone odoo/enterprise for a version with the user's own GitHub access, or register an existing folder.
 * @param {object} o - options
 */
function enterprise(o) {
  const version = E.normVersion(o.version);
  if (!version) die('Usage: enterprise --version 19.0 [--path dir]');
  if (o.path && o.path !== true) {
    if (!fs.existsSync(path.join(o.path, 'web_enterprise'))) die(`${o.path} does not look like an Enterprise checkout (no web_enterprise).`);
    const cfg = readJson(CONFIG, {});
    cfg.enterprise = { ...(cfg.enterprise || {}), [version]: path.resolve(o.path) };
    writeJson(CONFIG, cfg);
    console.log(`Enterprise ${version} registered: ${path.resolve(o.path)} (never deleted by clean).`);
    return;
  }
  const found = enterpriseFor(version);
  if (found) {
    console.log(`Enterprise ${version}: ${found}`);
    return;
  }
  const url = 'https://github.com/odoo/enterprise.git';
  if (capture('git', ['ls-remote', '--heads', url, version]).status !== 0) {
    die(`No access to ${url} with the user's GitHub credentials. The user needs Odoo partner access, or can pass an existing folder with --path.`);
  }
  fs.mkdirSync(ENT, { recursive: true });
  console.log(`>> cloning Enterprise ${version} (shallow) into ${path.join(ENT, version)}`);
  if (run('git', ['clone', '--depth', '1', '--branch', version, url, path.join(ENT, version)]) !== 0) die('git clone failed.');
}

/**
 * Wait until Odoo answers on the port.
 * @param {number} port - port
 * @param {number} [seconds] - timeout
 * @returns {Promise<boolean|string>} true when ready, 'error' when Odoo answers with server errors
 */
async function waitHttp(port, seconds = 180) {
  let errors = 0;
  for (let i = 0; i < seconds / 3; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/web/login`, { redirect: 'manual' });
      if (r.status < 500) return true;
      // Odoo answers but the registry fails to load: no point waiting the full timeout.
      if (++errors >= 5) return 'error';
    } catch {
      // Not up yet.
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

/**
 * Run a one-shot command in the odoo service (no ports, removed afterwards).
 * @param {object} e - record
 * @param {string[]} args - command
 * @param {string[]} [extra] - extra "docker compose run" options
 * @returns {number} exit status
 */
function odooRun(e, args, extra = []) {
  return compose(e, ['run', '--rm', '--no-deps', ...extra, 'odoo', ...args]);
}

/**
 * Read manifest.json of an Odoo backup zip with the Python of the Odoo image (same on Windows and Linux).
 * @param {string} zip - backup path
 * @param {string} version - Odoo version (image tag)
 * @returns {object} manifest, or {} when absent
 */
function zipManifest(zip, version) {
  const py = 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(z.read("manifest.json").decode() if "manifest.json" in z.namelist() else "{}")';
  const r = capture('docker', ['run', '--rm', '-v', `${E.hostPath(path.dirname(zip))}:/backup:ro`, '--entrypoint', 'python3',
    `odoo:${version}`, '-c', py, `/backup/${path.basename(zip)}`]);
  try {
    return JSON.parse(r.out || '{}');
  } catch {
    return {};
  }
}

/**
 * Create and start an environment, restoring a backup or creating an empty database.
 * @param {object} o - options
 */
async function up(o) {
  requireDocker();
  const name = E.slug(o.name);
  const version = E.normVersion(o.version);
  if (!name || !version || !o.repo || o.repo === true) die('Usage: up --name n --repo dir --version 19.0 [--backup file]');
  if (fs.existsSync(path.join(envDir(name), 'env.json'))) die(`Environment "${name}" already exists: use "start", or "down" first.`);
  const repo = path.resolve(o.repo);
  if (!fs.existsSync(repo)) die(`Repo not found: ${repo}`);
  const addons = E.findAddonsDirs(repo);
  if (!addons.length) die(`No Odoo modules found in ${repo} (are the submodules checked out? git submodule update --init).`);
  let ent = null;
  if (o.enterprise && o.enterprise !== 'none' && o.enterprise !== true) ent = path.resolve(o.enterprise);
  else if (o.enterprise !== 'none') {
    ent = enterpriseFor(version);
    if (!ent) die(`No Enterprise ${version} yet: run "enterprise --version ${version}" first, or pass --enterprise none for Community.`);
  }
  let backup = o.backup && o.backup !== true ? path.resolve(o.backup) : null;
  let filestoreTar = null;
  if (o['from-odoosh'] && o['from-odoosh'] !== true) {
    if (backup) die('Use --backup or --from-odoosh, not both.');
    ({ dump: backup, filestore: filestoreTar } = fromOdoosh(String(o['from-odoosh']), name, version));
  }
  if (backup && !fs.existsSync(backup)) die(`Backup not found: ${backup}`);
  let pg = o.pg && o.pg !== true ? String(o.pg) : E.DEFAULT_PG;
  if (!o.pg && backup && backup.endsWith('.zip')) {
    const manifest = zipManifest(backup, version);
    if (manifest.version && E.normVersion(String(manifest.version).split('.')[0]) !== version) {
      die(`The backup is Odoo ${manifest.version} but the environment is ${version}. Use the matching --version.`);
    }
    const major = String(manifest.pg_version || '').split('.')[0];
    if (/^\d+$/.test(major) && Number(major) > Number(pg)) pg = major;
  }
  const e = {
    name, version, repo, addons, enterprise: ent, pg,
    extra: o['extra-addons'] && o['extra-addons'] !== true ? String(o['extra-addons']).split(',').map((p) => path.resolve(p.trim())) : [],
    db: name.replace(/-/g, '_'), port: o.port ? Number(o.port) : await pickPort(),
    db_password: E.secret(), admin_passwd: E.secret(),
    backup, keep: true, created_at: new Date().toISOString(), build: false,
    pip: o.pip && o.pip !== true ? String(o.pip).split(',').map((p) => p.trim()).filter(Boolean) : [],
  };
  const dir = envDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const reqs = E.collectRequirements(repo, addons, e.pip);
  if (reqs) {
    e.build = true;
    fs.writeFileSync(path.join(dir, 'requirements.txt'), reqs);
    fs.writeFileSync(path.join(dir, 'Dockerfile'), E.renderDockerfile(e));
  }
  fs.writeFileSync(path.join(dir, 'odoo.conf'), E.renderConf(e));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), E.renderCompose(e));
  saveEnv(e);
  console.log(`>> environment ${name}: Odoo ${version}, Postgres ${pg}, port ${e.port}`);
  console.log(`>> addons: ${['enterprise'].filter(() => ent).concat(addons.map((a) => a || '(repo root)')).join(', ')}`);
  if (e.build && compose(e, ['build', 'odoo']) !== 0) die('Image build failed (see the pip output above).');
  if (compose(e, ['up', '-d', '--wait', 'db']) !== 0) die('Postgres did not start.');
  const pgEnv = ['-e', 'PGHOST=db', '-e', 'PGUSER=odoo', '-e', `PGPASSWORD=${e.db_password}`];
  if (backup) {
    const script = path.join(__dirname, 'lib', 'restore.py');
    const mounts = ['-v', `${E.hostPath(path.dirname(backup))}:/backup:ro`, '-v', `${E.hostPath(script)}:/oap/restore.py:ro`];
    const tarArgs = filestoreTar ? ['--filestore-tar', `/backup/${path.basename(filestoreTar)}`] : [];
    const status = odooRun(e, ['python3', '/oap/restore.py', '--src', `/backup/${path.basename(backup)}`, '--db', e.db, '--filestore', '/var/lib/odoo/filestore', ...tarArgs], [...pgEnv, ...mounts]);
    if (status !== 0) die(`Restore failed. The environment is left as is: inspect it, or "down --name ${name} --yes" and retry.`);
    if (!o['no-neutralize']) neutralize(e);
    if (!o['no-snapshot']) snapshot(e);
  } else {
    const mods = ['base', ...(o.modules && o.modules !== true ? String(o.modules).split(',') : [])].join(',');
    const demo = Number(version.split('.')[0]) < 19 ? ['--without-demo=all'] : [];
    if (odooRun(e, ['odoo', '-d', e.db, '-i', mods, ...demo, '--stop-after-init']) !== 0) die('Creating the empty database failed (see the log above).');
  }
  if (backup && o.modules && o.modules !== true) {
    if (odooRun(e, ['odoo', '-d', e.db, '-u', String(o.modules), '--stop-after-init']) !== 0) die('Module update failed (see the log above).');
  }
  await startOdoo(e);
}

/**
 * Shell command run in the odoo service with Postgres access (data volume mounted).
 * @param {object} e - record
 * @param {string} script - sh script
 * @returns {number} exit status
 */
function dbShell(e, script) {
  return odooRun(e, ['sh', '-ec', script], ['-e', 'PGHOST=db', '-e', 'PGUSER=odoo', '-e', `PGPASSWORD=${e.db_password}`]);
}

/**
 * Save the current database and filestore as the environment's snapshot (template copy), replacing the previous one.
 * @param {object} e - record
 */
function snapshot(e) {
  const fsDir = '/var/lib/odoo/filestore';
  const snap = `${e.db}_snap`;
  console.log(`>> snapshot: ${e.db} -> ${snap} (reset restores it in seconds; it takes as much disk as the database)`);
  compose(e, ['stop', 'odoo']);
  const ok = dbShell(e, `dropdb --if-exists ${snap}; createdb -T ${e.db} ${snap}; rm -rf ${fsDir}/${snap}; if [ -d ${fsDir}/${e.db} ]; then cp -a ${fsDir}/${e.db} ${fsDir}/${snap}; fi`);
  if (ok !== 0) die('Snapshot failed (see above).');
  e.snapshot_at = new Date().toISOString();
  saveEnv(e);
}

/**
 * Put the database and filestore back to the snapshot.
 * @param {object} e - record
 */
async function reset(e) {
  if (!e.snapshot_at) die(`${e.name} has no snapshot: take one with "snapshot --name ${e.name}" first.`);
  const fsDir = '/var/lib/odoo/filestore';
  const snap = `${e.db}_snap`;
  requireDocker();
  console.log(`>> reset ${e.db} to the snapshot of ${e.snapshot_at}`);
  compose(e, ['stop', 'odoo']);
  const ok = dbShell(e, `dropdb --if-exists ${e.db}; createdb -T ${snap} ${e.db}; rm -rf ${fsDir}/${e.db}; if [ -d ${fsDir}/${snap} ]; then cp -a ${fsDir}/${snap} ${fsDir}/${e.db}; fi`);
  if (ok !== 0) die('Reset failed (see above).');
  await startOdoo(e);
}

/**
 * Download the database (pg_dump custom format) and filestore of an Odoo.sh build over SSH into
 * ~/.oap/local-env/downloads/<name>/. Read-only on the build: only psql queries, pg_dump and tar run there.
 * @param {string} target - ssh target as shown by Odoo.sh (e.g. 1234567@project-branch-1234567.dev.odoo.com)
 * @param {string} name - environment name
 * @param {string} version - expected Odoo version
 * @returns {{dump: string, filestore: string}} downloaded files
 */
function fromOdoosh(target, name, version) {
  if (!/^[\w.-]+@[\w.-]+$/.test(target)) die('--from-odoosh expects the SSH target of the build: <build id>@<build host>.');
  // OAP_LOCALENV_SSH replaces ssh in tests (a .js file runs with node).
  const fake = process.env.OAP_LOCALENV_SSH;
  const ssh = fake ? (fake.endsWith('.js') ? process.execPath : fake) : 'ssh';
  const sshArgs = (cmd) => [...(fake && fake.endsWith('.js') ? [fake] : []), '-o', 'BatchMode=yes', target, cmd];
  const dbq = 'DB=$(psql -tAc "select current_database()")';
  const v = capture(ssh, sshArgs(`${dbq}; psql -tAc "select latest_version from ir_module_module where name='base'"`));
  if (v.status !== 0) die(`SSH to ${target} failed: ${v.err || v.out}. Check the user's SSH key is registered in Odoo.sh.`);
  const remote = E.normVersion(v.out.split('.')[0]);
  if (remote !== version) die(`The build runs Odoo ${v.out} but the environment is ${version}. Bring a build of the same version (or a migrated backup with --backup).`);
  const out = path.join(BASE, 'downloads', name);
  fs.mkdirSync(out, { recursive: true });
  const fetchTo = (file, cmd, label) => {
    console.log(`>> downloading ${label} from ${target}`);
    const fd = fs.openSync(path.join(out, file), 'w');
    const r = spawnSync(ssh, sshArgs(cmd), { stdio: ['ignore', fd, 'inherit'] });
    fs.closeSync(fd);
    if (r.error || r.status !== 0) die(`Download of ${label} failed (exit ${r.status}).`);
    return path.join(out, file);
  };
  const dump = fetchTo('dump.dump', `${dbq}; pg_dump -Fc --no-owner --no-privileges "$DB"`, 'the database (pg_dump)');
  const filestore = fetchTo('filestore.tar', `${dbq}; cd "$HOME/data/filestore/$DB" && tar -cf - .`, 'the filestore');
  return { dump, filestore };
}

/**
 * Neutralize the database (odoo neutralize from 16; SQL fallback for older versions).
 * @param {object} e - record
 */
function neutralize(e) {
  console.log('>> neutralizing (no outgoing mail, crons off)');
  if (Number(e.version.split('.')[0]) >= 16) {
    if (odooRun(e, ['odoo', 'neutralize', '-d', e.db]) !== 0) die('Neutralize failed: do not start this database.');
    return;
  }
  const sql = 'UPDATE ir_cron SET active = false; UPDATE ir_mail_server SET active = false; UPDATE fetchmail_server SET active = false;';
  compose(e, ['exec', '-T', 'db', 'psql', '-U', 'odoo', '-d', e.db, '-c', sql]);
}

/**
 * Start the Odoo service and wait for HTTP.
 * @param {object} e - record
 */
async function startOdoo(e) {
  if (compose(e, ['up', '-d']) !== 0) die('docker compose up failed.');
  e.last_used = new Date().toISOString();
  saveEnv(e);
  const ok = await waitHttp(e.port);
  if (ok === true) console.log(`>> ready: http://localhost:${e.port}  (database ${e.db})`);
  else if (ok === 'error') console.log(`>> Odoo answers with server errors (HTTP 500): look for ERROR/CRITICAL in "localenv.js logs --name ${e.name}"`);
  else console.log(`>> Odoo did not answer yet: localenv.js logs --name ${e.name}`);
}

/**
 * Run odoo with -u/-i on stopped server, then restart it.
 * @param {object} e - record
 * @param {string} flag - -u or -i
 * @param {string} modules - comma separated modules
 */
async function updateModules(e, flag, modules) {
  if (!modules || modules === true) die('Missing --modules a,b');
  requireDocker();
  compose(e, ['stop', 'odoo']);
  const status = odooRun(e, ['odoo', '-d', e.db, flag, String(modules), '--stop-after-init']);
  await startOdoo(e);
  if (status !== 0) die(`odoo ${flag} ${modules} failed (log above). The server was restarted with the previous state.`);
}

/**
 * Regenerate an environment's files after the repo changed (new submodules or requirements) or to point it to
 * another repo folder; the database and filestore are kept.
 * @param {object} e - record
 * @param {object} o - options (--repo dir)
 */
async function rebuild(e, o) {
  requireDocker();
  if (o.repo && o.repo !== true) e.repo = path.resolve(o.repo);
  if (!fs.existsSync(e.repo)) die(`Repo not found: ${e.repo}`);
  e.addons = E.findAddonsDirs(e.repo);
  if (o.pip && o.pip !== true) e.pip = [...new Set([...(e.pip || []), ...String(o.pip).split(',').map((p) => p.trim()).filter(Boolean)])];
  const dir = envDir(e.name);
  const reqs = E.collectRequirements(e.repo, e.addons, e.pip);
  e.build = Boolean(reqs);
  if (reqs) {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), reqs);
    fs.writeFileSync(path.join(dir, 'Dockerfile'), E.renderDockerfile(e));
  }
  fs.writeFileSync(path.join(dir, 'odoo.conf'), E.renderConf(e));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), E.renderCompose(e));
  saveEnv(e);
  console.log(`>> repo ${e.repo}; addons: ${e.addons.map((a) => a || '(repo root)').join(', ')}`);
  if (e.build && compose(e, ['build', 'odoo']) !== 0) die('Image build failed (see the pip output above).');
  if (compose(e, ['up', '-d', '--force-recreate', 'odoo']) !== 0) die('docker compose up failed.');
  await startOdoo(e);
}

/**
 * Size of the docker volumes of every environment, keyed by environment name.
 * @returns {object} name -> human size
 */
function volumeSizes() {
  const r = capture('docker', ['system', 'df', '-v', '--format', '{{json .Volumes}}']);
  const sizes = {};
  try {
    for (const v of JSON.parse(r.out || '[]')) {
      const m = /^oaple-(.+)_(db|data)$/.exec(v.Name);
      if (m) sizes[m[1]] = `${sizes[m[1]] ? `${sizes[m[1]]} + ` : ''}${v.Size}`;
    }
  } catch {
    // Older docker: no sizes.
  }
  return sizes;
}

/** Print every environment with its state. */
function list() {
  const envs = allEnvs();
  if (!envs.length) {
    console.log('No local environments.');
    return;
  }
  const running = capture('docker', ['ps', '--filter', 'label=oap.local-env', '--format', '{{.Label "oap.local-env"}}']).out.split('\n');
  const sizes = volumeSizes();
  for (const e of envs) {
    const state = running.includes(e.name) ? 'running' : 'stopped';
    console.log(`${e.name}  Odoo ${e.version}  ${state}  http://localhost:${e.port}  db=${e.db}  ${e.keep ? 'kept' : 'released'}  ${sizes[e.name] || ''}  repo=${e.repo}`);
  }
}

/**
 * Delete an environment: containers, volumes, project image and its folder.
 * @param {object} e - record
 */
function removeEnv(e) {
  compose(e, ['down', '--volumes', '--remove-orphans', ...(e.build ? ['--rmi', 'local'] : [])]);
  fs.rmSync(envDir(e.name), { recursive: true, force: true });
  // Files downloaded from Odoo.sh for this environment (dump and filestore tar).
  fs.rmSync(path.join(BASE, 'downloads', e.name), { recursive: true, force: true });
  console.log(`>> ${e.name} deleted.`);
}

/**
 * Cleanup: released environments (and kept ones only when asked by version), unused images and plugin Enterprise.
 * @param {object} o - options
 */
function clean(o) {
  requireDocker();
  const version = o.version && o.version !== true ? E.normVersion(o.version) : null;
  const envs = allEnvs().filter((e) => !version || e.version === version);
  const victims = envs.filter((e) => !e.keep);
  const kept = envs.filter((e) => e.keep);
  const ent = version && fs.existsSync(path.join(ENT, version)) ? [path.join(ENT, version)] : [];
  const images = version ? [`odoo:${version}`] : [];
  console.log('Would delete:');
  victims.forEach((e) => console.log(`  environment ${e.name} (Odoo ${e.version})`));
  images.forEach((i) => console.log(`  image ${i}`));
  ent.forEach((d) => console.log(`  Enterprise clone ${d}`));
  if (!victims.length && !images.length && !ent.length) console.log('  nothing');
  if (kept.length) console.log(`Kept (release them first): ${kept.map((e) => e.name).join(', ')}`);
  console.log('Note: on Docker Desktop the disk image does not shrink by itself after deleting; compacting it is a separate manual step.');
  if (!o.yes) {
    console.log('Dry run. Repeat with --yes after the user confirms.');
    return;
  }
  victims.forEach(removeEnv);
  const stillUsed = allEnvs().some((e) => e.version === version);
  if (!stillUsed) {
    images.forEach((i) => run('docker', ['image', 'rm', i]));
    ent.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  } else if (version) console.log(`Image and Enterprise ${version} kept: other environments still use them.`);
}

/** Entry point. */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = E.parseArgs(rest);
  if (!cmd || cmd === '--help' || cmd === '-h' || o.help) return console.log(USAGE);
  switch (cmd) {
    case 'doctor':
      return console.log(`Docker ${requireDocker()} is running. Data folder: ${BASE}`);
    case 'enterprise':
      return enterprise(o);
    case 'addons':
      if (!o.repo || o.repo === true) die('Usage: addons --repo dir');
      return console.log(E.findAddonsDirs(path.resolve(o.repo)).map((a) => a || '(repo root)').join('\n') || 'No modules found.');
    case 'up':
      return up(o);
    case 'list':
      return list();
    case 'status':
      return console.log(JSON.stringify({ ...loadEnv(o.name), db_password: undefined, admin_passwd: undefined }, null, 2));
    case 'start':
      requireDocker();
      return startOdoo(loadEnv(o.name));
    case 'stop':
      requireDocker();
      return compose(loadEnv(o.name), ['stop']);
    case 'logs':
      return compose(loadEnv(o.name), ['logs', '--no-color', '--tail', String(o.tail && o.tail !== true ? o.tail : 200), 'odoo']);
    case 'rebuild':
      return rebuild(loadEnv(o.name), o);
    case 'restart':
      requireDocker();
      compose(loadEnv(o.name), ['restart', 'odoo']);
      return startOdoo(loadEnv(o.name));
    case 'snapshot': {
      requireDocker();
      const e = loadEnv(o.name);
      snapshot(e);
      return startOdoo(e);
    }
    case 'reset':
      return reset(loadEnv(o.name));
    case 'update':
      return updateModules(loadEnv(o.name), '-u', o.modules);
    case 'install':
      return updateModules(loadEnv(o.name), '-i', o.modules);
    case 'test': {
      const e = loadEnv(o.name);
      if (!o.modules || o.modules === true) die('Missing --modules a,b');
      requireDocker();
      const tags = o.tags && o.tags !== true ? String(o.tags) : String(o.modules).split(',').map((m) => `/${m.trim()}`).join(',');
      const status = odooRun(e, ['odoo', '-d', e.db, '-u', String(o.modules), '--test-enable', '--test-tags', tags, '--stop-after-init', '--http-port', '8070']);
      process.exit(status);
      break;
    }
    case 'keep':
    case 'release': {
      const e = loadEnv(o.name);
      e.keep = cmd === 'keep';
      saveEnv(e);
      return console.log(`${e.name}: ${e.keep ? 'kept until released' : 'released (clean may delete it)'}`);
    }
    case 'down': {
      const e = loadEnv(o.name);
      if (!o.yes) die(`This deletes ${e.name} with its database and filestore. Confirm with the user, then repeat with --yes.`);
      requireDocker();
      return removeEnv(e);
    }
    case 'clean':
      return clean(o);
    default:
      die(USAGE);
  }
  return undefined;
}

if (require.main === module) main().catch((err) => die(String((err && err.stack) || err)));

module.exports = { fromOdoosh };
