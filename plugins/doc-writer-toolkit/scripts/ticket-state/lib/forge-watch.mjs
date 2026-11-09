import { WINDOW_MS, advance, readFeed, readSource, sourcesOf, ticketsOf } from './feed.mjs';
import { readLedgersApart } from './ledger.mjs';
import { allLocks } from './locks.mjs';
import { commentWait, dueWaits } from './quiet.mjs';
import { runDaily } from './runner.mjs';
import { notificationsOf, notify } from './notify.mjs';
import { appendRunLog, localDate } from './report.mjs';
import { progressAfterCheck } from './progress.mjs';
import { tickSecondsOf } from './settings.mjs';
import { alive, runCheck, takeWatchLock, watchLockHolder } from './watch.mjs';
import { dropHandOnStep, fullHandOns, handOnLive, readForge, readHandOnStep, runsGoing, takeHandOn, writeForge, writeHandOn } from './forge-state.mjs';
import { fullArgs, handOnArgs, handOnId, spawnDetached } from './dispatch.mjs';

// The forge check and the tick (D-126). The owner's and a reviewer's comments on the pipeline's PRs are picked up
// within a minute, and nothing that runs long can hold that up:
//   - the LaunchAgent ticks every `schedule.forgeSeconds`; each tick runs the forge check in its own process, and, when
//     `schedule.watchMinutes` have passed since the last full check began, starts the full check as a process of its
//     own (detached), so a full check's long hand-on (a chain of sessions) never stops the next tick;
//   - the forge check has its own lock (`watch/forge-active/`) and its own memory (lib/forge-state.mjs): it may run
//     while a full check runs. It reads no tracker, runs no morning run, no start pass and no job;
//   - its hand-on starts the runner as a process of its own (`watcher.mjs --hand-on`), detached, and does not wait for
//     it: the next tick, a minute later, looks at the PRs again. The run's group locks decide who runs a ticket (the
//     runner skips a group another run holds), and the forge check's record of its live runs (`handOns`) holds their
//     tickets until the run took its locks, for the full check as well;
//   - at most `limits.parallel` runs at a time across processes: the live group locks and both checks' live runs;
//   - a ticket the full check handed on (its record in `feed.json`, lib/dispatch.mjs) is held as one of its own runs'.

const iso = (ms) => new Date(ms).toISOString();
const errorText = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

// A ticket's wait for quiet: its PRs, when its comments are quiet, why, and since when it waits. A wait that is new,
// or that a newer comment moved, goes to the run log once.
function waitEntry(key, w, prev, { out, say, now }) {
  const entry = { prs: w.prs, dueAt: iso(w.dueAt), why: w.why, since: prev?.since ?? iso(now) };
  const moved = !prev || prev.dueAt !== entry.dueAt;
  out.waiting.push({ key, until: entry.dueAt, why: w.why, ...(moved ? { new: true } : {}) });
  if (moved) say({ kind: 'watch', keys: [key], outcome: 'waits', note: `comments on ${w.prs.join(', ')}: the session starts at ${entry.dueAt} unless a newer one comes (${w.why})` });
  return entry;
}

// The run's result as a hand-on keeps it: what the notifications read (lib/notify.mjs), a start's first step included.
const summaryOf = (r) => ({
  named: r?.named ?? [],
  stopped: r?.stopped ?? null,
  guard: (r?.guard ?? []).map((g) => ({ kind: g.kind, reason: g.reason, what: g.what ?? null })),
  ran: (r?.ran ?? []).map((s) => ({ group: s.group ?? null, stage: s.stage ?? null, keys: s.keys ?? [], outcome: s.outcome ?? null, note: s.note ?? null })),
  starts: (r?.starts ?? []).map((s) => ({ group: s.group ?? null, steps: (s.steps ?? []).slice(0, 1).map((x) => ({ stage: x.stage ?? null, keys: x.keys ?? [], outcome: x.outcome ?? null })) })),
  notes: r?.notes ?? [],
});

export { fullArgs, handOnArgs, spawnDetached } from './dispatch.mjs';

// ------------------------------------------------------------------ the forge check

export async function runForgeCheck({ settings, clients, io = {}, options = {} }) {
  const { dryRun = false, claude = 'claude' } = options;
  const clock = io.now ?? Date.now;
  const isAlive = io.isAlive ?? alive;
  const checkStart = clock();
  const today = localDate(checkStart);
  const out = { kind: 'forge', mode: settings.mode, dryRun, at: iso(checkStart), sources: [], events: 0, tickets: [], handed: [], waiting: [], held: [], finished: [], handOn: null, jobs: [], errors: [], notified: [], notes: [...(options.notes ?? [])] };
  if (settings.mode === 'off') {
    out.stopped = 'mode off: nothing runs';
    return out;
  }
  const lock = dryRun ? { taken: true, release: () => {} } : takeWatchLock(settings.state, { now: checkStart, isAlive, name: 'forge-active' });
  if (!lock.taken) {
    out.skipped = `another forge check holds its lock${lock.held ? ` (pid ${lock.held.pid}, since ${lock.held.startedAt})` : ''}: nothing read`;
    return out;
  }
  const log = [];
  const say = (e) => log.push({ at: iso(clock()), ...e });
  const failed = (part, e) => out.errors.push({ part, error: errorText(e) });
  try {
    const prev = readForge(settings.state);
    const next = structuredClone(prev);
    next.at = iso(checkStart);
    const waits = next.waits;
    const fullMs = settings.schedule.watchMinutes * 60000;
    // `backoff`: after a run that failed or died, the ticket waits its interval even when a new comment comes.
    const requeue = (keys, why, dueAt, backoff = false) => {
      for (const k of keys) waits[k] = { prs: waits[k]?.prs ?? null, dueAt: iso(dueAt), why, since: waits[k]?.since ?? iso(checkStart), ...(backoff ? { backoff: true } : {}) };
    };

    // 0. The runs it started that ended: their notifications (a step failed twice, a guard stop), and a run that failed
    // or left no result puts its tickets back to wait (after a full interval when it failed: each try reads /usage).
    next.handOns = [];
    for (const h of prev.handOns ?? []) {
      if (handOnLive(h, { now: checkStart, isAlive })) {
        next.handOns.push(h);
        continue;
      }
      const r = takeHandOn(settings.state, h.id);
      if (r?.error) {
        failed('the run', r.error);
        requeue(h.keys, `its run failed: ${r.error}`, checkStart + fullMs, true);
      } else if (!r) {
        // A crash, a reboot: after a full interval, as a failed run, so a run that always dies isn't started every tick.
        out.notes.push(`the run of ${h.keys.join(', ')} (pid ${h.pid}) ended with no result: looked at again after ${settings.schedule.watchMinutes} min`);
        requeue(h.keys, 'its run ended with no result', checkStart + fullMs, true);
      } else out.finished.push({ id: h.id, keys: h.keys, run: r.run });
    }

    // 1. The PRs that changed, per repo, with its own cursors. A cursor older than the window (a sleep) starts from
    // now: the full check reads that stretch with its own cursors. A read that fails keeps the cursor and is only
    // reported here; the full check tells a source that keeps failing.
    const fresh = [];
    for (const src of sourcesOf(settings).filter((s) => s.kind === 'prs')) {
      const cur = prev.sources?.[src.name];
      if (!cur?.lastCheck || checkStart - Date.parse(cur.lastCheck) > WINDOW_MS) {
        next.sources[src.name] = { lastCheck: iso(checkStart), seen: {} };
        out.sources.push({ name: src.name, outcome: 'started', note: cur?.lastCheck ? 'the cursor is older than the window: starts from now (the full check reads the stretch)' : 'no cursor yet: starts from now' });
        continue;
      }
      const from = iso(Date.parse(cur.lastCheck) - WINDOW_MS);
      try {
        const events = await readSource(src, clients, from);
        const neu = events.filter((e) => !(e.id in (cur.seen ?? {})));
        fresh.push(...neu);
        next.sources[src.name] = advance(cur, { checkStart, events });
        out.sources.push({ name: src.name, outcome: 'read', from, events: events.length, new: neu.length });
      } catch (e) {
        out.sources.push({ name: src.name, outcome: 'failed', from, error: errorText(e), note: 'the cursor stays' });
      }
    }
    out.events = fresh.length;

    // 2. The tickets: of the changed PRs, and those whose wait ended.
    const { ledgers, bad } = readLedgersApart(settings.state);
    for (const b of bad) out.notes.push(`the ledger ${b.key} does not read (${b.error}): the full check reports it`);
    const looks = new Map();
    for (const [key, events] of ticketsOf(fresh, ledgers).keys) looks.set(key, [...new Set(events.map((e) => `${e.repo}#${e.number}`))]);
    for (const key of dueWaits(waits, checkStart)) if (!looks.has(key)) looks.set(key, waits[key].prs ?? null);
    const locks = allLocks(settings.state, checkStart).filter((x) => x.live);
    // The full check's live runs too (lib/dispatch.mjs): a ticket it handed on is held as one of ours.
    const fullRuns = fullHandOns(settings.state).filter((h) => handOnLive(h, { now: checkStart, isAlive }));
    const running = new Set([...next.handOns, ...fullRuns].flatMap((h) => h.keys));
    const handing = [];
    for (const [key, prIds] of looks) {
      const l = ledgers.find((x) => x.key === key);
      // A closed ticket, or one in the owner's hands: nothing to hand on.
      if (!l || l.stages?.close?.status === 'done' || l.mode === 'hand') {
        delete waits[key];
        continue;
      }
      // Its last run failed or died: it waits out its interval, whatever comes meanwhile.
      if (waits[key]?.backoff && Date.parse(waits[key].dueAt) > checkStart) continue;
      // A run holds it (its group's lock, or a run of ours that may not have taken it yet): its comments wait for the
      // next session; looked at again at the next tick, with no forge read now.
      if (running.has(key) || locks.some((x) => x.group === (l.group ?? l.key))) {
        out.held.push(key);
        waits[key] = { prs: prIds, dueAt: iso(checkStart), why: 'a run holds the ticket', since: prev.waits?.[key]?.since ?? iso(checkStart) };
        continue;
      }
      let w;
      try {
        w = await commentWait({ settings, clients, ledger: l, prIds, now: clock() });
      } catch (e) {
        out.sources.push({ name: `activity:${key}`, outcome: 'failed', error: errorText(e), note: 'looked at again at the next tick' });
        waits[key] = { prs: prIds, dueAt: iso(checkStart), why: 'its comments could not be read', since: prev.waits?.[key]?.since ?? iso(checkStart) };
        continue;
      }
      out.tickets.push({ key, comments: w.comments, ready: w.ready, why: w.why });
      if (!w.comments) delete waits[key];
      else if (w.ready) handing.push(key);
      else waits[key] = waitEntry(key, w, prev.waits?.[key], { out, say, now: checkStart });
    }

    // 3. The hand-on: one run for the tickets ready now, in a process of its own; this check doesn't wait for it. At
    // `limits.parallel` runs going across processes, counted as the runner counts them (`runsGoing`: the groups with a
    // live lock, and our live runs that hold none yet), the tickets wait for a slot.
    if (handing.length) {
      const groupOf = (k) => ledgers.find((x) => x.key === k)?.group ?? k;
      const busy = runsGoing({ locks, handOns: [...next.handOns, ...fullRuns], now: checkStart, isAlive, groupOf }).size;
      const limit = settings.limits.parallel;
      if (typeof limit === 'number' && busy >= limit) {
        out.notes.push(`${busy} run(s) going, limits.parallel ${limit}: ${handing.join(', ')} wait for a slot`);
        requeue(handing, `the runs are at limits.parallel (${limit})`, checkStart);
      } else {
        const id = handOnId(checkStart);
        say({ kind: 'watch', keys: handing, outcome: 'handed', note: `the forge check: comments to answer on ${handing.join(', ')}; the run goes on in a process of its own (${id})` });
        try {
          const args = handOnArgs(settings, { id, keys: handing, claude });
          // A dry run plans: it names the run it would start, and starts none.
          const child = dryRun ? { pid: null, planned: args } : io.spawn ? io.spawn(args, { settings, kind: 'hand-on' }) : spawnDetached(args, { settings, env: io.env ?? process.env });
          out.handed = handing;
          out.handOn = { id, pid: child.pid };
          next.handOns.push({ id, pid: child.pid, keys: handing, at: iso(checkStart) });
          for (const k of handing) delete waits[k];
        } catch (e) {
          failed('the hand-on', e);
          requeue(handing, `its run could not start: ${errorText(e)}`, checkStart + fullMs);
        }
      }
    }

    if (!dryRun) {
      for (const k of Object.keys(next.notified ?? {})) if (!k.includes(today)) delete next.notified[k];
      const notes = [...out.finished.flatMap((f) => notificationsOf({ run: f.run, today })), ...notificationsOf({ errors: out.errors, today })];
      for (const n of notes) {
        if (next.notified?.[n.key]) continue;
        const r = (io.notify ?? notify)(n, io.notifyIo ?? {});
        (next.notified ??= {})[n.key] = iso(clock());
        out.notified.push({ title: n.title, text: n.text, urgent: n.urgent, ...r });
        if (n.error) say({ kind: 'watch', what: n.error.part, outcome: 'failed', note: n.error.error });
      }
      writeForge(settings.state, next);
      appendRunLog(settings.state, today, log);
      // The progress file and the gates' notifications, after one of its runs ended: the full check writes them otherwise.
      if (out.finished.length) progressAfterCheck({ settings, now: clock(), notify: io.notify, notifyIo: io.notifyIo ?? {} });
    }
    out.log = log;
    out.quiet = !out.handed.length && !out.errors.length && !out.finished.length && !out.waiting.some((x) => x.new);
    return out;
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------------ the hand-on

// A check's /usage reading a hand-on starts from, when it is no older than this; an older one is read again.
export const USAGE_FRESH_MS = 10 * 60000;

// A hand-on's process (`watcher.mjs --hand-on <id> --ticket <key>…`): the runner's watcher run for these tickets; its
// result goes to `watch/hand-on/<id>.json` for the next check of the one that started it. One the full check started
// has its step file (lib/dispatch.mjs): one group, from the check's /usage reading; a start is a scheduled run of that
// group's start (`startKeys`), and a finishing step the morning run handed on keeps its one more try (`retryWaiting`).
export async function runHandOn({ settings, clients, io = {}, options = {} }) {
  const { id, keys = [], claude = 'claude', dryRun = false } = options;
  const clock = io.now ?? Date.now;
  const at = iso(clock());
  const run = io.runDaily ?? runDaily;
  const runnerIo = { ...(io.runner ?? {}), ...(io.claudeEnv ? { claudeEnv: io.claudeEnv } : {}) };
  const handed = readHandOnStep(settings.state, id);
  if (handed && !dryRun) dropHandOnStep(settings.state, id);
  const usage = handed?.usage && clock() - Date.parse(handed.usageAt) < USAGE_FRESH_MS ? { usage: handed.usage } : {};
  const runOptions = !handed
    ? { dryRun, trigger: 'watcher', named: keys, claude }
    : handed.step?.stage === 'start'
      ? { dryRun, trigger: 'schedule', startKeys: keys, claude, handOnId: id, retryWaiting: Boolean(handed.retryWaiting), ...usage }
      : { dryRun, trigger: 'watcher', named: keys, claude, handOnId: id, retryWaiting: Boolean(handed.retryWaiting), ...usage };
  let result;
  try {
    const r = await run({ settings, clients, io: runnerIo, options: runOptions });
    result = { kind: 'hand-on', id, keys, at, ended: iso(clock()), run: summaryOf(r) };
  } catch (e) {
    result = { kind: 'hand-on', id, keys, at, ended: iso(clock()), error: errorText(e) };
  }
  if (!dryRun) writeHandOn(settings.state, id, result);
  return result;
}

// ------------------------------------------------------------------ the tick

// Whether a tick starts the full check: `schedule.watchMinutes` since the last full check began (half a tick early
// counts: launchd's interval drifts), or none known, or a clock gone back. With no forge check (`schedule.forgeSeconds`
// none, or not shorter than the full interval) every tick is a full check.
export function checkKindOf(settings, feed, now) {
  const fullMs = settings.schedule.watchMinutes * 60000;
  const tickMs = tickSecondsOf(settings) * 1000;
  if (tickMs >= fullMs) return 'full';
  const last = Date.parse(feed?.fullAt ?? '');
  if (!Number.isFinite(last) || now < last) return 'full';
  return now - last >= fullMs - tickMs / 2 ? 'full' : 'forge';
}

// One tick of the LaunchAgent. `options.kind` 'full' or 'forge' runs that check here and now. Otherwise: with no forge
// check, the full check here, as before; with one, the forge check here, and, when it is due and no full check runs
// (its lock's holder is alive), the full check started as a process of its own, which this tick doesn't wait for.
export async function runTick({ settings, clients, io = {}, options = {} }) {
  if (options.kind === 'full') return runCheck({ settings, clients, io, options });
  if (options.kind === 'forge') return runForgeCheck({ settings, clients, io, options });
  const now = (io.now ?? Date.now)();
  if (tickSecondsOf(settings) >= settings.schedule.watchMinutes * 60) return runCheck({ settings, clients, io, options });
  let kind = 'full';
  try {
    kind = checkKindOf(settings, readFeed(settings.state), now);
  } catch {
    /* a feed that doesn't read: the full check reports it */
  }
  let full = null;
  if (kind === 'full' && settings.mode !== 'off') {
    const holder = watchLockHolder(settings.state, { now, ...(io.isAlive ? { isAlive: io.isAlive } : {}) });
    if (holder) full = { running: true, pid: holder.pid, since: holder.startedAt };
    else if (options.dryRun) full = { planned: fullArgs(settings, { claude: options.claude ?? 'claude', dryRun: true }) };
    else {
      try {
        const args = fullArgs(settings, { claude: options.claude ?? 'claude' });
        const child = io.spawn ? io.spawn(args, { settings, kind: 'full' }) : spawnDetached(args, { settings, env: io.env ?? process.env });
        full = { started: true, pid: child.pid };
      } catch (e) {
        full = { error: errorText(e) };
      }
    }
  }
  const out = await runForgeCheck({ settings, clients, io, options });
  if (full) out.full = full;
  if (full?.error) out.quiet = false;
  return out;
}
