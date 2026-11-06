import fs from 'node:fs';
import path from 'node:path';

// The host's browser lock: one folder, `<state>/.playwright.lock`, that serialises Playwright runs between pipeline
// sessions and hand runs (a hand run makes it with `mkdir` and moves it away when done, the host's own procedure). A
// pipeline session takes and frees it only through `browser-lock.mjs`, since a role may not remove or move a folder.
// `holder.json` in it names the ticket. When a session ends, failed or not, the runner frees a lock its ticket still
// holds; and a lock older than STALE_MINUTES is taken over, so a holder that crashed never keeps it.

export const LOCK_NAME = '.playwright.lock';
export const HOLDER = 'holder.json';
export const STALE_MINUTES = 60;
export const browserLockDir = (state) => path.join(state, LOCK_NAME);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The lock now: not held; held, with its holder (`by: 'pipeline'` and a ticket, or none for a hand run's), since when and whether stale; or broken (not a folder: never touched). */
export function browserLockState(state, now = Date.now()) {
  const dir = browserLockDir(state);
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
    // a hand run's lock: an empty folder
  }
  const since = Date.parse(holder?.at ?? '') || st.mtimeMs;
  return { held: true, holder, since: new Date(since).toISOString(), stale: now - since >= STALE_MINUTES * 60000 };
}

const checkTicket = (ticket) => {
  if (!KEY.test(String(ticket ?? ''))) throw Object.assign(new Error(`--ticket <key> is required: the ticket the lock is taken for (${ticket ?? 'none'})`), { exitCode: 2 });
};

function remove(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder: it is left alone`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Takes the lock for `ticket`: free, already this ticket's, or stale (taken over). Otherwise `{ taken: false, holder, since }`. */
export function takeBrowserLock(state, { ticket, now = Date.now() }) {
  checkTicket(ticket);
  const dir = browserLockDir(state);
  const s = browserLockState(state, now);
  if (s.broken) return { taken: false, broken: s.broken };
  const ours = s.held && s.holder?.by === 'pipeline' && s.holder.ticket === ticket;
  if (s.held && !s.stale && !ours) return { taken: false, holder: s.holder ?? { by: 'hand' }, since: s.since };
  if (s.held) remove(dir);
  fs.mkdirSync(state, { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const t = browserLockState(state, now);
    return { taken: false, holder: t.holder ?? { by: 'hand' }, since: t.since };
  }
  fs.writeFileSync(path.join(dir, HOLDER), JSON.stringify({ by: 'pipeline', ticket, at: new Date(now).toISOString() }) + '\n');
  return { taken: true, ...(s.held && !ours ? { tookOver: { ...(s.holder ?? { by: 'hand' }), since: s.since } } : {}) };
}

/** Frees the lock if one of `tickets` holds it; a lock someone else holds (another ticket, a hand run) stays. */
export function freeBrowserLock(state, { tickets }) {
  const s = browserLockState(state);
  if (!s.held) return { freed: false, held: false };
  if (s.broken) return { freed: false, broken: s.broken };
  if (s.holder?.by !== 'pipeline' || !tickets.includes(s.holder.ticket)) return { freed: false, holder: s.holder ?? { by: 'hand' }, since: s.since };
  remove(browserLockDir(state));
  return { freed: true };
}
