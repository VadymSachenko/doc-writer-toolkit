import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LISTS, NOW, ago, card, gitRepo, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runDaily, scriptedCalls } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { labelChanges, labelSnapshot } from '../lib/pr-labels.mjs';
import { writeLedger } from '../lib/ledger.mjs';
import { renderReport } from '../lib/report.mjs';
import { renderProgress } from '../lib/progress.mjs';
import { computeStatus } from '../lib/status.mjs';
import { makeGit } from '../lib/world.mjs';
import { worktreePath } from '../lib/worktree.mjs';
import { syncIds } from '../lib/id-sync.mjs';
import { mergedUntranslated } from '../lib/progress.mjs';

// The translated label (`forge.translatedLabel`): whether a PR's translations match its UA, next to the stage label and
// the ready label. Each row of the scenarios is a test below, through the real git of a target clone; then a person's
// edit of an EN heading after the translation (the runner's id step), and the warning on a merge without the label.

const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];
const EN = 'i18n/en/docusaurus-plugin-content-docs/current';
const DE = 'i18n/de/docusaurus-plugin-content-docs/current';
const STAGE = 'In final review';
const READY = 'Merge advised';
const TRANSLATED = 'Translations match';
const LABELS = { forge: { ...rawSettings().forge, readyLabel: READY, translatedLabel: TRANSLATED } };
const stageOf = (cmd) => /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];

// The pages: on the base, a published heading (`old-part`); the PR adds a heading (`new-fields`) and links to both.
const BASE = {
  ua: '# Сторінка\n\n## Стара частина {/* #old-part */}\n\nТекст.\n',
  en: '# Page\n\n## Old part\n\nText.\n',
  de: '# Seite\n\n## Alter Teil {/* #old-part */}\n\nText.\n',
};
const PAGES = {
  'docs/x/index.md': `${BASE.ua}\n## Нові поля {/* #new-fields */}\n\nДив. [нові поля](#new-fields).\n`,
  [`${EN}/x/index.md`]: `${BASE.en}\n## New fields\n\nSee [new fields](#new-fields).\n`,
  [`${DE}/x/index.md`]: `${BASE.de}\n## Neue Felder {/* #new-fields */}\n\nSiehe [neue Felder](#new-fields).\n`,
  'docs/y/other.md': '# Інша\n\nДив. [стару частину](/x/#old-part) і [нові поля](/x/#new-fields).\n',
  [`${EN}/y/other.md`]: '# Other\n\nSee [the old part](/x/#old-part) and [the new fields](/x/#new-fields).\n',
};

// A target clone with a bare origin, the base with its pages, and the ticket branch with the PR's pages (the pipeline's
// commit, its draft and translation). `handEdit` is the owner's push from a clone of their own.
function setup({ extra = LABELS, stage = 'readyForMerge', translated = true, base = BASE } = {}) {
  const c = card({ number: 1194, status: stage === 'translation' ? 'translation' : stage === 'smeReview' ? 'smeReview' : 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 57, head: 'ticket-57', labels: [STAGE, ...(stage === 'readyForMerge' ? [READY] : []), ...(translated ? [TRANSLATED] : [])] });
  const w = world({ cards: [c], prs: [forgePr], extra });
  const bare = path.join(tmp('origin-'), 'guide-docs.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'guide-docs'));
  clone.commit({
    '.gitignore': 'node_modules/\n.sources/\nbuild/\n',
    'CLAUDE.md': `# Site\n\n## Documentation toolkit configuration\n\n- **UA content root:** \`docs/\`\n- **EN i18n root:** \`${EN}/\`\n`,
    'docusaurus.config.ts': "export default { i18n: { defaultLocale: 'uk', locales: ['uk', 'en', 'de'] } };\n",
    'docs/x/index.md': base.ua,
    [`${EN}/x/index.md`]: base.en,
    [`${DE}/x/index.md`]: base.de,
    'docs/y/other.md': '# Інша\n\nДив. [стару частину](/x/#old-part).\n',
    [`${EN}/y/other.md`]: '# Other\n\nSee [the old part](/x/#old-part).\n',
  }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  clone.g('fetch', '-q', 'origin');
  clone.g('checkout', '-q', '-b', 'ticket-57');
  const h1 = clone.commit(PAGES, 'Draft and translation');
  clone.g('push', '-q', 'origin', 'ticket-57');
  // The forge shows the branch as origin has it, a push of the runner's own included.
  const originHead = () => execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/ticket-57'], { encoding: 'utf8' }).trim();
  Object.defineProperty(forgePr, 'headCommit', { get: originHead, enumerable: true });
  const other = path.join(tmp('owner-'), 'guide-docs');
  execFileSync('git', ['clone', '-q', bare, other]);
  const og = (...args) => execFileSync('git', ['-C', other, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const [k, v] of [['user.email', 'owner@example.com'], ['user.name', 'Owner'], ['commit.gpgsign', 'false']]) og('config', k, v);
  og('checkout', '-q', 'ticket-57');
  const handEdit = (edit) => {
    og('fetch', '-q', 'origin');
    og('reset', '-q', '--hard', 'origin/ticket-57');
    for (const [rel, fn] of Object.entries(edit)) {
      const file = path.join(other, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof fn === 'function' ? fn(fs.readFileSync(file, 'utf8')) : fn);
    }
    og('add', '-A');
    og('commit', '-q', '-m', 'Fix: by hand');
    og('push', '-q', 'origin', 'ticket-57');
    return og('rev-parse', 'HEAD');
  };
  const chain = Object.fromEntries(CHAIN.map((s, i) => [s, { status: 'done', head: h1, seq: 10 + i }]));
  const ready = stage === 'readyForMerge' || translated;
  ledger(w, c, {
    stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' },
    prs: [{ repo: 'guide-docs', number: 57, url: forgePr.url, targets: ['guide'], review: 'sme', branch: 'ticket-57', stage, pipelineCommits: [h1], chain, ...(ready ? { readyForMerge: [{ head: h1, at: ago(9), seq: 20 }] } : {}), ...(translated ? { translated: { head: h1, at: ago(9), seq: 20 } } : {}) }],
  });
  const show = (sha, rel) => execFileSync('git', ['-C', bare, 'show', `${sha}:${rel}`], { encoding: 'utf8' });
  const filesOf = (from, to) => execFileSync('git', ['-C', bare, 'diff', '--name-only', from, to], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  return { w, c, forgePr, bare, h1, handEdit, originHead, show, filesOf };
}

// A run; a session stand-in that records its stage done at the forge's head (a style check lists the shas its brief named).
function runner(t, { sessions = [] } = {}) {
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    sessions.push(stage);
    const result = stage === 'styleCheck' ? { reviewed: [...briefOf(cmd).matchAll(/^- ([0-9a-f]{40}): /gm)].map((m) => ({ sha: m[1] })) } : {};
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1194', stage, pr: 'guide-docs#57', status: 'done', head: t.originHead(), result, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  return () => runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, sleep: async () => {}, spawnClaude }, options: { trigger: 'watcher', named: ['1194'] } });
}
const labelCalls = (t) => t.w.forge.log.filter((x) => x[0] === 'changeLabels').map((x) => [x[3], x[4]]);
const touches = (t, label) => labelCalls(t).filter(([add, remove]) => [...add, ...remove].includes(label));
const stages = (out) => out.ran.map((r) => r.stage);

// ------------------------------------------------------------------ the scenarios, row by row

test('AC-1: ticket 1194 replayed: after the chain #57 carries the stage label, the ready label and the translated label; the owner\'s move to In translation again starts no step and keeps them', async () => {
  const t = setup({ stage: 'translation', translated: false });
  const sessions = [];
  const go = runner(t, { sessions });
  const first = await go();
  assert.deepEqual(stages(first), ['readyForMerge', 'move'], 'the chain was done: ready for merge, and the card back in the owner\'s queue');
  assert.deepEqual(t.forgePr.labels.filter((l) => [STAGE, READY, TRANSLATED].includes(l)).sort(), [STAGE, READY, TRANSLATED].sort());
  assert.deepEqual(read(t.w, '1194').prs[0].translated.head, t.h1);
  const calls = labelCalls(t).length;
  // 04:00: the owner moves the card to In translation again; nothing changed.
  t.c.placeId = LISTS.translation.id;
  const again = await go();
  assert.deepEqual(sessions, [], 'no model step');
  assert.deepEqual(stages(again), ['follow', 'move'], 'the move is followed and the card comes back');
  assert.equal(t.c.placeId, LISTS.finalReview.id);
  assert.deepEqual(touches(t, TRANSLATED).length + touches(t, READY).length, 2, 'only the two adds of the first run: no label came off');
  assert.equal(labelCalls(t).length, calls);
  assert.ok([STAGE, READY, TRANSLATED].every((l) => t.forgePr.labels.includes(l)));
});

test('row: the chain runs: no translated label until ready for merge; never translated: none', async () => {
  const t = setup({ stage: 'translation', translated: false });
  t.forgePr.labels = [STAGE];
  const l = read(t.w, '1194');
  delete l.prs[0].readyForMerge;
  l.prs[0].chain = { translate: { status: 'done', head: t.h1, seq: 10 } };
  writeLedger(t.w.settings.state, l);
  const before = labelSnapshot(t.w.settings.state, ['1194']);
  await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1194', stage: 'enReview', pr: 'guide-docs#57', status: 'done', head: t.h1, now: NOW });
  assert.deepEqual(labelChanges(before, t.w.settings.state, ['1194'], t.w.settings.forge), [], 'a chain stage puts no label on');
  assert.equal(read(t.w, '1194').prs[0].translated, undefined);
});

test('row: moved back after the translation with UA unchanged (the expert called, back to work, back to the queue): the translated label stays, the ready label comes off', async () => {
  const t = setup();
  const go = runner(t);
  for (const to of ['smeReview', 'inProgress', 'finalReview']) {
    t.c.placeId = LISTS[to].id;
    const out = await go();
    assert.equal(out.ran[0].stage, 'follow', to);
  }
  assert.deepEqual(touches(t, READY), [[[], [READY]]], 'the ready label came off once, at the first move back');
  assert.deepEqual(touches(t, TRANSLATED), [], 'the translated label is untouched');
  assert.equal(read(t.w, '1194').prs[0].translated.head, t.h1);
});

test('row: UA changed after the translation (the owner\'s final edit): the translated label comes off with the ready label; the owner\'s move then re-syncs it, and it is back on, after the re-sync and before ready for merge', async () => {
  const t = setup();
  const sessions = [];
  const go = runner(t, { sessions });
  const h2 = t.handEdit({ 'docs/x/index.md': (s) => s.replace('Текст.', 'Виправлений текст.') });
  const first = await go();
  assert.deepEqual(stages(first).slice(0, 2), ['untranslated', 'move'], 'the label off first, then back to the owner\'s queue (D-112)');
  assert.equal(read(t.w, '1194').prs[0].translated, undefined);
  assert.ok(!t.forgePr.labels.includes(TRANSLATED) && !t.forgePr.labels.includes(READY));
  assert.ok(!sessions.includes('resync'), 'a UA change after ready translates nothing by itself');
  t.c.placeId = LISTS.translation.id;
  const second = await go();
  assert.deepEqual(stages(second).filter((s) => s !== 'follow' && s !== 'move'), ['resync', 'readyForMerge']);
  assert.deepEqual(touches(t, TRANSLATED), [[[], [TRANSLATED]], [[TRANSLATED], []]], 'off at the UA change, on once the re-sync is done');
  assert.equal(read(t.w, '1194').prs[0].translated.head, h2);
  assert.ok(t.forgePr.labels.includes(READY) && t.forgePr.labels.includes(TRANSLATED));
});

test('row: an answer to a comment that changes UA, at the expert\'s review: the label comes off at any stage, with no other step', async () => {
  const t = setup({ stage: 'smeReview' });
  const l = read(t.w, '1194');
  l.prs[0].pipelineCommits.push(t.handEdit({ 'docs/x/index.md': (s) => s.replace('Текст.', 'Текст за коментарем.') }));
  writeLedger(t.w.settings.state, l);
  const out = await runner(t)();
  assert.deepEqual(stages(out), ['untranslated']);
  assert.deepEqual(touches(t, TRANSLATED), [[[], [TRANSLATED]]]);
  assert.equal(read(t.w, '1194').prs[0].stage, 'smeReview');
});

test('row: only EN, an id or an image changed: the translated label stays', async () => {
  // EN by hand, with no heading changed: its ids checked and found in step (no commit), then ready for its head again,
  // the label untouched.
  const t = setup();
  const h2 = t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('Text.', 'Edited text.') });
  assert.deepEqual(stages(await runner(t)()), ['idSync', 'readyForMerge']);
  assert.equal(t.originHead(), h2, 'no id commit');
  assert.deepEqual(read(t.w, '1194').prs[0].idChecked, [h2]);
  assert.deepEqual(touches(t, TRANSLATED).filter(([, remove]) => remove.length), []);
  assert.equal(read(t.w, '1194').prs[0].translated.head, h2);
  // An id-only change of the pipeline's (a heading id added) and an image: neither takes it off.
  const u = setup();
  const l = read(u.w, '1194');
  l.prs[0].pipelineCommits.push(u.handEdit({ 'docs/y/other.md': '# Інша {/* #other */}\n\nДив. [стару частину](/x/#old-part) і [нові поля](/x/#new-fields).\n' }));
  writeLedger(u.w.settings.state, l);
  const st = await computeStatus({ settings: u.w.settings, clients: u.w.clients(), now: NOW, git: makeGit(u.w.settings) });
  assert.notEqual(st.tickets[0].next?.stage, 'untranslated');
  const v = setup();
  v.handEdit({ 'docs/x/.assets/a.png': 'uk v2', [`${EN}/x/.assets/a.png`]: 'en v2' });
  const out = await runner(v)();
  assert.ok(!stages(out).includes('untranslated'), 'an image change keeps it');
  assert.deepEqual(touches(v, TRANSLATED), []);
});

test('row: merged: frozen; the close records whether the PR had the label', async () => {
  const t = setup();
  t.forgePr.state = 'merged';
  t.forgePr.mergedAt = ago(1);
  t.forgePr.mergeCommit = 'f'.repeat(40);
  t.c.placeId = LISTS.done.id;
  const out = await runner(t)();
  assert.ok(stages(out).includes('close') || stages(out).includes('follow'));
  assert.deepEqual(labelCalls(t), [], 'a merged PR is never touched');
  assert.equal(read(t.w, '1194').prs[0].merged?.translated ?? true, true);
});

// ------------------------------------------------------------------ the gating

test('settings: the id comments default to English texts, a host gives its own, and anything else is refused', async () => {
  const { settingsFor } = await import('./fakes.mjs');
  const root = tmp();
  assert.match(settingsFor(root).idComments.kept, /reply `<rename>`/);
  assert.equal(settingsFor(root, { forge: { ...LABELS.forge, idComments: { rename: 'rename the id' } } }).idComments.rename, 'rename the id');
  assert.throws(() => settingsFor(root, { forge: { ...LABELS.forge, idComments: { other: 'x' } } }), /forge\.idComments must be/);
  assert.throws(() => settingsFor(root, { forge: { ...LABELS.forge, idComments: { kept: '' } } }), /forge\.idComments must be/);
  assert.equal(settingsFor(root, LABELS).forge.translatedLabel, TRANSLATED);
});

test('AC-4: with no translated label in the settings: no step, no record, no label call; the rule runs as before', async () => {
  const t = setup({ extra: { forge: { ...rawSettings().forge, readyLabel: READY } }, translated: false });
  t.handEdit({ 'docs/x/index.md': (s) => s.replace('Текст.', 'Виправлений текст.') });
  const out = await runner(t)();
  assert.deepEqual(stages(out).slice(0, 1), ['move']);
  assert.ok(!stages(out).includes('untranslated'));
  assert.deepEqual(touches(t, TRANSLATED), []);
  assert.equal(read(t.w, '1194').prs[0].translated, undefined);
  assert.deepEqual(scriptedCalls({ stage: 'readyForMerge', pr: 'guide-docs#57', keys: ['1194'] }, read(t.w, '1194'), t.w.settings).filter((c) => c.includes(TRANSLATED)), []);
  // An EN heading edit: no id step either.
  const u = setup({ extra: { forge: { ...rawSettings().forge } }, translated: false });
  u.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## New fields', '## Added fields') });
  assert.deepEqual(stages(await runner(u)()), ['readyForMerge']);
});

test('the plan of a dry run names the translated label: on at ready for merge, off at the untranslated step', () => {
  const t = setup();
  const l = read(t.w, '1194');
  const calls = scriptedCalls({ stage: 'readyForMerge', pr: 'guide-docs#57', keys: ['1194'] }, l, t.w.settings);
  assert.ok(calls.includes(`forge add-label --repo guide-docs --number 57 --label "${TRANSLATED}"`));
  assert.deepEqual(scriptedCalls({ stage: 'untranslated', pr: 'guide-docs#57', keys: ['1194'] }, l, t.w.settings), [`forge remove-label --repo guide-docs --number 57 --label "${TRANSLATED}"`]);
});

// ------------------------------------------------------------------ scope 3: a hand edit of an EN heading

// The forge's review and reply, kept: the line comments the runner posts, and the owner's replies in their threads.
function reviewsOf(t) {
  const posted = [];
  let next = 7100;
  t.w.forge.diffLines = async () => [{ path: `${EN}/x/index.md`, lines: null }];
  t.w.forge.createReview = async (a) => {
    const made = { id: ++next, comments: a.comments.map((c) => ({ id: ++next, path: c.path, line: c.line, body: c.body })) };
    posted.push({ kind: 'review', ...a, made });
    return made;
  };
  t.w.forge.reviewComment = async ({ id }) => ({ id: Number(id), number: 57, path: `${EN}/x/index.md`, line: 3, inReplyTo: null, body: 'x' });
  t.w.forge.reply = async (a) => (posted.push({ kind: 'reply', ...a }), { id: ++next });
  return posted;
}

test('AC-3: an EN heading edited by hand after the translation: a heading new in the PR renames its UA id, every locale\'s and the links; a published one keeps its id on the EN heading; one pipeline commit, line comments, no word changed, the labels stay', async () => {
  const t = setup();
  const posted = reviewsOf(t);
  const sessions = [];
  const h2 = t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## New fields', '## Added fields').replace('## Old part', '## Earlier part') });
  const out = await runner(t, { sessions })();
  assert.deepEqual(stages(out), ['idSync', 'readyForMerge'], 'the id step, then ready for its head');
  assert.deepEqual(sessions, []);
  const h3 = t.originHead();
  assert.notEqual(h3, h2);
  assert.equal(execFileSync('git', ['-C', t.bare, 'rev-parse', `${h3}^`], { encoding: 'utf8' }).trim(), h2, 'one commit on top of the owner\'s');
  assert.deepEqual(t.filesOf(h2, h3), ['docs/x/index.md', 'docs/y/other.md', `${DE}/x/index.md`, `${EN}/x/index.md`, `${EN}/y/other.md`].sort());
  assert.equal(t.show(h3, 'docs/x/index.md'), PAGES['docs/x/index.md'].replaceAll('new-fields', 'added-fields'), 'UA: the comment and its own link');
  assert.equal(t.show(h3, `${DE}/x/index.md`), PAGES[`${DE}/x/index.md`].replaceAll('new-fields', 'added-fields'), 'the locale carries the comment verbatim');
  assert.equal(t.show(h3, `${EN}/x/index.md`), `${BASE.en.replace('## Old part', '## Earlier part \\{#old-part}')}\n## Added fields\n\nSee [new fields](#added-fields).\n`, 'EN: the published id kept explicitly, the link it copied from UA');
  assert.equal(t.show(h3, 'docs/y/other.md'), PAGES['docs/y/other.md'].replace('/x/#new-fields', '/x/#added-fields'), 'a link to the published id stays');
  assert.equal(t.show(h3, `${EN}/y/other.md`), PAGES[`${EN}/y/other.md`].replace('/x/#new-fields', '/x/#added-fields'));
  const l = read(t.w, '1194');
  const p = l.prs[0];
  assert.deepEqual([p.stage, p.readyForMerge.at(-1).head, p.translated.head], ['readyForMerge', h3, h3]);
  assert.ok(p.pipelineCommits.includes(h3) && p.idCommits.some((c) => c.sha === h3) && p.idChecked.includes(h2));
  assert.deepEqual(touches(t, TRANSLATED).filter(([, remove]) => remove.length), [], 'translated stays: only ids changed');
  assert.deepEqual(touches(t, READY).filter(([, remove]) => remove.length), [], 'merge recommended stays');
  // The line comments, under each heading the step changed, on the EN page.
  const review = posted.find((x) => x.kind === 'review');
  assert.equal(review.commit, h3);
  assert.deepEqual(review.comments.map((c) => [c.path, c.line]).sort((a, b) => a[1] - b[1]), [[`${EN}/x/index.md`, 3], [`${EN}/x/index.md`, 7]]);
  const kept = review.comments.find((c) => c.line === 3).body;
  assert.match(kept, /`#old-part`/);
  assert.match(kept, /reply `rename id`/);
  assert.match(review.comments.find((c) => c.line === 7).body, /`#new-fields` is now `#added-fields`.*5 link\(s\)/s);
  assert.deepEqual(p.idComments.map((c) => [c.kind, c.old, c.new, typeof c.commentId]).sort(), [['kept', 'old-part', 'earlier-part', 'number'], ['renamed', 'new-fields', 'added-fields', 'number']]);
  assert.ok(p.idComments.every((c) => l.posted.pr.map(String).includes(String(c.commentId))), 'the runner\'s comments are its own, never read as the owner\'s');
  // Nothing more to do: the next run starts nothing.
  assert.deepEqual(stages(await runner(t)()), []);

  // The owner asks for the rename of the published id in its thread: the first branch, for that heading.
  const keptId = p.idComments.find((c) => c.kind === 'kept').commentId;
  t.w.forge.activity['guide-docs#57'] = { threads: [{ id: 'T1', path: `${EN}/x/index.md`, line: 3, comments: [
    { id: keptId, author: 'owner-login', body: kept, createdAt: ago(1), updatedAt: ago(1), reviewId: review.made.id },
    { id: 9001, author: 'owner-login', body: 'Rename id', inReplyTo: keptId, createdAt: ago(0.5), updatedAt: ago(0.5), reviewId: 9100 },
  ] }] };
  const asked = await runner(t, { sessions })();
  assert.deepEqual(stages(asked), ['idSync', 'readyForMerge'], 'no answerComments session');
  assert.deepEqual(sessions, []);
  const h4 = t.originHead();
  assert.deepEqual(t.filesOf(h3, h4), ['docs/x/index.md', 'docs/y/other.md', `${DE}/x/index.md`, `${EN}/x/index.md`, `${EN}/y/other.md`].sort());
  assert.equal(t.show(h4, `${EN}/x/index.md`), t.show(h3, `${EN}/x/index.md`).replace(' \\{#old-part}', '').replace('#old-part', '#earlier-part'));
  assert.equal(t.show(h4, 'docs/x/index.md'), t.show(h3, 'docs/x/index.md').replaceAll('old-part', 'earlier-part'));
  assert.equal(t.show(h4, `${DE}/x/index.md`), t.show(h3, `${DE}/x/index.md`).replaceAll('old-part', 'earlier-part'));
  assert.equal(t.show(h4, 'docs/y/other.md'), t.show(h3, 'docs/y/other.md').replace('/x/#old-part', '/x/#earlier-part'));
  const reply = posted.find((x) => x.kind === 'reply');
  assert.equal(String(reply.comment), String(keptId));
  assert.match(reply.body, /`#old-part` is now `#earlier-part`/);
  const after = read(t.w, '1194').prs[0];
  assert.ok(after.idComments.find((c) => c.kind === 'kept').renamed);
  assert.ok(read(t.w, '1194').reviewComments.some((c) => String(c.id) === '9001'), 'the reply is handled');
  assert.deepEqual(touches(t, TRANSLATED).filter(([, remove]) => remove.length), []);
  assert.deepEqual(stages(await runner(t)()), [], 'nothing more: the reply is not read again');
});

// ------------------------------------------------------------------ scope 4: a merge without the label

test('scope 4: a PR merged without the translated label: the close records it, and the report and the progress file say so with its link', async () => {
  const t = setup();
  t.forgePr.labels = [STAGE];
  t.forgePr.state = 'merged';
  t.forgePr.mergedAt = ago(1);
  t.forgePr.mergeCommit = 'f'.repeat(40);
  t.c.placeId = LISTS.done.id;
  await runner(t)();
  const l = read(t.w, '1194');
  assert.equal(l.prs[0].merged.translated, false);
  const st = { mode: 'on', allowance: null, wip: { inProgress: 0, waiting: 0, limits: { inProgress: 3, waiting: 5 } }, tickets: [], startable: [], notStarted: [], notTickets: [], intake: { due: [] } };
  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(NOW));
  const report = renderReport({ settings: t.w.settings, st, date, ledgers: [l] });
  assert.match(report, new RegExp(`## Merged without «${TRANSLATED}»\\n\\n- \\[guide-docs#57\\]\\(${t.forgePr.url.replace(/[.]/g, '\\.')}\\) \\(1194\\): merged without the label: its translations may be behind main`));
  const progress = renderProgress({ ledgers: [l], now: NOW, translatedLabel: TRANSLATED });
  assert.match(progress, /- ⚠️ 1194 — guide-docs#57: merged without «Translations match»: its translations may be behind main \(https:\/\/forge\.example\/acme\/guide-docs\/pull\/57\)/);
  assert.doesNotMatch(progress, /Nothing waits for you/);
  // With the label on at the merge, or no label set up: nothing to say.
  const withLabel = structuredClone(l);
  withLabel.prs[0].merged.translated = true;
  assert.doesNotMatch(renderReport({ settings: t.w.settings, st, date, ledgers: [withLabel] }), /guide-docs#57\]\(.*merged without/);
  const plain = { ...t.w.settings, forge: { ...t.w.settings.forge, translatedLabel: null } };
  assert.doesNotMatch(renderReport({ settings: plain, st, date, ledgers: [l] }), /Merged without/);
  assert.doesNotMatch(renderProgress({ ledgers: [l], now: NOW }), /merged without/);
});

// ------------------------------------------------------------------ the review round: fixes, each with its test

test('fix 1: a heading published before UA ids existed (its id only an EN anchor on the base) keeps its id: never renamed without the owner asking', async () => {
  const t = setup({ base: { ua: '# Сторінка\n\n## Стара частина\n\nТекст.\n', en: BASE.en, de: '# Seite\n\n## Alter Teil\n\nText.\n' } });
  const posted = reviewsOf(t);
  const h2 = t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## Old part', '## Earlier part') });
  assert.deepEqual(stages(await runner(t)()), ['idSync', 'readyForMerge']);
  const h3 = t.originHead();
  assert.deepEqual(t.filesOf(h2, h3), [`${EN}/x/index.md`], 'only EN: the live #old-part is kept, UA and the locales untouched');
  assert.equal(t.show(h3, `${EN}/x/index.md`), PAGES[`${EN}/x/index.md`].replace('## Old part', '## Earlier part \\{#old-part}'));
  assert.equal(t.show(h3, 'docs/x/index.md'), PAGES['docs/x/index.md']);
  assert.deepEqual(read(t.w, '1194').prs[0].idComments.map((c) => [c.kind, c.old]), [['kept', 'old-part']]);
  assert.match(posted.find((x) => x.kind === 'review').comments[0].body, /published with the id `#old-part`/);
});

test('fix 2: an id commit whose record is refused after its push (the branch moved) is still the pipeline\'s: no hand commit, no UA change, the label stays', async () => {
  const t = setup();
  const posted = reviewsOf(t);
  const review = t.w.forge.createReview;
  let h3 = null;
  // The owner pushes an EN text edit while the runner posts its line comments: the record of the step sees another head.
  t.w.forge.createReview = async (a) => {
    h3 = t.originHead();
    t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('Text.', 'Edited text.') });
    return review(a);
  };
  t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## New fields', '## Added fields') });
  const first = await runner(t)();
  assert.equal(first.ran[0].stage, 'idSync');
  assert.equal(first.ran[0].outcome, 'moved');
  const p = read(t.w, '1194').prs[0];
  assert.ok(p.idCommits.some((c) => c.sha === h3) && p.pipelineCommits.includes(h3), 'the pushed id commit is recorded with the failed record');
  assert.equal(p.steps.idSync.status, 'failed');
  t.w.forge.createReview = review;
  const next = await runner(t)();
  assert.ok(!stages(next).includes('untranslated') && !stages(next).includes('move') && !stages(next).includes('styleCheck'), stages(next).join(', '));
  assert.deepEqual(touches(t, TRANSLATED).filter(([, remove]) => remove.length), []);
  assert.equal(read(t.w, '1194').prs[0].translated.head, t.originHead());
  assert.ok(posted.length >= 1);
});

test('fix 3: a rename that can\'t be made blocks its page: nothing on it changes, a line comment says why, and the ready PR waits for a later check of that page', async () => {
  const t = setup();
  const posted = reviewsOf(t);
  // The published heading reworded, and the new one given the published heading's words: `new-fields` → `old-part`
  // would take the id the published heading keeps.
  const h2 = t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## Old part', '## Earlier part').replace('## New fields', '## Old part') });
  const out = await runner(t)();
  assert.deepEqual(stages(out), ['idSync'], 'held: no ready for merge');
  assert.equal(t.originHead(), h2, 'no commit: no rename half made');
  const p = read(t.w, '1194').prs[0];
  assert.deepEqual(p.idBlocked.map((b) => [b.sha, b.pages]), [[h2, [`${EN}/x/index.md`]]]);
  assert.ok(!(p.idChecked ?? []).includes(h2), 'not checked as fine');
  const review = posted.find((x) => x.kind === 'review');
  assert.deepEqual(review.comments.map((c) => c.line), [7]);
  assert.match(review.comments[0].body, /not changed: `#new-fields` can't become `#old-part` \('old-part' is already the id of the UA heading on line 3\)/);
  assert.deepEqual(stages(await runner(t)()), [], 'not read again, and still held');
  // The owner rewords the new heading: its check passes, the block goes, and the PR is ready again.
  const h4 = t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## Old part\n\nSee', '## Added fields\n\nSee') });
  assert.deepEqual(stages(await runner(t)()), ['idSync', 'readyForMerge']);
  const after = read(t.w, '1194').prs[0];
  assert.ok(!after.idBlocked?.length, 'the block is gone');
  assert.ok(after.idChecked.includes(h4));
  assert.equal(t.show(t.originHead(), 'docs/x/index.md'), PAGES['docs/x/index.md'].replaceAll('new-fields', 'added-fields'));
});

test('fix 3 and 4, in the id step itself: a chain of renames made whole; a commit a hook refuses leaves the worktree as it was', async () => {
  const root = tmp('ids-');
  const g = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  };
  g('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'Bot'], ['commit.gpgsign', 'false']]) g('config', k, v);
  put({ 'CLAUDE.md': `# Site\n\n## Documentation toolkit configuration\n\n- **UA content root:** \`docs/\`\n- **EN i18n root:** \`${EN}/\`\n`, 'docs/a.md': '# А\n' });
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'pr');
  const UA = '# Сторінка\n\n## Приклад {/* #example */}\n\nТекст.\n\n## Приклад {/* #example-1 */}\n\nДив. [перший](#example) і [другий](#example-1).\n';
  const ENP = '# Page\n\n## Sample\n\nText.\n\n## Example\n\nSee [first](#example) and [second](#example-1).\n';
  put({ 'docs/x.md': UA, [`${EN}/x.md`]: ENP });
  g('add', '-A');
  g('commit', '-q', '-m', 'pr');
  const start = g('rev-parse', 'HEAD');
  // A commit the hook refuses: an error, and the worktree back at its head.
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const refused = await syncIds({ wt: root, base: 'main', pages: [`${EN}/x.md`] });
  assert.match(refused.error ?? '', /the heading ids/);
  assert.equal(refused.reset, true);
  assert.equal(g('status', '--porcelain'), '');
  assert.equal(g('rev-parse', 'HEAD'), start);
  fs.rmSync(hook);
  // The chain, whole: `example` → `sample`, `example-1` → `example`, and both links follow.
  const r = await syncIds({ wt: root, base: 'main', pages: [`${EN}/x.md`] });
  assert.deepEqual(r.fixes.map((f) => [f.kind, f.old, f.new]), [['renamed', 'example', 'sample'], ['renamed', 'example-1', 'example']]);
  assert.equal(fs.readFileSync(path.join(root, 'docs/x.md'), 'utf8'), UA.replace('{/* #example */}', '{/* #sample */}').replace('{/* #example-1 */}', '{/* #example */}').replace('(#example) і [другий](#example-1)', '(#sample) і [другий](#example)'));
  assert.equal(fs.readFileSync(path.join(root, `${EN}/x.md`), 'utf8'), ENP.replace('(#example) and [second](#example-1)', '(#sample) and [second](#example)'), 'no EN link left pointing nowhere');
  assert.equal(g('status', '--porcelain'), '');
});

test('fix 6a: a push refused for another reason than a moved branch (a hook, rights) is a failed step, the worktree back at its head', async () => {
  const t = setup();
  reviewsOf(t);
  const h2 = t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## New fields', '## Added fields') });
  fs.writeFileSync(path.join(t.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
  const out = await runner(t)();
  assert.equal(out.ran[0].stage, 'idSync');
  assert.equal(out.ran[0].outcome, 'failed');
  assert.match(out.ran[0].note, /push of the id commit was refused/);
  const wt = worktreePath(t.w.settings, read(t.w, '1194').prs[0]);
  assert.equal(execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), h2);
  assert.equal(execFileSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '');
  assert.equal(read(t.w, '1194').prs[0].steps.idSync.status, 'failed');
});

test('fix 6b: a rename the owner asks for that changes nothing gets a reply saying why; the reply is the runner\'s and the request is handled', async () => {
  const t = setup();
  const posted = reviewsOf(t);
  t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## Old part', '## Earlier part') });
  await runner(t)();
  const kept = read(t.w, '1194').prs[0].idComments.find((c) => c.kind === 'kept');
  // The owner puts the old words back, then asks for the rename all the same.
  t.handEdit({ [`${EN}/x/index.md`]: (s) => s.replace('## Earlier part \\{#old-part}', '## Old part') });
  await runner(t)();
  t.w.forge.activity['guide-docs#57'] = { threads: [{ id: 'T1', path: `${EN}/x/index.md`, line: 3, comments: [
    { id: kept.commentId, author: 'owner-login', body: 'x', createdAt: ago(1), updatedAt: ago(1), reviewId: 1 },
    { id: 9002, author: 'owner-login', body: 'rename id.', inReplyTo: kept.commentId, createdAt: ago(0.5), updatedAt: ago(0.5), reviewId: 9101 },
  ] }] };
  const before = t.originHead();
  const out = await runner(t)();
  assert.equal(out.ran[0].stage, 'idSync');
  assert.equal(t.originHead(), before, 'no commit');
  const reply = posted.find((x) => x.kind === 'reply');
  assert.equal(String(reply.comment), String(kept.commentId));
  assert.match(reply.body, /^The id `#old-part` is not renamed: .*already has the id 'old-part'/);
  const l = read(t.w, '1194');
  assert.ok(l.reviewComments.some((c) => String(c.id) === '9002'), 'handled');
  assert.ok(!l.prs[0].idComments.find((c) => c.kind === 'kept').renamed, 'not marked renamed');
  assert.ok(l.posted.pr.length > 0);
});

test('fix 6d: a merged hand-mode ticket is not listed as merged without the label', () => {
  const l = { key: '9', mode: 'hand', stages: { close: { status: 'done', at: new Date(NOW).toISOString() } }, prs: [{ repo: 'guide-docs', number: 3, merged: { translated: false } }] };
  const today = () => true;
  assert.deepEqual(mergedUntranslated([l], today), []);
  assert.equal(mergedUntranslated([{ ...l, mode: 'pipeline' }], today).length, 1);
});
