'use strict';
const path = require('path');
const { splitCommand, programName } = require('./shell');

const DENY = 'deny';
const ASK = 'ask';

const GITHUB_WRITE_TOOLS = new Set([
  'merge_pull_request', 'push_files', 'create_or_update_file', 'delete_file', 'create_branch',
  'update_pull_request_branch', 'delete_repository', 'fork_repository', 'create_repository',
]);
const REMOTE_EXEC_TOOLS = /^mcp__composio__COMPOSIO_(REMOTE_BASH_TOOL|REMOTE_WORKBENCH|MULTI_EXECUTE_TOOL)$/;
const CHROME_TOOL = /^mcp__(plugin_[^_]+_)?claude-in-chrome__/;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Guard config and learned notes may only change through their scripts or with user confirmation.
const CONFIG_FILE = /(^|[\\/])\.claude[\\/]odoo-agent(-notes)?\.json$/;
// Odoo.sh public hosts that are not customer instances.
const ODOO_PUBLIC_HOSTS = new Set(['odoo.com', 'www.odoo.com']);

// Commands that must never run on an Odoo.sh build (terminal, SSH or browser terminal).
const REMOTE_DENY = [
  { re: /\bodoosh-push\b/i, why: 'odoosh-push sube commits desde el build al repositorio.' },
  { re: /\bgit\s+push\b/i, why: 'git push desde el build no está permitido.' },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'rm -rf no está permitido.' },
  { re: /\bdropdb\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b/i, why: 'operación destructiva de base de datos.' },
  { re: /\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b|\bALTER\s+TABLE\b/i, why: 'escritura SQL directa no permitida.' },
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
  if (ask.length) return { decision: ASK, reason: ask.map((r) => r.reason).join(' ') };
  return null;
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
 * Evaluate a `git push` invocation.
 * @param {string[]} args - tokens after "push"
 * @param {object} ctx - {config, branchOf(dir), dir}
 * @returns {{decision: string, reason: string}} decision
 */
function evaluatePush(args, ctx) {
  const { config } = ctx;
  const positional = [];
  let tags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--force(-with-lease|-if-includes)?(=.*)?$/.test(a) || hasShortFlag(a, 'f')) {
      return { decision: DENY, reason: 'Force push bloqueado por odoo-browser-agent.' };
    }
    if (a === '--delete' || hasShortFlag(a, 'd') || a === '--mirror' || a === '--all' || a === '--branches' || a === '--prune') {
      return { decision: DENY, reason: `git push ${a} bloqueado (puede borrar o sobrescribir ramas remotas).` };
    }
    if (a === '--tags') { tags = true; continue; }
    if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }

  const refspecs = positional.slice(1);
  if (!refspecs.length) {
    // Without a refspec the destination depends on push.default/upstream config: require it explicitly.
    return { decision: DENY, reason: `Indicar remoto y rama explícitos: git push origin ${config.staging_branch || '<rama-staging>'}.` };
  }
  const targets = [];
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return { decision: DENY, reason: `Refspec forzado "${spec}" bloqueado.` };
    if (spec.startsWith(':')) return { decision: DENY, reason: `Borrado de rama remota "${spec}" bloqueado.` };
    let dst = spec.includes(':') ? spec.split(':').pop() : spec;
    if (dst === 'HEAD' || dst === '@') {
      const current = ctx.branchOf(ctx.dir);
      if (!current) return { decision: ASK, reason: 'No se pudo determinar la rama actual del push.' };
      dst = current;
    }
    targets.push(shortRef(dst));
  }

  for (const t of targets) {
    if (config.production_branches.includes(t)) {
      return { decision: DENY, reason: `Push a la rama de producción "${t}" prohibido.` };
    }
  }
  if (!config.staging_branch) {
    return { decision: DENY, reason: 'No hay staging_branch configurada en .claude/odoo-agent.json: preguntar al usuario la rama staging antes de hacer push.' };
  }
  const others = targets.filter((t) => t !== config.staging_branch);
  if (others.length) {
    return { decision: DENY, reason: `Solo se permite push a la rama staging "${config.staging_branch}" (destino: ${others.join(', ')}).` };
  }
  return { decision: ASK, reason: `Confirmar push a la rama staging "${config.staging_branch}"${tags ? ' (incluye tags)' : ''}.` };
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
  if (!loaded) return null; // Guard only applies inside repos with .claude/odoo-agent.json
  const config = loaded.config;
  const sub = tokens[i];
  const args = tokens.slice(i + 1);
  const local = { ...ctx, config, dir };
  if (!sub) return null;
  if (pushConfig) return { decision: ASK, reason: 'git -c push.*/remote.* altera el destino de los push: confirmar.' };

  switch (sub) {
    case 'push':
      return evaluatePush(args, local);
    case 'config':
      if (args.some((a) => /^(push|remote|branch)\./i.test(a))) {
        return { decision: ASK, reason: 'Cambiar configuración push/remote/branch: confirmar.' };
      }
      return null;
    case 'branch':
      if (args.some((a) => a === '--delete' || hasShortFlag(a, 'd') || hasShortFlag(a, 'D'))) {
        return { decision: DENY, reason: 'Borrar ramas está prohibido.' };
      }
      if (args.some((a) => hasShortFlag(a, 'm') || hasShortFlag(a, 'M') || a === '--move' || hasShortFlag(a, 'f') || a === '--force')) {
        return { decision: ASK, reason: 'Renombrar o sobrescribir ramas requiere confirmación.' };
      }
      return null;
    case 'reset':
      if (args.includes('--hard')) return { decision: DENY, reason: 'git reset --hard puede borrar cambios del usuario.' };
      return null;
    case 'clean':
      if (args.some((a) => hasShortFlag(a, 'f') || a === '--force')) return { decision: DENY, reason: 'git clean -f borra archivos no versionados.' };
      return null;
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
      return { decision: DENY, reason: `git ${sub} reescribe historia o referencias.` };
    case 'checkout':
    case 'restore':
      if (sub === 'restore' || args.includes('--') || args.includes('.') || args.some((a) => hasShortFlag(a, 'f') || a === '--force')) {
        return { decision: ASK, reason: `git ${sub} puede descartar cambios locales del usuario.` };
      }
      return null;
    case 'stash':
      if (['drop', 'clear'].includes(args[0])) return { decision: ASK, reason: `git stash ${args[0]} elimina cambios guardados.` };
      return null;
    case 'commit':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'am':
    case 'pull': {
      const branch = ctx.branchOf(dir);
      if (!branch) return { decision: ASK, reason: `No se pudo determinar la rama actual antes de git ${sub}: confirmar.` };
      if (config.production_branches.includes(branch)) {
        return { decision: DENY, reason: `Rama actual "${branch}" es de producción: no se permiten ${sub} en ella.` };
      }
      if (sub === 'merge' && args.some((a) => config.production_branches.includes(shortRef(a.replace(/^origin\//, ''))))) {
        return { decision: ASK, reason: 'Merge desde una rama de producción: confirmar.' };
      }
      return null;
    }
    case 'remote':
      if (['add', 'set-url', 'rename', 'remove', 'rm'].includes(args[0])) {
        return { decision: ASK, reason: `git remote ${args[0]} cambia los destinos de push.` };
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
  return hit ? { decision: DENY, reason: `Comando remoto bloqueado: ${hit.why}` } : null;
}

/**
 * Evaluate an ssh invocation (tokens after "ssh"). Applies even without project config.
 * @param {string[]} args - ssh arguments
 * @param {object} ctx - {loadConfig(dir), dir}
 * @returns {{decision: string, reason: string}|null} decision
 */
function evaluateSsh(args, ctx) {
  const withValue = new Set(['-i', '-p', '-o', '-l', '-F', '-J', '-L', '-R', '-D', '-E', '-b', '-c', '-m', '-O', '-Q', '-S', '-W', '-w', '-e', '-I', '-B']);
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += withValue.has(args[i]) ? 2 : 1;
  const dest = args[i];
  if (!dest) return null;
  const host = dest.split('@').pop().toLowerCase();
  if (!/\.odoo\.com$/.test(host)) return null;
  const loaded = ctx.loadConfig(ctx.dir);
  const config = loaded ? loaded.config : {};
  if (isProductionHost(host, config)) {
    return { decision: DENY, reason: `SSH a "${host}" bloqueado: se trata como producción (solo se permiten builds *.dev.odoo.com).` };
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
function evaluateConfigWrite(tokens, raw) {
  const isConfigCli = tokens.some((t) => /(^|[\\/])config\.js$/.test(t)) && tokens.some((t) => ['init', 'set-staging', 'set-ssh'].includes(t));
  if (isConfigCli) return { decision: ASK, reason: 'Cambio de .claude/odoo-agent.json (rama staging/producción/SSH): confirmar con el usuario.' };
  if (/odoo-agent(-notes)?\.json/.test(raw) &&/(>|\bsed\b|\btee\b|Set-Content|Out-File|Add-Content|\bcp\b|\bmv\b|Copy-Item|Move-Item|Remove-Item|\brm\b|\bdel\b)/i.test(raw)) {
    return { decision: ASK, reason: 'Modificación de .claude/odoo-agent.json desde la shell: confirmar.' };
  }
  return null;
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
  for (const tokens of splitCommand(command)) {
    const prog = programName(tokens[0]);
    const rest = tokens.slice(1);
    if ((prog === 'cd' || prog === 'set-location' || prog === 'pushd' || prog === 'sl') && rest[0]) {
      dir = resolveDir(dir, rest.filter((t) => !t.startsWith('-'))[0] || '.');
      continue;
    }
    const local = { ...ctx, dir };
    results.push(evaluateConfigWrite(tokens, tokens.join(' ')));
    if (prog === 'git') results.push(evaluateGit(rest, local));
    else if (prog === 'ssh') results.push(evaluateSsh(rest, local));
    else if (prog === 'odoosh-push') results.push(evaluateRemoteText('odoosh-push'));
    // Nested shells: bash -c "...", powershell -Command "...", cmd /c "..."
    if (depth < 3 && ['bash', 'sh', 'powershell', 'pwsh', 'cmd'].includes(prog)) {
      for (const t of rest) if (/\s/.test(t)) results.push(evaluateCommand(t, local, depth + 1));
    }
  }
  const merged = strictest(results);
  // Every parsed push inside a configured repo yields a decision; a leftover push-like text is suspicious.
  if (!merged && depth === 0 && ctx.loadConfig(dir) && /\bgit(\.exe)?["']?(\s+-\S+(\s+\S+)?)*\s+push\b/i.test(command)) {
    return { decision: ASK, reason: 'Posible git push que no se pudo analizar: confirmar.' };
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
        results.push({ decision: DENY, reason: `Navegación a ${host} bloqueada: se trata como instancia de producción.` });
      } else if (!hostAllowed(host, ctx.config.allowed_domains)) {
        results.push({ decision: ASK, reason: `Navegación a dominio no permitido: ${host}.` });
      }
    }
    results.push(evaluateRemoteText(s));
  }
  if (/javascript|evaluate|execute_script/i.test(toolName)) {
    results.push({ decision: ASK, reason: 'Ejecución de JavaScript en el navegador: confirmar.' });
  }
  return strictest(results);
}

/**
 * Main policy entry point for a PreToolUse event.
 * @param {object} event - hook input {tool_name, tool_input, cwd}
 * @param {object} deps - {loadConfig(dir), branchOf(dir)}
 * @returns {{decision: string, reason: string}|null} decision, null = no opinion
 */
function evaluate(event, deps) {
  const cwd = event.cwd || process.cwd();
  const name = event.tool_name || '';
  const input = event.tool_input || {};

  if (FILE_TOOLS.has(name)) {
    const target = String(input.file_path || input.notebook_path || '');
    return CONFIG_FILE.test(target)
      ? { decision: ASK, reason: `Edición directa de ${path.basename(target)}: confirmar con el usuario (usar config.js / notes.js).` }
      : null;
  }
  // Shell commands resolve the config per directory (git -C, cd), so they are not gated on cwd.
  if (SHELL_TOOLS.has(name)) {
    return evaluateCommand(String(input.command || ''), { loadConfig: deps.loadConfig, branchOf: deps.branchOf, dir: cwd });
  }

  const loaded = deps.loadConfig(cwd);
  if (!loaded) return null; // MCP rules only apply in sessions started inside a configured repo
  const ctx = { config: loaded.config, branchOf: deps.branchOf, dir: cwd };
  if (name.startsWith('mcp__github__')) {
    const tool = name.slice('mcp__github__'.length);
    if (GITHUB_WRITE_TOOLS.has(tool)) {
      return { decision: DENY, reason: `mcp__github__${tool} bloqueado: los cambios de código se hacen con git local y push a staging.` };
    }
    return null;
  }
  if (REMOTE_EXEC_TOOLS.test(name)) {
    return { decision: DENY, reason: 'Ejecución remota vía Composio bloqueada durante tareas Odoo.' };
  }
  if (CHROME_TOOL.test(name)) return evaluateChrome(name, input, ctx);
  return null;
}

module.exports = { evaluate, evaluateCommand, evaluatePush, evaluateSsh, evaluateRemoteText, evaluateChrome, isProductionHost, CHROME_TOOL, DENY, ASK };
