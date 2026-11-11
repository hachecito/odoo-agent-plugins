'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, FAILURE_HINT_EVERY_MS } = require('../scripts/lib/memory-hook');
const { loadRun } = require('../scripts/lib/run');
const { addNote } = require('../scripts/lib/notes');

/**
 * Create a temp repo with an active run.
 * @param {object} extra - extra run fields
 * @returns {{root: string, deps: object}} fixture
 */
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoosh-browser-'));
  fs.mkdirSync(path.join(root, '.oap', 'odoosh-browser'), { recursive: true });
  const run = { state: 'IMPLEMENTATION', started_at: new Date(Date.now() - 60000).toISOString(), history: [], evidence: [], ...extra };
  fs.writeFileSync(path.join(root, '.oap', 'odoosh-browser', 'run.json'), JSON.stringify(run));
  return { root, deps: { loadConfig: () => ({ root }) } };
}

test('stop hook: reminds once per run when nothing was recorded', () => {
  const { root, deps } = fixture();
  const first = decide({ hook_event_name: 'Stop', cwd: root }, deps);
  assert.strictEqual(first.decision, 'block');
  assert.ok(first.reason.includes('notes.js'));
  assert.strictEqual(loadRun(root).memory_reminded, true);
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: root }, deps), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stop hook: silent when memory was written, when already continuing, or without an active run', () => {
  const a = fixture();
  addNote(a.root, { text: 'Creía que X; en realidad Y' });
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: a.root }, a.deps), null);
  const b = fixture();
  assert.strictEqual(decide({ hook_event_name: 'Stop', stop_hook_active: true, cwd: b.root }, b.deps), null);
  const c = fixture({ state: 'COMPLETED' });
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: c.root }, c.deps), null);
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: a.root }, { loadConfig: () => null }), null);
  for (const f of [a, b, c]) fs.rmSync(f.root, { recursive: true, force: true });
});

test('failure hook: adds context at most once per interval', () => {
  const { root, deps } = fixture();
  const t = Date.now();
  const first = decide({ hook_event_name: 'PostToolUseFailure', cwd: root }, { ...deps, now: t });
  assert.ok(first.hookSpecificOutput.additionalContext.includes('notes.js'));
  assert.strictEqual(decide({ hook_event_name: 'PostToolUseFailure', cwd: root }, { ...deps, now: t + 1000 }), null);
  assert.ok(decide({ hook_event_name: 'PostToolUseFailure', cwd: root }, { ...deps, now: t + FAILURE_HINT_EVERY_MS + 1 }));
  fs.rmSync(root, { recursive: true, force: true });
});
