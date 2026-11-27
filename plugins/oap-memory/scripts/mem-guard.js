#!/usr/bin/env node
'use strict';
// PreToolUse hook of oap-memory: protects the memory stores (ask/deny only, never approves). Silent on errors.
const { evaluate } = require('./lib/memguard');
const { findOapRoot } = require('./lib/root');
const { isSessionActive } = require('./lib/session');

/**
 * Tell whether a memory session is open for the repo of a folder.
 * @param {string} dir - folder
 * @returns {boolean} true while a plugin task runs there
 */
function sessionActive(dir) {
  const root = findOapRoot(dir);
  return Boolean(root && isSessionActive(root));
}

/** Read the hook event from stdin and emit a decision when there is one. */
function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    try {
      const result = evaluate(JSON.parse(data || '{}'), { sessionActive });
      if (result) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: `[oap-memory] ${result.reason}` },
        }));
      }
    } catch {
      // Never break or block a session because of the hook itself.
    }
    process.exit(0);
  });
}

main();
