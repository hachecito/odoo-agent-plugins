#!/usr/bin/env node
'use strict';
// Render the final Markdown report of an odoo-task run from recorded evidence.
const { loadConfig } = require('./lib/config');
const { REQUIRED_EVIDENCE, loadRun, verdict } = require('./lib/run');

const ICON = { pass: '[OK]', fail: '[FAIL]', skipped: '[NOT RUN]', not_applicable: '[N/A]' };

/**
 * Build the Markdown report text.
 * @param {object} run - run state
 * @returns {string} Markdown report
 */
function render(run) {
  const v = verdict(run);
  const latest = {};
  for (const e of run.evidence) latest[e.kind] = e;
  const lines = [
    `# Odoo task report`,
    '',
    `**Task:** ${run.task}`,
    `**Staging branch:** ${run.staging_branch}`,
    `**Result:** ${v.verdict}`,
    `**Fix cycles:** ${run.fix_cycles}`,
    '',
    '## Checks',
    '',
  ];
  const kinds = [...new Set([...REQUIRED_EVIDENCE, ...Object.keys(latest)])];
  for (const k of kinds) {
    const e = latest[k];
    if (!e) lines.push(`- [MISSING] ${k}: no evidence recorded`);
    else lines.push(`- ${ICON[e.status]} ${k}: ${e.detail}${e.source ? ` (source: ${e.source})` : ''}`);
  }
  if (v.missing.length || v.skipped.length) {
    lines.push('', '## Not yet verified', '');
    [...v.missing, ...v.skipped].forEach((k) => lines.push(`- ${k}`));
  }
  const k = run.knowledge || [];
  if (k.length) {
    lines.push('', '## Knowledge', '');
    const LABEL = {
      added: 'Added to project memory', promoted: 'Promoted to global knowledge', 'confirmed-global': 'Already in global knowledge (confirmation added)',
      'global-updated': 'Global copy updated', 'kept-in-project': 'Verified but kept in the project',
    };
    for (const e of k) {
      const where = e.global ? ` → ${e.global} (remove from global: knowledge.js remove ${e.global})` : '';
      lines.push(`- ${LABEL[e.action] || e.action}: ${e.id} "${e.title}"${where}${e.reason ? ` — ${e.reason}` : ''}`);
    }
  }
  lines.push('', '## History', '');
  run.history.forEach((h) => lines.push(`- ${h.at} ${h.state}${h.note ? ` — ${h.note}` : ''}`));
  return lines.join('\n') + '\n';
}

/** Entry point: print the report for the run in the current repo. */
function main() {
  const loaded = loadConfig(process.cwd());
  const run = loaded && loadRun(loaded.root);
  if (!run) {
    console.error('No run recorded.');
    process.exit(1);
  }
  process.stdout.write(render(run));
}

if (require.main === module) main();
module.exports = { render };
