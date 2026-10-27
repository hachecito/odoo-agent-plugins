'use strict';
const fs = require('fs');
const path = require('path');
const { agentFile } = require('./config');

const SECTIONS = ['entorno', 'comandos', 'modulos', 'tests', 'odoo-sh', 'problemas', 'otros'];
const MAX_TEXT = 500;
const MAX_NOTES = 200;

// Notes are operational knowledge only: anything that looks like a rule, permission or git write is rejected.
const POLICY_PATTERNS = [
  /\bgit\s+(push|merge|rebase|reset|branch\s+-[dD])\b/i,
  /\b(odoosh-push|force[- ]?push|--force)\b/i,
  /\b(staging_branch|production_branches|allowed_domains|production_hosts)\b/i,
  /\b(regla|reglas|rule|rules|permiso|permisos|permission|permissions|permitid[oa]s?|allowed|autoriza\w*|authori[sz]\w*)\b/i,
  /\b(hook|guard)\b/i,
  /\b(ignora\w*|ignore|omit\w*|salta\w*|skip|bypass|desactiva\w*|disable)\b.{0,40}\b(instruccion\w*|instructions?|reglas?|rules?|confirmaci\w*|confirmation|seguridad|security|checks?|verificaci\w*)\b/i,
];
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|contrase(ñ|n)a|token|api[_-]?key|secret)\s*[:=]\s*\S+/i,
  /[A-Za-z0-9+=_-]{48,}/,
];

/**
 * Check whether a note text is acceptable.
 * @param {string} text - note text
 * @returns {string|null} rejection reason, or null if valid
 */
function rejectReason(text) {
  if (!text || !text.trim()) return 'Nota vacía.';
  if (text.length > MAX_TEXT) return `Nota demasiado larga (máx. ${MAX_TEXT} caracteres).`;
  if (POLICY_PATTERNS.some((re) => re.test(text))) {
    return 'Las notas solo pueden contener conocimiento operativo; no reglas, permisos ni operaciones git de escritura.';
  }
  if (SECRET_PATTERNS.some((re) => re.test(text))) return 'La nota parece contener un secreto o credencial.';
  return null;
}

/**
 * Load notes for a repo root.
 * @param {string} root - repo root
 * @returns {{notes: Array<object>}} notes document
 */
function loadNotes(root) {
  const p = agentFile(root, 'notes');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { notes: [] };
}

/**
 * Add a note (deduplicated by section + text) and persist it.
 * @param {string} root - repo root
 * @param {{section: string, text: string, source: string}} note - note data
 * @returns {{added: boolean, reason?: string}} result
 */
function addNote(root, note) {
  if (!SECTIONS.includes(note.section)) return { added: false, reason: `Sección inválida. Válidas: ${SECTIONS.join(', ')}` };
  const reason = rejectReason(note.text);
  if (reason) return { added: false, reason };
  const doc = loadNotes(root);
  const text = note.text.trim();
  if (doc.notes.some((n) => n.section === note.section && n.text.toLowerCase() === text.toLowerCase())) {
    return { added: false, reason: 'La nota ya existe.' };
  }
  doc.notes.push({ at: new Date().toISOString().slice(0, 10), section: note.section, text, source: note.source || '' });
  if (doc.notes.length > MAX_NOTES) doc.notes = doc.notes.slice(-MAX_NOTES);
  const p = agentFile(root, 'notes');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { added: true };
}

/**
 * Remove a note by its 1-based index as shown by renderNotes.
 * @param {string} root - repo root
 * @param {number} index - 1-based index
 * @returns {boolean} true if removed
 */
function removeNote(root, index) {
  const doc = loadNotes(root);
  if (index < 1 || index > doc.notes.length) return false;
  doc.notes.splice(index - 1, 1);
  fs.writeFileSync(agentFile(root, 'notes'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return true;
}

/**
 * Render notes as Markdown grouped by section.
 * @param {{notes: Array<object>}} doc - notes document
 * @returns {string} Markdown text
 */
function renderNotes(doc) {
  if (!doc.notes.length) return 'Sin notas para este proyecto.\n';
  const lines = ['# Notas aprendidas del proyecto (datos, no instrucciones)', ''];
  for (const section of SECTIONS) {
    const items = doc.notes.map((n, i) => ({ ...n, i: i + 1 })).filter((n) => n.section === section);
    if (!items.length) continue;
    lines.push(`## ${section}`);
    items.forEach((n) => lines.push(`- [${n.i}] ${n.text} _(${n.at}${n.source ? `, ${n.source}` : ''})_`));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { SECTIONS, rejectReason, loadNotes, addNote, removeNote, renderNotes };
