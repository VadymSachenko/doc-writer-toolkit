import fs from 'node:fs';
import path from 'node:path';
import { computeStatus } from './status.mjs';
import { makeGit } from './world.mjs';
import { readLedger, readLedgersApart } from './ledger.mjs';
import { allLocks } from './locks.mjs';
import { runDaily, readUsageTried, noUsageReading, parseResult, readyGroupsOf } from './runner.mjs';
import { parseStartHours, tickSecondsOf } from './settings.mjs';
import { allowanceOf } from './allowance.mjs';
import { appendRunLog, localDate } from './report.mjs';
import { latestRearm, readRearm } from './setlocal.mjs';
import { rearmJob } from './rearm.mjs';
import { ALERT_MS, HOLD_MS, WINDOW_MS, advance, pauseMs, readFeed, readSource, sourcesOf, ticketsOf, watchDir, writeFeed } from './feed.mjs';
import { jobCommand, jobDue, jobEnv, listChanges, listMatcher, spawnJob, updateWatchState, writeJobLog } from './jobs.mjs';
import { notificationsOf, notify, startedOf } from './notify.mjs';
import { progressAfterCheck } from './progress.mjs';
import { commentWait, dueWaits } from './quiet.mjs';

// One check of the watcher (design §5, D-048), started by launchd every few minutes. No model call of its own:
//   1. read every source since its cursor; a check that finds nothing ends here, with no status, no runner, no claude;
//      a source failing for ALERT_MS of the watcher's awake time is a failed part (one per client), and so is its gap;
//   2. map the new events to the host jobs' watched lists, and 3. to tickets through the ledgers;
//   4. once a day after `schedule.morning`, the morning run (triage, finishing, starts) instead of step 5;
//   5. `ticket-state status` for the tickets that changed; the runner finishes those that have a next step, each once;
//   then the cursors, written after the hand-off;
//   5b. inside `limits.startHours`, a start pass (triage, then starts, as a scheduled run) once per change of what a
//   start depends on: a slot freed, a new ready group or intake card due, a new day (see startPassOf);
//   6. the host jobs that are due; 7. the notifications.
// An error in one part is caught there, reported and notified, and the rest of the check goes on.
// One check at a time: a lock in `<state>/watch/active/`, freed when its process is gone.
// Between full checks, the forge check (runForgeCheck, D-126): the PRs that changed only, for the comments on them.
// Both hand a ticket whose next step answers comments on only once the comments are quiet (lib/quiet.mjs).

const iso = (ms) => new Date(ms).toISOString();
const STALE_MS = 12 * 3600 * 1000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export function takeWatchLock(state, { pid = process.pid, now = Date.now(), isAlive = alive } = {}) {
  const dir = path.join(watchDir(state), 'active');
  fs.mkdirSync(watchDir(state), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid, startedAt: iso(now) }) + '\n');
      return { taken: true, release: () => fs.rmSync(dir, { recursive: true, force: true }) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      } catch {
        /* being written */
      }
      const age = now - (owner?.startedAt ? Date.parse(owner.startedAt) : fs.statSync(dir).mtimeMs);
      const stale = owner ? !isAlive(owner.pid) || age > STALE_MS : age > 60000;
      if (!stale || attempt) return { taken: false, held: owner };
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { taken: false, held: null };
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const localMinutes = (ms) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

// The next time the morning run is due after `ms`: today's `schedule.morning` if it is still ahead, else tomorrow's.
export function nextMorning(ms, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ------------------------------------------------------------------ the start pass

// Whether a time is inside `limits.startHours`, local time: only then does the watcher triage and start between
// morning runs. Following open tickets goes on at any hour.
export function inStartHours(ms, spec) {
  const h = parseStartHours(spec) ?? parseStartHours('10-22');
  const m = localMinutes(ms);
  return m >= h.from && m < h.to;
}

// When the start hours that hold `ms` end (ms), local time.
export function startHoursEnd(ms, spec) {
  const h = parseStartHours(spec) ?? parseStartHours('10-22');
  const d = new Date(ms);
  d.setHours(0, h.to, 0, 0);
  return d.getTime();
}

// What a start depends on, as one look at the flow saw it: the date, the open tickets, the ready groups (a group whose
// start failed waits apart, lib/limits.mjs) and the intake cards due for triage. The allowance is not in it: a pass
// stopped by the day's allowance runs again only after one of these changes, or on the next day.
export function startPrint({ date, openKeys = [], ready = [], intakeDue = [] }) {
  const sorted = (xs) => [...(xs ?? [])].map(String).sort();
  return { date, open: sorted(openKeys), ready: sorted(ready), intakeDue: sorted(intakeDue) };
}
const printOfStatus = (st, date) => startPrint({ date, openKeys: st.wip?.openKeys, ready: readyGroupsOf(st), intakeDue: (st.intake?.due ?? []).map((c) => c.key) });
const printOfSummary = (s, date) => (s?.wip ? startPrint({ date, openKeys: s.wip.openKeys, ready: s.ready, intakeDue: s.intakeDue }) : null);

const gone = (a = [], b = []) => a.filter((x) => !b.includes(x));

// The intake cards due now that weren't at the last look: the only ones a watcher pass triages. A card whose triage
// failed stays due, so it waits for the next morning run, or for a person (a comment puts it back in its quiet hours,
// and it is new once due again).
export function newlyDue(last, now) {
  return last ? gone(now.intakeDue, last.intakeDue) : [...now.intakeDue];
}

// Why a start pass is due, from the print the last look left and the one seen now; null when nothing changed that
// could let a start or a triage happen. Only these count: a ticket no longer open, a group newly ready, an intake card
// newly due, a new date. The open tickets growing, a ready group gone, a card back in its quiet hours: none.
export function changeOf(last, now) {
  if (!last) return 'no start pass yet';
  if (last.date !== now.date) return 'a new day';
  const why = [];
  const left = gone(last.open, now.open);
  if (left.length) why.push(`a slot freed: ${left.join(', ')} no longer open`);
  const ready = gone(now.ready, last.ready);
  if (ready.length) why.push(`newly ready: ${ready.join(', ')}`);
  const due = newlyDue(last, now);
  if (due.length) why.push(`due for triage: ${due.join(', ')}`);
  return why.length ? why.join('; ') : null;
}

// Why no group can start now, whatever the allowance, from the counts alone (each one a condition `startable` holds
// to as well), or null.
export function noRoomOf(wip) {
  const l = wip?.limits ?? {};
  if (l.open !== null && l.open !== undefined && wip.open >= l.open) return `${wip.open} open (${(wip.openKeys ?? []).join(', ')}) of ${l.open}`;
  if (typeof l.inProgress === 'number' && wip.inProgress >= l.inProgress) return `${wip.inProgress} in progress of ${l.inProgress}`;
  if (typeof l.waiting === 'number' && wip.waiting >= l.waiting) return `${wip.waiting} waiting of ${l.waiting}`;
  return null;
}

// A start pass that failed before its first step is tried again after this long, not at every check.
export const RETRY_MS = 30 * 60 * 1000;

// A card that came into, or changed in, the ready or the intake list of the flow's board.
const START_STATUSES = new Set(['ready', 'intake']);

const errorText = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);
const HOUR = 3600 * 1000;

// A source failure that lasts is told per client, not per board or repo: a token that is gone fails them all. The
// client's own error is cut short, so the notification (240 characters) keeps both the error and what to check.
const CLIENTS = {
  tracker: { part: 'the tracker', check: 'its token and key (tracker.credentials) and the network' },
  forge: { part: 'the forge', check: 'its sign-in and the network' },
};
const clientOf = (name) => (name.startsWith('board:') ? CLIENTS.tracker : CLIENTS.forge);
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function runCheck({ settings, clients, io = {}, options = {} }) {
  const { dryRun = false, claude = 'claude' } = options;
  const clock = io.now ?? Date.now;
  const checkStart = clock();
  const today = localDate(checkStart);
  const out = { kind: 'full', mode: settings.mode, dryRun, at: iso(checkStart), sources: [], events: 0, unmapped: 0, tickets: [], handed: [], waiting: [], pending: [], morning: null, run: null, jobs: [], errors: [], capped: [], notified: [], notes: [...(options.notes ?? [])] };
  if (settings.mode === 'off') {
    out.stopped = 'mode off: nothing runs';
    return out;
  }
  const lock = dryRun ? { taken: true, release: () => {} } : takeWatchLock(settings.state, { now: checkStart, ...(io.isAlive ? { isAlive: io.isAlive } : {}) });
  if (!lock.taken) {
    out.skipped = `another check or run holds the watcher lock${lock.held ? ` (pid ${lock.held.pid}, since ${lock.held.startedAt})` : ''}: nothing read, the cursors stay`;
    return out;
  }
  const log = [];
  const say = (e) => log.push({ at: iso(clock()), ...e });
  // An error in one part of the check is caught there: the rest goes on, and the reason is reported and notified.
  const failed = (part, e) => out.errors.push({ part, error: errorText(e) });
  try {
    const feed = readFeed(settings.state);
    const next = structuredClone(feed);
    // The watcher's awake time: a check that comes more than a pause after the last one ended (the Mac asleep, the
    // agent off) starts it again, so a failure counts only from the first check after a wake.
    const sinceLast = checkStart - Date.parse(feed.checkedAt ?? '');
    const awakeSince = feed.awakeSince && sinceLast <= pauseMs(settings) ? Date.parse(feed.awakeSince) : checkStart;
    next.awakeSince = iso(awakeSince);
    // When the last full check began: the watcher's tick runs the next one `watchMinutes` after it (checkKindOf).
    next.fullAt = iso(checkStart);
    const afterMorning = localMinutes(checkStart) >= minutesOf(settings.schedule.morning);

    // 1. The sources. One that fails keeps its cursor; after HOLD_MS of failing the gap is reported and it starts again.
    const failSource = (src, cur, error) => {
      const from = iso(Date.parse(cur.lastCheck) - WINDOW_MS);
      if (checkStart - Date.parse(cur.lastCheck) > HOLD_MS) {
        next.sources[src.name] = { lastCheck: iso(checkStart), seen: {}, failingSince: cur.failingSince ?? iso(checkStart), lastError: error };
        say({ kind: 'feed', what: src.name, outcome: 'failed', note: `a gap: nothing read from ${cur.lastCheck} to ${iso(checkStart)} (failing: ${error}); the morning run reconciles every open ticket` });
        return { name: src.name, outcome: 'gap', from, error };
      }
      next.sources[src.name] = { ...cur, failingSince: cur.failingSince ?? iso(checkStart), lastError: error };
      return { name: src.name, outcome: 'failed', from, error, note: 'the cursor stays; the next check reads the same window' };
    };
    let fresh = [];
    for (const src of sourcesOf(settings)) {
      const cur = feed.sources[src.name];
      if (!cur?.lastCheck) {
        next.sources[src.name] = { lastCheck: iso(checkStart), seen: {} };
        out.sources.push({ name: src.name, outcome: 'started', note: 'no cursor yet: starts from now' });
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
        out.sources.push(failSource(src, cur, errorText(e)));
      }
    }

    // A read that has failed for ALERT_MS of awake time is a failed part, so the once-a-day urgent notification tells the
    // owner: one per client, after `schedule.morning` (the board's failure keeps the morning run waiting meanwhile).
    // Its 24-hour gap is one more, at the gap; a gap that is mostly a sleep is only logged. Taken from the reads alone:
    // a watched list that can't be matched (step 2) is already its job's failed part.
    const lasting = new Map();
    for (const s of out.sources.filter((x) => x.outcome === 'failed' || x.outcome === 'gap')) {
      const since = Date.parse(next.sources[s.name].failingSince ?? iso(checkStart));
      if (checkStart - Math.max(since, awakeSince) < ALERT_MS) continue;
      const client = clientOf(s.name);
      const l = lasting.get(client) ?? { since, error: s.error, gap: false };
      if (since < l.since) Object.assign(l, { since, error: s.error });
      lasting.set(client, { ...l, gap: l.gap || s.outcome === 'gap' });
    }
    for (const [client, l] of lasting) {
      const why = `(${short(l.error)}). Check ${client.check}.`;
      if (afterMorning) failed(client.part, `unreadable for ${Math.floor((checkStart - l.since) / HOUR)} h ${why}`);
      if (l.gap) failed(`${client.part}'s events`, `a 24-hour gap, nothing read ${why}`);
    }

    // 2. The host jobs' watched lists. A list that can't be matched (renamed, or its board's lists unreadable) fails
    // its board's source for this check, as a failed read would: the cursor stays, and none of its events is used.
    for (const job of settings.hostJobs) {
      if (!job.watch) continue;
      const events = fresh.filter((e) => e.board === job.watch.board);
      if (!events.length) continue;
      try {
        const inList = await listMatcher(job, { settings, clients });
        next.jobs[job.name] = updateWatchState(next.jobs[job.name], listChanges(events, inList));
      } catch (e) {
        const name = `board:${job.watch.board}`;
        failed(`job ${job.name}`, e);
        const i = out.sources.findIndex((x) => x.name === name);
        out.sources[i] = failSource({ name }, feed.sources[name], `job ${job.name}: ${errorText(e)}`);
        fresh = fresh.filter((x) => x.board !== job.watch.board);
        for (const other of settings.hostJobs) if (other.watch?.board === job.watch.board && other !== job) next.jobs[other.name] = feed.jobs?.[other.name] ?? next.jobs[other.name];
      }
    }
    out.events = fresh.length;

    // 3. Tickets. A ledger file that doesn't read is reported, and its ticket kept in `pending` (its events can't be
    // mapped without it); the others map as usual.
    let keys = new Map();
    let unmapped = [];
    const wanted = [...(feed.pending ?? [])];
    const want = (k) => !wanted.includes(k) && wanted.push(k);
    try {
      const { ledgers, bad } = readLedgersApart(settings.state);
      for (const b of bad) {
        failed(`the ledger ${b.key}`, b.error);
        want(b.key);
      }
      const mapped = ticketsOf(fresh, ledgers);
      keys = mapped.keys;
      unmapped = mapped.unmapped;
      out.unmapped = mapped.unmapped.length;
      for (const k of keys.keys()) want(k);
      // A `set retry` since the last check: the tickets whose last session failed, or that hit the cap, are looked at.
      const rearmed = latestRearm(readRearm(settings.state));
      if (rearmed && rearmed > (feed.rearmSeen ? Date.parse(feed.rearmSeen) : 0)) {
        for (const l of ledgers) if ((l.runs ?? []).length) want(l.key);
        next.rearmSeen = iso(rearmed);
      }
    } catch (e) {
      failed('the ledgers', e);
    }
    // The tickets whose comments were waiting to be quiet and now are: no event comes from a quiet PR.
    for (const k of dueWaits(feed.commentWaits, checkStart)) want(k);

    // 4 and 5. The morning run, or the tickets that changed. What could not be handed on stays in `pending`.
    const run = io.runDaily ?? runDaily;
    const runnerIo = { ...(io.runner ?? {}), ...(io.claudeEnv ? { claudeEnv: io.claudeEnv } : {}) };
    // Not in a check whose own board couldn't be read (a Mac just awake, its network not up yet): the next check runs it.
    const board = out.sources.find((x) => x.name === `board:${settings.tracker.board}`);
    const offline = board && (board.outcome === 'failed' || board.outcome === 'gap');
    const morningDue = next.morning?.lastDate !== today && afterMorning;
    // The status this check read for the tickets that changed (every ticket's counts are in it), for the start pass.
    let seen = null;
    if (morningDue && offline) out.notes.push(`the morning run waits: the board can't be read in this check (${board.error})`);
    next.pending = [];
    if (morningDue && !offline) {
      const progress = {};
      let begun = true;
      try {
        out.morning = await run({ settings, clients, io: runnerIo, options: { dryRun, morning: true, trigger: 'schedule', claude, progress } });
        out.handed = wanted;
      } catch (e) {
        // A morning run that failed before its first step is started again at the next check; one that failed part
        // way counts as the day's, so its triage, starts and retries are not repeated at every check.
        failed('the morning run', e);
        next.pending = wanted;
        begun = Boolean(progress.begun);
      }
      if (begun) next.morning = { lastDate: today, at: iso(clock()), ...(out.errors.some((x) => x.part === 'the morning run') ? { error: out.errors.at(-1).error } : {}) };
      // The morning run is the day's first start pass: what it left is what the watcher's next pass compares with.
      if (begun) next.starts = { date: today, at: iso(clock()), by: 'morning', print: printOfSummary(out.morning?.after, today), nextDueAt: out.morning?.after?.intakeQuietAt ?? null, deferred: null, outcome: out.morning ? 'the morning run' : 'the morning run failed part way' };
    } else if (wanted.length) {
      let st = null;
      try {
        st = await computeStatus({ settings, clients, now: checkStart, only: wanted, git: io.git ?? makeGit(settings) });
      } catch (e) {
        failed('status', e);
        next.pending = wanted;
      }
      if (st) {
        seen = st;
        out.tickets = st.tickets.map((t) => ({ key: t.key, state: t.state, next: t.next ? t.next.stage : null, locked: Boolean(t.locked), hand: Boolean(t.hand), events: (keys.get(t.key) ?? []).length, ...(t.next?.waits ? { waits: t.next.waits } : {}), ...(t.held ? { held: t.gate.why } : {}) }));
        out.capped = st.tickets.filter((t) => t.capped).map((t) => ({ key: t.key, ...t.capped, why: t.gate.why }));
        // A failed step that waits for a person is not handed on: the runner would read /usage for nothing. A start is
        // handed on only for a card already in work (a person's move, or a recorded start that goes on).
        const runnable = st.tickets.filter((t) => t.next && !t.locked && !t.hand && !t.next.waits && (t.next.stage !== 'start' || t.next.byHand || t.next.again)).map((t) => t.key);
        // A ticket a run holds now is looked at again on the next check, so a change made during that run isn't lost.
        next.pending = st.tickets.filter((t) => t.locked).map((t) => t.key);
        out.handed = wanted;
        // Comments to answer go on once they are quiet (lib/quiet.mjs); until then the ticket waits in `commentWaits`.
        const waits = (next.commentWaits ??= {});
        const handing = [];
        for (const key of runnable) {
          const w = await waitOf(st.tickets.find((t) => t.key === key));
          if (w) waits[key] = w;
          else handing.push(key);
        }
        // A ticket this status saw, not locked and not waiting now, has no wait left: answered, handed on, or another step.
        for (const t of st.tickets) if (!t.locked && !out.waiting.some((x) => x.key === t.key)) delete waits[t.key];
        if (handing.length) {
          say({ kind: 'watch', keys: handing, outcome: 'handed', note: `${fresh.length} new event(s); the runner finishes ${handing.join(', ')}` });
          try {
            out.run = await run({ settings, clients, io: runnerIo, options: { dryRun, trigger: 'watcher', named: handing, claude } });
          } catch (e) {
            failed('the run', e);
            next.pending = [...new Set([...next.pending, ...handing])];
          }
        }
      }
    }
    out.pending = next.pending;

    // The cursors move: every event was handed on, or its ticket is in `pending` or waits in `commentWaits`.
    if (!dryRun) writeFeed(settings.state, next);

    // 5b. The start pass: only once today's morning run has run, and not in the check that ran it. Today is the date
    // the check began on, so a check that began before `schedule.morning` and ran past it leaves the day's first
    // starts to the morning run, and so do start hours that begin before it.
    if (!morningDue && next.morning?.lastDate === today) {
      try {
        out.startPass = await startPassOf();
      } catch (e) {
        failed('the start pass', e);
      }
      if (!out.startPass) delete out.startPass;
    }

    // 6. Host jobs. A watch job whose board wasn't read in this check neither runs nor changes: it hasn't seen the list.
    // A disarmed job re-arms when the reads that failed with it read again, or by `set retry job <name>`; an alert held
    // through the night goes out at the first check after `schedule.morning` if the job is still disarmed (lib/rearm.mjs).
    const rearms = readRearm(settings.state).jobs;
    const heldAlerts = [];
    for (const job of settings.hostJobs) {
      const r = rearmJob(job, next.jobs[job.name] ?? {}, { sources: out.sources, rearmedAt: rearms[job.name], now: checkStart });
      if (r.state !== next.jobs[job.name] && (next.jobs[job.name] || r.rearmed)) next.jobs[job.name] = r.state;
      if (r.rearmed) say({ kind: 'job', job: job.name, outcome: 'rearmed', note: r.rearmed.why });
      // A job that re-armed before the morning (the reads came back, or the owner's `set retry job`) needs no alert:
      // the held one is dropped unsent; the night stays in the job's log.
      const held = next.jobs[job.name]?.alert;
      const back = held && next.jobs[job.name].rearmed && Date.parse(next.jobs[job.name].rearmed.at) >= Date.parse(held.at);
      if (back) next.jobs[job.name] = { ...next.jobs[job.name], alert: null };
      else if (afterMorning && held) {
        heldAlerts.push({ name: job.name, ...held });
        next.jobs[job.name] = { ...next.jobs[job.name], alert: null };
      }
    }
    for (const job of settings.hostJobs) {
      const state = next.jobs[job.name] ?? {};
      const src = job.watch ? out.sources.find((x) => x.name === `board:${job.watch.board}`) : null;
      if (src && (src.outcome === 'failed' || src.outcome === 'gap')) {
        out.jobs.push({ name: job.name, due: false, why: `its board can't be read in this check: ${src.error}` });
        continue;
      }
      const due = jobDue(job, state, checkStart);
      if (!due.due) {
        out.jobs.push({ name: job.name, due: false, ...(due.at ? { at: due.at } : {}), ...(due.why ? { why: due.why } : {}) });
        continue;
      }
      try {
        out.jobs.push(await runJob(job, state));
      } catch (e) {
        failed(`job ${job.name}`, e);
        out.jobs.push({ name: job.name, due: true, outcome: 'failed', note: errorText(e) });
      }
    }

    // 7. Notifications, once a day per reason; a caught error goes to the run log once a day too.
    if (!dryRun) {
      for (const k of Object.keys(next.notified ?? {})) if (!k.includes(today)) delete next.notified[k];
      for (const n of notificationsOf({ morning: out.morning, run: out.run, startPass: out.startPass, jobs: [...out.jobs, ...heldAlerts], errors: out.errors, capped: out.capped ?? [], today })) {
        if (next.notified?.[n.key]) continue;
        const r = (io.notify ?? notify)(n, io.notifyIo ?? {});
        (next.notified ??= {})[n.key] = iso(clock());
        out.notified.push({ title: n.title, text: n.text, urgent: n.urgent, ...r });
        if (n.error) say({ kind: 'watch', what: n.error.part, outcome: 'failed', note: n.error.error });
        if (n.capped) say({ kind: 'step', key: n.capped.key, stage: n.capped.stage, pr: n.capped.pr ?? null, outcome: 'failed', note: n.capped.why });
      }
      // When this check ended: a long run or job inside it is not a pause.
      next.checkedAt = iso(clock());
      writeFeed(settings.state, next);
      appendRunLog(settings.state, today, log);
      progressAfterCheck({ settings, now: clock(), notify: io.notify, notifyIo: io.notifyIo ?? {} });
    }
    out.log = log;
    out.quiet = !fresh.length && !wanted.length && !out.waiting.length && !out.morning && !out.startPass && !out.errors.length && !out.jobs.some((j) => j.due !== false) && out.sources.every((s) => s.outcome !== 'failed' && s.outcome !== 'gap');
    return out;

    // A ticket whose next step answers comments: its wait in `commentWaits` while they aren't quiet yet, else null (it
    // goes on now). A read that fails hands it on, as before the rule.
    async function waitOf(t) {
      if (t?.next?.stage !== 'answerComments') return null;
      let w;
      try {
        w = await commentWait({ settings, clients, ledger: readLedger(settings.state, t.key), prIds: t.next.pr ? [t.next.pr] : null, now: clock() });
      } catch (e) {
        out.notes.push(`${t.key}: the comments' times could not be read (${errorText(e)}): handed on`);
        return null;
      }
      if (w.ready || !w.dueAt) return null;
      return waitEntry(t.key, w, feed.commentWaits?.[t.key], { out, say, now: checkStart });
    }

    // The start pass between morning runs: the runner's triage and starts, as a scheduled run makes them (the same
    // limits, allowance and start order), once per change of what a start depends on (`startPrint`). The memory is
    // `starts` in the feed: the print the last pass (the morning run's or this one's) left, a change seen when no pass
    // could run (`deferred`), and when the next intake card is due (`nextDueAt`). A check reads the status for it only
    // when this check read one anyway (tickets changed), or something may have changed: a card in the ready or intake
    // list, a new day, an intake card due, a change deferred. Inside `limits.startHours` only; outside them a change is
    // kept for the first check inside them (the morning run takes it over).
    async function startPassOf() {
      const last = feed.starts ?? null;
      const cardMoved = unmapped.some((e) => e.board === settings.tracker.board && START_STATUSES.has(e.statusAfter ?? e.status));
      const dueAgain = Boolean(last?.nextDueAt) && checkStart >= Date.parse(last.nextDueAt);
      // The hours at this moment, not at the check's start: the watcher's own run may have taken past their end.
      if (!inStartHours(clock(), settings.limits.startHours) || offline) {
        // A new date alone is no change to keep: the first check inside the hours looks at a new day anyway.
        const why = cardMoved ? 'a card changed in the ready or intake list' : seen && last?.print ? changeOf({ ...last.print, date: today }, printOfStatus(seen, today)) : null;
        if (why && !last?.deferred) next.starts = { ...(last ?? {}), deferred: why };
        return null;
      }
      // A pass that failed before its first step (or its status read) is tried again after RETRY_MS, not at every check.
      if (last?.retryAt && clock() < Date.parse(last.retryAt)) return null;
      const retryLater = (why) => ({ ...(last ?? {}), deferred: last?.deferred ?? why, retryAt: iso(clock() + RETRY_MS) });
      if (!seen && !last?.deferred && last?.date === today && !dueAgain && !cardMoved) return null;
      let view = seen;
      if (!view) {
        try {
          view = await computeStatus({ settings, clients, now: checkStart, only: [], git: io.git ?? makeGit(settings) });
        } catch (e) {
          next.starts = retryLater('the status could not be read');
          throw e;
        }
      }
      const print = printOfStatus(view, today);
      const nextDueAt = view.intake?.waiting?.[0]?.quietAt ?? null;
      // A morning run that failed part way left no print: what this check sees is the day's from now on.
      if (last && !last.print && last.date === today) {
        next.starts = { ...last, print, nextDueAt, deferred: null };
        return null;
      }
      const why = changeOf(last?.print ?? null, print);
      if (!why) {
        // Nothing that could let a start happen; what was seen is the view the next change is measured from.
        if (last) next.starts = { ...last, print, nextDueAt, deferred: null, retryAt: null };
        return null;
      }
      const base = { date: today, at: iso(checkStart), by: 'watcher', print, nextDueAt, deferred: null, retryAt: null };
      // Only the intake cards newly due are triaged here; nothing to triage, and nothing that could start whatever the
      // allowance: no runner, no /usage.
      const triageKeys = newlyDue(last?.print ?? null, print);
      const noRoom = triageKeys.length ? null : !print.ready.length ? 'no ready ticket' : noRoomOf(view.wip);
      if (noRoom) {
        next.starts = { ...base, outcome: `not run: ${noRoom}` };
        return { why, ran: false, skipped: noRoom };
      }
      if (!dryRun) {
        next.starts = { ...base, outcome: 'running' };
        writeFeed(settings.state, next);
      }
      say({ kind: 'watch', what: 'the start pass', outcome: 'handed', note: why });
      const progress = {};
      try {
        // No triage and no further start once the hours end while the pass runs; a started group's chain goes on.
        const startUntil = startHoursEnd(clock(), settings.limits.startHours);
        const r = await run({ settings, clients, io: runnerIo, options: { dryRun, trigger: 'schedule', startPass: true, startUntil, triageKeys, claude, progress } });
        const started = startedOf(r);
        next.starts = { ...base, at: iso(clock()), print: printOfSummary(r.after, today) ?? print, nextDueAt: r.after?.intakeQuietAt ?? nextDueAt, outcome: started.length ? `started ${started.map((s) => s.keys.join(', ')).join('; ')}` : 'started nothing' };
        return { why, ran: true, run: r };
      } catch (e) {
        // One that failed before its first step is tried again after RETRY_MS; one that failed part way counts.
        next.starts = progress.begun ? { ...base, outcome: `failed: ${errorText(e)}` } : { ...retryLater(why), deferred: why };
        throw e;
      }
    }

    // A due host job: run in mode on only; a skill job is a model call, so the guard holds it like a scheduled step.
    async function runJob(job, state) {
      const cmd = jobCommand(job, { settings, state, claude });
      const shown = [cmd.bin, ...cmd.args];
      const done = { ...state, armed: false, firstChange: null, lastRun: iso(checkStart), failures: 0, failingSince: null, heldUntil: null, disarmed: null };
      if (dryRun || settings.mode !== 'on') {
        if (!dryRun) {
          next.jobs[job.name] = done;
          say({ kind: 'job', job: job.name, outcome: 'planned', note: `mode ${settings.mode}: not run` });
        }
        return { name: job.name, due: true, planned: true, command: shown };
      }
      if (cmd.model) {
        const read = io.readUsage ? { usage: await io.readUsage(), tries: null } : await readUsageTried(claude, io.claudeEnv, io.sleep ? { sleep: io.sleep } : {});
        const usage = read.usage;
        const a = allowanceOf(usage, settings.limits, new Date(clock()));
        const held = !a ? noUsageReading(usage ? null : read.tries) : a.remaining <= 0 ? `the week is at ${a.used}%, the allowance by now is ${a.cap}%` : null;
        if (held) {
          next.jobs[job.name] = { ...state, heldUntil: iso(checkStart + 3600000) };
          say({ kind: 'guard', what: `job ${job.name}`, reason: held });
          return { name: job.name, due: true, held };
        }
      }
      const started = clock();
      // A skill job gets the claude environment (the sign-in token); a script never does.
      const env = cmd.model ? io.claudeEnv ?? io.env ?? process.env : io.env ?? process.env;
      const res = await (io.spawnJob ?? spawnJob)(cmd, { cwd: settings.root, env, timeoutMs: job.timeoutMinutes * 60000, extra: jobEnv(job, state) });
      const file = writeJobLog(settings.state, job.name, iso(started), res);
      const result = cmd.model ? parseResult(res.stdout) : null;
      const ok = res.code === 0 && !(result && result.isError);
      // A failed try runs again at the next check, quietly: the job stays armed (a watch job) or keeps its last run (an
      // `every` job). One that has failed at each try for ALERT_MS of awake time, as a source, is disarmed with one
      // urgent notification: a watch job until its next new card, an `every` job until the next morning run. A network
      // drop of a few minutes costs a few tries, not the day, and a sleep is not failing time.
      const failures = ok ? 0 : (state.failures ?? 0) + 1;
      const failingSince = ok ? null : state.failingSince ?? iso(checkStart);
      const lasting = !ok && checkStart - Math.max(Date.parse(failingSince), awakeSince) >= ALERT_MS;
      const until = lasting ? (job.every !== undefined ? iso(nextMorning(checkStart, settings.schedule.morning)) : 'its next new card') : null;
      // Disarmed while reads were failing too (the network, a board): it re-arms once those read again. Before
      // `schedule.morning` its alert is held until the first check after it, as a source's is.
      const downWith = lasting ? out.sources.filter((x) => x.outcome === 'failed' || x.outcome === 'gap').map((x) => x.name) : [];
      const alert = lasting && !afterMorning ? { at: iso(started), since: failingSince, failures, exit: res.code, until } : null;
      next.jobs[job.name] = ok ? done : lasting ? { ...done, lastFailure: iso(started), heldUntil: job.every !== undefined ? until : null, disarmed: { at: iso(started), downWith }, rearmed: null, alert } : { ...state, failures, failingSince };
      const entry = { kind: 'job', job: job.name, outcome: ok ? 'done' : 'failed', exit: res.code, durationMs: clock() - started, log: path.relative(settings.root, file), ...(result?.costUsd !== undefined && result?.costUsd !== null ? { costUsd: result.costUsd } : {}), ...(lasting ? { note: `failed at each try for an hour (${failures} tries); disarmed until ${until}` } : !ok ? { note: 'failed; tried again at the next check' } : {}) };
      say(entry);
      return { name: job.name, due: true, outcome: entry.outcome, exit: res.code, log: entry.log, ...(lasting ? { disarmed: true, failures, until, ...(downWith.length ? { downWith } : {}), ...(alert ? { alertHeld: iso(nextMorning(checkStart, settings.schedule.morning)) } : {}) } : entry.note ? { note: entry.note } : {}) };
    }
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------------ the forge check

// A ticket's entry in `commentWaits` (lib/quiet.mjs): its PRs, when its comments are quiet, why, and since when it
// waits. A wait that is new, or moved by a newer comment, goes to the run log once.
function waitEntry(key, w, prev, { out, say, now }) {
  const entry = { prs: w.prs, dueAt: iso(w.dueAt), why: w.why, since: prev?.since ?? iso(now) };
  const moved = !prev || prev.dueAt !== entry.dueAt;
  out.waiting.push({ key, until: entry.dueAt, why: w.why, ...(moved ? { new: true } : {}) });
  if (moved) say({ kind: 'watch', keys: [key], outcome: 'waits', note: `comments on ${w.prs.join(', ')}: the session starts at ${entry.dueAt} unless a newer one comes (${w.why})` });
  return entry;
}

// The forge check (D-126), between full checks: the owner's and a reviewer's comments on the pipeline's PRs picked up
// within a minute. No model call of its own, and no tracker read: it reads, per repo of the targets, the PRs that
// changed (cursors of its own, `forgeCheck` in the feed, so the full check's are untouched), maps them to tickets
// through the ledgers, reads the activity of each changed PR of a ticket, and hands a ticket with comments to answer to
// the runner (`--watcher`) once they are quiet (lib/quiet.mjs); the tickets in `commentWaits` whose quiet ended are
// looked at with no event. No morning run, no start pass, no host job: the full check keeps those. A ticket a run
// holds waits for that run to end. It shares the watcher's lock: one check at a time.
export async function runForgeCheck({ settings, clients, io = {}, options = {} }) {
  const { dryRun = false, claude = 'claude' } = options;
  const clock = io.now ?? Date.now;
  const checkStart = clock();
  const today = localDate(checkStart);
  const out = { kind: 'forge', mode: settings.mode, dryRun, at: iso(checkStart), sources: [], events: 0, tickets: [], handed: [], waiting: [], held: [], run: null, jobs: [], errors: [], notified: [], notes: [...(options.notes ?? [])] };
  if (settings.mode === 'off') {
    out.stopped = 'mode off: nothing runs';
    return out;
  }
  const lock = dryRun ? { taken: true, release: () => {} } : takeWatchLock(settings.state, { now: checkStart, ...(io.isAlive ? { isAlive: io.isAlive } : {}) });
  if (!lock.taken) {
    out.skipped = `another check or run holds the watcher lock${lock.held ? ` (pid ${lock.held.pid}, since ${lock.held.startedAt})` : ''}: the forge check reads nothing`;
    return out;
  }
  const log = [];
  const say = (e) => log.push({ at: iso(clock()), ...e });
  const failed = (part, e) => out.errors.push({ part, error: errorText(e) });
  try {
    const feed = readFeed(settings.state);
    const next = structuredClone(feed);
    const cursors = (next.forgeCheck ??= { sources: {} }).sources;
    next.forgeCheck.at = iso(checkStart);

    // 1. The PRs that changed, per repo. A cursor older than the window (a sleep, a long run in a check) starts from
    // now: the full check reads that stretch with its own cursors. A read that fails keeps the cursor and is only
    // reported here; the full check tells a source that keeps failing.
    const fresh = [];
    for (const src of sourcesOf(settings).filter((s) => s.kind === 'prs')) {
      const cur = feed.forgeCheck?.sources?.[src.name];
      if (!cur?.lastCheck || checkStart - Date.parse(cur.lastCheck) > WINDOW_MS) {
        cursors[src.name] = { lastCheck: iso(checkStart), seen: {} };
        out.sources.push({ name: src.name, outcome: 'started', note: cur?.lastCheck ? 'the cursor is older than the window: starts from now (the full check reads the stretch)' : 'no cursor yet: starts from now' });
        continue;
      }
      const from = iso(Date.parse(cur.lastCheck) - WINDOW_MS);
      try {
        const events = await readSource(src, clients, from);
        const neu = events.filter((e) => !(e.id in (cur.seen ?? {})));
        fresh.push(...neu);
        cursors[src.name] = advance(cur, { checkStart, events });
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
    for (const key of dueWaits(feed.commentWaits, checkStart)) if (!looks.has(key)) looks.set(key, feed.commentWaits[key].prs ?? null);
    const waits = (next.commentWaits ??= {});
    const locks = allLocks(settings.state, checkStart);
    const handing = [];
    for (const [key, prIds] of looks) {
      const l = ledgers.find((x) => x.key === key);
      // A closed ticket, or one in the owner's hands: nothing to hand on.
      if (!l || l.stages?.close?.status === 'done' || l.mode === 'hand') {
        delete waits[key];
        continue;
      }
      // A run holds it: its comments wait for the next session; looked at again at the next check, with no forge read now.
      if (locks.some((x) => x.group === (l.group ?? l.key) && x.live)) {
        out.held.push(key);
        waits[key] = { prs: prIds, dueAt: iso(checkStart), why: 'a run holds the ticket', since: feed.commentWaits?.[key]?.since ?? iso(checkStart) };
        continue;
      }
      let w;
      try {
        w = await commentWait({ settings, clients, ledger: l, prIds, now: clock() });
      } catch (e) {
        out.sources.push({ name: `activity:${key}`, outcome: 'failed', error: errorText(e), note: 'looked at again at the next check' });
        waits[key] = { prs: prIds, dueAt: iso(checkStart), why: 'its comments could not be read', since: feed.commentWaits?.[key]?.since ?? iso(checkStart) };
        continue;
      }
      out.tickets.push({ key, comments: w.comments, ready: w.ready, why: w.why });
      if (!w.comments) delete waits[key];
      else if (w.ready) {
        handing.push(key);
        delete waits[key];
      } else waits[key] = waitEntry(key, w, feed.commentWaits?.[key], { out, say, now: checkStart });
    }

    // 3. The hand-on: one runner run, as the full check's. A run that throws leaves its tickets to the full check
    // (`pending`), not to the next tick: each try reads /usage.
    if (handing.length) {
      say({ kind: 'watch', keys: handing, outcome: 'handed', note: `the forge check: comments to answer on ${handing.join(', ')}` });
      const run = io.runDaily ?? runDaily;
      const runnerIo = { ...(io.runner ?? {}), ...(io.claudeEnv ? { claudeEnv: io.claudeEnv } : {}) };
      out.handed = handing;
      try {
        out.run = await run({ settings, clients, io: runnerIo, options: { dryRun, trigger: 'watcher', named: handing, claude } });
      } catch (e) {
        failed('the run', e);
        next.pending = [...new Set([...(next.pending ?? []), ...handing])];
      }
    }

    if (!dryRun) {
      for (const k of Object.keys(next.notified ?? {})) if (!k.includes(today)) delete next.notified[k];
      for (const n of notificationsOf({ run: out.run, errors: out.errors, today })) {
        if (next.notified?.[n.key]) continue;
        const r = (io.notify ?? notify)(n, io.notifyIo ?? {});
        (next.notified ??= {})[n.key] = iso(clock());
        out.notified.push({ title: n.title, text: n.text, urgent: n.urgent, ...r });
        if (n.error) say({ kind: 'watch', what: n.error.part, outcome: 'failed', note: n.error.error });
      }
      writeFeed(settings.state, next);
      appendRunLog(settings.state, today, log);
      // The progress file and the gates' notifications, after a hand-on only: the full check writes them otherwise.
      if (out.run) progressAfterCheck({ settings, now: clock(), notify: io.notify, notifyIo: io.notifyIo ?? {} });
    }
    out.log = log;
    out.quiet = !out.handed.length && !out.errors.length && !out.waiting.some((x) => x.new);
    return out;
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------------ the tick

// Which check a tick of the LaunchAgent runs: the full one when `schedule.watchMinutes` have passed since the last
// full check began (half a tick early counts: launchd's interval drifts), when no full check is known, or when there is
// no forge check (`schedule.forgeSeconds` none, or not shorter than the full interval); the forge check otherwise.
export function checkKindOf(settings, feed, now) {
  const fullMs = settings.schedule.watchMinutes * 60000;
  const tickMs = tickSecondsOf(settings) * 1000;
  if (tickMs >= fullMs) return 'full';
  const last = Date.parse(feed?.fullAt ?? '');
  if (!Number.isFinite(last) || now < last) return 'full';
  return now - last >= fullMs - tickMs / 2 ? 'full' : 'forge';
}

// One tick: `options.kind` 'full' or 'forge' forces it; otherwise checkKindOf decides from the feed. A feed that
// doesn't read goes to the full check, which reports it.
export async function runTick({ settings, clients, io = {}, options = {} }) {
  let kind = options.kind ?? null;
  if (!kind) {
    try {
      kind = checkKindOf(settings, readFeed(settings.state), (io.now ?? Date.now)());
    } catch {
      kind = 'full';
    }
  }
  return kind === 'forge' ? runForgeCheck({ settings, clients, io, options }) : runCheck({ settings, clients, io, options });
}
