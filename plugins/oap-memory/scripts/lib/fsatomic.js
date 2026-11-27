'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Windows refuses to rename over a file while another process has it open, even a plain reader such as the guard
// reading run.json on every tool call; antivirus and editors do the same.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// A lock whose owner is gone is taken over at once; one whose owner cannot be checked (another OS, e.g. WSL and
// Windows on the same /mnt/c file) is considered abandoned after LOCK_STALE_MS. Work under a lock takes milliseconds.
const LOCK_STALE_MS = 15 * 1000;
const LOCK_TIMEOUT_MS = 20 * 1000;
const OWNER = `${os.hostname()}|${process.platform}`;

/**
 * Tell whether a path is on a Windows drive mounted in WSL (/mnt/c/...), where renames are not atomic for readers
 * and a file being deleted from Windows can briefly answer ENOENT.
 * @param {string} file - path
 * @returns {boolean} true on WSL drive mounts
 */
function onWslDrive(file) {
  return process.platform === 'linux' && /^\/mnt\/[a-z]\//i.test(path.resolve(file));
}

/**
 * Block the current thread for a few milliseconds (scripts here are synchronous CLIs and hooks).
 * @param {number} ms - milliseconds
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file atomically: temp file in the same directory, fsync, then rename over the target.
 * If the rename keeps being refused (target held open on Windows), the content is written in place instead, which is
 * what plain writeFileSync did before; it is only atomic when the rename succeeds.
 * @param {string} file - target path
 * @param {string} data - content (utf8)
 * @param {{retries?: number, delayMs?: number, rename?: function, fallback?: boolean}} [opts] - retry policy;
 *   rename is injectable for tests; fallback=false throws instead of writing in place
 * @returns {{atomic: boolean}} whether the rename succeeded
 */
function writeFileAtomic(file, data, opts = {}) {
  // About 1.5 s of retries with jitter, so a retry can land between two reads of a busy reader.
  const retries = opts.retries ?? 10;
  const delayMs = opts.delayMs ?? 25;
  const rename = opts.rename || fs.renameSync;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, data, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        rename(tmp, file);
        return { atomic: true };
      } catch (err) {
        if (!RETRY_CODES.has(err.code)) throw err;
        if (attempt >= retries) {
          if (opts.fallback === false) throw err;
          fs.writeFileSync(file, data, 'utf8');
          return { atomic: false };
        }
        sleepSync(delayMs + Math.floor(Math.random() * delayMs * (attempt + 1)));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed, or already gone */ }
  }
}

/**
 * Tell whether a writeFileAtomic of this file is in progress (its temp file exists next to it).
 * @param {string} file - target path
 * @returns {boolean} true if a temp file is present
 */
function writeInProgress(file) {
  const prefix = `.${path.basename(file)}.`;
  try {
    return fs.readdirSync(path.dirname(file)).some((f) => f.startsWith(prefix) && f.endsWith('.tmp'));
  } catch {
    return false;
  }
}

/**
 * Read a file written with writeFileAtomic, retrying briefly while a write is visible half-done: on WSL over a Windows
 * drive (/mnt/c) a rename is not atomic for readers, which may see the file missing or partial for a moment.
 * @param {string} file - path
 * @param {function(string): *} [parse] - parser; a throw counts as a partial read (e.g. JSON.parse)
 * @param {number} [attempts] - maximum reads
 * @returns {*} parsed content, or null if the file does not exist
 */
function readFileStable(file, parse = (s) => s, attempts = 6) {
  for (let i = 1; ; i++) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Elsewhere a missing file is only retried while a write is in progress, so an absent file costs nothing.
      if (i >= attempts || !(writeInProgress(file) || (onWslDrive(file) && i < 3))) return null;
      sleepSync(15 * i);
      continue;
    }
    try {
      return parse(text);
    } catch (err) {
      if (i >= attempts) throw err;
      sleepSync(15 * i);
    }
  }
}

/**
 * Tell whether a lock's owner process is known to be gone (same machine and OS, pid no longer running).
 * @param {string} content - lock file content
 * @returns {boolean} true only when the owner is certainly dead
 */
function ownerIsDead(content) {
  let info;
  try { info = JSON.parse(content); } catch { return false; }
  if (!info || info.owner !== OWNER || !Number.isInteger(info.pid)) return false;
  if (info.pid === process.pid) return false;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/**
 * Run a function while holding an exclusive lock file (created with 'wx'). A lock whose owner died, or older than
 * staleMs, is taken over.
 * @param {string} lockFile - lock path
 * @param {function(): *} fn - work to do under the lock
 * @param {{timeoutMs?: number, staleMs?: number}} [opts] - waiting limits
 * @returns {*} fn's result
 */
function withLock(lockFile, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, owner: OWNER, at: new Date().toISOString() }));
      break;
    } catch (err) {
      // A lock file being deleted by its owner answers EPERM on Windows and ENOENT on WSL drive mounts instead of
      // EEXIST: wait as if it were held.
      const transient = RETRY_CODES.has(err.code) || (err.code === 'ENOENT' && onWslDrive(lockFile));
      if (!transient && err.code !== 'EEXIST') throw err;
      if (err.code === 'EEXIST') {
        let content;
        let age;
        try {
          content = fs.readFileSync(lockFile, 'utf8');
          age = Date.now() - fs.statSync(lockFile).mtimeMs;
        } catch {
          continue; // released meanwhile
        }
        if (ownerIsDead(content) || age > staleMs) {
          // Re-check right before removing, so a lock just re-created by another waiter is not removed.
          try { if (fs.readFileSync(lockFile, 'utf8') === content) fs.unlinkSync(lockFile); } catch { /* gone */ }
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockFile}`);
      sleepSync(10 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockFile); } catch { /* removed as stale by another process */ }
  }
}

module.exports = { writeFileAtomic, readFileStable, withLock, sleepSync, ownerIsDead };
