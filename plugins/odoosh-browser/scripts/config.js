#!/usr/bin/env node
'use strict';
// CLI to create, show, validate and migrate .oap/odoosh-browser/config.json in an Odoo module repo.
const path = require('path');
const { spawnSync } = require('child_process');
const { CONFIG_REL, DEFAULTS, loadConfig, validateConfig, saveConfig, migrateLegacy, ensureExcluded } = require('./lib/config');

/**
 * Run an oap-memory command through mem.js and return its output ('' when oap-memory is missing or fails).
 * @param {string[]} args - mem.js arguments
 * @returns {string} trimmed stdout
 */
function mem(args) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'mem.js'), ...args], { encoding: 'utf8', timeout: 30000 });
  return res.status === 0 ? String(res.stdout || '').trim() : '';
}

/**
 * Parse --key value pairs from argv.
 * @param {string[]} argv - arguments
 * @returns {object} options map
 */
function parseOpts(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      opts[key] = next && !next.startsWith('--') ? (i++, next) : true;
    }
  }
  return opts;
}

/** Entry point: init | show | validate | set-staging <branch>. */
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseOpts(rest);
  const dir = path.resolve(opts.dir || process.cwd());
  const loaded = loadConfig(dir);

  if (cmd === 'init') {
    if (loaded && !opts.force) {
      console.log(`Already exists: ${loaded.path}`);
      process.exit(0);
    }
    const config = {
      ...DEFAULTS,
      odoo_sh_project: opts.project || null,
      staging_branch: opts.staging || null,
      production_branches: opts.production ? String(opts.production).split(',').map((s) => s.trim()) : DEFAULTS.production_branches,
      odoo_version: opts.version || null,
    };
    const target = path.join(dir, CONFIG_REL);
    saveConfig(target, config);
    console.log(`Created: ${target}`);
    const ex = ensureExcluded(dir);
    if (ex.excluded.length) console.log(`Added to ${ex.excludeFile}: ${ex.excluded.join(', ')}`);
    printProblems(validateConfig(config));
    return;
  }
  if (!loaded) {
    console.error(`No ${CONFIG_REL} in ${dir} or any parent directory. Run "init".`);
    process.exit(1);
  }
  if (cmd === 'show') {
    console.log(JSON.stringify({ path: loaded.path, ...loaded.config }, null, 2));
  } else if (cmd === 'validate') {
    const problems = validateConfig(loaded.config);
    printProblems(problems);
    if (loaded.legacy) console.log('Warning: files in the old location (.claude/). Run "config.js migrate" to move them to .oap/.');
    const memWarning = mem(['migrate', '--needed', '--dir', loaded.root]);
    if (memWarning) console.log(memWarning);
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === 'migrate') {
    const res = migrateLegacy(loaded.root);
    // Old .claude/*-notes.json into .oap/memory.md: done by oap-memory.
    res.notes = Number((/(\d+)$/.exec(mem(['notes', 'migrate-legacy', '--dir', loaded.root])) || [])[1] || 0);
    res.moved.forEach((r) => console.log(`Moved: ${r}`));
    res.skipped.forEach((r) => console.log(`Unchanged (target already exists): ${r}`));
    if (res.notes) console.log(`Notes converted to .oap/memory.md: ${res.notes}`);
    if (res.excludeFile) console.log(res.excluded.length ? `Added to ${res.excludeFile}: ${res.excluded.join(', ')}` : '.git/info/exclude already had .oap/.');
    else console.log('No .git/info/exclude found: exclude .oap/ from version control by hand.');
    if (!res.moved.length && !res.skipped.length && !res.notes) console.log('No old files to migrate.');
  } else if (cmd === 'set-staging') {
    const branch = rest[0];
    if (!branch || branch.startsWith('--')) {
      console.error('Usage: config.js set-staging <branch>');
      process.exit(1);
    }
    if (loaded.config.production_branches.includes(branch)) {
      console.error(`"${branch}" is declared as a production branch; it cannot be staging.`);
      process.exit(1);
    }
    saveConfig(loaded.path, { ...loaded.config, staging_branch: branch });
    console.log(`staging_branch = ${branch}`);
  } else if (cmd === 'set-autonomy') {
    const mode = rest[0];
    if (!['confirm', 'auto', 'yolo'].includes(mode)) {
      console.error('Usage: config.js set-autonomy confirm|auto|yolo  (auto: push to staging without confirmation; yolo: also plugin scripts, Chrome and ssh to dev builds without confirmation; production stays denied)');
      process.exit(1);
    }
    const autonomy = { push_staging: mode === 'confirm' ? 'confirm' : 'auto', yolo: mode === 'yolo' };
    saveConfig(loaded.path, { ...loaded.config, autonomy });
    console.log(`autonomy = ${JSON.stringify(autonomy)}`);
  } else if (cmd === 'set-ssh') {
    saveConfig(loaded.path, { ...loaded.config, ssh: { ...loaded.config.ssh, enabled: opts.enabled !== 'false', key: opts.key || loaded.config.ssh.key } });
    console.log('ssh updated');
  } else {
    console.error('Usage: config.js init|show|validate|migrate|set-staging <branch>|set-autonomy confirm|auto|yolo|set-ssh --enabled true|false [--key path] [--dir path]');
    process.exit(1);
  }
}

/**
 * Print validation problems or OK.
 * @param {string[]} problems - validation messages
 */
function printProblems(problems) {
  if (!problems.length) console.log('Configuration is valid.');
  else problems.forEach((p) => console.log(`- ${p}`));
}

main();
