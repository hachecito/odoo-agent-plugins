'use strict';
const fs = require('fs');
const { loadRun } = require('./run');
const { agentFile } = require('./config');

// Only calls that poll the build status are spaced out; typing, clicks, waits and screenshots
// (e.g. running tests in the editor terminal) are never delayed.
const POLL_TOOLS = new Set(['navigate', 'get_page_text', 'read_page', 'find']);

/**
 * Tell whether a Claude in Chrome tool call polls a page (and may be spaced out).
 * @param {string} toolName - full tool name (mcp__...claude-in-chrome__<tool>)
 * @returns {boolean} true for page-reading tools
 */
function isPollCall(toolName) {
  return POLL_TOOLS.has(String(toolName || '').split('__').pop());
}

/**
 * Compute how long to wait before the next browser call.
 * @param {number|null} lastMs - epoch ms of the previous call, or null
 * @param {number} nowMs - current epoch ms
 * @param {number} intervalSec - minimum seconds between calls
 * @returns {number} milliseconds to wait (0 if none)
 */
function computeWaitMs(lastMs, nowMs, intervalSec) {
  if (!lastMs) return 0;
  return Math.max(0, intervalSec * 1000 - (nowMs - lastMs));
}

/**
 * Space out page-polling browser calls while the run waits for an Odoo.sh build (state REMOTE_BUILD).
 * @param {{root: string, config: object}} loaded - loaded project config
 * @param {function(number): Promise<void>} sleep - sleep implementation (ms)
 * @param {string} toolName - full tool name of the call
 * @returns {Promise<number>} milliseconds actually waited
 */
async function throttleBrowser(loaded, sleep, toolName) {
  if (!isPollCall(toolName)) return 0;
  const run = loadRun(loaded.root);
  if (!run || run.state !== 'REMOTE_BUILD') return 0;
  const p = agentFile(loaded.root, 'throttle');
  const last = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).last_ms : null;
  const waitMs = computeWaitMs(last, Date.now(), loaded.config.build_poll_seconds);
  if (waitMs > 0) await sleep(waitMs);
  fs.mkdirSync(require('path').dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ last_ms: Date.now() }) + '\n', 'utf8');
  return waitMs;
}

module.exports = { computeWaitMs, throttleBrowser, isPollCall };
