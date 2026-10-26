#!/usr/bin/env node
'use strict';
// CLI to create, show and validate .claude/odoo-agent.json in an Odoo module repo.
const path = require('path');
const { CONFIG_REL, DEFAULTS, loadConfig, validateConfig, saveConfig } = require('./lib/config');

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
      console.log(`Ya existe: ${loaded.path}`);
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
    console.log(`Creado: ${target}`);
    printProblems(validateConfig(config));
    return;
  }
  if (!loaded) {
    console.error(`No existe ${CONFIG_REL} en ${dir} ni en directorios superiores. Ejecutar "init".`);
    process.exit(1);
  }
  if (cmd === 'show') {
    console.log(JSON.stringify({ path: loaded.path, ...loaded.config }, null, 2));
  } else if (cmd === 'validate') {
    const problems = validateConfig(loaded.config);
    printProblems(problems);
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === 'set-staging') {
    const branch = rest[0];
    if (!branch || branch.startsWith('--')) {
      console.error('Uso: config.js set-staging <rama>');
      process.exit(1);
    }
    if (loaded.config.production_branches.includes(branch)) {
      console.error(`"${branch}" está declarada como rama de producción; no puede ser staging.`);
      process.exit(1);
    }
    saveConfig(loaded.path, { ...loaded.config, staging_branch: branch });
    console.log(`staging_branch = ${branch}`);
  } else if (cmd === 'set-ssh') {
    saveConfig(loaded.path, { ...loaded.config, ssh: { ...loaded.config.ssh, enabled: opts.enabled !== 'false', key: opts.key || loaded.config.ssh.key } });
    console.log('ssh actualizado');
  } else {
    console.error('Uso: config.js init|show|validate|set-staging <rama>|set-ssh --enabled true|false [--key ruta] [--dir ruta]');
    process.exit(1);
  }
}

/**
 * Print validation problems or OK.
 * @param {string[]} problems - validation messages
 */
function printProblems(problems) {
  if (!problems.length) console.log('Configuración válida.');
  else problems.forEach((p) => console.log(`- ${p}`));
}

main();
