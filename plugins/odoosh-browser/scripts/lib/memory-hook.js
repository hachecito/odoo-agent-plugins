'use strict';
const fs = require('fs');
const path = require('path');
const { agentFile } = require('./config');
const { loadRun, saveRun, isRunActive } = require('./run');

const FAILURE_HINT_EVERY_MS = 10 * 60 * 1000;
const NOTES_JS = path.resolve(__dirname, '..', 'notes.js').split(path.sep).join('/');
const ADD_CMD = `node "${NOTES_JS}" add [--tag t] --text "creía X, en realidad Y" --source "<tarea>"`;

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
      reason: `[odoosh-browser] Antes de terminar: ¿algo de esta tarea resultó distinto de lo esperado (comando que falló, ruta, test lento, rareza del editor u Odoo.sh)? `
        + `Si lo comprobaste y servirá en otras tareas del proyecto, anótalo (0 a 5 líneas) con ${ADD_CMD}. Los detalles que solo valen para esta tarea no van a la memoria. Si no hay nada que anotar, termina sin más.`,
    };
  }

  if (event.hook_event_name === 'PostToolUseFailure') {
    if (now - (run.last_failure_hint_ms || 0) < FAILURE_HINT_EVERY_MS) return null;
    run.last_failure_hint_ms = now;
    saveRun(loaded.root, run);
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `[odoosh-browser] Si resuelves este fallo y la causa no era la esperada, anótalo en el momento con ${ADD_CMD}.`,
      },
    };
  }
  return null;
}

module.exports = { decide, memoryTouchedSinceStart, FAILURE_HINT_EVERY_MS };
