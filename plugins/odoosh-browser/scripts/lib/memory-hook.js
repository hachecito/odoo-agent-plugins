'use strict';
const fs = require('fs');
const path = require('path');
const { agentFile } = require('./config');
const { loadRun, saveRun, isRunActive } = require('./run');

const FAILURE_HINT_EVERY_MS = 10 * 60 * 1000;
const NOTES_JS = path.resolve(__dirname, '..', 'notes.js').split(path.sep).join('/');
const ADD_CMD = `node "${NOTES_JS}" add [--tag t] --text "I thought X, actually Y" --source "<task>"`;

/**
 * Tell whether memory.md was written since the run started.
 * @param {string} root - repo root
 * @param {object} run - run state
 * @returns {boolean} true if a note was added during this run
 */
function memoryTouchedSinceStart(root, run) {
  const p = agentFile(root, 'memory');
  return fs.existsSync(p) && fs.statSync(p).mtimeMs >= Date.parse(run.started_at);
}

/**
 * Decide what a Stop / PostToolUseFailure hook event should answer. Pure apart from run.json bookkeeping.
 * @param {object} event - hook input {hook_event_name, stop_hook_active, cwd}
 * @param {{loadConfig: function, now?: number}} deps - dependencies
 * @returns {object|null} hook output JSON, or null for no opinion
 */
function decide(event, deps) {
  const now = deps.now || Date.now();
  const loaded = deps.loadConfig(event.cwd || process.cwd());
  if (!loaded || !isRunActive(loaded.root, now)) return null;
  const run = loadRun(loaded.root);

  if (event.hook_event_name === 'Stop') {
    // stop_hook_active: Claude is already continuing because of a Stop hook; never loop. One reminder per run.
    if (event.stop_hook_active || run.memory_reminded || memoryTouchedSinceStart(loaded.root, run)) return null;
    run.memory_reminded = true;
    saveRun(loaded.root, run);
    return {
      decision: 'block',
      reason: `[odoosh-browser] Before finishing: did anything in this task turn out different from what you expected (a failing command, a path, a slow test, an editor or Odoo.sh quirk)? `
        + `If you verified it and it will help other tasks in this project, record it (0 to 5 lines) with ${ADD_CMD}. Details that only matter for this task do not go to memory. If there is nothing to record, just finish.`,
    };
  }

  if (event.hook_event_name === 'PostToolUseFailure') {
    // Subagents cannot write memory (guard): they hand the lesson back, without using the main thread's hint window.
    if (event.agent_id) {
      if (now - (run.last_subagent_hint_ms || 0) < FAILURE_HINT_EVERY_MS) return null;
      run.last_subagent_hint_ms = now;
      saveRun(loaded.root, run);
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext: '[odoosh-browser] If you solve this failure and the cause was not the expected one, include it as [LESSON] in your answer to the orchestrator (do not use notes.js).',
        },
      };
    }
    if (now - (run.last_failure_hint_ms || 0) < FAILURE_HINT_EVERY_MS) return null;
    run.last_failure_hint_ms = now;
    saveRun(loaded.root, run);
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `[odoosh-browser] If you solve this failure and the cause was not the expected one, record it right away with ${ADD_CMD}.`,
      },
    };
  }
  return null;
}

module.exports = { decide, memoryTouchedSinceStart, FAILURE_HINT_EVERY_MS };
