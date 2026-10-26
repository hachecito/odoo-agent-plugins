#!/usr/bin/env node
'use strict';
// CLI to track the state and evidence of an odoo-task run (.claude/odoo-agent-run.json).
const { loadConfig } = require('./lib/config');
const { STATES, EVIDENCE_STATUS, loadRun, saveRun, verdict } = require('./lib/run');

const MAX_FIX_CYCLES = 3;

/**
 * Read the value following a --flag.
 * @param {string[]} args - arguments
 * @param {string} name - flag name without dashes
 * @returns {string|undefined} value
 */
function opt(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Entry point: init | state <STATE> | evidence | cycle | show. */
function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const loaded = loadConfig(opt(args, 'dir') || process.cwd());
  if (!loaded) {
    console.error('No hay .claude/odoo-agent.json: ejecutar primero la skill odoo-project-setup.');
    process.exit(1);
  }
  const root = loaded.root;
  const now = new Date().toISOString();
  let run = loadRun(root);

  if (cmd === 'init') {
    run = {
      task: opt(args, 'task') || '',
      staging_branch: loaded.config.staging_branch,
      started_at: now,
      state: 'DISCOVERY',
      fix_cycles: 0,
      history: [{ at: now, state: 'DISCOVERY' }],
      evidence: [],
    };
    saveRun(root, run);
    console.log('Ejecución iniciada (DISCOVERY).');
    return;
  }
  if (!run) {
    console.error('No hay ejecución activa: usar "init --task ...".');
    process.exit(1);
  }
  if (cmd === 'state') {
    const s = args[0];
    if (!STATES.includes(s)) {
      console.error(`Estado inválido. Válidos: ${STATES.join(', ')}`);
      process.exit(1);
    }
    if (s === 'COMPLETED' && verdict(run).verdict !== 'COMPLETADA') {
      console.error(`No se puede marcar COMPLETED: ${JSON.stringify(verdict(run))}`);
      process.exit(1);
    }
    run.state = s;
    run.history.push({ at: now, state: s, note: opt(args, 'note') });
  } else if (cmd === 'evidence') {
    const kind = opt(args, 'kind');
    const status = opt(args, 'status');
    if (!kind || !EVIDENCE_STATUS.includes(status)) {
      console.error(`Uso: evidence --kind <tipo> --status ${EVIDENCE_STATUS.join('|')} --detail "..." [--source "..."]`);
      process.exit(1);
    }
    run.evidence.push({ at: now, kind, status, detail: opt(args, 'detail') || '', source: opt(args, 'source') || '' });
  } else if (cmd === 'cycle') {
    run.fix_cycles += 1;
    if (run.fix_cycles > MAX_FIX_CYCLES) {
      run.state = 'BLOCKED';
      run.history.push({ at: now, state: 'BLOCKED', note: `Superado el límite de ${MAX_FIX_CYCLES} ciclos de corrección` });
      saveRun(root, run);
      console.error(`Límite de ${MAX_FIX_CYCLES} ciclos superado: BLOCKED. Pedir ayuda al usuario.`);
      process.exit(1);
    }
  } else if (cmd !== 'show') {
    console.error('Uso: run-state.js init --task "..." | state <ESTADO> [--note ...] | evidence ... | cycle | show');
    process.exit(1);
  }
  saveRun(root, run);
  console.log(JSON.stringify({ state: run.state, fix_cycles: run.fix_cycles, ...verdict(run) }, null, 2));
}

main();
