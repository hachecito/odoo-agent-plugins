'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../scripts/lib/policy');
const { DEFAULTS } = require('../scripts/lib/config');

const CONFIG = { ...DEFAULTS, staging_branch: 'staging-agent', production_branches: ['main'] };

/**
 * Run the policy with a fake config and current branch.
 * @param {string} tool - tool name
 * @param {object} input - tool input
 * @param {object} opts - {branch, config}
 * @returns {string|null} decision
 */
function decide(tool, input, opts = {}) {
  const config = opts.config === undefined ? CONFIG : opts.config;
  const res = evaluate(
    { tool_name: tool, tool_input: input, cwd: process.cwd() },
    {
      loadConfig: () => (config ? { config, root: '.', path: '.' } : null),
      branchOf: () => (opts.branch === undefined ? 'staging-agent' : opts.branch),
      runActive: () => opts.active !== false,
    },
  );
  return res ? res.decision : null;
}
const bash = (command, opts) => decide('Bash', { command }, opts);

test('no config: guard is passive', () => {
  assert.strictEqual(bash('git push --force origin main', { config: null }), null);
});

test('push to staging asks for confirmation', () => {
  assert.strictEqual(bash('git push origin staging-agent'), 'ask');
  assert.strictEqual(bash('git push -u origin HEAD'), 'ask');
  assert.strictEqual(bash('git push origin HEAD:refs/heads/staging-agent'), 'ask');
});

test('outside a plugin task only direct production pushes are blocked', () => {
  const idle = { active: false };
  assert.strictEqual(bash('git push origin main', idle), 'deny');
  assert.strictEqual(bash('git push --force origin main', idle), 'deny');
  assert.strictEqual(bash('git push origin feature:main', idle), 'deny');
  assert.strictEqual(bash('git push', { ...idle, branch: 'main' }), 'deny');
  assert.strictEqual(bash('git push --all', idle), 'deny');
  // Feature branches for PRs, force push to own branches, local work, SSH and browser are free.
  assert.strictEqual(bash('git push -u origin fix/mi-cambio', idle), null);
  assert.strictEqual(bash('git push', { ...idle, branch: 'fix/mi-cambio' }), null);
  assert.strictEqual(bash('git push --force-with-lease origin fix/mi-cambio', idle), null);
  assert.strictEqual(bash('git commit -m x', { ...idle, branch: 'main' }), null);
  assert.strictEqual(bash('git branch -D old', idle), null);
  assert.strictEqual(bash('ssh 1@myproject.odoo.com', idle), null);
  assert.strictEqual(decide('mcp__claude-in-chrome__navigate', { url: 'https://evil.example.com' }, idle), null);
  assert.strictEqual(decide('mcp__github__create_pull_request', { base: 'main' }, idle), null);
  assert.strictEqual(decide('mcp__github__merge_pull_request', { pullNumber: 1 }, idle), 'ask');
  // Guard config is still protected.
  assert.strictEqual(decide('Edit', { file_path: '/r/.claude/odoosh-browser.json' }, idle), 'ask');
});

test('during a task a feature branch push for a PR asks, production still denied', () => {
  assert.strictEqual(bash('git push -u origin fix/mi-cambio'), 'ask');
  assert.strictEqual(bash('git push origin fix/mi-cambio:main'), 'deny');
  assert.strictEqual(decide('mcp__github__create_pull_request', { base: 'main', head: 'fix/mi-cambio' }), null);
});

test('push without explicit refspec is denied', () => {
  assert.strictEqual(bash('git push'), 'deny');
  assert.strictEqual(bash('git push origin'), 'deny');
  assert.strictEqual(bash('git -c push.default=matching push origin staging-agent'), 'ask');
  assert.strictEqual(bash('git config push.default matching'), 'ask');
});

test('push to production or other branches is denied', () => {
  assert.strictEqual(bash('git push origin main'), 'deny');
  assert.strictEqual(bash('git push origin staging-agent:main'), 'deny');
  assert.strictEqual(bash('git push origin feature-x'), 'ask');
  assert.strictEqual(bash('git push origin HEAD', { branch: 'main' }), 'deny');
  assert.strictEqual(bash('git push origin staging-agent main'), 'deny');
});

test('config is resolved from the directory where git runs', () => {
  const path = require('path');
  const repo = path.resolve('/work/odoo/18/custom');
  const loadConfig = (dir) => (path.resolve(dir) === repo ? { config: CONFIG } : null);
  const run = (command, cwd) => {
    const r = evaluate({ tool_name: 'Bash', tool_input: { command }, cwd }, { loadConfig, branchOf: () => 'staging-agent', runActive: () => true });
    return r ? r.decision : null;
  };
  const parent = path.resolve('/work/odoo/18');
  assert.strictEqual(run('git push origin main', parent), null);
  assert.strictEqual(run('git -C custom push origin main', parent), 'deny');
  assert.strictEqual(run('cd custom && git push --force origin staging-agent', parent), 'deny');
  assert.strictEqual(run(`git -C "${repo}" push origin staging-agent`, parent), 'ask');
});

test('unknown current branch asks before commit/merge', () => {
  assert.strictEqual(bash('git commit -m x', { branch: null }), 'ask');
});

test('guard config cannot be changed silently', () => {
  assert.strictEqual(decide('Write', { file_path: 'C:\\repo\\.claude\\odoosh-browser.json' }, { config: null }), 'ask');
  assert.strictEqual(decide('Edit', { file_path: '/repo/.claude/odoosh-browser.json' }), 'ask');
  assert.strictEqual(decide('Edit', { file_path: '/repo/models/sale.py' }), null);
  assert.strictEqual(bash('node "C:/x/scripts/config.js" set-staging main'), 'ask');
  assert.strictEqual(bash('node C:/x/scripts/config.js init --staging stg', { config: null }), 'ask');
  assert.strictEqual(bash('node C:/x/scripts/config.js show'), null);
  assert.strictEqual(bash('echo {} > .claude/odoosh-browser.json'), 'ask');
  assert.strictEqual(decide('PowerShell', { command: 'Set-Content .claude\\odoosh-browser.json "{}"' }), 'ask');
});

test('push without staging branch configured is denied', () => {
  assert.strictEqual(bash('git push origin x', { config: { ...CONFIG, staging_branch: null } }), 'deny');
});

test('force and delete variants are denied', () => {
  for (const cmd of [
    'git push --force origin staging-agent',
    'git push -f',
    'git push -uf origin staging-agent',
    'git push --force-with-lease',
    'git push origin +staging-agent',
    'git push origin :staging-agent',
    'git push --delete origin staging-agent',
    'git push --mirror',
    'git push --all',
    'git branch -D staging-agent',
    'git branch -d old',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git filter-branch --all',
  ]) assert.strictEqual(bash(cmd), 'deny', cmd);
});

test('chained, -C and nested shells are parsed', () => {
  assert.strictEqual(bash('git add . && git commit -m "x" && git push origin main'), 'deny');
  assert.strictEqual(bash('cd repo; git -C sub push --force'), 'deny');
  assert.strictEqual(decide('PowerShell', { command: 'git status; git push origin main' }), 'deny');
  assert.strictEqual(bash('bash -c "git push origin main"'), 'deny');
  assert.strictEqual(bash('cmd /c "git push -f"'), 'deny');
  assert.strictEqual(bash('"C:\\Program Files\\Git\\cmd\\git.exe" push origin main'), 'deny');
});

test('commits/merges on production branch are denied', () => {
  assert.strictEqual(bash('git commit -m "fix"', { branch: 'main' }), 'deny');
  assert.strictEqual(bash('git merge staging-agent', { branch: 'main' }), 'deny');
  assert.strictEqual(bash('git commit -m "fix"'), null);
  assert.strictEqual(bash('git merge origin/main'), 'ask');
});

test('harmless commands pass', () => {
  for (const cmd of ['git status', 'git log --grep push', 'git diff', 'git commit -m "fix push button"', 'node -v', 'git checkout staging-agent']) {
    assert.strictEqual(bash(cmd), null, cmd);
  }
});

test('commands that may discard user changes ask', () => {
  assert.strictEqual(bash('git checkout -- models/sale.py'), 'ask');
  assert.strictEqual(bash('git restore .'), 'ask');
  assert.strictEqual(bash('git stash drop'), 'ask');
});

test('ssh: production hosts and dangerous remote commands are denied', () => {
  assert.strictEqual(bash('ssh 123@proj-staging-123.dev.odoo.com "tail -n 100 ~/logs/odoo.log"'), null);
  assert.strictEqual(bash('ssh 123@myproject.odoo.com'), 'deny');
  assert.strictEqual(bash('ssh 123@proj-staging-123.dev.odoo.com odoosh-push'), 'deny');
  assert.strictEqual(bash('ssh -o BatchMode=yes 123@x.dev.odoo.com "psql -c \\"DELETE FROM res_partner\\""'), 'deny');
  assert.strictEqual(bash('ssh 123@x.dev.odoo.com "rm -rf ~/src"'), 'deny');
});

test('GitHub MCP writes and Composio remote exec are denied', () => {
  assert.strictEqual(decide('mcp__github__merge_pull_request', { pullNumber: 1 }), 'deny');
  assert.strictEqual(decide('mcp__github__push_files', {}), 'deny');
  assert.strictEqual(decide('mcp__github__get_commit', {}), null);
  assert.strictEqual(decide('mcp__composio__COMPOSIO_REMOTE_BASH_TOOL', {}), 'deny');
});

test('Claude in Chrome: domains and terminal text', () => {
  const t = 'mcp__claude-in-chrome__navigate';
  assert.strictEqual(decide(t, { url: 'https://www.odoo.sh/project/x/branches' }), null);
  assert.strictEqual(decide(t, { url: 'https://github.com/org/repo' }), null);
  assert.strictEqual(decide(t, { url: 'https://evil.example.com/steal' }), 'ask');
  assert.strictEqual(decide(t, { url: 'https://proj-staging-1.dev.odoo.com/odoo-sh/editor/lab' }), null);
  assert.strictEqual(decide(t, { url: 'https://www.odoo.com/documentation/18.0/' }), null);
  assert.strictEqual(decide(t, { url: 'https://miempresa.odoo.com/odoo/sales' }), 'deny');
  assert.strictEqual(decide('mcp__claude-in-chrome__computer', { action: 'type', text: 'odoosh-push' }), 'deny');
  assert.strictEqual(decide('mcp__claude-in-chrome__javascript_tool', { code: '1+1' }), 'ask');
});
