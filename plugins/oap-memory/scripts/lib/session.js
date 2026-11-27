'use strict';
// Memory session of a plugin task (.oap/memory-session.json): whether a task is running, what was noted or promoted
// during it (for the task report) and the reminder bookkeeping of memory-hook. Plugins open and close it.
const path = require('path');
const { writeFileAtomic, readFileStable } = require('./fsatomic');

// A session idle for longer than this is considered closed (same as an odoosh-browser task).
const SESSION_STALE_HOURS = 24;
// After a session closes (e.g. the run reached COMPLETED), the closing lessons are still listed in its report.
const REPORT_GRACE_HOURS = 6;
const LABEL = {
  added: 'Added to project memory', promoted: 'Promoted to global knowledge', 'confirmed-global': 'Already in global knowledge (confirmation added)',
  'global-updated': 'Global copy updated', 'kept-in-project': 'Verified but kept in the project',
};

/**
 * Session file of a repo.
 * @param {string} root - repo root
 * @returns {string} absolute path
 */
function sessionPath(root) {
  return path.join(root, '.oap', 'memory-session.json');
}

/**
 * Load the last session, or null.
 * @param {string} root - repo root
 * @returns {object|null} session
 */
function loadSession(root) {
  return readFileStable(sessionPath(root), JSON.parse);
}

/**
 * Write the session.
 * @param {string} root - repo root
 * @param {object} s - session
 */
function saveSession(root, s) {
  writeFileAtomic(sessionPath(root), `${JSON.stringify(s, null, 2)}\n`);
}

/**
 * Open a new session (replaces the previous one).
 * @param {string} root - repo root
 * @param {{source: string, task?: string}} info - plugin and task
 * @param {number} [nowMs] - current epoch ms
 * @returns {object} session
 */
function startSession(root, info, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  const s = { source: info.source, task: info.task || null, started_at: at, last_at: at, ended_at: null, items: [] };
  saveSession(root, s);
  return s;
}

/**
 * Close the current session (its items stay for the report).
 * @param {string} root - repo root
 * @param {number} [nowMs] - current epoch ms
 * @returns {boolean} true if a session was open
 */
function endSession(root, nowMs = Date.now()) {
  const s = loadSession(root);
  if (!s || s.ended_at) return false;
  s.ended_at = new Date(nowMs).toISOString();
  saveSession(root, s);
  return true;
}

/**
 * Tell whether a session is open and not stale.
 * @param {string} root - repo root
 * @param {number} [nowMs] - current epoch ms
 * @returns {boolean} true while a plugin task runs
 */
function isSessionActive(root, nowMs = Date.now()) {
  const s = loadSession(root);
  if (!s || s.ended_at) return false;
  return nowMs - Date.parse(s.last_at || s.started_at) < SESSION_STALE_HOURS * 3600 * 1000;
}

/**
 * Record a knowledge action in the open session, or in one closed less than REPORT_GRACE_HOURS ago (the lessons
 * written while closing a task still belong to its report). Otherwise nothing.
 * @param {string} root - repo root
 * @param {object} item - {action, id, title, global?, reason?, status?}
 * @param {number} [nowMs] - current epoch ms
 */
function recordInSession(root, item, nowMs = Date.now()) {
  const s = loadSession(root);
  if (!s) return;
  const closedRecently = s.ended_at && nowMs - Date.parse(s.ended_at) < REPORT_GRACE_HOURS * 3600 * 1000;
  if (!isSessionActive(root, nowMs) && !closedRecently) return;
  const at = new Date(nowMs).toISOString();
  s.items = [...(s.items || []), { at, ...item }];
  if (!s.ended_at) s.last_at = at;
  saveSession(root, s);
}

/**
 * Markdown "Knowledge" section of the task report for the last session ('' when nothing was recorded).
 * @param {object|null} s - session
 * @returns {string} Markdown
 */
function renderKnowledge(s) {
  const items = (s && s.items) || [];
  if (!items.length) return '';
  const lines = ['## Knowledge', ''];
  for (const e of items) {
    const where = e.global ? ` → ${e.global} (remove from global: knowledge.js remove ${e.global})` : '';
    lines.push(`- ${LABEL[e.action] || e.action}: ${e.id} "${e.title}"${where}${e.reason ? ` — ${e.reason}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  SESSION_STALE_HOURS, REPORT_GRACE_HOURS, sessionPath, loadSession, saveSession, startSession, endSession, isSessionActive, recordInSession, renderKnowledge,
};
