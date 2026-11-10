import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, ago, card, pr, rawSettings, settingsFor, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { ROLE_DIR, briefFor, runDaily } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { afterTrigger, sortComments, unhandled } from '../lib/world.mjs';
import { parseReply, parseThreadReply, resolveReply } from '../lib/edits.mjs';
import { DEFAULT_LABELS, renderSections, rewriteDescription, sectionHash } from '../lib/pr-description.mjs';
import { followRounds, roundSnapshot } from '../lib/pr-rounds.mjs';
import { renderProgress } from '../lib/progress.mjs';

// A PR review round (D-142, TASK-097): the trigger word, a reply in the pipeline's own thread, two commits and one
// review per round, the live description, the place threads and the cleanup. An invented host: the owner is
// `owner-login`, the expert of the `guide` target `expert-one`, a colleague `colleague-two`.

const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const C1 = 'c1'.repeat(20);
const C2 = 'c2'.repeat(20);
const HEADER = '🤖 **[BOT]**';
const PAGE = 'docs/x/a.md';
const WORDS = ['helper', 'помічник'];
const ROUNDS = (extra = {}) => ({ commentHeader: HEADER, forge: { ...rawSettings().forge, triggerWords: WORDS, reviewRounds: { labels: { readers: { developer: 'For the developer', writer: 'For the writer' } } } }, ...extra });
const fmt = (s) => `${s.stage}${s.pr ? ` ${s.pr}` : ''}`;
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 'session-1', usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [] });
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const tree = () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const at = ago(1);
const comment = (id, author, body, extra = {}) => ({ id, author, body, createdAt: at, updatedAt: at, ...extra });

// ------------------------------------------------------------------ the trigger word (scope 5)

test('the trigger word: an owner\'s comment is for the pipeline only when it starts with a word and a colon, in any case, with a space before the colon; the word is cut off', () => {
  for (const body of ['helper: поверни', 'Helper : поверни', '  HELPER:поверни', 'помічник: поверни', 'ПОМІЧНИК :  поверни']) assert.equal(afterTrigger(body, WORDS)?.trim(), 'поверни', body);
  for (const body of ['поверни', 'helper поверни', 'my helper: поверни', '@helper: поверни', 'helpers: поверни']) assert.equal(afterTrigger(body, WORDS), null, body);
  assert.equal(afterTrigger('helper: x', []), null, 'no words set: no word to find');
});

test('AC-3: with the words set, the owner\'s comment without one starts nothing; with one it is read with the word cut off; an expert\'s needs none; a colleague\'s is listed for the owner', () => {
  const ledger = { posted: { pr: [] }, reviewComments: [] };
  const p = { repo: 'guide-docs', number: 7 };
  const activity = {
    comments: [comment(1, 'owner-login', 'helper: 2 — поверни'), comment(2, 'owner-login', 'A note to myself.'), comment(3, 'expert-one', 'The limit is 50, not 100.'), comment(4, 'colleague-two', 'Looks odd to me.'), comment(5, 'Expert-One', 'Case does not matter.')],
    threads: [{ id: 'T1', comments: [comment(10, 'owner-login', 'A thread of my own', { reviewId: 50 }), comment(11, 'owner-login', '@expert-one check this, please', { reviewId: 51 }), comment(12, 'owner-login', 'Under a worded review', { reviewId: 52 })] }],
    reviews: [{ id: 52, author: 'owner-login', state: 'COMMENTED', body: 'Helper: these two lines', submittedAt: at }],
  };
  const sorted = sortComments(ledger, p, activity, 'owner-login', HEADER, { words: WORDS, experts: ['expert-one'] });
  assert.deepEqual(sorted.items.map((c) => [c.id, c.by, c.body]), [
    [12, 'owner', 'Under a worded review'],
    [1, 'owner', '2 — поверни'],
    [3, 'reviewer', 'The limit is 50, not 100.'],
    [5, 'reviewer', 'Case does not matter.'],
    [52, 'owner', 'these two lines'],
  ]);
  assert.deepEqual(sorted.others.map((c) => [c.id, c.author]), [[4, 'colleague-two']]);
  assert.equal(sorted.others[0].body, undefined, 'the list for the owner carries no text');
  // No words set: today's behaviour, every comment that isn't the owner's is a reviewer's.
  const plain = unhandled(ledger, p, activity, 'owner-login', HEADER);
  assert.deepEqual(plain.map((c) => [c.id, c.by]), [[10, 'owner'], [11, 'owner'], [12, 'owner'], [1, 'owner'], [2, 'owner'], [3, 'reviewer'], [4, 'reviewer'], [5, 'reviewer'], [52, 'owner']]);
  assert.equal(plain.find((c) => c.id === 1).body, 'helper: 2 — поверни', 'the text as written');
});

test('AC-3: a colleague\'s comment starts no session and is listed in the progress file\'s «Waiting for you», with a link; an expert\'s starts one', async () => {
  const c = card({ number: 971, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 71, headCommit: HEAD })], activity: { 'guide-docs#71': { comments: [comment(4, 'colleague-two', 'Looks odd to me.')] } }, extra: ROUNDS() });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 71, url: 'https://forge.example/acme/guide-docs/pull/71', targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const st = await w.status();
  const t = st.tickets.find((x) => x.key === '971');
  assert.deepEqual(t.steps, [], 'nothing to answer');
  assert.deepEqual(t.prs[0].others, [{ id: 4, kind: 'comment', author: 'colleague-two', at, link: 'https://forge.example/acme/guide-docs/pull/71#issuecomment-4' }]);
  const text = renderProgress({ ledgers: [read(w, '971')], memory: { others: { '971|guide-docs#71': t.prs[0].others } }, now: NOW });
  assert.match(text, /## Waiting for you\n\n[\s\S]*- 💬 971 — guide-docs#71: a comment of colleague-two's the pipeline doesn't take \(https:\/\/forge\.example\/acme\/guide-docs\/pull\/71#issuecomment-4\): hand it on/);
  w.forge.activity['guide-docs#71'].comments.push(comment(5, 'expert-one', 'Wrong limit.'));
  assert.deepEqual((await w.one('971')).steps.map(fmt), ['answerComments guide-docs#71']);
});

test('the settings: the trigger words are words with no space or colon; the review rounds take the host\'s labels over the default ones', () => {
  const root = tmp();
  const s = settingsFor(root, ROUNDS());
  assert.deepEqual(s.triggerWords, WORDS);
  assert.equal(s.reviewRounds.labels.resolved, DEFAULT_LABELS.resolved);
  assert.equal(s.reviewRounds.labels.readers.developer, 'For the developer');
  assert.equal(s.reviewRounds.labels.stages.pr, DEFAULT_LABELS.stages.pr);
  const none = settingsFor(root);
  assert.deepEqual([none.triggerWords, none.reviewRounds], [[], null], 'none set: today\'s behaviour');
  assert.throws(() => settingsFor(root, { forge: { ...rawSettings().forge, triggerWords: ['two words'] } }), /triggerWords/);
  assert.throws(() => settingsFor(root, { forge: { ...rawSettings().forge, triggerWords: 'helper' } }), /triggerWords/);
  assert.throws(() => settingsFor(root, { forge: { ...rawSettings().forge, reviewRounds: { labels: { resolved: '' } } } }), /reviewRounds\.labels\.resolved/);
});

// ------------------------------------------------------------------ a reply in the pipeline's thread (scope 4)

test('a reply in a thread is read with the reply by number\'s words: a restore, an assent, the owner\'s text, a description; a restore with its reason is a restore', () => {
  const kind = (body) => { const r = parseThreadReply(body); return [r.kind, r.reason ?? null]; };
  assert.deepEqual(kind('поверни'), ['restore', null]);
  assert.deepEqual(kind('поверни як було, тут наголос на книжці, а не на читачеві.'), ['restore', 'тут наголос на книжці, а не на читачеві.']);
  assert.deepEqual(kind('ок'), ['keep', null]);
  assert.deepEqual(kind('залиш: так краще'), ['keep', 'так краще']);
  assert.deepEqual(kind('«Читач обирає книжку»'), ['verbatim', null]);
  assert.deepEqual(kind('зроби коротше, без слова «також»'), ['describe', null]);
  assert.deepEqual(kind('> a quoted line\nповерни'), ['restore', null], 'a quoted line is not the owner\'s words');
  // The reply by number's grammar is the same as before (AC-8): a thread's reply changes none of it.
  assert.equal(parseReply('поверни'), null, 'no number: no reply by number');
});

const STYLE_ITEM = { n: 4, list: '6100', stage: 'answerComments', page: PAGE, block: 'Крок 2', before: 'Книжку обирає читач.', after: 'Читач обирає книжку.', rule: 'gdsg: word order', commentId: 7201, at: ago(5), seq: 4 };
const roundLedger = (w, c, { prExtra = {}, ...extra } = {}) => ledger(w, c, {
  stages: BASE,
  prs: [{ repo: 'guide-docs', number: 81, url: 'https://forge.example/acme/guide-docs/pull/81', targets: ['guide'], review: 'sme', stage: 'finalReview', edits: [{ n: 1, list: 'description', stage: 'pr', page: PAGE, block: 'Крок 1', before: 'а', after: 'б', at: ago(9), seq: 1 }, { ...STYLE_ITEM, n: 4, list: '6999', commentId: undefined, before: 'інше', after: 'інше2' }, STYLE_ITEM], ...prExtra }],
  posted: { pr: [6100, 7201, 7301], card: [] },
  places: [{ id: 'p1', repo: 'guide-docs', pr: 81, page: PAGE, line: 12, claim: 'The limit is 50 for every method', state: 'open', commentId: 7301 }],
  ...extra,
});
const thread = (rootId, rootBody, replies) => ({ id: `T${rootId}`, resolved: false, comments: [comment(rootId, 'owner-login', `${HEADER}\n\n${rootBody}`, { reviewId: 6100 }), ...replies] });

test('AC-3: «helper: поверни» in a style fix\'s thread restores that item\'s exact «було», answered in the thread and never settled; a reply without the word starts nothing', async () => {
  const c = card({ number: 981, status: 'finalReview' });
  const replies = [comment(7202, 'owner-login', 'helper: поверни як було, тут наголос на книжці.', { reviewId: 6200, inReplyTo: 7201 })];
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { threads: [thread(7201, '«Книжку обирає…» → «Читач обирає…»', replies)] } }, extra: ROUNDS() });
  roundLedger(w, c);
  const s = (await w.one('981')).steps[0];
  assert.equal(fmt(s), 'answerComments guide-docs#81');
  assert.deepEqual(s.threadReplies, [{ id: 7202, n: 4, do: 'restore', page: PAGE, block: 'Крок 2', now: 'Читач обирає книжку.', put: 'Книжку обирає читач.', reason: 'тут наголос на книжці.' }], 'the item its thread was posted for, not the other list\'s item 4');
  const brief = briefFor({ ...s, role: 'writer', keys: ['981'] }, w.settings);
  assert.ok(brief.includes(`- 4, restore: ${PAGE}, Крок 2: put back "Книжку обирає читач." where it reads "Читач обирає книжку.". (reply 7202); the owner's reason: "тут наголос на книжці."`));
  assert.match(brief, /Then answer in that thread \(`forge\.mjs reply --comment <the reply's id>`\): what you did and the commit, in a line\. Never settle \(resolve\) such a thread: the owner does\./);
  assert.match(brief, /a restore is an edit of its own with `restores`/);

  // The same reply with no word, a tag of the expert: nothing starts.
  w.forge.activity['guide-docs#81'].threads[0].comments[1] = comment(7202, 'owner-login', '@expert-one глянь, будь ласка', { reviewId: 6200, inReplyTo: 7201 });
  assert.deepEqual((await w.one('981')).steps, []);
});

test('a reply in a place\'s thread is the answer to that place only when it is the owner\'s with the word (decision 3): the owner\'s with no word starts nothing, an expert\'s and a colleague\'s there are listed for the owner', async () => {
  const c = card({ number: 982, status: 'finalReview' });
  const replies = [
    comment(7304, 'owner-login', '@expert-one check this, please', { reviewId: 6299 }),
    comment(7302, 'expert-one', 'Yes, for every method but one.', { reviewId: 6300 }),
    comment(7305, 'colleague-two', 'I think so too.', { reviewId: 6302 }),
    comment(7303, 'owner-login', 'helper: the expert confirmed it, leave it.', { reviewId: 6301 }),
  ];
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { threads: [thread(7301, 'A place to check', replies)] } }, extra: ROUNDS() });
  roundLedger(w, c);
  const t = await w.one('982');
  const s = t.steps[0];
  assert.deepEqual(s.placeReplies.map((r) => [r.id, r.place, r.by, r.text]), [[7303, 'p1', 'owner', 'the expert confirmed it, leave it.']]);
  assert.deepEqual(t.prs[0].others.map((x) => [x.id, x.author]), [[7302, 'expert-one'], [7305, 'colleague-two']], 'the expert the owner tagged and the colleague, listed for the owner');
  assert.equal(s.threadReplies, undefined, 'no item\'s thread');
  assert.deepEqual(s.take.map((x) => x.id), [7303], 'the session takes the owner\'s worded reply only');
  const brief = briefFor({ ...s, role: 'writer', keys: ['982'] }, w.settings);
  assert.match(brief, /record that reply's id as the place's `replyId`: the runner then settles the thread\. Never settle a thread yourself\./);
  assert.ok(brief.includes('- reply 7303, place p1 (docs/x/a.md, line 12, now open): "the expert confirmed it, leave it."'));
  assert.ok(!brief.includes('- review-comment 7302') && !brief.includes('an expert\'s need none'), 'the expert\'s reply is not a comment the step takes');
  assert.ok(brief.includes('- review-comment 7303 by the owner: "the expert confirmed it, leave it."\n  - earlier in its thread, your line comment: "A place to check"\n  - earlier in its thread, the owner: "@expert-one check this, please"\n  - earlier in its thread, expert-one: "Yes, for every method but one."'), 'it is read as the thread the owner\'s reply points at');
  // Only the expert's reply, with no owner's word: nothing starts.
  w.forge.activity['guide-docs#81'].threads[0].comments = w.forge.activity['guide-docs#81'].threads[0].comments.filter((x) => x.id === 7301 || x.id === 7302);
  assert.deepEqual((await w.one('982')).steps, []);
});

test('the trigger word after a quote: a "Quote reply" starts with the quoted lines, and the word is read on the first line after them', () => {
  assert.equal(afterTrigger('> «Книжку обирає читач.»\n> the line\n\nhelper: поверни', WORDS), '> «Книжку обирає читач.»\n> the line\n\nповерни');
  assert.equal(parseThreadReply(afterTrigger('> quoted\nhelper: поверни', WORDS)).kind, 'restore');
  assert.equal(afterTrigger('> helper: a quoted word is not the owner\'s', WORDS), null);
  assert.equal(afterTrigger('> quoted\nno word here', WORDS), null);
});

test('with the trigger words, the brief lists the comments the step takes, word cut off, and says every other is for people', async () => {
  const c = card({ number: 983, status: 'finalReview' });
  const activity = { comments: [comment(5101, 'owner-login', 'helper: shorten step 2'), comment(5102, 'owner-login', 'A note for the expert.'), comment(5103, 'colleague-two', 'Step 3 reads oddly.'), comment(5104, 'expert-one', 'The limit is 50.')] };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': activity }, extra: ROUNDS() });
  roundLedger(w, c);
  const s = (await w.one('983')).steps[0];
  assert.deepEqual(s.take.map((x) => [x.id, x.by, x.text]), [[5101, 'owner', 'shorten step 2'], [5104, 'reviewer', 'The limit is 50.']]);
  const brief = briefFor({ ...s, role: 'writer', keys: ['983'] }, w.settings);
  assert.ok(brief.includes('- comment 5101 by the owner: "shorten step 2"'));
  assert.ok(brief.includes('- comment 5104 by the expert expert-one: "The limit is 50."'));
  assert.match(brief, /Every other new comment on the PR, the owner's without the word, a colleague's, a reply in a thread an expert didn't open by anyone but the owner \(an expert's answer in your own or the owner's thread too\), is for people: don't act on it, don't answer it, and don't record it in `handled`/);
  assert.match(brief, /One exception: a comment the owner's worded comment hands on, by pointing at it .* record its id in `handled` too, so it leaves the owner's list\./);
  assert.ok(!brief.includes('A note for the expert.') && !brief.includes('Step 3 reads oddly.'));
  // No words set: no such list, the brief as before.
  const plain = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': activity } });
  roundLedger(plain, c);
  const s2 = (await plain.one('983')).steps[0];
  assert.equal(s2.take, undefined);
  assert.ok(!briefFor({ ...s2, role: 'writer', keys: ['983'] }, plain.settings).includes('The comments this step takes'));
});

test('a colleague\'s comment stays listed for the owner until it is handed on: its own id handled, not any later worded comment of the owner\'s', async () => {
  const c = card({ number: 984, status: 'finalReview' });
  const later = new Date(Date.parse(at) + 60000).toISOString();
  const activity = { comments: [comment(5201, 'colleague-two', 'Step 3 reads oddly.'), comment(5203, 'colleague-two', 'And step 4.'), { ...comment(5202, 'owner-login', 'helper: take the comment about step 3 into account'), createdAt: later, updatedAt: later }] };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': activity }, extra: ROUNDS() });
  roundLedger(w, c);
  assert.deepEqual((await w.one('984')).prs[0].others.map((x) => x.id), [5201, 5203], 'listed while the owner\'s hand-on is not handled yet');
  roundLedger(w, c, { reviewComments: [{ repo: 'guide-docs', pr: 81, id: 5202, updatedAt: later, at: later }] });
  assert.deepEqual((await w.one('984')).prs[0].others.map((x) => x.id), [5201, 5203], 'a later worded comment alone hands nothing on');
  roundLedger(w, c, { reviewComments: [{ repo: 'guide-docs', pr: 81, id: 5202, updatedAt: later, at: later }, { repo: 'guide-docs', pr: 81, id: 5201, updatedAt: at, at: later }] });
  assert.deepEqual((await w.one('984')).prs[0].others.map((x) => x.id), [5203], 'the one the session took with it is off the list; the other stays');
});

test('an expert\'s reply in the owner\'s own thread starts nothing; the owner\'s worded reply under it does, with the thread for the session to read; the answer leaves the list once the session records it', async () => {
  const c = card({ number: 985, status: 'finalReview' });
  const t1 = (n) => new Date(Date.parse(at) + n * 60000).toISOString();
  const own = { id: 'T8001', resolved: false, path: PAGE, line: 20, comments: [
    comment(8001, 'owner-login', '@expert-one is the limit right here?', { reviewId: 6400, path: PAGE, line: 20, createdAt: t1(0), updatedAt: t1(0) }),
    comment(8002, 'expert-one', 'No, it is 50 for cards.', { reviewId: 6401, inReplyTo: 8001, createdAt: t1(1), updatedAt: t1(1) }),
  ] };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { threads: [own] } }, extra: ROUNDS() });
  roundLedger(w, c);
  let t = await w.one('985');
  assert.deepEqual(t.steps, [], 'the expert\'s answer in the owner\'s thread starts no session');
  assert.deepEqual(t.prs[0].others.map((x) => [x.id, x.author]), [[8002, 'expert-one']], 'listed for the owner');
  own.comments.push(comment(8003, 'owner-login', 'helper: зроби, як каже експерт', { reviewId: 6402, inReplyTo: 8001, createdAt: t1(2), updatedAt: t1(2) }));
  t = await w.one('985');
  const s = t.steps[0];
  assert.equal(s.stage, 'answerComments');
  assert.deepEqual(s.take.map((x) => [x.id, x.text]), [[8003, 'зроби, як каже експерт']], 'the session takes the owner\'s worded reply only');
  assert.deepEqual(s.take[0].context, [{ by: 'owner', author: 'owner-login', text: '@expert-one is the limit right here?' }, { by: 'other', author: 'expert-one', text: 'No, it is 50 for cards.' }]);
  const brief = briefFor({ ...s, role: 'writer', keys: ['985'] }, w.settings);
  assert.ok(brief.includes('- review-comment 8003 by the owner on docs/x/a.md:20: "зроби, як каже експерт"\n  - earlier in its thread, the owner: "@expert-one is the limit right here?"\n  - earlier in its thread, expert-one: "No, it is 50 for cards."'));
  roundLedger(w, c, { reviewComments: [{ repo: 'guide-docs', pr: 81, id: 8003, updatedAt: t1(2), at: t1(3) }] });
  t = await w.one('985');
  assert.deepEqual(t.steps, []);
  assert.deepEqual(t.prs[0].others.map((x) => x.id), [8002], 'a reply after it hands nothing on by itself: a forge thread is flat');
  roundLedger(w, c, { reviewComments: [{ repo: 'guide-docs', pr: 81, id: 8003, updatedAt: t1(2), at: t1(3) }, { repo: 'guide-docs', pr: 81, id: 8002, updatedAt: t1(1), at: t1(3) }] });
  t = await w.one('985');
  assert.equal(t.prs[0].others, undefined, 'the session took it with the owner\'s reply that points at it, and recorded it');
  // The expert corrects the answer after that: it is new again, for the owner.
  own.comments[1] = { ...own.comments[1], body: 'Sorry, 40 for cards.', updatedAt: t1(4) };
  assert.deepEqual((await w.one('985')).prs[0].others.map((x) => x.id), [8002]);
});

test('the owner\'s «поверни» under the pipeline\'s line comment hands on no expert\'s remark above it', async () => {
  const c = card({ number: 987, status: 'finalReview' });
  const replies = [comment(7212, 'expert-one', 'I would rather say X.', { reviewId: 6210, inReplyTo: 7201 }), comment(7213, 'owner-login', 'helper: поверни', { reviewId: 6211, inReplyTo: 7201 })];
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { threads: [thread(7201, '«Книжку обирає…» → «Читач обирає…»', replies)] } }, extra: ROUNDS() });
  roundLedger(w, c, { reviewComments: [{ repo: 'guide-docs', pr: 81, id: 7213, updatedAt: at, at }] });
  assert.deepEqual((await w.one('987')).prs[0].others.map((x) => x.id), [7212]);
  const brief = briefFor({ ...(await (async () => { roundLedger(w, c); return (await w.one('987')).steps[0]; })()), role: 'writer', keys: ['987'] }, w.settings);
  assert.match(brief, /A reply that only comes after it in a thread hands nothing on: «поверни», a quoted text or «ок» under your line comment is about your item/);
});

test('who opened a thread: a thread whose first comment was deleted starts with a reply and is no one\'s; the owner listed as an expert opens no expert\'s thread; logins compare case-blind', () => {
  const l = { posted: { pr: [] }, reviewComments: [] };
  const p = { repo: 'guide-docs', number: 81 };
  const threads = [
    { id: 'A', comments: [comment(1, 'expert-one', 'Under a deleted comment.', { inReplyTo: 99 })] },
    { id: 'B', comments: [comment(2, 'owner-login', 'A question.'), comment(3, 'expert-one', 'An answer.', { inReplyTo: 2 })] },
    { id: 'C', comments: [comment(4, 'Owner-Login', 'helper: shorten it')] },
  ];
  const sorted = sortComments(l, p, { threads }, 'owner-login', HEADER, { words: WORDS, experts: ['expert-one', 'owner-login'] });
  assert.deepEqual(sorted.items.map((x) => x.id), [4], 'the owner\'s worded comment, whatever the case of the login');
  assert.deepEqual(sorted.others.map((x) => x.id), [1, 3]);
});

test('the context of a long thread keeps its first comment; a login that reads like a marker stays a login', () => {
  const l = { posted: { pr: [10] }, reviewComments: [] };
  const p = { repo: 'guide-docs', number: 81 };
  const list = [comment(10, 'owner-login', `${HEADER}\n\nThe item.`), ...Array.from({ length: 10 }, (_, k) => comment(11 + k, k % 2 ? 'pipeline' : 'colleague-two', `remark ${k}`, { inReplyTo: 10 })), comment(30, 'owner-login', 'helper: ок', { inReplyTo: 10 })];
  const sorted = sortComments(l, p, { threads: [{ id: 'T', comments: list }] }, 'owner-login', HEADER, { words: WORDS, experts: [] });
  const ctx = sorted.items.find((x) => x.id === 30).context;
  assert.equal(ctx.length, 8);
  assert.deepEqual(ctx[0], { by: 'pipeline', author: 'owner-login', text: 'The item.' });
  assert.deepEqual(ctx.slice(1).map((x) => x.text), ['remark 3', 'remark 4', 'remark 5', 'remark 6', 'remark 7', 'remark 8', 'remark 9']);
  assert.deepEqual(ctx[1], { by: 'other', author: 'pipeline', text: 'remark 3' });
});

test('in a thread an expert opened, an expert\'s reply needs no word; in a colleague\'s thread it is for people', async () => {
  const c = card({ number: 986, status: 'finalReview' });
  const threads = [
    { id: 'T8101', resolved: false, comments: [comment(8101, 'expert-one', 'Step 2 is wrong.', { reviewId: 6500, path: PAGE, line: 5 }), comment(8102, 'expert-one', 'It should be step 3.', { reviewId: 6501, inReplyTo: 8101 })] },
    { id: 'T8201', resolved: false, comments: [comment(8201, 'colleague-two', 'Odd wording.', { reviewId: 6502, path: PAGE, line: 9 }), comment(8202, 'expert-one', 'Agreed.', { reviewId: 6503, inReplyTo: 8201 })] },
  ];
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { threads } }, extra: ROUNDS() });
  roundLedger(w, c);
  const t = await w.one('986');
  assert.deepEqual(t.steps[0].take.map((x) => x.id), [8101, 8102]);
  assert.equal(t.steps[0].take[0].context, undefined, 'the thread\'s first comment has no earlier one');
  assert.deepEqual(t.prs[0].others.map((x) => x.id), [8201, 8202]);
});

// ------------------------------------------------------------------ the round's record (scopes 1–3, AC-1)

const ROUND_EDITS = [
  { n: 5, page: PAGE, block: 'Крок 3', before: 'Не передавайте разом з shelfName: API повертає помилку.', after: 'Не передавайте разом з shelfName.', reason: 'errors are listed below' },
  { n: 6, page: PAGE, block: 'Крок 3', before: 'з shelfName та з loanMode', after: 'з shelfName або з loanMode', commentId: 7401 },
  { n: 7, page: PAGE, block: 'Крок 3', before: 'з shelfName або з loanMode', after: 'з shelfName або з параметром loanMode', rule: 'ua-grammar: conjunction', commentId: 7402 },
  { n: 8, page: PAGE, block: 'Крок 4', before: '"Оберіть книжку"', after: '«Оберіть книжку»', rule: 'quotes', mechanical: true },
  { n: 9, page: PAGE, block: 'Крок 4', before: 'книжку - список', after: 'книжку — список', rule: 'dash', mechanical: true },
];

test('AC-1: a round with an instruction done word for word, one interpreted, one substantive and two mechanical fixes: commit 1 and commit 2, one review, a line comment for the interpreted instruction and the substantive fix only', async () => {
  const c = card({ number: 983, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], extra: ROUNDS() });
  roundLedger(w, c);
  const result = {
    handled: [{ id: 7202, updatedAt: at }],
    review: { id: 7400, commits: [{ sha: C1.slice(0, 7), role: 'comments' }, { sha: C2.slice(0, 7), role: 'style' }] },
    commits: [C1, C2],
    edits: ROUND_EDITS,
    questions: [],
    answered: [{ n: 2, answer: 'No, the developer answered', link: 'https://forge.example/acme/guide-docs/pull/81#issuecomment-9' }],
    posted: [{ kind: 'review', id: 7400 }, { kind: 'review-comment', id: 7401 }, { kind: 'review-comment', id: 7402 }],
  };
  const rec = (r) => runRecord({ settings: w.settings, clients: w.clients(), key: '983', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', result: JSON.stringify(r), now: NOW });
  // What the record refuses: a substantive fix with no line comment, a mechanical one with one, a comment not posted, a
  // round with no style commit for its style fixes, a review not in `posted`, and no `questions`.
  const swap = (n, over) => ({ ...result, edits: ROUND_EDITS.map((e) => (e.n === n ? { ...e, ...over } : e)) });
  await assert.rejects(rec(swap(7, { commentId: undefined })), (e) => e.exitCode === 2 && /item 7 is a substantive style fix: give the "commentId"/.test(e.message));
  await assert.rejects(rec(swap(8, { commentId: 7402 })), (e) => e.exitCode === 2 && /item 8 is a mechanical fix: it is folded in the review's text/.test(e.message));
  await assert.rejects(rec(swap(6, { commentId: 9999 })), (e) => e.exitCode === 2 && /item 6's line comment 9999 is not in "posted"/.test(e.message));
  await assert.rejects(rec({ ...result, review: { id: 7400, commits: [result.review.commits[0]] } }), (e) => e.exitCode === 2 && /the style fixes are the "style" commit/.test(e.message));
  await assert.rejects(rec({ ...result, review: { ...result.review, commits: [...result.review.commits, { sha: 'f'.repeat(7), role: 'style' }] } }), (e) => e.exitCode === 2 && /one "style" commit a round/.test(e.message));
  await assert.rejects(rec({ ...result, posted: result.posted.slice(1) }), (e) => e.exitCode === 2 && /the round's review 7400 goes in "posted"/.test(e.message));
  await assert.rejects(rec({ ...result, questions: undefined }), (e) => e.exitCode === 2 && /give "questions"/.test(e.message));
  assert.equal(read(w, '983').prs[0].rounds, undefined, 'nothing written by a refused record');

  await rec(result);
  const p = read(w, '983').prs[0];
  assert.deepEqual(p.rounds, [{ n: 1, stage: 'answerComments', at: new Date(NOW).toISOString(), seq: p.rounds[0].seq, commits: [{ sha: C1.slice(0, 7), role: 'comments' }, { sha: C2.slice(0, 7), role: 'style' }], review: 7400, comments: 2 }]);
  const items = p.edits.filter((e) => e.list === '7400');
  assert.deepEqual(items.map((e) => [e.n, e.commentId ?? null, e.mechanical ?? false]), [[5, null, false], [6, 7401, false], [7, 7402, false], [8, null, true], [9, null, true]]);
  assert.equal(items[0].reason, 'errors are listed below', "the learning from the owner's edits keeps the reason");
  assert.equal(items[2].rule, 'ua-grammar: conjunction');
  // The reply by number reads the new items as any other (AC-8).
  assert.deepEqual(resolveReply(parseReply('7 — поверни'), p.edits).map((x) => [x.n, x.do, x.put]), [[7, 'restore', 'з shelfName або з loanMode']]);
});

test('a restore of a style fix is recorded as its rule rejected for that block (the learning from the owner\'s edits)', async () => {
  const c = card({ number: 984, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], extra: ROUNDS() });
  roundLedger(w, c);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '984', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({
    handled: [{ id: 7202, updatedAt: at, replyId: 7203 }],
    review: { id: 7500, commits: [{ sha: C1.slice(0, 7), role: 'comments' }] },
    commits: [C1],
    edits: [{ n: 5, page: PAGE, block: 'Крок 2', before: 'Читач обирає книжку.', after: 'Книжку обирає читач.', restores: 4, reason: 'тут наголос на книжці.' }],
    questions: [],
    posted: [7500, 7203],
  }) });
  const p = read(w, '984').prs[0];
  const undone = p.edits.filter((e) => e.n === 4).at(-1);
  assert.deepEqual([undone.rule, undone.rejected?.by], ['gdsg: word order', 5]);
  assert.equal(p.edits.find((e) => e.n === 4 && e.list === '6999').rejected, undefined, 'only the item the thread was about');
});

test('a hand commit\'s style check posts its round the same way: one commit, one review, a fix not applied with its line comment', async () => {
  const c = card({ number: 985, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], extra: ROUNDS() });
  roundLedger(w, c);
  const rec = (r) => runRecord({ settings: w.settings, clients: w.clients(), key: '985', stage: 'styleCheck', pr: 'guide-docs#81', status: 'done', result: JSON.stringify(r), now: NOW });
  const base = { reviewed: [{ sha: C1, reason: 'clearer' }], review: { id: 7600, commits: [{ sha: C2.slice(0, 7), role: 'style' }] }, commits: [C2], edits: [{ n: 5, page: PAGE, block: 'Крок 1', before: 'Якщо передати true то', after: 'Якщо передати true,', rule: 'ua-grammar: comma', commentId: 7601 }], notes: [{ page: PAGE, block: 'Помилки', text: 'placeholder rule left: the API text', commentId: 7602 }], posted: [7600, 7601, 7602] };
  await assert.rejects(rec({ ...base, summary: { id: 1 } }), (e) => e.exitCode === 2 && /not both/.test(e.message));
  await assert.rejects(rec({ ...base, notes: [{ ...base.notes[0], commentId: 1 }] }), (e) => e.exitCode === 2 && /a note's line comment 1 is not in "posted"/.test(e.message));
  await rec(base);
  const p = read(w, '985').prs[0];
  assert.deepEqual(p.rounds.map((r) => [r.stage, r.review, r.comments, r.commits.map((x) => x.role)]), [['styleCheck', 7600, 2, ['style']]]);
  assert.deepEqual(p.styleChecked.map((x) => x.sha), [C1]);
  assert.equal(p.edits.at(-1).list, '7600');
});

// ------------------------------------------------------------------ the EN stage (scope 9, AC-7)

test('AC-7: the EN review posts its round like a UA one: its items are the review\'s, not the description\'s list; without the rounds, the description\'s list as before', async () => {
  const c = card({ number: 986, status: 'translation' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], extra: ROUNDS() });
  roundLedger(w, c, { prs: [{ repo: 'guide-docs', number: 81, url: 'https://forge.example/acme/guide-docs/pull/81', targets: ['guide'], review: 'sme', stage: 'translation', chain: { translate: { status: 'done', head: HEAD } }, edits: [] }] });
  const en = { n: 1, page: 'i18n/en/x/a.md', block: 'Step 1', before: 'will contain', after: 'contains', rule: 'gdsg: present tense', commentId: 7701 };
  const rec = (r) => runRecord({ settings: w.settings, clients: w.clients(), key: '986', stage: 'enReview', pr: 'guide-docs#81', status: 'done', head: HEAD, result: JSON.stringify(r), now: NOW });
  await rec({ commits: [C2], review: { id: 7700, commits: [{ sha: C2.slice(0, 7), role: 'style' }] }, edits: [en], asked: [{ text: 'Is «widget» the term here?', reader: 'writer' }], posted: [7700, 7701] });
  const p = read(w, '986').prs[0];
  assert.deepEqual(p.edits.map((e) => [e.n, e.list, e.commentId]), [[1, '7700', 7701]]);
  assert.deepEqual(p.rounds.map((r) => [r.stage, r.review]), [['enReview', 7700]]);
  assert.deepEqual(p.questions.map((q) => [q.n, q.reader, q.text]), [[1, 'writer', 'Is «widget» the term here?']]);

  const c2 = card({ number: 987, status: 'translation' });
  const old = world({ cards: [c2], prs: [pr({ repo: 'guide-docs', number: 82, headCommit: HEAD })] });
  ledger(old, c2, { key: '987', stages: BASE, prs: [{ repo: 'guide-docs', number: 82, targets: ['guide'], review: 'sme', stage: 'translation', chain: { translate: { status: 'done', head: HEAD } } }] });
  await runRecord({ settings: old.settings, clients: old.clients(), key: '987', stage: 'enReview', pr: 'guide-docs#82', status: 'done', head: HEAD, result: JSON.stringify({ commits: [C2], edits: [{ ...en, commentId: undefined }] }), now: NOW });
  assert.deepEqual(read(old, '987').prs[0].edits.map((e) => e.list), ['description']);
});

test('AC-7: the further locales post nothing on lines: the brief of the locales stage has no round', () => {
  const s = settingsFor(tmp(), ROUNDS());
  const brief = briefFor({ stage: 'locales', role: 'translator', keys: ['1'], pr: 'guide-docs#81' }, s);
  assert.ok(!/review-on-lines/.test(brief));
  const en = briefFor({ stage: 'enReview', role: 'reviewer', keys: ['1'], pr: 'guide-docs#81' }, s);
  assert.match(en, /one review with line comments over the EN lines/);
});

// ------------------------------------------------------------------ the briefs and the role texts (AC-2)

test('AC-2: a deleted section is one line with its line count and a link to the diff; no comment quotes more than the changed fragment', () => {
  const s = settingsFor(tmp(), ROUNDS());
  const brief = briefFor({ stage: 'answerComments', role: 'writer', keys: ['1'], pr: 'guide-docs#81', nextEdit: 5 }, s);
  assert.match(brief, /under a deleted block: one line, its heading and its line count, the reason, and a link to the diff; never the block's text/);
  assert.match(brief, /the changed fragment as «before» → «after» when it fits on one line \(only the fragment, never the paragraph\)/);
  assert.match(brief, /Number the edits you record on this PR from 5: the numbers stay in the ledger/);
  assert.match(brief, /a comment that starts with `helper:` or `помічник:`/);
  assert.ok(!/post the summary/.test(brief), 'no summary comment in a round');
  const writer = fs.readFileSync(path.join(ROLE_DIR, 'writer.md'), 'utf8');
  assert.match(writer, /A deleted block is one line/);
  // A recorded example of the format, as the host's template has it (invented page and counts).
  const example = '🤖 **[BOT]**\n\nDeleted section «Create a loan with a shelf choice» (65 lines): the ticket names no such endpoint. [diff](https://forge.example/acme/guide-docs/pull/81/files)';
  assert.ok(example.split('\n').length <= 3 && example.length < 200);
  // Without the rounds, the brief is today's.
  const old = briefFor({ stage: 'answerComments', role: 'writer', keys: ['1'], pr: 'guide-docs#81', nextEdit: 5 }, settingsFor(tmp()));
  assert.ok(old.includes('A numbered list of edits you post on this PR starts at 5'));
  assert.ok(!/review-on-lines/.test(old));
});

// ------------------------------------------------------------------ the live description (scope 7, AC-5)

const TEMPLATE = (inner = { questions: 'q', places: 'p', rounds: 'r' }) => [
  '## Description', '', 'Two sentences a person wrote.', '',
  '## Open questions', '', '<!-- ticket-flow:questions -->', inner.questions, '<!-- /ticket-flow:questions -->', '',
  '## Places', '', '<!-- ticket-flow:places -->', inner.places, '<!-- /ticket-flow:places -->', '',
  '<!-- ticket-flow:rounds -->', inner.rounds, '<!-- /ticket-flow:rounds -->', '', 'A line a person added at the end.',
].join('\n');

test('AC-5: the three sections show only the open questions, the answered ones under «resolved» with their links, the places\' states and the rounds; text outside the markers is unchanged', () => {
  const labels = settingsFor(tmp(), ROUNDS()).reviewRounds.labels;
  const l = {
    places: [
      { id: 'p1', repo: 'guide-docs', pr: 81, claim: 'The shelf name rule', state: 'deleted', commentId: 11 },
      { id: 'p2', repo: 'guide-docs', pr: 81, claim: 'Every method but one', state: 'open', commentId: 12 },
      { id: 'p3', repo: 'guide-docs', pr: 81, claim: 'Two new error rows', state: 'confirmed', commentId: 13 },
      { id: 'p9', repo: 'guide-docs', pr: 99, claim: 'Another PR', state: 'open', commentId: 19 },
    ],
  };
  const p = {
    repo: 'guide-docs', number: 81, url: 'https://forge.example/acme/guide-docs/pull/81',
    questions: [
      { n: 1, text: 'Should the shelf choice work on the loan endpoint?', reader: 'developer', place: 'Body attributes, the pickShelf row', why: 'The test request returned a card at once.', proposal: 'If yes, a backend defect.' },
      { n: 2, text: 'Is loanMode required?', reader: 'developer', answer: { text: 'No, the developer answered', link: 'https://forge.example/acme/guide-docs/pull/81#issuecomment-9' } },
      { n: 3, text: 'Keep the third case as its own row?', reader: 'writer', answer: { text: 'Yes', link: C1 } },
    ],
    rounds: [{ n: 1, stage: 'pr', commits: [{ sha: 'abc1234' }, { sha: 'def5678' }], review: 501, comments: 1 }, { n: 2, stage: 'answerComments', commits: [{ sha: C1 }, { sha: C2 }], review: 502, comments: 2 }],
  };
  const sections = renderSections(l, p, labels);
  assert.equal(sections.questions, [
    '<details open>\n<summary>For the developer (1)</summary>\n\n**1.** Should the shelf choice work on the loan endpoint?\n- **Place:** Body attributes, the pickShelf row\n- **Why a question:** The test request returned a card at once.\n- **Proposal:** If yes, a backend defect.\n\n</details>',
    `<details>\n<summary>Resolved (2)</summary>\n\n**2.** ~~Is loanMode required?~~ No, the developer answered · [answer](https://forge.example/acme/guide-docs/pull/81#issuecomment-9)\n\n**3.** ~~Keep the third case as its own row?~~ Yes · ${C1.slice(0, 7)}\n\n</details>`,
  ].join('\n\n'));
  assert.equal(sections.places, [
    '- **p1** The shelf name rule — block deleted · thread closed',
    '- **p2** Every method but one — [open thread ↗](https://forge.example/acme/guide-docs/pull/81#discussion_r12)',
    '- **p3** Two new error rows — confirmed · [thread](https://forge.example/acme/guide-docs/pull/81#discussion_r13)',
  ].join('\n'));
  assert.equal(sections.rounds, `<details>\n<summary>Rounds (2)</summary>\n\n- 1 · first version · line comments: 1 · abc1234, def5678 · [review](https://forge.example/acme/guide-docs/pull/81#pullrequestreview-501)\n- 2 · comments · line comments: 2 · ${C1.slice(0, 7)}, ${C2.slice(0, 7)} · [review](https://forge.example/acme/guide-docs/pull/81#pullrequestreview-502)\n\n</details>`);
  const body = TEMPLATE();
  const r = rewriteDescription(body, sections);
  assert.equal(r.changed, true);
  assert.deepEqual([r.kept, r.missing], [[], []]);
  const outside = (s) => s.replace(/<!-- ticket-flow:(\w+)[^>]*-->[\s\S]*?<!-- \/ticket-flow:\1 -->/g, '<$1>');
  assert.equal(outside(r.body), outside(body), 'text outside the markers is byte for byte the same');
  assert.ok(r.body.includes(`<!-- ticket-flow:places h=${sectionHash(sections.places)} -->\n${sections.places}\n<!-- /ticket-flow:places -->`));
  assert.deepEqual(rewriteDescription(r.body, sections), { body: r.body, changed: false, kept: [], missing: [] }, 'the same ledger: no change');
});

test('AC-5: a person\'s edit inside the markers is kept with a warning; a description with no markers is left as it is', () => {
  const labels = settingsFor(tmp(), ROUNDS()).reviewRounds.labels;
  const first = rewriteDescription(TEMPLATE(), { questions: 'Q1', places: 'P1', rounds: 'R1' }).body;
  const edited = first.replace('P1', 'P1, and a note the owner wrote here');
  const r = rewriteDescription(edited, { questions: 'Q2', places: 'P2', rounds: 'R2' });
  assert.deepEqual(r.kept, ['places']);
  assert.ok(r.body.includes('P1, and a note the owner wrote here') && r.body.includes('Q2') && r.body.includes('R2'));
  // GitHub gives a description back with CRLF line ends: still the runner's own text.
  assert.deepEqual(rewriteDescription(first.replace(/\n/g, '\r\n'), { questions: 'Q1', places: 'P1', rounds: 'R1' }).kept, []);
  const none = rewriteDescription('## Description\n\nOld PR.', renderSections({}, { questions: [], rounds: [] }, labels));
  assert.deepEqual([none.changed, none.missing], [false, ['questions', 'places', 'rounds']]);
});

// ------------------------------------------------------------------ the runner after a round (scopes 6–8, AC-4, AC-6)

// The PR's first round (the `pr` stage's), before the two summaries below: they were posted once the rounds began.
const FIRST_ROUND = { n: 1, stage: 'pr', at: ago(40), seq: 1, commits: [], review: 501, comments: 1 };
const roundWorld = (number, extra = {}, { rounds = [FIRST_ROUND], body = TEMPLATE() } = {}) => {
  const c = card({ number, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 81, headCommit: HEAD });
  forgePr.body = body;
  const activity = {
    'guide-docs#81': {
      threads: [thread(7301, 'A place to check', [comment(7303, 'owner-login', 'helper: the expert confirmed it.', { reviewId: 6301 })]), { id: 'T88', resolved: false, comments: [comment(88, 'expert-one', 'Is this right?')] }],
      comments: [comment(6001, 'owner-login', `${HEADER}\n\nAn older summary.`), comment(6002, 'owner-login', `${HEADER}\n\nA summary the owner deleted.`), comment(6003, 'owner-login', 'The owner\'s own comment.')],
    },
  };
  const w = world({ cards: [c], prs: [forgePr], activity, extra: ROUNDS(extra) });
  roundLedger(w, c, { summaries: [{ repo: 'guide-docs', pr: 81, id: 6001, at: ago(30) }, { repo: 'guide-docs', pr: 81, id: 6002, at: ago(20) }], posted: { pr: [6100, 7201, 7301, 6001, 6002], card: [] }, prExtra: rounds.length ? { rounds } : {}, ...extra.ledger });
  w.forge.activity['guide-docs#81'].comments = w.forge.activity['guide-docs#81'].comments.filter((x) => x.id !== 6002);
  return { c, forgePr, w };
};

test('AC-4, AC-6: after a round the runner settles the confirmed place\'s thread, removes the older summaries it posted (one already gone is a warning) and rewrites the description; a person\'s thread and comment are never touched', async () => {
  const { forgePr, w } = roundWorld(990);
  const spawnClaude = async () => {
    await runRecord({ settings: w.settings, clients: w.clients(), key: '990', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({
      handled: [{ id: 7303, updatedAt: at }, { id: 88, updatedAt: at }],
      review: { id: 7800, commits: [] },
      places: [{ id: 'p1', state: 'confirmed', replyId: 7304 }],
      questions: [],
      posted: [7800, 7304],
    }) });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: tree, spawnClaude }, options: { morning: false, trigger: 'watch', named: ['990'] } });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['answerComments', 'done']]);
  const log = w.forge.log.map((x) => x.slice(0, 3));
  assert.deepEqual(log.filter((x) => x[0] === 'resolveThread'), [['resolveThread', 'guide-docs', 'T7301']], 'only the pipeline\'s place thread');
  assert.deepEqual(log.filter((x) => x[0] === 'deleteComment'), [['deleteComment', 'guide-docs', 6001]], 'only its own older summary; the one the owner deleted is not posted again');
  assert.ok(w.forge.activity['guide-docs#81'].comments.some((x) => x.id === 6003), "the owner's own comment stays");
  assert.ok(out.log.some((e) => e.kind === 'rounds' && /the older summary 6002 is already gone/.test(e.note)), 'a 404 is a warning');
  assert.match(forgePr.body, /- \*\*p1\*\* The limit is 50 for every method — confirmed · \[thread\]\(https:\/\/forge\.example\/acme\/guide-docs\/pull\/81#discussion_r7301\)/);
  assert.match(forgePr.body, /- 2 · comments · \[review\]\(https:\/\/forge\.example\/acme\/guide-docs\/pull\/81#pullrequestreview-7800\)/);
  assert.ok(forgePr.body.startsWith('## Description\n\nTwo sentences a person wrote.') && forgePr.body.endsWith('A line a person added at the end.'));
  // The next round: nothing to settle or remove again.
  const before = roundSnapshot(w.settings.state, ['990']);
  const again = await followRounds({ settings: w.settings, clients: w.clients(), keys: ['990'], before });
  assert.deepEqual(again, []);
  assert.equal(w.forge.log.filter((x) => x[0] === 'deleteComment' || x[0] === 'resolveThread').length, 2);
});

test('AC-4: a place whose block was deleted gets its thread settled; with no review rounds the runner does nothing after a step', async () => {
  const { w } = roundWorld(991);
  const before = roundSnapshot(w.settings.state, ['991']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '991', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ review: { id: 7900, commits: [] }, places: [{ id: 'p1', state: 'deleted', replyId: 7305 }], questions: [], posted: [7900, 7305] }) });
  await assert.rejects(runRecord({ settings: w.settings, clients: w.clients(), key: '991', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ review: { id: 7901, commits: [] }, places: [{ id: 'p1', state: 'confirmed' }], questions: [], posted: [7901] }) }), (e) => e.exitCode === 2 && /give "replyId"/.test(e.message));
  assert.deepEqual(await followRounds({ settings: w.settings, clients: w.clients(), keys: ['991'], before }), ['guide-docs#81: the older summary 6002 is already gone']);
  assert.deepEqual(w.forge.log.filter((x) => x[0] === 'resolveThread').map((x) => x[2]), ['T7301']);
  // The same host with no `forge.reviewRounds`: no call.
  const off = { ...w.settings, reviewRounds: null };
  w.forge.log.length = 0;
  assert.deepEqual(await followRounds({ settings: off, clients: w.clients(), keys: ['991'], before: new Map() }), []);
  assert.deepEqual(w.forge.log, []);
});

test('AC-5: a description a person changed inside the markers since the last rewrite is kept, with a warning', async () => {
  const { forgePr, w } = roundWorld(992);
  const first = await followRounds({ settings: w.settings, clients: w.clients(), keys: ['992'], before: new Map() });
  assert.deepEqual(first, []);
  forgePr.body = forgePr.body.replace('**p1**', '**p1** (asked the expert by phone)');
  await runRecord({ settings: w.settings, clients: w.clients(), key: '992', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ review: { id: 7950, commits: [] }, questions: [], posted: [7950] }) });
  const before = new Map([[...roundSnapshot(w.settings.state, ['992']).entries()].map(([k, v]) => [k, { ...v, seq: v.seq - 1, rounds: v.rounds - 1 }])[0]]);
  const warnings = await followRounds({ settings: w.settings, clients: w.clients(), keys: ['992'], before });
  assert.ok(warnings.some((x) => /the description's places section was edited by a person since the last round: left as it is/.test(x)), warnings.join('; '));
  assert.ok(forgePr.body.includes('(asked the expert by phone)'));
  assert.match(forgePr.body, /pullrequestreview-7950/, 'the other sections are written');
});

test('the first version: the pr record keeps the description\'s questions and the first round with the draft and the UA review\'s commits', async () => {
  const c = card({ number: 993, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 81, head: 'ticket-993', headCommit: HEAD });
  const w = world({ cards: [c], prs: [forgePr], extra: ROUNDS() });
  ledger(w, c, { stages: { ...BASE, write: { status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-993', commits: ['3f1a2b0'] }] } }, uaReview: { status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-993', commits: ['8c4d9e1'] }] } } }, prs: [{ repo: 'guide-docs', branch: 'ticket-993', targets: ['guide'], review: 'sme', stage: 'writing' }] });
  await runRecord({ settings: w.settings, clients: w.clients(), key: '993', stage: 'pr', status: 'done', now: NOW, result: JSON.stringify({
    prs: [{ repo: 'guide-docs', branch: 'ticket-993', number: 81, expertReview: { recommended: false, why: 'checked in the code' }, review: { id: 501 }, questions: [{ text: 'Should it work on the loan endpoint?', reader: 'developer', place: 'Body attributes', why: 'A test returned a card.', proposal: 'A defect if yes.' }, { text: 'Keep the row?', reader: 'writer' }] }],
    places: [{ id: 'p1', repo: 'guide-docs', pr: 81, page: PAGE, line: 12, claim: 'x', source: 'transcript', commentId: 7301 }],
    posted: [501, 7301],
  }) });
  const p = read(w, '993').prs[0];
  assert.deepEqual(p.questions.map((q) => [q.n, q.reader, q.text]), [[1, 'developer', 'Should it work on the loan endpoint?'], [2, 'writer', 'Keep the row?']]);
  assert.deepEqual(p.rounds.map((r) => [r.n, r.stage, r.review, r.comments, r.commits.map((x) => `${x.sha}:${x.role}`)]), [[1, 'pr', 501, 1, ['3f1a2b0:draft', '8c4d9e1:style']]]);
  const brief = briefFor({ stage: 'pr', role: 'writer', keys: ['993'] }, w.settings);
  assert.match(brief, /record each PR's questions in `prs\[\]\.questions`/);
  assert.match(brief, /The first version gets no line comment per style fix/);
  // With review rounds the questions are required, `[]` when none: the runner's section never says "none" over the
  // questions a session wrote and didn't record.
  const c2 = card({ number: 995, status: 'finalReview' });
  const w2 = world({ cards: [c2], prs: [pr({ repo: 'guide-docs', number: 82, head: 'ticket-995', headCommit: HEAD })], extra: ROUNDS() });
  ledger(w2, c2, { stages: BASE, prs: [{ repo: 'guide-docs', branch: 'ticket-995', targets: ['guide'], review: 'sme', stage: 'writing' }] });
  const prRec = (entry) => runRecord({ settings: w2.settings, clients: w2.clients(), key: '995', stage: 'pr', status: 'done', now: NOW, result: JSON.stringify({ prs: [{ repo: 'guide-docs', branch: 'ticket-995', number: 82, expertReview: { recommended: false, why: 'x' }, ...entry }], posted: [] }) });
  await assert.rejects(prRec({}), (e) => e.exitCode === 2 && /"questions" is required with review rounds/.test(e.message));
  await prRec({ questions: [] });
  assert.deepEqual(read(w2, '995').prs[0].questions, []);
});

// ------------------------------------------------------------------ the gate and the fix round

test('with neither forge.triggerWords nor forge.reviewRounds, a reply in a place\'s or an item\'s thread is an ordinary comment: today\'s step, brief and ledger', async () => {
  const c = card({ number: 996, status: 'finalReview' });
  const replies = [comment(7302, 'owner-login', 'Confirmed by the expert, leave it.', { reviewId: 6300 })];
  const styleReply = [comment(7202, 'owner-login', 'поверни', { reviewId: 6200 })];
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { threads: [thread(7301, 'A place to check', replies), thread(7201, 'A style fix', styleReply)] } } });
  roundLedger(w, c);
  const s = (await w.one('996')).steps[0];
  assert.deepEqual(Object.keys(s).filter((k) => !['keys', 'cards', 'group', 'role', 'stage', 'pr', 'model', 'effort', 'estimate', 'worktrees', 'codeTrees', 'clones', 'reason', 'priority'].includes(k)).sort(), ['comments', 'nextEdit', 'owner', 'reviewer']);
  assert.deepEqual([s.comments, s.owner, s.reviewer, s.nextEdit], [2, 2, 0, 5]);
  const brief = briefFor({ ...s, role: 'writer', keys: ['996'] }, w.settings);
  for (const text of ['places to check', 'settles the thread', 'threads of your line comments', 'review rounds', 'The comments this step takes', 'trigger word']) assert.ok(!brief.includes(text), text);
  assert.match(brief, /A numbered list of edits you post on this PR starts at 5/);
  // The `pr` record keeps no rounds and no questions, whatever the session sends.
  const c2 = card({ number: 997, status: 'finalReview' });
  const w2 = world({ cards: [c2], prs: [pr({ repo: 'guide-docs', number: 83, head: 'ticket-997', headCommit: HEAD })] });
  ledger(w2, c2, { stages: { ...BASE, write: { status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-997', commits: ['3f1a2b0'] }] } } }, prs: [{ repo: 'guide-docs', branch: 'ticket-997', targets: ['guide'], review: 'sme', stage: 'writing' }] });
  await runRecord({ settings: w2.settings, clients: w2.clients(), key: '997', stage: 'pr', status: 'done', now: NOW, result: JSON.stringify({ prs: [{ repo: 'guide-docs', branch: 'ticket-997', number: 83, expertReview: { recommended: false, why: 'x' }, review: { id: 501 }, questions: [{ text: 'Q?', reader: 'writer' }] }], posted: [501] }) });
  const p = read(w2, '997').prs[0];
  assert.deepEqual([p.rounds, p.questions], [undefined, undefined]);
});

test('a PR from before the switch: its summaries are never removed, and its description with no markers gets the three sections at its end at its first round', async () => {
  const body = '## Description\n\nOld PR.\n\n## Open questions\n\n- An old question.';
  const { forgePr, w } = roundWorld(994, {}, { rounds: [], body });
  const before = roundSnapshot(w.settings.state, ['994']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '994', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ review: { id: 7960, commits: [] }, asked: [{ text: 'Is 50 the limit?', reader: 'developer' }], questions: [], posted: [7960] }) });
  assert.deepEqual(await followRounds({ settings: w.settings, clients: w.clients(), keys: ['994'], before }), []);
  assert.deepEqual(w.forge.log.filter((x) => x[0] === 'deleteComment'), [], 'the summaries before the first round hold its lists and questions');
  assert.ok(forgePr.body.startsWith(`${body}\n\n## Open questions\n\n<!-- ticket-flow:questions h=`), forgePr.body);
  assert.match(forgePr.body, /\*\*1\.\*\* Is 50 the limit\?/);
  assert.match(forgePr.body, /## Places to check\n\n<!-- ticket-flow:places h=[0-9a-f]{8} -->\n- \*\*p1\*\* The limit is 50/);
  assert.match(forgePr.body, /<!-- ticket-flow:rounds h=[0-9a-f]{8} -->\n<details>/);
  // The next round writes between the markers it added, once.
  const next = roundSnapshot(w.settings.state, ['994']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '994', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ review: { id: 7961, commits: [] }, answered: [{ n: 1, answer: 'yes, the expert', link: 'abc1234' }], questions: [], posted: [7961] }) });
  assert.deepEqual(await followRounds({ settings: w.settings, clients: w.clients(), keys: ['994'], before: next }), []);
  assert.equal(forgePr.body.match(/ticket-flow:questions h=/g).length, 1);
  assert.match(forgePr.body, /pullrequestreview-7961/);
  assert.deepEqual(w.forge.log.filter((x) => x[0] === 'deleteComment'), []);
});

test('a round changes only a place\'s state, its reply and its answer; the EN round names the translation commit the translation stage recorded', async () => {
  const c = card({ number: 998, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], extra: ROUNDS() });
  roundLedger(w, c);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '998', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ review: { id: 7970, commits: [] }, places: [{ id: 'p1', state: 'confirmed', replyId: 7971, answer: 'yes', claim: 'rewritten', commentId: 1, repo: 'other', pr: 9 }], questions: [], posted: [7970, 7971] }) });
  const place = read(w, '998').places[0];
  assert.deepEqual([place.state, place.replyId, place.answer, place.claim, place.commentId, place.repo, place.pr], ['confirmed', 7971, 'yes', 'The limit is 50 for every method', 7301, 'guide-docs', 81]);

  const c2 = card({ number: 999, status: 'translation' });
  const w2 = world({ cards: [c2], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], extra: ROUNDS() });
  roundLedger(w2, c2, { prs: [{ repo: 'guide-docs', number: 81, targets: ['guide'], review: 'sme', stage: 'translation', chain: { translate: { status: 'done', head: HEAD } }, pipelineCommits: [C1], edits: [] }] });
  const rec = (r) => runRecord({ settings: w2.settings, clients: w2.clients(), key: '999', stage: 'enReview', pr: 'guide-docs#81', status: 'done', head: HEAD, result: JSON.stringify(r), now: NOW });
  await assert.rejects(rec({ commits: [C2], review: { id: 7980, commits: [{ sha: 'd'.repeat(7), role: 'translation' }, { sha: C2.slice(0, 7), role: 'style' }] }, posted: [7980] }), (e) => e.exitCode === 2 && /not among "commits" nor the PR's recorded commits/.test(e.message));
  await rec({ commits: [C2], review: { id: 7980, commits: [{ sha: C1.slice(0, 7), role: 'translation' }, { sha: C2.slice(0, 7), role: 'style' }] }, posted: [7980] });
  assert.deepEqual(read(w2, '999').prs[0].rounds[0].commits.map((x) => x.role), ['translation', 'style']);
  const brief = briefFor({ stage: 'enReview', pr: 'guide-docs#81', role: 'reviewer', keys: ['999'] }, w2.settings);
  assert.match(brief, /"role": "translation" \| "style"/);
});
