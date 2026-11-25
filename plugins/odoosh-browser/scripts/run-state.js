#!/usr/bin/env node
'use strict';
// CLI to track the state and evidence of an odoo-task run (.oap/odoosh-browser/run.json).
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

const USAGE = 'Usage: run-state.js init --task "..." | state <STATE> [--note ...] | evidence ... | cycle | build-wait | close [--note ...] | show';

/** Entry point: init | state <STATE> | evidence | cycle | show. */
function main() {
  const [cmd, ...args] = process.argv.slice(2);
  // A help flag never runs the command ("close --help" used to close the run).
  if (!cmd || [cmd, ...args].some((a) => a === '--help' || a === '-h')) {
    console.log(USAGE);
    return;
  }
  const loaded = loadConfig(opt(args, 'dir') || process.cwd());
  if (!loaded) {
    console.error('No .oap/odoosh-browser/config.json: run the odoo-project-setup skill first.');
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
    console.log('Run started (DISCOVERY).');
    return;
  }
  if (!run) {
    console.error('No active run: use "init --task ...".');
    process.exit(1);
  }
  if (cmd === 'state') {
    const s = args[0];
    if (!STATES.includes(s)) {
      console.error(`Invalid state. Valid: ${STATES.join(', ')}`);
      process.exit(1);
    }
    // The independent verification (odoo-verifier) runs in FINAL_VERIFICATION: it cannot be skipped.
    if (s === 'COMPLETED' && run.state !== 'FINAL_VERIFICATION') {
      console.error('COMPLETED can only be set from FINAL_VERIFICATION (after the verifier).');
      process.exit(1);
    }
    if (s === 'COMPLETED' && verdict(run).verdict !== 'COMPLETE') {
      const v = verdict(run);
      console.error(`Cannot set COMPLETED: ${JSON.stringify(v)}`);
      if (v.skipped.includes('local_checks')) {
        console.error('If the project has no local Odoo environment, record local_checks with --status not_applicable and the reason; skipped means it could have been done and was not.');
      }
      process.exit(1);
    }
    run.state = s;
    run.history.push({ at: now, state: s, note: opt(args, 'note') });
  } else if (cmd === 'evidence') {
    const kind = opt(args, 'kind');
    const status = opt(args, 'status');
    if (!kind || !EVIDENCE_STATUS.includes(status)) {
      console.error(`Usage: evidence --kind <kind> --status ${EVIDENCE_STATUS.join('|')} --detail "..." [--source "..."]`);
      process.exit(1);
    }
    run.evidence.push({ at: now, kind, status, detail: opt(args, 'detail') || '', source: opt(args, 'source') || '' });
  } else if (cmd === 'cycle') {
    run.fix_cycles += 1;
    if (run.fix_cycles > MAX_FIX_CYCLES) {
      run.state = 'BLOCKED';
      run.history.push({ at: now, state: 'BLOCKED', note: `Exceeded the limit of ${MAX_FIX_CYCLES} fix cycles` });
      saveRun(root, run);
      console.error(`Limit of ${MAX_FIX_CYCLES} cycles exceeded: BLOCKED. Ask the user for help.`);
      process.exit(1);
    }
  } else if (cmd === 'close') {
    // Ends the run so the guard goes back to idle mode (only direct production pushes blocked).
    if (run.closed) {
      console.log('The run was already closed.');
      return;
    }
    run.closed = true;
    run.history.push({ at: now, state: run.state, note: `Run closed${opt(args, 'note') ? `: ${opt(args, 'note')}` : ''}` });
  } else if (cmd === 'build-wait') {
    // Report minutes spent in REMOTE_BUILD and block the run when the configured limit is exceeded.
    const entered = [...run.history].reverse().find((h) => h.state === 'REMOTE_BUILD');
    if (run.state !== 'REMOTE_BUILD' || !entered) {
      console.error('The run is not in REMOTE_BUILD.');
      process.exit(1);
    }
    const minutes = (Date.parse(now) - Date.parse(entered.at)) / 60000;
    const limit = loaded.config.build_timeout_minutes;
    if (minutes > limit) {
      run.state = 'BLOCKED';
      run.history.push({ at: now, state: 'BLOCKED', note: `Odoo.sh build not finished after ${limit} min` });
      saveRun(root, run);
      console.error(`Build wait limit (${limit} min) exceeded: BLOCKED. Tell the user.`);
      process.exit(1);
    }
    console.log(JSON.stringify({ waiting_minutes: Math.round(minutes * 10) / 10, limit_minutes: limit, poll_seconds: loaded.config.build_poll_seconds }));
    return;
  } else if (cmd !== 'show') {
    console.error(USAGE);
    process.exit(1);
  }
  saveRun(root, run);
  console.log(JSON.stringify({ state: run.state, fix_cycles: run.fix_cycles, ...verdict(run) }, null, 2));
}

main();
