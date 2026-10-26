'use strict';

const SEPARATORS = ['&&', '||', ';', '|', '\n', '\r'];

/**
 * Split a shell command line into segments of tokens, honoring quotes.
 * Works well enough for bash, PowerShell and cmd one-liners.
 * @param {string} command - raw command line
 * @returns {string[][]} list of segments, each a list of tokens
 */
function splitCommand(command) {
  const segments = [];
  let tokens = [];
  let current = '';
  let hasToken = false;
  let quote = null;

  const pushToken = () => {
    if (hasToken) tokens.push(current);
    current = '';
    hasToken = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
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
