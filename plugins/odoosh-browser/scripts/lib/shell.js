'use strict';

const SEPARATORS = ['&&', '||', ';', '|', '\n', '\r'];

/**
 * Split a shell command line into segments of tokens, honoring quotes.
 * Redirections (2>&1, > file, 2>$null...) are not tokens: their targets go to segment.redirects.
 * Works well enough for bash, PowerShell and cmd one-liners.
 * @param {string} command - raw command line
 * @returns {string[][]} list of segments, each a list of tokens with a `redirects` array property
 */
function splitCommand(command) {
  const segments = [];
  let tokens = [];
  let redirects = [];
  let current = '';
  let hasToken = false;
  let quote = null;
  let redirectNext = false;

  const pushToken = () => {
    if (hasToken) {
      if (redirectNext) redirects.push(current);
      else tokens.push(current);
      redirectNext = false;
    }
    current = '';
    hasToken = false;
  };
  const pushSegment = () => {
    pushToken();
    redirectNext = false;
    if (tokens.length) {
      tokens.redirects = redirects;
      segments.push(tokens);
    }
    tokens = [];
    redirects = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length && command[i + 1] === '"') {
        current += '"';
        i++;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    const sep = SEPARATORS.find((s) => command.startsWith(s, i));
    if (sep) {
      pushSegment();
      i += sep.length - 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      // A bare fd number or "&" right before the operator belongs to it (2>, &>), not to the command.
      if (/^\d*&?$/.test(current)) { current = ''; hasToken = false; } else pushToken();
      while (command[i + 1] === '>' || command[i + 1] === '|') i++;
      const dup = /^&(\d+|-)/.exec(command.slice(i + 1));
      if (dup) i += dup[0].length; // 2>&1, >&2: fd duplication, no target
      else redirectNext = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    current += ch;
    hasToken = true;
  }
  pushSegment();
  return segments;
}

/**
 * Strip a path/extension from an executable token (e.g. C:\\git\\git.exe -> git).
 * @param {string} token - executable token
 * @returns {string} normalized lowercase program name
 */
function programName(token) {
  const base = token.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/, '');
}

module.exports = { splitCommand, programName };
