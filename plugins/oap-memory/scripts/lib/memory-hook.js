'use strict';
const fs = require('fs');
const path = require('path');
const { memoryFile } = require('./notes');
const { loadSession, saveSession, isSessionActive } = require('./session');

const FAILURE_HINT_EVERY_MS = 10 * 60 * 1000;
const NOTES_JS = path.resolve(__dirname, '..', 'notes.js').split(path.sep).join('/');
const ADD_CMD = `node "${NOTES_JS}" add [--tag t] --text "I thought X, actually Y" --source "<task>"`;

/**
 * Tell whether something was noted since the session started: memory.md written (old format) or an entry added
 * to the knowledge store (knowledge.js records it in the session; notes.js add goes there once migrated).
 * @param {string} root - repo root
 * @param {object} s - memory session
 * @returns {boolean} true if a note was added during this session
 */
function memoryTouchedSinceStart(root, s) {
  if ((s.items || []).some((k) => k.action === 'added')) return true;
  const p = memoryFile(root);
  return fs.existsSync(p) && fs.statSync(p).mtimeMs >= Date.parse(s.started_at);
}

/**
 * Decide what a Stop / PostToolUseFailure hook event should answer. Pure apart from the session bookkeeping.
 * @param {object} event - hook input {hook_event_name, stop_hook_active, cwd, agent_id}
 * @param {{findRoot: function, now?: number}} deps - dependencies (findRoot(dir) returns the repo root or null)
 * @returns {object|null} hook output JSON, or null for no opinion
 */
function decide(event, deps) {
  const now = deps.now || Date.now();
  const root = deps.findRoot(event.cwd || process.cwd());
  if (!root || !isSessionActive(root, now)) return null;
  const s = loadSession(root);

  if (event.hook_event_name === 'Stop') {
    // stop_hook_active: Claude is already continuing because of a Stop hook; never loop. One reminder per session.
    if (event.stop_hook_active || s.memory_reminded || memoryTouchedSinceStart(root, s)) return null;
    s.memory_reminded = true;
    saveSession(root, s);
    return {
      decision: 'block',
      reason: `[oap-memory] Before finishing: did anything in this task turn out different from what you expected (a failing command, a path, a slow test, a tool quirk)? `
        + `If you verified it and it will help other tasks in this project, record it (0 to 5 lines) with ${ADD_CMD}. Details that only matter for this task do not go to memory. If there is nothing to record, just finish.`,
    };
  }

  if (event.hook_event_name === 'PostToolUseFailure') {
    // Subagents cannot write memory (mem-guard): they hand the lesson back, without using the main thread's hint window.
    if (event.agent_id) {
      if (now - (s.last_subagent_hint_ms || 0) < FAILURE_HINT_EVERY_MS) return null;
      s.last_subagent_hint_ms = now;
      saveSession(root, s);
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext: '[oap-memory] If you solve this failure and the cause was not the expected one, include it as [LESSON] in your answer to the orchestrator (do not write memory yourself).',
        },
      };
    }
    if (now - (s.last_failure_hint_ms || 0) < FAILURE_HINT_EVERY_MS) return null;
    s.last_failure_hint_ms = now;
    saveSession(root, s);
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `[oap-memory] If you solve this failure and the cause was not the expected one, record it right away with ${ADD_CMD}.`,
      },
    };
  }
  return null;
}

module.exports = { decide, memoryTouchedSinceStart, FAILURE_HINT_EVERY_MS };
