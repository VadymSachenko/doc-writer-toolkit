import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTS, NOW, ago, card, pr } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { briefFor, runDaily } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { runHandover } from '../lib/handover.mjs';
import { parseUsage } from '../lib/allowance.mjs';

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
    await runRecord({ settings: w.settings, clients: w.clients(), key: '501', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-11', number: 11 }], places }, now: NOW });
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

test('comments come first in the owner\'s queue and start no chain stage; a pending reviewer on a sme PR doesn\'t move it back', async () => {
  const c = card({ number: 503, status: 'finalReview' });
  const w = world({
    cards: [c],
    prs: [pr({ repo: 'guide-docs', number: 13, headCommit: HEAD, reviewRequests: ['expert-one'] })],
    activity: { 'guide-docs#13': { comments: [{ id: 901, author: 'owner-login', body: 'fix this', createdAt: ago(1), updatedAt: ago(1) }] } },
  });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 13, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
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

test('a UA change after ready for merge re-syncs, whoever made it: an answer to a comment too; an id-only one keeps the PR ready', async () => {
  const old = 'a'.repeat(40);
  const c = { words: card({ number: 515, status: 'finalReview' }), ids: card({ number: 516, status: 'finalReview' }), en: card({ number: 517, status: 'finalReview' }), synced: card({ number: 518, status: 'finalReview' }) };
  const changed = { [HEAD]: ['docs/a.md'] };
  const git = { branchCommits: () => [], changedUnder: (t, from, to) => (t.repo === 'guide-docs' && changed[to] && !git.ids.has(t) ? changed[to] : []), pagesOf: () => [], ids: new Set() };
  const words = pr({ repo: 'guide-docs', number: 41, headCommit: HEAD });
  const idsPr = pr({ repo: 'api-docs', number: 42, headCommit: HEAD });
  const en = pr({ repo: 'api-docs', number: 43, headCommit: HEAD });
  const synced = pr({ repo: 'guide-docs', number: 44, headCommit: HEAD });
  const w = world({ cards: Object.values(c), prs: [words, idsPr, en, synced], git });
  const answered = (n, repo, targets, extra = {}) => ({ stages: BASE, prs: [{ repo, number: n, targets, review: 'places', stage: 'readyForMerge', pipelineCommits: ['b'], chain: chainDone(old), readyForMerge: [{ head: old, at: ago(5) }], ...extra }] });
  ledger(w, c.words, answered(41, 'guide-docs', ['guide']));
  ledger(w, c.ids, answered(42, 'api-docs', ['api']));
  ledger(w, c.en, answered(43, 'api-docs', ['api']));
  ledger(w, c.synced, answered(44, 'guide-docs', ['guide'], { steps: { resync: { status: 'done', head: HEAD } } }));
  const st = await w.status();
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.deepEqual(steps(by['515']), ['resync guide-docs#41'], 'the pipeline\'s own commit, UA changed: the chain\'s languages catch up');
  const resync = by['515'].steps[0];
  assert.equal(resync.since, old, 'the step names the ready head');
  assert.equal(resync.head, HEAD);
  assert.equal(resync.commits, 0, 'no hand commit: the pipeline made the change');
  assert.match(briefFor({ ...resync, role: 'translator', keys: ['515'] }, w.settings), new RegExp(`UA changed since ready for merge at ${old}: re-sync the blocks changed in ${old}\\.\\.${HEAD}\\.`));
  assert.deepEqual(by['516'].steps, [], 'an id-only change keeps it ready');
  assert.deepEqual(by['517'].steps, [], 'UA untouched');
  assert.deepEqual(steps(by['518']), ['readyForMerge guide-docs#44'], 'synced: ready for the new head');
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
  const r = await runRecord({ settings: w.settings, clients: w.clients(), key: '520', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-46', number: 46 }], places: [place('p1', { refs: [ref] }), place('p2', {}), place('p3', { refs: [{ repo: 'code-repo', path: 'a.go' }] })] }, now: NOW });
  assert.equal(r.warnings.length, 2);
  const l = read(w, '520');
  assert.deepEqual(l.places.map((p) => [p.id, Boolean(p.noRef)]), [['p1', false], ['p2', true], ['p3', true]]);
  assert.deepEqual(l.places[0].refs, [ref]);
  assert.equal(l.places[0].reason, 'the change named it');
  const t = await w.one('520');
  assert.match(t.mismatch.join('; '), /2 place\(s\) from the code with no reference at a commit: p2, p3/);
});
