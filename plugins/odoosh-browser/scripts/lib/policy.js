'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitCommand, programName } = require('./shell');

const DENY = 'deny';
const ASK = 'ask';
const ALLOW = 'allow';

const GITHUB_WRITE_TOOLS = new Set([
  'merge_pull_request', 'push_files', 'create_or_update_file', 'delete_file', 'create_branch',
  'update_pull_request_branch', 'delete_repository', 'fork_repository', 'create_repository',
]);
const REMOTE_EXEC_TOOLS = /^mcp__composio__COMPOSIO_(REMOTE_BASH_TOOL|REMOTE_WORKBENCH|MULTI_EXECUTE_TOOL)$/;
const CHROME_TOOL = /^mcp__(plugin_[^_]+_)?claude-in-chrome__/;
// Other browser MCPs open a browser without the user's session and skip the Chrome rules.
const OTHER_BROWSER_TOOL = /^mcp__.*(chrome[-_]devtools|playwright|puppeteer|browsermcp|browser[-_]use|browserbase)/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Guard config, learned notes and the knowledge stores (.oap/memory/, ~/.oap/knowledge/) may only change through
// their scripts or with user confirmation. Current and legacy (plugin <= 0.3) names are both protected.
const CONFIG_FILE = /(^|[\\/])(\.oap[\\/](memory\.md|odoosh-browser[\\/]config\.json)|\.claude[\\/](odoosh-browser|odoo-agent)(-notes)?\.json)$|(^|[\\/])\.oap[\\/](memory|knowledge)[\\/]/;
const PROTECTED_PATH = /(\.oap[\\/](memory\.md|odoosh-browser[\\/]config\.json|memory[\\/]|knowledge[\\/])|(odoosh-browser|odoo-agent)(-notes)?\.json)/;
// Programs that write, copy, move or delete the file named in their arguments.
const WRITER_PROGRAMS = new Set(['tee', 'cp', 'mv', 'rm', 'del', 'copy', 'move', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'remove-item', 'new-item', 'sc', 'ac', 'ni']);
// Yolo mode: these scripts of the Odoo agent plugins run without a prompt, only from a real plugin root (see trustedRoots).
const YOLO_SCRIPTS = new Set(['run-state.js', 'notes.js', 'knowledge.js', 'report.js', 'ssh-check.js', 'config.js', 'oap.js', 'tasks.js', 'hotpatch.js', 'diag.js']);
let trustedRootsCache = null;

/**
 * Plugin roots whose scripts yolo mode trusts: this plugin, its sibling odoo-squad and their marketplace installs.
 * A folder that merely has the same name (e.g. written inside the client repo) is not trusted.
 * @returns {string[]} normalized absolute roots
 */
function trustedRoots() {
  if (trustedRootsCache) return trustedRootsCache;
  const own = path.resolve(__dirname, '..', '..');
  const roots = [own, path.resolve(own, '..', 'odoo-squad')];
  try {
    const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, entries] of Object.entries(installed.plugins || {})) {
      if (/^(odoosh-browser|odoo-squad)@/.test(key)) for (const e of entries) if (e.installPath) roots.push(path.resolve(e.installPath));
    }
  } catch {
    // No marketplace install: only the checkout roots are trusted.
  }
  trustedRootsCache = roots.map((r) => (process.platform === 'win32' ? r.toLowerCase() : r));
  return trustedRootsCache;
}

/**
 * Tell whether a node script argument is an allowlisted script inside a trusted plugin root.
 * @param {string} token - script path as written in the command
 * @param {string} dir - directory the command runs in
 * @returns {boolean} true if trusted
 */
function isTrustedPluginScript(token, dir) {
  let abs = resolveDir(dir, token);
  if (!YOLO_SCRIPTS.has(path.basename(abs))) return false;
  if (process.platform === 'win32') abs = abs.toLowerCase();
  return trustedRoots().some((root) => path.dirname(abs) === path.join(root, 'scripts'));
}
// Read-only filters allowed next to a plugin script or an ssh call in yolo mode.
const SAFE_FILTERS = new Set(['grep', 'tail', 'head', 'wc', 'sort', 'uniq', 'cut', 'echo', 'select-object', 'select-string']);
const NULL_DEVICES = new Set(['/dev/null', '$null', 'nul']);
// Odoo.sh public hosts that are not customer instances.
const ODOO_PUBLIC_HOSTS = new Set(['odoo.com', 'www.odoo.com']);

// Commands that must never run on an Odoo.sh build (terminal, SSH or browser terminal).
const REMOTE_DENY = [
  { re: /\bodoosh-push\b/i, why: 'odoosh-push uploads commits from the build to the repository.' },
  { re: /\bgit\s+push\b/i, why: 'git push from the build is not allowed.' },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'rm -rf is not allowed.' },
  { re: /\bdropdb\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b/i, why: 'destructive database operation.' },
  { re: /\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b|\bALTER\s+TABLE\b/i, why: 'direct SQL writes are not allowed.' },
];

/**
 * Combine decisions keeping the most restrictive one (deny > ask > none).
 * @param {Array<{decision: string, reason: string}|null>} results - partial results
 * @returns {{decision: string, reason: string}|null} merged result
 */
function strictest(results) {
  const list = results.filter(Boolean);
  const deny = list.filter((r) => r.decision === DENY);
  if (deny.length) return { decision: DENY, reason: deny.map((r) => r.reason).join(' ') };
  const ask = list.filter((r) => r.decision === ASK);
  // A merged ask can be auto-approved in yolo mode only if every part of it can.
  if (ask.length) return { decision: ASK, reason: ask.map((r) => r.reason).join(' '), yolo: ask.every((r) => r.yolo) };
  return null;
}

/**
 * Build an ask that yolo mode may auto-approve when the project enabled it.
 * @param {object} config - project config
 * @param {string} reason - reason shown to the user
 * @returns {{decision: string, reason: string, yolo: boolean}} decision
 */
function yoloAsk(config, reason) {
  return { decision: ASK, reason, yolo: Boolean(config.autonomy && config.autonomy.yolo === true) };
}

/**
 * Resolve a directory argument, accepting Git Bash style paths (/c/Users/...).
 * @param {string} base - current directory
 * @param {string} p - path argument
 * @returns {string} absolute path
 */
function resolveDir(base, p) {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m && process.platform === 'win32') return path.resolve(`${m[1]}:${m[2] || '/'}`);
  return path.resolve(base, p);
}

/**
 * Normalize a ref name (refs/heads/x -> x).
 * @param {string} ref - ref or branch name
 * @returns {string} short branch name
 */
function shortRef(ref) {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Check whether a token is a short-option cluster containing a given letter (e.g. -uf has f).
 * @param {string} tok - token
 * @param {string} letter - option letter
 * @returns {boolean} true if present
 */
function hasShortFlag(tok, letter) {
  return /^-[a-zA-Z]+$/.test(tok) && tok.slice(1).includes(letter);
}

/**
 * Decide whether a host looks like an Odoo.sh production instance (not verified by Odoo docs:
 * dev/staging builds use *.dev.odoo.com, other customer *.odoo.com hosts are treated as production).
 * @param {string} host - hostname
 * @param {object} config - project config
 * @returns {boolean} true if it must be treated as production
 */
function isProductionHost(host, config) {
  const h = host.toLowerCase();
  const extra = ((config.ssh && config.ssh.production_hosts) || []).map((x) => x.toLowerCase());
  if (extra.includes(h)) return true;
  if (ODOO_PUBLIC_HOSTS.has(h) || /\.dev\.odoo\.com$/.test(h)) return false;
  return /\.odoo\.com$/.test(h);
}

/**
 * Split `git push` arguments into flags and refspecs.
 * @param {string[]} args - tokens after "push"
 * @returns {{force: boolean, destructive: string|null, tags: boolean, refspecs: string[]}} parsed push
 */
function parsePush(args) {
  const positional = [];
  let force = false;
  let destructive = null;
  let tags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--force(-with-lease|-if-includes)?(=.*)?$/.test(a) || hasShortFlag(a, 'f')) { force = true; continue; }
    if (a === '--delete' || hasShortFlag(a, 'd') || a === '--mirror' || a === '--all' || a === '--branches' || a === '--prune') {
      destructive = destructive || a;
      continue;
    }
    if (a === '--tags') { tags = true; continue; }
    if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  return { force, destructive, tags, refspecs: positional.slice(1) };
}

/**
 * Resolve the destination branch of a refspec (src:dst, +dst, :dst, HEAD).
 * @param {string} spec - refspec
 * @param {object} ctx - {branchOf(dir), dir}
 * @returns {string|null} destination branch, or null if unknown
 */
function refspecTarget(spec, ctx) {
  let dst = spec.replace(/^\+/, '');
  dst = dst.includes(':') ? dst.split(':').pop() : dst;
  if (dst === 'HEAD' || dst === '@') return ctx.branchOf(ctx.dir);
  return shortRef(dst);
}

/**
 * Outside a plugin task only direct pushes to production are blocked.
 * @param {string[]} args - tokens after "push"
 * @param {object} ctx - {config, branchOf(dir), dir}
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluatePushIdle(args, ctx) {
  const prod = ctx.config.production_branches;
  const { destructive, refspecs } = parsePush(args);
  if (['--mirror', '--all', '--branches'].includes(destructive)) {
    return { decision: DENY, reason: `git push ${destructive} may include the production branch.` };
  }
  const targets = refspecs.length ? refspecs.map((s) => refspecTarget(s, ctx)) : [ctx.branchOf(ctx.dir)];
  const hit = targets.find((t) => t && prod.includes(t));
  if (hit) return { decision: DENY, reason: `Direct push to the production branch "${hit}" blocked: on Odoo.sh it deploys to the client. Use a branch and a PR.` };
  if (targets.includes(null)) return { decision: ASK, reason: 'Could not determine the push target branch: confirm it is not production.' };
  return null;
}

/**
 * Evaluate a `git push` invocation during a plugin task.
 * @param {string[]} args - tokens after "push"
 * @param {object} ctx - {config, branchOf(dir), dir}
 * @returns {{decision: string, reason: string}} decision
 */
function evaluatePush(args, ctx) {
  const { config } = ctx;
  const { force, destructive, tags, refspecs } = parsePush(args);
  if (force) return { decision: DENY, reason: 'Force push blocked by odoosh-browser.' };
  if (destructive) return { decision: DENY, reason: `git push ${destructive} blocked (it can delete or overwrite remote branches).` };

  if (!refspecs.length) {
    // Without a refspec the destination depends on push.default/upstream config: require it explicitly.
    return { decision: DENY, reason: `Name the remote and branch explicitly: git push origin ${config.staging_branch || '<staging-branch>'}.` };
  }
  const targets = [];
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return { decision: DENY, reason: `Forced refspec "${spec}" blocked.` };
    if (spec.startsWith(':')) return { decision: DENY, reason: `Remote branch deletion "${spec}" blocked.` };
    let dst = spec.includes(':') ? spec.split(':').pop() : spec;
    if (dst === 'HEAD' || dst === '@') {
      const current = ctx.branchOf(ctx.dir);
      if (!current) return { decision: ASK, reason: 'Could not determine the current branch for the push.' };
      dst = current;
    }
    targets.push(shortRef(dst));
  }

  for (const t of targets) {
    if (config.production_branches.includes(t)) {
      return { decision: DENY, reason: `Push to the production branch "${t}" is forbidden.` };
    }
  }
  if (!config.staging_branch) {
    return { decision: DENY, reason: 'No staging_branch set in .oap/odoosh-browser/config.json: ask the user for the staging branch before pushing.' };
  }
  const others = targets.filter((t) => t !== config.staging_branch);
  if (others.length) {
    // Feature branches (e.g. for a PR against production) are allowed after confirmation.
    return { decision: ASK, reason: `Push to a branch other than the staging "${config.staging_branch}" (target: ${others.join(', ')}): confirm.` };
  }
  // Opt-in per project: a plain push to the staging branch is not questioned. Tags still ask; production is denied above.
  if (!tags && config.autonomy && config.autonomy.push_staging === 'auto' && !config.autonomy.yolo) return null;
  return yoloAsk(config, `Confirm push to the staging branch "${config.staging_branch}"${tags ? ' (includes tags)' : ''}.`);
}

/**
 * Evaluate a git invocation (tokens after the git program).
 * @param {string[]} tokens - tokens after "git"
 * @param {object} ctx - {loadConfig(dir), branchOf(dir), dir}
 * @returns {{decision: string, reason: string}|null} decision or null if allowed
 */
function evaluateGit(tokens, ctx) {
  let dir = ctx.dir;
  let i = 0;
  let pushConfig = false;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i];
    if (t === '-C' && tokens[i + 1]) { dir = resolveDir(dir, tokens[i + 1]); i += 2; continue; }
    if (t === '-c' && tokens[i + 1]) { if (/^(push|remote)\./i.test(tokens[i + 1])) pushConfig = true; i += 2; continue; }
    i++;
  }
  const loaded = ctx.loadConfig(dir);
  if (!loaded) return null; // Guard only applies inside repos with the plugin config
  const config = loaded.config;
  const sub = tokens[i];
  const args = tokens.slice(i + 1);
  const local = { ...ctx, config, dir };
  if (!sub) return null;
  // Outside an active plugin task the user works freely; only direct pushes to production are blocked.
  if (!ctx.runActive(loaded.root)) return sub === 'push' ? evaluatePushIdle(args, local) : null;
  if (pushConfig) return { decision: ASK, reason: 'git -c push.*/remote.* changes where pushes go: confirm.' };

  // Squad rule: subagents hand their changes back; only the main thread commits and pushes.
  if (ctx.subagent && (sub === 'push' || sub === 'commit')) {
    return { decision: DENY, reason: `git ${sub} from a subagent blocked: only the main thread (orchestrator) commits and pushes.` };
  }
  switch (sub) {
    case 'push':
      return evaluatePush(args, local);
    case 'config':
      if (args.some((a) => /^(push|remote|branch)\./i.test(a))) {
        return { decision: ASK, reason: 'Changing push/remote/branch configuration: confirm.' };
      }
      return null;
    case 'branch':
      if (args.some((a) => a === '--delete' || hasShortFlag(a, 'd') || hasShortFlag(a, 'D'))) {
        return { decision: DENY, reason: 'Deleting branches is forbidden.' };
      }
      if (args.some((a) => hasShortFlag(a, 'm') || hasShortFlag(a, 'M') || a === '--move' || hasShortFlag(a, 'f') || a === '--force')) {
        return { decision: ASK, reason: 'Renaming or overwriting branches needs confirmation.' };
      }
      return null;
    case 'reset':
      if (args.includes('--hard')) return { decision: DENY, reason: 'git reset --hard can erase the user\'s changes.' };
      return null;
    case 'clean':
      if (args.some((a) => hasShortFlag(a, 'f') || a === '--force')) return { decision: DENY, reason: 'git clean -f deletes untracked files.' };
      return null;
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
      return { decision: DENY, reason: `git ${sub} rewrites history or references.` };
    case 'checkout':
    case 'restore':
      if (sub === 'restore' || args.includes('--') || args.includes('.') || args.some((a) => hasShortFlag(a, 'f') || a === '--force')) {
        return { decision: ASK, reason: `git ${sub} can discard the user's local changes.` };
      }
      return null;
    case 'stash':
      if (['drop', 'clear'].includes(args[0])) return { decision: ASK, reason: `git stash ${args[0]} removes stashed changes.` };
      return null;
    case 'commit':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'am':
    case 'pull': {
      const branch = ctx.branchOf(dir);
      if (!branch) return { decision: ASK, reason: `Could not determine the current branch before git ${sub}: confirm.` };
      if (config.production_branches.includes(branch)) {
        return { decision: DENY, reason: `Current branch "${branch}" is a production branch: ${sub} is not allowed on it.` };
      }
      if (sub === 'merge' && args.some((a) => config.production_branches.includes(shortRef(a.replace(/^origin\//, ''))))) {
        return { decision: ASK, reason: 'Merge from a production branch: confirm.' };
      }
      return null;
    }
    case 'remote':
      if (['add', 'set-url', 'rename', 'remove', 'rm'].includes(args[0])) {
        return { decision: ASK, reason: `git remote ${args[0]} changes the push targets.` };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Check a text that will run on a remote Odoo.sh build.
 * @param {string} text - remote command or typed terminal text
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateRemoteText(text) {
  const hit = REMOTE_DENY.find((r) => r.re.test(text));
  if (hit) return { decision: DENY, reason: `Remote command blocked: ${hit.why}` };
  return evaluateOdooShell(text);
}

/**
 * Check an odoo-bin shell run: its script must travel inline in base64 so it can be read here.
 * @param {string} text - remote command or typed terminal text
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateOdooShell(text) {
  if (!/\bodoo-bin\s+shell\b/i.test(text)) return null;
  const payloads = text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || [];
  if (!payloads.length) {
    return { decision: ASK, reason: 'odoo-bin shell without the base64 script inside the command: it cannot be checked; confirm.' };
  }
  for (const p of payloads) {
    const code = Buffer.from(p, 'base64').toString('utf8');
    if (/\bcommit\s*\(|auto_commit\s*=\s*True/.test(code)) {
      return { decision: DENY, reason: 'The odoo-bin shell script commits: diagnostics are read-only (without a commit the shell rolls everything back at the end).' };
    }
    const hit = REMOTE_DENY.find((r) => r.re.test(code));
    if (hit) return { decision: DENY, reason: `odoo-bin shell script blocked: ${hit.why}` };
  }
  return null;
}

/**
 * Find the destination host of an ssh invocation.
 * @param {string[]} args - ssh arguments
 * @returns {{host: string|null, i: number}} lowercase host and index of the destination token
 */
function sshTarget(args) {
  const withValue = new Set(['-i', '-p', '-o', '-l', '-F', '-J', '-L', '-R', '-D', '-E', '-b', '-c', '-m', '-O', '-Q', '-S', '-W', '-w', '-e', '-I', '-B']);
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += withValue.has(args[i]) ? 2 : 1;
  return { host: args[i] ? args[i].split('@').pop().toLowerCase() : null, i };
}

/**
 * Evaluate an ssh invocation (tokens after "ssh"). Only applies during an active plugin task.
 * @param {string[]} args - ssh arguments
 * @param {object} ctx - {loadConfig(dir), runActive(root), dir}
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateSsh(args, ctx) {
  const { host, i } = sshTarget(args);
  if (!host) return null;
  if (!/\.odoo\.com$/.test(host)) return null;
  const loaded = ctx.loadConfig(ctx.dir);
  if (!loaded || !ctx.runActive(loaded.root)) return null;
  const config = loaded.config;
  if (isProductionHost(host, config)) {
    return { decision: DENY, reason: `SSH to "${host}" blocked: it is treated as production (only *.dev.odoo.com builds are allowed).` };
  }
  const remote = args.slice(i + 1).join(' ');
  return remote ? evaluateRemoteText(remote) : null;
}

/**
 * Detect commands that would modify the guard's own config file.
 * @param {string[]} tokens - segment tokens
 * @param {string} raw - raw segment text
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateConfigWrite(tokens) {
  const isConfigCli = tokens.some((t) => /(^|[\\/])config\.js$/.test(t)) && tokens.some((t) => ['init', 'set-staging', 'set-ssh', 'set-autonomy', 'migrate'].includes(t));
  if (isConfigCli) return { decision: ASK, reason: 'Change to the plugin configuration (staging/production branch, SSH, autonomy or file migration): confirm with the user.' };
  // Removing knowledge (also an entry promoted to every project) or migrating memory always asks the user.
  const kIdx = tokens.findIndex((t, i) => /(^|[\\/])knowledge\.js$/.test(t) || (t === 'knowledge' && /(^|[\\/])oap\.js$/.test(tokens[i - 1] || '')));
  if (kIdx >= 0 && ['remove', 'migrate'].includes(tokens[kIdx + 1]) && !(tokens[kIdx + 1] === 'migrate' && tokens.includes('--dry-run'))) {
    return { decision: ASK, reason: `knowledge.js ${tokens[kIdx + 1]}: confirm with the user.` };
  }
  // Only real writes count: a redirection to the file or a writing program naming it (reading it with cat is free).
  const redirected = (tokens.redirects || []).some((t) => PROTECTED_PATH.test(t));
  const prog = programName(tokens[0]);
  const writer = WRITER_PROGRAMS.has(prog) || (prog === 'sed' && tokens.some((t) => /^(-i|--in-place)/.test(t) || /^-[a-zA-Z]*i/.test(t)));
  const written = writer && tokens.slice(1).some((t) => PROTECTED_PATH.test(t));
  if (redirected || written) {
    return { decision: ASK, reason: 'Changing the plugin configuration or notes from the shell: confirm.' };
  }
  return null;
}

const RUN_WRITE_CMDS = new Set(['init', 'state', 'evidence', 'cycle', 'close']);
const NOTES_WRITE_CMDS = new Set(['add', 'remove', 'migrate']);
const KNOWLEDGE_WRITE_CMDS = new Set(['add', 'update', 'deprecate', 'remove', 'reindex', 'migrate']);

/**
 * Detect a subagent writing the run state, the shared memory or the knowledge stores (directly or through oap.js).
 * @param {string[]} tokens - segment tokens
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateSubagentStateWrite(tokens) {
  for (let i = 0; i < tokens.length - 1; i++) {
    const m = /(^|[\\/])(run-state|notes|knowledge)(\.js)?$/.exec(tokens[i]);
    if (!m || (!m[3] && !/(^|[\\/])oap\.js$/.test(tokens[i - 1] || ''))) continue;
    const writes = { 'run-state': RUN_WRITE_CMDS, notes: NOTES_WRITE_CMDS, knowledge: KNOWLEDGE_WRITE_CMDS }[m[2]];
    if (writes.has(tokens[i + 1])) {
      return { decision: DENY, reason: `${m[2]}.js ${tokens[i + 1]} from a subagent blocked: hand the evidence or lesson back to the orchestrator, which records it.` };
    }
  }
  return null;
}

/**
 * Tell whether a shell command only runs the plugins' own scripts, ssh to dev builds and read-only filters.
 * Used by yolo mode to skip Claude Code's own permission prompt for them.
 * @param {string} command - command line
 * @param {string} dir - directory the command runs in
 * @returns {boolean} true if every segment is one of those
 */
function isYoloSafeCommand(command, dir = process.cwd()) {
  const segments = splitCommand(command);
  let core = false;
  for (const tokens of segments) {
    const prog = programName(tokens[0]);
    if ((tokens.redirects || []).some((t) => !NULL_DEVICES.has(t.toLowerCase()))) return false;
    if (prog === 'node' && tokens[1] && isTrustedPluginScript(tokens[1], dir)) { core = true; continue; }
    if (prog === 'ssh') {
      const { host } = sshTarget(tokens.slice(1));
      if (!host || !/\.dev\.odoo\.com$/.test(host)) return false;
      core = true;
      continue;
    }
    if (['cd', 'set-location'].includes(prog) || SAFE_FILTERS.has(prog)) continue;
    return false;
  }
  return core;
}

/**
 * Evaluate one shell command line (bash, PowerShell or cmd).
 * @param {string} command - command line
 * @param {object} ctx - {loadConfig(dir), branchOf(dir), dir}
 * @param {number} depth - recursion depth for nested shells
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateCommand(command, ctx, depth = 0) {
  const results = [];
  let dir = ctx.dir;
  if (!ctx.seen) ctx = { ...ctx, seen: { push: false } };
  for (const tokens of splitCommand(command)) {
    const prog = programName(tokens[0]);
    const rest = tokens.slice(1);
    if ((prog === 'cd' || prog === 'set-location' || prog === 'pushd' || prog === 'sl') && rest[0]) {
      dir = resolveDir(dir, rest.filter((t) => !t.startsWith('-'))[0] || '.');
      continue;
    }
    const local = { ...ctx, dir };
    results.push(evaluateConfigWrite(tokens));
    if (ctx.subagent) {
      const loaded = ctx.loadConfig(dir);
      if (loaded && ctx.runActive(loaded.root)) results.push(evaluateSubagentStateWrite(tokens));
    }
    if (prog === 'git') {
      if (rest.includes('push')) ctx.seen.push = true;
      results.push(evaluateGit(rest, local));
    } else if (prog === 'ssh') results.push(evaluateSsh(rest, local));
    // Nested shells: bash -c "...", powershell -Command "...", cmd /c "..."
    if (depth < 3 && ['bash', 'sh', 'powershell', 'pwsh', 'cmd'].includes(prog)) {
      for (const t of rest) if (/\s/.test(t)) results.push(evaluateCommand(t, local, depth + 1));
    }
  }
  const merged = strictest(results);
  // A push-like text that the parser did not recognize as a git push is suspicious.
  if (!merged && depth === 0 && !ctx.seen.push && ctx.loadConfig(dir) && /\bgit(\.exe)?["']?(\s+-\S+(\s+\S+)?)*\s+push\b/i.test(command)) {
    return { decision: ASK, reason: 'Possible git push that could not be parsed: confirm.' };
  }
  return merged;
}

/**
 * Collect every string value inside a tool input object.
 * @param {*} value - any JSON value
 * @param {string[]} out - accumulator
 * @returns {string[]} strings found
 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

/**
 * Check whether a host belongs to an allowed domain.
 * @param {string} host - hostname
 * @param {string[]} domains - allowed base domains
 * @returns {boolean} true if allowed
 */
function hostAllowed(host, domains) {
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

/**
 * Evaluate a Claude in Chrome tool call (best effort, tool names not hardcoded).
 * @param {string} toolName - full tool name
 * @param {object} toolInput - tool input
 * @param {object} ctx - {config}
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateChrome(toolName, toolInput, ctx) {
  const results = [];
  for (const s of collectStrings(toolInput)) {
    for (const m of s.matchAll(/https?:\/\/([^/\s:"'?#]+)/gi)) {
      const host = m[1].toLowerCase();
      if (isProductionHost(host, ctx.config)) {
        results.push({ decision: DENY, reason: `Navigation to ${host} blocked: it is treated as a production instance.` });
      } else if (!hostAllowed(host, ctx.config.allowed_domains)) {
        results.push({ decision: ASK, reason: `Navigation to a domain not allowed: ${host}.` });
      }
    }
    results.push(evaluateRemoteText(s));
  }
  if (/javascript|evaluate|execute_script/i.test(toolName)) {
    results.push(yoloAsk(ctx.config, 'Running JavaScript in the browser: confirm.'));
  }
  return strictest(results);
}

/**
 * Main policy entry point for a PreToolUse event.
 * @param {object} event - hook input {tool_name, tool_input, cwd}
 * @param {object} deps - {loadConfig(dir), branchOf(dir), runActive(root)}
 * @returns {{decision: string, reason: string}|null} decision, null = no opinion
 */
function evaluate(event, deps) {
  const result = evaluateRules(event, deps);
  if (result && result.decision !== ASK) return result;
  const cwd = event.cwd || process.cwd();
  const loaded = deps.loadConfig(cwd);
  const yolo = Boolean(loaded && loaded.config.autonomy && loaded.config.autonomy.yolo === true && deps.runActive(loaded.root));
  if (!yolo) return result;
  // Yolo mode (opt-in, active task only): approve asks marked as yolo-safe; config changes, unknown domains,
  // other branches and anything unparsed keep asking, and deny always wins.
  if (result) return result.yolo ? { decision: ALLOW, reason: `Yolo mode: ${result.reason}` } : result;
  const name = event.tool_name || '';
  if (CHROME_TOOL.test(name)) return { decision: ALLOW, reason: 'Yolo mode: Claude in Chrome on an allowed domain.' };
  if (SHELL_TOOLS.has(name) && isYoloSafeCommand(String((event.tool_input || {}).command || ''), cwd)) {
    return { decision: ALLOW, reason: 'Yolo mode: plugin script or ssh to a development/staging build.' };
  }
  return null;
}

/**
 * Apply the safety rules to a PreToolUse event (no yolo handling).
 * @param {object} event - hook input {tool_name, tool_input, cwd, agent_id}
 * @param {object} deps - {loadConfig(dir), branchOf(dir), runActive(root)}
 * @returns {{decision: string, reason: string, yolo?: boolean}|null} decision, null = no opinion
 */
function evaluateRules(event, deps) {
  const cwd = event.cwd || process.cwd();
  const name = event.tool_name || '';
  const input = event.tool_input || {};

  if (FILE_TOOLS.has(name)) {
    const target = String(input.file_path || input.notebook_path || '');
    return CONFIG_FILE.test(target)
      ? { decision: ASK, reason: `Direct edit of ${path.basename(target)}: confirm with the user (use config.js / notes.js).` }
      : null;
  }
  // Shell commands resolve the config per directory (git -C, cd), so they are not gated on cwd.
  if (SHELL_TOOLS.has(name)) {
    // agent_id is only present when the call comes from a subagent (Claude Code hooks reference).
    return evaluateCommand(String(input.command || ''), { loadConfig: deps.loadConfig, branchOf: deps.branchOf, runActive: deps.runActive, dir: cwd, subagent: Boolean(event.agent_id) });
  }

  const loaded = deps.loadConfig(cwd);
  if (!loaded) return null; // MCP rules only apply in sessions started inside a configured repo
  const ctx = { config: loaded.config, branchOf: deps.branchOf, dir: cwd };
  if (!deps.runActive(loaded.root)) {
    // Outside a plugin task: merging a PR may deploy to production, everything else is free.
    return name === 'mcp__github__merge_pull_request'
      ? { decision: ASK, reason: 'Merging a PR can deploy to production if its base is the production branch: confirm.' }
      : null;
  }
  if (name.startsWith('mcp__github__')) {
    const tool = name.slice('mcp__github__'.length);
    if (GITHUB_WRITE_TOOLS.has(tool)) {
      return { decision: DENY, reason: `mcp__github__${tool} blocked: code changes go through local git and a push to staging.` };
    }
    return null;
  }
  if (REMOTE_EXEC_TOOLS.test(name)) {
    return { decision: DENY, reason: 'Remote execution through Composio blocked during Odoo tasks.' };
  }
  if (CHROME_TOOL.test(name)) return evaluateChrome(name, input, ctx);
  if (OTHER_BROWSER_TOOL.test(name)) {
    return { decision: DENY, reason: 'During a plugin task the only browser is Claude in Chrome. If it is not available, ask the user to run /chrome or start with claude --chrome; do not use another browser MCP.' };
  }
  return null;
}

module.exports = { evaluate, evaluateRules, isYoloSafeCommand, evaluateCommand, evaluatePush, evaluateSsh, evaluateRemoteText, evaluateChrome, isProductionHost, CHROME_TOOL, DENY, ASK, ALLOW };
