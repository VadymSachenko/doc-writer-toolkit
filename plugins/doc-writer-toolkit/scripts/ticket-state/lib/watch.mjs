import fs from 'node:fs';
import path from 'node:path';
import { computeStatus } from './status.mjs';
import { makeGit } from './world.mjs';
import { readAllLedgers } from './ledger.mjs';
import { runDaily, readUsageFromClaude, parseResult } from './runner.mjs';
import { allowanceOf } from './allowance.mjs';
import { appendRunLog, localDate } from './report.mjs';
import { readRearm } from './setlocal.mjs';
import { HOLD_MS, WINDOW_MS, advance, readFeed, readSource, sourcesOf, ticketsOf, watchDir, writeFeed } from './feed.mjs';
import { jobCommand, jobDue, jobEnv, listChanges, listMatcher, spawnJob, updateWatchState, writeJobLog } from './jobs.mjs';
import { notificationsOf, notify } from './notify.mjs';

// One check of the watcher (design §5, D-048), started by launchd every few minutes. No model call of its own:
//   1. read every source since its cursor; a check that finds nothing ends here, with no status, no runner, no claude;
//   2. map the new events to the host jobs' watched lists, and 3. to tickets through the ledgers;
//   4. once a day after `schedule.morning`, the morning run (triage, finishing, starts) instead of step 5;
//   5. `ticket-state status` for the tickets that changed; the runner finishes those that have a next step, each once;
//   then the cursors, written after the hand-off; 6. the host jobs that are due; 7. the notifications.
// An error in one part is caught there, reported and notified, and the rest of the check goes on.
// One check at a time: a lock in `<state>/watch/active/`, freed when its process is gone.

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

const errorText = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

export async function runCheck({ settings, clients, io = {}, options = {} }) {
  const { dryRun = false, claude = 'claude' } = options;
  const clock = io.now ?? Date.now;
  const checkStart = clock();
  const today = localDate(checkStart);
  const out = { mode: settings.mode, dryRun, at: iso(checkStart), sources: [], events: 0, unmapped: 0, tickets: [], handed: [], pending: [], morning: null, run: null, jobs: [], errors: [], notified: [], notes: [...(options.notes ?? [])] };
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

    // 1. The sources. One that fails keeps its cursor; after HOLD_MS of failing the gap is reported and it starts again.
    const failSource = (src, cur, error) => {
      const from = iso(Date.parse(cur.lastCheck) - WINDOW_MS);
      if (checkStart - Date.parse(cur.lastCheck) > HOLD_MS) {
        next.sources[src.name] = { lastCheck: iso(checkStart), seen: {} };
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

    // 3. Tickets. Ledgers that can't be read leave the events unmapped: the morning run reconciles them.
    let keys = new Map();
    const wanted = [...(feed.pending ?? [])];
    try {
      const ledgers = readAllLedgers(settings.state);
      const mapped = ticketsOf(fresh, ledgers);
      keys = mapped.keys;
      out.unmapped = mapped.unmapped.length;
      for (const k of keys.keys()) if (!wanted.includes(k)) wanted.push(k);
      // A `set` since the last check re-arms the failed steps: their tickets are looked at now.
      const rearmed = readRearm(settings.state);
      if (rearmed && rearmed > (feed.rearmSeen ? Date.parse(feed.rearmSeen) : 0)) {
        for (const l of ledgers) if ((l.runs ?? []).at(-1)?.outcome === 'failed' && !wanted.includes(l.key)) wanted.push(l.key);
        next.rearmSeen = iso(rearmed);
      }
    } catch (e) {
      failed('the ledgers', e);
    }

    // 4 and 5. The morning run, or the tickets that changed. What could not be handed on stays in `pending`.
    const run = io.runDaily ?? runDaily;
    const runnerIo = { ...(io.runner ?? {}), ...(io.claudeEnv ? { claudeEnv: io.claudeEnv } : {}) };
    const morningDue = next.morning?.lastDate !== today && localMinutes(checkStart) >= minutesOf(settings.schedule.morning);
    next.pending = [];
    if (morningDue) {
      try {
        out.morning = await run({ settings, clients, io: runnerIo, options: { dryRun, morning: true, trigger: 'schedule', claude } });
        out.handed = wanted;
      } catch (e) {
        // Once a day all the same: a morning run that fails is not started again at every check.
        failed('the morning run', e);
        next.pending = wanted;
      }
      next.morning = { lastDate: today, at: iso(clock()), ...(out.errors.some((x) => x.part === 'the morning run') ? { error: out.errors.at(-1).error } : {}) };
    } else if (wanted.length) {
      let st = null;
      try {
        st = await computeStatus({ settings, clients, now: checkStart, only: wanted, git: io.git ?? makeGit(settings) });
      } catch (e) {
        failed('status', e);
        next.pending = wanted;
      }
      if (st) {
        out.tickets = st.tickets.map((t) => ({ key: t.key, state: t.state, next: t.next ? t.next.stage : null, locked: Boolean(t.locked), hand: Boolean(t.hand), events: (keys.get(t.key) ?? []).length, ...(t.next?.waits ? { waits: t.next.waits } : {}), ...(t.held ? { held: t.gate.why } : {}) }));
        // A failed step that waits for a person is not handed on: the runner would read /usage for nothing.
        const runnable = st.tickets.filter((t) => t.next && !t.locked && !t.hand && !t.next.waits && (t.next.stage !== 'start' || t.next.byHand)).map((t) => t.key);
        // A ticket a run holds now is looked at again on the next check, so a change made during that run isn't lost.
        next.pending = st.tickets.filter((t) => t.locked).map((t) => t.key);
        out.handed = wanted;
        if (runnable.length) {
          say({ kind: 'watch', keys: runnable, outcome: 'handed', note: `${fresh.length} new event(s); the runner finishes ${runnable.join(', ')}` });
          try {
            out.run = await run({ settings, clients, io: runnerIo, options: { dryRun, trigger: 'watcher', named: runnable, claude } });
          } catch (e) {
            failed('the run', e);
            next.pending = [...new Set([...next.pending, ...runnable])];
          }
        }
      }
    }
    out.pending = next.pending;

    // The cursors move: every event was handed on, or its ticket is in `pending`.
    if (!dryRun) writeFeed(settings.state, next);

    // 6. Host jobs. A watch job whose board wasn't read in this check neither runs nor changes: it hasn't seen the list.
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
      for (const n of notificationsOf({ morning: out.morning, run: out.run, jobs: out.jobs, errors: out.errors, today })) {
        if (next.notified?.[n.key]) continue;
        const r = (io.notify ?? notify)(n, io.notifyIo ?? {});
        (next.notified ??= {})[n.key] = iso(clock());
        out.notified.push({ title: n.title, text: n.text, urgent: n.urgent, ...r });
        if (n.error) say({ kind: 'watch', what: n.error.part, outcome: 'failed', note: n.error.error });
      }
      writeFeed(settings.state, next);
      appendRunLog(settings.state, today, log);
    }
    out.log = log;
    out.quiet = !fresh.length && !wanted.length && !out.morning && !out.errors.length && !out.jobs.some((j) => j.due !== false) && out.sources.every((s) => s.outcome !== 'failed' && s.outcome !== 'gap');
    return out;

    // A due host job: run in mode on only; a skill job is a model call, so the guard holds it like a scheduled step.
    async function runJob(job, state) {
      const cmd = jobCommand(job, { settings, state, claude });
      const shown = [cmd.bin, ...cmd.args];
      const done = { ...state, armed: false, firstChange: null, lastRun: iso(checkStart), failures: 0, heldUntil: null };
      if (dryRun || settings.mode !== 'on') {
        if (!dryRun) {
          next.jobs[job.name] = done;
          say({ kind: 'job', job: job.name, outcome: 'planned', note: `mode ${settings.mode}: not run` });
        }
        return { name: job.name, due: true, planned: true, command: shown };
      }
      if (cmd.model) {
        const usage = await (io.readUsage ?? (() => readUsageFromClaude(claude, io.claudeEnv)))();
        const a = allowanceOf(usage, settings.limits, new Date(clock()));
        const held = !a ? 'no usage reading: no scheduled start' : a.remaining <= 0 ? `the week is at ${a.used}%, the allowance by now is ${a.cap}%` : null;
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
      const failures = ok ? 0 : (state.failures ?? 0) + 1;
      const twice = failures >= 2;
      // Failed twice in a row: disarmed. A watch job waits for its next new card; an `every` job for the next morning run.
      const until = twice && job.every !== undefined ? iso(nextMorning(checkStart, settings.schedule.morning)) : null;
      next.jobs[job.name] = ok || twice ? { ...done, ...(twice ? { lastFailure: iso(started), heldUntil: until } : {}) } : { ...state, failures };
      const entry = { kind: 'job', job: job.name, outcome: ok ? 'done' : 'failed', exit: res.code, durationMs: clock() - started, log: path.relative(settings.root, file), ...(result?.costUsd !== undefined && result?.costUsd !== null ? { costUsd: result.costUsd } : {}), ...(twice ? { note: `failed twice; disarmed until ${until ?? 'its next new card'}` } : !ok ? { note: 'failed; tried again on the next check' } : {}) };
      say(entry);
      return { name: job.name, due: true, outcome: entry.outcome, exit: res.code, log: entry.log, ...(twice ? { note: 'failed twice', until: until ?? 'its next new card' } : entry.note ? { note: entry.note } : {}) };
    }
  } finally {
    lock.release();
  }
}
