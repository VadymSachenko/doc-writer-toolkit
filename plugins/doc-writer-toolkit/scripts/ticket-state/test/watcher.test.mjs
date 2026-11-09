import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD, LISTS, NOW, RELEASE, WATCH, card, noTree, pr, quietGit, rawSettings } from './fakes.mjs';
import { runRecord } from '../lib/record.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { takeLock, releaseLock } from '../lib/locks.mjs';
import { WINDOW_MS, emptyFeed, readFeed, sourcesOf, ticketsOf, writeFeed, feedPath } from '../lib/feed.mjs';
import { runCheck, takeWatchLock } from '../lib/watch.mjs';
import { jobCommand, listChanges, updateWatchState, jobDue } from '../lib/jobs.mjs';
import { readRunLog, renderReport } from '../lib/report.mjs';
import { PUSH_DENIED, runDaily } from '../lib/runner.mjs';
import { notificationsOf } from '../lib/notify.mjs';
import { setLocal } from '../lib/setlocal.mjs';

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

test('a start whose session moved the card and failed waits; a person acting hands it on as the start it was, a hand move as a hand start', async () => {
  const actions = { [BOARD]: [] };
  const comments = {};
  const moved = card({ number: 311, status: 'inProgress' });
  const byHand = card({ number: 312, status: 'inProgress' });
  const w = world({ cards: [moved, byHand], actions, comments });
  const at = iso(NOW - 30 * MIN);
  // 311: the runner recorded the scheduled start; its session moved the card, then failed (its mark has the card in work).
  ledger(w, moved, { stages: { triage: 'done', start: { status: 'failed', note: 'the session ended without recording the stage' } }, left: 'ready', startedBy: 'schedule', runs: [{ seq: 9, stage: 'start', role: 'writer', outcome: 'failed', failures: 1, start: at, after: { at, list: moved.placeId, comments: [], prs: {} } }] });
  // 312: only triaged; a person moved its card into work.
  ledger(w, byHand, { stages: { triage: 'done' }, left: 'ready' });
  seed(w, NOW - 5 * MIN);
  const { check, calls } = checker(w);
  actions[BOARD].push(act(moved, NOW - 2 * MIN), act(byHand, NOW - 2 * MIN, { type: 'updateCard', from: LISTS.ready, to: LISTS.inProgress }));
  let out = await check(NOW);
  assert.deepEqual(out.tickets.map((t) => [t.key, t.next, Boolean(t.waits)]), [['311', 'start', true], ['312', 'start', false]]);
  assert.deepEqual(calls.runs.map((r) => r.named), [['312']], 'the failed start waits; the hand start runs');
  // A person comments on 311's card: one more try, handed on as the scheduled start it was.
  (comments[moved.id] ??= []).push({ id: 'person-1', author: 'owner-login', time: iso(NOW + MIN), text: 'the attachment is back', edited: null });
  actions[BOARD].push({ ...act(moved, NOW + MIN), id: 'person-1' });
  out = await check(NOW + 5 * MIN);
  assert.deepEqual(calls.runs.map((r) => r.named), [['312'], ['311']], 'only the ticket with a new event is looked at');
  const st = await w.status();
  assert.deepEqual(st.tickets.map((t) => [t.key, t.next.startedBy, Boolean(t.next.again), Boolean(t.next.byHand)]), [['311', 'schedule', true, false], ['312', 'manual', false, true]]);
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

test('AC-4: one check at a time; a hand-off that fails keeps its tickets pending and the rest of the check goes on', async () => {
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
  const crashed = await failing.check(NOW);
  assert.deepEqual(crashed.errors, [{ part: 'the run', error: 'the runner crashed' }]);
  assert.deepEqual(readFeed(w.settings.state).pending, ['701'], 'not handed on: the ticket is looked at again on the next check');
  assert.equal(readFeed(w.settings.state).sources[`board:${BOARD}`].lastCheck, iso(NOW), 'the cursors move: the ticket is pending');
  assert.deepEqual(failing.calls.notes.map((x) => [x.urgent, x.title, x.text]), [[true, 'Ticket flow: a part of a check failed', 'the run: the runner crashed']]);
  assert.deepEqual(readRunLog(w.settings.state, '2026-11-10').filter((e) => e.outcome === 'failed').map((e) => [e.what, e.note]), [['the run', 'the runner crashed']]);
  await failing.check(NOW + MIN);
  assert.equal(failing.calls.notes.length, 1, 'once a day per reason');
  const ok = checker(w);
  await ok.check(NOW + 2 * MIN);
  assert.deepEqual(ok.calls.runs.map((r) => r.named), [['701']]);
  assert.deepEqual(readFeed(w.settings.state).pending, []);
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

// ------------------------------------------------------------------ a step that fails every time (the real runner)

const FAILED = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 200, total_cost_usd: 3, session_id: 's' });

// One owner move, then a step whose session fails every time after writing on its card: a comment through the tracker
// and its action on the board, as a real session would leave them. The real runner, real status, real ledger; only
// `claude` is a stand-in. Checks every 5 minutes from `from` to `to`.
function failingTicket(extra = {}) {
  const actions = { [BOARD]: [] };
  const comments = {};
  const w = world({ actions, comments, extra });
  const c = answered(w, 401);
  seed(w, NOW - 5 * MIN);
  const ref = { id: c.id, shortLink: c.shortLink, name: c.name };
  let clock = NOW;
  let k = 0;
  const sessions = [];
  const notes = [];
  actions[BOARD].push({ ...act(c, NOW - MIN, { type: 'updateCard', from: { id: LISTS.blocked.id, name: 'Blocked' }, to: { id: LISTS.inProgress.id, name: 'Doing' } }) });
  const runner = {
    now: () => clock,
    readUsage: () => usageAt(5),
    spawnClaude: async (cmd) => {
      sessions.push({ at: iso(clock), model: cmd.args[cmd.args.indexOf('--model') + 1] });
      const posted = await w.tracker.comment(c.id, `a question, session ${sessions.length}`);
      actions[BOARD].push({ ...act(c, clock + MIN), id: `session-${posted.id}` });
      return { code: 1, stdout: FAILED, stderr: '' };
    },
  };
  const checkAt = (at) => {
    clock = at;
    return runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => clock, git: quietGit, runner, notify: (m) => (notes.push(m), { sent: true }) }, options: {} });
  };
  const day = async (from, to) => {
    for (let at = from; at < to; at += 5 * MIN) await checkAt(at);
  };
  // A person writes on the card: the comment in the tracker and its action on the board.
  const personComments = (at) => {
    const id = `person-${++k}`;
    (comments[c.id] ??= []).push({ id, author: 'owner-login', time: iso(at), text: 'here is the answer', edited: null });
    actions[BOARD].push({ ...act(c, at), id });
  };
  const failedTwice = () => notes.filter((m) => m.title === 'Ticket flow: a step failed twice');
  return { w, c, sessions, notes, day, personComments, failedTwice };
}

test('a step that fails every time: at most two sessions a day and one notification; a person acting gives one more try', async () => {
  const t = failingTicket();
  // The day after the owner's move, the next morning run included (07:00).
  await t.day(NOW, NOW + 24 * HOUR);
  assert.deepEqual(t.sessions.map((x) => x.at), [iso(NOW), '2026-11-11T07:00:00.000Z'], 'one at the move, one at the next morning run');
  assert.ok(t.sessions.every((x) => x.model === 'claude-opus-5-5'));
  assert.equal(t.failedTwice().length, 1);
  const l = read(t.w, '401');
  assert.deepEqual(l.runs.map((r) => [r.outcome, r.failures]), [['failed', 1], ['failed', 2]]);
  const st = await t.w.one('401');
  assert.deepEqual([st.next, st.held, st.gate.who], [null, true, 'owner']);
  const report = fs.readFileSync(path.join(t.w.settings.state, 'reports', '2026-11-11.md'), 'utf8');
  const failures = report.split('## Failures and guard stops')[1].split('##')[0];
  assert.equal(failures.match(/401 answers/g)?.length, 1, 'one line in the failures for the two sessions');
  assert.match(report, /## Waiting for you\n\n- \[401\][^\n]*answers failed in 2 sessions/);

  // A person's comment after the hold: one more session, then it waits again; nothing more that day.
  t.personComments(NOW + 24 * HOUR + 2 * MIN);
  await t.day(NOW + 24 * HOUR + 5 * MIN, NOW + 46 * HOUR);
  assert.equal(t.sessions.length, 3);
  assert.equal(t.sessions[2].at, iso(NOW + 24 * HOUR + 5 * MIN));
  assert.equal(t.failedTwice().length, 1, 'once a day per reason');
});

test('a step that fails at a lower model: the retry is the second session and holds the ticket at once; a guard-held retry is not "failed twice"', async () => {
  const t = failingTicket({ roles: { writer: { model: 'claude-sonnet-5-5' } } });
  await t.day(NOW, NOW + 24 * HOUR);
  assert.deepEqual(t.sessions.map((x) => [x.at, x.model]), [[iso(NOW), 'claude-sonnet-5-5'], [iso(NOW), 'claude-opus-5-5']]);
  assert.equal(t.failedTwice().length, 1);
  assert.equal((await t.w.one('401')).held, true, 'the morning run does not try it again');

  // The owner raises the turns with `set`: that alone re-arms nothing. `set retry 401` does: the next check looks at the
  // held ticket, with no event, and tries it once.
  fs.mkdirSync(path.dirname(t.w.settings.file), { recursive: true });
  fs.writeFileSync(t.w.settings.file, JSON.stringify(rawSettings({ roles: { writer: { model: 'claude-sonnet-5-5' } } })));
  setLocal({ settings: t.w.settings, key: 'roles.writer.maxTurns', value: '300', now: NOW + 24 * HOUR });
  await t.day(NOW + 24 * HOUR, NOW + 24 * HOUR + 5 * MIN);
  assert.equal(t.sessions.length, 2);
  setLocal({ settings: t.w.settings, key: 'retry', value: '401', now: NOW + 24 * HOUR + MIN });
  await t.day(NOW + 24 * HOUR + 5 * MIN, NOW + 25 * HOUR);
  assert.deepEqual(t.sessions.slice(2).map((x) => [x.at, x.model]), [[iso(NOW + 24 * HOUR + 5 * MIN), 'claude-sonnet-5-5'], [iso(NOW + 24 * HOUR + 5 * MIN), 'claude-opus-5-5']], 'one more try, with its retry up the ladder');
  assert.equal((await t.w.one('401')).held, true);

  // The guard holds the retry: one failed session, with its own note and no urgent notification.
  const g = failingTicket({ roles: { writer: { model: 'claude-sonnet-5-5' } } });
  let reads = 0;
  const out = await runDaily({ settings: g.w.settings, clients: g.w.clients(), io: { now: () => NOW, readUsage: () => usageAt(reads++ ? 45 : 5), spawnClaude: async () => ({ code: 1, stdout: FAILED, stderr: '' }) }, options: { trigger: 'watcher', named: ['401'] } });
  const step = out.ran.find((x) => x.stage === 'answers');
  assert.deepEqual([step.outcome, step.note], ['failed', 'failed; the guard held the retry']);
  assert.deepEqual(notificationsOf({ run: out, today: '2026-11-10' }).filter((n) => /failed twice/.test(n.title)), []);
});

test('the morning run waits for a check that can read the board: a Mac awake before its network runs it once, at 09:05', async () => {
  const w = world({ actions: { [BOARD]: [] } });
  // Asleep overnight: the last check was last evening, the morning run last ran yesterday.
  const f = emptyFeed();
  for (const src of sourcesOf(w.settings)) f.sources[src.name] = { lastCheck: iso(NOW - 12 * HOUR), seen: {} };
  f.morning = { lastDate: '2026-11-09' };
  writeFeed(w.settings.state, f);
  let down = true;
  const places = w.tracker.places;
  w.tracker.places = async (b) => {
    if (down) throw new Error('fetch failed: getaddrinfo ENOTFOUND tracker.example');
    return places(b);
  };
  const mornings = [];
  const check = (at) =>
    runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => at, git: quietGit, runner: { now: () => at, readUsage: () => usageAt(5) }, runDaily: async (a) => (mornings.push([iso(at), a.options.morning]), runDaily(a)), notify: () => ({ sent: true }) }, options: {} });
  const first = await check(NOW);
  assert.deepEqual(mornings, [], 'not at 09:00: the board could not be read');
  assert.match(first.notes.join(' '), /the morning run waits: the board can't be read in this check \(fetch failed: getaddrinfo ENOTFOUND/);
  assert.equal(readFeed(w.settings.state).morning.lastDate, '2026-11-09');
  down = false;
  for (const at of [NOW + 5 * MIN, NOW + 10 * MIN, NOW + 3 * HOUR]) await check(at);
  assert.deepEqual(mornings, [[iso(NOW + 5 * MIN), true]], 'once, at 09:05, and not again that day');
  assert.equal(readFeed(w.settings.state).morning.lastDate, '2026-11-10');
});

// A world whose boards can't be read while `down(at)` holds (the tracker answers 401, as for a token that is gone),
// checked at the given times with the real runner; the morning runs and the urgent notifications are kept.
function deadBoard({ lastCheck, down }) {
  const w = world({ actions: { [BOARD]: [] } });
  seed(w, lastCheck, { morning: localDay(lastCheck) });
  let clock = lastCheck;
  const places = w.tracker.places;
  w.tracker.places = async (b) => {
    if (down(clock)) throw new Error('GET /1/boards/x/lists: HTTP 401 invalid token');
    return places(b);
  };
  const mornings = [];
  const urgent = [];
  const check = (at) => {
    clock = at;
    return runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => at, git: quietGit, runner: { now: () => at, readUsage: () => usageAt(5) }, runDaily: async (a) => (mornings.push(iso(at)), runDaily(a)), notify: (m) => (m.urgent && urgent.push([iso(at), m.text]), { sent: true }) }, options: {} });
  };
  const checks = async (from, to, step) => {
    for (let at = from; at < to; at += step) await check(at);
  };
  return { w, mornings, urgent, checks };
}
const localDay = (ms) => iso(ms).slice(0, 10);

test('a board that can never be read (a token gone): urgent once a day after schedule.morning, naming the error and what to check, and at each 24-hour gap', async () => {
  const t = deadBoard({ lastCheck: NOW - 5 * MIN, down: () => true });
  await t.checks(NOW, NOW + 50 * HOUR, 30 * MIN);
  assert.deepEqual(t.mornings, [], 'the morning run waits for a board that reads');
  const unreadable = (h) => `the tracker: unreadable for ${h} h (GET /1/boards/x/lists: HTTP 401 invalid token). Check its token and key (tracker.credentials) and the network.`;
  const gap = "the tracker's events: a 24-hour gap, nothing read (GET /1/boards/x/lists: HTTP 401 invalid token). Check its token and key (tracker.credentials) and the network.";
  // An hour after the first failure; then each day at the first check after 07:00, not at midnight; and at each gap
  // (24 hours after the board was last read). Both boards fail on the one token: one notification, not one a board.
  assert.deepEqual(t.urgent, [
    ['2026-11-10T10:00:00.000Z', unreadable(1)],
    ['2026-11-11T07:00:00.000Z', unreadable(22)],
    ['2026-11-11T09:00:00.000Z', gap],
    ['2026-11-12T07:00:00.000Z', unreadable(46)],
    ['2026-11-12T09:30:00.000Z', gap],
  ]);
  for (const day of ['2026-11-10', '2026-11-11', '2026-11-12']) {
    const log = readRunLog(t.w.settings.state, day);
    assert.equal(log.filter((e) => e.kind === 'watch' && e.what === 'the tracker').length, 1, `${day}: one line in the run log for the report`);
    assert.ok(!JSON.stringify(log).includes('TEST_TOKEN') && !JSON.stringify(log).includes('TEST_KEY'));
  }
  assert.equal(readFeed(t.w.settings.state).sources[`board:${BOARD}`].failingSince, iso(NOW), 'still failing since the first failure, across the gaps');
});

test('PRs that can never be read (the forge sign-in gone): one urgent notification for every repo and source, after an hour', async () => {
  const bad = 'HTTP 401 Bad credentials';
  const w = world({ fail: { 'guide-docs': bad, 'api-docs': bad, 'portal-docs': bad } });
  seed(w, NOW - 5 * MIN);
  const { check, calls } = checker(w);
  for (let at = NOW; at <= NOW + 70 * MIN; at += 5 * MIN) await check(at);
  assert.deepEqual(calls.notes.map((m) => [m.urgent, m.text]), [[true, `the forge: unreadable for 1 h (${bad}). Check its sign-in and the network.`]]);
  assert.equal(calls.runs.length, 0);
});

test('a board that fails for under an hour after a wake: no urgent notification, and one morning run once it reads', async () => {
  const outage = (from) => (at) => at >= from && at < from + 55 * MIN;
  // Asleep overnight; the board fails from 09:00 to 09:50 and reads at 09:55.
  const plain = deadBoard({ lastCheck: NOW - 12 * HOUR, down: outage(NOW) });
  await plain.checks(NOW, NOW + 2 * HOUR, 5 * MIN);
  // The same, but it was failing for 50 minutes when the Mac went to sleep: the sleep is not failing time.
  const evening = NOW - 13 * HOUR;
  const before = deadBoard({ lastCheck: evening - 5 * MIN, down: (at) => outage(evening)(at) || outage(NOW)(at) });
  await before.checks(evening, evening + 55 * MIN, 5 * MIN);
  await before.checks(NOW, NOW + 2 * HOUR, 5 * MIN);
  // Asleep over a weekend: the first check after the wake is already a 24-hour gap; it is logged, not notified.
  const weekend = deadBoard({ lastCheck: NOW - 60 * HOUR, down: outage(NOW) });
  await weekend.checks(NOW, NOW + 2 * HOUR, 5 * MIN);
  assert.ok(readRunLog(weekend.w.settings.state, '2026-11-10').some((e) => e.kind === 'feed' && /a gap/.test(e.note)));
  for (const t of [plain, before, weekend]) {
    assert.deepEqual(t.urgent, []);
    assert.deepEqual(t.mornings, [iso(NOW + 55 * MIN)], 'once, at 09:55');
  }
});

test('a morning run that throws before its first step runs again at the next check; one that throws part way counts as the day', async () => {
  for (const [begun, expected] of [[false, 2], [true, 1]]) {
    const w = world();
    seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
    let calls = 0;
    const { check, calls: seen } = checker(w, {
      runDaily: (a) => {
        if (calls++) return { mode: 'on', ran: [], starts: [], guard: [] };
        if (begun) a.options.progress.begun = true;
        throw new Error('getaddrinfo ENOTFOUND tracker.example');
      },
    });
    const out = await check(NOW);
    assert.deepEqual(out.errors.map((e) => e.part), ['the morning run']);
    await check(NOW + 5 * MIN);
    await check(NOW + 10 * MIN);
    assert.equal(seen.runs.filter((r) => r.morning).length, expected, begun ? 'part way: once a day' : 'before any step: again at the next check');
    assert.equal(readFeed(w.settings.state).morning.lastDate, '2026-11-10');
  }
});

test('a ledger file that does not read: reported; nothing is handed on (status reads every ledger), and the tickets wait in pending until it reads', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 401);
  seed(w, NOW - 5 * MIN);
  actions[BOARD].push(act(a, NOW - MIN));
  const bad = path.join(w.settings.state, 'tickets', '402.json');
  fs.writeFileSync(bad, '{ "schemaVersion": 1, "key": "40');
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.ok(out.errors.some((e) => e.part === 'the ledger 402' && /cannot parse/.test(e.error)));
  assert.ok(out.errors.some((e) => e.part === 'status' && /cannot parse/.test(e.error)), 'status fails on it too');
  const feed = readFeed(w.settings.state);
  assert.ok(feed.pending.includes('402') && feed.pending.includes('401'), 'kept for the next check (status reads every ledger, so it waits too)');
  assert.equal(feed.sources[`board:${BOARD}`].lastCheck, iso(NOW));
  assert.deepEqual(calls.runs, []);
  // The file is repaired: the next check hands the ticket on.
  fs.rmSync(bad);
  await check(NOW + 5 * MIN);
  assert.deepEqual(calls.runs.map((r) => r.named), [['401']]);
});

test('a loop of any cause: a stage that "succeeds" but makes a fresh event each time runs at most limits.sessionsPerStageDay sessions a day', async () => {
  const activity = { 'guide-docs#81': { comments: [{ id: 8100, author: 'expert-one', body: 'a question', createdAt: iso(NOW - 10 * MIN), updatedAt: iso(NOW - 10 * MIN) }] } };
  // The PR changed (a comment) a minute before the first check; each reply changes it again.
  const p81 = { ...pr({ repo: 'guide-docs', number: 81, labels: ['in expert review'] }), updatedAt: iso(NOW - MIN) };
  const c = card({ number: 481, status: 'smeReview' });
  // Bounded so a missing cap fails fast: two steps a run, twelve checks (an hour); the cap is 3 a day.
  const w = world({ cards: [c], activity, changed: { 'guide-docs': [p81] }, prs: [p81], extra: { limits: { stepsPerTicket: 2 } } });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 81, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  seed(w, NOW - 5 * MIN);
  let clock = NOW;
  const sessions = [];
  const notes = [];
  const spawnClaude = async () => {
    sessions.push(iso(clock));
    // It handles the newest comment and records the stage, but its own reply isn't in `posted`: a new comment.
    const list = activity['guide-docs#81'].comments;
    await runRecord({ settings: w.settings, clients: w.clients(), key: '481', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', result: { questions: [], handled: list.map((x) => ({ id: x.id, updatedAt: x.updatedAt })) }, now: clock });
    const id = 8100 + list.length;
    list.push({ id, author: 'owner-login', body: 'a reply', createdAt: iso(clock), updatedAt: iso(clock + 1000) });
    p81.updatedAt = iso(clock + MIN);
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  for (let at = NOW; at < NOW + HOUR; at += 5 * MIN) {
    clock = at;
    await runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => clock, git: quietGit, runner: { now: () => clock, readUsage: () => usageAt(5), spawnClaude, ensureWorktree: noTree }, notify: (m) => (notes.push(m), { sent: true }) }, options: {} });
  }
  assert.equal(sessions.length, 3);
  const t = await w.one('481');
  assert.deepEqual([t.next, t.held, t.capped.sessions], [null, true, 3]);
  assert.match(t.gate.why, /answerComments on guide-docs#81 ran 3 sessions today \(limits.sessionsPerStageDay\): held until tomorrow/);
  assert.deepEqual(notes.filter((m) => m.urgent).map((m) => m.title), ['Ticket flow: a step hit its daily cap']);
  assert.equal(readRunLog(w.settings.state, '2026-11-10').filter((e) => e.outcome === 'failed' && e.key === '481').length, 1, 'one line in the report');
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

test('AC-5 and AC-2: a skill job waits at the limit; observe plans it; a script job runs every N minutes; a job that fails for an hour is urgent', async () => {
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
  // It failed: tried again at each check, quietly. Failing at each try for an hour (01:00 to 02:06): urgent, and
  // disarmed until the next morning run.
  await s.check(every.t0 + MIN);
  assert.equal(s.calls.jobs.length, 2);
  assert.deepEqual(s.calls.notes, [], 'a failure shorter than an hour is quiet');
  for (let at = every.t0 + 6 * MIN; at < Date.parse('2026-11-10T07:00:00Z'); at += 30 * MIN) await s.check(at);
  assert.equal(s.calls.jobs.length, 5, 'at 01:00, 01:01, 01:06, 01:36 and 02:06; not after, before the next morning run');
  // Disarmed at 02:06, at night: the alert is held until the first check after schedule.morning, as a source's is.
  assert.deepEqual(s.calls.notes, [], 'no sound at night');
  assert.deepEqual(readRunLog(every.w.settings.state, '2026-11-10').filter((e) => e.kind === 'job' && /disarmed/.test(e.note ?? '')).map((e) => e.at), ['2026-11-10T02:06:00.000Z']);
  assert.equal(readFeed(every.w.settings.state).jobs.copy.heldUntil, '2026-11-10T07:00:00.000Z');
  const morning = await s.check(Date.parse('2026-11-10T07:00:00Z'));
  assert.equal(s.calls.jobs.length, 6);
  assert.deepEqual(morning.jobs.map((j) => [j.name, j.outcome]), [['copy', 'failed']]);
  assert.deepEqual(s.calls.notes.filter((x) => x.urgent).map((x) => [x.title, x.text]), [['Ticket flow: a host job kept failing at night', 'copy failed at each try from 01:00 (5 tries, last exit 1) and was disarmed at 02:06; disarmed until the morning run (07:00). See /ticket-report.']]);
});

// An `every 5` script job that reads the board itself (a card copy): it exits 1 while `fails(at)`, and the board's
// own reads fail while `down(at)` (the network). Checks every 5 minutes; the job's tries are kept with their exit.
function everyJob({ from, down = () => false, fails = down }) {
  const w = world({ actions: { [BOARD]: [] }, extra: { hostJobs: [{ name: 'copy', every: 5, run: { script: 'scripts/copy.mjs' } }] } });
  seed(w, from - 5 * MIN);
  let clock = from;
  const places = w.tracker.places;
  w.tracker.places = async (b) => {
    if (down(clock)) throw new Error('fetch failed: getaddrinfo ENOTFOUND tracker.example');
    return places(b);
  };
  const runs = [];
  const { check, calls } = checker(w, { spawnJob: () => (runs.push([iso(clock), fails(clock) ? 1 : 0]), fails(clock) ? { code: 1, stdout: '', stderr: 'fetch failed' } : { code: 0, stdout: '', stderr: '' }) });
  const checks = async (start, end) => {
    for (clock = start; clock < end; clock += 5 * MIN) await check(clock);
  };
  return { w, runs, checks, urgent: () => calls.notes.filter((m) => m.urgent), state: () => readFeed(w.settings.state).jobs.copy };
}

test('a host job through a 10-minute network drop: tried again at each check, quietly; it runs at the first check after, and is never disarmed', async () => {
  const noon = Date.parse('2026-11-10T12:00:00Z');
  const t = everyJob({ from: noon - HOUR, down: (at) => at >= noon && at < noon + 10 * MIN });
  await t.checks(noon - HOUR, noon + 2 * HOUR);
  assert.deepEqual(t.urgent(), []);
  assert.deepEqual(t.runs.filter(([at]) => at >= '2026-11-10T11:55' && at <= '2026-11-10T12:15:00.000Z').map(([at, code]) => [at.slice(11, 16), code]), [['11:55', 0], ['12:00', 1], ['12:05', 1], ['12:10', 0], ['12:15', 0]]);
  assert.equal(t.runs.length, 36, 'at every check: never disarmed');
  assert.deepEqual([t.state().heldUntil, t.state().failingSince, t.state().failures, t.state().lastFailure], [null, null, 0, undefined]);
});

test('a host job that fails at each try for an hour of awake time: one urgent notification, then disarmed until the next morning run', async () => {
  const noon = Date.parse('2026-11-10T12:00:00Z');
  const t = everyJob({ from: noon, fails: (at) => at >= noon });
  // The report, as the day's run writes it: the job failing, then disarmed; each failed try names the job.
  const report = async () => renderReport({ settings: t.w.settings, st: await t.w.status(), date: '2026-11-10', runLog: readRunLog(t.w.settings.state, '2026-11-10') });
  await t.checks(noon, noon + 35 * MIN);
  assert.deepEqual(t.urgent(), []);
  assert.match(await report(), /\n- copy: not run yet, failing since 2026-11-10T12:00:00\.000Z \(7 tries\)\n/);
  await t.checks(noon + 35 * MIN, noon + 6 * HOUR);
  assert.deepEqual(t.urgent().map((m) => [m.title, m.text]), [['Ticket flow: a host job keeps failing', 'copy failed at each try for an hour (13 tries, last exit 1); disarmed until 2026-11-11T07:00:00.000Z. See /ticket-report.']]);
  assert.deepEqual([t.runs.length, t.runs.at(-1)[0]], [13, '2026-11-10T13:00:00.000Z'], 'tried at each check from 12:00 to 13:00, then not again that day');
  assert.equal(t.state().heldUntil, '2026-11-11T07:00:00.000Z');
  const text = await report();
  assert.match(text, /\n- copy: last run 2026-11-10T13:00:00\.000Z, disarmed after an hour of failing at 2026-11-10T13:00:00\.000Z, held until 2026-11-11T07:00:00\.000Z\n/);
  const failures = text.split('## Failures and guard stops')[1].split('##')[0];
  assert.match(failures, /- 2026-11-10T12:00:00\.000Z job copy: failed; tried again at the next check\n/);
  assert.match(failures, /- 2026-11-10T13:00:00\.000Z job copy: failed at each try for an hour \(13 tries\); disarmed until 2026-11-11T07:00:00\.000Z/);
});

test('a watch job that fails at two checks runs again at the next one, not only at its next new card', async () => {
  const { w, t0, arrive } = releaseWorld({ hostJobs: [{ name: 'notes', watch: { board: WATCH, list: 'Shipping' }, quietHours: 3, run: { script: 'scripts/notes.mjs' } }] });
  let tries = 0;
  const { check, calls } = checker(w, { spawnJob: () => (tries++ < 2 ? { code: 1, stdout: '', stderr: 'HTTP 502' } : { code: 0, stdout: '', stderr: '' }) });
  arrive(t0);
  await check(t0 + 5 * MIN);
  for (const m of [0, 5, 10, 15]) await check(t0 + 3 * HOUR + m * MIN);
  assert.equal(calls.jobs.length, 3, 'failed at 04:00 and 04:05, done at 04:10, then not again');
  assert.deepEqual(calls.notes, []);
  const s = readFeed(w.settings.state).jobs.notes;
  assert.deepEqual([s.armed, s.failingSince, s.failures, s.lastRun], [false, null, 0, '2026-11-10T04:10:00.000Z']);
});

test('a watch job that fails at each try for an hour is disarmed until its next new card, with one urgent notification', async () => {
  const { w, t0, arrive } = releaseWorld({ hostJobs: [{ name: 'notes', watch: { board: WATCH, list: 'Shipping' }, quietHours: 3, run: { script: 'scripts/notes.mjs' } }] });
  const { check, calls } = checker(w, { spawnJob: () => ({ code: 1, stdout: '', stderr: 'HTTP 502' }) });
  arrive(t0);
  await check(t0 + 5 * MIN);
  for (let at = t0 + 3 * HOUR; at <= t0 + 5 * HOUR; at += 5 * MIN) await check(at);
  assert.equal(calls.jobs.length, 13, 'at each check from 04:00 to 05:00, then not again');
  assert.deepEqual(calls.notes, [], 'disarmed at 05:00, before schedule.morning: the alert waits');
  const s = readFeed(w.settings.state).jobs.notes;
  assert.deepEqual([s.armed, s.heldUntil, s.failingSince, s.lastFailure], [false, null, null, '2026-11-10T05:00:00.000Z']);
  // A new card arms it again.
  arrive(t0 + 5 * HOUR + 10 * MIN);
  await check(t0 + 5 * HOUR + 15 * MIN);
  assert.equal(readFeed(w.settings.state).jobs.notes.armed, true);
  // The first check after schedule.morning tells the owner, once.
  await check(Date.parse('2026-11-10T07:00:00Z'));
  await check(Date.parse('2026-11-10T07:05:00Z'));
  assert.deepEqual(calls.notes.filter((m) => m.urgent).map((m) => m.text), ['notes failed at each try from 04:00 (13 tries, last exit 1) and was disarmed at 05:00; disarmed until its next new card. See /ticket-report.']);
});

test('a sleep is not failing time for a host job: failing as the Mac went to sleep and at the first check after the wake, then it runs', async () => {
  const evening = Date.parse('2026-11-10T17:30:00Z');
  const wake = Date.parse('2026-11-11T08:00:00Z');
  const t = everyJob({ from: evening - 3 * HOUR, down: (at) => (at >= evening && at < evening + HOUR) || (at >= wake && at < wake + 5 * MIN) });
  // Awake until 17:55, failing from 17:30; asleep until 08:00, with no network at the first check.
  await t.checks(evening - 3 * HOUR, evening + 30 * MIN);
  await t.checks(wake, wake + HOUR);
  assert.deepEqual(t.urgent(), []);
  assert.deepEqual(t.runs.filter(([, code]) => code).map(([at]) => at.slice(5, 16)), ['11-10T17:30', '11-10T17:35', '11-10T17:40', '11-10T17:45', '11-10T17:50', '11-10T17:55', '11-11T08:00']);
  assert.deepEqual(t.runs.find(([at]) => at === '2026-11-11T08:05:00.000Z'), ['2026-11-11T08:05:00.000Z', 0], 'it runs at 08:05');
  assert.deepEqual([t.state().heldUntil, t.state().failingSince, t.state().lastFailure], [null, null, undefined]);
});

test('a watched list that is gone: its board fails for this check with the reason; the morning run, the hand-off and the other cursors go on', async () => {
  const actions = { [BOARD]: [], [WATCH]: [] };
  const w = world({ actions, extra: { hostJobs: [{ name: 'notes', watch: { board: WATCH, list: 'Renamed list' }, quietHours: 3, run: { script: 'x.mjs' } }] } });
  const a = answered(w, 401);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  actions[BOARD].push(act(a, NOW - MIN, { type: 'updateCard', from: { id: LISTS.blocked.id, name: 'Blocked' }, to: { id: LISTS.inProgress.id, name: 'Doing' } }));
  const other = card({ number: null, name: 'Release item', list: RELEASE, board: WATCH });
  actions[WATCH].push(act(other, NOW - 2 * MIN, { type: 'createCard', list: shipping }));
  const { check, calls } = checker(w);
  const out = await check(NOW);
  assert.deepEqual(out.errors, [{ part: 'job notes', error: `no list 'Renamed list' on board ${WATCH}` }]);
  assert.deepEqual(calls.runs.map((r) => [r.morning, r.trigger]), [[true, 'schedule']], 'the morning run is due, and runs');
  const feed = readFeed(w.settings.state);
  assert.equal(feed.sources[`board:${BOARD}`].lastCheck, iso(NOW), 'the other cursors move');
  assert.equal(feed.sources[`board:${WATCH}`].lastCheck, iso(NOW - 5 * MIN), 'the failed board keeps its cursor, under the 24-hour hold');
  assert.match(feed.sources[`board:${WATCH}`].lastError, /job notes: no list 'Renamed list'/);
  assert.deepEqual(out.jobs, [{ name: 'notes', due: false, why: `its board can't be read in this check: job notes: no list 'Renamed list' on board ${WATCH}` }]);
  assert.deepEqual(calls.notes.filter((x) => x.urgent).map((x) => x.text), [`job notes: no list 'Renamed list' on board ${WATCH}`]);

  // The next check: the same reason is not notified again, and the ticket's own events go on being handed.
  actions[BOARD].push(act(a, NOW + 3 * MIN));
  const again = await check(NOW + 5 * MIN);
  assert.deepEqual(again.errors.map((e) => e.part), ['job notes']);
  assert.deepEqual(calls.runs.at(-1).named, ['401']);
  assert.equal(calls.notes.filter((x) => x.urgent).length, 1);
});

test('a watch job neither runs nor re-arms while its board can not be read; after the board is back it runs once', async () => {
  const actions = { [WATCH]: [] };
  const w = world({ actions });
  const t0 = Date.parse('2026-11-10T01:00:00Z');
  seed(w, t0 - 5 * MIN);
  const { check, calls } = checker(w, { readUsage: () => usageAt(5) });
  const arrive = (time) => actions[WATCH].push(act(card({ number: null, name: 'Release item', list: RELEASE, board: WATCH }), time, { type: 'createCard', list: shipping }));
  arrive(t0);
  await check(t0 + 5 * MIN);
  // The board fails from 01:30; a card arrives at 03:00 during the outage. 04:05 is 3 hours after the last change the
  // job saw, but not after the one it couldn't see.
  actions.fail = { [WATCH]: 'HTTP 503' };
  arrive(t0 + 2 * HOUR);
  for (const at of [t0 + HOUR + 5 * MIN, t0 + 2 * HOUR + 5 * MIN, t0 + 3 * HOUR + 5 * MIN, t0 + 3 * HOUR + 11 * MIN]) {
    const out = await check(at);
    assert.deepEqual(out.jobs, [{ name: 'notes', due: false, why: "its board can't be read in this check: HTTP 503" }]);
  }
  assert.equal(calls.jobs.length, 0, 'no run at 04:05');
  assert.deepEqual(readFeed(w.settings.state).jobs.notes, { firstChange: iso(t0), armed: true, lastChange: iso(t0) }, 'its state is untouched');
  delete actions.fail;
  const back = await check(t0 + 3 * HOUR + 17 * MIN);
  assert.deepEqual(back.jobs.map((j) => [j.due, j.at]), [[false, '2026-11-10T06:00:00.000Z']], 'the 03:00 card restarts the wait');
  const ran = await check(t0 + 6 * HOUR + 17 * MIN);
  assert.deepEqual(ran.jobs.map((j) => [j.due, j.outcome]), [[true, 'done']]);
  assert.deepEqual(calls.jobs.map((j) => j.opts.extra.DOC_TOOLKIT_JOB_LAST_CHANGE), ['2026-11-10T03:00:00.000Z'], 'once, at 07:17, for the batch with the 03:00 card');
  await check(t0 + 6 * HOUR + 22 * MIN);
  assert.equal(calls.jobs.length, 1, 'not armed again');
});

test('a skill job carries every push denial the roles carry, whatever its own allow list', () => {
  const w = world({ extra: { hostJobs: [{ name: 'notes', every: 60, run: { skill: 'notes-writer', allowedTools: ['Bash(git push:*)', 'Bash(git status:*)'] } }, { name: 'plain', every: 60, run: { skill: 'notes-writer' } }] } });
  for (const job of w.settings.hostJobs) {
    const { args } = jobCommand(job, { settings: w.settings });
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    for (const rule of PUSH_DENIED) assert.ok(denied.includes(rule), `${job.name} denies ${rule}`);
  }
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

// ------------------------------------------------------------------ host jobs after an outage

const jobAlerts = (t) => t.urgent().filter((m) => /host job/.test(m.title));

test('E3: a 65-minute drop at noon on an awake Mac: one job alert, and the copy runs again at the first check after the board reads', async () => {
  const noon = Date.parse('2026-11-10T12:00:00Z');
  const t = everyJob({ from: Date.parse('2026-11-10T08:00:00Z'), down: (at) => at >= noon && at < noon + 65 * MIN });
  await t.checks(Date.parse('2026-11-10T08:00:00Z'), noon + HOUR + 5 * MIN);
  // Disarmed at 13:00, with the boards failing too: one urgent job alert, now (it is day).
  assert.deepEqual(jobAlerts(t).map((m) => m.text), ['copy failed at each try for an hour (13 tries, last exit 1); disarmed until the 2 reads that failed with it read again, 2026-11-11T07:00:00.000Z at the latest. See /ticket-report.']);
  assert.deepEqual(t.state().disarmed.downWith, [`board:${BOARD}`, `board:${WATCH}`]);
  await t.checks(noon + HOUR + 5 * MIN, Date.parse('2026-11-10T18:00:00Z'));
  // 13:05: the boards read again, so the job re-arms and runs in the same check, then every 5 minutes.
  assert.deepEqual(t.runs.find(([at]) => at >= '2026-11-10T13:05'), ['2026-11-10T13:05:00.000Z', 0]);
  assert.equal(t.runs.filter(([at, code]) => at >= '2026-11-10T13:05' && code === 0).length, 59, 'every check from 13:05 to 17:55');
  assert.deepEqual([t.state().heldUntil, t.state().disarmed, t.state().rearmed.why], [null, null, `board:${BOARD}, board:${WATCH} read again`]);
  assert.equal(jobAlerts(t).length, 1, 'one job alert; the tracker unreadable for an hour is its own part, told once too');
  assert.match(renderReport({ settings: t.w.settings, st: await t.w.status(), date: '2026-11-10', runLog: [], watched: [], proposal: null, ledgers: [] }), /copy: last run .*disarmed after an hour of failing at 2026-11-10T13:00:00.000Z, re-armed at 2026-11-10T13:05:00.000Z/);
});

test('E4: the network down 01:00-02:30 on a Mac awake overnight: the job alert is held, dropped when the copy re-arms at 02:30, and nothing sounds in the morning', async () => {
  const t = everyJob({ from: Date.parse('2026-11-10T20:00:00Z'), down: (at) => at >= Date.parse('2026-11-11T01:00:00Z') && at < Date.parse('2026-11-11T02:30:00Z') });
  await t.checks(Date.parse('2026-11-10T20:00:00Z'), Date.parse('2026-11-11T02:30:00Z'));
  assert.deepEqual(jobAlerts(t), [], 'nothing sounds at night');
  assert.ok(t.state().alert, 'disarmed at 02:00: the alert is held for the morning');
  await t.checks(Date.parse('2026-11-11T02:30:00Z'), Date.parse('2026-11-11T07:00:00Z'));
  assert.deepEqual(t.runs.find(([at]) => at >= '2026-11-11T02:30'), ['2026-11-11T02:30:00.000Z', 0], 'the first check after the boards read');
  assert.equal(t.runs.filter(([at, code]) => at >= '2026-11-11T02:30' && at < '2026-11-11T07:00' && code === 0).length, 54);
  assert.equal(t.state().alert, null, 're-armed at 02:30: the held alert is dropped');
  await t.checks(Date.parse('2026-11-11T07:00:00Z'), Date.parse('2026-11-11T09:00:00Z'));
  assert.deepEqual(jobAlerts(t), [], 'the job runs again: no alert in the morning');
  assert.match(t.state().rearmed.why, /read again/);
});

test('E6 and set retry job: a job that fails on its own (the network fine) stays disarmed until the morning; set retry job re-arms it', async () => {
  let broken = true;
  const t = everyJob({ from: Date.parse('2026-11-10T08:00:00Z'), fails: () => broken });
  await t.checks(Date.parse('2026-11-10T08:00:00Z'), Date.parse('2026-11-10T10:00:00Z'));
  assert.equal(jobAlerts(t).length, 1);
  assert.deepEqual([t.state().heldUntil, t.state().disarmed.downWith], ['2026-11-11T07:00:00.000Z', []], 'no read failed with it: nothing re-arms it by itself');
  const tries = t.runs.length;
  await t.checks(Date.parse('2026-11-10T10:00:00Z'), Date.parse('2026-11-10T11:00:00Z'));
  assert.equal(t.runs.length, tries, 'held: not tried');
  // The owner fixed the cause and re-arms it.
  broken = false;
  assert.throws(() => setLocal({ settings: t.w.settings, key: 'retry', value: 'job', name: 'nope', now: Date.parse('2026-11-10T11:01:00Z') }), /'nope' is not a host job/);
  assert.throws(() => setLocal({ settings: t.w.settings, key: 'retry', value: 'job', now: Date.parse('2026-11-10T11:01:00Z') }), /needs the job name/);
  const r = setLocal({ settings: t.w.settings, key: 'retry', value: 'job', name: 'copy', now: Date.parse('2026-11-10T11:01:00Z') });
  assert.deepEqual([r.job, r.changed], ['copy', true]);
  await t.checks(Date.parse('2026-11-10T11:05:00Z'), Date.parse('2026-11-10T11:15:00Z'));
  assert.deepEqual(t.runs.slice(tries), [['2026-11-10T11:05:00.000Z', 0], ['2026-11-10T11:10:00.000Z', 0]]);
  assert.deepEqual([t.state().heldUntil, t.state().rearmed.why], [null, '`ticket-state set retry job`']);
  // The same re-arm doesn't apply twice: a later disarm needs a later retry.
  broken = true;
  await t.checks(Date.parse('2026-11-10T11:15:00Z'), Date.parse('2026-11-10T12:30:00Z'));
  assert.ok(t.state().disarmed, 'disarmed again after another hour');
});
