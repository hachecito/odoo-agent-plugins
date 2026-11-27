'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluate } = require('../scripts/lib/memguard');

/**
 * Decision of the memory guard for a tool call.
 * @param {string} tool - tool name
 * @param {object} input - tool input
 * @param {{subagent?: boolean, active?: boolean}} [o] - subagent call, open memory session
 * @returns {string|null} ask, deny or null
 */
function decide(tool, input, o = {}) {
  const event = { tool_name: tool, tool_input: input, cwd: process.cwd(), ...(o.subagent ? { agent_id: 'a1' } : {}) };
  const r = evaluate(event, { sessionActive: () => o.active !== false });
  return r ? r.decision : null;
}
const bash = (command, o) => decide('Bash', { command }, o);
const sub = (command, o) => bash(command, { subagent: true, ...o });

test('direct edits of the stores ask; reads and look-alike paths are free', () => {
  for (const f of ['C:\\repo\\.oap\\memory\\entries\\tests\\p-20261126-7f3a.md', '/home/u/.oap/knowledge/entries/odoo/g-20261126-aa10.md',
    'C:/repo/.oap/memory/_index/catalog.jsonl', 'C:/repo/.oap/memory.md', 'C:/repo/.claude/odoosh-browser-notes.json']) {
    assert.strictEqual(decide('Write', { file_path: f }), 'ask', f);
    assert.strictEqual(decide('Edit', { file_path: f }), 'ask', f);
  }
  assert.strictEqual(decide('Write', { file_path: 'C:\\repo\\.oap\\memoryx.md' }), null);
  assert.strictEqual(decide('Write', { file_path: 'C:\\repo\\.oap\\odoosh-browser\\run.json' }), null);
  assert.strictEqual(bash('cat .oap/memory/entries/tests/p-20261126-7f3a.md'), null);
  assert.strictEqual(bash('sed -n 1,20p .oap/memory.md'), null);
  assert.strictEqual(bash('sed -i s/a/b/ .oap/memory.md'), 'ask');
  assert.strictEqual(bash('rm -rf .oap/memory/entries'), 'ask');
  assert.strictEqual(bash('echo x > ~/.oap/knowledge/entries/odoo/g-20261126-aa10.md'), 'ask');
  assert.strictEqual(decide('PowerShell', { command: 'Remove-Item -Recurse .oap\\memory\\entries' }), 'ask');
});

test('remove and migrate --apply/--rollback ask by any route; the rest gets no opinion (never allow)', () => {
  for (const c of ['node "C:/x/scripts/knowledge.js" remove g-20261126-aa10', 'node "C:/p/scripts/oap.js" knowledge remove p-20261126-7f3a',
    'node "C:/p/scripts/mem.js" remove p-20261126-7f3a', 'node knowledge.js migrate --apply', 'node "C:/p/scripts/mem.js" migrate --rollback 20261126-101010',
    'bash -c "node C:/x/knowledge.js remove g-20261126-aa10"']) {
    assert.strictEqual(bash(c), 'ask', c);
  }
  for (const c of ['node knowledge.js search "picking lotes"', 'node knowledge.js add --title x --summary y --category tests', 'node knowledge.js migrate',
    'node knowledge.js migrate --dry-run', 'node "C:/p/scripts/mem.js" context --task t.md', 'git status', 'npm test']) {
    assert.strictEqual(bash(c), null, c);
  }
});

test('subagents can read memory but not write it while a memory session is open', () => {
  for (const cmd of ['add --title x', 'update p-20261126-7f3a --status verified', 'deprecate p-1', 'remove p-1', 'reindex', 'migrate --apply', 'task-summary --folder f', 'session start --source x', 'session end']) {
    assert.strictEqual(sub(`node "C:/p/scripts/knowledge.js" ${cmd}`), 'deny', cmd);
    assert.strictEqual(sub(`node "C:/p/scripts/oap.js" knowledge ${cmd}`), 'deny', cmd);
    assert.strictEqual(sub(`node "C:/p/scripts/mem.js" ${cmd}`), 'deny', cmd);
  }
  assert.strictEqual(sub('node "C:/p/scripts/oap.js" notes.js add --text x'), 'deny');
  assert.strictEqual(sub('node "C:/p/scripts/mem.js" notes add --text x'), 'deny');
  for (const c of ['node "C:/p/scripts/knowledge.js" search "lotes"', 'node "C:/p/scripts/oap.js" knowledge.js get p-20261126-7f3a',
    'node "C:/p/scripts/mem.js" session report', 'node "C:/p/scripts/oap.js" notes show', 'node "C:/p/scripts/mem.js" context --text x']) {
    assert.strictEqual(sub(c), null, c);
  }
  // Without an open session (outside a plugin task) subagent writes are not this hook's business, as before.
  assert.strictEqual(sub('node "C:/p/scripts/knowledge.js" add --title x', { active: false }), null);
});

test('hook entry: silent on unrelated or broken input, JSON decision otherwise', () => {
  const run = (input) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'mem-guard.js')], { input, encoding: 'utf8' });
  for (const input of ['', 'not json', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })]) {
    const r = run(input);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
  const r = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/r/.oap/memory/entries/x/p-1.md' } }));
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});
