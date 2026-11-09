import fs from 'node:fs';
import path from 'node:path';

// The machine's build lock: one folder, `<state>/.build.lock`, that lets one full site build run at a time in the
// pipeline (a full Docusaurus build of every locale takes gigabytes of memory and, under swap, half an hour). Only the
// runner takes it, never a session: around the chain's `build` stage, which it runs itself, and around a session that
// builds the site on its own (a re-sync, whose locale-translator builds; a visual pack with no build of its head to
// reuse). `holder.json` in it names the ticket, the stage, the runner's pid and when it was last renewed. The runner
// renews it while the build runs and frees it when the build or the session ends, failed or not. A holder whose
// process is gone, or that has not renewed it for STALE_MINUTES, is taken over: a runner that crashed never keeps it.
// Sessions may not write the folder (`writeDeniedFor` in lib/runner.mjs).

export const BUILD_LOCK_NAME = '.build.lock';
export const HOLDER = 'holder.json';
export const STALE_MINUTES = 60;
export const buildLockDir = (state) => path.join(state, BUILD_LOCK_NAME);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Whether a process runs: `kill 0` checks without signalling. EPERM: it runs as another user.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The lock now: not held; held, with its holder, since when it was last renewed and whether it is stale; or broken (not a folder: never touched). */
export function buildLockState(state, { now = Date.now(), isAlive = pidAlive } = {}) {
  const dir = buildLockDir(state);
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return { held: false };
  }
  if (!st.isDirectory()) return { held: true, broken: `${dir} is not a folder (a link or a file): it is left alone` };
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(path.join(dir, HOLDER), 'utf8'));
  } catch {
    // a folder with no holder (made by hand, or a runner that died between the two writes): stale by its age only
  }
  const since = Date.parse(holder?.at ?? '') || st.mtimeMs;
  const old = now - since >= STALE_MINUTES * 60000;
  const gone = Number.isInteger(holder?.pid) && !isAlive(holder.pid);
  return { held: true, holder, since: new Date(since).toISOString(), stale: old || gone, ...(gone ? { gone: true } : {}) };
}

const checkTicket = (ticket) => {
  if (!KEY.test(String(ticket ?? ''))) throw new Error(`the build lock is taken for a ticket key (${ticket ?? 'none'})`);
};

function remove(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return; // another taker removed the stale lock first
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder: it is left alone`);
  fs.rmSync(dir, { recursive: true, force: true });
}

const holderOf = ({ ticket, stage, pid, now }) => ({ by: 'pipeline', ticket, stage: stage ?? null, pid, at: new Date(now).toISOString() });

/** Takes the lock for `ticket`: free, already this ticket's in this process, or stale (taken over). Otherwise `{ taken: false, holder, since }`. */
export function takeBuildLock(state, { ticket, stage = null, pid = process.pid, now = Date.now(), isAlive = pidAlive }) {
  checkTicket(ticket);
  const dir = buildLockDir(state);
  const s = buildLockState(state, { now, isAlive });
  if (s.broken) return { taken: false, broken: s.broken };
  const ours = s.held && s.holder?.ticket === ticket && s.holder?.pid === pid;
  if (s.held && !s.stale && !ours) return { taken: false, holder: s.holder ?? { by: 'hand' }, since: s.since };
  if (s.held) remove(dir);
  fs.mkdirSync(state, { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const t = buildLockState(state, { now, isAlive });
    return { taken: false, holder: t.holder ?? { by: 'hand' }, since: t.since };
  }
  fs.writeFileSync(path.join(dir, HOLDER), JSON.stringify(holderOf({ ticket, stage, pid, now })) + '\n');
  return { taken: true, ...(s.held && !ours ? { tookOver: { ...(s.holder ?? { by: 'hand' }), since: s.since } } : {}) };
}

/** The holder's time moved to now, while its build runs, so a live build is never taken over. Only the holder's own. */
export function renewBuildLock(state, { ticket, pid = process.pid, now = Date.now() }) {
  const s = buildLockState(state, { now, isAlive: () => true });
  if (!s.held || s.broken || s.holder?.ticket !== ticket || s.holder?.pid !== pid) return false;
  const file = path.join(buildLockDir(state), HOLDER);
  const tmp = `${file}.tmp-${pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...s.holder, at: new Date(now).toISOString() }) + '\n');
  fs.renameSync(tmp, file);
  return true;
}

/** Frees the lock if one of `tickets` holds it from this process; a lock someone else holds stays. */
export function freeBuildLock(state, { tickets, pid = process.pid }) {
  const s = buildLockState(state, { isAlive: () => true });
  if (!s.held) return { freed: false, held: false };
  if (s.broken) return { freed: false, broken: s.broken };
  if (!tickets.includes(s.holder?.ticket) || s.holder?.pid !== pid) return { freed: false, holder: s.holder ?? { by: 'hand' }, since: s.since };
  remove(buildLockDir(state));
  return { freed: true };
}

/**
 * Waits for the lock and takes it: tries at once, then every `pollMs` until `waitMs` has passed. `{ taken: true }`, or
 * `{ taken: false, holder }` when someone else held it for the whole wait, or `{ taken: false, broken }`. `sleep` and
 * `now` replace the wait and the clock in tests.
 */
export async function waitForBuildLock(state, { ticket, stage = null, waitMs, pollMs = 15000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isAlive = pidAlive, pid = process.pid }) {
  const until = now() + waitMs;
  for (;;) {
    const r = takeBuildLock(state, { ticket, stage, pid, now: now(), isAlive });
    if (r.taken || r.broken || now() >= until) return r;
    await sleep(Math.min(pollMs, Math.max(0, until - now())));
  }
}
