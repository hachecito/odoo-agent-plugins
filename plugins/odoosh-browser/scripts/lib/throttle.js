'use strict';
const fs = require('fs');
const { loadRun } = require('./run');
const { agentFile } = require('./config');

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
 * Space out browser calls while the run waits for an Odoo.sh build (state REMOTE_BUILD).
 * @param {{root: string, config: object}} loaded - loaded project config
 * @param {function(number): Promise<void>} sleep - sleep implementation (ms)
 * @returns {Promise<number>} milliseconds actually waited
 */
async function throttleBrowser(loaded, sleep) {
  const run = loadRun(loaded.root);
  if (!run || run.state !== 'REMOTE_BUILD') return 0;
  const p = agentFile(loaded.root, 'throttle');
  const last = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).last_ms : null;
  const waitMs = computeWaitMs(last, Date.now(), loaded.config.build_poll_seconds);
  if (waitMs > 0) await sleep(waitMs);
  fs.writeFileSync(p, JSON.stringify({ last_ms: Date.now() }) + '\n', 'utf8');
  return waitMs;
}

module.exports = { computeWaitMs, throttleBrowser };
