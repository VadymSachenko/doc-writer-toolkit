import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTS, MEMBERS, NOW, ago, card, pr, rawSettings } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { briefFor, runDaily, scriptedCalls } from '../lib/runner.mjs';
import { renderReport } from '../lib/report.mjs';
import { runRecord } from '../lib/record.mjs';
import { runHandover } from '../lib/handover.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { parseReply, resolveReply, suggestionOf } from '../lib/edits.mjs';

// No chain stage runs before a person moved the card to the translation status, on every path. `finalReview` is the
// owner's queue and starts nothing; the chain's end takes the card back there and says so on the card.

const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];
const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const fmt = (s) => `${s.stage}${s.pr ? ` ${s.pr}` : ''}${s.to ? ` -> ${s.to}` : ''}`;
const steps = (t) => t.steps.map(fmt);
const chainDone = (head = HEAD, n = 7) => Object.fromEntries(CHAIN.slice(0, n).map((s, i) => [s, { status: 'done', head, seq: 10 + i }]));
const modelSteps = (t) => t.steps.filter((s) => s.role);
const moved = (c, status) => {
  c.placeId = LISTS[status].id;
};
const run = (w, spawnClaude, options = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] }), spawnClaude }, options: { morning: false, trigger: 'watch', ...options } });
const noSession = async () => {
  throw new Error('a session started');
};

test('a places PR goes to the owner\'s queue after the pr stage, with places and with none, and starts nothing', async () => {
  for (const places of [[{ id: 'p1', repo: 'api-docs', pr: 11, page: 'docs/a.md', line: 3, claim: 'c', why: 'codeOnly', source: 'code', refs: [{ repo: 'code', path: 'a.go', lines: '1-2', commit: 'abc' }] }], []]) {
    const c = card({ number: 501, status: 'inProgress' });
    const w = world({ cards: [c], prs: [pr({ repo: 'api-docs', number: 11, head: 'ticket-11', labels: ['In progress'] })] });
    ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [{ repo: 'api-docs', branch: 'ticket-11', targets: ['api'], review: 'places', number: undefined }] });
    await runRecord({ settings: w.settings, clients: w.clients(), key: '501', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-11', number: 11, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }], places }, now: NOW });
    assert.equal(read(w, '501').prs[0].stage, 'finalReview');
    const t = await w.one('501');
    assert.deepEqual(steps(t), ['move -> finalReview'], 'the card follows; no chain stage');
    moved(c, 'finalReview');
    const l = read(w, '501');
    l.left = { status: 'finalReview', list: LISTS.finalReview };
    ledger(w, c, { stages: BASE, prs: l.prs, places: l.places });
    const after = await w.one('501');
    assert.equal(after.state, 'finalReview');
    assert.deepEqual(after.steps, [], 'it waits for the owner');
    assert.equal(after.gate.who, 'owner');
  }
});

test('a reviewer\'s move after the approval lands in the owner\'s queue and starts nothing; the move to In translation starts the chain and approves', async () => {
  const c = card({ number: 502, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 12, headCommit: HEAD, labels: ['in expert review'] });
  const w = world({ cards: [c], prs: [forgePr] });
  ledger(w, c, { stages: BASE, left: 'smeReview', prs: [{ repo: 'guide-docs', number: 12, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  let t = await w.one('502');
  assert.deepEqual(steps(t), ['follow -> finalReview']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '502', stage: 'follow', status: 'done', to: 'finalReview', now: NOW });
  assert.equal(read(w, '502').prs[0].stage, 'finalReview');
  assert.equal(read(w, '502').prs[0].approval ?? null, null, 'a review\'s move is no UA approve');
  t = await w.one('502');
  assert.deepEqual(t.steps, []);

  moved(c, 'translation');
  t = await w.one('502');
  assert.equal(t.state, 'translation');
  assert.deepEqual(steps(t), ['follow -> translation']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '502', stage: 'follow', status: 'done', to: 'translation', now: NOW });
  const p = read(w, '502').prs[0];
  assert.deepEqual([p.stage, p.approval.head, p.approval.by], ['translation', HEAD, 'person']);
  t = await w.one('502');
  assert.deepEqual(steps(t), ['translate guide-docs#12']);
});

test('comments come first in the owner\'s queue and start no chain stage; a pending reviewer the move back took along doesn\'t move it back', async () => {
  const c = card({ number: 503, status: 'finalReview' });
  const w = world({
    cards: [c],
    prs: [pr({ repo: 'guide-docs', number: 13, headCommit: HEAD, reviewRequests: ['expert-one'] })],
    activity: { 'guide-docs#13': { comments: [{ id: 901, author: 'owner-login', body: 'fix this', createdAt: ago(1), updatedAt: ago(1) }] } },
  });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 13, targets: ['guide'], review: 'sme', stage: 'finalReview', reviewersRequested: ['expert-one'] }] });
  const t = await w.one('503');
  assert.deepEqual(steps(t), ['answerComments guide-docs#13']);
});

test('row 9: a reviewer requested from the owner\'s queue moves a places PR to review; moved back by a person, the same request doesn\'t move it again', async () => {
  const c = card({ number: 504, status: 'finalReview' });
  const forgePr = pr({ repo: 'api-docs', number: 14, headCommit: HEAD, reviewRequests: ['expert-two'], labels: ['In tech review'] });
  const w = world({ cards: [c], prs: [forgePr] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'api-docs', number: 14, targets: ['api'], review: 'places', stage: 'finalReview' }] });
  const out = await run(w, noSession, { named: ['504'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.to, r.outcome]), [['move', 'smeReview', 'done']]);
  assert.equal(c.placeId, LISTS.smeReview.id);
  assert.deepEqual(read(w, '504').prs[0].reviewersRequested, ['expert-two']);
  moved(c, 'finalReview');
  await runRecord({ settings: w.settings, clients: w.clients(), key: '504', stage: 'follow', status: 'done', to: 'finalReview', now: NOW });
  const t = await w.one('504');
  assert.deepEqual(t.steps, [], 'a person chose this; the old request stays quiet');
});

test('two PRs: the approved sme half lands in the queue while the card stands with the slower one; both wait for the card; the move takes both', async () => {
  const c = card({ number: 505, status: 'smeReview' });
  const prs = [pr({ repo: 'portal-docs', number: 21, head: 'a', headCommit: HEAD, labels: ['In final review'] }), pr({ repo: 'portal-docs', number: 22, head: 'b', headCommit: HEAD, labels: ['In expert review'], reviewDecision: 'APPROVED' })];
  const w = world({ cards: [c], prs });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'portal-docs', number: 21, branch: 'a', targets: ['portal-api'], review: 'places', stage: 'finalReview' }, { repo: 'portal-docs', number: 22, branch: 'b', targets: ['portal-ui'], review: 'sme', stage: 'smeReview' }] });
  let t = await w.one('505');
  assert.deepEqual(t.steps, [], 'neither goes on: the places half waits for the card too');

  // The card goes straight from review to In translation: one card approves the whole ticket.
  moved(c, 'translation');
  t = await w.one('505');
  assert.deepEqual(steps(t), ['follow -> translation']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '505', stage: 'follow', status: 'done', to: 'translation', now: NOW });
  assert.deepEqual(read(w, '505').prs.map((p) => p.stage), ['translation', 'translation']);
  t = await w.one('505');
  assert.deepEqual(steps(t), ['translate portal-docs#21', 'translate portal-docs#22']);
});

test('two PRs, an sme half approved while the other PR is slower: it lands in the queue and starts nothing', async () => {
  const c = card({ number: 506, status: 'inProgress' });
  const prs = [pr({ repo: 'portal-docs', number: 23, head: 'a', headCommit: HEAD, labels: ['In progress'] }), pr({ repo: 'portal-docs', number: 24, head: 'b', headCommit: HEAD, labels: ['In final review'], reviewDecision: 'APPROVED' })];
  const w = world({ cards: [c], prs });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'portal-docs', number: 23, branch: 'a', targets: ['portal-api'], review: 'places', stage: 'reworkWait' }, { repo: 'portal-docs', number: 24, branch: 'b', targets: ['portal-ui'], review: 'sme', stage: 'smeReview' }] });
  const out = await run(w, noSession, { named: ['506'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.pr, r.to]), [['move', 'portal-docs#24', 'finalReview']]);
  const l = read(w, '506');
  assert.deepEqual(l.prs.map((p) => p.stage), ['reworkWait', 'finalReview']);
  assert.equal(c.placeId, LISTS.inProgress.id, 'the card stands with the slower PR');
  assert.equal(l.prs[1].approval ?? null, null);
});

test('a PR with two cards: moving either is the approve, and the other card comes along; moving it back takes both back', async () => {
  const a = card({ number: 507, status: 'finalReview' });
  const b = card({ number: 508, status: 'finalReview' });
  const w = world({ cards: [a, b], prs: [pr({ repo: 'guide-docs', number: 31, headCommit: HEAD, labels: ['In final review', 'in expert review'] })] });
  for (const c of [a, b]) ledger(w, c, { stages: BASE, group: '507-508', prs: [{ repo: 'guide-docs', number: 31, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  moved(a, 'translation');
  // Only the moved card's ledger follows. The first chain step is the proof the other came along before it.
  let seen = null;
  const spawnClaude = async () => {
    seen = [b.placeId, read(w, '508').prs[0].stage];
    return { code: 1, stdout: '', stderr: 'stop here' };
  };
  await run(w, spawnClaude, { named: ['507', '508'] });
  assert.deepEqual(seen, [LISTS.translation.id, 'translation']);
  assert.equal(read(w, '508').prs[0].approval.by, 'person');
  assert.equal(read(w, '507').prs[0].approval.by, 'person');
  assert.equal(read(w, '508').left.status, 'translation');

  // A person moves the second card back: both stop.
  moved(b, 'finalReview');
  await run(w, noSession, { named: ['507', '508'] });
  assert.equal(a.placeId, LISTS.finalReview.id);
  assert.deepEqual([read(w, '507').prs[0].stage, read(w, '508').prs[0].stage], ['finalReview', 'finalReview']);
});

test('a PR with two cards: a move to In translation from review, from rework and from Blocked takes the other card along', async () => {
  for (const [status, stage, n] of [['smeReview', 'smeReview', 0], ['inProgress', 'reworkWait', 1], ['blocked', 'questions', 2]]) {
    const a = card({ number: 520 + 2 * n, status });
    const b = card({ number: 521 + 2 * n, status });
    const w = world({ cards: [a, b], prs: [pr({ repo: 'guide-docs', number: 50 + n, headCommit: HEAD })] });
    for (const c of [a, b]) ledger(w, c, { stages: BASE, group: `${a.number}-${b.number}`, prs: [{ repo: 'guide-docs', number: 50 + n, targets: ['guide'], review: 'sme', stage }] });
    moved(a, 'translation');
    let seen = null;
    await run(w, async () => {
      seen = [b.placeId, read(w, String(b.number)).prs[0].stage];
      return { code: 1, stdout: '', stderr: 'stop here' };
    }, { named: [String(a.number), String(b.number)] });
    assert.deepEqual(seen, [LISTS.translation.id, 'translation'], `from ${status}`);
    assert.equal(read(w, String(a.number)).prs[0].stage, 'translation', `from ${status}`);
  }
});

test('half an approve can\'t happen: a move to In translation from Blocked takes every open PR below ready, and the card stays', async () => {
  const c = card({ number: 530, status: 'blocked' });
  const prs = [pr({ repo: 'guide-docs', number: 60, head: 'a', headCommit: HEAD }), pr({ repo: 'api-docs', number: 61, head: 'b', headCommit: HEAD }), pr({ repo: 'api-docs', number: 62, head: 'c', headCommit: HEAD })];
  const w = world({ cards: [c], prs });
  const ready = [{ head: HEAD, at: ago(5) }];
  ledger(w, c, { stages: BASE, prs: [
    { repo: 'guide-docs', number: 60, branch: 'a', targets: ['guide'], review: 'sme', stage: 'questions' },
    { repo: 'api-docs', number: 61, branch: 'b', targets: ['api'], review: 'places', stage: 'smeReview' },
    { repo: 'api-docs', number: 62, branch: 'c', targets: ['api'], review: 'places', stage: 'readyForMerge', chain: chainDone(), readyForMerge: ready },
  ] });
  moved(c, 'translation');
  assert.deepEqual(steps(await w.one('530')), ['follow -> translation']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '530', stage: 'follow', status: 'done', to: 'translation', now: NOW });
  const l = read(w, '530');
  assert.deepEqual(l.prs.map((p) => p.stage), ['translation', 'translation', 'readyForMerge'], 'a ready one stays');
  assert.deepEqual(l.prs.map((p) => p.approval?.by ?? null), ['person', 'person', null]);
  const t = await w.one('530');
  assert.ok(!t.steps.some((s) => s.stage === 'move'), `the card isn't pulled back while the chain runs: ${steps(t)}`);
  assert.deepEqual(steps(t), ['translate guide-docs#60', 'translate api-docs#61']);
});

test('a PR with no number yet isn\'t taken by the move to In translation, and the card goes back to it', async () => {
  const c = card({ number: 531, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 63, head: 'a', headCommit: HEAD })] });
  ledger(w, c, { stages: BASE, prs: [
    { repo: 'guide-docs', number: 63, branch: 'a', targets: ['guide'], review: 'sme', stage: 'smeReview' },
    { repo: 'api-docs', branch: 'd', targets: ['api'], review: 'places', stage: 'writing' },
  ] });
  moved(c, 'translation');
  await runRecord({ settings: w.settings, clients: w.clients(), key: '531', stage: 'follow', status: 'done', to: 'translation', now: NOW });
  const l = read(w, '531');
  assert.deepEqual(l.prs.map((p) => [p.stage, p.approval?.by ?? null]), [['translation', 'person'], ['writing', null]]);
  assert.ok(steps(await w.one('531')).includes('move -> inProgress'), 'the half not written yet holds the card');
});

test('a ledger at finalReview from before the change waits for a person\'s move, a half-run chain and a stage left running too', async () => {
  const c = { half: card({ number: 509, status: 'finalReview' }), running: card({ number: 510, status: 'finalReview' }) };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 32, headCommit: HEAD }), pr({ repo: 'guide-docs', number: 33, headCommit: HEAD })] });
  ledger(w, c.half, { stages: BASE, prs: [{ repo: 'guide-docs', number: 32, targets: ['guide'], review: 'sme', stage: 'finalReview', chain: chainDone(HEAD, 3), approval: { head: HEAD, at: ago(30) } }] });
  ledger(w, c.running, { stages: BASE, prs: [{ repo: 'guide-docs', number: 33, targets: ['guide'], review: 'sme', stage: 'finalReview', chain: { translate: { status: 'running', head: HEAD } } }] });
  for (const key of ['509', '510']) {
    const t = await w.one(key);
    assert.deepEqual(t.steps, [], `${key} starts nothing`);
    assert.equal(t.state, 'finalReview');
  }
  moved(c.half, 'translation');
  const t = await w.one('509');
  assert.deepEqual(steps(t), ['follow -> translation']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '509', stage: 'follow', status: 'done', to: 'translation', now: NOW });
  assert.deepEqual(steps(await w.one('509')), ['align guide-docs#32'], 'it goes on from where it stopped');
});

test('an older ledger at placesWait reads as the owner\'s queue', async () => {
  const c = card({ number: 511, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'api-docs', number: 34, headCommit: HEAD })] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'api-docs', number: 34, targets: ['api'], review: 'places', stage: 'placesWait' }] });
  const t = await w.one('511');
  assert.equal(t.state, 'finalReview');
  assert.deepEqual(steps(t), ['move -> finalReview']);
});

test('moving the card back from In translation stops the chain between steps', async () => {
  const c = card({ number: 513, status: 'translation' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 36, headCommit: HEAD, labels: ['In final review'] })] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 36, targets: ['guide'], review: 'sme', stage: 'translation' }] });
  const stages = [];
  const spawnClaude = async () => {
    stages.push('session');
    // The session does its stage; while it works, a person moves the card back.
    await runRecord({ settings: w.settings, clients: w.clients(), key: '513', stage: 'translate', status: 'done', pr: 'guide-docs#36', head: HEAD, now: NOW });
    moved(c, 'finalReview');
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = await run(w, spawnClaude, { named: ['513'] });
  assert.equal(stages.length, 1, 'one session, no next stage');
  assert.deepEqual(out.ran.map((r) => r.stage), ['translate', 'follow']);
  const l = read(w, '513');
  assert.equal(l.prs[0].stage, 'finalReview');
  assert.equal(l.prs[0].chain.translate.status, 'done');
  assert.deepEqual((await w.one('513')).steps, []);
});

test('a question during the chain: the answer brings the PR back to the owner\'s queue, not into the chain', async () => {
  const c = card({ number: 514, status: 'blocked' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 37, headCommit: HEAD })] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 37, targets: ['guide'], review: 'sme', stage: 'translation' }] });
  await runRecord({ settings: w.settings, clients: w.clients(), key: '514', stage: 'questions', status: 'done', pr: 'guide-docs#37', result: { questions: [{ id: 'q1', text: 't' }] }, now: NOW });
  moved(c, 'inProgress');
  await runRecord({ settings: w.settings, clients: w.clients(), key: '514', stage: 'answers', status: 'done', pr: 'guide-docs#37', result: {}, now: NOW });
  assert.equal(read(w, '514').prs[0].stage, 'finalReview');
  assert.deepEqual(steps(await w.one('514')), ['move -> finalReview']);
});

test('a UA change after ready for merge goes back to the owner\'s queue, whoever made it, with no model step; an id-only one keeps the PR ready', async () => {
  const old = 'a'.repeat(40);
  const c = { words: card({ number: 515, status: 'finalReview' }), ids: card({ number: 516, status: 'finalReview' }), en: card({ number: 517, status: 'finalReview' }) };
  const changed = { [HEAD]: ['docs/a.md'] };
  const git = { branchCommits: () => [], changedUnder: (t, from, to) => (t.repo === 'guide-docs' && changed[to] ? changed[to] : []), pagesOf: () => [] };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 41, headCommit: HEAD, labels: ['In final review'] }), pr({ repo: 'api-docs', number: 42, headCommit: HEAD }), pr({ repo: 'api-docs', number: 43, headCommit: HEAD })], git });
  const answered = (n, repo, targets) => ({ stages: BASE, prs: [{ repo, number: n, targets, review: 'places', stage: 'readyForMerge', pipelineCommits: ['b'], chain: chainDone(old), readyForMerge: [{ head: old, at: ago(5) }] }] });
  ledger(w, c.words, answered(41, 'guide-docs', ['guide']));
  ledger(w, c.ids, answered(42, 'api-docs', ['api']));
  ledger(w, c.en, answered(43, 'api-docs', ['api']));
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.deepEqual(steps(by['515']), ['move guide-docs#41 -> finalReview'], "the pipeline's own commit, UA changed: the owner reads it first");
  assert.deepEqual(modelSteps(by['515']), [], "nothing is translated before the owner's move");
  assert.deepEqual(by['516'].steps, [], 'an id-only change keeps it ready');
  assert.deepEqual(by['517'].steps, [], 'UA untouched');
  // The move itself: the PR in the owner's queue, the card where it is, the ready head kept for the re-sync.
  await runRecord({ settings: w.settings, clients: w.clients(), key: '515', stage: 'move', status: 'done', pr: 'guide-docs#41', to: 'finalReview', now: NOW });
  const l = read(w, '515');
  assert.equal(l.prs[0].stage, 'finalReview');
  assert.deepEqual(l.prs[0].readyForMerge.map((r) => r.head), [old]);
  const t = await w.one('515');
  assert.deepEqual(t.steps, [], 'it waits for the owner');
  assert.equal(t.state, 'finalReview');
});

test('the owner\'s move to In translation after a UA change at ready for merge re-syncs the whole range since the ready head, once, then ready', async () => {
  const old = 'a'.repeat(40);
  const c = { words: card({ number: 561, status: 'translation' }), synced: card({ number: 562, status: 'translation' }), ids: card({ number: 563, status: 'translation' }) };
  const git = { branchCommits: () => [], changedUnder: (t, from, to) => (t.repo === 'guide-docs' && from === old && to === HEAD ? ['docs/a.md', 'docs/b.md'] : []), pagesOf: () => [] };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 47, headCommit: HEAD }), pr({ repo: 'guide-docs', number: 48, headCommit: HEAD }), pr({ repo: 'api-docs', number: 49, headCommit: HEAD })], git });
  const back = (n, repo, targets, extra = {}) => ({ stages: BASE, prs: [{ repo, number: n, targets, review: 'places', stage: 'translation', pipelineCommits: ['b'], chain: chainDone(old), readyForMerge: [{ head: old, at: ago(5) }], ...extra }] });
  ledger(w, c.words, back(47, 'guide-docs', ['guide']));
  ledger(w, c.synced, back(48, 'guide-docs', ['guide'], { steps: { resync: { status: 'done', head: HEAD } } }));
  ledger(w, c.ids, back(49, 'api-docs', ['api']));
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.deepEqual(steps(by['561']), ['resync guide-docs#47'], 'one re-sync, not the chain again');
  const resync = by['561'].steps[0];
  assert.equal(resync.since, old, 'the step names the ready head');
  assert.equal(resync.head, HEAD);
  assert.ok(briefFor({ ...resync, role: 'translator', keys: ['561'] }, w.settings).includes(`re-sync the blocks changed in ${old}..${HEAD}, the whole range at once.`));
  assert.deepEqual(steps(by['562']), ['readyForMerge guide-docs#48'], 'synced: ready for the new head');
  assert.deepEqual(steps(by['563']), ['readyForMerge api-docs#49'], 'nothing in UA to re-sync: ready, no session');
});

test('a handover of a card in the owner\'s queue starts nothing', async () => {
  const c = card({ number: 519, status: 'finalReview', labels: ['Guide'] });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 45, headCommit: HEAD })], comments: { [c.id]: [{ id: 'k', text: 'PR: https://github.com/example-owner/guide-docs/pull/45' }] } });
  ledger(w, c, { stages: BASE, mode: 'hand', prs: [{ repo: 'guide-docs', number: 45, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  await runHandover({ settings: w.settings, clients: w.clients(), key: '519', now: NOW });
  const t = await w.one('519');
  assert.equal(t.mode, 'pipeline');
  assert.deepEqual(t.steps, []);
});

test('a place from the code with no reference: the record stands, the session is told, and status reports it; a reference at a commit passes', async () => {
  const c = card({ number: 520, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'api-docs', number: 46, head: 'ticket-46', headCommit: HEAD, labels: ['In progress'] })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [{ repo: 'api-docs', branch: 'ticket-46', targets: ['api'], review: 'places' }] });
  const ref = { repo: 'code-repo', path: 'services/a.go', lines: '10-20', commit: 'c0ffee', url: 'https://code.example/blob/c0ffee/services/a.go#L10-L20' };
  const place = (id, extra) => ({ id, repo: 'api-docs', pr: 46, page: 'docs/a.md', line: 3, claim: 'c', source: 'code', reason: 'the change named it', ...extra });
  const r = await runRecord({ settings: w.settings, clients: w.clients(), key: '520', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-46', number: 46, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }], places: [place('p1', { refs: [ref] }), place('p2', {}), place('p3', { refs: [{ repo: 'code-repo', path: 'a.go' }] })] }, now: NOW });
  assert.equal(r.warnings.length, 2);
  const l = read(w, '520');
  assert.deepEqual(l.places.map((p) => [p.id, Boolean(p.noRef)]), [['p1', false], ['p2', true], ['p3', true]]);
  assert.deepEqual(l.places[0].refs, [ref]);
  assert.equal(l.places[0].reason, 'the change named it');
  const t = await w.one('520');
  assert.match(t.mismatch.join('; '), /2 place\(s\) from the code with no reference at a commit: p2, p3/);
});

// ------------------------------------------------------------------ the owner first; the expert on the owner's call

// The people on the board: the owner, and each target's card members next to its reviewers.
const PEOPLE = (() => {
  const r = rawSettings();
  return { tracker: { ...r.tracker, owner: 'owner-one' }, forge: { ...r.forge, expertLabel: 'Expert advised' }, targets: r.targets.map((t) => ({ ...t, cardMembers: t.reviewers[0] === 'expert-one' ? ['expert-one'] : ['@expert-two'] })) };
})();
const added = (w) => w.tracker.log.filter((e) => e[0] === 'addMember').map((e) => [e[1], MEMBERS.find((m) => m.id === e[2]).username]);
const asked = (w) => w.forge.log.filter((e) => e[0] === 'requestReviewers').map((e) => [e[1].number, e[1].logins]);
const ran = (out) => out.ran.map((r) => [r.stage, r.to, r.outcome]);

test('owner first: a sme PR opens with no reviewer and lands in the owner\'s queue with its final review label; no expert is asked or added; the report names the recommendation', async () => {
  const c = card({ number: 530, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 31, head: 'ticket-31', labels: ['in progress'] })], extra: PEOPLE });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-31', targets: ['guide'], review: 'sme', number: undefined }] });
  await runRecord({ settings: w.settings, clients: w.clients(), key: '530', stage: 'pr', status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-31', number: 31, expertReview: { recommended: true, why: 'one open question for the expert: the daily limit' } }] }, now: NOW });
  assert.equal(read(w, '530').prs[0].stage, 'finalReview');
  const out = await run(w, noSession, { named: ['530'] });
  assert.deepEqual(ran(out), [['move', 'finalReview', 'done']]);
  assert.equal(c.placeId, LISTS.finalReview.id);
  assert.deepEqual(w.forge.prs[0].labels, ['Expert advised', 'In final review'], 'the stage label, and the expert label the recommendation put on');
  assert.deepEqual(w.forge.prs[0].reviewRequests, [], 'no review request');
  assert.deepEqual([asked(w), added(w)], [[], []], 'no expert asked or added');
  const st = await w.status();
  const t = st.tickets.find((x) => x.key === '530');
  assert.deepEqual([t.state, t.steps, t.gate.who], ['finalReview', [], 'owner']);
  assert.deepEqual(t.prs[0].expertReview.recommended, true);
  const report = renderReport({ settings: w.settings, st, date: '2026-11-10' });
  assert.match(report, /## Expert review, your call\n\n- \[guide-docs#31\]\(\S+\) \(\[530\]\(\S+\)\): an expert review is recommended: one open question for the expert: the daily limit/);
});

test('the owner\'s move to the review calls each PR\'s own expert (reviewer, review label, card member); a move back removes nobody; a second move adds nothing twice', async () => {
  const c = card({ number: 531, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 32, headCommit: HEAD, labels: ['In final review'] }), pr({ repo: 'api-docs', number: 33, headCommit: HEAD, labels: ['In final review'] })], extra: PEOPLE });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 32, targets: ['guide'], review: 'sme', stage: 'finalReview' }, { repo: 'api-docs', number: 33, targets: ['api'], review: 'places', stage: 'finalReview' }] });
  moved(c, 'smeReview');
  assert.deepEqual(steps(await w.one('531')), ['follow -> smeReview']);
  assert.deepEqual(scriptedCalls({ stage: 'follow', to: 'smeReview', keys: ['531'] }, read(w, '531'), w.settings).filter((x) => !x.startsWith('forge set-stage-label')), [
    'forge request-reviewers --repo guide-docs --number 32 --reviewer expert-one',
    'forge request-reviewers --repo api-docs --number 33 --reviewer expert-two',
    `tracker add-member ${c.shortLink} --member expert-one`,
    `tracker add-member ${c.shortLink} --member expert-two`,
  ]);
  assert.deepEqual(ran(await run(w, noSession, { named: ['531'] })), [['follow', 'smeReview', 'done']]);
  assert.deepEqual(asked(w), [[32, ['expert-one']], [33, ['expert-two']]], 'each PR its own target\'s reviewer');
  assert.deepEqual(w.forge.prs.map((p) => p.labels), [['in expert review'], ['In tech review']]);
  assert.deepEqual(added(w), [[c.id, 'expert-one'], [c.id, 'expert-two']]);
  assert.deepEqual(read(w, '531').prs.map((p) => [p.stage, p.reviewersRequested]), [['smeReview', ['expert-one']], ['smeReview', ['expert-two']]]);
  let t = await w.one('531');
  assert.deepEqual([t.state, t.steps], ['smeReview', []]);

  // Back to the owner's queue before the experts answered: nobody is removed, and the pending requests move nothing.
  moved(c, 'finalReview');
  assert.deepEqual(ran(await run(w, noSession, { named: ['531'] })), [['follow', 'finalReview', 'done']]);
  assert.deepEqual(w.forge.prs.map((p) => p.reviewRequests.map((r) => r.login)), [['expert-one'], ['expert-two']], 'no request removed');
  assert.deepEqual(c.memberIds.map((id) => MEMBERS.find((m) => m.id === id).username), ['expert-one', 'expert-two'], 'no one removed from the card');
  assert.ok(!w.forge.log.some((e) => e[0] === 'updatePr'), 'no PR edit');
  t = await w.one('531');
  assert.deepEqual([t.state, t.steps], ['finalReview', []]);

  // The owner's second call: the reviewers already asked and the members already on the card are left as they are.
  moved(c, 'smeReview');
  assert.deepEqual(ran(await run(w, noSession, { named: ['531'] })), [['follow', 'smeReview', 'done']]);
  assert.equal(asked(w).length, 2, 'not asked twice');
  assert.equal(added(w).length, 2, 'not added twice');
});

test('row 9 for every review kind: a reviewer a person requested on a sme PR in the owner\'s queue moves the card and adds the card member; the pipeline asks no one itself', async () => {
  const c = card({ number: 532, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 34, headCommit: HEAD, reviewRequests: ['expert-one'], labels: ['In final review'] })], extra: PEOPLE });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 34, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  assert.deepEqual(steps(await w.one('532')), ['move guide-docs#34 -> smeReview']);
  assert.deepEqual(ran(await run(w, noSession, { named: ['532'] })), [['move', 'smeReview', 'done']]);
  assert.equal(c.placeId, LISTS.smeReview.id);
  assert.deepEqual(w.forge.prs[0].labels, ['in expert review']);
  assert.deepEqual([asked(w), added(w)], [[], [[c.id, 'expert-one']]]);
  assert.deepEqual(read(w, '532').prs[0].reviewersRequested, ['expert-one']);
});

test('a ledger at the review from before the owner-first rule reads as it did; the move back takes its pending request along', async () => {
  const c = card({ number: 533, status: 'smeReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 35, headCommit: HEAD, reviewRequests: ['expert-one'], labels: ['in expert review'] })], extra: PEOPLE });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 35, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  let t = await w.one('533');
  assert.deepEqual([t.state, t.steps], ['smeReview', []]);
  moved(c, 'finalReview');
  assert.deepEqual(ran(await run(w, noSession, { named: ['533'] })), [['follow', 'finalReview', 'done']]);
  assert.deepEqual(read(w, '533').prs[0].reviewersRequested, ['expert-one']);
  t = await w.one('533');
  assert.deepEqual([t.state, t.steps], ['finalReview', []], 'no move back to the review');
  assert.deepEqual([asked(w), added(w)], [[], []]);
});

test('triage into the ready status: the record adds the owner to the card, once; a card already carrying the owner is unchanged; a failure is a warning', async () => {
  const bare = card({ number: 534, status: 'ready', labels: ['Guide'] });
  const has = card({ number: 535, status: 'ready', labels: ['Guide'], members: ['owner-one'] });
  const byHand = card({ number: 537, status: 'ready', labels: ['Guide'] });
  const failing = card({ number: 538, status: 'ready', labels: ['Guide'] });
  const w = world({ cards: [bare, has, byHand, failing], extra: PEOPLE });
  const triage = (c, result = { verdict: 'docs-required', movedTo: 'ready', targets: ['guide'], size: 'edit' }) => runRecord({ settings: w.settings, clients: w.clients(), key: String(c.number), stage: 'triage', status: 'done', card: c.shortLink, result, now: NOW });
  const r = await triage(bare);
  assert.equal(r.warnings, undefined);
  await triage(has);
  // A card the owner put in the ready status by hand (no move by the triage) is neither refused nor touched.
  await triage(byHand, { verdict: 'owner-card', targets: ['guide'] });
  assert.deepEqual(added(w), [[bare.id, 'owner-one']], 'only the card the triage moved and that lacked the owner');
  w.tracker.addMember = async () => {
    throw new Error('the tracker is down');
  };
  const f = await triage(failing);
  assert.match(f.warnings.join('; '), /the owner \(owner-one\) was not added to the card: the tracker is down/);
  assert.deepEqual([534, 535, 537, 538].map((n) => read(w, String(n)).triage.verdict), ['docs-required', 'docs-required', 'owner-card', 'docs-required'], 'every triage recorded');
});

test('pr with no expert review recommendation records null with a warning and adds no label; a label the repository lacks is a warning', async () => {
  const c = card({ number: 539, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 37, head: 'ticket-37', labels: ['in progress'] }), pr({ repo: 'api-docs', number: 38, head: 'ticket-38', labels: ['In progress'] })], extra: PEOPLE });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-37', targets: ['guide'], review: 'sme', number: undefined }, { repo: 'api-docs', branch: 'ticket-38', targets: ['api'], review: 'places', number: undefined }] });
  const changeLabels = w.forge.changeLabels;
  w.forge.changeLabels = async (a) => {
    if (a.add.includes('Expert advised')) throw new Error("no label 'Expert advised' in the repository");
    return changeLabels(a);
  };
  const r = await runRecord({ settings: w.settings, clients: w.clients(), key: '539', stage: 'pr', status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-37', number: 37 }, { repo: 'api-docs', branch: 'ticket-38', number: 38, expertReview: { recommended: true, why: 'a fee found neither in the code nor in the UI' } }] }, now: NOW });
  assert.match(r.warnings.join('; '), /ticket-37: no "expertReview".*recorded as null/);
  assert.match(r.warnings.join('; '), /api-docs#38: the label 'Expert advised' was not added: no label/);
  const l = read(w, '539');
  assert.deepEqual(l.prs.map((p) => [p.stage, p.expertReview?.recommended ?? null]), [['finalReview', null], ['finalReview', true]]);
  assert.deepEqual(w.forge.prs.map((p) => p.labels), [['in progress'], ['In progress']], 'no label on either');
});

test('a card member the board has no member for stops the run like an unmatched list; with no one named, the members are never read', async () => {
  const c = card({ number: 536, status: 'ready' });
  const bad = { ...PEOPLE, targets: PEOPLE.targets.map((t, i) => (i ? t : { ...t, cardMembers: ['nobody-here'] })) };
  const w = world({ cards: [c], extra: bad });
  await assert.rejects(w.status(), (e) => e.exitCode === 2 && /no board member matches 'nobody-here' \(targets 'guide'.cardMembers\)/.test(e.message));
  const plain = world({ cards: [c] });
  await plain.status();
  assert.ok(!plain.tracker.reads.some((r) => r[0] === 'members'));
});

// The optional translation label: a target that names one gives it to its PR for the chain, and takes it off when the
// chain ends or the card is moved back out. A target without one keeps the final review label, as before.
const WITH_TRANSLATION = { targets: rawSettings().targets.map((t) => (t.id === 'guide' ? { ...t, labels: { ...t.labels, translation: 'In translation' } } : t)) };
const labelChanges = (w) => w.forge.log.filter((e) => e[0] === 'changeLabels').map((e) => [e[2], e[3], e[4]]);
const stopHere = async () => ({ code: 1, stdout: '', stderr: 'stop here' });

test('a person\'s move to In translation gives the PR its translation label in place of the final review one; a move back out gives the final review label back', async () => {
  const c = card({ number: 540, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 45, headCommit: HEAD, labels: ['ship it', 'In final review'] });
  const w = world({ cards: [c], prs: [forgePr], extra: WITH_TRANSLATION });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 45, targets: ['guide'], review: 'sme', stage: 'finalReview', label: 'In final review' }] });
  moved(c, 'translation');
  assert.deepEqual(steps(await w.one('540')), ['follow -> translation']);
  assert.deepEqual(scriptedCalls({ stage: 'follow', to: 'translation', keys: ['540'] }, read(w, '540'), w.settings), ['forge set-stage-label --target guide --number 45 --stage translation']);
  // The chain's first session sees the PR already labelled; it stops there.
  let seen = null;
  await run(w, async () => {
    seen = [...forgePr.labels];
    return stopHere();
  }, { named: ['540'] });
  assert.deepEqual(seen, ['ship it', 'In translation']);
  assert.deepEqual(labelChanges(w), [[45, ['In translation'], ['In final review']]], 'one request: added and removed together');
  assert.deepEqual([read(w, '540').prs[0].stage, read(w, '540').prs[0].label], ['translation', 'In translation']);

  // A person moves the card back during the chain: the final review label comes back, the owner's label stays.
  moved(c, 'finalReview');
  assert.deepEqual(ran(await run(w, noSession, { named: ['540'] })), [['follow', 'finalReview', 'done']]);
  assert.deepEqual(forgePr.labels, ['ship it', 'In final review']);
  assert.deepEqual(labelChanges(w).at(-1), [45, ['In final review'], ['In translation']]);
  assert.deepEqual([read(w, '540').prs[0].stage, read(w, '540').prs[0].label], ['finalReview', 'In final review']);

  // Into the chain again, then back to rework: the in-progress label, and the translation label goes.
  moved(c, 'translation');
  await run(w, stopHere, { named: ['540'] });
  assert.deepEqual(forgePr.labels, ['ship it', 'In translation']);
  moved(c, 'inProgress');
  await run(w, noSession, { named: ['540'] });
  assert.deepEqual(forgePr.labels, ['ship it', 'in progress']);
});

test('a target with no translation label: the move to In translation changes no label, and from the review it sets the final review label as before', async () => {
  const c = card({ number: 541, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 46, headCommit: HEAD, labels: ['In final review'] });
  const w = world({ cards: [c], prs: [forgePr] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 46, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  moved(c, 'translation');
  assert.deepEqual(scriptedCalls({ stage: 'follow', to: 'translation', keys: ['541'] }, read(w, '541'), w.settings), ['forge set-stage-label --target guide --number 46 --stage finalReview']);
  await run(w, stopHere, { named: ['541'] });
  assert.equal(read(w, '541').prs[0].stage, 'translation');
  assert.deepEqual(forgePr.labels, ['In final review']);
  assert.deepEqual(labelChanges(w), [], 'no label request');

  const r = card({ number: 542, status: 'smeReview' });
  const reviewed = pr({ repo: 'guide-docs', number: 47, headCommit: HEAD, labels: ['in expert review'] });
  const w2 = world({ cards: [r], prs: [reviewed] });
  ledger(w2, r, { stages: BASE, prs: [{ repo: 'guide-docs', number: 47, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  moved(r, 'translation');
  await run(w2, stopHere, { named: ['542'] });
  assert.deepEqual(reviewed.labels, ['In final review']);
});

// ------------------------------------------------------------------ the list of edits and the reply by number

const EN_PAGE = 'i18n/en/docusaurus-plugin-content-docs/current/x/a.md';
const item = (n, list, before, after, extra = {}) => ({ n, list, stage: list === 'description' ? 'pr' : 'answerComments', page: 'docs/x/a.md', block: `Крок ${n}`, before, after, at: ago(10), seq: n, ...extra });
const EDITS = [
  item(1, 'description', 'Відкрийте розділ.', 'Відкрийте розділ **Платежі**.'),
  item(2, 'description', 'Натисніть **Зберегти**.', 'Натисніть кнопку **Зберегти**.', { en: { page: EN_PAGE, before: 'Click **Save**.', after: 'Click the **Save** button.' } }),
  item(3, 'description', 'Поле необовʼязкове.', 'Поле можна залишити порожнім.'),
  item(4, 'description', 'Дані оновлюються.', 'Дані оновлюються щохвилини.'),
  item(5, '7001', 'Звіт за день', 'Звіт за добу'),
  item(6, '7001', 'Оберіть період.', 'Оберіть період звіту.'),
  item(7, '7001', 'Після того як ви натиснете кнопку, система перевірить усі поля форми й покаже помилки, якщо вони є.', 'Система перевіряє поля форми.'),
  item(8, '7001', 'Готово.', 'Звіт сформовано.'),
];

test('AC-2: a reply by number gives a brief that restores item 2 exactly (EN too), puts 5 verbatim and rewrites 7; items not named are untouched', async () => {
  const c = card({ number: 571, status: 'finalReview' });
  const body = '2 — поверни; 5 — "Звіт за добу, «Платежі»; підсумок"; 7 — коротше';
  const w = world({
    cards: [c],
    prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })],
    activity: { 'guide-docs#81': { comments: [{ id: 9001, author: 'owner-login', body, createdAt: ago(1), updatedAt: ago(1) }, { id: 9002, author: 'reviewer-one', body: '3 — поверни', createdAt: ago(1), updatedAt: ago(1) }] } },
  });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 81, targets: ['guide'], review: 'sme', stage: 'readyForMerge', chain: chainDone(), readyForMerge: [{ head: HEAD, at: ago(5) }], edits: EDITS }] });
  const t = await w.one('571');
  assert.deepEqual(steps(t), ['answerComments guide-docs#81']);
  const s = t.steps[0];
  assert.equal(s.nextEdit, 9, 'a new list goes on from the last number');
  assert.equal(s.replies.length, 1, "only the owner's comment is a reply; a reviewer's goes the usual way");
  assert.deepEqual(s.replies[0].items, [
    { n: 2, do: 'restore', page: 'docs/x/a.md', block: 'Крок 2', now: 'Натисніть кнопку **Зберегти**.', put: 'Натисніть **Зберегти**.', en: { page: EN_PAGE, now: 'Click the **Save** button.', put: 'Click **Save**.' } },
    { n: 5, do: 'verbatim', page: 'docs/x/a.md', block: 'Крок 5', now: 'Звіт за добу', put: 'Звіт за добу, «Платежі»; підсумок' },
    { n: 7, do: 'rewrite', page: 'docs/x/a.md', block: 'Крок 7', now: 'Система перевіряє поля форми.', how: 'коротше' },
  ]);
  const brief = briefFor({ ...s, role: 'writer', keys: ['571'] }, w.settings);
  assert.ok(brief.includes('A numbered list of edits you post on this PR starts at 9'));
  assert.ok(brief.includes(`- 2, restore: docs/x/a.md, Крок 2: put back "Натисніть **Зберегти**." where it reads "Натисніть кнопку **Зберегти**.". EN ${EN_PAGE}: put back "Click **Save**." where it reads "Click the **Save** button.".`));
  assert.ok(brief.includes('- 5, the owner\'s text: docs/x/a.md, Крок 5: replace "Звіт за добу" with exactly "Звіт за добу, «Платежі»; підсумок".'));
  assert.ok(brief.includes('- 7, rewrite as the owner describes ("коротше"): docs/x/a.md, Крок 7, which reads "Система перевіряє поля форми.".'));
  for (const n of [1, 3, 4, 6, 8]) assert.ok(!new RegExp(`^- ${n}, `, 'm').test(brief), `item ${n} is not named: nothing for it`);
});

test('AC-4: a number that does not exist, or one in two lists, is asked back, never guessed; a numbered comment on a PR with no list is an ordinary instruction', async () => {
  const c = { asked: card({ number: 572, status: 'finalReview' }), plain: card({ number: 573, status: 'finalReview' }) };
  const comment = (id, body) => ({ comments: [{ id, author: 'owner-login', body, createdAt: ago(1), updatedAt: ago(1) }] });
  const w = world({
    cards: Object.values(c),
    prs: [pr({ repo: 'guide-docs', number: 82, headCommit: HEAD }), pr({ repo: 'guide-docs', number: 83, headCommit: HEAD })],
    activity: { 'guide-docs#82': comment(9101, 'Дякую.\n12 — поверни\n3 — поверни\n4 —\n1 — "Відкрийте розділ."'), 'guide-docs#83': comment(9102, '1. Прибери зайве слово.\n2. Додай примітку.') },
  });
  // Item 3 is also in a list posted by hand before the numbering went on.
  ledger(w, c.asked, { stages: BASE, prs: [{ repo: 'guide-docs', number: 82, targets: ['guide'], review: 'sme', stage: 'finalReview', edits: [...EDITS, item(3, '6999', 'Старий текст.', 'Новий текст.')] }] });
  ledger(w, c.plain, { stages: BASE, prs: [{ repo: 'guide-docs', number: 83, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const st = await w.status();
  const asked = st.tickets.find((t) => t.key === '572').steps[0];
  assert.deepEqual(asked.replies[0].items.map((x) => [x.n, x.do, x.why ?? null]), [
    [12, 'ask', 'there is no item 12 on this PR (its items are 1–8)'],
    [3, 'ask', 'item 3 is in 2 lists (the PR description, comment 6999)'],
    [4, 'ask', 'the reply names item 4 with nothing to do'],
    [1, 'verbatim', null],
  ]);
  const brief = briefFor({ ...asked, role: 'writer', keys: ['572'] }, w.settings);
  assert.ok(brief.includes('- 12, ask back, change nothing: there is no item 12 on this PR (its items are 1–8).'));
  assert.ok(brief.includes('- 3, ask back, change nothing: item 3 is in 2 lists (the PR description, comment 6999).'));
  assert.ok(brief.includes("If an item's words point at another place than that item's block (the owner numbered their own instructions, not the list), change nothing for it and ask back."), 'numbered instructions are never guessed onto items');
  const plain = st.tickets.find((t) => t.key === '573').steps[0];
  assert.deepEqual([plain.stage, plain.replies, plain.nextEdit], ['answerComments', undefined, 1], 'no list yet: the owner\'s instructions, applied as before');
});

test('the reply\'s free form: dictated separators, a quote holding a semicolon, a line going on the item before, and words before the first number', () => {
  const parsed = parseReply('Добре, кілька правок:\n1. як було\n3: «нова назва; друга частина»\n4) прибери «також»\nі не повторюй слово\n#6 — revert\nпункт 8 - верни назад.\n2 — 5 полів');
  assert.equal(parsed.rest, 'Добре, кілька правок:');
  assert.deepEqual(parsed.items.map((x) => [x.n, x.kind, x.text]), [
    [1, 'restore', 'як було'],
    [3, 'verbatim', 'нова назва; друга частина'],
    [4, 'describe', 'прибери «також»\nі не повторюй слово'],
    [6, 'restore', 'revert'],
    [8, 'restore', 'верни назад'],
    [2, 'describe', '5 полів'],
  ]);
  assert.equal(parseReply('Гарно, але кнопка називається інакше.'), null, 'no number first: not a reply by number');
  assert.deepEqual(parseReply('- 2 — поверни, будь ласка\n* 5 — коротше\n• 6 — "Так."').items.map((x) => [x.n, x.kind]), [[2, 'restore'], [5, 'describe'], [6, 'verbatim']], 'a bulleted reply');
  assert.deepEqual(parseReply('> 3. «а» → «б»\n> ще рядок цитати\n2 — поверни\n> 4. «в» → «г»').items.map((x) => [x.n, x.kind, x.text]), [[2, 'restore', 'поверни']], "a quote reply's quoted lines are not the owner's words");
  assert.equal(parseReply('5 — «a» і «b»').items[0].kind, 'describe', 'two quotes and words between them are a description');
  assert.deepEqual(resolveReply(parseReply('5 — поверни; 5 — коротше'), EDITS).map((x) => x.why), ['item 5 is named twice in the reply', 'item 5 is named twice in the reply']);
});

test('a suggestion the owner left is put in verbatim; only the words outside the block are an instruction', async () => {
  assert.deepEqual(suggestionOf('Краще так:\n```suggestion\nНатисніть **Зберегти**.\n```\nі без крапки в кінці списку'), { text: 'Натисніть **Зберегти**.', note: 'Краще так:\nі без крапки в кінці списку' });
  assert.deepEqual(suggestionOf('````suggestion\nА ```код``` тут\n````'), { text: 'А ```код``` тут', note: '' });
  assert.equal(suggestionOf('Без блоку, просто слова.'), null);
  const c = card({ number: 574, status: 'finalReview' });
  const line = { id: 9201, author: 'owner-login', body: '```suggestion\nОберіть **Період** і натисніть **Показати**.\n```', path: 'docs/x/a.md', line: 12, reviewId: 9200, createdAt: ago(1), updatedAt: ago(1) };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 84, headCommit: HEAD })], activity: { 'guide-docs#84': { reviews: [{ id: 9200, author: 'owner-login', state: 'COMMENTED', body: '', submittedAt: ago(1) }], threads: [{ id: 'th1', path: 'docs/x/a.md', line: 12, comments: [line] }] } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 84, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const s = (await w.one('574')).steps[0];
  assert.deepEqual(s.suggestions, [{ id: 9201, path: 'docs/x/a.md', line: 12, text: 'Оберіть **Період** і натисніть **Показати**.', note: '' }]);
  const brief = briefFor({ ...s, role: 'writer', keys: ['574'] }, w.settings);
  assert.ok(brief.includes('- comment 9201, docs/x/a.md line 12: "Оберіть **Період** і натисніть **Показати**."'));
  assert.match(brief, /unless the lines already read so \(the owner committed it, a hand edit: change nothing\)/);
});

test('the numbered lists in the ledger: the description from 1, a reply going on, a collision kept and warned, the EN side from the re-sync', async () => {
  const c = card({ number: 575, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 85, head: 'ticket-85', headCommit: HEAD, labels: ['In progress'] })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-85', targets: ['guide'], review: 'sme' }] });
  const rec = (args) => runRecord({ settings: w.settings, clients: w.clients(), key: '575', now: NOW, ...args });
  const desc = [1, 2].map((n) => ({ n, page: 'docs/x/a.md', block: `Крок ${n}`, before: `було ${n}`, after: `стало ${n}` }));
  await rec({ stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-85', number: 85, expertReview: { recommended: false, why: 'all checked in the UI' }, edits: desc }] } });
  let p = read(w, '575').prs[0];
  assert.deepEqual(p.edits.map((e) => [e.n, e.list, e.stage, e.before, e.after]), [[1, 'description', 'pr', 'було 1', 'стало 1'], [2, 'description', 'pr', 'було 2', 'стало 2']]);
  // A malformed item is a usage error: nothing is written.
  await assert.rejects(rec({ stage: 'answerComments', status: 'done', pr: 'guide-docs#85', result: { summary: { id: 7101 }, edits: [{ n: 3, page: 'docs/x/a.md', after: 'x' }] } }), (e) => e.exitCode === 2 && /exact "before" and "after"/.test(e.message));
  await assert.rejects(rec({ stage: 'answerComments', status: 'done', pr: 'guide-docs#85', result: { edits: [] } }), (e) => e.exitCode === 2 && /give "summary"/.test(e.message));
  const out = await rec({ stage: 'answerComments', status: 'done', pr: 'guide-docs#85', result: { summary: { id: 7101 }, edits: [{ n: 3, page: 'docs/x/a.md', block: 'Крок 3', before: 'стало 2', after: 'було 2' }, { n: 2, page: 'docs/x/b.md', before: 'b', after: 'c' }] } });
  assert.deepEqual(out.warnings, ['edit 2 is also item 2 of the PR description: a reply naming 2 will be asked back']);
  p = read(w, '575').prs[0];
  assert.deepEqual(p.edits.map((e) => [e.n, e.list]), [[1, 'description'], [2, 'description'], [3, '7101'], [2, '7101']]);
  // The re-sync's EN side lands on the latest item of the number.
  const l = read(w, '575');
  l.prs[0].stage = 'translation';
  l.prs[0].chain = chainDone();
  const { writeLedger } = await import('../lib/ledger.mjs');
  writeLedger(w.settings.state, l);
  await rec({ stage: 'resync', status: 'done', pr: 'guide-docs#85', head: HEAD, result: { edits: [{ n: 3, en: { page: EN_PAGE, before: 'Step two.', after: 'Step one.' } }] } });
  p = read(w, '575').prs[0];
  assert.deepEqual(p.edits.find((e) => e.n === 3).en, { page: EN_PAGE, before: 'Step two.', after: 'Step one.' });
});

test('AC-3: the re-sync after a restore of both languages is told the item\'s EN is set, so it finds nothing to change there', async () => {
  const old = 'a'.repeat(40);
  const c = card({ number: 576, status: 'translation' });
  const git = { branchCommits: () => [], changedUnder: (t, from, to) => (from === old && to === HEAD ? ['docs/x/a.md'] : []), pagesOf: () => [] };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 86, headCommit: HEAD })], git });
  // Item 9 (the reply that restored item 2, both languages) and item 10 (a rewrite, UA only) came after the ready head.
  const edits = [...EDITS, item(9, '7201', 'Натисніть кнопку **Зберегти**.', 'Натисніть **Зберегти**.', { block: 'Крок 2', seq: 40, en: { page: EN_PAGE, before: 'Click the **Save** button.', after: 'Click **Save**.' } }), item(10, '7201', 'Звіт сформовано.', 'Готово.', { seq: 41 })];
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 86, targets: ['guide'], review: 'sme', stage: 'translation', chain: chainDone(old), readyForMerge: [{ head: old, at: ago(5), seq: 30 }], edits }] });
  const s = (await w.one('576')).steps[0];
  assert.equal(fmt(s), 'resync guide-docs#86');
  assert.deepEqual(s.items, [{ n: 9, page: 'docs/x/a.md', block: 'Крок 2', en: true }, { n: 10, page: 'docs/x/a.md', block: 'Крок 10', en: false }], 'only the items since the ready head');
  const brief = briefFor({ ...s, role: 'translator', keys: ['576'] }, w.settings);
  assert.ok(brief.includes('- 9: docs/x/a.md, Крок 2 (EN set)'));
  assert.ok(brief.includes('- 10: docs/x/a.md, Крок 10'));
  assert.match(brief, /An item marked "EN set" was changed in EN with UA \(a restore of both\): its EN block already matches, leave it\./);
});

test('the reply\'s traps: no bare-space separator, a general line after a restore stays general, items named together, nested quotes, the owner\'s own numbered list, an assent', () => {
  const kinds = (t) => parseReply(t)?.items.map((x) => [x.n, x.kind, x.text]) ?? null;
  assert.equal(parseReply('5 хвилин тому я просив інше'), null, 'a number and a space are no item');
  assert.equal(parseReply('2.5 мм — замало'), null, 'a decimal point is no separator');
  const general = parseReply('2 — поверни\nЗагалом зроби весь текст коротшим');
  assert.deepEqual([kinds('2 — поверни\nЗагалом зроби весь текст коротшим'), general.rest], [[[2, 'restore', 'поверни']], 'Загалом зроби весь текст коротшим'], 'the restore kept, the general line not narrowed to item 2');
  assert.deepEqual(kinds('7 — коротше\nі без «також»'), [[7, 'describe', 'коротше\nі без «також»']], 'a description still goes on');
  assert.deepEqual(resolveReply(parseReply('2 і 3 — поверни'), EDITS).map((x) => [x.n, x.do, x.why]), [[2, 'ask', 'the reply names items 2, 3 together: ask for each on its own'], [3, 'ask', 'the reply names items 2, 3 together: ask for each on its own']]);
  assert.deepEqual(kinds('5 — «Натисніть «Зберегти»»'), [[5, 'verbatim', 'Натисніть «Зберегти»']]);
  assert.deepEqual(kinds('5 — «А «Б»; В»'), [[5, 'verbatim', 'А «Б»; В']], 'no cut inside a nested quote');
  const own = resolveReply(parseReply('1. Додай розділ про ліміти\n2. Прибери скриншот з кроку 3'), EDITS);
  assert.deepEqual(own.map((x) => x.do), ['ask', 'ask'], "the owner's own numbered list is asked back, not applied to items 1 and 2");
  assert.match(own[0].why, /reads as a numbered list of its own/);
  assert.deepEqual(resolveReply(parseReply('1. коротше\n2. прибери «також»'), EDITS).map((x) => x.do), ['rewrite', 'rewrite'], 'a quote in an item marks a reply to the list');
  assert.deepEqual(resolveReply(parseReply('1. коротше\n2 — поверни'), EDITS).map((x) => x.do), ['rewrite', 'restore']);
  assert.deepEqual(resolveReply(parseReply('3 — ок; 4 — залиш; 6 — не треба; 8 — не потрібно'), EDITS).map((x) => x.do), ['keep', 'keep', 'ask', 'ask'], 'an assent changes nothing; «не треба» may mean undo, so it is asked back');
});

test('a restore of an item whose block a later item changed is asked back; a rewrite names the later items; the words outside the items reach the brief', async () => {
  const edits = [...EDITS, item(9, '7301', 'Натисніть кнопку **Зберегти**.', 'Натисніть **Зберегти** унизу.', { block: 'Крок 2' })];
  const out = resolveReply(parseReply('2 — поверни; 2 — коротше'), edits);
  assert.equal(out[0].do, 'ask');
  const restore = resolveReply(parseReply('2 — поверни'), edits)[0];
  assert.deepEqual([restore.do, restore.why], ['ask', "item 2's block was changed again by item 9: ask which text to restore"]);
  const rewrite = resolveReply(parseReply('2 — коротше'), edits)[0];
  assert.deepEqual([rewrite.do, rewrite.later], ['rewrite', [9]]);
  const c = card({ number: 577, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 87, headCommit: HEAD })], activity: { 'guide-docs#87': { comments: [{ id: 9301, author: 'owner-login', body: '9 — поверни\nЗагалом зроби весь текст коротшим', createdAt: ago(1), updatedAt: ago(1) }] } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 87, targets: ['guide'], review: 'sme', stage: 'finalReview', edits }] });
  const s = (await w.one('577')).steps[0];
  const brief = briefFor({ ...s, role: 'writer', keys: ['577'] }, w.settings);
  assert.ok(brief.includes('- 9, restore: docs/x/a.md, Крок 2: put back "Натисніть кнопку **Зберегти**." where it reads "Натисніть **Зберегти** унизу.".'));
  assert.ok(brief.includes('Words of the reply outside its items (not tied to one item; an instruction for the PR, or a remark): "Загалом зроби весь текст коротшим".'));
  assert.ok(brief.includes("Where the block doesn't read as the line says, change nothing for that item and ask back."));
});

test('two suggestion blocks in one comment are asked back; a block of several lines is matched by content', async () => {
  assert.deepEqual(suggestionOf('```suggestion\nА\n```\nі\n```suggestion\nБ\n```').several, 2);
  const c = card({ number: 578, status: 'finalReview' });
  const line = (id, body) => ({ id, author: 'owner-login', body, path: 'docs/x/a.md', line: 12, reviewId: 9400, createdAt: ago(1), updatedAt: ago(1) });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 88, headCommit: HEAD })], activity: { 'guide-docs#88': { reviews: [{ id: 9400, author: 'owner-login', state: 'COMMENTED', body: '', submittedAt: ago(1) }], threads: [{ id: 'th2', path: 'docs/x/a.md', line: 12, comments: [line(9401, '```suggestion\nА\n```\n```suggestion\nБ\n```')] }] } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 88, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const s = (await w.one('578')).steps[0];
  assert.deepEqual(s.suggestions, [{ id: 9401, path: 'docs/x/a.md', line: 12, several: 2 }]);
  const brief = briefFor({ ...s, role: 'writer', keys: ['578'] }, w.settings);
  assert.ok(brief.includes('- comment 9401, docs/x/a.md line 12: 2 suggestion blocks in one comment; ask back, change nothing.'));
  assert.match(brief, /match the lines it replaces by their content, and if that isn't certain, change nothing and ask back/);
});

test('a PR with two cards: the reply is read against both cards\' lists, and an item they record differently is asked back', async () => {
  const c = { a: card({ number: 579, status: 'finalReview' }), b: card({ number: 580, status: 'finalReview' }) };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 89, headCommit: HEAD })], activity: { 'guide-docs#89': { comments: [{ id: 9501, author: 'owner-login', body: '5 — поверни; 10 — поверни', createdAt: ago(1), updatedAt: ago(1) }] } } });
  const prOf = (edits) => [{ repo: 'guide-docs', number: 89, targets: ['guide'], review: 'sme', stage: 'finalReview', edits }];
  ledger(w, c.a, { stages: BASE, group: '579-580', prs: prOf(EDITS) });
  // The other card's record has item 10 the first lacks, and item 5 with another text.
  ledger(w, c.b, { stages: BASE, group: '579-580', prs: prOf([...EDITS.filter((e) => e.n !== 5), item(5, '7001', 'Звіт за день', 'Звіт за тиждень'), item(10, '7501', 'Старе.', 'Нове.')]) });
  const s = (await w.status()).tickets.find((t) => t.key === '579').steps[0];
  assert.equal(s.nextEdit, 11, 'the numbers go on from both records');
  assert.deepEqual(s.replies[0].items.map((x) => [x.n, x.do, x.why ?? null]), [[5, 'ask', 'item 5 reads differently in the records of the cards that share this PR'], [10, 'restore', null]]);
});

test('a move to In translation takes a ready PR along only for the owner\'s own commits with no session since ready, and the other card of the PR goes with it', async () => {
  const old = 'a'.repeat(40);
  const c = { mine: card({ number: 591, status: 'translation' }), session: card({ number: 592, status: 'translation' }), a: card({ number: 593, status: 'translation' }), b: card({ number: 594, status: 'finalReview' }) };
  const vcs = { branchCommits: () => [], changedUnder: (t, from, to) => (from === old && to === HEAD ? ['docs/a.md'] : []), commitsBetween: (t, from, to) => (from === old && to === HEAD ? [HEAD] : null), pagesOf: () => [] };
  const w = world({ cards: Object.values(c), prs: [91, 92, 93].map((number) => pr({ repo: 'guide-docs', number, headCommit: HEAD })), git: vcs });
  const ready = (number, extra = {}) => ({ stages: BASE, left: 'finalReview', prs: [{ repo: 'guide-docs', number, targets: ['guide'], review: 'sme', stage: 'readyForMerge', pipelineCommits: ['e0e0e0e'], chain: chainDone(old), readyForMerge: [{ head: old, at: ago(5), seq: 5 }] }], ...extra });
  ledger(w, c.mine, ready(91));
  // An answer session ran on the PR after it was marked ready; its record failed, so its commit is in no list.
  ledger(w, c.session, { ...ready(92), runs: [{ seq: 6, stage: 'answerComments', pr: 'guide-docs#92', role: 'writer', start: ago(2), outcome: 'failed' }] });
  ledger(w, c.a, ready(93, { group: '593-594' }));
  ledger(w, c.b, ready(93, { group: '593-594' }));
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.deepEqual(by['591'].steps[0].takeReady, [{ pr: 'guide-docs#91', head: HEAD }]);
  assert.equal(by['592'].steps[0].takeReady, undefined, 'a session since ready: not known to be the owner\'s alone');
  // The other card of PR 93 goes along with the same takeReady: one move, one re-sync, no extra move back.
  const follow = { ...by['593'].steps[0], keys: ['593'] };
  assert.deepEqual(follow.takeReady, [{ pr: 'guide-docs#93', head: HEAD }]);
  assert.ok(scriptedCalls(follow, read(w, '593'), w.settings).includes(`tracker move ${c.b.shortLink} --to translation`), 'the other card is moved along');
  moved(c.b, 'translation');
  for (const key of ['593', '594']) await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'follow', status: 'done', to: 'translation', result: { takeReady: follow.takeReady }, now: NOW });
  assert.deepEqual(['593', '594'].map((k) => read(w, k).prs[0].stage), ['translation', 'translation']);
  assert.deepEqual(['593', '594'].map((k) => read(w, k).prs[0].approval?.head ?? null), [HEAD, HEAD]);
});

test('a PR with two cards: the other card\'s own PR, which its record takes into translation, gets the translation label too', async () => {
  const all = { targets: rawSettings().targets.map((t) => ({ ...t, labels: { ...t.labels, translation: 'In translation' } })) };
  const a = card({ number: 598, status: 'finalReview' });
  const b = card({ number: 599, status: 'finalReview' });
  const shared = pr({ repo: 'guide-docs', number: 63, headCommit: HEAD, labels: ['In final review'] });
  const own = pr({ repo: 'api-docs', number: 64, headCommit: HEAD, labels: ['In final review'] });
  const w = world({ cards: [a, b], prs: [shared, own], extra: all });
  const sharedPr = { repo: 'guide-docs', number: 63, targets: ['guide'], review: 'sme', stage: 'finalReview' };
  ledger(w, a, { stages: BASE, group: '598-599', prs: [sharedPr] });
  ledger(w, b, { stages: BASE, group: '598-599', prs: [sharedPr, { repo: 'api-docs', number: 64, targets: ['api'], review: 'places', stage: 'finalReview' }] });
  moved(a, 'translation');
  assert.deepEqual(scriptedCalls({ stage: 'follow', to: 'translation', keys: ['598'] }, read(w, '598'), w.settings), [
    'forge set-stage-label --target guide --number 63 --stage translation',
    `tracker move ${b.shortLink} --to translation`,
    'forge set-stage-label --target api --number 64 --stage translation',
  ]);
  await run(w, stopHere, { named: ['598'] });
  assert.deepEqual(read(w, '599').prs.map((p) => p.stage), ['translation', 'translation']);
  assert.deepEqual([shared.labels, own.labels], [['In translation'], ['In translation']]);
  assert.equal(labelChanges(w).filter((e) => e[0] === 63).length, 1, 'the shared PR labelled once');
});

test('the plan of a move to In translation labels a ready PR it takes along; its record keeps the label; row 8 sends a ready PR back with the final review label', async () => {
  const old = 'a'.repeat(40);
  const c = { taken: card({ number: 595, status: 'translation' }), back: card({ number: 597, status: 'finalReview' }) };
  const vcs = { branchCommits: () => [], changedUnder: (t, from, to) => (from === old && to === HEAD ? ['docs/a.md'] : []), commitsBetween: (t, from, to) => (from === old && to === HEAD ? [HEAD] : null), pagesOf: () => [] };
  const w = world({ cards: Object.values(c), prs: [95, 97].map((number) => pr({ repo: 'guide-docs', number, headCommit: HEAD, labels: ['In final review'] })), git: vcs, extra: WITH_TRANSLATION });
  const ready = (number, left, pipelineCommits) => ({ stages: BASE, left, prs: [{ repo: 'guide-docs', number, targets: ['guide'], review: 'sme', stage: 'readyForMerge', pipelineCommits, label: 'In final review', chain: chainDone(old), readyForMerge: [{ head: old, at: ago(5), seq: 5 }] }] });
  ledger(w, c.taken, ready(95, 'finalReview', ['e0e0e0e']));
  // The head moved by a commit of the pipeline's (an answer pushed while the owner looked): row 8 sends it back.
  ledger(w, c.back, ready(97, 'same', [HEAD]));
  const by = Object.fromEntries((await w.status()).tickets.map((t) => [t.key, t]));
  const follow = { ...by['595'].steps[0], keys: ['595'] };
  assert.deepEqual(follow.takeReady, [{ pr: 'guide-docs#95', head: HEAD }]);
  assert.deepEqual(scriptedCalls(follow, read(w, '595'), w.settings), ['forge set-stage-label --target guide --number 95 --stage translation']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '595', stage: 'follow', status: 'done', to: 'translation', result: { takeReady: follow.takeReady }, now: NOW });
  assert.deepEqual([read(w, '595').prs[0].stage, read(w, '595').prs[0].label], ['translation', 'In translation']);
  assert.deepEqual(scriptedCalls({ stage: 'readyForMerge', pr: 'guide-docs#95', keys: ['595'] }, read(w, '595'), w.settings), ['forge set-stage-label --target guide --number 95 --stage finalReview']);
  const move = by['597'].steps[0];
  assert.deepEqual([move.stage, move.to], ['move', 'finalReview']);
  assert.equal(scriptedCalls(move, read(w, '597'), w.settings)[0], 'forge set-stage-label --target guide --number 97 --stage finalReview');
});
