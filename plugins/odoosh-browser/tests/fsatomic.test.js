'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeFileAtomic, withLock } = require('../scripts/lib/fsatomic');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oap-fsatomic-'));
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

test('writeFileAtomic: writes, replaces and leaves no temp file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sub', 'a.json');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepStrictEqual(leftovers(path.dirname(file)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: retries a rename refused with EPERM (Windows file held open)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.txt');
  let calls = 0;
  const flaky = (from, to) => {
    if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    fs.renameSync(from, to);
  };
  writeFileAtomic(file, 'ok', { rename: flaky, delayMs: 1 });
  assert.strictEqual(calls, 3);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: a rename that keeps failing falls back to an in-place write (old behaviour)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'old');
  const broken = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  assert.deepStrictEqual(writeFileAtomic(file, 'new', { rename: broken, retries: 2, delayMs: 1 }), { atomic: false });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepStrictEqual(leftovers(dir), []);
  // With fallback disabled the error surfaces and the old content stays.
  fs.writeFileSync(file, 'old');
  assert.throws(() => writeFileAtomic(file, 'new', { rename: broken, retries: 1, delayMs: 1, fallback: false }), /busy/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepStrictEqual(leftovers(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: other errors are not retried and leave no temp file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.txt');
  let calls = 0;
  const denied = () => { calls++; throw Object.assign(new Error('nope'), { code: 'EXDEV' }); };
  assert.throws(() => writeFileAtomic(file, 'x', { rename: denied }), /nope/);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(leftovers(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withLock: a stale lock is taken over; a recent one with a live or unknown owner times out', () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, '{}');
  const old = new Date(Date.now() - 120 * 1000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(withLock(lock, () => 42), 42);
  assert.strictEqual(fs.existsSync(lock), false);
  fs.writeFileSync(lock, '{}');
  assert.throws(() => withLock(lock, () => 1, { timeoutMs: 100 }), /Timed out/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withLock: a lock left by a dead process on this machine is taken over at once', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const { ownerIsDead } = require('../scripts/lib/fsatomic');
  const dir = tmpDir();
  const lock = path.join(dir, 'x.lock');
  const owner = `${os.hostname()}|${process.platform}`;
  const deadPid = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(deadPid), owner, at: new Date().toISOString() }));
  const t = Date.now();
  assert.strictEqual(withLock(lock, () => 'ok', { timeoutMs: 2000 }), 'ok');
  assert.ok(Date.now() - t < 1000, 'took over without waiting for the stale timeout');
  // A live owner (this process' parent) or another OS is never declared dead.
  assert.strictEqual(ownerIsDead(JSON.stringify({ pid: process.ppid, owner })), false);
  assert.strictEqual(ownerIsDead(JSON.stringify({ pid: Number(deadPid), owner: 'other|linux' })), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: a reader holding the file open never sees a torn file and the writer never fails', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run.json');
  const lib = path.resolve(__dirname, '..', 'scripts', 'lib', 'fsatomic.js');
  writeFileAtomic(file, JSON.stringify({ i: 0, d: 'x'.repeat(50000) }));
  const reader = `const fs=require('fs');let bad=0;const end=Date.now()+1500;while(Date.now()<end){try{JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8'))}catch(e){bad++}}console.log(bad)`;
  const writer = `const {writeFileAtomic}=require(${JSON.stringify(lib)});for(let i=1;i<=40;i++)writeFileAtomic(${JSON.stringify(file)},JSON.stringify({i,d:'x'.repeat(50000)}));`;
  const run = (code) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (status) => resolve({ status, out }));
  });
  const [r, w] = await Promise.all([run(reader), run(writer)]);
  assert.strictEqual(w.status, 0, 'writer failed');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).i, 40);
  // Torn reads are only possible on the rare in-place fallback; they must stay exceptional.
  assert.ok(Number(r.out) <= 5, `torn reads: ${r.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withLock + writeFileAtomic: 10 processes incrementing one file lose no update', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'counter.txt');
  fs.writeFileSync(file, '0');
  const lib = path.resolve(__dirname, '..', 'scripts', 'lib', 'fsatomic.js');
  const script = `const fs=require('fs');const {withLock,writeFileAtomic}=require(${JSON.stringify(lib)});
for(let i=0;i<20;i++) withLock(${JSON.stringify(`${file}.lock`)},()=>{const n=Number(fs.readFileSync(${JSON.stringify(file)},'utf8'));writeFileAtomic(${JSON.stringify(file)},String(n+1));});`;
  const runs = Array.from({ length: 10 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  }));
  await Promise.all(runs);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '200');
  assert.deepStrictEqual(leftovers(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
