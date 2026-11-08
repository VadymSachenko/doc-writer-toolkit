import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, pr } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { takeLock } from '../lib/locks.mjs';
import { makeClients } from '../lib/world.mjs';
import { fixture, replayer } from '../../forge/test/fake-gh.mjs';

// AC-1: `status` derives the state and the next step for every state of the design (§1) and every row of the rule (§7).

const fmt = (s) => `${s.stage}${s.pr ? ` ${s.pr}` : ''}${s.to ? ` -> ${s.to}` : ''}`;
const next = (t) => (t.next ? fmt(t.next) : null);

test('states before the PRs: ready, needsInfo, planning, writing, questions, planGate', async () => {
  const cards = {
    ready: card({ number: 101, status: 'ready' }),
    needs: card({ number: 102, status: 'ready', labels: ['needs info'] }),
    started: card({ number: 103, status: 'inProgress' }),
    planned: card({ number: 104, status: 'inProgress' }),
    written: card({ number: 105, status: 'inProgress' }),
    reviewed: card({ number: 106, status: 'inProgress' }),
    asked: card({ number: 107, status: 'blocked' }),
    gate: card({ number: 108, status: 'blocked' }),
  };
  const w = world({ cards: Object.values(cards) });
  ledger(w, cards.ready, { stages: { triage: 'done' } });
  ledger(w, cards.needs, { stages: { triage: 'done' } });
  ledger(w, cards.started, { stages: { triage: 'done', start: 'done' } });
  ledger(w, cards.planned, { stages: { triage: 'done', start: 'done', plan: 'done' } });
  ledger(w, cards.written, { stages: { triage: 'done', start: 'done', plan: 'done', write: 'done' } });
  ledger(w, cards.reviewed, { stages: { triage: 'done', start: 'done', plan: 'done', write: 'done', uaReview: 'done' } });
  ledger(w, cards.asked, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' } });
  ledger(w, cards.gate, { stages: { triage: 'done', start: 'done', plan: 'done', planGate: 'done' } });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, [t.state, next(t), t.counts]]));
  assert.deepEqual(by['101'], ['ready', null, null]);
  assert.deepEqual(by['102'], ['needsInfo', null, null]);
  assert.deepEqual(by['103'], ['planning', 'plan', 'inProgress']);
  assert.deepEqual(by['104'], ['planning', 'write', 'inProgress']);
  assert.deepEqual(by['105'], ['writing', 'uaReview', 'inProgress']);
  assert.deepEqual(by['106'], ['writing', 'pr', 'inProgress']);
  assert.deepEqual(by['107'], ['questions', null, 'waiting']);
  assert.deepEqual(by['108'], ['planGate', null, 'waiting']);
  assert.equal(st.tickets.find((t) => t.key === '107').gate.who, 'owner');
  assert.deepEqual(st.groups.map((g) => g.group), ['101'], 'needs info is not startable');
});

test('row 6: a person moved the card; Blocked -> In progress resumes where the ticket stopped', async () => {
  const c = {
    answered: card({ number: 201, status: 'inProgress' }),
    approved: card({ number: 202, status: 'inProgress' }),
    toReady: card({ number: 203, status: 'ready' }),
    toBlocked: card({ number: 204, status: 'blocked' }),
    toDone: card({ number: 205, status: 'done' }),
    byHand: card({ number: 206, status: 'inProgress' }),
    unblocked: card({ number: 207, status: 'inProgress' }),
  };
  const w = world({ cards: Object.values(c) });
  ledger(w, c.answered, { stages: { start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  fs.mkdirSync(path.join(w.root, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'plans', 'p.md'), 'the plan');
  ledger(w, c.approved, { stages: { start: 'done', plan: 'done', planGate: 'done' }, left: 'blocked', plan: { sectionPlan: { file: 'plans/p.md', hash: 'stale-hash' } } });
  ledger(w, c.toReady, { stages: { start: 'done', plan: 'done' }, left: 'inProgress' });
  ledger(w, c.toBlocked, { stages: { start: 'done', plan: 'done', write: 'done' }, left: 'inProgress' });
  ledger(w, c.toDone, { stages: { start: 'done' }, left: 'inProgress' });
  ledger(w, c.byHand, { stages: { triage: 'done' }, left: 'ready' });
  ledger(w, c.unblocked, { stages: { start: 'done', plan: 'done', write: 'done' }, left: 'blocked' });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, [t.state, next(t)]]));
  assert.deepEqual(by['201'], ['planning', 'answers']);
  assert.deepEqual(by['202'], ['planning', 'planGate'], 'the plan file changed since the gate: a new gate');
  assert.deepEqual(by['203'], ['paused', null]);
  assert.deepEqual(by['204'], ['ownerBlock', null]);
  assert.equal(st.tickets.find((t) => t.key === '204').counts, 'waiting');
  assert.deepEqual(by['205'], ['closed', 'follow -> done']);
  assert.deepEqual(by['206'], ['planning', 'start'], 'a card a person took into work: a manual start');
  assert.deepEqual(by['207'], ['writing', 'follow -> inProgress'], "the owner's own block lifted");
  // The same gate, the plan unchanged: moving the card back approves it.
  const sp = (await import('../lib/record.mjs')).fileHash(w.root, 'plans/p.md');
  ledger(w, c.approved, { stages: { start: 'done', plan: 'done', planGate: 'done' }, left: 'blocked', plan: { sectionPlan: { file: 'plans/p.md', hash: sp } } });
  assert.equal(next(await w.one('202')), 'planApproval');
});

test('rows 1, 2, 3 and 7: locked, hand, outside, interrupted', async () => {
  const c = {
    locked: card({ number: 301, status: 'inProgress' }),
    hand: card({ number: 302, status: 'inProgress' }),
    archived: card({ number: 303, status: 'inProgress', closed: true }),
    aside: card({ number: 304, list: LISTS.side }),
    running: card({ number: 305, status: 'inProgress' }),
  };
  const w = world({ cards: Object.values(c) });
  ledger(w, c.locked, { stages: { start: 'done', plan: { status: 'running' } } });
  ledger(w, c.hand, { stages: { start: 'done' }, mode: 'hand' });
  ledger(w, c.archived, { stages: { start: 'done' } });
  ledger(w, c.aside, { stages: { start: 'done' }, left: 'inProgress' });
  ledger(w, c.running, { stages: { start: 'done', plan: { status: 'running' } } });
  ledger(w, card({ number: 306, status: 'inProgress' }), { stages: { start: 'done' } }); // its card is gone from the tracker
  takeLock(w.settings.state, { group: '301', kind: 'schedule', stage: 'plan', leaseMinutes: 120, now: NOW });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.equal(by['301'].state, 'locked');
  assert.equal(by['301'].derivedState, 'planning');
  assert.equal(by['301'].counts, 'inProgress', 'a locked ticket still counts as what it does');
  assert.equal(by['301'].next, null);
  assert.equal(by['302'].state, 'planning');
  assert.equal(by['302'].hand, true);
  assert.equal(by['302'].next, null);
  assert.equal(by['302'].counted, false);
  assert.equal(by['303'].state, 'outside');
  assert.match(by['303'].notes[0], /archived/);
  assert.equal(by['304'].state, 'outside');
  assert.match(by['304'].notes[0], /outside the flow/);
  assert.equal(next(by['305']), 'plan');
  assert.equal(by['305'].next.interrupted, true);
  assert.equal(by['306'].state, 'outside');
  assert.match(by['306'].notes[0], /gone/);
});

test('row 13: the video gate tries parts within the day, falls back to Blocked, and imports when every part has its transcript', async () => {
  const c = { auto: card({ number: 401, status: 'inProgress' }), none: card({ number: 402, status: 'inProgress' }), failed: card({ number: 403, status: 'inProgress' }), waits: card({ number: 404, status: 'blocked' }), all: card({ number: 405, status: 'blocked' }), full: card({ number: 406, status: 'inProgress' }) };
  const w = world({ cards: Object.values(c), extra: { video: { browserProfile: '/somewhere/profile', partsPerDay: 3 } } });
  const parts = (name, n, tries = []) => Array.from({ length: n }, (_, i) => ({ file: `t/${name}-part${i + 1}.mp4`, start: i * 1800, transcript: `t/${name}-part${i + 1}-transcript.txt`, tries: typeof tries === 'function' ? tries(i) : tries }));
  const video = (ps) => ({ videos: [{ file: 't/v.mp4', parts: ps }], gateComment: 'Gate: the video', at: ago(5) });
  const failedTry = [{ at: ago(1), outcome: 'failed', reason: 'a sign-in wall' }];
  ledger(w, c.auto, { stages: { start: 'done', plan: 'done', videoGate: 'done' }, video: video(parts('auto', 5)) });
  ledger(w, c.failed, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoTry: 'done' }, video: video(parts('failed', 2, (i) => (i === 0 ? failedTry : []))) });
  ledger(w, c.waits, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoBlock: 'done' }, video: video(parts('waits', 2, failedTry)) });
  fs.mkdirSync(path.join(w.root, 't'), { recursive: true });
  for (const i of [1, 2]) fs.writeFileSync(path.join(w.root, `t/all-part${i}-transcript.txt`), 'text');
  ledger(w, c.all, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoBlock: 'done' }, video: video(parts('all', 2)) });
  const uploadedToday = [{ at: new Date(NOW - 60000).toISOString(), outcome: 'uploaded' }];
  ledger(w, c.full, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoTry: 'done' }, video: video(parts('full', 6, (i) => (i < 3 ? uploadedToday : []))) });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.equal(by['401'].state, 'videoGate');
  assert.equal(by['401'].counts, 'waiting');
  assert.equal(next(by['401']), 'videoTry');
  assert.equal(by['401'].next.parts.length, 3, 'three parts a day');
  assert.equal(next(by['403']), 'videoBlock', 'a failed try falls back to the gate');
  assert.equal(by['404'].next, null, 'in Blocked, waiting for the transcripts');
  assert.equal(next(by['405']), 'videoImport');
  assert.equal(by['406'].next, null, "today's three tries are used: the rest waits for tomorrow");
  assert.ok(by['406'].notes.some((n) => /wait for tomorrow/.test(n)));
  // No automatic try configured: straight to the gate.
  const w2 = world({ cards: [c.none] });
  ledger(w2, c.none, { stages: { start: 'done', plan: 'done', videoGate: 'done' }, video: video(parts('none', 1)) });
  assert.equal(next(await w2.one('402')), 'videoBlock');
});

test('the video gate: a card the owner moves back before every transcript goes on without the video', async () => {
  const c = card({ number: 410, status: 'inProgress' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoBlock: 'done' }, left: 'blocked', video: { videos: [{ file: 'v.mp4', parts: [{ file: 'v.mp4', start: 0, transcript: 'v.txt', tries: [] }] }] } });
  const t = await w.one('410');
  assert.equal(next(t), 'answers');
  assert.equal(t.next.withoutVideo, true);
  assert.ok(t.notes.some((n) => /without the video/.test(n)));
});

test('rows 9 and 11: a places PR waits in the owner\'s queue, open places or none; a new review request moves it to review; new comments are answered', async () => {
  const c = { req: card({ number: 501, status: 'finalReview' }), settled: card({ number: 502, status: 'finalReview' }), open: card({ number: 503, status: 'finalReview' }), commented: card({ number: 504, status: 'smeReview' }) };
  const prs = [
    pr({ repo: 'api-docs', number: 11, labels: ['In progress'], reviewRequests: ['expert-two'] }),
    pr({ repo: 'api-docs', number: 12, labels: ['In progress'] }),
    pr({ repo: 'api-docs', number: 13, labels: ['In progress'] }),
    pr({ repo: 'guide-docs', number: 14, labels: ['in expert review'] }),
  ];
  const activity = {
    'guide-docs#14': {
      threads: [{ id: 'T1', path: 'docs/a.md', line: 3, comments: [{ id: 7001, author: 'expert-one', body: 'wrong', createdAt: ago(3), updatedAt: ago(3) }, { id: 7002, author: 'owner-login', body: 'fix it so', createdAt: ago(2), updatedAt: ago(2) }] }],
      comments: [{ id: 7003, author: 'owner-login', body: 'posted by the pipeline', createdAt: ago(2), updatedAt: ago(2) }],
      reviews: [{ id: 7004, author: 'expert-one', state: 'APPROVED', body: '', submittedAt: ago(1) }],
    },
  };
  const w = world({ cards: Object.values(c), prs, activity });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  const places = (n, state) => [{ id: 'p1', repo: 'api-docs', pr: n, page: 'docs/x.md', line: 3, claim: 'c', why: 'codeOnly', state }];
  ledger(w, c.req, { stages: base, prs: [{ repo: 'api-docs', number: 11, targets: ['api'], review: 'places', stage: 'finalReview' }], places: places(11, 'open') });
  ledger(w, c.settled, { stages: base, prs: [{ repo: 'api-docs', number: 12, targets: ['api'], review: 'places', stage: 'finalReview' }], places: places(12, 'ownerAnswered') });
  ledger(w, c.open, { stages: base, prs: [{ repo: 'api-docs', number: 13, targets: ['api'], review: 'places', stage: 'finalReview' }], places: places(13, 'open') });
  ledger(w, c.commented, { stages: base, prs: [{ repo: 'guide-docs', number: 14, targets: ['guide'], review: 'sme', stage: 'smeReview' }], posted: { card: [], pr: [7003] }, reviewComments: [{ repo: 'guide-docs', pr: 14, id: 7001, updatedAt: ago(4) }] });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.equal(next(by['501']), 'move api-docs#11 -> smeReview');
  assert.equal(by['502'].next, null, 'settled places start nothing');
  assert.equal(by['503'].state, 'finalReview');
  assert.equal(by['503'].counts, null, "the owner's queue counts for nothing");
  assert.equal(by['503'].gate.who, 'owner');
  assert.equal(by['503'].next, null);
  const t = by['504'];
  assert.equal(t.state, 'smeReview');
  assert.equal(t.counts, null, 'SME review counts for nothing');
  assert.equal(next(t), 'answerComments guide-docs#14');
  assert.equal(t.next.comments, 2, 'the edited reviewer comment and the owner instruction; not the pipeline own comment, not an empty verdict');
  assert.equal(t.next.owner, 1);
});

test('row 11: the comments of the owner\'s review not yet submitted are no instruction; once it is submitted they are answered (through the GitHub adapter)', async () => {
  // The forge reads from the owner's login, and GitHub gives a draft review's line comments to its author.
  const c = card({ number: 505, status: 'smeReview' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 7, branch: 'docs/export-screen', targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  const routes = (state) => {
    const threads = fixture('gql-threads');
    threads.data.repository.pullRequest.reviewThreads.nodes = [3, 9].map((line) => ({
      id: `PRRT_${line}`, isResolved: false, isOutdated: false, path: 'docs/a.md', line,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: `PRRC_${600 + line}`, databaseId: 600 + line, author: { __typename: 'User', login: 'owner-login' }, body: `Say it as the app does (${line}).`, createdAt: ago(1), updatedAt: ago(1), path: 'docs/a.md', line, replyTo: null, pullRequestReview: { databaseId: 530, state } }] },
    }));
    const reviews = fixture('gql-reviews');
    reviews.data.repository.pullRequest.reviews.nodes = [];
    const comments = fixture('gql-comments');
    comments.data.repository.pullRequest.comments.nodes = [];
    return { 'graphql PrByNumber': fixture('gql-pr-7'), 'graphql PrReviews': reviews, 'graphql PrThreads': threads, 'graphql PrComments': comments };
  };
  const view = async (state) => (await w.status({ clients: makeClients({ settings: w.settings, io: { trackerAdapter: w.tracker, ghRunner: replayer(routes(state)) } }) })).tickets.find((t) => t.key === '505');
  const pending = await view('PENDING');
  assert.equal(next(pending), null, 'half a review asks nothing yet');
  const sent = await view('COMMENTED');
  assert.equal(next(sent), 'answerComments guide-docs#7');
  assert.deepEqual([sent.next.comments, sent.next.owner], [2, 2]);
});

test('row 12: the first chain stage not done for the head; then ready for merge; row 4: every PR merged closes', async () => {
  const head = 'b'.repeat(40);
  const c = { chain: card({ number: 601, status: 'translation' }), done: card({ number: 602, status: 'translation' }), rfm: card({ number: 603, status: 'finalReview' }), merged: card({ number: 604, status: 'finalReview' }), unmerged: card({ number: 605, status: 'finalReview' }) };
  const prs = [pr({ repo: 'guide-docs', number: 21, headCommit: head }), pr({ repo: 'guide-docs', number: 22, headCommit: head }), pr({ repo: 'guide-docs', number: 23, headCommit: head }), pr({ repo: 'guide-docs', number: 24, state: 'merged' }), pr({ repo: 'guide-docs', number: 25, state: 'closed' })];
  const w = world({ cards: Object.values(c), prs });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  const chain = (n) => Object.fromEntries(['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'].slice(0, n).map((s, i) => [s, { status: 'done', head, seq: 10 + i }]));
  ledger(w, c.chain, { stages: base, prs: [{ repo: 'guide-docs', number: 21, targets: ['guide'], review: 'sme', stage: 'translation', chain: chain(2) }] });
  ledger(w, c.done, { stages: base, prs: [{ repo: 'guide-docs', number: 22, targets: ['guide'], review: 'sme', stage: 'translation', chain: chain(7) }] });
  ledger(w, c.rfm, { stages: base, prs: [{ repo: 'guide-docs', number: 23, targets: ['guide'], review: 'sme', stage: 'readyForMerge', chain: chain(7), readyForMerge: [{ head, at: ago(1) }] }] });
  ledger(w, c.merged, { stages: base, prs: [{ repo: 'guide-docs', number: 24, targets: ['guide'], review: 'sme', stage: 'readyForMerge' }] });
  ledger(w, c.unmerged, { stages: base, prs: [{ repo: 'guide-docs', number: 25, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.equal(next(by['601']), 'locales guide-docs#21');
  assert.equal(by['601'].next.role, 'translator');
  assert.equal(next(by['602']), 'readyForMerge guide-docs#22');
  assert.equal(by['602'].next.role, null, 'no model');
  assert.equal(by['603'].state, 'readyForMerge');
  assert.equal(by['603'].next, null);
  assert.equal(by['603'].gate.who, 'owner');
  assert.equal(by['604'].state, 'merged');
  assert.equal(next(by['604']), 'close');
  assert.equal(by['605'].state, 'outside');
  assert.match(by['605'].notes[0], /closed unmerged/);
});

test('two PRs: the card stands with the slower PR; an approved PR goes on to the owner\'s queue by itself and starts nothing; a question stops only its PR', async () => {
  const c = { two: card({ number: 701, status: 'inProgress' }), asked: card({ number: 702, status: 'blocked' }) };
  const prs = [
    pr({ repo: 'portal-docs', number: 31, head: 'ticket-701-api', labels: ['In progress'] }),
    pr({ repo: 'portal-docs', number: 32, head: 'ticket-701-ui', labels: ['In expert review'], reviewDecision: 'APPROVED' }),
    pr({ repo: 'portal-docs', number: 33, head: 'ticket-702-api', labels: ['In progress'] }),
    pr({ repo: 'portal-docs', number: 34, head: 'ticket-702-ui', labels: ['In expert review'] }),
  ];
  const w = world({ cards: Object.values(c), prs });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  ledger(w, c.two, {
    stages: base,
    prs: [
      { repo: 'portal-docs', number: 31, branch: 'ticket-701-api', targets: ['portal-api'], review: 'places', stage: 'reworkWait' },
      { repo: 'portal-docs', number: 32, branch: 'ticket-701-ui', targets: ['portal-ui'], review: 'sme', stage: 'smeReview' },
    ],
    places: [{ id: 'p1', repo: 'portal-docs', pr: 31, state: 'open' }],
  });
  ledger(w, c.asked, {
    stages: base,
    left: 'blocked',
    prs: [
      { repo: 'portal-docs', number: 33, branch: 'ticket-702-api', targets: ['portal-api'], review: 'places', stage: 'finalReview' },
      { repo: 'portal-docs', number: 34, branch: 'ticket-702-ui', targets: ['portal-ui'], review: 'sme', stage: 'questions', resumeTo: 'smeReview' },
    ],
    places: [],
  });
  const st = await w.status();
  const two = st.tickets.find((t) => t.key === '701');
  assert.equal(two.state, 'reworkWait', 'the ticket is where its least advanced PR is');
  assert.equal(two.card.status, 'inProgress');
  assert.deepEqual(two.steps.map(fmt), ['move portal-docs#32 -> finalReview']);
  assert.equal(two.steps[0].approved, true);
  const asked = st.tickets.find((t) => t.key === '702');
  assert.equal(asked.state, 'questions');
  assert.deepEqual(asked.steps, [], "the other PR waits in the owner's queue while the card is in Blocked");
});

test('row 8: a hand edit before ready for merge is noted and kept; after it, a UA change goes back to the owner\'s queue', async () => {
  const head = 'c'.repeat(40);
  const ready = 'd'.repeat(40);
  const c = { before: card({ number: 801, status: 'translation' }), after: card({ number: 802, status: 'finalReview' }), en: card({ number: 803, status: 'finalReview' }) };
  // UA changed after ready on #42; #43's hand commit left UA alone.
  const git = { branchCommits: () => [head, ready], changedUnder: (t, from, to) => (from === ready && to === head && git.uaPrs.has(t.repo) ? ['docs/a.md'] : []), pagesOf: () => [], uaPrs: new Set(['guide-docs']) };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 41, headCommit: head }), pr({ repo: 'guide-docs', number: 42, headCommit: head }), pr({ repo: 'api-docs', number: 43, headCommit: head })], git });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  const chain = Object.fromEntries(['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'].map((s) => [s, { status: 'done', head: ready }]));
  ledger(w, c.before, { stages: base, prs: [{ repo: 'guide-docs', number: 41, targets: ['guide'], stage: 'translation', pipelineCommits: ['ddddddd'], chain: { translate: { status: 'done', head } } }] });
  ledger(w, c.after, { stages: base, prs: [{ repo: 'guide-docs', number: 42, targets: ['guide'], stage: 'readyForMerge', pipelineCommits: ['ddddddd'], chain, readyForMerge: [{ head: ready, at: ago(3) }] }] });
  ledger(w, c.en, { stages: base, prs: [{ repo: 'api-docs', number: 43, targets: ['api'], stage: 'readyForMerge', pipelineCommits: ['ddddddd'], chain, readyForMerge: [{ head: ready, at: ago(3) }] }] });
  const st = await w.status();
  const before = st.tickets.find((t) => t.key === '801');
  assert.match(before.mismatch[0], /hand edit, kept/);
  assert.equal(next(before), 'enReview guide-docs#41', 'the next stage reads the branch');
  const after = st.tickets.find((t) => t.key === '802');
  assert.deepEqual(after.steps.map(fmt), ['move guide-docs#42 -> finalReview'], 'back to the owner, no re-sync yet');
  assert.equal(after.steps[0].role, null, 'no model step');
  assert.equal(after.steps[0].since, ready);
  assert.deepEqual(st.tickets.find((t) => t.key === '803').steps.map(fmt), ['readyForMerge api-docs#43'], 'a hand commit that left UA alone: ready for its head, no re-sync');
});

test('the card follows the least advanced PR when the pipeline left it elsewhere', async () => {
  const c = card({ number: 901, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 51, labels: ['in progress'] })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 51, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  const t = await w.one('901');
  assert.equal(next(t), 'move -> smeReview');
  assert.equal(t.next.card, true);
});

test('a person moved the card into review or final review: the PRs at the card stage follow, the label too', async () => {
  const c = { fin: card({ number: 911, status: 'finalReview' }), back: card({ number: 912, status: 'inProgress' }) };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 61 }), pr({ repo: 'guide-docs', number: 62 })] });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  ledger(w, c.fin, { stages: base, left: 'smeReview', prs: [{ repo: 'guide-docs', number: 61, targets: ['guide'], stage: 'smeReview' }] });
  ledger(w, c.back, { stages: base, left: 'smeReview', prs: [{ repo: 'guide-docs', number: 62, targets: ['guide'], stage: 'smeReview' }] });
  const st = await w.status();
  const fin = st.tickets.find((t) => t.key === '911');
  assert.equal(fin.state, 'finalReview');
  assert.equal(next(fin), 'follow -> finalReview');
  assert.equal(fin.next.prStage, 'finalReview');
  const back = st.tickets.find((t) => t.key === '912');
  assert.equal(back.state, 'reworkWait');
  assert.equal(next(back), 'follow -> inProgress');
});

test('a failed step waits until a person acts after it: a move, a comment, a PR comment or a hand commit; the pipeline own writes never count', async () => {
  const at = new Date(NOW - 30 * 60000).toISOString();
  const head = '9'.repeat(40);
  const c = {
    waits: card({ number: 951, status: 'inProgress' }),
    commented: card({ number: 952, status: 'inProgress' }),
    posted: card({ number: 953, status: 'inProgress' }),
    held: card({ number: 954, status: 'inProgress' }),
    moved: card({ number: 955, status: 'inProgress' }),
    prComment: card({ number: 956, status: 'smeReview' }),
    prOwn: card({ number: 957, status: 'smeReview' }),
    committed: card({ number: 958, status: 'translation' }),
  };
  const comments = Object.fromEntries(Object.values(c).map((x) => [x.id, [{ id: `own-${x.number}`, text: 'the failed session wrote this' }]]));
  comments[c.commented.id].push({ id: 'person-1', text: 'see the second screen' });
  comments[c.posted.id].push({ id: 'posted-1', text: 'recorded by a later session' });
  const activity = {
    'guide-docs#71': { comments: [{ id: 7101, author: 'owner-login', body: 'the failed session replied', createdAt: at, updatedAt: at }, { id: 7102, author: 'expert-one', body: 'one more thing', createdAt: ago(0.1), updatedAt: ago(0.1) }] },
    'guide-docs#72': { comments: [{ id: 7201, author: 'owner-login', body: 'the failed session replied', createdAt: at, updatedAt: at }] },
  };
  const git = { branchCommits: (t, h) => (h === head ? ['e'.repeat(40), 'f'.repeat(40)] : []), changedUnder: () => [], pagesOf: () => [] };
  const w = world({ cards: Object.values(c), comments, activity, git, prs: [pr({ repo: 'guide-docs', number: 71 }), pr({ repo: 'guide-docs', number: 72 }), pr({ repo: 'guide-docs', number: 73, headCommit: head })] });
  const mark = (x, extra = {}) => ({ at, list: x.placeId, comments: [`own-${x.number}`], prs: {}, ...extra });
  const failedRun = (x, extra = {}, after = mark(x)) => ({ runs: [{ seq: 9, stage: 'answers', outcome: 'failed', failures: 1, start: at, after, ...extra }] });
  const answers = { stages: { start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' };
  ledger(w, c.waits, { ...answers, ...failedRun(c.waits) });
  ledger(w, c.commented, { ...answers, ...failedRun(c.commented) });
  ledger(w, c.posted, { ...answers, ...failedRun(c.posted), posted: { card: ['posted-1'], pr: [] } });
  // A session that ended on a busy browser lock after them changes nothing: still held.
  ledger(w, c.held, { ...answers, runs: [...failedRun(c.held, { failures: 2 }).runs, { seq: 10, stage: 'answers', outcome: 'busy', start: at }] });
  // The card left in Blocked by the failed session's own move would be in the mark; here a person moved it on since.
  ledger(w, c.moved, { ...answers, ...failedRun(c.moved, {}, mark(c.moved, { list: LISTS.blocked.id })) });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  const prMark = (x, n, ids) => mark(x, { prs: { [`guide-docs#${n}`]: { head: 'a'.repeat(40), hand: [], comments: ids } } });
  ledger(w, c.prComment, { stages: base, prs: [{ repo: 'guide-docs', number: 71, targets: ['guide'], review: 'sme', stage: 'smeReview' }], runs: [{ seq: 9, stage: 'answerComments', pr: 'guide-docs#71', outcome: 'failed', failures: 1, start: at, after: prMark(c.prComment, 71, ['7101']) }] });
  ledger(w, c.prOwn, { stages: base, prs: [{ repo: 'guide-docs', number: 72, targets: ['guide'], review: 'sme', stage: 'smeReview' }], runs: [{ seq: 9, stage: 'answerComments', pr: 'guide-docs#72', outcome: 'failed', failures: 1, start: at, after: prMark(c.prOwn, 72, ['7201']) }] });
  // The failed session pushed e…e without recording it: in the mark. f…f came after: a hand commit.
  ledger(w, c.committed, { stages: base, prs: [{ repo: 'guide-docs', number: 73, targets: ['guide'], review: 'sme', stage: 'translation' }], runs: [{ seq: 9, stage: 'translate', pr: 'guide-docs#73', outcome: 'failed', failures: 1, start: at, after: mark(c.committed, { prs: { 'guide-docs#73': { head, hand: ['e'.repeat(40)], comments: [] } } }) }] });
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  const waits = (k) => [next(by[k]), Boolean(by[k].next?.waits), by[k].failed?.acted ?? null];
  assert.deepEqual(waits('951'), ['answers', true, null], 'its own comment is in the mark: it waits for the morning run');
  assert.equal(by['951'].next.prior, 1);
  assert.deepEqual(waits('952'), ['answers', false, 'a person commented on the card']);
  assert.deepEqual(waits('953'), ['answers', true, null], 'a comment in posted is the pipeline own');
  assert.deepEqual([by['954'].next, by['954'].held, by['954'].gate.who], [null, true, 'owner'], 'two failed sessions in a row: held for the owner');
  assert.match(by['954'].gate.why, /answers failed in 2 sessions .* gives it one more try/);
  assert.deepEqual(waits('955'), ['answers', false, 'a person moved the card']);
  assert.deepEqual(waits('956'), ['answerComments guide-docs#71', false, 'a comment or review on guide-docs#71']);
  assert.deepEqual(waits('957'), ['answerComments guide-docs#72', true, null], 'the failed session own reply is in the mark');
  assert.deepEqual(waits('958'), ['translate guide-docs#73', false, 'a commit on guide-docs#73']);

  assert.match(by['954'].gate.why, /a comment on the card or the PR gives it one more try .*`ticket-state set retry 954`/);

  // `set retry 954` after the failure re-arms that ticket only; `set retry all`, every one.
  fs.mkdirSync(w.settings.state, { recursive: true });
  fs.writeFileSync(path.join(w.settings.state, 'rearmed.json'), JSON.stringify({ all: null, tickets: { 954: new Date(NOW - 60000).toISOString() } }));
  const again = Object.fromEntries((await w.status()).tickets.map((t) => [t.key, t]));
  assert.deepEqual([next(again['954']), again['954'].failed.acted], ['answers', 'the owner re-armed it with `ticket-state set retry`']);
  assert.ok(again['951'].next.waits, 'another ticket is not re-armed');
  fs.writeFileSync(path.join(w.settings.state, 'rearmed.json'), JSON.stringify({ all: new Date(NOW - 60000).toISOString(), tickets: {} }));
  assert.equal(Object.fromEntries((await w.status()).tickets.map((t) => [t.key, t]))['951'].next.waits, undefined);

  // A held card moved to a list never read: its comments can't be read, and status still answers for every ticket.
  c.held.placeId = LISTS.drafts.id;
  fs.rmSync(path.join(w.settings.state, 'rearmed.json'));
  const parked = Object.fromEntries((await w.status()).tickets.map((t) => [t.key, t]));
  assert.deepEqual([parked['954'].held, next(parked['954'])], [undefined, 'follow -> drafts'], 'the move is a person\'s: the ticket follows it');
  assert.deepEqual([next(parked['951']), parked['951'].next.waits !== undefined], ['answers', true]);
});

test('a failed step: a move of the card there and back is a person acting, seen in the card own moves', async () => {
  const at = new Date(NOW - 30 * 60000).toISOString();
  const c = { back: card({ number: 961, status: 'inProgress' }), still: card({ number: 962, status: 'inProgress' }) };
  const moved = (t) => ({ time: t, from: { id: LISTS.inProgress.id, name: 'Doing' }, to: { id: LISTS.blocked.id, name: 'Blocked' } });
  // Both cards were last moved before the failure; one went to Blocked and back after it.
  c.back.moves = [moved(ago(2)), moved(ago(0.3)), moved(ago(0.2))];
  c.still.moves = [moved(ago(2))];
  const w = world({ cards: Object.values(c) });
  for (const x of Object.values(c)) ledger(w, x, { stages: { start: 'done', plan: 'done', questions: 'done' }, left: 'blocked', runs: [{ seq: 9, stage: 'answers', outcome: 'failed', failures: 2, start: at, after: { at, list: x.placeId, lastMove: ago(2), comments: [], prs: {} } }] });
  const st = Object.fromEntries((await w.status()).tickets.map((t) => [t.key, t]));
  assert.deepEqual([next(st['961']), st['961'].failed.acted], ['answers', 'a person moved the card']);
  assert.deepEqual([st['962'].next, st['962'].held], [null, true]);
});
