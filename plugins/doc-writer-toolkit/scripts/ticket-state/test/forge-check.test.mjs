import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, card, pr, quietGit } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { makeClients } from '../lib/world.mjs';
import { emptyFeed, readFeed, sourcesOf, writeFeed } from '../lib/feed.mjs';
import { takeLock, releaseLock } from '../lib/locks.mjs';
import { writeLedger } from '../lib/ledger.mjs';
import { checkKindOf, runCheck, runForgeCheck, runTick, takeWatchLock } from '../lib/watch.mjs';
import { startRule } from '../lib/quiet.mjs';
import { main as watcherMain, oneLine } from '../watcher.mjs';
import { fixture, replayer } from '../../forge/test/fake-gh.mjs';

// The forge check (D-126): the owner's comments on a pipeline PR are picked up within a minute, by a check of the
// changed PRs only, every schedule.forgeSeconds between full checks. A submitted review starts its session at once;
// single comments once they have been quiet for schedule.commentQuietMinutes (AC-1, AC-2). The forge check reads no
// tracker, runs no morning run, no start pass and no job, and never overlaps a full check (AC-3). In-memory forge and
// tracker, and a fake clock.

process.env.TZ = 'UTC';

const iso = (ms) => new Date(ms).toISOString();
const SEC = 1000;
const MIN = 60000;
const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const PR_ID = 'guide-docs#81';

// The feed after a full check at `fullAt`: every cursor at `at`, the forge check's too, and today's morning run done.
function seed(w, at, { fullAt = at, morning = '2026-11-10', jobs = {} } = {}) {
  const f = emptyFeed();
  for (const s of sourcesOf(w.settings)) f.sources[s.name] = { lastCheck: iso(at), seen: {} };
  f.forgeCheck = { sources: Object.fromEntries(sourcesOf(w.settings).filter((s) => s.kind === 'prs').map((s) => [s.name, { lastCheck: iso(at), seen: {} }])) };
  f.morning = { lastDate: morning };
  f.fullAt = iso(fullAt);
  f.checkedAt = iso(fullAt);
  f.jobs = jobs;
  writeFeed(w.settings.state, f);
}

// A ticket in the expert review with one open PR; `say(at, …)` adds a comment to it as the forge would show it, and
// moves the PR's update time.
function commented(extra = {}) {
  const activity = { [PR_ID]: { comments: [], threads: [], reviews: [] } };
  const p81 = { ...pr({ repo: 'guide-docs', number: 81, labels: ['in expert review'] }), updatedAt: iso(NOW - 30 * MIN) };
  const c = card({ number: 481, status: 'smeReview' });
  const w = world({ cards: [c], activity, changed: { 'guide-docs': [p81] }, prs: [p81], ...extra });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 81, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  // The in-memory forge logs the feed's reads only: the PR activity's is logged here too.
  const comments = w.forge.issueComments;
  w.forge.issueComments = async (a) => (w.forge.reads.push(['issueComments', `${a.repo}#${a.number}`]), comments(a));
  let ids = 8100;
  const touch = (at) => (p81.updatedAt = iso(Math.max(Date.parse(p81.updatedAt), at)));
  const say = (at, { author = 'owner-login', body = 'say it as the app does' } = {}) => {
    activity[PR_ID].comments.push({ id: ++ids, author, body, createdAt: iso(at), updatedAt: iso(at) });
    touch(at);
  };
  // A submitted review: line comments under one review id, with the review's own text (or none).
  const review = (at, { lines = 2, body = '', state = 'COMMENTED', author = 'owner-login' } = {}) => {
    const rid = ++ids;
    activity[PR_ID].reviews.push({ id: rid, author, state, body, submittedAt: iso(at) });
    for (let i = 0; i < lines; i++) activity[PR_ID].threads.push({ id: `T${rid}-${i}`, path: 'docs/a.md', line: 3 + i, comments: [{ id: ++ids, author, body: `line ${i}`, createdAt: iso(at), updatedAt: iso(at), reviewId: rid }] });
    touch(at);
  };
  return { w, activity, p81, say, review };
}

// Checks with stand-ins: the runner records what it was handed and, as the session would, records the comments as
// answered; /usage, a job or a model call outside the runner fails the test.
function ticker(w, { session = true } = {}) {
  const calls = { runs: [], jobs: [], notes: [] };
  const io = (at) => ({
    now: () => at,
    git: quietGit,
    runDaily: async (a) => {
      calls.runs.push({ at, ...a.options });
      if (session && a.options.named?.includes('481')) {
        const list = [...w.forge.activity[PR_ID].comments, ...w.forge.activity[PR_ID].threads.flatMap((t) => t.comments), ...w.forge.activity[PR_ID].reviews.filter((r) => r.body)];
        await runRecord({ settings: w.settings, clients: w.clients(), key: '481', stage: 'answerComments', pr: PR_ID, status: 'done', result: { handled: list.map((x) => ({ id: x.id, updatedAt: x.updatedAt ?? x.submittedAt })) }, now: at });
      }
      return { mode: w.settings.mode, named: a.options.named ?? [], ran: [], starts: [], guard: [] };
    },
    readUsage: () => assert.fail('no /usage outside the runner'),
    spawnJob: async (cmd) => (calls.jobs.push(cmd), { code: 0, stdout: '', stderr: '' }),
    notify: (m) => (calls.notes.push(m), { sent: true }),
  });
  return {
    calls,
    forge: (at, options = {}) => runForgeCheck({ settings: w.settings, clients: w.clients(), io: io(at), options }),
    full: (at, options = {}) => runCheck({ settings: w.settings, clients: w.clients(), io: io(at), options }),
    tick: (at, options = {}) => runTick({ settings: w.settings, clients: w.clients(), io: io(at), options }),
  };
}

test('AC-1: an owner comment waits for 2 quiet minutes and is handed on at the first check after them, as the watcher hands on (--watcher)', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(NOW);
  let out = await t.forge(NOW + 10 * SEC);
  assert.deepEqual([out.kind, out.events, out.handed, t.calls.runs.length], ['forge', 1, [], 0]);
  assert.deepEqual(out.waiting, [{ key: '481', until: iso(NOW + 2 * MIN), why: `${PR_ID}: a comment at ${iso(NOW)}: waits for quiet`, new: true }]);
  assert.equal(readFeed(w.settings.state).commentWaits['481'].dueAt, iso(NOW + 2 * MIN));
  assert.match(oneLine(out), /forge check; 1 changed PR\(s\); 481 waits for quiet until 2026-11-10T09:02:00.000Z/);
  // Nothing new, the wait not over: no activity read, a quiet line.
  const reads = w.forge.reads.length;
  out = await t.forge(NOW + 70 * SEC);
  assert.deepEqual([out.quiet, out.handed, t.calls.runs.length], [true, [], 0]);
  assert.deepEqual([...new Set(w.forge.reads.slice(reads).map((r) => r[0]))], ['changedPrs']);
  // The quiet is over: handed on with no new event, 2 min 10 s after the comment.
  out = await t.forge(NOW + 130 * SEC);
  assert.deepEqual(out.handed, ['481']);
  assert.deepEqual(t.calls.runs.map((r) => [r.at - NOW, r.trigger, r.named]), [[130 * SEC, 'watcher', ['481']]]);
  assert.equal(readFeed(w.settings.state).commentWaits['481'], undefined);
  // Answered: the next checks hand nothing on.
  out = await t.forge(NOW + 190 * SEC);
  assert.deepEqual([out.handed, t.calls.runs.length], [[], 1]);
});

test('AC-1: a submitted review is a batch and starts at once; so is a review with text of its own, or with a verdict', async () => {
  for (const [what, opts] of [['two line comments', { lines: 2 }], ['its own text', { lines: 0, body: 'Please look at the whole page again.' }], ['a verdict', { lines: 1, state: 'CHANGES_REQUESTED' }]]) {
    const { w, review } = commented();
    seed(w, NOW - MIN);
    const t = ticker(w);
    review(NOW, opts);
    const out = await t.forge(NOW + 10 * SEC);
    assert.deepEqual([out.handed, out.waiting], [['481'], []], what);
    assert.deepEqual(t.calls.runs.map((r) => [r.trigger, r.named]), [['watcher', ['481']]], what);
  }
  // A reviewer's single comment waits as the owner's does.
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(NOW, { author: 'expert-one' });
  const out = await t.forge(NOW + 10 * SEC);
  assert.deepEqual([out.handed, out.waiting.map((x) => x.key)], [[], ['481']]);
});

test('AC-2: three comments 30 s apart start one session, not three, also with a full check in the middle of them', async () => {
  const { w, say } = commented();
  // The last full check began 3 min 20 s before the first comment: the tick at +70 s is a full one.
  seed(w, NOW - 200 * SEC);
  const t = ticker(w);
  const comments = [NOW, NOW + 30 * SEC, NOW + 60 * SEC];
  const kinds = [];
  for (let at = NOW + 10 * SEC; at < NOW + 8 * MIN; at += MIN) {
    while (comments.length && comments[0] <= at) say(comments.shift());
    kinds.push((await t.tick(at)).kind);
  }
  assert.deepEqual(kinds, ['forge', 'full', 'forge', 'forge', 'forge', 'forge', 'full', 'forge']);
  // One session, at the first check two minutes after the last comment (+60 s): +190 s.
  assert.deepEqual(t.calls.runs.map((r) => [(r.at - NOW) / SEC, r.named]), [[190, ['481']]]);
});

test('the full check holds a comment for its quiet too, and hands it on itself when no forge check runs (schedule.forgeSeconds none)', async () => {
  const { w, say } = commented({ extra: { schedule: { forgeSeconds: null } } });
  seed(w, NOW - 5 * MIN);
  const t = ticker(w);
  say(NOW - MIN);
  assert.equal(checkKindOf(w.settings, readFeed(w.settings.state), NOW), 'full');
  let out = await t.tick(NOW);
  assert.deepEqual([out.kind, out.handed, out.waiting.map((x) => [x.key, x.until])], ['full', ['481'], [['481', iso(NOW + MIN)]]]);
  assert.equal(t.calls.runs.length, 0, 'status found the comments; their quiet is not over');
  // Five minutes on, no event: the wait list brings the ticket back.
  out = await t.tick(NOW + 5 * MIN);
  assert.deepEqual(t.calls.runs.map((r) => [r.trigger, r.named]), [['watcher', ['481']]]);
  assert.equal(readFeed(w.settings.state).commentWaits['481'], undefined);
});

test('AC-3: the forge check reads no tracker, runs no morning run, no start pass and no job, and makes no /usage or model call', async () => {
  const { w, say } = commented();
  // The morning run is due (yesterday's ran), a job is due, and no start pass has run: a full check would do all three.
  seed(w, NOW - MIN, { morning: '2026-11-09', jobs: { notes: { armed: true, firstChange: iso(NOW - 5 * 3600000), lastChange: iso(NOW - 4 * 3600000) } } });
  const before = readFeed(w.settings.state);
  const t = ticker(w);
  say(NOW - 5 * MIN);
  const out = await t.forge(NOW);
  assert.deepEqual(out.handed, ['481']);
  assert.deepEqual(w.tracker.reads, [], 'no tracker read');
  assert.equal(out.morning, undefined);
  assert.equal(out.startPass, undefined);
  assert.deepEqual([t.calls.jobs, out.jobs], [[], []]);
  assert.deepEqual(t.calls.runs.map((r) => [r.trigger, r.morning ?? false, r.startPass ?? false]), [['watcher', false, false]]);
  // Only the changed PRs, and the activity of the one that changed.
  assert.deepEqual([...new Set(w.forge.reads.map((r) => r[0]))], ['changedPrs', 'issueComments']);
  assert.deepEqual(w.forge.reads.filter((r) => r[0] === 'issueComments'), [['issueComments', PR_ID]]);
  const after = readFeed(w.settings.state);
  assert.deepEqual([after.morning, after.starts, after.jobs, after.sources, after.checkedAt, after.awakeSince, after.fullAt], [before.morning, before.starts, before.jobs, before.sources, before.checkedAt, before.awakeSince, before.fullAt], "the full check's memory is left as it was");
});

test('AC-3: one check at a time: a forge check skips while a full check holds the lock, and a full check skips while a forge check hands on', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(NOW - 5 * MIN);
  const held = takeWatchLock(w.settings.state, { now: NOW });
  let out = await t.forge(NOW);
  assert.match(out.skipped, /holds the watcher lock/);
  assert.deepEqual([w.forge.reads, t.calls.runs], [[], []]);
  held.release();
  // The other way round: a full check started while the forge check's run is going.
  let inner = null;
  const io = {
    now: () => NOW,
    git: quietGit,
    readUsage: () => assert.fail('no /usage'),
    runDaily: async (a) => {
      inner = await runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, git: quietGit }, options: {} });
      return { mode: 'on', named: a.options.named, ran: [], starts: [], guard: [] };
    },
  };
  out = await runForgeCheck({ settings: w.settings, clients: w.clients(), io, options: {} });
  assert.deepEqual(out.handed, ['481']);
  assert.match(inner.skipped, /holds the watcher lock/);
});

test('the comments of a review not yet submitted never start a session through the forge check; once it is submitted, at once (through the GitHub adapter)', async () => {
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
  const runs = [];
  const check = (at) =>
    runForgeCheck({
      settings: w.settings,
      clients: makeClients({ settings: w.settings, io: { trackerAdapter: w.tracker, ghRunner: gh } }),
      io: { now: () => at, git: quietGit, readUsage: () => assert.fail('no /usage'), runDaily: async (a) => (runs.push(a.options.named), { mode: 'on', named: a.options.named, ran: [], starts: [], guard: [] }) },
      options: {},
    });
  let out = await check(NOW);
  assert.ok(calls.includes('graphql PrThreads'), 'the changed PR was read');
  assert.deepEqual([out.tickets, out.handed, out.waiting, runs], [[{ key: '505', comments: 0, ready: false, why: 'no comment to answer' }], [], [], []]);
  assert.deepEqual(readFeed(w.settings.state).commentWaits, {}, 'nothing waits: a draft is no comment');
  // Past the quiet time, still nothing: no wait was kept, so nothing comes back.
  out = await check(NOW + 3 * MIN);
  assert.deepEqual([out.handed, runs], [[], []]);
  // Submitted: one review with two line comments, a batch: handed on at the first check after.
  state = 'COMMENTED';
  updatedAt = iso(NOW + 3 * MIN + 20 * SEC);
  out = await check(NOW + 3 * MIN + 30 * SEC);
  assert.deepEqual([out.handed, runs], [['505'], [['505']]]);
});

test('a ticket a run holds: its comments wait for that run to end, with no forge read meanwhile; a ticket in the owner\'s hands is never handed on', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  const t = ticker(w);
  say(NOW - 5 * MIN);
  takeLock(w.settings.state, { group: '481', kind: 'manual', leaseMinutes: 60, now: NOW });
  let out = await t.forge(NOW);
  assert.deepEqual([out.held, out.handed, t.calls.runs.length], [['481'], [], 0]);
  const reads = w.forge.reads.length;
  out = await t.forge(NOW + MIN);
  assert.deepEqual([out.held, [...new Set(w.forge.reads.slice(reads).map((r) => r[0]))]], [['481'], ['changedPrs']]);
  releaseLock(w.settings.state, '481');
  out = await t.forge(NOW + 2 * MIN);
  assert.deepEqual(out.handed, ['481']);
  // In the owner's hands: the comments are theirs to answer.
  const l = read(w, '481');
  l.mode = 'hand';
  writeLedger(w.settings.state, l);
  say(NOW + 3 * MIN);
  out = await t.forge(NOW + 6 * MIN);
  assert.deepEqual([out.handed, out.waiting, t.calls.runs.length], [[], [], 1]);
});

test('a hand-on that throws leaves its tickets to the full check (pending), not to the next minute; a forge read that fails keeps the cursor', async () => {
  const { w, say } = commented();
  seed(w, NOW - MIN);
  say(NOW - 5 * MIN);
  const notes = [];
  const out = await runForgeCheck({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, git: quietGit, runDaily: async () => { throw new Error('the status could not be read'); }, notify: (m) => (notes.push(m), { sent: true }) }, options: {} });
  assert.deepEqual(out.errors, [{ part: 'the run', error: 'the status could not be read' }]);
  const f = readFeed(w.settings.state);
  assert.deepEqual([f.pending, f.commentWaits['481']], [['481'], undefined]);
  assert.deepEqual(notes.map((n) => n.title), ['Ticket flow: a part of a check failed']);
  // The forge down: the cursor stays, nothing is handed on.
  const down = commented({ fail: { 'guide-docs': 'HTTP 502' } });
  seed(down.w, NOW - MIN);
  const r = await ticker(down.w).forge(NOW);
  assert.deepEqual(r.sources.map((s) => [s.name, s.outcome]), [['prs:guide-docs', 'failed'], ['prs:api-docs', 'read'], ['prs:portal-docs', 'read']]);
  assert.equal(readFeed(down.w.settings.state).forgeCheck.sources['prs:guide-docs'].lastCheck, iso(NOW - MIN));
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

test('the watcher CLI: --full and --forge force a check, and exclude each other', async () => {
  await assert.rejects(watcherMain(['--full', '--forge'], { stdout: { write: () => {} } }), /--full and --forge exclude each other/);
});
