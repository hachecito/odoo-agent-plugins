'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, FAILURE_HINT_EVERY_MS } = require('../scripts/lib/memory-hook');
const { loadSession, startSession, saveSession, endSession } = require('../scripts/lib/session');
const { addNote } = require('../scripts/lib/notes');

/**
 * Create a temp repo with an open memory session.
 * @param {object} extra - extra session fields
 * @returns {{root: string, deps: object}} fixture
 */
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-memory-'));
  fs.mkdirSync(path.join(root, '.oap'), { recursive: true });
  saveSession(root, { ...startSession(root, { source: 'odoosh-browser' }, Date.now() - 60000), ...extra });
  return { root, deps: { findRoot: () => root } };
}

test('stop hook: reminds once per session when nothing was recorded', () => {
  const { root, deps } = fixture();
  const first = decide({ hook_event_name: 'Stop', cwd: root }, deps);
  assert.strictEqual(first.decision, 'block');
  assert.ok(first.reason.includes('notes.js'));
  assert.strictEqual(loadSession(root).memory_reminded, true);
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: root }, deps), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stop hook: silent when memory was written, when already continuing, or without an open session', () => {
  const a = fixture();
  addNote(a.root, { text: 'Creía que X; en realidad Y' });
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: a.root }, a.deps), null);
  const b = fixture();
  assert.strictEqual(decide({ hook_event_name: 'Stop', stop_hook_active: true, cwd: b.root }, b.deps), null);
  const c = fixture();
  endSession(c.root);
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: c.root }, c.deps), null);
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: a.root }, { findRoot: () => null }), null);
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

test('failure hook: subagents are told to hand the lesson back, on their own interval', () => {
  const { root, deps } = fixture();
  const t = Date.now();
  const sub = decide({ hook_event_name: 'PostToolUseFailure', cwd: root, agent_id: 'a1' }, { ...deps, now: t });
  assert.ok(sub.hookSpecificOutput.additionalContext.includes('[LESSON]'));
  assert.strictEqual(decide({ hook_event_name: 'PostToolUseFailure', cwd: root, agent_id: 'a1' }, { ...deps, now: t + 1000 }), null);
  // The main thread's hint window is untouched
  assert.ok(decide({ hook_event_name: 'PostToolUseFailure', cwd: root }, { ...deps, now: t + 1000 }).hookSpecificOutput.additionalContext.includes('notes.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('stop hook: silent when an entry was added to the knowledge store during the session', () => {
  const { root, deps } = fixture({ items: [{ action: 'added', id: 'p-20261126-7f3a', title: 'x' }] });
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: root }, deps), null);
  const other = fixture({ items: [{ action: 'kept-in-project', id: 'p-20261126-7f3a', title: 'x' }] });
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: other.root }, other.deps).decision, 'block');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other.root, { recursive: true, force: true });
});

test('session: stale after 24 h of inactivity, so the hooks go quiet', () => {
  const { root, deps } = fixture();
  const later = Date.now() + 25 * 3600 * 1000;
  assert.strictEqual(decide({ hook_event_name: 'Stop', cwd: root }, { ...deps, now: later }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
