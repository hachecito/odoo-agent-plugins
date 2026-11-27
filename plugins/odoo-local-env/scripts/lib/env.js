'use strict';
// Pure helpers of odoo-local-env: paths, addons detection and the generated compose, odoo.conf and Dockerfile.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP_DIRS = new Set(['.git', '.idea', '.vscode', '.oap', '.specify', 'node_modules', '__pycache__', 'specs', 'docs']);
const DEFAULT_PG = '16';

/**
 * Folder that holds every local environment and the Enterprise checkouts.
 * @param {object} [env] - environment variables
 * @returns {string} base folder
 */
function baseDir(env = process.env) {
  return path.join(path.resolve(env.OAP_HOME || os.homedir()), '.oap', 'local-env');
}

/**
 * Normalize an environment name to [a-z0-9-].
 * @param {string} name - raw name
 * @returns {string} slug
 */
function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * Normalize an Odoo version ("19", "19.0", "saas-19.1") to the image tag form "19.0".
 * @param {string} v - version
 * @returns {string|null} normalized version or null
 */
function normVersion(v) {
  const m = /^(\d{2})(?:\.(\d))?$/.exec(String(v || '').trim());
  return m ? `${m[1]}.${m[2] || '0'}` : null;
}

/**
 * Parse argv into positionals and --key value options (a flag with no value is true).
 * @param {string[]} argv - arguments
 * @returns {{_: string[], [k: string]: any}} parsed options
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    } else out._.push(a);
  }
  return out;
}

/**
 * Find the addons folders of a repo: folders whose direct children hold a __manifest__.py (root and submodules).
 * @param {string} repo - repo root
 * @param {number} [depth] - max folder depth to search
 * @returns {string[]} folders relative to the repo ('' is the root), sorted
 */
function findAddonsDirs(repo, depth = 3) {
  const found = [];
  const isModule = (dir) => fs.existsSync(path.join(dir, '__manifest__.py')) || fs.existsSync(path.join(dir, '__openerp__.py'));
  const walk = (dir, rel, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
    if (subs.some((e) => isModule(path.join(dir, e.name)))) found.push(rel);
    if (level >= depth) return;
    for (const e of subs) {
      const child = path.join(dir, e.name);
      if (!isModule(child)) walk(child, rel ? `${rel}/${e.name}` : e.name, level + 1);
    }
  };
  walk(repo, '', 0);
  return found.sort();
}

/**
 * Merge the requirements.txt of the repo root and of each addons folder (dedupe, comments dropped).
 * @param {string} repo - repo root
 * @param {string[]} addons - addons folders relative to the repo
 * @param {string[]} [extra] - extra pip packages asked by the user
 * @returns {string} merged requirements ('' when there are none)
 */
function collectRequirements(repo, addons, extra = []) {
  const lines = [...extra];
  // Repo root, each addons folder and each module folder (some modules ship their own requirements.txt).
  const rels = new Set(['', ...addons]);
  for (const rel of addons) {
    try {
      fs.readdirSync(path.join(repo, rel), { withFileTypes: true }).filter((d) => d.isDirectory()).forEach((d) => rels.add(rel ? `${rel}/${d.name}` : d.name));
    } catch {
      // Unreadable folder: skip.
    }
  }
  for (const rel of rels) {
    // external_dependencies.python of the manifest (import names, which match the pip name for most libraries).
    try {
      const manifest = fs.readFileSync(path.join(repo, rel, '__manifest__.py'), 'utf8');
      const block = /['"]external_dependencies['"]\s*:\s*\{[^}]*?['"]python['"]\s*:\s*\[([^\]]*)\]/.exec(manifest);
      for (const m of (block ? block[1] : '').matchAll(/['"]([^'"]+)['"]/g)) if (!lines.includes(m[1])) lines.push(m[1]);
    } catch {
      // Not a module folder.
    }
    const file = path.join(repo, rel, 'requirements.txt');
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const l = raw.replace(/#.*/, '').trim();
      if (l && !lines.includes(l)) lines.push(l);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Path as Docker Desktop and Linux accept it in a compose bind mount (forward slashes).
 * @param {string} p - host path
 * @returns {string} path
 */
function hostPath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * Random hex secret.
 * @param {number} [bytes] - length in bytes
 * @returns {string} secret
 */
function secret(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Container addons_path for an environment.
 * @param {object} e - environment record
 * @returns {string} comma separated container paths
 */
function addonsPath(e) {
  const paths = [];
  if (e.enterprise) paths.push('/mnt/enterprise');
  for (const rel of e.addons) paths.push(rel ? `/mnt/repo/${rel}` : '/mnt/repo');
  (e.extra || []).forEach((_, i) => paths.push(`/mnt/extra${i}`));
  return paths.join(',');
}

/**
 * Render odoo.conf.
 * @param {object} e - environment record
 * @returns {string} config text
 */
function renderConf(e) {
  return [
    '[options]',
    `addons_path = ${addonsPath(e)}`,
    'data_dir = /var/lib/odoo',
    'db_host = db',
    'db_port = 5432',
    'db_user = odoo',
    `db_password = ${e.db_password}`,
    `admin_passwd = ${e.admin_passwd}`,
    `db_name = ${e.db}`,
    `dbfilter = ^${e.db}$`,
    'list_db = False',
    'workers = 0',
    'max_cron_threads = 0',
    'proxy_mode = False',
    'log_level = info',
    '',
  ].join('\n');
}

/**
 * Render the Dockerfile of the project image (official image plus the repo's Python requirements).
 * @param {object} e - environment record
 * @returns {string} Dockerfile text
 */
function renderDockerfile(e) {
  return [
    `FROM odoo:${e.version}`,
    'USER root',
    'COPY requirements.txt /tmp/oap-requirements.txt',
    // Newer images (Ubuntu noble) need --break-system-packages; older pip does not know the flag. If the whole file
    // fails (e.g. a manifest import name that is not a pip name), install line by line and report what failed.
    'RUN F="--break-system-packages"; pip3 install --help | grep -q break-system-packages || F=""; \\',
    '    pip3 install --no-cache-dir $F -r /tmp/oap-requirements.txt || \\',
    '    (while read -r p; do pip3 install --no-cache-dir $F "$p" || echo "OAP-PIP-FAILED: $p"; done < /tmp/oap-requirements.txt)',
    'USER odoo',
    '',
  ].join('\n');
}

/**
 * Render compose.yaml: Postgres and Odoo, data in named volumes, code mounted read-only, port bound to localhost.
 * @param {object} e - environment record
 * @returns {string} compose text
 */
function renderCompose(e) {
  const q = (s) => JSON.stringify(s);
  const labels = (indent) => [`${indent}oap.local-env: ${q(e.name)}`, `${indent}oap.odoo-version: ${q(e.version)}`];
  const mounts = [
    '      - data:/var/lib/odoo',
    '      - ./odoo.conf:/etc/odoo/odoo.conf:ro',
    `      - ${q(`${hostPath(e.repo)}:/mnt/repo:ro`)}`,
  ];
  if (e.enterprise) mounts.push(`      - ${q(`${hostPath(e.enterprise)}:/mnt/enterprise:ro`)}`);
  (e.extra || []).forEach((p, i) => mounts.push(`      - ${q(`${hostPath(p)}:/mnt/extra${i}:ro`)}`));
  return [
    `name: ${q(`oaple-${e.name}`)}`,
    'services:',
    '  db:',
    // Official Postgres plus pgvector: Odoo 19 databases (AI features) create the "vector" extension.
    `    image: pgvector/pgvector:pg${e.pg}`,
    '    environment:',
    '      POSTGRES_USER: odoo',
    `      POSTGRES_PASSWORD: ${q(e.db_password)}`,
    '      POSTGRES_DB: postgres',
    '    volumes:',
    '      - db:/var/lib/postgresql/data',
    '    labels:',
    ...labels('      '),
    '    healthcheck:',
    '      test: ["CMD-SHELL", "pg_isready -U odoo -d postgres"]',
    '      interval: 3s',
    '      timeout: 3s',
    '      retries: 40',
    '  odoo:',
    e.build ? '    build: .' : `    image: odoo:${e.version}`,
    ...(e.build ? [`    image: ${q(`oaple-${e.name}:${e.version}`)}`] : []),
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    ports:',
    `      - ${q(`127.0.0.1:${e.port}:8069`)}`,
    '    environment:',
    `      PASSWORD: ${q(e.db_password)}`,
    '    volumes:',
    ...mounts,
    '    labels:',
    ...labels('      '),
    'volumes:',
    '  db:',
    '    labels:',
    ...labels('      '),
    '  data:',
    '    labels:',
    ...labels('      '),
    '',
  ].join('\n');
}

module.exports = {
  DEFAULT_PG, baseDir, slug, normVersion, parseArgs, findAddonsDirs, collectRequirements, hostPath, secret,
  addonsPath, renderConf, renderDockerfile, renderCompose,
};
