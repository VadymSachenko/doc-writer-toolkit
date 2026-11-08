import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, card, pr, quietGit } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { makeClients } from '../lib/world.mjs';
import { emptyFeed, readFeed, sourcesOf, writeFeed } from '../lib/feed.mjs';
import { takeLock, releaseLock } from '../lib/locks.mjs';
import { writeLedger } from '../lib/ledger.mjs';
import { runCheck, watchLockHolder } from '../lib/watch.mjs';
import { checkKindOf, handOnArgs, runForgeCheck, runHandOn, runTick, spawnDetached } from '../lib/forge-watch.mjs';
import { emptyForge, readForge, writeForge, handOnFile } from '../lib/forge-state.mjs';
import { startRule } from '../lib/quiet.mjs';
import { WATCHER } from '../lib/launchd.mjs';
import { main as watcherMain, oneLine } from '../watcher.mjs';
import { fixture, replayer } from '../../forge/test/fake-gh.mjs';

// The forge check (D-126): the owner's comments on a pipeline PR are picked up within a minute. Each tick runs the
// forge check, which reads the changed PRs only and hands a ticket on to a run in a process of its own; the full check
// is started as a process of its own every watchMinutes. A submitted review starts its session at once, single comments
// once quiet (AC-1, AC-2). The forge check reads no tracker and runs no morning run, start pass or job (AC-3); a long
// session of one ticket never holds up another ticket's comments. In-memory forge and tracker, a fake clock, stand-ins
// for the detached processes (`io.spawn`) and for which pids live (`io.isAlive`).

process.env.TZ = 'UTC';

const iso = (ms) => new Date(ms).toISOString();
const SEC = 1000;
const MIN = 60000;
const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const idOf = (n) => `guide-docs#${n}`;

// The feed after a full check at `fullAt`, today's morning run done, and the forge check's cursors at `at`.
function seed(w, at, { fullAt = at, morning = '2026-11-10', jobs = {} } = {}) {
  const f = emptyFeed();
  for (const s of sourcesOf(w.settings)) f.sources[s.name] = { lastCheck: iso(at), seen: {} };
  f.morning = { lastDate: morning };
  f.fullAt = iso(fullAt);
  f.checkedAt = iso(fullAt);
  f.jobs = jobs;
  writeFeed(w.settings.state, f);
  const g = emptyForge();
  for (const s of sourcesOf(w.settings).filter((x) => x.kind === 'prs')) g.sources[s.name] = { lastCheck: iso(at), seen: {} };
  writeForge(w.settings.state, g);
}

// Tickets in the expert review, one open PR each (ticket 4NN on guide-docs#NN). `say(n, at)` adds a single comment
// to the PR as the forge would show it, `review(n, at)` a submitted review; each moves the PR's update time.
function commented({ numbers = [81], extra = {}, fail } = {}) {
  const activity = {};
  const prs = numbers.map((n) => ({ ...pr({ repo: 'guide-docs', number: n, labels: ['in expert review'] }), updatedAt: iso(NOW - 30 * MIN) }));
  const cards = numbers.map((n) => card({ number: 400 + n, status: 'smeReview' }));
  for (const n of numbers) activity[idOf(n)] = { comments: [], threads: [], reviews: [] };
  const w = world({ cards, activity, changed: { 'guide-docs': prs }, prs, extra, ...(fail ? { fail } : {}) });
  numbers.forEach((n, i) => ledger(w, cards[i], { stages: BASE, prs: [{ repo: 'guide-docs', number: n, targets: ['guide'], review: 'sme', stage: 'smeReview' }] }));
  // The in-memory forge logs the feed's reads only: the PR activity's is logged here too.
  const comments = w.forge.issueComments;
  w.forge.issueComments = async (a) => (w.forge.reads.push(['issueComments', `${a.repo}#${a.number}`]), comments(a));
  let ids = 8100;
  const touch = (n, at) => {
    const p = prs.find((x) => x.number === n);
    p.updatedAt = iso(Math.max(Date.parse(p.updatedAt), at));
  };
  const say = (n, at, { author = 'owner-login' } = {}) => {
    activity[idOf(n)].comments.push({ id: ++ids, author, body: 'say it as the app does', createdAt: iso(at), updatedAt: iso(at) });
    touch(n, at);
  };
  const review = (n, at, { lines = 2, body = '', state = 'COMMENTED', author = 'owner-login' } = {}) => {
    const rid = ++ids;
    activity[idOf(n)].reviews.push({ id: rid, author, state, body, submittedAt: iso(at) });
    for (let i = 0; i < lines; i++) activity[idOf(n)].threads.push({ id: `T${rid}-${i}`, path: 'docs/a.md', line: 3 + i, comments: [{ id: ++ids, author, body: `line ${i}`, createdAt: iso(at), updatedAt: iso(at), reviewId: rid }] });
    touch(n, at);
  };
  return { w, activity, say, review };
}

// The stand-ins. `io.spawn` records a detached process and gives it a live pid; `finish` runs a hand-on's process to
// its end as `watcher.mjs --hand-on` would (its run answers the comments, as a session records them) and ends its pid.
function ticker(w, { gate = null } = {}) {
  const live = new Set();
  let pids = 7000;
  const calls = { spawns: [], runs: [], jobs: [], notes: [] };
  // The test's own process holds the full check's lock when a full check runs in it.
  const isAlive = (p) => p === process.pid || live.has(p);
  const session = (at) => async (a) => {
    calls.runs.push({ at, ...a.options });
    for (const key of a.options.named ?? []) {
      const n = Number(key) - 400;
      const act = w.forge.activity[idOf(n)];
      if (!act) continue;
      const list = [...act.comments, ...act.threads.flatMap((t) => t.comments), ...act.reviews.filter((r) => r.body)];
      await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'answerComments', pr: idOf(n), status: 'done', result: { handled: list.map((x) => ({ id: x.id, updatedAt: x.updatedAt ?? x.submittedAt })) }, now: at });
    }
    if (gate) await gate(a);
    return { mode: w.settings.mode, named: a.options.named ?? [], ran: [], starts: [], guard: [] };
  };
  const io = (at) => ({
    now: () => at,
    git: quietGit,
    isAlive,
    runDaily: session(at),
    readUsage: () => assert.fail('no /usage outside a run'),
    spawn: (args, { kind }) => {
      const pid = ++pids;
      live.add(pid);
      calls.spawns.push({ at, kind, args, pid });
      return { pid };
    },
    spawnJob: async (cmd) => (calls.jobs.push(cmd), { code: 0, stdout: '', stderr: '' }),
    notify: (m) => (calls.notes.push(m), { sent: true }),
  });
  const finish = async (spawned, at) => {
    const id = spawned.args[spawned.args.indexOf('--hand-on') + 1];
    const keys = spawned.args.flatMap((a, i) => (a === '--ticket' ? [spawned.args[i + 1]] : []));
    const r = await runHandOn({ settings: w.settings, clients: w.clients(), io: { now: () => at, runDaily: session(at) }, options: { id, keys } });
    live.delete(spawned.pid);
    return r;
  };
  const handOns = () => calls.spawns.filter((s) => s.kind === 'hand-on');
  return {
    calls,
    live,
    handOns,
    finish,
    forge: (at, options = {}) => runForgeCheck({ settings: w.settings, clients: w.clients(), io: io(at), options }),
    full: (at, options = {}) => runCheck({ settings: w.settings, clients: w.clients(), io: io(at), options }),
    tick: (at, options = {}) => runTick({ settings: w.settings, clients: w.clients(), io: io(at), options }),
  };
}

const keysOf = (s) => s.args.flatMap((a, i) => (a === '--ticket' ? [s.args[i + 1]] : []));

test('AC-1: an owner comment waits for 2 quiet minutes, then starts a run in a process of its own (--hand-on, the watcher run); the next check collects it', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(81, NOW);
  let out = await t.forge(NOW + 10 * SEC);
  assert.deepEqual([out.kind, out.events, out.handed, t.calls.spawns], ['forge', 1, [], []]);
  assert.deepEqual(out.waiting, [{ key: '481', until: iso(NOW + 2 * MIN), why: `${idOf(81)}: a comment at ${iso(NOW)}: waits for quiet`, new: true }]);
  assert.equal(readForge(w.settings.state).waits['481'].dueAt, iso(NOW + 2 * MIN));
  assert.match(oneLine(out), /forge check; 1 changed PR\(s\); 481 waits for quiet until 2026-11-10T09:02:00.000Z/);
  // Nothing new, the wait not over: no activity read, a quiet check.
  const reads = w.forge.reads.length;
  out = await t.forge(NOW + 70 * SEC);
  assert.deepEqual([out.quiet, out.handed, t.calls.spawns.length], [true, [], 0]);
  assert.deepEqual([...new Set(w.forge.reads.slice(reads).map((r) => r[0]))], ['changedPrs']);
  // The quiet is over: a run is started, with no new event, 2 min 10 s after the comment; the check doesn't wait for it.
  out = await t.forge(NOW + 130 * SEC);
  assert.deepEqual(out.handed, ['481']);
  const [s] = t.handOns();
  assert.equal(s.at - NOW, 130 * SEC);
  assert.deepEqual(s.args.slice(0, 2), [WATCHER, '--hand-on']);
  assert.deepEqual(keysOf(s), ['481']);
  assert.deepEqual(s.args.slice(-7), ['--root', w.settings.root, '--settings', w.settings.file, '--claude', 'claude', '--quiet']);
  assert.equal(t.calls.runs.length, 0, 'no run inside the check');
  assert.deepEqual(readForge(w.settings.state).handOns.map((h) => [h.keys, h.pid]), [[['481'], s.pid]]);
  assert.match(oneLine(out), /comments: run \S+ \(pid 7001\) started for 481/);
  // The hand-on's process runs the watcher run and ends; the next check collects it and starts nothing more.
  const r = await t.finish(s, NOW + 140 * SEC);
  assert.deepEqual([r.keys, r.run.named, t.calls.runs.map((x) => x.trigger)], [['481'], ['481'], ['watcher']]);
  out = await t.forge(NOW + 190 * SEC);
  assert.deepEqual([out.finished.map((f) => f.keys), out.handed, t.handOns().length], [[['481']], [], 1]);
  assert.deepEqual(readForge(w.settings.state).handOns, []);
  assert.equal(fs.existsSync(handOnFile(w.settings.state, r.id)), false, 'the result file is taken');
});

test('AC-1: a submitted review is a batch and starts at once; so is a review with text of its own, or with a verdict; a reviewer\'s single comment waits', async () => {
  for (const [what, opts] of [['two line comments', { lines: 2 }], ['its own text', { lines: 0, body: 'Please look at the whole page again.' }], ['a verdict', { lines: 1, state: 'CHANGES_REQUESTED' }]]) {
    const { w, review } = commented();
    seed(w, NOW - MIN);
    const t = ticker(w);
    review(81, NOW, opts);
    const out = await t.forge(NOW + 10 * SEC);
    assert.deepEqual([out.handed, out.waiting, t.handOns().map(keysOf)], [['481'], [], [['481']]], what);
  }
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(81, NOW, { author: 'expert-one' });
  const out = await t.forge(NOW + 10 * SEC);
  assert.deepEqual([out.handed, out.waiting.map((x) => x.key)], [[], ['481']]);
});

test('AC-2: three comments 30 s apart start one run, not three, also with a full check started in the middle of them', async () => {
  const { w, say } = commented();
  // The last full check began 3 min 20 s before the first comment: the tick at +70 s starts a full one.
  seed(w, NOW - 200 * SEC);
  const t = ticker(w);
  const comments = [NOW, NOW + 30 * SEC, NOW + 60 * SEC];
  const fulls = [];
  for (let at = NOW + 10 * SEC; at < NOW + 8 * MIN; at += MIN) {
    while (comments.length && comments[0] <= at) say(81, comments.shift());
    const out = await t.tick(at);
    fulls.push(Boolean(out.full?.started));
    // The full check's process, run here to its end; the hand-on's too.
    if (out.full?.started) await t.full(at);
    for (const s of t.handOns().filter((x) => t.live.has(x.pid))) await t.finish(s, at);
  }
  assert.deepEqual(fulls, [false, true, false, false, false, false, true, false]);
  // One run, at the first tick two minutes after the last comment (+60 s): +190 s. The full check at +70 s held it.
  assert.deepEqual(t.handOns().map((s) => [(s.at - NOW) / SEC, keysOf(s)]), [[190, ['481']]]);
  assert.deepEqual(t.calls.runs.map((r) => [(r.at - NOW) / SEC, r.named]), [[190, ['481']]]);
});

test('the full check holds comments for their quiet too (in pending), and hands them on itself when there is no forge check', async () => {
  const { w, say } = commented({ extra: { schedule: { forgeSeconds: null } } });
  seed(w, NOW - 5 * MIN);
  const t = ticker(w);
  say(81, NOW - MIN);
  assert.equal(checkKindOf(w.settings, readFeed(w.settings.state), NOW), 'full');
  let out = await t.tick(NOW);
  assert.deepEqual([out.kind, out.pending, out.waiting.map((x) => [x.key, x.until])], ['full', ['481'], [['481', iso(NOW + MIN)]]]);
  assert.deepEqual([t.calls.runs, t.calls.spawns], [[], []]);
  out = await t.tick(NOW + 5 * MIN);
  assert.deepEqual(t.calls.runs.map((r) => [r.trigger, r.named]), [['watcher', ['481']]]);
  assert.deepEqual(out.pending, []);
});

test('the full check holds a ticket whose forge run may not have taken its lock yet, as it holds a locked one', async () => {
  const { w, say } = commented();
  seed(w, NOW - 5 * MIN);
  const t = ticker(w);
  say(81, NOW - 10 * MIN);
  t.live.add(4242);
  writeForge(w.settings.state, { ...readForge(w.settings.state), handOns: [{ id: 'x', pid: 4242, keys: ['481'], at: iso(NOW - 10 * SEC) }] });
  const out = await t.full(NOW);
  assert.deepEqual([t.calls.runs, out.pending], [[], ['481']]);
});

test('AC-3: the forge check reads no tracker, runs no morning run, no start pass and no job, makes no /usage or model call, and leaves the full check\'s feed alone', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN, { morning: '2026-11-09', jobs: { notes: { armed: true, firstChange: iso(NOW - 5 * 3600000), lastChange: iso(NOW - 4 * 3600000) } } });
  const before = fs.readFileSync(path.join(w.settings.state, 'watch', 'feed.json'), 'utf8');
  const t = ticker(w);
  say(81, NOW - 5 * MIN);
  const out = await t.forge(NOW);
  assert.deepEqual(out.handed, ['481']);
  assert.deepEqual(w.tracker.reads, [], 'no tracker read');
  assert.deepEqual([out.morning, out.startPass, out.jobs, t.calls.jobs, t.calls.runs], [undefined, undefined, [], [], []]);
  assert.deepEqual([...new Set(w.forge.reads.map((r) => r[0]))], ['changedPrs', 'issueComments']);
  assert.deepEqual(w.forge.reads.filter((r) => r[0] === 'issueComments'), [['issueComments', idOf(81)]]);
  assert.equal(fs.readFileSync(path.join(w.settings.state, 'watch', 'feed.json'), 'utf8'), before, "the full check's file is not written");
});

test('a long session of one ticket never holds up another\'s comments: while a full check runs ticket A\'s chain, B\'s comments are handed on within the forge interval', async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const { w, say, review } = commented({ numbers: [81, 82] });
  // The full check's run of A takes A's group lock and runs for as long as the gate holds (a 40-minute session, a chain).
  const t = ticker(w, {
    gate: async (a) => {
      if (!a.options.named?.includes('481')) return;
      takeLock(w.settings.state, { group: '481', kind: 'schedule', stage: 'answerComments', leaseMinutes: 120, now: NOW });
      await held;
      releaseLock(w.settings.state, '481');
    },
  });
  seed(w, NOW - 5 * MIN);
  say(81, NOW - 10 * MIN);
  let fullDone = false;
  const full = t.full(NOW).then((o) => ((fullDone = true), o));
  await new Promise((r) => setImmediate(r));
  assert.ok(watchLockHolder(w.settings.state, { isAlive: () => true }), 'the full check holds its lock through its run');
  // B: a submitted review. The first forge check after it starts B's run, while A's session still goes on.
  review(82, NOW + 20 * SEC);
  let out = await t.forge(NOW + 30 * SEC);
  assert.deepEqual([out.handed, fullDone], [['482'], false]);
  // A tick with the full check due while that one still runs: no second full check, and the forge check runs.
  writeFeed(w.settings.state, { ...readFeed(w.settings.state), fullAt: iso(NOW - 5 * MIN) });
  out = await t.tick(NOW + 60 * SEC);
  assert.equal(out.full.running, true);
  assert.equal(t.calls.spawns.filter((s) => s.kind === 'full').length, 0);
  // B's run ends; a single comment on B: handed on within the quiet time and one tick, A's session still going.
  await t.finish(t.handOns()[0], NOW + 70 * SEC);
  say(82, NOW + 75 * SEC);
  for (let at = NOW + 90 * SEC; at <= NOW + 4 * MIN; at += MIN) await t.forge(at);
  assert.deepEqual(t.handOns().map((s) => [(s.at - NOW) / SEC, keysOf(s)]), [[30, ['482']], [210, ['482']]]);
  assert.equal(fullDone, false, "A's session is still going");
  // A's own comments wait while its run holds it: no run of A from the forge check.
  say(81, NOW + 4 * MIN);
  out = await t.forge(NOW + 7 * MIN);
  assert.deepEqual([out.held, out.handed], [['481'], []]);
  release();
  await full;
});

test('a second comment while the ticket\'s run is starting waits until that process ended; a ticket in the owner\'s hands is never handed on', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(81, NOW - 5 * MIN);
  let out = await t.forge(NOW);
  assert.deepEqual(out.handed, ['481']);
  // Its run hasn't taken the group lock yet (it reads /usage first): a new comment on the PR waits, with no forge read.
  say(81, NOW + 10 * SEC);
  const reads = w.forge.reads.length;
  out = await t.forge(NOW + MIN);
  assert.deepEqual([out.held, out.handed, [...new Set(w.forge.reads.slice(reads).map((r) => r[0]))]], [['481'], [], ['changedPrs']]);
  // The process ended before it answered the new one (its run took a snapshot): the next check hands it on.
  t.live.delete(t.handOns()[0].pid);
  out = await t.forge(NOW + 3 * MIN);
  assert.deepEqual([out.handed, t.handOns().length], [['481'], 2]);
  assert.match(out.notes.join(' '), /ended with no result/);
  // In the owner's hands: the comments are theirs to answer.
  await t.finish(t.handOns()[1], NOW + 3 * MIN);
  const l = read(w, '481');
  l.mode = 'hand';
  writeLedger(w.settings.state, l);
  say(81, NOW + 4 * MIN);
  out = await t.forge(NOW + 7 * MIN);
  assert.deepEqual([out.handed, out.waiting, t.handOns().length], [[], [], 2]);
});

test('a run that failed is told and its tickets wait a full interval; at limits.parallel the tickets wait for a slot; a forge read that fails keeps the cursor', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(81, NOW - 5 * MIN);
  await t.forge(NOW);
  const [s] = t.handOns();
  const id = s.args[s.args.indexOf('--hand-on') + 1];
  await runHandOn({ settings: w.settings, clients: w.clients(), io: { now: () => NOW + 5 * SEC, runDaily: async () => { throw new Error('the status could not be read'); } }, options: { id, keys: ['481'] } });
  t.live.delete(s.pid);
  let out = await t.forge(NOW + MIN);
  assert.deepEqual(out.errors, [{ part: 'the run', error: 'the status could not be read' }]);
  assert.deepEqual(t.calls.notes.map((n) => n.title), ['Ticket flow: a part of a check failed']);
  assert.equal(readForge(w.settings.state).waits['481'].dueAt, iso(NOW + 6 * MIN));
  out = await t.forge(NOW + 3 * MIN);
  assert.deepEqual(out.handed, []);
  // At the limit (3 runs hold group locks): the ticket waits, and starts once a slot frees.
  for (const g of ['a1', 'a2', 'a3']) takeLock(w.settings.state, { group: g, kind: 'schedule', leaseMinutes: 120, now: NOW });
  out = await t.forge(NOW + 6 * MIN);
  assert.deepEqual([out.handed, t.handOns().length], [[], 1]);
  assert.match(out.notes.join(' '), /limits.parallel 3: 481 wait for a slot/);
  releaseLock(w.settings.state, 'a1');
  out = await t.forge(NOW + 7 * MIN);
  assert.deepEqual(out.handed, ['481']);
  // The forge down: the cursor stays, nothing is handed on.
  const down = commented({ fail: { 'guide-docs': 'HTTP 502' } });
  seed(down.w, NOW - MIN);
  const r = await ticker(down.w).forge(NOW);
  assert.deepEqual(r.sources.map((x) => [x.name, x.outcome]), [['prs:guide-docs', 'failed'], ['prs:api-docs', 'read'], ['prs:portal-docs', 'read']]);
  assert.equal(readForge(down.w.settings.state).sources['prs:guide-docs'].lastCheck, iso(NOW - MIN));
});

test('the comments of a review not yet submitted never start a run through the forge check; once it is submitted, at once (through the GitHub adapter)', async () => {
  const c = card({ number: 505, status: 'smeReview' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 7, branch: 'docs/export-screen', targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  seed(w, NOW - MIN);
  // The owner is writing a review: two line comments under review 530, still PENDING. GitHub moves the PR's update time.
  let state = 'PENDING';
  let updatedAt = iso(NOW - 30 * SEC);
  const node = () => ({ ...fixture('gql-pr-7').data.repository.pullRequest, updatedAt });
  const routes = {
    'graphql ChangedPrs': (call) => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: call.variables.name === 'guide-docs' ? [node()] : [] } } } }),
    'graphql PrByNumber': () => ({ data: { repository: { pullRequest: node() } } }),
    'graphql PrReviews': () => ({ data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'PRR_530', databaseId: 530, author: { login: 'owner-login' }, state, body: '', submittedAt: state === 'PENDING' ? null : updatedAt, commit: null }] } } } } }),
    'graphql PrThreads': () => ({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [3, 9].map((line) => ({ id: `PRRT_${line}`, isResolved: false, isOutdated: false, path: 'docs/a.md', line, comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: `PRRC_${600 + line}`, databaseId: 600 + line, author: { __typename: 'User', login: 'owner-login' }, body: `Say it as the app does (${line}).`, createdAt: iso(NOW - 40 * SEC), updatedAt: iso(NOW - 40 * SEC), path: 'docs/a.md', line, replyTo: null, pullRequestReview: { databaseId: 530, state } }] } })) } } } },
    }),
    'graphql PrComments': () => ({ data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }),
  };
  const calls = [];
  const gh = replayer(routes, { onCall: (x) => calls.push(x.key) });
  const spawns = [];
  const check = (at) =>
    runForgeCheck({
      settings: w.settings,
      clients: makeClients({ settings: w.settings, io: { trackerAdapter: w.tracker, ghRunner: gh } }),
      io: { now: () => at, git: quietGit, isAlive: () => false, spawn: (args) => (spawns.push(args), { pid: 9000 + spawns.length }) },
      options: {},
    });
  let out = await check(NOW);
  assert.ok(calls.includes('graphql PrThreads'), 'the changed PR was read');
  assert.deepEqual([out.tickets, out.handed, out.waiting, spawns], [[{ key: '505', comments: 0, ready: false, why: 'no comment to answer' }], [], [], []]);
  assert.deepEqual(readForge(w.settings.state).waits, {}, 'nothing waits: a draft is no comment');
  // Past the quiet time, still nothing: no wait was kept, so nothing comes back.
  out = await check(NOW + 3 * MIN);
  assert.deepEqual([out.handed, spawns], [[], []]);
  // Submitted: one review with two line comments, a batch: a run at the first check after.
  state = 'COMMENTED';
  updatedAt = iso(NOW + 3 * MIN + 20 * SEC);
  out = await check(NOW + 3 * MIN + 30 * SEC);
  assert.deepEqual([out.handed, spawns.map((a) => keysOf({ args: a }))], [['505'], [['505']]]);
});

test('a detached process: its own session, its output appended to the LaunchAgent log, no API key in its environment', async () => {
  const w = world();
  const log = path.join(w.settings.state, 'watch', 'launchd.log');
  const child = spawnDetached(['-e', "console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, auth: process.env.ANTHROPIC_AUTH_TOKEN ?? null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, path: Boolean(process.env.PATH) }))"], { settings: w.settings, env: { ...process.env, ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.ok(child.pid > 0);
  for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim()), { key: null, auth: null, token: null, path: true });
  // The hand-on's arguments name the host, its settings and the claude command; the process prepares its own sign-in.
  const args = handOnArgs(w.settings, { id: 'h1', keys: ['481', '482'], claude: '/opt/claude/bin/claude' });
  assert.deepEqual(args, [WATCHER, '--hand-on', 'h1', '--ticket', '481', '--ticket', '482', '--root', w.settings.root, '--settings', w.settings.file, '--claude', '/opt/claude/bin/claude', '--quiet']);
});

test('the tick: the full check every watchMinutes since the last one began (half a tick early counts), the forge check between; an old feed or a clock gone back: full', () => {
  const w = world();
  const s = w.settings;
  const at = (ago) => ({ fullAt: iso(NOW - ago) });
  assert.equal(checkKindOf(s, at(60 * SEC), NOW), 'forge');
  assert.equal(checkKindOf(s, at(269 * SEC), NOW), 'forge');
  assert.equal(checkKindOf(s, at(270 * SEC), NOW), 'full');
  assert.equal(checkKindOf(s, {}, NOW), 'full', 'a feed from before the forge check');
  assert.equal(checkKindOf(s, at(-MIN), NOW), 'full', 'the clock went back');
  assert.equal(checkKindOf({ ...s, schedule: { ...s.schedule, forgeSeconds: null } }, at(60 * SEC), NOW), 'full');
});

test('a full check\'s lock with no owner file: held for a minute (being written), then stale, and a due tick starts the full check', async () => {
  const { w } = commented();
  seed(w, NOW - 10 * MIN);
  const dir = path.join(w.settings.state, 'watch', 'active');
  fs.mkdirSync(dir);
  const t = ticker(w);
  const real = Date.now();
  assert.equal(watchLockHolder(w.settings.state, { now: real + 10 * SEC }) !== null, true, 'fresh: held');
  fs.utimesSync(dir, new Date(real - 2 * MIN), new Date(real - 2 * MIN));
  assert.equal(watchLockHolder(w.settings.state, { now: real }), null, 'two minutes old: stale');
  // The tick's clock is the test's: the folder's age is read against it.
  fs.utimesSync(dir, new Date(NOW - 2 * MIN), new Date(NOW - 2 * MIN));
  let out = await t.tick(NOW);
  assert.equal(out.full.started, true);
  fs.utimesSync(dir, new Date(NOW - 10 * SEC), new Date(NOW - 10 * SEC));
  out = await t.tick(NOW + SEC);
  assert.equal(out.full.running, true);
});

test('mode off: a tick starts no full check and the forge check reads nothing', async () => {
  const { w, say } = commented({ extra: { mode: 'off' } });
  seed(w, NOW - 10 * MIN);
  const t = ticker(w);
  say(81, NOW - 5 * MIN);
  const out = await t.tick(NOW);
  assert.deepEqual([out.stopped, out.full, t.calls.spawns, w.forge.reads], ['mode off: nothing runs', undefined, [], []]);
});

test('the start rule on its own: a batch at once, single comments after the quiet, the newest counts', () => {
  const now = NOW;
  const quietMs = 2 * MIN;
  const c = (id, at, extra = {}) => ({ id, kind: 'comment', by: 'owner', updatedAt: iso(at), ...extra });
  assert.equal(startRule([], {}, { now, quietMs }), null);
  assert.deepEqual(startRule([c(1, now - 3 * MIN), c(2, now - MIN)], {}, { now, quietMs }).ready, false);
  assert.equal(startRule([c(1, now - 3 * MIN), c(2, now - MIN)], {}, { now, quietMs }).dueAt, now + MIN);
  assert.equal(startRule([c(1, now - 2 * MIN)], {}, { now, quietMs }).ready, true);
  // One line comment added on its own (a review of one comment, no text, no verdict): a single comment.
  const single = { reviews: [{ id: 50, state: 'COMMENTED', body: '' }], threads: [{ comments: [{ id: 51, reviewId: 50 }] }] };
  assert.equal(startRule([c(51, now - 10 * SEC, { kind: 'review-comment' })], single, { now, quietMs }).ready, false);
  const batch = { reviews: [{ id: 50, state: 'COMMENTED', body: '' }], threads: [{ comments: [{ id: 51, reviewId: 50 }, { id: 52, reviewId: 50 }] }] };
  assert.equal(startRule([c(51, now - 10 * SEC, { kind: 'review-comment' })], batch, { now, quietMs }).why, 'a submitted review');
});

test('the watcher CLI: --full, --forge and --hand-on exclude each other; --hand-on needs its tickets', async () => {
  const quiet = { stdout: { write: () => {} } };
  await assert.rejects(watcherMain(['--full', '--forge'], quiet), /exclude each other/);
  await assert.rejects(watcherMain(['--forge', '--hand-on', 'h1', '--ticket', '1'], quiet), /exclude each other/);
  await assert.rejects(watcherMain(['--hand-on', 'h1'], quiet), /needs the tickets/);
  await assert.rejects(watcherMain(['--ticket', '1'], quiet), /goes with --hand-on/);
  await assert.rejects(watcherMain(['--hand-on', '../x', '--ticket', '1'], quiet), /not a hand-on id/);
});
