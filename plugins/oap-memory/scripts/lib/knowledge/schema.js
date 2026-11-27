'use strict';
// Knowledge entries: Markdown with a YAML frontmatter. Only the YAML subset written here is read back:
// plain/quoted scalars, inline [lists], block "- item" lists, folded ">-" text, null, booleans, integers and comments.

const SCHEMA_VERSION = 1;
const SCOPES = ['global', 'project', 'task'];
const STATUSES = ['observed', 'verified', 'deprecated'];
const TYPES = ['gotcha', 'solution', 'behavior', 'pattern', 'procedure', 'decision', 'config', 'task'];
// Categories that may be promoted to global knowledge; any other category stays in its project.
const GLOBAL_CATEGORIES = ['odoo', 'odoo-sh', 'editor', 'tests', 'tooling', 'migration', 'debugging'];
const FIELD_ORDER = [
  'id', 'title', 'type', 'scope', 'category', 'tags', 'odoo_versions', 'status', 'summary',
  'evidence', 'superseded_by', 'promoted_to', 'no_promote', 'source', 'created', 'updated', 'schema_version',
];
const LIST_FIELDS = new Set(['tags', 'odoo_versions', 'evidence']);
const ID_RE = /^[gpt]-\d{8}-[0-9a-f]{4,8}$/;

/**
 * Strip a trailing " # comment" from an unquoted scalar.
 * @param {string} s - raw scalar text
 * @returns {string} text without the comment
 */
function stripComment(s) {
  const i = s.search(/\s#/);
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

/**
 * Parse one YAML scalar of the supported subset.
 * @param {string} raw - scalar text
 * @returns {*} string, number, boolean or null
 */
function parseScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) return JSON.parse(s.slice(0, s.lastIndexOf('"') + 1));
  if (s.startsWith("'")) return s.slice(1, s.lastIndexOf("'")).replace(/''/g, "'");
  const v = stripComment(s);
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Split an inline flow list body on commas outside quotes.
 * @param {string} inner - text between [ and ]
 * @returns {string[]} raw items
 */
function splitFlow(inner) {
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += inner[++i] || '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quote) throw new Error('Unclosed quote in list');
  if (cur.trim()) items.push(cur);
  return items.map((x) => x.trim()).filter(Boolean);
}

/**
 * Split a document into frontmatter data and Markdown body.
 * @param {string} text - file content
 * @returns {{data: object, body: string}} parsed entry
 */
function parseEntry(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('Missing frontmatter (first line must be ---)');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('Unclosed frontmatter (no closing ---)');
  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!m) throw new Error(`Unsupported frontmatter line ${i + 1}: ${line}`);
    const [, key, rest = ''] = m;
    const value = rest.trim();
    if (value.startsWith('[')) {
      const close = value.lastIndexOf(']');
      if (close < 0) throw new Error(`Unclosed list for ${key}`);
      data[key] = splitFlow(value.slice(1, close)).map(parseScalar);
    } else if (value === '>-' || value === '>' || value === '|' || value === '|-') {
      const parts = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      data[key] = value.startsWith('>') ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else if (value === '' && i + 1 < end && /^\s*-\s/.test(lines[i + 1])) {
      const items = [];
      while (i + 1 < end && /^\s*-\s/.test(lines[i + 1])) items.push(parseScalar(lines[++i].replace(/^\s*-\s/, '')));
      data[key] = items;
    } else {
      data[key] = parseScalar(value);
    }
  }
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/**
 * Format a scalar so parseScalar reads it back unchanged.
 * @param {*} v - value
 * @returns {string} YAML text
 */
function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  const plainSafe = s !== '' && s === s.trim() && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/(:\s|\s#|[\r\n])/.test(s)
    && !/:$/.test(s) && !/^(null|~|true|false|-?\d+)$/.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

/**
 * Format a list item; commas and brackets also need quotes inside a flow list.
 * @param {*} v - item
 * @returns {string} YAML text
 */
function formatItem(v) {
  const s = formatScalar(v);
  return /^[^"]*[,[\]]/.test(s) ? JSON.stringify(String(v)) : s;
}

/**
 * Serialize frontmatter data and body into a document (known fields first, in schema order).
 * @param {object} data - frontmatter fields
 * @param {string} body - Markdown body
 * @returns {string} file content
 */
function serializeEntry(data, body) {
  const keys = [...FIELD_ORDER.filter((k) => k in data), ...Object.keys(data).filter((k) => !FIELD_ORDER.includes(k))];
  const lines = keys.map((k) => {
    const v = data[k];
    if (Array.isArray(v) || LIST_FIELDS.has(k)) return `${k}: [${(v || []).map(formatItem).join(', ')}]`;
    return `${k}: ${formatScalar(v)}`;
  });
  const text = String(body || '').replace(/^\n+/, '');
  return `---\n${lines.join('\n')}\n---\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

/**
 * Return one "## Heading" section of a Markdown body (heading included).
 * @param {string} body - Markdown body
 * @param {string} heading - section title, case-insensitive
 * @returns {string|null} section text, or null if absent
 */
function getSection(body, heading) {
  const lines = String(body).split(/\r?\n/);
  const want = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === want);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

module.exports = {
  SCHEMA_VERSION, SCOPES, STATUSES, TYPES, GLOBAL_CATEGORIES, FIELD_ORDER, ID_RE,
  parseEntry, serializeEntry, parseScalar, formatScalar, getSection,
};
