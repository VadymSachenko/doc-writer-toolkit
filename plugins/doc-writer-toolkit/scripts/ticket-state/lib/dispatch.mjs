import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFeed, watchDir, writeFeed } from './feed.mjs';
import { readLedger } from './ledger.mjs';
import { allLocks } from './locks.mjs';
import { scriptEnv } from './env.mjs';
import { WATCHER } from './launchd.mjs';
import { dropHandOnStep, forgeHandOns, handOnLive, runsGoing, writeHandOnStep } from './forge-state.mjs';

// The hand-on (TASK-092): a check never waits for a session. The full check's run, its morning run and its start pass
// decide in the runner as any run does, and each group they would advance goes to a run in a process of its own
// (`watcher.mjs --hand-on <id>`), one group per process, so a ticket's chain never waits for another's. The forge
// check's hand-on (lib/forge-watch.mjs) starts the same kind of process. Who may be handed on:
//   - not a group a run holds: its group's live lock, or a live run of either check that carries one of its tickets
//     (the window before that run takes its lock);
//   - not past `limits.parallel` runs going across processes (`runsGoing`: the live group locks and both checks' live
//     runs; 1 at the session bar): the group waits, and the next check that finds a slot hands it on;
//   - the record of the run (`handOns` in `feed.json`: { id, pid, keys, group, stage, at, by, why, retried }) is written
//     at once, so the forge check, which may run at the same time, holds its tickets too; the step and the check's /usage
//     reading go to `hand-on/<id>.step.json` before the process starts. `retried`: the run carries a failed step's (or a
//     failed start's) one more try; if it comes back not having used it, the check that collects it owes it again
//     that day (lib/watch.mjs `owed`).
// Two checks that read each other's record before either wrote it can still hand one ticket on twice: the run takes
// its group's lock before its first step and reads the step again under it (lib/runner.mjs `advance`), so it runs once.

const iso = (ms) => new Date(ms).toISOString();
const errorText = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

// A process of its own, detached from the tick (its own session, so launchd's end of the tick doesn't end it; the
// plist says `AbandonProcessGroup` too), its output appended to the LaunchAgent's log. No pipe: the tick exits first.
export function spawnDetached(args, { settings, env = process.env, node = process.execPath }) {
  const log = path.join(watchDir(settings.state), 'launchd.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(node, args, { cwd: settings.root, env: scriptEnv(env), detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return { pid: child.pid, args };
  } finally {
    fs.closeSync(fd);
  }
}

const common = (settings, claude) => ['--root', settings.root, ...(settings.file ? ['--settings', settings.file] : []), '--claude', claude, '--quiet'];

// The arguments of a hand-on's process and of a full check's: the watcher in a mode of its own. It prepares its own
// environment (no API key; the sign-in token for its `claude` only), as the tick does.
export const handOnArgs = (settings, { id, keys, claude = 'claude' }) => [WATCHER, '--hand-on', id, ...keys.flatMap((k) => ['--ticket', k]), ...common(settings, claude)];
export const fullArgs = (settings, { claude = 'claude', dryRun = false }) => [WATCHER, '--full', ...common(settings, claude), ...(dryRun ? ['--dry-run'] : [])];
// The learning pass (lib/learn.mjs, TASK-054): its sessions never run inside a check.
export const learnArgs = (settings, { claude = 'claude' }) => [WATCHER, '--learn', ...common(settings, claude)];

export const handOnId = (ms) => `${iso(ms).replace(/[-:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

// The `dispatch` option of the runner (lib/runner.mjs) for one full check. `records`: the full check's live runs (its
// `feed.handOns`, which this adds to); `by`: `watcher`, `morning` or `startPass`; `why`: the start pass's reason.
// Returns { group, keys, stage } with `id` and `pid` once handed on, or `waits`, `held` or `error`.
// `drain`: why no new run starts now (the hub waiting for the runs to end, lib/hub-update.mjs `hubDrain`), or null.
export function makeDispatcher({ settings, io = {}, records, by, why = null, claude = 'claude', drain = () => null }) {
  const clock = io.now ?? Date.now;
  const live = io.isAlive ? { isAlive: io.isAlive } : {};
  const groupOf = (k) => {
    try {
      return readLedger(settings.state, k)?.group ?? k;
    } catch {
      return k;
    }
  };
  return async function dispatch(step, { usage = null, retryWaiting = false } = {}) {
    const at = clock();
    const group = step.group ?? step.keys[0];
    const base = { group, keys: step.keys, stage: step.stage };
    const locks = allLocks(settings.state, at);
    const going = [...forgeHandOns(settings.state), ...records].filter((h) => handOnLive(h, { now: at, ...live }));
    if (locks.some((l) => l.live && l.group === group)) return { ...base, held: `its group's lock (${group})` };
    const draining = drain();
    if (draining) return { ...base, waits: draining };
    const holder = going.find((h) => h.keys.some((k) => step.keys.includes(k)));
    if (holder) return { ...base, held: `run ${holder.id}, handed on at ${holder.at}` };
    const busy = runsGoing({ locks, handOns: going, now: at, ...live, groupOf }).size;
    const limit = (usage?.session?.percent ?? 0) >= (settings.limits.sessionPercent ?? 80) ? 1 : settings.limits.parallel;
    if (typeof limit === 'number' && busy >= limit) return { ...base, waits: `${busy} run(s) going, limits.parallel ${limit}` };
    const id = handOnId(at);
    writeHandOnStep(settings.state, id, { id, by, ...(why ? { why } : {}), at: iso(at), step: { stage: step.stage, group, keys: step.keys, pr: step.pr ?? null }, retryWaiting, usage, usageAt: usage ? iso(at) : null });
    let child;
    try {
      const args = handOnArgs(settings, { id, keys: step.keys, claude });
      child = await (io.spawn ? io.spawn(args, { settings, kind: 'hand-on' }) : spawnDetached(args, { settings, env: io.env ?? process.env }));
    } catch (e) {
      dropHandOnStep(settings.state, id);
      return { ...base, error: errorText(e) };
    }
    const retried = retryWaiting && Boolean(step.waits || (step.stage === 'start' && step.prior));
    records.push({ id, pid: child.pid, keys: step.keys, group, stage: step.stage, at: iso(at), by, ...(why ? { why } : {}), ...(retried ? { retried: true } : {}) });
    // At once, not at the end of the check: the forge check reads it to hold these tickets.
    writeFeed(settings.state, { ...readFeed(settings.state), handOns: records });
    return { ...base, id, pid: child.pid };
  };
}
