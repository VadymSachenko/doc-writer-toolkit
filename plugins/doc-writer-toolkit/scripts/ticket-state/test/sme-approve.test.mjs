import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTS, NOW, ago, card, pr, settingsFor, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { briefFor, runDaily } from '../lib/runner.mjs';
import { renderReport, workingDaysBetween } from '../lib/report.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { reviewerSignals } from '../lib/world.mjs';
import { forwardMove } from '../lib/stages.mjs';
import { DEFAULT_REVIEW_COMMENT } from '../lib/settings.mjs';

// The expert's Approve moves the card (D-082); the expert's review request is easy to act on: a comment with the way to
// approve at each entry, the line in the summary, and the report's quiet experts; a person's forward move takes the
// check label off (D-128).

const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const fmt = (s) => `${s.stage}${s.pr ? ` ${s.pr}` : ''}${s.to ? ` -> ${s.to}` : ''}`;
const steps = (t) => t.steps.map(fmt);
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const noSession = async () => {
  throw new Error('a session started');
};
const run = (w, options = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] }), spawnClaude: noSession }, options: { morning: false, trigger: 'watch', ...options } });
const ran = (out) => out.ran.map((r) => [r.stage, r.pr ?? null, r.to ?? null, r.outcome]);
const approve = (id, at, commit = HEAD, author = 'expert-one') => ({ id, author, state: 'APPROVED', body: '', submittedAt: at, commit });
const smePr = (extra = {}) => ({ repo: 'guide-docs', number: 7, targets: ['guide'], review: 'sme', stage: 'smeReview', ...extra });

test('AC-1: a single PR the expert approved since it entered the review goes to the owner\'s queue: the card moves, the label follows, the approval is kept at the head the expert approved', async () => {
  const c = card({ number: 901, status: 'smeReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 7, headCommit: HEAD, labels: ['in expert review', 'Look at me'] });
  const w = world({ cards: [c], prs: [forgePr], activity: { 'guide-docs#7': { reviews: [approve(9101, ago(1), OLD)] } } });
  ledger(w, c, { stages: BASE, prs: [smePr({ smeSince: ago(5) })] });
  const t = await w.one('901');
  assert.deepEqual(steps(t), ['move guide-docs#7 -> finalReview']);
  assert.deepEqual(t.steps[0].review, { id: 9101, login: 'expert-one', head: OLD, at: ago(1) });
  assert.equal(t.steps[0].role, null, 'no model');

  assert.deepEqual(ran(await run(w, { named: ['901'] })), [['move', 'guide-docs#7', 'finalReview', 'done']]);
  assert.equal(c.placeId, LISTS.finalReview.id, 'the card is in the owner\'s queue');
  assert.deepEqual(forgePr.labels, ['Look at me', 'In final review'], 'the stage label follows; the check label stays: the owner has not looked');
  const l = read(w, '901');
  assert.equal(l.prs[0].stage, 'finalReview');
  assert.deepEqual(l.prs[0].expertApproval, { head: OLD, at: ago(1), by: 'reviewer', login: 'expert-one', review: 9101 });
  assert.equal(l.prs[0].approval ?? null, null, "the expert's approval is not the owner's read");
  const after = await w.one('901');
  assert.deepEqual([after.state, after.steps], ['finalReview', []], 'it starts nothing: the owner reads, then moves the card');
});

test('AC-2: approved with new comments of the expert\'s: the comments are answered first, with no Approve line; the move follows once they are handled', async () => {
  const c = card({ number: 902, status: 'smeReview' });
  const activity = { 'guide-docs#7': { comments: [{ id: 9201, author: 'expert-one', body: 'One more thing: the limit is daily.', createdAt: ago(2), updatedAt: ago(2) }], reviews: [approve(9202, ago(1))] } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 7, headCommit: HEAD, labels: ['in expert review'] })], activity });
  ledger(w, c, { stages: BASE, prs: [smePr({ smeSince: ago(5) })] });
  let t = await w.one('902');
  assert.deepEqual(steps(t), ['answerComments guide-docs#7'], 'row 11 first');
  assert.equal(t.steps[0].askApprove, undefined, 'the expert already approved: no Approve line');
  await runRecord({ settings: w.settings, clients: w.clients(), key: '902', stage: 'answerComments', pr: 'guide-docs#7', status: 'done', result: { handled: [{ id: 9201, updatedAt: ago(2) }] }, now: NOW });
  t = await w.one('902');
  assert.deepEqual(steps(t), ['move guide-docs#7 -> finalReview']);
});

test('item 2: answering the expert before an approval asks for one in the summary: the brief gives the Files changed link and the path', async () => {
  const c = card({ number: 903, status: 'smeReview' });
  const activity = { 'guide-docs#7': { comments: [{ id: 9301, author: 'expert-one', body: 'Wrong field name.', createdAt: ago(2), updatedAt: ago(2) }, { id: 9302, author: 'owner-login', body: 'Agree, fix it.', createdAt: ago(1), updatedAt: ago(1) }] } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 7, headCommit: HEAD, labels: ['in expert review'] })], activity });
  ledger(w, c, { stages: BASE, prs: [smePr({ smeSince: ago(5), url: 'https://forge.example/acme/guide-docs/pull/7' })] });
  const t = await w.one('903');
  assert.deepEqual(steps(t), ['answerComments guide-docs#7']);
  assert.equal(t.steps[0].askApprove, 'https://forge.example/acme/guide-docs/pull/7/files');
  const brief = briefFor({ ...t.steps[0], keys: ['903'] }, w.settings);
  assert.match(brief, /end the summary with one line that asks the expert, when nothing else is needed, to approve: the link https:\/\/forge\.example\/acme\/guide-docs\/pull\/7\/files and the path «Review changes» → «Approve» → «Submit review»/);

  // The owner's comments alone, or a PR in the owner's queue: no such line.
  const c2 = card({ number: 904, status: 'finalReview' });
  const w2 = world({ cards: [c2], prs: [pr({ repo: 'guide-docs', number: 8, headCommit: HEAD, labels: ['In final review'] })], activity: { 'guide-docs#8': { comments: [{ id: 9401, author: 'expert-one', body: 'Late note.', createdAt: ago(1), updatedAt: ago(1) }] } } });
  ledger(w2, c2, { stages: BASE, prs: [smePr({ number: 8, stage: 'finalReview' })] });
  assert.equal((await w2.one('904')).steps[0].askApprove, undefined);
});

test('loop guards: an approval from before the PR entered the review moves nothing; a later request for changes cancels an approval', async () => {
  const c = { old: card({ number: 905, status: 'smeReview' }), changes: card({ number: 906, status: 'smeReview' }), legacy: card({ number: 907, status: 'smeReview' }) };
  const prs = [5, 6, 7].map((number) => pr({ repo: 'guide-docs', number, headCommit: HEAD, labels: ['in expert review'] }));
  const activity = {
    // Approved in an earlier round; the card came back to the review since.
    'guide-docs#5': { reviews: [approve(9501, ago(30))] },
    'guide-docs#6': { reviews: [approve(9601, ago(4)), { id: 9602, author: 'expert-one', state: 'CHANGES_REQUESTED', body: '', submittedAt: ago(3), commit: HEAD }] },
    // A ledger from before `smeSince`: the time the card was left in the review stands for it.
    'guide-docs#7': { reviews: [approve(9701, ago(30))] },
  };
  const w = world({ cards: Object.values(c), prs, activity });
  ledger(w, c.old, { stages: BASE, prs: [smePr({ number: 5, smeSince: ago(10) })] });
  ledger(w, c.changes, { stages: BASE, prs: [smePr({ number: 6, smeSince: ago(10) })] });
  ledger(w, c.legacy, { stages: BASE, prs: [smePr({ number: 7 })] });
  const st = await w.status();
  for (const key of ['905', '906', '907']) assert.deepEqual(st.tickets.find((t) => t.key === key).steps, [], key);
});

test('reviewerSignals: the latest verdict of each reviewer counts; the pipeline\'s own login and bots are no reviewer', () => {
  const a = reviewerSignals({ reviews: [approve(1, '2026-11-09T10:00:00Z'), { id: 2, author: 'owner-login', state: 'COMMENTED', body: 'x', submittedAt: '2026-11-09T12:00:00Z' }], comments: [{ id: 3, author: 'ci[bot]', createdAt: '2026-11-09T13:00:00Z' }] }, 'owner-login');
  assert.deepEqual(a, { reviewerAt: '2026-11-09T10:00:00.000Z', approved: { id: 1, login: 'expert-one', commit: HEAD, at: '2026-11-09T10:00:00Z' } });
  const b = reviewerSignals({ reviews: [approve(1, '2026-11-09T10:00:00Z'), { id: 4, author: 'expert-two', state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-11-09T09:00:00Z' }], threads: [{ comments: [{ id: 5, author: 'expert-two', createdAt: '2026-11-09T11:00:00Z' }] }] }, 'owner-login');
  assert.deepEqual(b, { reviewerAt: '2026-11-09T11:00:00.000Z', approved: null });
  assert.deepEqual(reviewerSignals({}, 'owner-login'), { reviewerAt: null, approved: null });
});

test('item 4: a person\'s move into the review posts the comment with the way to approve, once, kept in `posted`; it is never read as the owner\'s', async () => {
  const c = card({ number: 908, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 7, headCommit: HEAD, labels: ['In final review', 'Look at me'] });
  const activity = { 'guide-docs#7': { comments: [] } };
  const w = world({ cards: [c], prs: [forgePr], activity });
  ledger(w, c, { stages: BASE, prs: [smePr({ stage: 'finalReview', url: forgePr.url })] });
  c.placeId = LISTS.smeReview.id;
  assert.deepEqual(ran(await run(w, { named: ['908'] })), [['follow', null, 'smeReview', 'done']]);
  const posted = w.forge.log.filter((e) => e[0] === 'comment').map((e) => e[1]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body, `The changes to review: ${forgePr.url}/files\nWhen nothing else is needed: «Review changes» → «Approve» → «Submit review».`);
  const l = read(w, '908');
  const id = 900 + w.forge.log.findIndex((e) => e[0] === 'comment') + 1;
  assert.ok(l.posted.pr.map(String).includes(String(id)), 'its id is in posted');
  assert.equal(l.prs[0].smeSince, new Date(NOW).toISOString(), 'the time it entered the review');
  assert.deepEqual(forgePr.labels, ['in expert review'], "the owner's check is done: the check label is off");
  // The forge shows it from the owner's login: it starts no answer.
  activity['guide-docs#7'].comments.push({ id, author: 'owner-login', body: posted[0].body, createdAt: ago(0), updatedAt: ago(0) });
  assert.deepEqual((await w.one('908')).steps, []);
});

test('item 4: a review a person requested from the owner\'s queue (row 9) gets the comment too', async () => {
  const c = card({ number: 909, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 7, headCommit: HEAD, reviewRequests: ['expert-one'], labels: ['In final review'] });
  const w = world({ cards: [c], prs: [forgePr] });
  ledger(w, c, { stages: BASE, prs: [smePr({ stage: 'finalReview', url: forgePr.url })] });
  assert.deepEqual(ran(await run(w, { named: ['909'] })), [['move', 'guide-docs#7', 'smeReview', 'done']]);
  assert.equal(w.forge.log.filter((e) => e[0] === 'comment').length, 1);
  const l = read(w, '909');
  assert.equal(l.posted.pr.length, 1);
  assert.equal(l.prs[0].smeSince, new Date(NOW).toISOString());
});

test('D-128: a person\'s forward move takes the check label off the PRs it moves; a move back keeps it; a person\'s move on from the review is the approval at the head', async () => {
  assert.deepEqual([forwardMove('finalReview', 'translation'), forwardMove('finalReview', 'smeReview'), forwardMove('smeReview', 'finalReview'), forwardMove('inProgress', 'finalReview')], [true, true, true, true]);
  assert.deepEqual([forwardMove('translation', 'finalReview'), forwardMove('finalReview', 'inProgress'), forwardMove('smeReview', 'blocked'), forwardMove('translation', 'smeReview')], [false, false, false, false]);

  const c = { on: card({ number: 910, status: 'translation' }), back: card({ number: 911, status: 'finalReview' }) };
  const prs = [pr({ repo: 'guide-docs', number: 10, headCommit: HEAD, labels: ['In final review', 'Look at me'] }), pr({ repo: 'guide-docs', number: 11, headCommit: HEAD, labels: ['In final review', 'Look at me'] })];
  const w = world({ cards: Object.values(c), prs });
  ledger(w, c.on, { stages: BASE, left: 'smeReview', prs: [smePr({ number: 10 })] });
  ledger(w, c.back, { stages: BASE, left: 'translation', prs: [smePr({ number: 11, stage: 'translation' })] });
  const stopHere = async () => ({ code: 1, stdout: '', stderr: 'stop here' });
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] }), spawnClaude: stopHere }, options: { morning: false, trigger: 'watch', named: ['910', '911'] } });
  assert.ok(!prs[0].labels.includes('Look at me'), 'forward: off');
  assert.ok(prs[1].labels.includes('Look at me'), 'back: kept');
  assert.deepEqual(read(w, '910').prs[0].expertApproval, { head: HEAD, at: new Date(NOW).toISOString(), by: 'person' });
});

test('AC-4: the report lists a PR whose expert has been quiet for the set working days, with the text to send; a weekend is not counted', async () => {
  // Fri 2026-11-06 12:00 local; Mon 9, Tue 10, Wed 11.
  const fri = new Date(2026, 10, 6, 12).getTime();
  assert.equal(workingDaysBetween(fri, '2026-11-10'), 1, 'Monday only');
  assert.equal(workingDaysBetween(fri, '2026-11-11'), 2, 'Monday and Tuesday');
  assert.equal(workingDaysBetween(fri, '2026-11-07'), 0);

  const c = { quiet: card({ number: 912, status: 'smeReview' }), spoke: card({ number: 913, status: 'smeReview' }) };
  const prs = [pr({ repo: 'guide-docs', number: 12, headCommit: HEAD, labels: ['in expert review'] }), pr({ repo: 'guide-docs', number: 13, headCommit: HEAD, labels: ['in expert review'] })];
  // The expert of #13 commented on Tuesday: two working days are not over by Wednesday.
  const activity = { 'guide-docs#13': { comments: [{ id: 9131, author: 'expert-one', body: 'Looking.', createdAt: new Date(2026, 10, 10, 9).toISOString(), updatedAt: new Date(2026, 10, 10, 9).toISOString() }] } };
  const w = world({ cards: Object.values(c), prs, activity });
  ledger(w, c.quiet, { stages: BASE, prs: [smePr({ number: 12, smeSince: new Date(fri).toISOString(), url: prs[0].url })] });
  ledger(w, c.spoke, { stages: BASE, prs: [smePr({ number: 13, smeSince: new Date(fri).toISOString(), url: prs[1].url })], reviewComments: [{ repo: 'guide-docs', pr: 13, id: 9131, updatedAt: new Date(2026, 10, 10, 9).toISOString() }] });
  const st = await w.status();
  const wed = renderReport({ settings: w.settings, st, date: '2026-11-11' });
  const section = wed.split('## Expert review gone quiet\n\n')[1].split('\n\n')[0];
  assert.equal(section, `- [guide-docs#12](${prs[0].url}) ([912](${c.quiet.url})): no word from the expert for 2 working day(s), since 2026-11-06. To send: The changes to review: ${prs[0].url}/files When nothing else is needed: «Review changes» → «Approve» → «Submit review».`);
  const tue = renderReport({ settings: w.settings, st, date: '2026-11-10' });
  assert.match(tue, /## Expert review gone quiet\n\n- none\n/, 'one working day is not enough');
});

test('settings: `forge.reviewComment` needs <files>; `schedule.expertQuietDays` defaults to 2', () => {
  const root = tmp();
  const s = settingsFor(root);
  assert.equal(s.reviewComment, DEFAULT_REVIEW_COMMENT);
  assert.equal(s.schedule.expertQuietDays, 2);
  const own = settingsFor(root, { forge: { kind: 'github', owner: 'acme', self: 'owner-login', reviewComment: 'Please look: <files>' } });
  assert.equal(own.reviewComment, 'Please look: <files>');
  assert.throws(() => settingsFor(root, { forge: { kind: 'github', owner: 'acme', reviewComment: 'no link' } }), /forge\.reviewComment/);
});
