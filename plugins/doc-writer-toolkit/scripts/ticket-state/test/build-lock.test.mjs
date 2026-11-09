import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './fakes.mjs';
import { BUILD_LOCK_NAME, HOLDER, STALE_MINUTES, buildLockDir, buildLockState, freeBuildLock, pidAlive, renewBuildLock, takeBuildLock, waitForBuildLock } from '../lib/build-lock.mjs';

// The machine's build lock: one full site build at a time in the pipeline. Taken only by the runner; renewed while its
// build runs; a holder whose process is gone, or that stopped renewing an hour ago, is taken over.

const T0 = Date.parse('2026-11-06T09:00:00Z');
const MIN = 60000;
const alive = () => true;
const DEAD = 2 ** 22 + 12345;

test('AC-2: the build lock: one ticket at a time; only its holder frees it; a second taker waits until it is free', async () => {
  const state = tmp();
  const dir = buildLockDir(state);
  assert.equal(dir, path.join(state, BUILD_LOCK_NAME));
  assert.deepEqual(takeBuildLock(state, { ticket: '501', stage: 'build', pid: 100, now: T0, isAlive: alive }), { taken: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, HOLDER), 'utf8')), { by: 'pipeline', ticket: '501', stage: 'build', pid: 100, at: new Date(T0).toISOString() });
  assert.equal(takeBuildLock(state, { ticket: '501', pid: 100, now: T0 + MIN, isAlive: alive }).taken, true, 'its own lock again');
  const other = takeBuildLock(state, { ticket: '502', pid: 200, now: T0 + 2 * MIN, isAlive: alive });
  assert.deepEqual([other.taken, other.holder.ticket], [false, '501']);
  assert.equal(takeBuildLock(state, { ticket: '501', pid: 200, now: T0 + 2 * MIN, isAlive: alive }).taken, false, 'the same ticket from another runner waits too');
  assert.equal(freeBuildLock(state, { tickets: ['502'], pid: 200 }).freed, false, 'another ticket can\'t free it');
  assert.equal(freeBuildLock(state, { tickets: ['501'], pid: 200 }).freed, false, 'nor another process');

  // The second taker waits, polling, and gets the lock once the first frees it.
  let clock = T0 + 3 * MIN;
  const polls = [];
  const sleep = async (ms) => {
    polls.push(ms);
    clock += ms;
    if (polls.length === 2) assert.deepEqual(freeBuildLock(state, { tickets: ['501'], pid: 100 }), { freed: true });
  };
  const got = await waitForBuildLock(state, { ticket: '502', stage: 'build', pid: 200, waitMs: 30 * MIN, pollMs: 15000, now: () => clock, sleep, isAlive: alive });
  assert.deepEqual([got.taken, polls], [true, [15000, 15000]]);
  assert.equal(buildLockState(state, { now: clock, isAlive: alive }).holder.ticket, '502');

  // Held for the whole wait: gives up with the holder.
  clock += MIN;
  const gaveUp = await waitForBuildLock(state, { ticket: '503', pid: 300, waitMs: 2 * MIN, pollMs: 15000, now: () => clock, sleep: async (ms) => (clock += ms), isAlive: alive });
  assert.deepEqual([gaveUp.taken, gaveUp.holder.ticket], [false, '502']);
  assert.deepEqual(freeBuildLock(state, { tickets: ['502'], pid: 200 }), { freed: true });
  assert.deepEqual(freeBuildLock(state, { tickets: ['502'], pid: 200 }), { freed: false, held: false });
});

test('AC-2: stale takeover: a holder whose process is gone at once, one that stopped renewing after an hour; a renewed one never', () => {
  const state = tmp();
  const dir = buildLockDir(state);
  // A runner that crashed: its pid is gone, so the lock is taken over at once.
  takeBuildLock(state, { ticket: '501', pid: DEAD, now: T0, isAlive: alive });
  assert.equal(pidAlive(DEAD), false);
  const s = buildLockState(state, { now: T0 + MIN });
  assert.deepEqual([s.stale, s.gone], [true, true]);
  const over = takeBuildLock(state, { ticket: '502', pid: process.pid, now: T0 + MIN });
  assert.deepEqual([over.taken, over.tookOver.ticket, over.tookOver.pid], [true, '501', DEAD]);

  // A live holder that renews is never stale; one that stops renewing is, STALE_MINUTES after its last renewal.
  for (let m = 10; m <= 120; m += 10) assert.equal(renewBuildLock(state, { ticket: '502', pid: process.pid, now: T0 + m * MIN }), true);
  assert.equal(buildLockState(state, { now: T0 + 125 * MIN }).stale, false);
  assert.equal(takeBuildLock(state, { ticket: '503', pid: 300, now: T0 + 125 * MIN }).taken, false);
  assert.equal(renewBuildLock(state, { ticket: '503', pid: 300, now: T0 + 126 * MIN }), false, 'only the holder renews');
  assert.equal(buildLockState(state, { now: T0 + (120 + STALE_MINUTES - 1) * MIN }).stale, false);
  assert.equal(buildLockState(state, { now: T0 + (120 + STALE_MINUTES) * MIN }).stale, true);
  assert.equal(takeBuildLock(state, { ticket: '503', pid: 300, now: T0 + (120 + STALE_MINUTES) * MIN }).tookOver.ticket, '502');

  // A folder with no holder: stale by its age only. A lock that isn't a folder is never touched.
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir);
  const mtime = fs.statSync(dir).mtimeMs;
  assert.deepEqual(takeBuildLock(state, { ticket: '501', now: mtime + MIN }).holder, { by: 'hand' });
  assert.equal(takeBuildLock(state, { ticket: '501', now: mtime + STALE_MINUTES * MIN }).tookOver.by, 'hand');
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(dir, 'not a folder');
  assert.match(takeBuildLock(state, { ticket: '501', now: T0 }).broken, /not a folder/);
  assert.match(freeBuildLock(state, { tickets: ['501'] }).broken, /not a folder/);
  assert.equal(fs.readFileSync(dir, 'utf8'), 'not a folder');
});
