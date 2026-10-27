#!/usr/bin/env node
'use strict';
// Render the final Markdown report of an odoo-task run from recorded evidence.
const { loadConfig } = require('./lib/config');
const { REQUIRED_EVIDENCE, loadRun, verdict } = require('./lib/run');

const ICON = { pass: '[OK]', fail: '[FALLO]', skipped: '[NO EJECUTADO]', not_applicable: '[N/A]' };

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
    `# Informe de tarea Odoo`,
    '',
    `**Tarea:** ${run.task}`,
    `**Rama staging:** ${run.staging_branch}`,
    `**Resultado:** ${v.verdict}`,
    `**Ciclos de corrección:** ${run.fix_cycles}`,
    '',
    '## Verificaciones',
    '',
  ];
  const kinds = [...new Set([...REQUIRED_EVIDENCE, ...Object.keys(latest)])];
  for (const k of kinds) {
    const e = latest[k];
    if (!e) lines.push(`- [FALTA] ${k}: sin evidencia registrada`);
    else lines.push(`- ${ICON[e.status]} ${k}: ${e.detail}${e.source ? ` (fuente: ${e.source})` : ''}`);
  }
  if (v.missing.length || v.skipped.length) {
    lines.push('', '## Pendiente de verificar', '');
    [...v.missing, ...v.skipped].forEach((k) => lines.push(`- ${k}`));
  }
  lines.push('', '## Historial', '');
  run.history.forEach((h) => lines.push(`- ${h.at} ${h.state}${h.note ? ` — ${h.note}` : ''}`));
  return lines.join('\n') + '\n';
}

/** Entry point: print the report for the run in the current repo. */
function main() {
  const loaded = loadConfig(process.cwd());
  const run = loaded && loadRun(loaded.root);
  if (!run) {
    console.error('No hay ejecución registrada.');
    process.exit(1);
  }
  process.stdout.write(render(run));
}

if (require.main === module) main();
module.exports = { render };
