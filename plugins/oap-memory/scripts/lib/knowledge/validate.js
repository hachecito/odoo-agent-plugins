'use strict';
const { SCHEMA_VERSION, SCOPES, STATUSES, TYPES, GLOBAL_CATEGORIES, ID_RE } = require('./schema');

// Memory may hold any Odoo knowledge (access rights, install hooks, skipped tests...), but never text aimed at the
// plugin's own safeguards: its branch config, autonomy, the guard, or skipping confirmations and rules.
const POLICY_PATTERNS = [
  /\b(staging_branch|production_branches|allowed_domains|production_hosts|push_staging|autonomy|yolo)\b/i,
  /\bguard(\.js)?\b/i,
  // "the hook" on its own refers to the plugin; Odoo hooks are named (post_init_hook, hook de instalación, webhook).
  /\b(el|los|este|ese|the|this|that)\s+hooks?\b(?!\s+(de|del|of|post|pre|uninstall|install|para|for)\b)/i,
  /\b(ignora\w*|ignore|omit\w*|salta\w*|skip\w*|bypass\w*|desactiva\w*|disable\w*)\b.{0,40}\b(instruccion\w*|instructions?|reglas?|rules?|confirmaci\w*|confirmation|seguridad|security|salvaguardas?|safeguards?)\b/i,
  /\b(sin|without)\s+(pedir\s+|asking\s+(for\s+)?)?(confirmaci\w*|confirmation)\b/i,
  // Git actions only: "commit" alone is also cr.commit() and "production" is also mrp.production / a stock location.
  /\b(permitid[oa]s?|allowed|autorizad[oa]s?|authori[sz]ed)\b.{0,40}\b(push|git\s+commit|merge|deploy|rebuild)\b/i,
  /\b(push|git\s+commit|merge|deploy|rebuild)\b.{0,40}\b(permitid[oa]s?|allowed|autorizad[oa]s?|authori[sz]ed)\b/i,
  // Pushing or merging INTO a production branch ("a producción", "to main"); "órdenes de producción" or
  // "to the production location" are Odoo, not a deploy target.
  /\b(push\w*|merge\w*|deploy\w*|despleg\w*)\b.{0,30}\b(to|into|a|al|en|hacia)\s+(the\s+|la\s+|el\s+)?(rama\s+|branch\s+)?(main|master|production|producci[oó]n)\b(?!\s+(location|ubicaci\w*|orders?|[oó]rden\w*|lots?|lines?|steps?|rules?|reglas?))/i,
];
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|contrase(ñ|n)a|token|api[_-]?key|secret)\s*[:=]\s*\S+/i,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, // JWT
  /\b[a-z][\w+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // URL with user:password
  /\b(AKIA[0-9A-Z]{16}|AIza[\w-]{35}|xox[abprs]-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/,
];
// Any other run of 48+ key-like characters counts as a possible key, unless it is lowercase words joined by - or _
// (task folder slugs such as 20261123-export-kit-components-..., long Odoo field or module names).
const LONG_RUN = /[A-Za-z0-9+=_-]{48,}/g;
const WORDS_RUN = /^[a-z0-9]+([-_][a-z0-9]+)+$/;
// Global knowledge is shared by every project: no personal data, hosts or links outside public documentation.
const GLOBAL_PATTERNS = [
  // The domain must end in a letter TLD, so code references like odoo/odoo@18.0:addons/... are not e-mails.
  [/\b[\w.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, 'an e-mail address'],
  // Lookarounds keep Odoo module versions (18.0.1.0.0) from looking like an IP.
  [/(?<![\d.])(\d{1,3}\.){3}\d{1,3}(?![\d.])/, 'an IP address'],
  [/\+\d{1,3}[\s-]?\d{2,4}([\s-]?\d{2,4}){2,}/, 'a phone number'],
  [/\.dev\.odoo\.com\b/i, 'an Odoo.sh build host'],
];
const PUBLIC_URL_RE = /^https?:\/\/((www\.)?odoo\.(com|sh)\/|github\.com\/(odoo|OCA)\/|docs\.python\.org\/|nodejs\.org\/|www\.postgresql\.org\/docs\/)/i;

/**
 * Reason why text touches the plugin's safeguards, or null.
 * @param {string} text - text to check
 * @returns {string|null} reason
 */
function policyReason(text) {
  return POLICY_PATTERNS.some((re) => re.test(text))
    ? 'Memory holds operational knowledge only: nothing about the plugin branches, autonomy, guard or skipping confirmations.'
    : null;
}

/**
 * Reason why text looks like it contains a secret, or null.
 * @param {string} text - text to check
 * @returns {string|null} reason
 */
function secretReason(text) {
  const s = String(text);
  const longKey = (s.match(LONG_RUN) || []).some((run) => !WORDS_RUN.test(run));
  return longKey || SECRET_PATTERNS.some((re) => re.test(s)) ? 'The text looks like it contains a secret or credential.' : null;
}

/**
 * Check an entry's frontmatter and body.
 * @param {object} data - frontmatter fields
 * @param {string} body - Markdown body
 * @returns {string[]} problems (empty when valid)
 */
function validateEntry(data, body) {
  const p = [];
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  if (!ID_RE.test(String(data.id || ''))) p.push('id must look like p-20261126-7f3a (g|p|t, date, 4-8 hex).');
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 120) p.push('title is required (max 120 characters).');
  if (!TYPES.includes(data.type)) p.push(`type must be one of: ${TYPES.join(', ')}.`);
  if (!SCOPES.includes(data.scope)) p.push(`scope must be one of: ${SCOPES.join(', ')}.`);
  else if (data.id && ID_RE.test(data.id) && data.id[0] !== data.scope[0]) p.push('id prefix must match the scope (g/p/t).');
  if (typeof data.category !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(data.category)) p.push('category must be lowercase letters, digits or dashes (max 32).');
  if (!Array.isArray(data.tags) || data.tags.some((t) => !/^[\w.-]{1,32}$/.test(String(t)))) p.push('tags must be a list of 1-32 characters (letters, digits, . _ -).');
  if (!Array.isArray(data.odoo_versions) || data.odoo_versions.some((v) => !/^\d{1,2}\.\d$/.test(String(v)))) p.push('odoo_versions must be a list like ["17.0", "18.0"] ([] = any).');
  if (!STATUSES.includes(data.status)) p.push(`status must be one of: ${STATUSES.join(', ')}.`);
  if (typeof data.summary !== 'string' || !data.summary.trim() || data.summary.length > 400) p.push('summary is required (max 400 characters).');
  if (data.evidence !== undefined && !Array.isArray(data.evidence)) p.push('evidence must be a list.');
  if (data.status === 'verified' && !(data.evidence || []).length) p.push('a verified entry needs at least one evidence item.');
  for (const k of ['superseded_by', 'promoted_to']) {
    if (data[k] !== undefined && data[k] !== null && !ID_RE.test(String(data[k]))) p.push(`${k} must be an entry id or null.`);
  }
  if (!isDate(data.created) || !isDate(data.updated)) p.push('created and updated must be dates (YYYY-MM-DD).');
  if (data.schema_version !== SCHEMA_VERSION) p.push(`schema_version must be ${SCHEMA_VERSION}.`);
  const text = [data.title, data.summary, ...(data.evidence || []), body].filter(Boolean).join('\n');
  // A task summary quotes the client's request, which is data about that task and never promoted: only the
  // secret check applies to it. Lessons and knowledge also get the policy check.
  const reason = (data.scope === 'task' ? null : policyReason(text)) || secretReason(text);
  if (reason) p.push(reason);
  return p;
}

/**
 * Check whether an entry may be copied to global knowledge.
 * @param {object} data - frontmatter fields
 * @param {string} body - Markdown body
 * @param {{projectTerms?: string[], globalCategories?: string[]}} [ctx] - project-specific words (own module names and
 *   the names plugins declare) and the global categories (built-in plus declared)
 * @returns {string[]} reasons it cannot be promoted (empty when it can)
 */
function globalProblems(data, body, ctx = {}) {
  const p = [];
  if (data.status !== 'verified') p.push('only verified entries are promoted.');
  if (!(ctx.globalCategories || GLOBAL_CATEGORIES).includes(data.category)) p.push(`category "${data.category}" is project-specific.`);
  if (data.type === 'task' || data.type === 'decision' || data.type === 'config') p.push(`type "${data.type}" is project-specific.`);
  const text = [data.title, data.summary, ...(data.tags || []), body].filter(Boolean).join('\n');
  for (const [re, what] of GLOBAL_PATTERNS) if (re.test(text)) p.push(`it contains ${what}.`);
  for (const url of text.match(/https?:\/\/[^\s)>\]"']+/g) || []) {
    if (!PUBLIC_URL_RE.test(url)) p.push(`it links outside public documentation (${url}).`);
  }
  const lower = text.toLowerCase();
  for (const term of ctx.projectTerms || []) {
    const t = String(term || '').trim().toLowerCase();
    if (t.length < 3) continue;
    const re = new RegExp(`(^|[^\\w.-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
    if (re.test(lower)) p.push(`it mentions "${term}", which belongs to this project.`);
  }
  return p;
}

module.exports = { POLICY_PATTERNS, SECRET_PATTERNS, policyReason, secretReason, validateEntry, globalProblems };
