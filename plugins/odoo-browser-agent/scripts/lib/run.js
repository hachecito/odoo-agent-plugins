'use strict';
const fs = require('fs');
const path = require('path');
const { RUN_STATE_REL } = require('./config');

const STATES = [
  'DISCOVERY', 'PLANNING', 'IMPLEMENTATION', 'LOCAL_TESTING', 'GIT_VALIDATION',
  'REMOTE_BUILD', 'REMOTE_TESTING', 'FINAL_VERIFICATION', 'COMPLETED', 'BLOCKED', 'FAILED',
];
// Evidence required to declare a task COMPLETED.
const REQUIRED_EVIDENCE = ['local_checks', 'commit', 'push', 'remote_build', 'logs_reviewed', 'remote_tests'];
const EVIDENCE_STATUS = ['pass', 'fail', 'skipped', 'not_applicable'];

/**
 * Resolve the run-state file for a repo root.
 * @param {string} root - repo root containing .claude/
 * @returns {string} absolute file path
 */
function runPath(root) {
  return path.join(root, RUN_STATE_REL);
}

/**
 * Load the run state, or null if none.
 * @param {string} root - repo root
 * @returns {object|null} state
 */
function loadRun(root) {
  const p = runPath(root);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * Persist the run state.
 * @param {string} root - repo root
 * @param {object} run - state object
 */
function saveRun(root, run) {
  fs.mkdirSync(path.dirname(runPath(root)), { recursive: true });
  fs.writeFileSync(runPath(root), JSON.stringify(run, null, 2) + '\n', 'utf8');
}

/**
 * Compute the final verdict from recorded evidence.
 * @param {object} run - run state
 * @returns {{verdict: string, missing: string[], failed: string[], skipped: string[]}} verdict
 */
function verdict(run) {
  const latest = {};
  for (const e of run.evidence || []) latest[e.kind] = e;
  const missing = REQUIRED_EVIDENCE.filter((k) => !latest[k]);
  const failed = Object.values(latest).filter((e) => e.status === 'fail').map((e) => e.kind);
  const skipped = Object.values(latest).filter((e) => e.status === 'skipped').map((e) => e.kind);
  let v = 'COMPLETADA';
  if (run.state === 'BLOCKED') v = 'BLOQUEADA';
  else if (failed.length || run.state === 'FAILED') v = 'FALLIDA';
  else if (missing.length || skipped.length) v = 'PARCIALMENTE VERIFICADA';
  return { verdict: v, missing, failed, skipped };
}

module.exports = { STATES, REQUIRED_EVIDENCE, EVIDENCE_STATUS, loadRun, saveRun, verdict, runPath };
