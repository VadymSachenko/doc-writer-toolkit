import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD, LISTS, NOW, RELEASE, WATCH, card, quietGit } from './fakes.mjs';
import { ledger, snapshot, world } from './helpers.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { takeLock, releaseLock } from '../lib/locks.mjs';
import { WINDOW_MS, emptyFeed, readFeed, sourcesOf, ticketsOf, writeFeed, feedPath } from '../lib/feed.mjs';
import { runCheck, takeWatchLock } from '../lib/watch.mjs';
import { listChanges, updateWatchState, jobDue } from '../lib/jobs.mjs';
import { readRunLog } from '../lib/report.mjs';

// The watcher (design §5, D-048, D-054): one check reads every event since its cursor and makes no model call when it
// finds nothing (AC-1); after a sleep the first check reads every event since the last one and each changed ticket
// runs once (AC-4); a host job starts once its list has been quiet for its hours, a change restarting the wait (AC-5).
// Recorded responses: the in-memory tracker and forge adapters give back recorded actions, PRs and events from `since`.

process.env.TZ = 'UTC';

const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const HOUR = 3600000;
const usageAt = (week, session = 10) => parseUsage(`Current session: ${session}% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, session_id: 's' });

// Every source with its cursor at `lastCheck`, and today's morning run already done (unless `morning` says otherwise).
function seed(w, lastCheck, { morning = '2026-11-10', jobs = {} } = {}) {
  const f = emptyFeed();
  for (const s of sourcesOf(w.settings)) f.sources[s.name] = { lastCheck: iso(lastCheck), seen: {} };
  f.morning = { lastDate: morning };
  f.jobs = jobs;
  writeFeed(w.settings.state, f);
}

// An action in the tracker adapter's shape.
let n = 0;
function act(c, time, { type = 'commentCard', from = null, to = null, list = null } = {}) {
  return {
    id: `act-${++n}`,
    type,
    time: iso(time),
    card: { id: c.id, shortLink: c.shortLink, name: c.name },
    by: null,
    text: null,
    placeId: to?.id ?? list?.id ?? c.placeId,
    placeBefore: from,
    placeAfter: to,
    changed: from ? ['idList'] : [],
  };
}

// A check with stand-ins that fail on any model call, recording what the runner and the notifications were asked.
function checker(w, { runDaily, readUsage, spawnJob } = {}) {
  const calls = { runs: [], usage: 0, jobs: [], notes: [] };
  const check = (at, options = {}) =>
    runCheck({
      settings: w.settings,
      clients: w.clients(),
      io: {
        now: () => at,
        git: quietGit,
        runDaily: async (a) => {
          calls.runs.push(a.options);
          return runDaily ? runDaily(a) : { mode: w.settings.mode, named: a.options.named ?? [], ran: [], starts: [], guard: [] };
        },
        readUsage: () => {
          calls.usage++;
          return readUsage ? readUsage() : assert.fail('a model call needs no /usage here');
        },
        spawnJob: async (cmd, opts) => {
          calls.jobs.push({ cmd, opts });
          return spawnJob ? spawnJob(cmd, opts) : { code: 0, stdout: RESULT, stderr: '' };
        },
        notify: (msg) => (calls.notes.push(msg), { sent: true }),
      },
      options,
    });
  return { check, calls };
}

// A ticket the owner answered: its card moved from Blocked back to In progress; its next step is the answers.
function answered(w, number) {
  const c = card({ number, status: 'inProgress' });
  w.tracker.cards.push(c);
  ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  return c;
}

test('AC-1: a quiet check reads only the event sources and makes no status, runner, /usage or model call', async () => {
  const w = world();
  seed(w, NOW - 5 * MIN);
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.equal(out.quiet, true);
  assert.equal(out.events, 0);
  assert.deepEqual([calls.runs, calls.usage, calls.jobs, calls.notes], [[], 0, [], []]);
  // Only the feed reads: the boards' actions (and the board's list names, to name the lists in them), the changed PRs
  // and the PR events. No card, no list's cards, no PR state.
  assert.deepEqual([...new Set(w.tracker.reads.map((r) => r[0]))].sort(), ['actions', 'places']);
  assert.deepEqual([...new Set(w.forge.reads.map((r) => r[0]))].sort(), ['changedPrs', 'events']);
  const actionReads = w.tracker.reads.filter((r) => r[0] === 'actions');
  assert.deepEqual(actionReads.map((r) => r[1]).sort(), [BOARD, WATCH].sort());
  // The window starts 10 minutes before the last check; the cursor moves to this check's start.
  assert.ok(actionReads.every((r) => r[2] === iso(NOW - 5 * MIN - WINDOW_MS)));
  assert.ok(Object.values(readFeed(w.settings.state).sources).every((s) => s.lastCheck === iso(NOW)));
  assert.deepEqual([w.tracker.log, w.forge.log], [[], []]);
});

test('AC-1: events on tickets with no next step call status, and start no runner and no model', async () => {
  const waiting = card({ number: 301, status: 'blocked' });
  const intake = card({ number: 302, status: 'intake' });
  const w = world({ cards: [waiting, intake], actions: { [BOARD]: [act(waiting, NOW - 2 * MIN), act(intake, NOW - MIN)] } });
  ledger(w, waiting, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  seed(w, NOW - 5 * MIN);
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.equal(out.events, 2);
  assert.equal(out.unmapped, 1, 'the intake card has no ledger: the morning triage takes it');
  assert.deepEqual(out.tickets.map((t) => [t.key, t.state, t.next]), [['301', 'questions', null]]);
  assert.deepEqual([calls.runs, calls.usage], [[], 0]);
});

test('AC-1: the first check of a new source starts from now and reads nothing', async () => {
  const w = world();
  writeFeed(w.settings.state, { ...emptyFeed(), morning: { lastDate: '2026-11-10' } });
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.ok(out.sources.every((s) => s.outcome === 'started'));
  assert.deepEqual([w.tracker.reads, w.forge.reads, calls.runs], [[], [], []]);
  assert.ok(Object.values(readFeed(w.settings.state).sources).every((s) => s.lastCheck === iso(NOW)));
});

test('AC-4: after a sleep the first check reads every event since the last one, and each changed ticket runs once', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 401);
  const b = answered(w, 402);
  const quiet = card({ number: 403, status: 'blocked' });
  w.tracker.cards.push(quiet);
  ledger(w, quiet, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  const slept = NOW - 9 * HOUR;
  seed(w, slept);
  actions[BOARD].push(
    act(a, slept - 25 * MIN), // before the window: never read
    act(a, NOW - 8 * HOUR, { type: 'updateCard', from: { id: LISTS.blocked.id, name: 'Blocked' }, to: { id: LISTS.inProgress.id, name: 'Doing' } }),
    act(a, NOW - 8 * HOUR + MIN),
    act(a, NOW - 3 * MIN),
    act(b, NOW - 2 * HOUR),
    act(quiet, NOW - HOUR),
  );
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.ok(w.tracker.reads.filter((r) => r[0] === 'actions' && r[1] === BOARD).every((r) => r[2] === iso(slept - WINDOW_MS)), 'the window starts 10 minutes before the last check');
  assert.equal(out.events, 5, 'every event since the last check, none from before the window');
  assert.equal(calls.runs.length, 1, 'one hand-off to the runner');
  assert.deepEqual(calls.runs[0].trigger, 'watcher');
  assert.deepEqual([...calls.runs[0].named].sort(), ['401', '402'], 'each changed ticket with a next step, once');
  assert.deepEqual(Object.fromEntries(out.tickets.map((t) => [t.key, t.events])), { 401: 3, 402: 1, 403: 1 });
  const feed = readFeed(w.settings.state);
  assert.equal(feed.sources[`board:${BOARD}`].lastCheck, iso(NOW));
  assert.ok(`${actions[BOARD][3].id}` in feed.sources[`board:${BOARD}`].seen, 'an event inside the next window is kept as seen');
  assert.ok(!(`${actions[BOARD][1].id}` in feed.sources[`board:${BOARD}`].seen), 'older ids are dropped');

  // Five minutes on: the overlap brings back an event already handed on; it is dropped, and nothing runs.
  const again = await check(NOW + 5 * MIN);
  assert.equal(again.events, 0);
  assert.equal(again.quiet, true);
  assert.equal(calls.runs.length, 1);

  // A new event on one ticket: that ticket only, once.
  actions[BOARD].push(act(a, NOW + 7 * MIN));
  await check(NOW + 10 * MIN);
  assert.deepEqual(calls.runs.map((r) => r.named), [calls.runs[0].named, ['401']]);
});

test('AC-4: a source that fails keeps its cursor; the others move; after 24 hours the gap is reported', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, fail: { 'api-docs': 'the forge answered 502' } });
  const a = answered(w, 501);
  seed(w, NOW - 5 * MIN);
  actions[BOARD].push(act(a, NOW - MIN));
  const { check, calls } = checker(w);
  const out = await check(NOW);
  const feed = readFeed(w.settings.state);
  assert.deepEqual(out.sources.filter((s) => s.outcome === 'failed').map((s) => s.name).sort(), ['events:api-docs', 'prs:api-docs']);
  assert.equal(feed.sources['prs:api-docs'].lastCheck, iso(NOW - 5 * MIN), 'the failed source keeps its cursor');
  assert.equal(feed.sources['prs:api-docs'].failingSince, iso(NOW));
  assert.equal(feed.sources[`board:${BOARD}`].lastCheck, iso(NOW), 'the others move on');
  assert.deepEqual(calls.runs.map((r) => r.named), [['501']], 'the events that were read are handed on');
  assert.ok(!out.quiet);

  // Still failing a day later: the gap is reported and the source starts again from now.
  const later = NOW + 25 * HOUR;
  const out2 = await check(later);
  assert.deepEqual(out2.sources.filter((s) => s.outcome === 'gap').map((s) => s.name).sort(), ['events:api-docs', 'prs:api-docs']);
  assert.equal(readFeed(w.settings.state).sources['prs:api-docs'].lastCheck, iso(later));
  const gaps = readRunLog(w.settings.state, '2026-11-11').filter((e) => e.kind === 'feed');
  assert.equal(gaps.length, 2);
  assert.match(gaps[0].note, /a gap: nothing read from .* the morning run reconciles/);
  assert.ok(!JSON.stringify(gaps).includes('TEST_TOKEN'));
});

test('AC-4: a ticket a run holds now is looked at again on the next check, and runs once it is free', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 601);
  seed(w, NOW - 5 * MIN);
  actions[BOARD].push(act(a, NOW - MIN));
  takeLock(w.settings.state, { group: '601', kind: 'manual', leaseMinutes: 60, now: NOW });
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.deepEqual(out.pending, ['601']);
  assert.deepEqual(calls.runs, []);
  releaseLock(w.settings.state, '601');
  await check(NOW + 5 * MIN);
  assert.deepEqual(calls.runs.map((r) => r.named), [['601']]);
  const after = await check(NOW + 10 * MIN);
  assert.equal(after.quiet, true, 'handed on once, then forgotten');
});

test('AC-4: one check at a time; a hand-off that fails leaves the cursors where they were', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 701);
  seed(w, NOW - 5 * MIN);
  actions[BOARD].push(act(a, NOW - MIN));
  const held = takeWatchLock(w.settings.state, { now: NOW });
  const { check, calls } = checker(w, { runDaily: () => assert.fail('not while the lock is held') });
  const before = fs.readFileSync(feedPath(w.settings.state), 'utf8');
  const out = await check(NOW);
  assert.match(out.skipped, /holds the watcher lock/);
  assert.equal(fs.readFileSync(feedPath(w.settings.state), 'utf8'), before);
  held.release();

  const failing = checker(w, {
    runDaily: () => {
      throw new Error('the runner crashed');
    },
  });
  await assert.rejects(failing.check(NOW), /the runner crashed/);
  assert.equal(fs.readFileSync(feedPath(w.settings.state), 'utf8'), before, 'nothing handed on: the same window is read again');
  const ok = checker(w);
  await ok.check(NOW + MIN);
  assert.deepEqual(ok.calls.runs.map((r) => r.named), [['701']]);
  assert.equal(calls.runs.length, 0);
  // A lock left by a process that is gone is taken over.
  fs.mkdirSync(path.join(w.settings.state, 'watch', 'active'), { recursive: true });
  fs.writeFileSync(path.join(w.settings.state, 'watch', 'active', 'owner.json'), JSON.stringify({ pid: 999999, startedAt: iso(NOW) }));
  assert.equal(takeWatchLock(w.settings.state, { now: NOW, isAlive: () => false }).taken, true);
});

test('the morning run: once a day at the first check after schedule.morning, with its notification; never twice', async () => {
  const w = world();
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const morning = { mode: 'on', ran: [{ stage: 'plan', group: '1', keys: ['1'], outcome: 'done' }], starts: [{ group: '2' }], guard: [], after: { wip: { inProgress: 1, waiting: 2 }, allowance: { used: 12, cap: 40 } } };
  const { check, calls } = checker(w, { runDaily: () => morning });
  await check(NOW);
  assert.deepEqual(calls.runs.map((r) => [r.morning, r.trigger]), [[true, 'schedule']]);
  assert.equal(readFeed(w.settings.state).morning.lastDate, '2026-11-10');
  assert.deepEqual(calls.notes.map((x) => [x.urgent, x.text]), [[false, '1 step(s) done, 0 failed, 1 started; 1 in progress, 2 waiting; week 12% of 40% allowed. /ticket-report']]);
  await check(NOW + 5 * MIN);
  assert.equal(calls.runs.length, 1);
  assert.equal(calls.notes.length, 1);

  // Before schedule.morning nothing starts.
  const early = world({ extra: { schedule: { morning: '10:00' } } });
  seed(early, NOW - 5 * MIN, { morning: '2026-11-09' });
  const e = checker(early);
  await e.check(NOW);
  assert.deepEqual(e.calls.runs, []);
});

test('notifications: urgent only for a limit reached or a step that failed twice, once a day per reason', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 801);
  seed(w, NOW - 5 * MIN);
  const run = { mode: 'on', named: ['801'], ran: [{ stage: 'answers', group: '801', keys: ['801'], outcome: 'failed', note: 'failed twice' }], starts: [], guard: [{ kind: 'guard', reason: 'the week is at 45%, the allowance by now is 40%' }] };
  const { check, calls } = checker(w, { runDaily: () => run });
  actions[BOARD].push(act(a, NOW - MIN));
  await check(NOW);
  assert.deepEqual(calls.notes.map((x) => [x.urgent, x.title]), [[true, 'Ticket flow: limit reached'], [true, 'Ticket flow: a step failed twice']]);
  actions[BOARD].push(act(a, NOW + 2 * MIN));
  await check(NOW + 5 * MIN);
  assert.equal(calls.notes.length, 2, 'not again the same day');
});

test('mode off: nothing is read and the cursors stay', async () => {
  const w = world({ extra: { mode: 'off' } });
  seed(w, NOW - 5 * MIN);
  const before = snapshot(w.settings.state);
  const { check } = checker(w);
  const out = await check(NOW);
  assert.equal(out.stopped, 'mode off: nothing runs');
  assert.deepEqual([w.tracker.reads, w.forge.reads], [[], []]);
  assert.deepEqual(snapshot(w.settings.state), before);
});

test('the dry run reads and plans, and writes no cursor, no job and no notification', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 901);
  seed(w, NOW - 5 * MIN);
  actions[BOARD].push(act(a, NOW - MIN));
  const before = snapshot(w.settings.state);
  const { check, calls } = checker(w);
  const out = await check(NOW, { dryRun: true });
  assert.deepEqual(calls.runs.map((r) => [r.dryRun, r.named]), [[true, ['901']]]);
  assert.deepEqual(snapshot(w.settings.state), before);
  assert.deepEqual(calls.notes, []);
  assert.equal(out.dryRun, true);
});

test('the event map: a card by id or short link, the original card, a PR by number or head branch; closed tickets out', () => {
  const ledgers = [
    { key: '1', card: { id: 'c1', shortLink: 'S1' }, original: { shortLink: 'O1' }, prs: [{ repo: 'api-docs', number: 41, branch: 'ticket-41' }], stages: {} },
    { key: '2', card: { id: 'c2', shortLink: 'S2' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2' }], stages: {} },
    { key: '3', card: { id: 'c3', shortLink: 'S3' }, prs: [], stages: { close: { status: 'done' } } },
  ];
  const events = [
    { id: 'a', card: { id: 'c1' } },
    { id: 'b', card: { id: 'x', shortLink: 'O1' } },
    { id: 'c', repo: 'api-docs', number: 41 },
    { id: 'd', repo: 'guide-docs', number: 7, head: 'ticket-2' },
    { id: 'e', card: { id: 'c3' } },
    { id: 'f', repo: 'api-docs', number: 99 },
  ];
  const { keys, unmapped } = ticketsOf(events, ledgers);
  assert.deepEqual(Object.fromEntries([...keys].map(([k, v]) => [k, v.map((e) => e.id)])), { 1: ['a', 'b', 'c'], 2: ['d'] });
  assert.deepEqual(unmapped.map((e) => e.id), ['e', 'f']);
});

// ------------------------------------------------------------------ host jobs (AC-5)

const shipping = { id: RELEASE.id, name: RELEASE.name };
const testing = { id: '5f00000000000000000a0102', name: 'Testing' };

function releaseWorld(extra = {}) {
  const actions = { [WATCH]: [] };
  const w = world({ actions, extra });
  const t0 = Date.parse('2026-11-10T01:00:00Z');
  seed(w, t0 - 5 * MIN);
  const arrive = (time, how = 'move') => {
    const c = card({ number: null, name: `Release item ${n}`, list: RELEASE, board: WATCH });
    actions[WATCH].push(how === 'create' ? act(c, time, { type: 'createCard', list: shipping }) : act(c, time, { type: 'updateCard', from: testing, to: shipping }));
    return c;
  };
  return { w, t0, actions, arrive };
}

test('AC-5: a host job starts once its list has been quiet for its hours; each change in the list restarts the wait', async () => {
  const { w, t0, actions, arrive } = releaseWorld();
  const { check, calls } = checker(w, { readUsage: () => usageAt(5) });
  // Three waves, 65 and 110 minutes apart, then one card taken out again.
  arrive(t0, 'create');
  await check(t0 + 10 * MIN);
  let job = readFeed(w.settings.state).jobs.notes;
  assert.deepEqual([job.armed, job.firstChange, job.lastChange], [true, iso(t0), iso(t0)]);
  arrive(t0 + 65 * MIN);
  await check(t0 + 70 * MIN);
  const third = arrive(t0 + 175 * MIN);
  await check(t0 + 180 * MIN);
  actions[WATCH].push(act(third, t0 + 200 * MIN, { type: 'updateCard', from: shipping, to: testing }));
  await check(t0 + 205 * MIN);
  job = readFeed(w.settings.state).jobs.notes;
  assert.deepEqual([job.firstChange, job.lastChange], [iso(t0), iso(t0 + 200 * MIN)], 'the card taken out restarted the wait too');
  // Three hours less a minute after the last change: still waiting. Three hours: it runs, once.
  const quietEnd = t0 + 200 * MIN + 3 * HOUR;
  const waiting = await check(quietEnd - MIN);
  assert.deepEqual(waiting.jobs.map((j) => [j.name, j.due, j.at]), [['notes', false, iso(quietEnd)]]);
  assert.equal(calls.jobs.length, 0);
  await check(quietEnd);
  assert.equal(calls.jobs.length, 1);
  const { cmd, opts } = calls.jobs[0];
  assert.equal(cmd.bin, 'claude');
  assert.match(cmd.args[1], /^\/notes-writer\n\nStarted unattended by the ticket flow's watcher/);
  assert.deepEqual(opts.extra, { DOC_TOOLKIT_JOB: 'notes', DOC_TOOLKIT_JOB_LIST: 'Shipping', DOC_TOOLKIT_JOB_FIRST_CHANGE: iso(t0), DOC_TOOLKIT_JOB_LAST_CHANGE: iso(t0 + 200 * MIN) });
  assert.equal(opts.cwd, w.root);
  assert.equal(calls.usage, 1, 'a skill job is a model call: the guard read /usage first');
  await check(quietEnd + 5 * MIN);
  assert.equal(calls.jobs.length, 1, 'once per batch');
  assert.equal(readFeed(w.settings.state).jobs.notes.armed, false);
  const log = readRunLog(w.settings.state, '2026-11-10').filter((e) => e.kind === 'job');
  assert.deepEqual(log.map((e) => [e.job, e.outcome]), [['notes', 'done']]);
});

test('AC-5: a change inside the wait, seen only after a sleep, still restarts it by its own time', async () => {
  const { w, t0, arrive } = releaseWorld();
  const { check, calls } = checker(w, { readUsage: () => usageAt(5) });
  arrive(t0);
  arrive(t0 + 2 * HOUR);
  // Asleep until t0 + 4 h: one check sees both; the wait counts from the second card, so it is not over yet.
  const out = await check(t0 + 4 * HOUR);
  assert.deepEqual(out.jobs.map((j) => [j.due, j.at]), [[false, iso(t0 + 5 * HOUR)]]);
  assert.equal(calls.jobs.length, 0);
  await check(t0 + 5 * HOUR);
  assert.equal(calls.jobs.length, 1);
});

test('AC-5 and AC-2: a skill job waits at the limit; observe plans it; a script job runs every N minutes; a job that fails twice is urgent', async () => {
  // The guard: at the allowance, the skill job is held for an hour and the owner is told once.
  const held = releaseWorld();
  const h = checker(held.w, { readUsage: () => usageAt(45) });
  held.arrive(held.t0);
  await h.check(held.t0 + 5 * MIN);
  const out = await h.check(held.t0 + 3 * HOUR + 5 * MIN);
  assert.deepEqual(out.jobs.map((j) => [j.name, j.held]), [['notes', 'the week is at 45%, the allowance by now is 30%']]);
  assert.equal(h.calls.jobs.length, 0);
  assert.deepEqual(h.calls.notes.map((x) => [x.urgent, x.title]), [[true, 'Ticket flow: limit reached']]);
  assert.match(readFeed(held.w.settings.state).jobs.notes.heldUntil, /^2026-11-10T05:05/);

  // observe: planned, not run.
  const obs = releaseWorld({ mode: 'observe' });
  const o = checker(obs.w);
  obs.arrive(obs.t0);
  await o.check(obs.t0 + 5 * MIN);
  const planned = await o.check(obs.t0 + 3 * HOUR + 5 * MIN);
  assert.equal(planned.jobs[0].planned, true);
  assert.equal(o.calls.jobs.length, 0);

  // A script job every 5 minutes; no /usage read for it.
  const every = releaseWorld({ hostJobs: [{ name: 'copy', every: 5, run: { script: 'scripts/copy.mjs', args: ['--quiet'] } }] });
  let fails = 0;
  const s = checker(every.w, { spawnJob: () => (fails++ < 9 ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' }) });
  await s.check(every.t0);
  assert.deepEqual([s.calls.jobs[0].cmd.bin, s.calls.jobs[0].cmd.args], [process.execPath, [path.join(every.w.root, 'scripts/copy.mjs'), '--quiet']]);
  assert.equal(s.calls.usage, 0);
  // It failed: tried again on the next check; failed twice: urgent, and it waits its interval.
  await s.check(every.t0 + MIN);
  assert.equal(s.calls.jobs.length, 2);
  assert.deepEqual(s.calls.notes.map((x) => x.title), ['Ticket flow: a host job failed twice']);
  await s.check(every.t0 + 3 * MIN);
  assert.equal(s.calls.jobs.length, 2);
  await s.check(every.t0 + 6 * MIN);
  assert.equal(s.calls.jobs.length, 3);
});

test('AC-5: the job rules on their own: arrivals arm, any change restarts, due after the quiet hours', () => {
  const inList = (ref) => ref?.id === 'L';
  const ev = (time, before, after, type = 'updateCard') => ({ time, type, list: after ?? before, listBefore: before, listAfter: after });
  const c = listChanges([ev('2026-11-10T01:00:00Z', { id: 'X' }, { id: 'L' }), ev('2026-11-10T01:30:00Z', null, null, 'commentCard')], inList);
  assert.deepEqual(c, { arrivals: ['2026-11-10T01:00:00Z'], changes: ['2026-11-10T01:00:00Z'] });
  assert.deepEqual(updateWatchState({}, { arrivals: [], changes: ['2026-11-10T01:00:00Z'] }), {}, 'a change with no new card arms nothing');
  const s = updateWatchState({}, c);
  const job = { name: 'j', watch: { board: 'b', list: 'L' }, quietHours: 3, run: { script: 'x.mjs' } };
  assert.equal(jobDue(job, s, Date.parse('2026-11-10T03:59:00Z')).due, false);
  assert.equal(jobDue(job, s, Date.parse('2026-11-10T04:00:00Z')).due, true);
});

test('settings: a host job needs one trigger and one run, and a script inside the host repo', () => {
  const bad = [
    [{ name: 'x', run: { script: 'a.mjs' } }, /either watch .* or every/],
    [{ name: 'x', every: 5, run: { script: 'a.mjs', skill: 'b' } }, /either script or skill/],
    [{ name: 'x', every: 5, run: { script: '../elsewhere/a.mjs' } }, /inside the host repo/],
    [{ name: 'x', watch: { board: 'b', list: 'L' }, run: { skill: 'b' } }, /quietHours/],
    [{ name: 'x y', every: 5, run: { skill: 'b' } }, /name/],
  ];
  for (const [job, re] of bad) assert.throws(() => world({ extra: { hostJobs: [job] } }), re);
});
