import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { host, tmp } from './fakes.mjs';
import { HOLDER, STALE_MINUTES, browserLockDir, browserLockState, busyDir, busyEnded, freeBrowserLock, noteBusy, takeBrowserLock } from '../lib/browser-lock.mjs';
import { loadSettings } from '../lib/settings.mjs';
import { main } from '../browser-lock.mjs';

const T0 = Date.parse('2026-11-06T09:00:00Z');
const MIN = 60000;

test('the browser lock: one ticket at a time; only its holder frees it; a hand run\'s lock is respected until stale', () => {
  const state = tmp();
  const dir = browserLockDir(state);
  assert.equal(dir, path.join(state, '.playwright.lock'), 'the folder a hand run makes with mkdir');
  assert.deepEqual(takeBrowserLock(state, { ticket: '501', now: T0 }), { taken: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, HOLDER), 'utf8')), { by: 'pipeline', ticket: '501', at: new Date(T0).toISOString() });
  assert.deepEqual(takeBrowserLock(state, { ticket: '501', now: T0 + MIN }), { taken: true }, 'its own lock again');
  const other = takeBrowserLock(state, { ticket: '502', now: T0 + 2 * MIN });
  assert.equal(other.taken, false);
  assert.equal(other.holder.ticket, '501');
  assert.deepEqual(freeBrowserLock(state, { tickets: ['502'] }).freed, false, 'another ticket can\'t free it');
  assert.ok(fs.existsSync(dir));
  assert.deepEqual(freeBrowserLock(state, { tickets: ['501'] }), { freed: true });
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(freeBrowserLock(state, { tickets: ['501'] }), { freed: false, held: false });

  // A hand run's lock: an empty folder. Held while fresh, never freed by a ticket, taken over once stale.
  fs.mkdirSync(dir);
  const mtime = fs.statSync(dir).mtimeMs;
  assert.deepEqual(takeBrowserLock(state, { ticket: '501', now: mtime + MIN }).holder, { by: 'hand' });
  assert.equal(freeBrowserLock(state, { tickets: ['501'] }).freed, false);
  assert.equal(browserLockState(state, mtime + (STALE_MINUTES - 1) * MIN).stale, false);
  const over = takeBrowserLock(state, { ticket: '501', now: mtime + STALE_MINUTES * MIN });
  assert.equal(over.taken, true);
  assert.equal(over.tookOver.by, 'hand');

  // A pipeline holder that crashed: stale after STALE_MINUTES from its own time.
  const at = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, HOLDER), 'utf8')).at);
  assert.equal(takeBrowserLock(state, { ticket: '502', now: at + (STALE_MINUTES - 1) * MIN }).taken, false);
  assert.equal(takeBrowserLock(state, { ticket: '502', now: at + STALE_MINUTES * MIN }).tookOver.ticket, '501');

  // Not a folder (a file, or a link to one elsewhere): never taken over or removed.
  freeBrowserLock(state, { tickets: ['502'] });
  const elsewhere = tmp();
  fs.symlinkSync(elsewhere, dir);
  assert.match(takeBrowserLock(state, { ticket: '501', now: T0 + 999 * MIN }).broken, /not a folder/);
  assert.match(freeBrowserLock(state, { tickets: ['501'] }).broken, /not a folder/);
  assert.ok(fs.lstatSync(dir).isSymbolicLink() && fs.existsSync(elsewhere));
  assert.throws(() => takeBrowserLock(state, { ticket: '../x', now: T0 }), /--ticket <key> is required/);
});

test('the CLI: take waits while another ticket holds it, free frees only its own; held after the wait is exit 3', async () => {
  const root = host();
  const { state } = await loadSettings({ root });
  const run = async (args, io = {}) => {
    let out = '';
    const code = await main([...args, '--root', root], { stdout: { write: (s) => (out += s) }, ...io });
    return { code, json: JSON.parse(out) };
  };
  assert.equal((await run(['take', '--ticket', '501'])).code, 0);
  // Another ticket waits; the holder frees it during the wait (as its session would), and the take goes through.
  let clock = Date.now(); // the first take used the real clock
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
    if (sleeps.length === 2) freeBrowserLock(state, { tickets: ['501'] });
  };
  const waited = await run(['take', '--ticket', '502', '--wait', '5'], { now: () => clock, sleep });
  assert.deepEqual([waited.code, waited.json.taken, sleeps], [0, true, [15000, 15000]]);
  // Still held at the end of the wait: exit 3, nothing changed.
  const held = await run(['take', '--ticket', '503', '--wait', '1'], { now: () => clock, sleep: async (ms) => (clock += ms) });
  assert.deepEqual([held.code, held.json.ok, held.json.holder.ticket], [3, false, '502']);
  // The give-up is noted for the runner, which treats the session as waiting; a take that went through notes nothing.
  assert.deepEqual(fs.readdirSync(busyDir(state)), ['503.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(busyDir(state), '503.json'), 'utf8')).holder.ticket, '502');
  assert.deepEqual([(await run(['free', '--ticket', '503'])).code, (await run(['status'])).json.holder.ticket], [3, '502']);
  assert.equal((await run(['free', '--ticket', '502'])).code, 0);
  assert.equal((await run(['status'])).json.held, false);
  await assert.rejects(run(['take']), /--ticket <key> is required/);
  await assert.rejects(run(['take', '--ticket', '501', '--wait', '600']), /--wait takes minutes from 0 to 60/);
  await assert.rejects(run(['remove', '--ticket', '501']), /take, free or status/);
});

test('two takers of one stale lock: the one that finds it already removed goes on, and only one of them takes it', () => {
  const state = tmp();
  const dir = browserLockDir(state);
  fs.mkdirSync(dir);
  const mtime = fs.statSync(dir).mtimeMs;
  const late = mtime + STALE_MINUTES * MIN;
  // Both read the lock as stale; the first removes and takes it before the second gets to remove it.
  const realLstat = fs.lstatSync;
  let raced = false;
  fs.lstatSync = (p, ...rest) => {
    if (!raced && p === dir && /\bat remove \(/.test(new Error().stack)) {
      raced = true;
      fs.rmSync(dir, { recursive: true }); // the other taker's removal
    }
    return realLstat(p, ...rest);
  };
  try {
    assert.equal(takeBrowserLock(state, { ticket: '501', now: late }).taken, true, 'no ENOENT: the second taker goes on to mkdir');
  } finally {
    fs.lstatSync = realLstat;
  }
  assert.ok(raced);
  assert.equal(takeBrowserLock(state, { ticket: '502', now: late }).taken, false, 'one holder');
});

test('busy notes: read once, only from the session\'s own time, and a broken lock writes none', async () => {
  const state = tmp();
  noteBusy(state, { ticket: '501', holder: { by: 'hand' }, now: T0 });
  noteBusy(state, { ticket: '502', holder: { by: 'hand' }, now: T0 - MIN });
  assert.deepEqual(busyEnded(state, { tickets: ['501', '502', '503'], since: T0 }), ['501'], 'a note from before the session is not its own');
  assert.deepEqual(fs.readdirSync(busyDir(state)), [], 'both notes were removed');
  assert.deepEqual(busyEnded(state, { tickets: ['501'], since: T0 }), [], 'read once');
  fs.mkdirSync(path.join(busyDir(state), '503.json'));
  assert.deepEqual(busyEnded(state, { tickets: ['503'], since: T0 }), [], 'not a note');
  assert.throws(() => noteBusy(state, { ticket: '../x', now: T0 }), /--ticket <key> is required/);

  const root = host();
  const { state: st } = await loadSettings({ root });
  fs.mkdirSync(st, { recursive: true });
  fs.symlinkSync(tmp(), browserLockDir(st));
  let out = '';
  assert.equal(await main(['take', '--ticket', '501', '--wait', '0', '--root', root], { stdout: { write: (x) => (out += x) } }), 3);
  assert.match(JSON.parse(out).broken, /not a folder/);
  assert.equal(fs.existsSync(busyDir(st)), false, 'a broken lock is not waiting: it needs a person');
});
