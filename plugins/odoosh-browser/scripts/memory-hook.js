#!/usr/bin/env node
'use strict';
// Stop / PostToolUseFailure hook: nudges the agent to record findings in .oap/memory.md during an active run.
const { decide } = require('./lib/memory-hook');
const { loadConfig } = require('./lib/config');

/** Read the hook event from stdin and print the answer, if any. Never blocks on its own errors. */
function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    try {
      const out = decide(JSON.parse(data || '{}'), { loadConfig });
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {
      // A reminder must never break the session.
    }
    process.exit(0);
  });
}

main();
