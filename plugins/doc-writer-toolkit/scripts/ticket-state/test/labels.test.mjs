import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTS, NOW, ago, card, pr, rawSettings, settingsFor, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runDaily, scriptedCalls } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { printable } from '../lib/settings.mjs';
import { unhandled } from '../lib/world.mjs';
import { writeLedger } from '../lib/ledger.mjs';
import { followLabels, labelChanges, labelSnapshot } from '../lib/pr-labels.mjs';
import { mergedEdits, parseReply, resolveReply } from '../lib/edits.mjs';

// The pipeline's comments carry the host's header (D-138); the ready label marks a PR ready for merge; the check label
// follows the questions put to the owner. The labels are the runner's (lib/pr-labels.mjs), the header the tracker's and
// the forge's modules' (their own tests post through them).

const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const HEADER = '🤖 **[BOT]**';
const READY = 'Merge advised';
const CHECK = 'Look at me';
const WITH_READY = { forge: { ...rawSettings().forge, readyLabel: READY } };
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 'session-1', usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [] });
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const tree = () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] });
const run = (w, spawnClaude, options = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: tree, spawnClaude }, options: { morning: false, trigger: 'watch', ...options } });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const noSession = async () => {
  throw new Error('a session started');
};
const labelCalls = (w) => w.forge.log.filter((x) => x[0] === 'changeLabels').map(([, repo, number, add, remove]) => ({ repo, number, add, remove }));

// ------------------------------------------------------------------ the header in the ticket flow

test('the header: one setting at the top of the shared file, given to the tracker and the forge clients; none by default', () => {
  const root = tmp();
  const on = settingsFor(root, { commentHeader: HEADER });
  assert.deepEqual([on.commentHeader, on.tracker.commentHeader, on.forge.commentHeader], [HEADER, HEADER, HEADER]);
  const off = settingsFor(root);
  assert.deepEqual([off.commentHeader, off.tracker.commentHeader, off.forge.commentHeader], [null, null, null]);
  assert.throws(() => settingsFor(root, { commentHeader: 'two\nlines' }), /commentHeader must be one line/);
  assert.equal(printable(settingsFor(root, WITH_READY)).forge.readyLabel, READY);
});

test('AC-1, AC-2: the runner\'s own comments get the header (the ready comment), and the one already there is found with it and without it', async () => {
  for (const before of [null, 'Ready for merge', `${HEADER}\n\nReady for merge`]) {
    const c = card({ number: 951, status: 'translation' });
    const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 51, headCommit: HEAD, labels: ['In final review'] })], comments: before ? { [c.id]: [{ id: 'old-1', time: ago(1), text: before }] } : {}, extra: { commentHeader: HEADER } });
    ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 51, targets: ['guide'], review: 'sme', stage: 'readyForMerge', readyForMerge: [{ head: HEAD, at: ago(2), seq: 5 }] }] });
    const out = await run(w, noSession, { named: ['951'] });
    assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['move', 'done']], JSON.stringify(before));
    const posted = w.tracker.log.filter((x) => x[0] === 'comment');
    if (before) assert.deepEqual(posted, [], `${JSON.stringify(before)}: found, not posted again`);
    else assert.deepEqual(posted.map((x) => x[2]), [`${HEADER}\n\nReady for merge`]);
    assert.equal(c.placeId, LISTS.finalReview.id);
  }
});

test('AC-2: a triage comment counts with the header in front and without it; with no header set, a headered one is read as it stands', async () => {
  const st = async (text, extra) => {
    const c = card({ number: 952, status: 'ready', labels: [] });
    const w = world({ cards: [c], comments: { [c.id]: [{ id: 'cm-1', time: ago(3), text }] }, extra });
    return (await w.status()).tickets.find((t) => t.key === '952');
  };
  for (const text of ['Triage: docs needed\nKey: 952', `${HEADER}\n\nTriage: docs needed\nKey: 952`]) {
    const t = await st(text, { commentHeader: HEADER });
    assert.deepEqual([t?.state, t?.triage?.verdict], ['ready', 'legacy'], text);
  }
  assert.equal(await st(`${HEADER}\n\nTriage: docs needed`, {}), undefined, 'no header set: the comment starts with something else');
});

test('AC-2: a PR comment that starts with the header is the pipeline\'s, recorded or not; one from before the header is read by its id as before', () => {
  const p = { repo: 'guide-docs', number: 7 };
  const at = ago(1);
  const activity = { comments: [
    { id: 1, author: 'me', body: `${HEADER}\n\n✏️ Edits\n\n**3.** \`docs/a.md\` · Steps · Step 2`, updatedAt: at },
    { id: 2, author: 'me', body: 'Edits\n3. docs/a.md: «a» → «b»', updatedAt: at },
    { id: 3, author: 'me', body: '3 — поверни', updatedAt: at },
  ] };
  const ids = (posted, header) => unhandled({ posted: { pr: posted }, reviewComments: [] }, p, activity, 'me', header).map((c) => c.id);
  assert.deepEqual(ids([], HEADER), [2, 3], 'the headered summary is never read as the owner\'s');
  assert.deepEqual(ids([2], HEADER), [3], 'an old summary is the pipeline\'s by its recorded id');
  assert.deepEqual(ids([], null), [1, 2, 3], 'no header set: only the ids tell');
});

// ------------------------------------------------------------------ AC-3: the layout and the reply by number

// A summary in the approved layout (sections with their headings, each edit's number in bold, «було» and «стало» on
// their own lines in a quote, a long block folded, the questions naming the item they ask about), posted by the
// pipeline, with the header.
const SUMMARY = [
  HEADER,
  '',
  '✏️ **Правки**',
  '',
  '**3.** `docs/x/a.md` · Налаштування · Крок 2',
  '> **Було:** Натисніть «Зберегти».',
  '> **Стало:** Натисніть **Зберегти**.',
  '',
  '**4.** `docs/x/b.md` · Довідка · Таблиця «Поля»',
  '<details><summary>Було / Стало</summary>',
  '',
  `> **Було:** ${'Довгий абзац. '.repeat(25)}`,
  `> **Стало:** ${'Довгий абзац, виправлено. '.repeat(15)}`,
  '',
  '</details>',
  '',
  '📝 **Примітки**',
  '',
  '- `docs/x/a.md` · Налаштування: правило про лапки не застосовано, бо змінило б зміст.',
  '',
  '❓ **Питання**',
  '',
  '- до **2**: «поверни» стосується кроку 3, а правка 2 у кроці 1. Який блок повернути?',
  '  - **Місце:** `docs/x/a.md` · Налаштування · Крок 1',
  '  - **Пропозиція:** повернути крок 1',
].join('\n');
const PAGE_A = 'docs/x/a.md';
const EDITS = [
  { n: 1, list: 'description', stage: 'pr', page: PAGE_A, block: 'Крок 1', before: 'було 1', after: 'стало 1' },
  { n: 2, list: 'description', stage: 'pr', page: PAGE_A, block: 'Крок 1b', before: 'було 2', after: 'стало 2' },
  { n: 3, list: '7001', stage: 'answerComments', page: PAGE_A, block: 'Крок 2', before: 'Натисніть «Зберегти».', after: 'Натисніть **Зберегти**.' },
  { n: 4, list: '7001', stage: 'answerComments', page: 'docs/x/b.md', block: 'Таблиця «Поля»', before: 'довгий', after: 'довгий, виправлено' },
];

test('AC-3: the pipeline\'s summary in the new layout is no reply by number, and the owner\'s replies to it resolve against the same numbers', () => {
  assert.equal(parseReply(SUMMARY), null, 'its bold numbers, quotes and sections name no item');
  const edits = mergedEdits([EDITS]);
  const plain = resolveReply(parseReply('3 — поверни\n4 — ок'), edits);
  assert.deepEqual(plain.map((x) => [x.n, x.do, x.put ?? null]), [[3, 'restore', 'Натисніть «Зберегти».'], [4, 'keep', null]]);
  // GitHub's quote reply puts the whole summary under `> `: only the owner's own lines count.
  const quoted = `${SUMMARY.split('\n').map((l) => `> ${l}`).join('\n')}\n\n3 — "Натисніть кнопку **Зберегти**."`;
  assert.deepEqual(resolveReply(parseReply(quoted), edits).map((x) => [x.n, x.do, x.put]), [[3, 'verbatim', 'Натисніть кнопку **Зберегти**.']]);
  // A number with no item, and one the owner wrote twice, are asked back as before.
  assert.deepEqual(resolveReply(parseReply('9 — поверни'), edits).map((x) => x.do), ['ask']);
});

// ------------------------------------------------------------------ the questions to the owner in the records

test('the questions: an answerComments record always states them, a styleCheck keeps the open ones, a forward move clears them', async () => {
  const c = card({ number: 953, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 53, headCommit: HEAD })] });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 53, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const rec = (stage, result, extra = {}) => runRecord({ settings: w.settings, clients: w.clients(), key: '953', stage, pr: 'guide-docs#53', status: 'done', result, now: NOW, ...extra });
  await assert.rejects(rec('answerComments', { handled: [] }), (e) => e.exitCode === 2 && /give "questions"/.test(e.message));
  await assert.rejects(rec('answerComments', { handled: [], questions: [{ text: 'Which?' }] }), (e) => e.exitCode === 2 && /give "summary"/.test(e.message));
  await assert.rejects(rec('answerComments', { handled: [], questions: [{ n: 2 }], summary: { id: 7001 } }), (e) => e.exitCode === 2 && /a list of \{ "text", "n"\? \}/.test(e.message));
  await rec('answerComments', { handled: [], summary: { id: 7001 }, questions: [{ text: 'Which block?', n: 2 }], posted: [7001] });
  assert.deepEqual(read(w, '953').prs[0].openQuestions.items, [{ text: 'Which block?', n: 2 }]);
  await rec('styleCheck', { reviewed: [{ sha: 'c'.repeat(40) }] });
  assert.deepEqual(read(w, '953').prs[0].openQuestions.items, [{ text: 'Which block?', n: 2 }], 'a style check answers none');
  await rec('styleCheck', { reviewed: [{ sha: 'd'.repeat(40) }], summary: { id: 7002 }, notes: [{ page: PAGE_A, block: 'Крок 2', text: 'n' }], questions: [{ text: 'Keep the term?' }], posted: [7002] });
  assert.deepEqual(read(w, '953').prs[0].openQuestions.items.map((x) => x.text), ['Which block?', 'Keep the term?']);
  await rec('answerComments', { handled: [], summary: { id: 7003 }, questions: [], posted: [7003] });
  assert.deepEqual(read(w, '953').prs[0].openQuestions.items, [], 'the session said none is left');
  await rec('answerComments', { handled: [], summary: { id: 7004 }, questions: [{ text: 'Again?' }], posted: [7004] });
  c.placeId = LISTS.translation.id;
  await runRecord({ settings: w.settings, clients: w.clients(), key: '953', stage: 'follow', status: 'done', to: 'translation', now: NOW });
  assert.equal(read(w, '953').prs[0].openQuestions, undefined, "a person's forward move: the owner's check is done");
});

// ------------------------------------------------------------------ AC-5: the check label follows the open questions

test('AC-5: after each answerComments the runner sets the check label from the questions left open; the owner\'s removal stands until the next record', async () => {
  const c = card({ number: 954, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 54, headCommit: HEAD, labels: ['In final review'] });
  const comments = [];
  const w = world({ cards: [c], prs: [forgePr], activity: { 'guide-docs#54': { comments } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 54, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const say = (id, body) => comments.push({ id, author: 'owner-login', body, createdAt: ago(1), updatedAt: ago(1) });
  let questions = [];
  const briefs = [];
  const spawnClaude = async (cmd) => {
    briefs.push(briefOf(cmd));
    const summary = 8000 + briefs.length;
    await runRecord({ settings: w.settings, clients: w.clients(), key: '954', stage: 'answerComments', pr: 'guide-docs#54', status: 'done', result: { handled: comments.map((x) => ({ id: x.id, updatedAt: x.updatedAt })), summary: { id: summary }, questions, posted: [summary] }, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const has = () => forgePr.labels.includes(CHECK);

  say(1, 'Чому тут «Зберегти»?');
  questions = [{ text: 'Яку назву кнопки лишити?', n: 3 }];
  assert.deepEqual((await run(w, spawnClaude, { named: ['954'] })).ran.map((r) => r.stage), ['answerComments']);
  assert.equal(has(), true, 'a question is open: on');
  assert.match(briefs[0], /Record in `questions` every question to the owner left open after this round/);

  forgePr.labels = forgePr.labels.filter((l) => l !== CHECK); // the owner takes it off
  assert.deepEqual((await run(w, spawnClaude, { named: ['954'] })).ran, [], 'nothing to answer');
  assert.equal(has(), false, 'between two records the owner\'s removal stands');

  say(2, 'Ок, дивлюся далі.');
  assert.deepEqual((await run(w, spawnClaude, { named: ['954'] })).ran.map((r) => r.stage), ['answerComments']);
  assert.match(briefs[1], /Questions to the owner still open on this PR, from its earlier summaries:\n- 3: "Яку назву кнопки лишити\?"/);
  assert.equal(has(), true, 'still open after the next record: put back');

  say(3, '3 — лиши «Зберегти»');
  questions = [];
  await run(w, spawnClaude, { named: ['954'] });
  assert.equal(has(), false, 'none left: off');
  assert.deepEqual(labelCalls(w).map((x) => [x.add, x.remove]), [[[CHECK], []], [[CHECK], []], [[], [CHECK]]]);
});

test('AC-5: no check label in the settings: no label call; a forge that refuses the label is a warning and the step stands', async () => {
  const c = card({ number: 955, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 55, headCommit: HEAD });
  const w = world({ cards: [c], prs: [forgePr], extra: { forge: { ...rawSettings().forge, checkLabel: null } } });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 55, targets: ['guide'], review: 'sme', stage: 'finalReview' }] });
  const before = labelSnapshot(w.settings.state, ['955']);
  await runRecord({ settings: w.settings, clients: w.clients(), key: '955', stage: 'answerComments', pr: 'guide-docs#55', status: 'done', result: { handled: [], summary: { id: 1 }, questions: [{ text: 'q' }], posted: [1] }, now: NOW });
  assert.deepEqual(labelChanges(before, w.settings.state, ['955'], w.settings.forge), []);
  const failing = { forge: { addLabel: async () => { throw new Error('no such label'); }, removeLabel: async () => {} } };
  const warnings = await followLabels({ settings: { ...w.settings, forge: { ...w.settings.forge, checkLabel: CHECK } }, clients: failing, keys: ['955'], before });
  assert.deepEqual(warnings, [`guide-docs#55: the label '${CHECK}' was not added: no such label`]);
});

// ------------------------------------------------------------------ AC-4: the ready label

test('AC-4: the ready label goes on when a PR is marked ready and comes off when it leaves ready for merge, never on a merged PR', async () => {
  const c = card({ number: 956, status: 'translation' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 56, headCommit: HEAD })], extra: WITH_READY });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 56, targets: ['guide'], review: 'sme', stage: 'translation', readyForMerge: [] }] });
  const change = (fn) => {
    const before = labelSnapshot(w.settings.state, ['956']);
    const now = read(w, '956');
    fn(now.prs[0]);
    writeLedger(w.settings.state, now);
    return labelChanges(before, w.settings.state, ['956'], w.settings.forge).map((x) => [x.label, x.add]);
  };
  assert.deepEqual(change((p) => ((p.stage = 'readyForMerge'), p.readyForMerge.push({ head: HEAD }))), [[READY, true]], 'marked ready');
  assert.deepEqual(change((p) => p.readyForMerge.push({ head: OLD })), [[READY, true]], 'marked ready again for a new head: put back');
  assert.deepEqual(change((p) => (p.label = 'x')), [], 'nothing about ready changed');
  for (const out of ['finalReview', 'translation', 'questions', 'writing']) {
    change((p) => (p.stage = 'readyForMerge'));
    assert.deepEqual(change((p) => (p.stage = out)), [[READY, false]], `left for ${out}`);
  }
  change((p) => (p.stage = 'readyForMerge'));
  assert.deepEqual(change((p) => (p.stage = 'merged')), [], 'merged: left as it is');
  // No ready label in the settings: none.
  assert.deepEqual(labelChanges(new Map(), w.settings.state, ['956'], { ...w.settings.forge, readyLabel: null }), []);
});

// The run itself, through the real git of a ticket worktree: worktree.test.mjs, "the ready label".
test('AC-4: the plan of row 8 takes the ready label off a ready PR it sends back, and the plan of ready for merge puts it on', async () => {
  const c = card({ number: 957, status: 'finalReview' });
  const git = { branchCommits: () => [], changedUnder: (t, from, to) => (from === OLD && to === HEAD ? ['docs/a.md'] : []), commitsBetween: () => [HEAD], pagesOf: () => [] };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 57, headCommit: HEAD, labels: ['In final review', READY] })], git, extra: WITH_READY });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 57, targets: ['guide'], review: 'sme', stage: 'readyForMerge', pipelineCommits: [HEAD], readyForMerge: [{ head: OLD, at: ago(5), seq: 5 }] }] });
  const step = (await w.one('957')).steps[0];
  assert.deepEqual([step.stage, step.to], ['move', 'finalReview']);
  assert.deepEqual(scriptedCalls({ ...step, keys: ['957'] }, read(w, '957'), w.settings).slice(0, 2), ['forge set-stage-label --target guide --number 57 --stage finalReview', `forge remove-label --repo guide-docs --number 57 --label "${READY}"`]);
  assert.deepEqual(scriptedCalls({ stage: 'readyForMerge', pr: 'guide-docs#57', keys: ['957'] }, read(w, '957'), w.settings), ['forge set-stage-label --target guide --number 57 --stage finalReview', `forge add-label --repo guide-docs --number 57 --label "${READY}"`]);
});

test('AC-1, AC-2: the video gate comment the runner posts gets the header once, and its first line is looked for past it', async () => {
  const c = card({ number: 958, status: 'inProgress' });
  const failedTry = [{ at: ago(1), outcome: 'failed', reason: 'a sign-in wall' }];
  const gateOf = (gateComment) => ({ videos: [{ file: 't/v.mp4', parts: [{ file: 't/v-part1.mp4', start: 0, transcript: 't/v-part1-transcript.txt', tries: failedTry }] }], gateComment, at: ago(5) });
  // A session that copied the header into its gate text: posted with one header, and its first line is the gate's.
  const w = world({ cards: [c], extra: { commentHeader: HEADER, video: { browserProfile: '/somewhere/profile', partsPerDay: 3 } } });
  ledger(w, c, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoTry: 'done' }, video: gateOf(`${HEADER}\n\nBlocked: a video is needed\nParts: v-part1`) });
  const out = await run(w, noSession, { named: ['958'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['videoBlock', 'done']]);
  assert.deepEqual(w.tracker.log.filter((x) => x[0] === 'comment').map((x) => x[2]), [`${HEADER}\n\nBlocked: a video is needed\nParts: v-part1`]);
  assert.equal(c.placeId, LISTS.blocked.id);
});

test('AC-5: a PR with two cards: each ledger is compared with itself, so a step with no new record changes no label, and one record on both gives one call', async () => {
  const c = { a: card({ number: 959, status: 'finalReview' }), b: card({ number: 960, status: 'finalReview' }) };
  const w = world({ cards: Object.values(c), prs: [pr({ repo: 'guide-docs', number: 59, headCommit: HEAD })] });
  const shared = (seq) => ({ repo: 'guide-docs', number: 59, targets: ['guide'], review: 'sme', stage: 'finalReview', openQuestions: { items: [{ text: 'Which?' }], stage: 'answerComments', at: ago(2), seq } });
  // Each ledger numbers its records on its own: the same PR's last answer is record 5 in one and 9 in the other.
  ledger(w, c.a, { stages: BASE, group: 'g', prs: [shared(5)] });
  ledger(w, c.b, { stages: BASE, group: 'g', prs: [shared(9)] });
  const keys = ['959', '960'];
  let before = labelSnapshot(w.settings.state, keys);
  assert.deepEqual(labelChanges(before, w.settings.state, keys, w.settings.forge), [], 'nothing recorded: the owner\'s removal stands');
  before = labelSnapshot(w.settings.state, keys);
  for (const key of keys) await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'answerComments', pr: 'guide-docs#59', status: 'done', result: { handled: [], summary: { id: 7059 }, questions: [{ text: 'Which?' }], posted: [7059] }, now: NOW });
  assert.deepEqual(labelChanges(before, w.settings.state, keys, w.settings.forge), [{ repo: 'guide-docs', number: 59, label: CHECK, add: true }]);
});
