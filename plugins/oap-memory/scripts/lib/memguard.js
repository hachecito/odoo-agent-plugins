'use strict';
// Memory safeguards for every plugin that uses oap-memory. This hook only restricts (ask/deny) and never approves:
// Claude Code keeps the most restrictive decision of all PreToolUse hooks (checked with Claude Code 2.1.332).
const path = require('path');
const { splitCommand, programName } = require('./shell');

const ASK = 'ask';
const DENY = 'deny';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Project memory, global knowledge and the old-format notes (current and odoosh-browser <= 0.3 names).
const MEMORY_FILE = /(^|[\\/])\.oap[\\/]memory\.md$|(^|[\\/])\.oap[\\/](memory|knowledge)[\\/]|(^|[\\/])\.claude[\\/](odoosh-browser|odoo-agent)-notes\.json$/;
const MEMORY_PATH = /\.oap[\\/](memory\.md|memory[\\/]|knowledge[\\/])|(odoosh-browser|odoo-agent)-notes\.json/;
// Commands mentioning none of these words cannot touch the memory: the hook stays silent (it runs in every session).
const RELEVANT = /\.oap|knowledge|notes|mem\.js|oap\.js/i;
const WRITER_PROGRAMS = new Set(['tee', 'cp', 'mv', 'rm', 'del', 'copy', 'move', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'remove-item', 'new-item', 'sc', 'ac', 'ni']);
const KNOWLEDGE_WRITES = new Set(['add', 'update', 'deprecate', 'remove', 'reindex', 'migrate', 'task-summary', 'session']);
const NOTES_WRITES = new Set(['add', 'remove', 'migrate', 'migrate-legacy']);
const DECISION_RANK = { [DENY]: 2, [ASK]: 1 };

/**
 * Keep the most restrictive of several decisions.
 * @param {Array<object|null>} results - partial results
 * @returns {{decision: string, reason: string}|null} merged result
 */
function merge(results) {
  return results.filter(Boolean).sort((a, b) => DECISION_RANK[b.decision] - DECISION_RANK[a.decision])[0] || null;
}

/**
 * Resolve a cd target (also /c/... paths of Git Bash on Windows).
 * @param {string} base - current folder
 * @param {string} p - target
 * @returns {string} absolute folder
 */
function resolveDir(base, p) {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m && process.platform === 'win32') return path.resolve(`${m[1]}:${m[2] || '/'}`);
  return path.resolve(base, p);
}

/**
 * Find the memory command a segment runs: knowledge.js / notes.js, or through oap.js / mem.js.
 * @param {string[]} tokens - segment tokens
 * @returns {{tool: string, sub: string|undefined, args: string[]}|null} knowledge or notes command
 */
function memoryCommand(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const base = t.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (base === 'knowledge.js' || base === 'notes.js') return { tool: base.slice(0, -3), sub: tokens[i + 1], args: tokens.slice(i + 2) };
    if (base === 'oap.js' && /^(knowledge|notes)(\.js)?$/.test(tokens[i + 1] || '')) {
      return { tool: tokens[i + 1].replace(/\.js$/, ''), sub: tokens[i + 2], args: tokens.slice(i + 3) };
    }
    if (base === 'mem.js') {
      // mem.js forwards to knowledge.js, or to notes.js with "mem.js notes ...".
      if (tokens[i + 1] === 'notes') return { tool: 'notes', sub: tokens[i + 2], args: tokens.slice(i + 3) };
      return { tool: 'knowledge', sub: tokens[i + 1], args: tokens.slice(i + 2) };
    }
  }
  return null;
}

/**
 * Evaluate one shell segment.
 * @param {string[]} tokens - segment tokens (with .redirects)
 * @param {{subagent: boolean, sessionActive: function, dir: string}} ctx - context
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateSegment(tokens, ctx) {
  const results = [];
  const mc = memoryCommand(tokens);
  if (mc && mc.tool === 'knowledge') {
    if (mc.sub === 'remove' || (mc.sub === 'migrate' && mc.args.some((a) => a === '--apply' || a === '--rollback'))) {
      results.push({ decision: ASK, reason: `knowledge.js ${mc.sub}: confirm with the user.` });
    }
  }
  if (mc && ctx.subagent && ctx.sessionActive(ctx.dir)) {
    const writes = mc.tool === 'knowledge' ? KNOWLEDGE_WRITES : NOTES_WRITES;
    if (writes.has(mc.sub) && !(mc.tool === 'knowledge' && mc.sub === 'session' && ['status', 'report'].includes(mc.args[0]))) {
      results.push({ decision: DENY, reason: `${mc.tool}.js ${mc.sub} from a subagent blocked: hand the lesson back to the orchestrator, which records it.` });
    }
  }
  // Only real writes count: a redirection to a memory file or a writing program naming it (reading is free).
  const prog = programName(tokens[0] || '');
  const writer = WRITER_PROGRAMS.has(prog) || (prog === 'sed' && tokens.some((t) => /^(-i|--in-place)/.test(t) || /^-[a-zA-Z]*i/.test(t)));
  if ((tokens.redirects || []).some((t) => MEMORY_PATH.test(t)) || (writer && tokens.slice(1).some((t) => MEMORY_PATH.test(t)))) {
    results.push({ decision: ASK, reason: 'Changing the project memory or global knowledge from the shell: confirm (use knowledge.js).' });
  }
  // Nested shells (bash -c "...", powershell -Command "..."): evaluate the quoted command too.
  if ((ctx.depth || 0) < 3) {
    for (const t of tokens.slice(1)) {
      if (/\s/.test(t) && RELEVANT.test(t)) results.push(evaluateCommand(t, { ...ctx, depth: (ctx.depth || 0) + 1 }));
    }
  }
  return merge(results);
}

/**
 * Evaluate a shell command line.
 * @param {string} command - command line
 * @param {{subagent: boolean, sessionActive: function, dir: string, depth?: number}} ctx - context
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateCommand(command, ctx) {
  if (!RELEVANT.test(command)) return null;
  const results = [];
  let dir = ctx.dir;
  for (const tokens of splitCommand(command)) {
    const prog = programName(tokens[0] || '');
    const rest = tokens.slice(1).filter((t) => !t.startsWith('-'));
    if (['cd', 'set-location', 'pushd', 'sl'].includes(prog) && rest[0]) {
      dir = resolveDir(dir, rest[0]);
      continue;
    }
    results.push(evaluateSegment(tokens, { ...ctx, dir }));
  }
  return merge(results);
}

/**
 * Evaluate a PreToolUse event.
 * @param {object} event - hook input {tool_name, tool_input, cwd, agent_id}
 * @param {{sessionActive: function}} deps - sessionActive(dir) tells whether a memory session is open there
 * @returns {{decision: string, reason: string}|null} decision, null = no opinion
 */
function evaluate(event, deps) {
  const name = event.tool_name || '';
  const input = event.tool_input || {};
  if (FILE_TOOLS.has(name)) {
    const target = String(input.file_path || input.notebook_path || '');
    return MEMORY_FILE.test(target)
      ? { decision: ASK, reason: `Direct edit of ${path.basename(target)} in the memory: confirm with the user (use knowledge.js).` }
      : null;
  }
  if (SHELL_TOOLS.has(name)) {
    return evaluateCommand(String(input.command || ''), { subagent: Boolean(event.agent_id), sessionActive: deps.sessionActive, dir: event.cwd || process.cwd() });
  }
  return null;
}

module.exports = { evaluate, evaluateCommand, memoryCommand, ASK, DENY, MEMORY_FILE };
