#!/usr/bin/env node
'use strict';
// PreToolUse hook: deterministic safety policy for odoo-browser-agent.
const { execFileSync } = require('child_process');
const { evaluate, ASK, DENY, CHROME_TOOL } = require('./lib/policy');
const { loadConfig } = require('./lib/config');
const { throttleBrowser } = require('./lib/throttle');

/**
 * Return the current branch of a git working tree.
 * @param {string} dir - working directory
 * @returns {string|null} branch name, or null if unknown/detached
 */
function branchOf(dir) {
  try {
    // symbolic-ref also works on a branch without commits; fails when HEAD is detached.
    const out = execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Print a PreToolUse decision in the hook JSON format.
 * @param {{decision: string, reason: string}} result - decision
 */
function emit(result) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: `[odoo-browser-agent] ${result.reason}`,
    },
  }));
}

/** Read the hook event from stdin and emit a decision when the policy has one. */
function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', async () => {
    let event;
    try {
      event = JSON.parse(data || '{}');
    } catch {
      process.exit(0);
    }
    try {
      const result = evaluate(event, { loadConfig, branchOf });
      // While waiting for an Odoo.sh build, space out allowed browser calls instead of letting the agent poll.
      if (CHROME_TOOL.test(event.tool_name || '') && !(result && result.decision === DENY)) {
        const loaded = loadConfig(event.cwd || process.cwd());
        if (loaded) await throttleBrowser(loaded, (ms) => new Promise((r) => setTimeout(r, ms)));
      }
      if (result) emit(result);
    } catch (err) {
      // Fail closed to "ask" instead of silently allowing when the policy crashes.
      emit({ decision: ASK, reason: `Error del guard (${err.message}); confirmar manualmente.` });
    }
    process.exit(0);
  });
}

main();
