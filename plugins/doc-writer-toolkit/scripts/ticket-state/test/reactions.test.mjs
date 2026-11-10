import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTS, MEMBERS, NOW, ago, card, pr, rawSettings, settingsFor, tmp } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { runDaily } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';

// The status marks (TASK-095, AC-4): the runner's reactions on the comments a session takes, 👀 at the pickup and the
// result after, from the record alone. An invented host: the owner is `owner-login` on the forge and `owner-one` on the
// tracker, the expert of the `guide` target `expert-one`.

const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const C1 = 'c1'.repeat(20);
const HEADER = '🤖 **[BOT]**';
const WORDS = ['helper'];
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 'session-1', usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [] });
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const tree = () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] });
const at = ago(1);
const comment = (id, author, body, extra = {}) => ({ id, author, body, createdAt: at, updatedAt: at, ...extra });
const MARKED = (reactions = true) => ({ commentHeader: HEADER, forge: { ...rawSettings().forge, triggerWords: WORDS, ...(reactions ? { reactions: true } : {}) } });

// A PR in the owner's queue with an item 1 on its list, and the comments given.
function prWorld(number, comments, { extra = MARKED() } = {}) {
  const c = card({ number, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })], activity: { 'guide-docs#81': { comments } }, extra });
  ledger(w, c, {
    stages: BASE,
    prs: [{ repo: 'guide-docs', number: 81, url: 'https://forge.example/acme/guide-docs/pull/81', targets: ['guide'], review: 'sme', stage: 'finalReview', edits: [{ n: 1, list: 'description', stage: 'pr', page: 'docs/x/a.md', block: 'Крок 1', before: 'а', after: 'б', at: ago(9), seq: 1 }] }],
    posted: { pr: [], card: [] },
  });
  return { c, w, key: String(number) };
}

// A session that records `answerComments` with `result`, after checking what the forge showed while it ran.
const session = (w, key, result, { during } = {}) => async () => {
  during?.();
  await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify(result) });
  return { code: 0, stdout: RESULT, stderr: '' };
};
const run = (w, key, spawnClaude) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: tree, spawnClaude }, options: { morning: false, trigger: 'watch', named: [key] } });
const marks = (w, id, kind = 'comment') => (w.forge.reactionsOn[`${kind}:${id}`] ?? []).map((r) => `${r.mark}@${r.login}`).sort();
const reacts = (w) => w.forge.log.filter((x) => x[0] === 'react').map((x) => [x[1], x[2], x[3]]);

test('AC-4: picked up, each comment the step takes gets 👀 before the session; applied, 👀 off and 🚀 on; a comment the session asked back about, or a reviewer\'s with no commit, gets 😕', async () => {
  const { w, key } = prWorld(901, [comment(5101, 'owner-login', 'helper: shorten step 2'), comment(5102, 'owner-login', 'helper: 1 — поверни'), comment(5103, 'expert-one', 'The limit is 50.'), comment(5104, 'expert-one', 'Is step 4 needed?'), comment(5105, 'owner-login', 'A note for myself.')]);
  let seen = null;
  const out = await run(w, key, session(w, key, {
    handled: [{ id: 5101, updatedAt: at, commit: C1 }, { id: 5102, updatedAt: at }, { id: 5103, updatedAt: at, commit: C1, replyId: 9902 }, { id: 5104, updatedAt: at, replyId: 9903 }],
    summary: { id: 9901 },
    edits: [{ n: 2, page: 'docs/x/a.md', block: 'Крок 2', before: 'довгий', after: 'короткий' }],
    questions: [{ text: 'Restore both lines of item 1, or the first only?', n: 1 }],
    commits: [C1],
    posted: [9901, 9902, 9903],
  }, { during: () => (seen = [5101, 5102, 5103, 5104, 5105].map((id) => marks(w, id))) }));
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['answerComments', 'done']]);
  assert.deepEqual(seen, [['seen@owner-login'], ['seen@owner-login'], ['seen@owner-login'], ['seen@owner-login'], []], 'the owner\'s note without the word is not taken and gets nothing');
  assert.deepEqual(marks(w, 5101), ['applied@owner-login']);
  assert.deepEqual(marks(w, 5102), ['asked@owner-login'], 'its item 1 is the question the record asks');
  assert.deepEqual(marks(w, 5103), ['applied@owner-login'], 'the expert\'s fix, committed');
  assert.deepEqual(marks(w, 5104), ['asked@owner-login'], 'the expert\'s comment with no commit: a note or a suggestion');
  assert.deepEqual(marks(w, 5105), []);
  assert.deepEqual(reacts(w).filter((x) => x[0] === 'comment:5101'), [['comment:5101', ['seen'], []], ['comment:5101', ['applied'], ['seen']]]);
  assert.ok(!out.log.some((e) => e.kind === 'reactions'), 'no warning');
});

test('AC-4: a taken comment the record left out of `handled` gets 😕, and so does every one of a failed step; a person\'s reaction stays', async () => {
  const { w, key } = prWorld(902, [comment(5201, 'owner-login', 'helper: shorten step 2'), comment(5202, 'owner-login', 'helper: and step 3')]);
  w.forge.reactionsOn['comment:5201'] = [{ mark: 'applied', login: 'expert-one' }, { mark: 'asked', login: 'expert-one' }];
  await run(w, key, session(w, key, { handled: [{ id: 5201, updatedAt: at, commit: C1 }], summary: { id: 9911 }, questions: [], commits: [C1], posted: [9911] }));
  assert.deepEqual(marks(w, 5201), ['applied@expert-one', 'applied@owner-login', 'asked@expert-one'], "the expert's 🚀 and 😕 are never taken off");
  assert.deepEqual(marks(w, 5202), ['asked@owner-login']);

  const f = prWorld(903, [comment(5301, 'owner-login', 'helper: shorten step 2')]);
  const out = await run(f.w, f.key, async () => ({ code: 1, stdout: RESULT, stderr: '' }));
  assert.equal(out.ran[0].outcome, 'failed');
  assert.deepEqual(marks(f.w, 5301), ['asked@owner-login'], 'the step could not do it');
});

test('AC-4: a mark the owner took off with no edit starts nothing; an edit is a new pickup: 👀 back on, the old 🚀 off, the new result set', async () => {
  const c5401 = comment(5401, 'owner-login', 'helper: shorten step 2');
  const { w, key } = prWorld(904, [c5401]);
  await run(w, key, session(w, key, { handled: [{ id: 5401, updatedAt: at, commit: C1 }], summary: { id: 9921 }, questions: [], commits: [C1], posted: [9921] }));
  assert.deepEqual(marks(w, 5401), ['applied@owner-login']);
  // The owner takes the 🚀 off: the ledger holds the comment handled, so no step and no reaction call.
  w.forge.reactionsOn['comment:5401'] = [];
  const reactsBefore = reacts(w).length;
  assert.deepEqual((await w.one(key)).steps, []);
  const idle = await run(w, key, async () => {
    throw new Error('no session');
  });
  assert.deepEqual(idle.ran, []);
  assert.equal(reacts(w).length, reactsBefore);
  // The owner puts 🚀 back by hand and then edits the comment: the second round.
  w.forge.reactionsOn['comment:5401'] = [{ mark: 'applied', login: 'owner-login' }];
  const later = new Date(NOW - 600000).toISOString();
  Object.assign(c5401, { body: 'helper: shorten step 2 and 3', updatedAt: later });
  let seen = null;
  await run(w, key, session(w, key, { handled: [{ id: 5401, updatedAt: later }], summary: { id: 9922 }, questions: [{ text: 'Step 3 is a table: shorten its rows?' }], posted: [9922] }, { during: () => (seen = marks(w, 5401)) }));
  assert.deepEqual(seen, ['seen@owner-login'], '👀 back on and the earlier 🚀 off at the pickup');
  assert.deepEqual(reacts(w).slice(reactsBefore), [['comment:5401', ['seen'], ['applied']], ['comment:5401', ['asked'], ['seen']]], 'answered only with a question that names no item, no commit: asked back');
});

test('the session\'s own word wins: `handled[].result` says applied or asked, in a review round too, where a line comment, a note or a thread ask-back says nothing the runner reads; a bad value is refused', async () => {
  const comments = [comment(5701, 'owner-login', 'helper: shorten step 2'), comment(5702, 'owner-login', 'helper: drop step 4'), comment(5703, 'owner-login', 'helper: add a note'), comment(5704, 'owner-login', 'helper: rename the heading')];
  const { w, key } = prWorld(909, comments, { extra: { ...MARKED(), forge: { ...MARKED().forge, reviewRounds: true } } });
  const result = {
    handled: [{ id: 5701, updatedAt: at, result: 'applied' }, { id: 5702, updatedAt: at, commit: C1, result: 'asked' }, { id: 5703, updatedAt: at }, { id: 5704, updatedAt: at, commit: C1 }],
    review: { id: 9961, commits: [{ sha: C1.slice(0, 7), role: 'comments' }] },
    commits: [C1],
    edits: [{ n: 2, page: 'docs/x/a.md', block: 'Крок 2', before: 'довгий', after: 'короткий', commentId: 9962 }],
    asked: [{ text: 'Should the note go under step 3?', reader: 'writer' }],
    questions: [],
    posted: [9961, 9962],
  };
  await assert.rejects(runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ ...result, handled: [{ id: 5701, updatedAt: at, result: 'done' }] }) }), (e) => e.exitCode === 2 && /"handled\[\]\.result" is one of applied, asked/.test(e.message));
  await run(w, key, session(w, key, result));
  assert.deepEqual(marks(w, 5701), ['applied@owner-login'], 'its own word, with no commit');
  assert.deepEqual(marks(w, 5702), ['asked@owner-login'], 'its own word, though a commit came with it');
  assert.deepEqual(marks(w, 5703), ['asked@owner-login'], 'no word, no commit, and the round asked a description question');
  assert.deepEqual(marks(w, 5704), ['applied@owner-login'], 'no word, committed');
});

test('a question on the card for the PR during the session marks only the comments it left undone: a committed one keeps 🚀', async () => {
  const { c, w, key } = prWorld(910, [comment(5801, 'owner-login', 'helper: shorten step 2'), comment(5802, 'owner-login', 'helper: which currency here?')]);
  await run(w, key, async () => {
    await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ handled: [{ id: 5801, updatedAt: at, commit: C1 }, { id: 5802, updatedAt: at }], summary: { id: 9971 }, questions: [], commits: [C1], posted: [9971] }) });
    w.tracker.cards.find((x) => x.id === c.id).placeId = LISTS.blocked.id;
    await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'questions', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({ questions: [{ id: 'q1', kind: 'fact', text: 'Which currency?', sources: [], commentId: 'cm-1' }] }) });
    return { code: 0, stdout: RESULT, stderr: '' };
  });
  assert.deepEqual(marks(w, 5801), ['applied@owner-login']);
  assert.deepEqual(marks(w, 5802), ['asked@owner-login']);
});

test('AC-4: a review\'s text and its line comment are marked by their own kinds', async () => {
  const c = card({ number: 905, status: 'finalReview' });
  const w = world({
    cards: [c],
    prs: [pr({ repo: 'guide-docs', number: 81, headCommit: HEAD })],
    activity: { 'guide-docs#81': { reviews: [{ id: 6601, author: 'owner-login', state: 'COMMENTED', body: 'helper: these lines', submittedAt: at }], threads: [{ id: 'T7', resolved: false, comments: [comment(6602, 'owner-login', 'shorter', { reviewId: 6601, path: 'docs/x/a.md', line: 4 })] }] } },
    extra: MARKED(),
  });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 81, targets: ['guide'], review: 'sme', stage: 'finalReview' }], posted: { pr: [], card: [] } });
  await run(w, '905', session(w, '905', { handled: [{ id: 6601, updatedAt: at }, { id: 6602, updatedAt: at, commit: C1 }], summary: { id: 9931 }, questions: [], commits: [C1], posted: [9931] }));
  assert.deepEqual(marks(w, 6601, 'review'), ['applied@owner-login']);
  assert.deepEqual(marks(w, 6602, 'review-comment'), ['applied@owner-login']);
});

test('a reaction that fails is a warning in the run log, never a failed step; with forge.reactions off no reaction is read or set', async () => {
  const { w, key } = prWorld(906, [comment(5501, 'owner-login', 'helper: shorten step 2')]);
  w.forge.reacted.fail = 'HTTP 502 Bad Gateway';
  const out = await run(w, key, session(w, key, { handled: [{ id: 5501, updatedAt: at, commit: C1 }], summary: { id: 9941 }, questions: [], commits: [C1], posted: [9941] }));
  assert.deepEqual(out.ran.map((r) => r.outcome), ['done']);
  const notes = out.log.filter((e) => e.kind === 'reactions').map((e) => e.note);
  assert.deepEqual(notes.length, 2, notes.join('; '));
  assert.match(notes[0], /guide-docs#81: the 👀 on comment 5501 was not set: HTTP 502/);
  assert.match(notes[1], /the 🚀 on comment 5501 was not set/);
  assert.ok(out.log.filter((e) => e.kind === 'reactions').every((e) => e.outcome === 'warning'), 'a warning, never listed with the failures');

  const off = prWorld(907, [comment(5601, 'owner-login', 'helper: shorten step 2')], { extra: MARKED(false) });
  off.w.forge.reacted.fail = 'a reaction was read';
  const quiet = await run(off.w, off.key, session(off.w, off.key, { handled: [{ id: 5601, updatedAt: at, commit: C1 }], summary: { id: 9951 }, questions: [], commits: [C1], posted: [9951] }));
  assert.deepEqual(quiet.ran.map((r) => r.outcome), ['done']);
  assert.deepEqual(reacts(off.w), []);
  assert.ok(!quiet.log.some((e) => e.kind === 'reactions'));
});

test('AC-4, the tracker: the owner\'s answers after the question get 👀 at the pickup and ✅ once `answers` is done; the pipeline\'s own comment and a colleague\'s get none', async () => {
  const c = card({ number: 908, status: 'inProgress' });
  const comments = {
    [c.id]: [
      { id: 'cm-old', author: { id: MEMBERS[0].id, username: 'owner-one' }, time: ago(30), text: 'Before the question.', edited: null },
      { id: 'cm-q', author: { id: MEMBERS[0].id, username: 'owner-one' }, time: ago(5), text: `${HEADER}\n\nWhich currency?`, edited: null },
      { id: 'cm-a', author: { id: MEMBERS[0].id, username: 'owner-one' }, time: ago(3), text: 'Euro.', edited: null },
      { id: 'cm-x', author: { id: MEMBERS[1].id, username: 'expert-one' }, time: ago(2), text: 'And the dollar later.', edited: null },
    ],
  };
  const w = world({ cards: [c], comments, extra: { commentHeader: HEADER, tracker: { ...rawSettings().tracker, owner: 'owner-one', reactions: true } } });
  ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked', questions: [{ id: 'q1', kind: 'fact', text: 'Which currency?', askedAt: ago(4), commentId: 'cm-q' }], posted: { pr: [], card: ['cm-q'] } });
  let seen = null;
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: tree, spawnClaude: async () => {
    // The chain goes on after the answers (the next stage's session records nothing here).
    if (seen) return { code: 0, stdout: RESULT, stderr: '' };
    seen = Object.fromEntries(Object.entries(w.tracker.reactionsOn).map(([k, v]) => [k, v.map((r) => r.mark)]));
    await runRecord({ settings: w.settings, clients: w.clients(), key: '908', stage: 'answers', status: 'done', now: NOW, result: JSON.stringify({ answer: { by: 'owner-one', commentId: 'cm-a' } }) });
    return { code: 0, stdout: RESULT, stderr: '' };
  } }, options: { morning: false, trigger: 'watch', named: ['908'] } });
  assert.equal(out.ran[0].stage, 'answers');
  assert.deepEqual(seen, { 'cm-a': ['seen'] }, 'only the owner\'s answer after the question');
  assert.deepEqual(w.tracker.reactionsOn['cm-a'].map((r) => r.mark), ['applied']);
  assert.deepEqual(w.tracker.log.filter((x) => /Reaction$/.test(x[0])).map((x) => x.slice(0, 3)), [['addReaction', 'cm-a', 'seen'], ['addReaction', 'cm-a', 'applied'], ['removeReaction', 'cm-a', 'rx-1']]);
});

test('the settings: forge.reactions and tracker.reactions are off by default, and take true or false only', () => {
  assert.deepEqual(settingsFor(tmp()).reactions, { forge: false, tracker: false });
  assert.deepEqual(settingsFor(tmp(), { forge: { ...rawSettings().forge, triggerWords: WORDS, reactions: true } }).reactions, { forge: true, tracker: false });
  assert.throws(() => settingsFor(tmp(), { forge: { ...rawSettings().forge, reactions: true } }), /forge\.reactions needs forge\.triggerWords/);
  const { self, ...noSelf } = rawSettings().forge;
  assert.throws(() => settingsFor(tmp(), { forge: { ...noSelf, triggerWords: WORDS, reactions: true } }), /forge\.reactions needs forge\.self/);
  assert.deepEqual(settingsFor(tmp(), { tracker: { ...rawSettings().tracker, reactions: true } }).reactions, { forge: false, tracker: true });
  assert.throws(() => settingsFor(tmp(), { forge: { ...rawSettings().forge, reactions: 'yes' } }), /forge\.reactions must be true or false/);
  assert.throws(() => settingsFor(tmp(), { tracker: { ...rawSettings().tracker, reactions: 1 } }), /tracker\.reactions must be true or false/);
});
