import fs from 'node:fs';
import path from 'node:path';
import { computeStatus } from './status.mjs';
import { makeGit } from './world.mjs';
import { readAllLedgers } from './ledger.mjs';
import { runDaily, readUsageFromClaude, parseResult } from './runner.mjs';
import { allowanceOf } from './allowance.mjs';
import { appendRunLog, localDate } from './report.mjs';
import { HOLD_MS, WINDOW_MS, advance, readFeed, readSource, sourcesOf, ticketsOf, watchDir, writeFeed } from './feed.mjs';
import { jobCommand, jobDue, jobEnv, listChanges, listMatcher, spawnJob, updateWatchState, writeJobLog } from './jobs.mjs';
import { notificationsOf, notify } from './notify.mjs';

// One check of the watcher (design §5, D-048), started by launchd every few minutes. No model call of its own:
//   1. read every source since its cursor; a check that finds nothing ends here, with no status, no runner, no claude;
//   2. map the new events to tickets through the ledgers, and to the host jobs' watched lists;
//   3. once a day after `schedule.morning`, the morning run (triage, finishing, starts) instead of step 4;
//   4. `ticket-state status` for the tickets that changed; the runner finishes those that have a next step, each once;
//   5. the host jobs that are due; 6. the cursors, written only after the hand-off; 7. the notifications.
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

export async function runCheck({ settings, clients, io = {}, options = {} }) {
  const { dryRun = false, claude = 'claude' } = options;
  const clock = io.now ?? Date.now;
  const checkStart = clock();
  const today = localDate(checkStart);
  const out = { mode: settings.mode, dryRun, at: iso(checkStart), sources: [], events: 0, unmapped: 0, tickets: [], handed: [], pending: [], morning: null, run: null, jobs: [], notified: [], notes: [...(options.notes ?? [])] };
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
  try {
    const feed = readFeed(settings.state);
    const next = structuredClone(feed);

    // 1. The sources.
    const fresh = [];
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
        const error = String(e.message ?? e).split('\n')[0].slice(0, 300);
        if (checkStart - Date.parse(cur.lastCheck) > HOLD_MS) {
          next.sources[src.name] = { lastCheck: iso(checkStart), seen: {} };
          say({ kind: 'feed', what: src.name, outcome: 'failed', note: `a gap: nothing read from ${cur.lastCheck} to ${iso(checkStart)} (failing: ${error}); the morning run reconciles every open ticket` });
          out.sources.push({ name: src.name, outcome: 'gap', from, error });
        } else {
          next.sources[src.name] = { ...cur, failingSince: cur.failingSince ?? iso(checkStart), lastError: error };
          out.sources.push({ name: src.name, outcome: 'failed', from, error, note: 'the cursor stays; the next check reads the same window' });
        }
      }
    }
    out.events = fresh.length;

    // 2. Tickets and watched lists.
    const { keys, unmapped } = ticketsOf(fresh, readAllLedgers(settings.state));
    out.unmapped = unmapped.length;
    const wanted = [...new Set([...keys.keys(), ...(feed.pending ?? [])])];
    for (const job of settings.hostJobs) {
      if (!job.watch) continue;
      const events = fresh.filter((e) => e.board === job.watch.board);
      if (!events.length) continue;
      const inList = await listMatcher(job, { settings, clients });
      next.jobs[job.name] = updateWatchState(next.jobs[job.name], listChanges(events, inList));
    }

    // 3 and 4. The morning run, or the tickets that changed.
    const run = io.runDaily ?? runDaily;
    const runnerIo = io.runner ?? {};
    const morningDue = next.morning?.lastDate !== today && localMinutes(checkStart) >= minutesOf(settings.schedule.morning);
    if (morningDue) {
      out.morning = await run({ settings, clients, io: runnerIo, options: { dryRun, morning: true, trigger: 'schedule', claude } });
      next.morning = { lastDate: today, at: iso(clock()) };
      next.pending = [];
      out.handed = wanted;
    } else if (wanted.length) {
      const st = await computeStatus({ settings, clients, now: checkStart, only: wanted, git: io.git ?? makeGit(settings) });
      out.tickets = st.tickets.map((t) => ({ key: t.key, state: t.state, next: t.next ? t.next.stage : null, locked: Boolean(t.locked), hand: Boolean(t.hand), events: (keys.get(t.key) ?? []).length }));
      const runnable = st.tickets.filter((t) => t.next && !t.locked && !t.hand && (t.next.stage !== 'start' || t.next.byHand)).map((t) => t.key);
      // A ticket a run holds now is looked at again on the next check, so a change made during that run isn't lost.
      next.pending = st.tickets.filter((t) => t.locked).map((t) => t.key);
      out.pending = next.pending;
      out.handed = wanted;
      if (runnable.length) {
        say({ kind: 'watch', keys: runnable, outcome: 'handed', note: `${fresh.length} new event(s); the runner finishes ${runnable.join(', ')}` });
        out.run = await run({ settings, clients, io: runnerIo, options: { dryRun, trigger: 'watcher', named: runnable, claude } });
      }
    } else next.pending = [];

    // 6 (first half). Every event is handed on: the cursors move.
    if (!dryRun) writeFeed(settings.state, next);

    // 5. Host jobs.
    for (const job of settings.hostJobs) {
      const state = next.jobs[job.name] ?? {};
      const due = jobDue(job, state, checkStart);
      if (!due.due) {
        out.jobs.push({ name: job.name, due: false, ...(due.at ? { at: due.at } : {}), ...(due.why ? { why: due.why } : {}) });
        continue;
      }
      out.jobs.push(await runJob(job, state));
    }

    // 7. Notifications, once a day per reason.
    if (!dryRun) {
      for (const k of Object.keys(next.notified ?? {})) if (!k.includes(today)) delete next.notified[k];
      for (const n of notificationsOf({ morning: out.morning, run: out.run, jobs: out.jobs, today })) {
        if (next.notified?.[n.key]) continue;
        const r = (io.notify ?? notify)(n, io.notifyIo ?? {});
        (next.notified ??= {})[n.key] = iso(clock());
        out.notified.push({ title: n.title, text: n.text, urgent: n.urgent, ...r });
      }
      writeFeed(settings.state, next);
      appendRunLog(settings.state, today, log);
    }
    out.log = log;
    out.quiet = !fresh.length && !wanted.length && !out.morning && !out.jobs.some((j) => j.due !== false) && out.sources.every((s) => s.outcome !== 'failed' && s.outcome !== 'gap');
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
        const usage = await (io.readUsage ?? (() => readUsageFromClaude(claude)))();
        const a = allowanceOf(usage, settings.limits, new Date(clock()));
        const held = !a ? 'no usage reading: no scheduled start' : a.remaining <= 0 ? `the week is at ${a.used}%, the allowance by now is ${a.cap}%` : null;
        if (held) {
          next.jobs[job.name] = { ...state, heldUntil: iso(checkStart + 3600000) };
          say({ kind: 'guard', what: `job ${job.name}`, reason: held });
          return { name: job.name, due: true, held };
        }
      }
      const started = clock();
      const res = await (io.spawnJob ?? spawnJob)(cmd, { cwd: settings.root, env: io.env ?? process.env, timeoutMs: job.timeoutMinutes * 60000, extra: jobEnv(job, state) });
      const file = writeJobLog(settings.state, job.name, iso(started), res);
      const result = cmd.model ? parseResult(res.stdout) : null;
      const ok = res.code === 0 && !(result && result.isError);
      const failures = ok ? 0 : (state.failures ?? 0) + 1;
      const twice = failures >= 2;
      next.jobs[job.name] = ok || twice ? { ...done, ...(twice ? { lastFailure: iso(started) } : {}) } : { ...state, failures };
      const entry = { kind: 'job', job: job.name, outcome: ok ? 'done' : 'failed', exit: res.code, durationMs: clock() - started, log: path.relative(settings.root, file), ...(result?.costUsd !== undefined && result?.costUsd !== null ? { costUsd: result.costUsd } : {}), ...(twice ? { note: 'failed twice' } : !ok ? { note: 'failed; tried again on the next check' } : {}) };
      say(entry);
      return { name: job.name, due: true, outcome: entry.outcome, exit: res.code, log: entry.log, ...(entry.note ? { note: entry.note } : {}) };
    }
  } finally {
    lock.release();
  }
}
