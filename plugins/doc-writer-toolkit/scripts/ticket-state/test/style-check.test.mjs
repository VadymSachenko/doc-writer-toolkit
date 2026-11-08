import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTS, NOW, ago, card, pr, settingsFor } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { briefFor } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseReply, resolveReply } from '../lib/edits.mjs';

// The style check of a person's edits (context/ticket-flow.md, "The style check of a person's edits"): after the
// review comments are applied, and once per hand commit that changed UA, before the next stage goes on.

const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const HAND = 'c'.repeat(40);
const EN_ONLY = 'd'.repeat(40);
const FIX = 'e'.repeat(40);
const OLD = 'a'.repeat(40);
const PAGE = 'docs/x/a.md';
const fmt = (s) => `${s.stage}${s.pr ? ` ${s.pr}` : ''}${s.to ? ` -> ${s.to}` : ''}`;
const DESC = [1, 2].map((n) => ({ n, list: 'description', stage: 'pr', page: PAGE, block: `Крок ${n}`, before: `було ${n}`, after: `стало ${n}`, at: ago(10), seq: n }));

// A branch whose commits the test sets: `diffs` maps a commit to the UA pages its own diff changed.
const vcs = (state) => ({
  branchCommits: () => state.commits,
  commitsBetween: (t, from, to) => state.between?.[`${from}..${to}`] ?? null,
  changedUnder: (t, from, to) => (from.endsWith('^') ? state.diffs[from.slice(0, -1)] ?? [] : state.changed?.[`${from}..${to}`] ?? []),
  imagesChanged: () => [],
  pagesOf: () => [],
});

const brief = (w, s, key) => briefFor({ ...s, role: 'writer', keys: [key] }, w.settings);

test('AC-3: a hand commit that changed UA gets one style check, listed with its pages; the same head, and the head after its fix, get none', async () => {
  const c = card({ number: 801, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 81, headCommit: HEAD });
  const state = { commits: [HEAD, EN_ONLY, HAND], diffs: { [HAND]: [PAGE], [EN_ONLY]: [] } };
  const w = world({ cards: [c], prs: [forgePr], git: vcs(state) });
  // HEAD is the pipeline's (an earlier answer); HAND changed UA by hand; EN_ONLY changed EN alone.
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 81, targets: ['guide'], review: 'sme', stage: 'finalReview', pipelineCommits: [HEAD.slice(0, 7)], edits: DESC }] });
  const s = (await w.one('801')).steps[0];
  assert.equal(fmt(s), 'styleCheck guide-docs#81');
  assert.deepEqual([s.role, s.commits, s.nextEdit], ['writer', [{ sha: HAND, pages: [PAGE] }], 3], 'only the UA commit, going on from the last number');
  const text = brief(w, s, '801');
  assert.ok(text.includes(`- ${HAND}: ${PAGE}`));
  assert.match(text, /Run the style check \(the writer role, "The style check"\) over the UA blocks each one changed/);
  assert.match(text, /Record every sha below in `reviewed`, fixed or not, with the reason its commit message gives/);
  assert.ok(text.includes('A numbered list of edits you post on this PR starts at 3'));

  // A record with no `reviewed` is a usage error; one with a list and no summary too.
  const rec = (result) => runRecord({ settings: w.settings, clients: w.clients(), key: '801', stage: 'styleCheck', status: 'done', pr: 'guide-docs#81', result, now: Date.now() });
  await assert.rejects(rec({}), (e) => e.exitCode === 2 && /"reviewed" lists every hand commit/.test(e.message));
  const one = { n: 3, page: PAGE, block: 'Крок 1', before: 'а', after: 'б', rule: 'r' };
  await assert.rejects(rec({ reviewed: [{ sha: HAND }], edits: [one], commits: [FIX] }), (e) => e.exitCode === 2 && /give "summary"/.test(e.message));
  await assert.rejects(rec({ reviewed: [{ sha: HAND }], summary: { id: 7801 }, edits: [one], posted: [7801] }), (e) => e.exitCode === 2 && /give the "commits" that pushed them/.test(e.message));
  await assert.rejects(rec({ reviewed: [{ sha: HAND }], summary: { id: 7801 }, edits: [one], commits: [FIX] }), (e) => e.exitCode === 2 && /the summary comment goes in "posted"/.test(e.message));
  assert.equal(read(w, '801').prs[0].styleChecked?.length ?? 0, 0, 'nothing written by a refused record');

  // The check fixed a rule the hand edit broke: its fix is a pipeline commit, the head moves to it.
  const fix = { n: 3, page: PAGE, block: 'Крок 1', before: 'Натисніть на кнопку **Зберегти**', after: 'Натисніть **Зберегти**', rule: 'gdsg: ui-elements §2' };
  await rec({ reviewed: [{ sha: HAND, reason: 'оператору не треба знати, що передав партнер' }], summary: { id: 7801 }, edits: [fix], commits: [FIX], posted: [7801] });
  const p = read(w, '801').prs[0];
  assert.deepEqual(p.styleChecked.map((x) => [x.sha, x.reason]), [[HAND, 'оператору не треба знати, що передав партнер']], 'the commit message\'s reason is kept with the sha');
  assert.deepEqual(p.edits.at(-1).rule, 'gdsg: ui-elements §2');
  assert.equal(p.edits.at(-1).list, '7801');
  forgePr.headCommit = FIX;
  state.commits = [FIX, HEAD, EN_ONLY, HAND];
  assert.deepEqual((await w.one('801')).steps, [], 'the head after the fix: no second check');
  // A later hand commit is checked on its own.
  const LATER = 'f'.repeat(40);
  forgePr.headCommit = LATER;
  state.commits = [LATER, FIX, HEAD, EN_ONLY, HAND];
  state.diffs[LATER] = [PAGE];
  assert.deepEqual((await w.one('801')).steps[0].commits, [{ sha: LATER, pages: [PAGE] }]);
});

test('AC-3: a check with nothing to fix records the sha, and the same head starts no second one', async () => {
  const c = card({ number: 802, status: 'smeReview' });
  const state = { commits: [HAND], diffs: { [HAND]: [PAGE] } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 82, headCommit: HAND })], git: vcs(state) });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 82, targets: ['guide'], review: 'sme', stage: 'smeReview' }] });
  assert.deepEqual((await w.one('802')).steps, [], 'at the expert review it waits for the owner\'s queue');
  c.placeId = LISTS.finalReview.id;
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 82, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  assert.equal(fmt((await w.one('802')).steps[0]), 'styleCheck guide-docs#82');
  await runRecord({ settings: w.settings, clients: w.clients(), key: '802', stage: 'styleCheck', status: 'done', pr: 'guide-docs#82', result: { reviewed: [{ sha: HAND.slice(0, 7) }] }, now: Date.now() });
  assert.deepEqual((await w.one('802')).steps, [], 'a short sha covers the commit');
});

test('the style check: an EN-only commit, a merge of the base and a commit before the ready head start none; new comments come first; a ready PR goes back to the queue first', async () => {
  // EN only, or a merge of the base (its own diff holds no page of the PR's: `changedUnder` with the base).
  const c1 = card({ number: 803, status: 'finalReview' });
  const w1 = world({ cards: [c1], prs: [pr({ repo: 'guide-docs', number: 83, headCommit: HAND })], git: vcs({ commits: [HAND, EN_ONLY], diffs: {} }) });
  ledger(w1, c1, { stages: BASE, prs: [{ repo: 'guide-docs', number: 83, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  assert.deepEqual((await w1.one('803')).steps, []);

  // Before the last ready head: that text went through the chain; only what came after it is checked.
  const c2 = card({ number: 804, status: 'finalReview' });
  const LATER = 'f'.repeat(40);
  const w2 = world({ cards: [c2], prs: [pr({ repo: 'guide-docs', number: 84, headCommit: LATER })], git: vcs({ commits: [LATER, OLD, HAND], diffs: { [HAND]: [PAGE], [LATER]: [PAGE] }, between: { [`${OLD}..${LATER}`]: [LATER] } }) });
  ledger(w2, c2, { stages: BASE, prs: [{ repo: 'guide-docs', number: 84, targets: ['guide'], review: 'sme', stage: 'finalReview', pipelineCommits: [OLD], readyForMerge: [{ head: OLD, at: ago(5), seq: 5 }] }] });
  assert.deepEqual((await w2.one('804')).steps[0].commits, [{ sha: LATER, pages: [PAGE] }]);

  // A ready PR whose UA a hand commit changed goes back to the owner's queue; the check follows there.
  const c3 = card({ number: 805, status: 'finalReview' });
  const w3 = world({ cards: [c3], prs: [pr({ repo: 'guide-docs', number: 85, headCommit: HAND })], git: vcs({ commits: [HAND], diffs: { [HAND]: [PAGE] }, changed: { [`${OLD}..${HAND}`]: [PAGE] }, between: { [`${OLD}..${HAND}`]: [HAND] } }) });
  ledger(w3, c3, { stages: BASE, prs: [{ repo: 'guide-docs', number: 85, targets: ['guide'], review: 'sme', stage: 'readyForMerge', readyForMerge: [{ head: OLD, at: ago(5), seq: 5 }] }] });
  assert.equal(fmt((await w3.one('805')).steps[0]), 'move guide-docs#85 -> finalReview');

  // New comments are answered first.
  const c4 = card({ number: 806, status: 'finalReview' });
  const w4 = world({ cards: [c4], prs: [pr({ repo: 'guide-docs', number: 86, headCommit: HAND })], git: vcs({ commits: [HAND], diffs: { [HAND]: [PAGE] } }), activity: { 'guide-docs#86': { comments: [{ id: 9801, author: 'owner-login', body: 'Коротше, будь ласка.', createdAt: ago(1), updatedAt: ago(1) }] } } });
  ledger(w4, c4, { stages: BASE, prs: [{ repo: 'guide-docs', number: 86, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  assert.equal(fmt((await w4.one('806')).steps[0]), 'answerComments guide-docs#86');
});

test('AC-1, AC-4: after the comments are applied the brief asks for the style check over their blocks; a fix is its own item, its «було» the owner\'s text, so a restore gives the owner\'s wording back', async () => {
  const c = card({ number: 807, status: 'finalReview' });
  const body = '```suggestion\nНатисніть на кнопку **Зберегти**, щоб зберегти зміни.\n```\nоператору не треба знати про партнера';
  const line = { id: 9811, author: 'owner-login', body, path: PAGE, line: 12, reviewId: 9810, createdAt: ago(1), updatedAt: ago(1) };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 87, headCommit: HEAD })], activity: { 'guide-docs#87': { reviews: [{ id: 9810, author: 'owner-login', state: 'COMMENTED', body: '', submittedAt: ago(1) }], threads: [{ id: 'th1', path: PAGE, line: 12, comments: [line] }] } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 87, targets: ['guide'], review: 'sme', stage: 'finalReview', edits: DESC }] });
  const s = (await w.one('807')).steps[0];
  assert.equal(fmt(s), 'answerComments guide-docs#87');
  const text = brief(w, s, '807');
  assert.match(text, /Once the comments are applied, the style check runs over the UA blocks they changed \(the writer role, "The style check"\), and over no other block: a block an item of the reply restores or keeps stays as the owner chose it\./);
  assert.match(text, /Its fixes go on the summary's numbered list after your edits, each with its `rule`; a fix that would change what the edit meant is not applied and is a note after the list, never numbered\./);
  // AC-4: a plain comment quoting a sentence with words removed is that sentence's replacement.
  assert.match(text, /A plain comment \(no `suggestion` block, no reply by number\) that quotes a sentence of the page with words removed or changed is the reviewer's replacement for that sentence: put it in as quoted/);

  // The summary as the writer records it: the suggestion applied (with the reason the comment gave), then the fix.
  const applied = { n: 3, page: PAGE, block: 'Крок 1', before: 'Натисніть **Зберегти**, яке партнер передав.', after: 'Натисніть на кнопку **Зберегти**, щоб зберегти зміни.', reason: 'оператору не треба знати про партнера' };
  const fix = { n: 4, page: PAGE, block: 'Крок 1', before: 'Натисніть на кнопку **Зберегти**, щоб зберегти зміни.', after: 'Натисніть **Зберегти**, щоб зберегти зміни.', rule: 'gdsg: ui-elements §2' };
  await runRecord({ settings: w.settings, clients: w.clients(), key: '807', stage: 'answerComments', status: 'done', pr: 'guide-docs#87', result: { handled: [{ id: 9811, updatedAt: ago(1), sort: 'owner' }], summary: { id: 7811 }, edits: [applied, fix], posted: [7811] }, now: Date.now() });
  const edits = read(w, '807').prs[0].edits;
  assert.deepEqual(edits.slice(-2).map((e) => [e.n, e.reason ?? null, e.rule ?? null]), [[3, 'оператору не треба знати про партнера', null], [4, null, 'gdsg: ui-elements §2']]);
  // «4 — поверни» puts back the owner's text, not the one before the owner's edit; «3 — поверни» is asked back.
  const undo = resolveReply(parseReply('4 — поверни'), edits)[0];
  assert.deepEqual([undo.do, undo.put, undo.now], ['restore', applied.after, fix.after]);
  assert.equal(resolveReply(parseReply('3 — поверни'), edits)[0].do, 'ask');
});

test('AC-2: a fix that would change what the edit meant is a note in the summary, never a numbered item', async () => {
  const c = card({ number: 808, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 88, headCommit: HEAD })] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 88, targets: ['guide'], review: 'sme', stage: 'finalReview', edits: DESC }] });
  const rec = (result) => runRecord({ settings: w.settings, clients: w.clients(), key: '808', stage: 'answerComments', status: 'done', pr: 'guide-docs#88', result, now: Date.now() });
  await assert.rejects(rec({ notes: [{ page: PAGE, block: 'Крок 1', text: 'x' }] }), (e) => e.exitCode === 2 && /give "summary"/.test(e.message));
  await rec({ notes: [] });
  const note = { page: PAGE, block: 'Крок 1', text: 'gdsg: wordiness: «для того, щоб» → «щоб» would drop the condition the owner added; left as written' };
  await rec({ summary: { id: 7821 }, edits: [], notes: [note], posted: [7821] });
  const l = read(w, '808');
  assert.deepEqual(l.summaries.at(-1).notes, [note]);
  assert.deepEqual(l.prs[0].edits.map((e) => e.n), [1, 2], 'no item for the note');
  assert.equal(resolveReply(parseReply('3 — поверни'), l.prs[0].edits)[0].do, 'ask', 'a number for a note is asked back');
});

test('a check that was running when the owner moved the card keeps its fixes: the record notes it, and the chain goes on with no move back', async () => {
  const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];
  const chain = Object.fromEntries(CHAIN.map((s, i) => [s, { status: 'done', head: OLD, seq: 10 + i }]));
  const c = card({ number: 809, status: 'translation' });
  const forgePr = pr({ repo: 'guide-docs', number: 89, headCommit: FIX });
  // The check read HAND in the queue; the owner moved the card while it ran, and the move's approval saw its fix FIX.
  const state = { commits: [FIX, HAND], diffs: { [HAND]: [PAGE], [FIX]: [PAGE] }, changed: { [`${OLD}..${FIX}`]: [PAGE] } };
  const w = world({ cards: [c], prs: [forgePr], git: vcs(state) });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 89, targets: ['guide'], review: 'sme', stage: 'translation', pipelineCommits: [OLD], chain, readyForMerge: [{ head: OLD, at: ago(5), seq: 5 }], approval: { head: FIX, at: ago(1) }, edits: DESC }] });
  const fix = { n: 3, page: PAGE, block: 'Крок 1', before: 'Натисніть на кнопку **Зберегти**', after: 'Натисніть **Зберегти**', rule: 'gdsg: ui-elements §2' };
  const out = await runRecord({ settings: w.settings, clients: w.clients(), key: '809', stage: 'styleCheck', status: 'done', pr: 'guide-docs#89', result: { reviewed: [{ sha: HAND }], summary: { id: 7891 }, edits: [fix], commits: [FIX], posted: [7891] }, now: Date.now() });
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /^style fixes landed after the card was moved on \(.+\): they are on the summary's numbered list \(comment 7891\) and can be undone by number$/);
  const l = read(w, '809');
  assert.deepEqual([l.log.at(-1).note, l.prs[0].steps.styleCheck.note], [out.warnings[0], out.warnings[0]]);
  assert.equal(fmt((await w.one('809')).steps[0]), 'resync guide-docs#89', 'the chain goes on with the fixes: no move back');
});

test('the owner\'s push, then move: a hand commit younger than 10 minutes waits; a block that undoes an earlier style fix is named for the session to leave out', async () => {
  const c = card({ number: 812, status: 'finalReview' });
  const dates = { [HAND]: { author: NOW - 5 * 60000, committer: NOW - 5 * 60000 } };
  const git = { ...vcs({ commits: [HAND], diffs: { [HAND]: [PAGE] } }), commitDates: (t, sha) => dates[sha] ?? null };
  const fix = { n: 3, list: '7801', stage: 'styleCheck', page: PAGE, block: 'Крок 1', before: 'Натисніть на кнопку **Зберегти**', after: 'Натисніть **Зберегти**', rule: 'gdsg: ui-elements §2', at: ago(10), seq: 3 };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 92, headCommit: HAND })], git });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 92, targets: ['guide'], review: 'sme', stage: 'finalReview', edits: [...DESC, fix] }] });
  const young = await w.one('812');
  assert.deepEqual(young.steps, [], 'too young: no session yet');
  assert.ok(young.notes.some((n) => /less than 10 minutes old/.test(n)), JSON.stringify(young.notes));
  dates[HAND] = { author: NOW - 11 * 60000, committer: NOW - 11 * 60000 };
  const s = (await w.one('812')).steps[0];
  assert.equal(fmt(s), 'styleCheck guide-docs#92');
  assert.deepEqual(s.fixes, [{ n: 3, page: PAGE, block: 'Крок 1', before: fix.before }]);
  const text = brief(w, s, '812');
  assert.match(text, /a block whose hand edit puts one's «було» back is the owner undoing that fix; leave the block out\./);
  assert.ok(text.includes(`- 3: ${PAGE}, Крок 1: "Натисніть на кнопку **Зберегти**"`));
});

test('a person\'s move is approval: hand commits the card was moved on with are recorded as seen, with no session and no bounce', async () => {
  const c = card({ number: 810, status: 'translation' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 90, headCommit: HAND })], git: vcs({ commits: [HAND], diffs: { [HAND]: [PAGE] } }) });
  const prOf = (extra) => [{ repo: 'guide-docs', number: 90, targets: ['guide'], review: 'sme', stage: 'translation', approval: { head: HAND, at: ago(1) }, ...extra }];
  ledger(w, c, { stages: BASE, prs: prOf() });
  const s = (await w.one('810')).steps[0];
  assert.deepEqual([fmt(s), s.role, s.skip, s.commits], ['styleCheck guide-docs#90', null, true, [{ sha: HAND, pages: [PAGE] }]], 'a scripted step, no writer session');
  // What the runner's scripted step records.
  await runRecord({ settings: w.settings, clients: w.clients(), key: '810', stage: 'styleCheck', status: 'done', pr: 'guide-docs#90', note: 'style check skipped: the card was moved on', result: { reviewed: [{ sha: HAND }], skipped: 'moved' }, now: Date.now() });
  const l = read(w, '810');
  assert.deepEqual(l.prs[0].styleChecked.map((x) => [x.sha, x.skipped]), [[HAND, 'moved']]);
  assert.equal(l.log.at(-1).note, 'style check skipped: the card was moved on');
  assert.equal(fmt((await w.one('810')).steps[0]), 'translate guide-docs#90', 'the chain goes on: no move back to the owner\'s queue');
});

test('styleCheck.since: a hand commit made before it counts as seen; a bad value is refused', async () => {
  const c = card({ number: 811, status: 'finalReview' });
  const LATER = 'f'.repeat(40);
  const dates = { [HAND]: Date.parse('2026-11-01T10:00:00Z'), [LATER]: Date.parse('2026-11-09T10:00:00Z') };
  const git = { ...vcs({ commits: [LATER, HAND], diffs: { [HAND]: [PAGE], [LATER]: [PAGE] } }), commitDates: (t, sha) => (dates[sha] ? { author: dates[sha], committer: 0 } : null) };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 91, headCommit: LATER })], git, extra: { styleCheck: { since: '2026-11-08T12:00:00Z' } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 91, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  assert.deepEqual((await w.one('811')).steps[0].commits, [{ sha: LATER, pages: [PAGE] }], 'only the commit after the cutoff');
  dates[LATER] = Date.parse('2026-11-02T10:00:00Z');
  assert.deepEqual((await w.one('811')).steps, [], 'every commit before the cutoff: no check');
  for (const since of ['2026-11-08', 'yesterday', 7]) assert.throws(() => settingsFor('/tmp/x', { styleCheck: { since } }), /styleCheck.since must be an ISO date-time/);
  assert.equal(settingsFor('/tmp/x').styleCheck.since, null, 'absent: no cutoff');
});
