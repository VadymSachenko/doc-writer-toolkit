import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeAdapter, gitRepo, pr as forgePr, settingsFor, tmp } from './fakes.mjs';
import { newLedger, newPr, writeLedger, readAllLedgers } from '../lib/ledger.mjs';
import { blocksOf, changedBlocks, collectEdits, entriesOf, logPath, readLog } from '../lib/learn-log.mjs';
import { checkPatterns, editKit, kindOf, learningCheck, learnStatus, learnWanted, markerOf, namesIn, namesOf, readLearning, renderBody, resolveRuleReply, trendOf, weekDue, weekOf } from '../lib/learn.mjs';
import { formOf, insertRule, ruleFiles, scriptOf } from '../lib/rule-insert.mjs';
import { commandFor } from '../lib/runner.mjs';
import { main } from '../ticket-state.mjs';
import { annotationProblems, rootRefs } from '../../../../../tools/lint-plugin.mjs';

// Learning from the owner's edits (TASK-054): the collection with no model (point 1, and the backfill of the PRs merged
// this week), the weekly proposal (point 2, AC-1), the host PR (point 3), the reply by number (point 4, AC-2), the
// toolkit PR in the target file's own form (point 5, AC-3). Every text below is invented and names no real product.

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const MONDAY = Date.parse('2026-11-16T09:00:00+02:00');
const WINDOW = '2026-11-09T00:00:00+02:00';

// A clone with an origin: `<root>/repos/<name>` and its bare remote.
function hostRepo(root, name, files) {
  const origin = path.join(root, 'origins', `${name}.git`);
  fs.mkdirSync(origin, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const r = gitRepo(path.join(root, 'repos', name));
  const base = r.commit(files, 'Start');
  r.g('remote', 'add', 'origin', origin);
  r.g('push', '-q', 'origin', 'main');
  r.g('fetch', '-q', 'origin');
  return { ...r, origin, base };
}

const PAGE = 'docs/x/a.md';
const PAGE_TEXT = '---\ntitle: Полив\n---\n\n# Полив\n\n## Ранковий полив\n\nПолийте розсаду, яку ви пересадили вчора.\n\nНатисніть **Почати**.\n\n## Пауза\n\nПолив можна зупинити до заходу сонця.\n';
const OWNER = 'test@example.com';
const LEARN = { since: WINDOW, authors: [OWNER] };

// A commit by someone else than the owner (an expert's push).
const commitAs = (r, email, files, message) => {
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(r.dir, rel), text);
  r.g('add', '-A');
  r.g('-c', `user.email=${email}`, '-c', 'user.name=Someone', 'commit', '-q', '-m', message);
  return r.g('rev-parse', 'HEAD');
};
const read = (r) => fs.readFileSync(path.join(r.dir, PAGE), 'utf8');

// A PR with four kinds of owner's edits: an applied comment, a restored style fix, a hand commit before ready for
// merge and the final edit after it; around them the pipeline's own commits (one recorded only in its round) and an
// expert's push. Merged into main with a merge commit, as the forge merges.
function editedPr(root, { merge = true } = {}) {
  const r = hostRepo(root, 'guide-docs', { [PAGE]: PAGE_TEXT, 'i18n/en/docusaurus-plugin-content-docs/current/x/a.md': '# Watering\n\nText.\n' });
  r.g('checkout', '-q', '-b', 'ticket-57');
  const draft = r.commit({ [PAGE]: PAGE_TEXT.replace('до заходу сонця', 'до самого заходу сонця') }, 'Draft: watering');
  const round = r.commit({ [PAGE]: read(r).replace('Полив можна зупинити', 'Полив можна призупинити') }, 'Round 1: the comments');
  const hand = r.commit({ [PAGE]: read(r).replace('Полийте розсаду, яку ви пересадили вчора.', 'Полийте розсаду.'), 'i18n/en/docusaurus-plugin-content-docs/current/x/a.md': '# Watering\n\nText, edited.\n' }, 'дата пересадки тут зайва');
  const expert = commitAs(r, 'expert@example.com', { [PAGE]: read(r).replace('## Пауза', '## Зупинка') }, 'Rename the heading');
  const ready = r.commit({ 'docs/x/b.md': '# Інша\n\nТекст.\n' }, 'EN translation');
  const final = r.commit({ [PAGE]: read(r).replace('Натисніть **Почати**.', 'Натисніть **Почати полив**.') }, 'Update a.md');
  r.g('push', '-q', 'origin', 'ticket-57');
  let mergeCommit = null;
  if (merge) {
    r.g('checkout', '-q', 'main');
    r.g('merge', '-q', '--no-ff', '-m', 'Merge pull request #57', 'ticket-57');
    mergeCommit = r.g('rev-parse', 'HEAD');
    r.g('push', '-q', 'origin', 'main');
  }
  r.g('fetch', '-q', 'origin');
  return { r, draft, round, hand, expert, ready, final, mergeCommit };
}

function edited(settings, key, number, extra = {}) {
  const l = newLedger({ key, card: { id: `c${key}`, shortLink: `s${key}`, url: `https://tracker.example/c/s${key}`, name: `Card ${key}` }, now: new Date(MONDAY - 9 * 86400000).toISOString() });
  l.prs.push({ ...newPr({ repo: 'guide-docs', targets: ['guide'], review: 'sme', branch: `ticket-${number}` }), number, url: `https://forge.example/acme/guide-docs/pull/${number}`, ...extra });
  writeLedger(settings.state, l);
  return l;
}

test('point 1: on a PR merged with a merge commit, the collector logs the applied comment, the restored style fix, the hand edit and the final edit, block by block, the owner\'s only; a second run adds nothing', async () => {
  const root = tmp();
  const settings = settingsFor(root, { learning: LEARN });
  const { draft, round, hand, ready, final, mergeCommit } = editedPr(root);
  const l857 = edited(settings, '857', 57, {
    pipelineCommits: [draft.slice(0, 7), ready],
    rounds: [{ stage: 'answerComments', commits: [{ sha: round, role: 'comments' }] }],
    readyForMerge: [{ head: ready, at: new Date(MONDAY - 3 * 86400000).toISOString(), seq: 9 }],
    styleChecked: [{ sha: hand, reason: 'читач поливає щодня, не лише після пересадки' }],
    edits: [
      { n: 1, list: 'description', stage: 'pr', page: PAGE, block: 'Пауза', before: 'до заходу сонця', after: 'до самого заходу сонця', at: 'x', seq: 1 },
      { n: 2, list: '7001', stage: 'answerComments', page: PAGE, block: 'Пауза', before: 'Полив можна зупинити.', after: 'Полив можна зупинити до заходу сонця.', reason: 'без умови читач не знає меж', at: '2026-11-10T10:00:00Z', seq: 2 },
      { n: 3, list: '7001', stage: 'answerComments', page: PAGE, block: 'Ранковий полив', before: 'Натисніть Почати.', after: 'Натисніть **Почати**.', rule: 'gdsg: ui-elements', at: '2026-11-10T10:00:00Z', seq: 2, rejected: { at: '2026-11-11T10:00:00Z', seq: 3, by: 4 } },
      { n: 4, list: '7002', stage: 'answerComments', page: PAGE, block: 'Ранковий полив', before: 'Натисніть **Почати**.', after: 'Натисніть Почати.', restores: 3, at: '2026-11-11T10:00:00Z', seq: 3 },
      { n: 5, list: '7002', stage: 'answerComments', page: PAGE, block: 'Пауза', before: 'зупинити', after: 'призупинити', reason: 'так точніше', at: '2026-11-11T10:00:00Z', seq: 3 },
    ],
  });
  // The comments each round handled, as the record keeps them; their authors come from the forge, never a model.
  l857.reviewComments = [{ repo: 'guide-docs', pr: 57, at: '2026-11-10T10:00:00Z', id: 9001, result: 'applied' }, { repo: 'guide-docs', pr: 57, at: '2026-11-11T10:00:00Z', id: 9002, replyId: 9003, result: 'applied' }];
  writeLedger(settings.state, l857);
  const authorsOf = async () => new Map([['9001', 'owner-login'], ['9002', 'expert-one'], ['9003', 'owner-login-bot']]);
  // Without the forge (it can't be read): the applied comments wait, the PR is read again.
  const blind = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: async () => ({ head: final, state: 'merged', mergedAt: '2026-11-13T12:00:00Z', mergeCommit }), authorsOf: async () => { throw new Error('offline'); }, now: MONDAY, dryRun: true });
  assert.ok(!blind.added.some((e) => e.source === 'comment') && blind.prs[0].deferred, 'no comment entry while the authors are unknown');
  const views = async () => ({ head: final, state: 'merged', mergedAt: '2026-11-13T12:00:00Z', mergeCommit });
  const r1 = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: views, authorsOf, now: MONDAY });
  const log = readLog(settings.state);
  assert.deepEqual(log.map((e) => e.source).sort(), ['comment', 'final', 'hand', 'restore'], 'not the pipeline\'s fix (1), the restore item itself (4), the expert\'s comment (5), the round\'s commit or the expert\'s push');
  const byS = Object.fromEntries(log.map((e) => [e.source, e]));
  assert.equal(byS.comment.comment, 'без умови читач не знає меж');
  assert.deepEqual([byS.restore.before, byS.restore.after, byS.restore.rule], ['Натисніть **Почати**.', 'Натисніть Почати.', 'gdsg: ui-elements']);
  assert.deepEqual([byS.hand.page, byS.hand.block, byS.hand.before, byS.hand.after, byS.hand.comment], [PAGE, 'Ранковий полив', 'Полийте розсаду, яку ви пересадили вчора.', 'Полийте розсаду.', 'читач поливає щодня, не лише після пересадки'], 'UA only; the style check\'s reason over the commit\'s subject');
  assert.deepEqual([byS.final.before, byS.final.after, byS.final.sha, byS.final.comment], ['Натисніть **Почати**.', 'Натисніть **Почати полив**.', final, 'Update a.md'], 'after the first ready head: the final edit');
  assert.ok(byS.hand.id.startsWith('commit:') && byS.final.id.startsWith('commit:'), 'a commit\'s lines are keyed by the commit, not by their source');
  assert.ok(log.every((e) => e.pr === 57 && e.repo === 'guide-docs' && e.url && e.key === '857'));
  assert.deepEqual([r1.added.length, r1.notes], [4, []]);
  // Once more: nothing added twice, and a merged PR is not read again.
  let asked = 0;
  const r2 = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: async (...a) => (asked++, views(...a)), now: MONDAY });
  assert.deepEqual([r2.added.length, asked, readLog(settings.state).length], [0, 0, 4]);
});

test('point 1: a merged PR whose merge commit isn\'t known lists no hand edit and is read again later, never closed as done with nothing', async () => {
  const root = tmp();
  const settings = settingsFor(root, { learning: LEARN });
  const { draft, round, ready, final, mergeCommit } = editedPr(root);
  edited(settings, '858', 57, { pipelineCommits: [draft, ready], rounds: [{ stage: 'answerComments', commits: [{ sha: round, role: 'comments' }] }] });
  const unknown = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: async () => ({ head: final, state: 'merged', mergedAt: '2026-11-13T12:00:00Z' }), now: MONDAY });
  assert.equal(unknown.added.length, 0);
  assert.match(unknown.notes.join('\n'), /no merge commit known/);
  const known = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: async () => ({ head: final, state: 'merged', mergedAt: '2026-11-13T12:00:00Z', mergeCommit }), now: MONDAY });
  assert.deepEqual(known.added.map((e) => e.source).sort(), ['hand', 'hand'], 'read again: the owner\'s two commits (no ready head here: both hand), the expert\'s push left out');
  assert.ok(!known.added.some((e) => e.after.includes('## Зупинка')));
});

test('the backfill, on real repos: a PR merged with a merge commit in the window is collected, one merged before it is not, a PR closed unmerged is not; the command run twice adds nothing twice; an earlier --since reads again what a later one left out', async () => {
  const root = tmp();
  const settings = settingsFor(root, { learning: LEARN });
  const r = hostRepo(root, 'guide-docs', { [PAGE]: PAGE_TEXT });
  const branch = (n, from, edit, at) => {
    r.g('checkout', '-q', '-b', `ticket-${n}`, from);
    const sha = r.commit({ [PAGE]: read(r).replace(edit[0], edit[1]) }, `owner's edit ${n}`);
    r.g('push', '-q', 'origin', `ticket-${n}`);
    return sha;
  };
  const head61 = branch(61, 'main', ['вчора.', 'вчора ввечері.'], null);
  r.g('checkout', '-q', 'main');
  r.g('merge', '-q', '--no-ff', '-m', 'Merge pull request #61', 'ticket-61');
  const merge61 = r.g('rev-parse', 'HEAD');
  r.g('push', '-q', 'origin', 'main');
  const head63 = branch(63, 'main', ['Натисніть **Почати**.', 'Натисніть **Почати зараз**.'], null);
  const head64 = branch(64, 'main', ['Пауза', 'Перерва'], null);
  const head60 = branch(60, 'main', ['сонця.', 'сонця, о 18:00.'], null);
  r.g('checkout', '-q', 'main');
  r.g('merge', '-q', '--no-ff', '-m', 'Merge pull request #60', 'ticket-60');
  const merge60 = r.g('rev-parse', 'HEAD');
  r.g('push', '-q', 'origin', 'main');
  r.g('fetch', '-q', 'origin');
  const item = (n, at) => ({ n, list: '7100', stage: 'answerComments', page: PAGE, block: 'Пауза', before: `було ${n}`, after: `стало ${n}`, at, seq: n });
  edited(settings, '901', 61, { stage: 'merged', merged: { at: '2026-11-12T10:00:00Z', commit: merge61 }, edits: [item(1, '2026-11-06T10:00:00Z')] });
  edited(settings, '902', 62, { stage: 'merged', merged: { at: '2026-11-06T10:00:00Z', commit: 'f'.repeat(40) }, edits: [item(2, '2026-11-05T10:00:00Z')] });
  edited(settings, '903', 63, { stage: 'finalReview', edits: [item(3, '2026-11-10T10:00:00Z')] });
  edited(settings, '904', 64, { stage: 'finalReview', edits: [item(4, '2026-11-10T10:00:00Z')] });
  edited(settings, '900', 60, { stage: 'merged', merged: { at: '2026-11-08T10:00:00Z', commit: merge60 }, edits: [] });
  // The forge: 61 merged this week, 63 open, 64 closed unmerged (62 and 60 are never asked while their ledgers say
  // they merged before the window).
  const fp = (number, state, headCommit, extra = {}) => Object.assign(forgePr({ number, state, headCommit }), extra);
  const adapter = forgeAdapter({ prs: [fp(60, 'merged', head60, { mergedAt: '2026-11-08T10:00:00Z', mergeCommit: merge60 }), fp(61, 'merged', head61, { mergedAt: '2026-11-12T10:00:00Z', mergeCommit: merge61 }), fp(62, 'merged', 'e'.repeat(40)), fp(63, 'open', head63), fp(64, 'closed', head64)] });
  const out = [];
  const stdout = { write: (s) => out.push(s) };
  const run = async (...extra) => {
    out.length = 0;
    await main(['learn', 'collect', '--root', root, '--settings', settings.file, ...extra], { stdout, forgeAdapter: adapter, env: {} });
    return JSON.parse(out.join(''));
  };
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(settings.file, JSON.stringify((await import('./fakes.mjs')).rawSettings({ learning: LEARN })));
  const dry = await run('--since', WINDOW, '--dry-run');
  assert.deepEqual([dry.dryRun, dry.added, fs.existsSync(path.join(settings.state, 'learning'))], [true, 4, false], 'a dry run lists and writes nothing, not even the learning folder');
  const first = await run('--since', WINDOW);
  const after = () => readLog(settings.state).map((e) => e.after).sort();
  assert.deepEqual(after(), ['Полийте розсаду, яку ви пересадили вчора ввечері.', 'Натисніть **Почати зараз**.', 'стало 1', 'стало 3'].sort(), 'the PR merged this week (its hand commit through the merge commit, its comment from before the window too), and the open one');
  assert.equal(first.added, 4);
  const second = await run('--since', WINDOW);
  assert.deepEqual([second.added, readLog(settings.state).length], [0, 4], 'run twice: nothing twice');
  // An earlier window reads again the PR the later one left out (60), not the ones it has.
  const earlier = await run('--since', '2026-11-07T00:00:00+02:00');
  assert.deepEqual([earlier.added, readLog(settings.state).length], [1, 5]);
  assert.ok(after().includes('Полив можна зупинити до заходу сонця, о 18:00.'));
  // A role session can't run it.
  await assert.rejects(main(['learn', 'collect', '--root', root, '--settings', settings.file], { stdout, forgeAdapter: adapter, env: { DOC_TOOLKIT_ROLE_SESSION: 'writer' } }), /refused in a role session/);
  const st = learnStatus(settings);
  assert.deepEqual([st.log.entries, st.log.prs, st.log.bySource], [5, 3, { comment: 2, hand: 3 }]);
});

test('N1: the comment authors come from the forge by the handled comments\' ids, a model\'s `by` is never read', async () => {
  const { authorsFrom } = await import('../lib/learn-log.mjs');
  const forge = { prActivity: async () => ({ reviews: [{ id: 1, author: 'a' }], threads: [{ comments: [{ id: 2, author: 'b' }] }], comments: [{ id: 3, author: 'c' }] }) };
  assert.deepEqual([...(await authorsFrom(forge)({ repo: 'guide-docs', number: 1 })).entries()], [['1', 'a'], ['2', 'b'], ['3', 'c']]);
  const settings = settingsFor(tmp(), { learning: LEARN });
  const l = { key: 'k', reviewComments: [{ repo: 'guide-docs', pr: 5, at: 't1', id: 11 }, { repo: 'guide-docs', pr: 5, at: 't2', id: 12 }] };
  const pr = { repo: 'guide-docs', number: 5, review: 'sme', edits: [
    { n: 1, list: 'r', stage: 'answerComments', page: PAGE, before: 'a', after: 'b', at: 't1', by: 'expert-one' },
    { n: 2, list: 'r', stage: 'answerComments', page: PAGE, before: 'c', after: 'd', at: 't2', by: 'owner-login' },
    { n: 3, list: 'r', stage: 'answerComments', page: PAGE, before: 'e', after: 'f', at: 't0' },
  ] };
  const got = entriesOf({ settings, ledger: l, pr, view: null, git: null, authors: new Map([['11', 'owner-login'], ['12', 'expert-one']]) });
  assert.deepEqual(got.entries.map((e) => e.n), [1, 3], 'the forge\'s authors decide (1 the owner\'s, 2 the expert\'s, whatever `by` says); an old round with no handled record, on an sme PR too, counts');
});

test('blocks: headings, paragraphs and fences apart; a change in whitespace only is none', () => {
  const b = blocksOf('---\ntitle: X\n---\n\n# A\n\nText one.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n## B\n\nText two.\n');
  assert.deepEqual(b.map((x) => [x.heading, x.text.split('\n')[0]]), [[null, '---'], ['A', '# A'], ['A', 'Text one.'], ['A', '```js'], ['B', '## B'], ['B', 'Text two.']]);
  assert.deepEqual(changedBlocks('# A\n\nOne  two.\n', '# A\n\nOne two.\n'), []);
  assert.deepEqual(changedBlocks('# A\n\nOne.\n\nTwo.\n', '# A\n\nOne, changed.\n\nTwo.\n\nThree.\n'), [{ block: 'A', before: 'One.', after: 'One, changed.' }, { block: 'A', before: '', after: 'Three.' }]);
});

test('a run\'s own pass reads its status only: a PR the status shows is read, one it doesn\'t waits for the weekly pass', async () => {
  const { viewsFrom } = await import('../lib/learn-log.mjs');
  const st = { tickets: [{ key: '857', prs: [{ id: 'guide-docs#57', head: 'h1', state: 'open' }] }] };
  const view = viewsFrom(st, null);
  assert.deepEqual(await view({ key: '857' }, { repo: 'guide-docs', number: 57 }), { head: 'h1', state: 'open', mergedAt: null, mergeCommit: null });
  assert.equal(await view({ key: '858' }, { repo: 'guide-docs', number: 58 }), null);
});

// ------------------------------------------------------------------ AC-1: patterns seen twice

const entry = (id, pr, extra = {}) => ({ id, repo: 'guide-docs', pr, url: `https://forge.example/acme/guide-docs/pull/${pr}`, page: PAGE, block: 'Б', before: `було ${id}`, after: `стало ${id}`, source: 'hand', at: '2026-11-10T10:00:00Z', ...extra });

test('AC-1: only patterns seen at least twice on two PRs are kept, with their examples; used, unknown, rejected and kindless ones are refused', () => {
  const log = [entry('a', 1), entry('b', 2), entry('c', 2), entry('c2', 2), entry('d', 3), entry('e', 4), entry('f', 5), entry('g', 6)];
  const result = {
    patterns: [
      { kind: 'продукт', rule: 'Крок називає температуру перед часом.', why: 'Читач спершу вмикає піч.', examples: ['a', 'b'] },
      { kind: 'загальне', rule: 'Одна дія — один крок.', why: 'Так читач не губить місце.', examples: ['c'] },
      { kind: 'product', rule: 'Два приклади, один PR.', why: 'w', examples: ['c', 'c2'] },
      { kind: 'general', rule: 'Невідомий рядок.', why: 'w', examples: ['d', 'zzz'] },
      { kind: 'general', rule: 'Уже використаний.', why: 'w', examples: ['d', 'used'] },
      { kind: 'general', rule: 'Рецепт не радить сорт борошна: це смак кухаря!', why: 'w', examples: ['d', 'e'] },
      { kind: 'general', rule: 'Правило, уже відкрите в PR.', why: 'w', examples: ['d', 'e'] },
      { kind: 'taste', rule: 'Без виду.', why: 'w', examples: ['d', 'e'] },
      { kind: 'виняток із загального', rule: 'Без правила, яке скасовує.', why: 'w', examples: ['d', 'e'] },
      { kind: 'exception', rule: 'Назва кнопки без лапок і без жирного в заголовках таблиць.', why: 'w', examples: ['f', 'g'], overrides: 'formatting-conventions.md Ж1' },
    ],
  };
  const { kept, refused } = checkPatterns(result, { log: [...log, entry('used', 9)], consumed: ['used'], rejected: ['рецепт не радить сорт борошна: це смак кухаря'], taken: ['Правило, уже відкрите в PR'] });
  assert.deepEqual(kept.map((k) => [k.kind, k.examples]), [['product', ['a', 'b']], ['exception', ['f', 'g']]]);
  assert.equal(kept[1].overrides, 'formatting-conventions.md Ж1');
  assert.deepEqual(refused.map((r) => r.why.split(':')[0].split(' (')[0]), [
    'seen 1 time(s) on 1 PR(s)',
    'seen 2 time(s) on 1 PR(s)',
    'examples not in the log',
    'examples an earlier proposal already used',
    'the owner rejected this rule before',
    'this rule is open on a rule PR or accepted already',
    'the kind "taste" is none of product, general, exception',
    'an exception names the general rule it overrides',
  ]);
  // An edit is used once: a second pattern that cites a kept one's example is refused.
  const twice = checkPatterns({ patterns: [{ kind: 'product', rule: 'X.', why: 'w', examples: ['a', 'd'] }, { kind: 'product', rule: 'Y.', why: 'w', examples: ['a', 'e'] }] }, { log });
  assert.deepEqual([twice.kept.length, twice.refused[0].why.startsWith('examples an earlier proposal already used')], [1, true]);
  assert.deepEqual([kindOf('тільки цей проєкт'), kindOf('Загальне'), kindOf('виняток із загального'), kindOf('other')], ['product', 'general', 'exception', null]);
  // By stem: the forms the owner writes.
  assert.deepEqual([kindOf('продуктове'), kindOf('тільки для цього проєкту'), kindOf('загальне правило'), kindOf('винятком'), kindOf('продукт має бути описаний на кожній сторінці окремо й докладно')], ['product', 'product', 'general', 'exception', null]);
});

test('the trend line counts the owner\'s edits per PR last week against the weeks before', () => {
  const at = (iso) => ({ at: iso });
  const log = [
    { ...entry('1', 1), ...at('2026-11-10T10:00:00Z') }, { ...entry('2', 1), ...at('2026-11-11T10:00:00Z') }, { ...entry('3', 2), ...at('2026-11-12T10:00:00Z') },
    { ...entry('4', 3), ...at('2026-11-03T10:00:00Z') }, { ...entry('5', 3), ...at('2026-11-03T10:00:00Z') }, { ...entry('6', 3), ...at('2026-11-04T10:00:00Z') }, { ...entry('7', 3), ...at('2026-11-05T10:00:00Z') },
  ];
  assert.deepEqual(trendOf(log, MONDAY), { now: 1.5, prs: 2, before: 4, weeks: 1 });
  assert.equal(weekOf(MONDAY), '2026-W47');
});

// ------------------------------------------------------------------ the kit and the description

const UA_LABELS = { title: 'Правила з правок власника, <week>', why: 'Чому', example: 'було → стало', kinds: { product: 'продукт', general: 'загальне', exception: 'виняток із загального' } };

test('the kit: a rule is a marked line under the section, made when missing; replaced and removed by its marker', () => {
  const labels = { why: 'Чому', kinds: { exception: 'виняток із загального' } };
  const a = editKit('# Product rules\n\n## Терміни\n\n- Термін.\n', { add: [{ rid: 'W1-1', kind: 'product', rule: 'Правило А.', why: 'Причина А.' }, { rid: 'W1-2', kind: 'exception', rule: 'Правило Б.', why: 'Причина Б.', overrides: 'Ж1' }], section: '## Правила з правок', labels });
  assert.equal(a, `# Product rules\n\n## Терміни\n\n- Термін.\n\n## Правила з правок\n\n- Правило А. Чому: Причина А. ${markerOf('W1-1')}\n- Правило Б. (виняток із загального: Ж1) Чому: Причина Б. ${markerOf('W1-2')}\n`);
  const b = editKit(a, { replace: [{ rid: 'W1-1', kind: 'product', rule: 'Правило А, нове.', why: 'Причина А.' }], remove: ['W1-2'], section: '## Правила з правок', labels });
  assert.ok(b.includes(`- Правило А, нове. Чому: Причина А. ${markerOf('W1-1')}`) && !b.includes('W1-2'));
  const c = editKit(b, { add: [{ rid: 'W2-1', kind: 'general', rule: 'В.', why: 'Г.' }], section: '## Правила з правок', labels });
  assert.match(c, /W1-1 -->\n- В\. Чому: Г\. <!-- learned:W2-1 -->\n$/, 'added after the section\'s last line');
  // N2: «N — "текст"» for a rule whose line the owner took out puts the line back, once.
  const d = editKit(c, { replace: [{ rid: 'W1-2', kind: 'product', rule: 'Правило Б, знову.', why: 'Причина Б.' }], section: '## Правила з правок', labels });
  assert.equal(d.split(markerOf('W1-2')).length, 2);
  assert.ok(d.includes(`- Правило Б, знову. Чому: Причина Б. ${markerOf('W1-2')}`));
});

test('point 3: the description starts with the trend line and the numbered rules, then the host\'s PR structure, and names no tool', async () => {
  const settings = settingsFor(tmp(), { learning: { ...LEARN, labels: UA_LABELS } });
  const log = [entry('a', 1), entry('b', 2)];
  const rules = [{ rid: 'W-1', kind: 'product', rule: 'Правило.', why: 'Причина.', examples: ['a', 'b'], question: 'Це правило лише цього продукту?' }];
  const body = renderBody({ pr: { items: [{ n: 1, rid: 'W-1', kind: 'product', rule: 'Правило.', why: 'Причина.', state: 'open' }] }, rules, log, trend: { now: 3, prs: 2, before: 4.25, weeks: 3 }, labels: settings.learning.labels, kit: 'doc-kit/product-rules.md' });
  const lines = body.split('\n');
  assert.match(lines[0], /^The owner's edits per PR: 3\.0 last week \(2 PRs\), 4\.3 a week on average in the 3 weeks before\.$/);
  assert.equal(lines[2], '1. **продукт** — Правило.');
  assert.equal(lines[3], '   Чому: Причина.');
  assert.equal(lines[4], '   - було → стало: «було a» → «стало a» ([guide-docs#1](https://forge.example/acme/guide-docs/pull/1))');
  const order = ['## Description', '<details>', '<summary>List of changes</summary>', '- `doc-kit/product-rules.md`: added rules 1.', '</details>', '## Task link', '## Open questions', '<summary>For the writer</summary>', '- 1: Це правило лише цього продукту?'].map((x) => lines.indexOf(x));
  assert.ok(order.every((x, i) => x > 4 && (i === 0 || x > order[i - 1])), `the sections in order: ${order}`);
  assert.doesNotMatch(body, /toolkit|plugin|claude|pipeline/i);
});

// ------------------------------------------------------------------ point 4: the reply by number

test('point 4: the reply by number on a rule PR: yes, no, the owner\'s text, a kind, a rewording; unknown numbers are asked back', () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ n, rid: `r${n}`, kind: 'product', rule: `Правило ${n}.`, state: n === 7 ? 'rejected' : 'open' }));
  const r = resolveRuleReply('1 — так\n2 — ні\n3 — "Нове правило три."\n4 — загальне\n5 — тільки цей проєкт\n6 — коротше, без прикладу\n7 — так\n9 — ні', items);
  assert.deepEqual(r.map((x) => [x.n, x.do, x.rule ?? x.kind ?? x.how ?? x.why ?? null]), [
    [1, 'keep', null], [2, 'reject', null], [3, 'verbatim', 'Нове правило три.'], [4, 'kind', 'general'], [5, 'kind', 'product'], [6, 'rewrite', 'коротше, без прикладу'], [7, 'ask', 'rule 7 was removed already'], [9, 'ask', 'there is no rule 9 on this PR'],
  ]);
  assert.equal(resolveRuleReply('2 — виняток із загального', items)[0].do, 'ask', 'an exception needs the rule it overrides');
  assert.equal(resolveRuleReply('Дякую, гляну пізніше', items), null, 'no number: no reply by number');
  // A no-word followed by punctuation, or a no-phrase, is a no; the kind alone is a kind change; a kind and more is a
  // kind change and a rewording; a no-word followed by more words is asked back.
  const m = resolveRuleReply('1 — ні, це факт\n2 — не додавай це\n3 — тільки для цього проєкту\n4 — продуктове\n5 — прибери, бо дублює Ж3\n6 — загальне, але коротше й без прикладу з таблиці\n7 — no problem', items.map((x) => ({ ...x, state: 'open' })));
  assert.deepEqual(m.map((x) => [x.n, x.do, x.kind ?? null]), [[1, 'reject', null], [2, 'reject', null], [3, 'kind', 'product'], [4, 'kind', 'product'], [5, 'reject', null], [6, 'rewrite', 'general'], [7, 'ask', null]]);
  assert.equal(m[5].how, 'загальне, але коротше й без прикладу з таблиці', 'the rewording keeps the whole reply');
  assert.deepEqual(resolveRuleReply('1 — no.\n2 — ні в якому разі не міняй\n3 — не проблема', items).map((x) => x.do), ['reject', 'ask', 'rewrite']);
});

// ------------------------------------------------------------------ AC-3: the toolkit file's own form

const FC = 'context/doc-rules/project-rules/formatting-conventions.md';
const PS = 'context/doc-rules/project-rules/procedure-steps.md';
const UA_RULE = {
  name: 'Налаштування перед часом',
  english: 'Setting before time',
  body: [
    'Крок рецепта називає налаштування печі перед часом: читач спершу вмикає піч, а потім ставить таймер.',
    '',
    '| ⛔ Не так | ✅ Так |',
    '|---|---|',
    '| Печіть 20 хвилин при 180 °C. | Увімкніть піч на 180 °C і печіть 20 хвилин. |',
    '',
    '**Джерела корпусу:** `GDSG-PRINCIPLES-AUDIENCE` — «Write for your audience». Правило Ж3 тут не змінюється.',
    '',
    '**Проєктне рішення:** порядок налаштувань у кроці — проєктний.',
  ].join('\n'),
  check: 'Налаштування названо перед часом?',
  loadRow: ['Порядок налаштувань у кроках', 'шаблони сторінок набору продукту'],
};
// The checklist line as inserted: it names its rule as its neighbours do (g).
const UA_CHECK = 'Налаштування названо перед часом (Ж11)?';

// The toolkit's own files (what git tracks under plugins/, tools/ and .claude-plugin/, and new files not ignored), copied
// into `dir`, so the real lint runs there.
const REPO = path.resolve(PLUGIN, '../..');
function repoCopy(dir) {
  const files = g(REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'plugins', 'tools', '.claude-plugin').split('\0').filter(Boolean);
  for (const f of files) {
    const src = path.join(REPO, f);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, f));
  }
}
const lintIn = (dir) => execFileSync(process.execPath, [path.join(dir, 'tools', 'lint-plugin.mjs')], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('AC-3: a fixture rule added to formatting-conventions.md keeps its language, numbering, heading form, structure and checklist; the lint\'s checks pass on it', () => {
  const text = fs.readFileSync(path.join(PLUGIN, FC), 'utf8');
  const before = formOf(text);
  const out = insertRule(text, UA_RULE, { pluginRoot: PLUGIN });
  assert.equal(out.number, Math.max(...before.rules.map((r) => r.n)) + 1);
  assert.equal(out.heading, `### Ж${out.number} — Налаштування перед часом (Setting before time)`);
  // Diffed against the file's existing rules: the same heading pattern, the next number, placed after the last rule.
  const re = /^### Ж\d+[a-z]? — .+ \([^()]*[A-Za-z][^()]*\)$/;
  assert.ok(before.rules.filter((r) => re.test(text.split('\n')[r.i])).length >= before.rules.length - 1, 'the pattern is the file\'s own');
  assert.match(out.heading, re);
  const after = formOf(out.text);
  assert.equal(after.rules.at(-1).n, out.number);
  const lines = out.text.split('\n');
  const at = lines.indexOf(out.heading);
  assert.ok(at > lines.findIndex((l) => l.startsWith('### Ж10 ')) && at < lines.indexOf('### Чекліст ядра'), 'after Ж10, before the core checklist');
  assert.ok(lines.indexOf(`- [ ] ${UA_CHECK}`) > lines.indexOf('### Чекліст ядра') && lines.indexOf(`- [ ] ${UA_CHECK}`) < lines.indexOf('## Українською'), 'its checklist line at the end of the checklist, with its (Ж11) like its neighbours');
  assert.ok(lines.indexOf('| Порядок налаштувань у кроках | шаблони сторінок набору продукту |') < lines.findIndex((l) => l.startsWith('### Ж1 ')), 'the row in the table of what lives where');
  assert.equal(out.text.split('\n').length, text.split('\n').length + UA_RULE.body.split('\n').length + 5, 'the heading, two blank lines, the checklist line and the table row');
  assert.equal(scriptOf(out.text), 'uk');
  // The lint's per-file checks on the new text: every plugin path exists, every annotation frame is whole.
  assert.deepEqual(rootRefs(out.text).filter(({ ref }) => !fs.existsSync(path.join(PLUGIN, ref))), []);
  assert.deepEqual(annotationProblems(out.text), []);
  // With the rule's marker: the line right after the heading, nothing else moves.
  const marked = insertRule(text, UA_RULE, { pluginRoot: PLUGIN, marker: markerOf('2026-W47-2') });
  const ml = marked.text.split('\n');
  assert.equal(ml[ml.indexOf(marked.heading) + 1], '<!-- learned:2026-W47-2 -->');
  assert.equal(ml.length, lines.length + 1);
  // The real lint, on a copy of the toolkit with the marked rule in the file.
  const copy = tmp();
  repoCopy(copy);
  fs.writeFileSync(path.join(copy, 'plugins/doc-writer-toolkit', FC), marked.text);
  execFileSync('git', ['init', '-q'], { cwd: copy });
  execFileSync('git', ['add', '-A'], { cwd: copy });
  assert.doesNotThrow(() => lintIn(copy), 'the lint passes with the rule in the file');
});

test('AC-3: the form is refused where it differs: an English body in a Ukrainian file, a missing part, a cross-reference to no rule, no English name, no check line', () => {
  const text = fs.readFileSync(path.join(PLUGIN, FC), 'utf8');
  const no = (rule, re) => assert.throws(() => insertRule(text, { ...UA_RULE, ...rule }, { pluginRoot: PLUGIN }), re);
  no({ body: 'A recipe step names the oven setting before the time. **Джерела корпусу:** none. **Проєктне рішення:** ours.', name: 'Setting before time' }, /written in English, the file in Ukrainian/);
  no({ body: UA_RULE.body.replace(/\*\*Проєктне рішення:\*\*[^\n]*/, '') }, /«\*\*проєктне рішення…\*\*»/);
  no({ body: `${UA_RULE.body}\n\nДив. також Ж42.` }, /refers to Ж42/);
  no({ english: undefined }, /give "english"/);
  no({ check: undefined }, /give "check"/);
  no({ body: `${UA_RULE.body}\n\n\${CLAUDE_PLUGIN_ROOT}/context/nowhere.md` }, /doesn't exist/);
  assert.throws(() => insertRule('# A file\n\nNo numbered rules.\n', UA_RULE), /no numbered rules/);
});

test('AC-3: an English list-form file takes the next item in its own form', () => {
  const text = fs.readFileSync(path.join(PLUGIN, PS), 'utf8');
  const before = formOf(text);
  assert.equal(before.form, 'list');
  const out = insertRule(text, { name: 'Setting before time', body: 'A step names the setting before the time.\nThe reader sets the oven first, then the timer.' }, { pluginRoot: PLUGIN });
  const n = before.rules.length + 1;
  assert.equal(out.heading, `${n}. **Setting before time**`, 'the file\'s names carry no full stop of their own');
  const lines = out.text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${n}. **Setting before time** A step names`));
  assert.ok(at > before.rules.at(-1).i);
  assert.equal(lines[at + 1], "   The reader sets the oven first, then the timer.");
  assert.throws(() => insertRule(text, { name: 'Налаштування', body: 'Крок називає налаштування печі перед часом, а таймер — після нього.' }), /written in Ukrainian, the file in English/);
  assert.deepEqual(ruleFiles(PLUGIN).map((f) => f.file).filter((f) => [FC, PS].includes(f)).sort(), [FC, PS]);
});

test('point 5: the host\'s names never reach the toolkit', () => {
  const settings = settingsFor(tmp(), { learning: { ...LEARN, names: ['Lunapay'] } });
  const names = namesOf(settings);
  assert.ok(['guide-docs', 'expert-one', 'owner-login', 'acme', 'Lunapay'].every((n) => names.includes(n)));
  assert.deepEqual(namesIn('Pages of guide-docs and the Lunapay app', names), ['guide-docs', 'Lunapay']);
  assert.deepEqual(namesIn('A recipe step', names), []);
  // A repo name's own words, the generic ones left out: the product's name in «ZEPHYR-DOC-PORTAL» is ZEPHYR.
  const words = namesOf({ targets: [{ repo: 'ZEPHYR-DOC-PORTAL' }, { repo: 'zephyr_api_docs' }], forge: {}, root: '/x/ZEPHYR-DOC-HUB', learning: { names: [] } });
  assert.ok(words.includes('ZEPHYR') && words.includes('zephyr'));
  assert.ok(!words.some((w) => ['DOC', 'PORTAL', 'api', 'docs', 'HUB'].includes(w)), 'no generic word');
  assert.deepEqual(namesIn('The Zephyr app', words).length > 0, true);
  // With a toolkit to write to, the product's and the company's names are required; so are `since` and `authors`.
  const bad = (learning, re) => assert.throws(() => settingsFor(tmp(), { learning }), re);
  bad({ ...LEARN, toolkit: { repo: 'o/t', path: 't' } }, /learning\.names is required with learning\.toolkit/);
  bad({ authors: [OWNER] }, /learning\.since is required/);
  bad({ since: WINDOW }, /learning\.authors is required/);
});

// ------------------------------------------------------------------ the whole loop, offline

// A stand-in for `claude`: it reads the input the brief names and writes the result `answer(mode, input)` gives.
function fakeClaude(answer, calls = []) {
  return async (cmd) => {
    const brief = cmd.args[cmd.args.indexOf('-p') + 1];
    const input = JSON.parse(fs.readFileSync(/Read the input: (\S+)/.exec(brief)[1], 'utf8'));
    const mode = /Stage `learn (\w+)`/.exec(brief)[1];
    calls.push({ mode, input, cmd });
    const result = answer(mode, input);
    if (result) fs.writeFileSync(/to exactly: (\S+)/.exec(brief)[1], JSON.stringify(result));
    return { code: 0, stdout: JSON.stringify({ type: 'result', total_cost_usd: 0.5, num_turns: 4 }) };
  };
}

function loopWorld({ mode = 'on' } = {}) {
  const root = tmp();
  const kitText = '# Product rules\n\n## Терміни\n\n- Термін.\n';
  const host = hostRepo(root, 'guide-docs', { 'CLAUDE.md': '# Host\n\n## Documentation toolkit configuration\n\n- **Product kit:** `doc-kit/`\n', 'doc-kit/product-rules.md': kitText, [PAGE]: PAGE_TEXT });
  const fcText = fs.readFileSync(path.join(PLUGIN, FC), 'utf8');
  // The toolkit: a copy of this repo's own files, so its real lint runs on the rule before the push.
  const toolkit = hostRepo(root, 'toolkit', { 'README.md': '# Toolkit\n' });
  repoCopy(toolkit.dir);
  toolkit.commit({}, 'The toolkit');
  toolkit.g('push', '-q', 'origin', 'main');
  toolkit.g('fetch', '-q', 'origin');
  // The host has trigger words: the owner's reply on a rule PR is taken without one too.
  const settings = settingsFor(root, { mode, forge: { kind: 'github', owner: 'acme', self: 'owner-login', assignee: 'owner-login', checkLabel: 'Look at me', triggerWords: ['докбот'] }, limits: { usageGuard: false, startHours: '00-24' }, learning: { ...LEARN, names: ['Zephyr'], section: '## Правила з правок', labels: UA_LABELS, toolkit: { repo: 'tools-org/toolkit', path: 'repos/toolkit', base: 'main' } } });
  const prs = [];
  const activity = {};
  const adapter = forgeAdapter({ prs, activity });
  let next = 100;
  adapter.createPr = async (a) => {
    const p = forgePr({ repo: a.repo, number: next++, head: a.head });
    p.body = a.body;
    p.title = a.title;
    prs.push(p);
    return { id: p.number, number: p.number, url: p.url };
  };
  const tprs = [];
  const tadapter = forgeAdapter({ prs: tprs });
  tadapter.createPr = async (a) => {
    const p = forgePr({ repo: a.repo, number: 7, head: a.head });
    Object.assign(p, { body: a.body, title: a.title });
    tprs.push(p);
    return { id: 7, number: 7, url: p.url };
  };
  return { root, host, toolkit, settings, prs, activity, adapter, tprs, tadapter, kitText, fcText };
}

async function forgeOf(settings, adapter) {
  const { createForge } = await import('../../forge/lib/forge.mjs');
  return createForge({ adapter, forge: settings.forge });
}

const kitOn = (repo, ref) => g(repo.origin, 'show', `${ref}:doc-kit/product-rules.md`);

test('the loop: Monday\'s session proposes in a PR, nothing reaches the kit before the merge (AC-2), the reply by number fixes the PR, the merge queues the toolkit PR, a rejected rule is never proposed again', async () => {
  const w = loopWorld();
  const { settings } = w;
  fs.mkdirSync(path.dirname(logPath(settings.state)), { recursive: true });
  const log = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)];
  fs.writeFileSync(logPath(settings.state), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const calls = [];
  const week1 = (mode, input) => {
    if (mode === 'week') return { patterns: [{ kind: 'product', rule: 'Кроки рецепта називають температуру перед часом.', why: 'Читач спершу вмикає піч.', examples: ['a', 'b'] }, { kind: 'general', rule: 'Крок називає налаштування перед часом.', why: 'Читач спершу налаштовує прилад.', examples: ['c', 'd'] }, { kind: 'product', rule: 'Один раз.', why: 'w', examples: ['e'] }], dropped: [] };
    if (mode === 'toolkit') return { file: FC, ...UA_RULE, summary: 'A recipe step names the oven setting before the time, since the reader sets the oven first.' };
    return null;
  };
  const forge = await forgeOf(settings, w.adapter);
  const io = { spawnClaude: fakeClaude(week1, calls), viewOf: async () => null, toolkitForgeAdapter: w.tadapter };
  const check = (over = {}) => learningCheck({ settings, clients: { forge }, io, now: MONDAY, morningDone: true, busy: null, ...over });

  // Switched on mid-week (the Wednesday before): the week is recorded, and no session runs before the next Monday.
  assert.equal((await check({ now: MONDAY - 5 * 86400000 })).week.why, 'the learning started in 2026-W46: the first session is the next week\'s');
  assert.equal(readLearning(settings.state).startWeek, '2026-W46');
  // Not before the morning run, not while a ticket run goes.
  assert.equal((await check({ morningDone: false })).week.why, "today's morning run hasn't run yet");
  assert.match((await check({ busy: '1 ticket run(s) going' })).week.why, /^the tickets first/);
  assert.equal(calls.length, 0);

  const r = await check();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'week');
  assert.deepEqual(calls[0].input.edits.map((e) => e.id), ['a', 'b', 'c', 'd', 'e']);
  // The session's role: the learner, writing only under the state's tmp folder, no Bash.
  assert.equal(calls[0].cmd.args[calls[0].cmd.args.indexOf('--agent') + 1], 'ticket-learner');
  assert.ok(calls[0].cmd.args.includes(`Edit(//${path.join(settings.state, 'tmp').replace(/^\/+/, '')}/**)`));
  assert.ok(!calls[0].cmd.args.some((a) => /^Edit\(.*\.sources/.test(a)), 'no .sources folder for the learner');
  assert.deepEqual(r.proposed.map((p) => [p.repo, p.rules]), [['guide-docs', 2]]);
  const pr = w.prs[0];
  assert.equal(pr.head, 'rules-from-edits-2026-w47');
  assert.equal(pr.title, 'Правила з правок власника, 2026-W47');
  assert.match(pr.body, /^The owner's edits per PR: .*\n\n1\. \*\*продукт\*\* — Кроки рецепта називають температуру перед часом\.\n {3}Чому: Читач спершу вмикає піч\.\n {3}- було → стало: «було a» → «стало a»/);
  assert.ok(pr.body.includes('2. **загальне** — Крок називає налаштування перед часом.'));
  assert.ok(!pr.body.includes('Один раз'), 'seen once: not proposed');
  // AC-2: the kit on the base is as it was; the branch holds the rules, under the section, marked.
  assert.equal(kitOn(w.host, 'main'), w.kitText.trim());
  const branchKit = kitOn(w.host, 'rules-from-edits-2026-w47');
  assert.ok(branchKit.includes('## Правила з правок\n\n- Кроки рецепта називають температуру перед часом. Чому: Читач спершу вмикає піч. <!-- learned:2026-W47-1 -->'));
  assert.equal(g(w.host.origin, 'log', '-1', '--format=%B', 'rules-from-edits-2026-w47'), "Rules from the owner's edits", 'a plain message, no trailer');
  assert.ok(r.notify[0].title.includes('rules from your edits'));
  const data = readLearning(settings.state);
  assert.deepEqual(data.consumed.sort(), ['a', 'b', 'c', 'd'], 'the edits a proposal used; the one seen once stays for a later week');
  // The same week again: no second session.
  await check();
  assert.equal(calls.length, 1);
  assert.equal(weekDue({ settings, data: readLearning(settings.state), now: MONDAY, morningDone: true }).why, '2026-W47 is done');

  // The owner's reply by number, without the host's trigger word: 1 no, 2 the owner's own text. Another person's comment
  // is never obeyed; the owner's comment that reads as no reply is listed, not dropped.
  w.activity['guide-docs#100'] = { comments: [
    { id: 501, author: 'someone-else', body: '1 — ні', createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z' },
    { id: 502, author: 'owner-login', body: '1 — ні, це факт\n2 — "Крок рецепта називає налаштування приладу перед часом."', createdAt: '2026-11-16T10:01:00Z', updatedAt: '2026-11-16T10:01:00Z' },
    { id: 503, author: 'owner-login', body: 'Дякую, гляну пізніше', createdAt: '2026-11-16T10:02:00Z', updatedAt: '2026-11-16T10:02:00Z' },
  ] };
  const r2 = await check();
  assert.deepEqual(r2.replied, [{ pr: 'guide-docs#100', items: [{ n: 1, do: 'reject' }, { n: 2, do: 'verbatim' }] }]);
  assert.deepEqual(r2.unclear.map((u) => [u.pr, u.comments.map((c) => c.id)]), [['guide-docs#100', [503]]]);
  const { renderProgress } = await import('../lib/progress.mjs');
  assert.match(renderProgress({ rulePrs: [{ repo: 'guide-docs', number: 100, rules: 1, unclear: r2.unclear[0].comments }] }), /❓ a comment of yours not read as a reply by number: «Дякую, гляну пізніше»/);
  const kit2 = kitOn(w.host, 'rules-from-edits-2026-w47');
  assert.ok(!kit2.includes('learned:2026-W47-1') && kit2.includes('- Крок рецепта називає налаштування приладу перед часом. Чому: Читач спершу налаштовує прилад. <!-- learned:2026-W47-2 -->'));
  const reply = w.adapter.log.find((x) => x[0] === 'comment')[1];
  assert.match(reply.body, /\*\*1\*\* — removed, not proposed again\n\*\*2\*\* — reworded: «Крок рецепта називає налаштування/);
  assert.match(w.prs[0].body, /1\. ~~продукт — Кроки рецепта називають температуру перед часом\.~~ \(removed\)/);
  assert.equal(kitOn(w.host, 'main'), w.kitText.trim(), 'still nothing on the base');
  // Seen once: the same comment is not answered again.
  await check();
  assert.equal(w.adapter.log.filter((x) => x[0] === 'comment').length, 1);

  // The merge is the yes: the general rule is queued for the toolkit, and the toolkit PR is made in the file's own form.
  // The owner reworded the line by hand before merging (its marker kept): the merged text is the rule.
  g(w.host.dir, 'fetch', '-q', 'origin');
  g(w.host.dir, 'checkout', '-q', '-B', 'merge-it', 'origin/rules-from-edits-2026-w47');
  const handKit = fs.readFileSync(path.join(w.host.dir, 'doc-kit/product-rules.md'), 'utf8').replace('Крок рецепта називає налаштування приладу перед часом.', 'Крок рецепта називає налаштування приладу перед часом приготування.');
  w.host.commit({ 'doc-kit/product-rules.md': handKit }, 'Уточнення');
  g(w.host.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  g(w.host.dir, 'checkout', '-q', 'main');
  g(w.host.dir, 'reset', '-q', '--hard', 'origin/main');
  w.prs[0].state = 'merged';
  const r3 = await check();
  const d3 = readLearning(settings.state);
  assert.deepEqual(d3.prs[0].items.map((x) => x.state), ['rejected', 'accepted']);
  assert.equal(d3.rules.find((r) => r.rid === '2026-W47-2').toolkit.rule, 'Крок рецепта називає налаштування приладу перед часом приготування.', 'the merged line read back before the toolkit queue');
  assert.equal(r3.toolkit[0].number, 7);
  const tk = w.tprs[0];
  assert.match(tk.title, /^Add a rule learned from the owner's edits to formatting-conventions\.md$/);
  assert.doesNotMatch(tk.body, /guide-docs|acme|owner-login|expert/);
  const fcNow = g(w.toolkit.origin, 'show', `${tk.head}:plugins/doc-writer-toolkit/${FC}`);
  assert.ok(fcNow.includes('### Ж11 — Налаштування перед часом (Setting before time)'));
  assert.equal(calls.at(-1).mode, 'toolkit');
  assert.ok([FC, PS].every((f) => calls.at(-1).input.files.some((x) => x.file === f)));
  assert.equal(g(w.toolkit.origin, 'show', `main:plugins/doc-writer-toolkit/${FC}`), w.fcText.trim(), 'the toolkit base: unchanged until the owner merges');

  // The next week: the toolkit PR merged and in the installed plugin (the switch): its host copy is removed; the rejected
  // rule's edits are used, and a session that proposes it again is refused.
  w.tprs[0].state = 'merged';
  const installed = tmp();
  fs.mkdirSync(path.dirname(path.join(installed, FC)), { recursive: true });
  fs.writeFileSync(path.join(installed, FC), fcNow);
  fs.appendFileSync(logPath(settings.state), [entry('f', 6), entry('g', 7)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const next = Date.parse('2026-11-23T09:00:00+02:00');
  io.pluginRoot = installed;
  io.spawnClaude = fakeClaude((mode) => (mode === 'week' ? { patterns: [{ kind: 'product', rule: 'Кроки рецепта називають температуру перед часом.', why: 'w', examples: ['f', 'g'] }] } : null), calls);
  const r4 = await learningCheck({ settings, clients: { forge }, io, now: next, morningDone: true });
  assert.deepEqual(calls.at(-1).input.rejected, ['Кроки рецепта називають температуру перед часом.']);
  const week = readLearning(settings.state).weeks['2026-W48'];
  assert.equal(week.refused[0].why, 'the owner rejected this rule before');
  assert.deepEqual(r4.proposed.map((p) => [p.rules, p.removes]), [[0, 1]], 'a PR that only removes the host copy');
  assert.ok(!kitOn(w.host, 'rules-from-edits-2026-w48').includes('learned:2026-W47-2'));
  assert.match(w.prs[1].body, /removed the copies of rules now in the shared rules/);
});

const seedLog = (settings, entries) => {
  fs.mkdirSync(path.dirname(logPath(settings.state)), { recursive: true });
  fs.writeFileSync(logPath(settings.state), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(settings.state, 'learning', 'proposals.json'), JSON.stringify({ startWeek: '2026-W40' }));
};
const HOUR = 3600000;
const TWO = { patterns: [{ kind: 'product', rule: 'Кроки рецепта називають температуру перед часом.', why: 'Читач спершу вмикає піч.', examples: ['a', 'b'] }, { kind: 'general', rule: 'Крок називає налаштування перед часом.', why: 'Читач спершу налаштовує прилад.', examples: ['c', 'd'] }] };

test('M3: a rule PR that could not be opened keeps nothing (no rule, no used edit, no branch, no worktree) and the week is tried again; a failing session at most three times, two hours apart', async () => {
  const w = loopWorld();
  const { settings } = w;
  seedLog(settings, [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)]);
  const calls = [];
  const forge = await forgeOf(settings, w.adapter);
  const io = { spawnClaude: fakeClaude((mode) => (mode === 'week' ? TWO : null), calls), viewOf: async () => null, toolkitForgeAdapter: w.tadapter };
  const make = w.adapter.createPr;
  w.adapter.createPr = async () => {
    throw new Error('the forge is down');
  };
  const pass = (now) => learningCheck({ settings, clients: { forge }, io, now, morningDone: true });
  const r1 = await pass(MONDAY);
  const d1 = readLearning(settings.state);
  assert.deepEqual([r1.proposed.length, d1.rules.length, d1.consumed, d1.attempts['2026-W47'].n, d1.weeks['2026-W47']], [0, 0, [], 1, undefined]);
  assert.equal(g(w.host.origin, 'branch', '--list', 'rules-from-edits-*'), 'rules-from-edits-2026-w47', 'the pushed branch stays: the pipeline never deletes a branch');
  const firstTry = g(w.host.origin, 'rev-parse', 'rules-from-edits-2026-w47');
  assert.ok(!fs.existsSync(path.join(settings.state, 'learning', 'trees', 'guide-docs')) || !fs.readdirSync(path.join(settings.state, 'learning', 'trees', 'guide-docs')).length, 'no worktree left');
  // At once: the backoff. Two hours later: the PR, the rules, the used edits.
  assert.match((await pass(MONDAY + 60000)).week.why, /the next one two hours after it/);
  assert.equal(calls.length, 1);
  w.adapter.createPr = make;
  const r2 = await pass(MONDAY + 2 * HOUR + 60000);
  const d2 = readLearning(settings.state);
  assert.deepEqual([r2.proposed.length, d2.rules.map((r) => r.rid), d2.consumed.sort(), d2.attempts['2026-W47']], [1, ['2026-W47-1', '2026-W47-2'], ['a', 'b', 'c', 'd'], undefined]);
  // The retry went on from the branch the first try left: a fast-forward, each rule's line once.
  const onBranch = kitOn(w.host, 'rules-from-edits-2026-w47');
  assert.deepEqual([onBranch.split('learned:2026-W47-1').length - 1, onBranch.split('learned:2026-W47-2').length - 1], [1, 1]);
  assert.doesNotThrow(() => g(w.host.origin, 'merge-base', '--is-ancestor', firstTry, 'rules-from-edits-2026-w47'), 'the first try\'s commit is still on the branch: nothing forced');
  // A PR the forge opened though its answer was lost: found by its head, used, not opened twice.
  const w3 = loopWorld();
  seedLog(w3.settings, [entry('a', 1), entry('b', 2)]);
  const f3 = await forgeOf(w3.settings, w3.adapter);
  const real = w3.adapter.createPr;
  w3.adapter.createPr = async (a) => {
    await real(a);
    throw new Error('timed out');
  };
  const r3 = await learningCheck({ settings: w3.settings, clients: { forge: f3 }, io: { spawnClaude: fakeClaude((mode) => (mode === 'week' ? { patterns: [TWO.patterns[0]] } : null)), viewOf: async () => null }, now: MONDAY, morningDone: true });
  assert.deepEqual([r3.proposed.map((p) => p.number), w3.prs.length, readLearning(w3.settings.state).weeks['2026-W47'] !== undefined], [[100], 1, true]);
  // A session that fails: three tries, then the next week.
  const w2 = loopWorld();
  seedLog(w2.settings, [entry('a', 1), entry('b', 2)]);
  const f2 = await forgeOf(w2.settings, w2.adapter);
  const failing = { spawnClaude: fakeClaude(() => null), viewOf: async () => null };
  for (const h of [0, 2, 4]) assert.match((await learningCheck({ settings: w2.settings, clients: { forge: f2 }, io: failing, now: MONDAY + h * HOUR + h * 60000, morningDone: true })).notes.join('\n'), /wrote no result file; try \d of 3/);
  assert.match((await learningCheck({ settings: w2.settings, clients: { forge: f2 }, io: failing, now: MONDAY + 7 * HOUR, morningDone: true })).week.why, /failed 3 times .*next week's/);
});

test('M2, N2, H3, M7: a reply whose push fails changes nothing; a rewording waits for the gate and may come back as a kind; a hand change on the branch is asked about, never decided; observe changes nothing', async () => {
  const w = loopWorld();
  const { settings } = w;
  seedLog(settings, [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)]);
  const calls = [];
  let answerResult = null;
  const forge = await forgeOf(settings, w.adapter);
  const io = { spawnClaude: fakeClaude((mode) => (mode === 'week' ? TWO : mode === 'answer' ? answerResult : null), calls), viewOf: async () => null, toolkitForgeAdapter: w.tadapter };
  const pass = (over = {}) => learningCheck({ settings, clients: { forge }, io, now: MONDAY, morningDone: true, ...over });
  await pass();
  const items = () => readLearning(settings.state).prs[0].items.map((x) => [x.n, x.state, x.kind]);
  const comment = (id, body) => (w.activity['guide-docs#100'] ??= { comments: [] }).comments.push({ id, author: 'owner-login', body, createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z' });
  // The push fails: nothing changes, the comment is read again later.
  const hook = path.join(w.host.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  comment(601, '1 — ні');
  const r1 = await pass();
  assert.deepEqual([r1.replied, items()], [[], [[1, 'open', 'product'], [2, 'open', 'general']]]);
  assert.match(r1.notes.join('\n'), /could not be pushed/);
  fs.rmSync(hook);
  const r2 = await pass();
  assert.deepEqual([r2.replied[0].items, items()[0]], [[{ n: 1, do: 'reject' }], [1, 'rejected', 'product']]);
  // A rewording by description: not while the gate is closed (no session, the comment waits), then the session says
  // the owner only meant another kind.
  comment(602, '2 — коротше, і зроби його правилом лише для цього продукту');
  const n = calls.length;
  const r3 = await pass({ morningDone: false });
  assert.match(r3.notes.join('\n'), /a rewording by description waits: today's morning run/);
  assert.equal(calls.length, n);
  answerResult = { rules: [{ n: 2, kind: 'product' }] };
  const r4 = await pass();
  assert.deepEqual([r4.replied[0].items, items()[1]], [[{ n: 2, do: 'kind' }], [2, 'open', 'product']]);
  // The owner rewords rule 2's line by hand and drops its marker, and puts rule 1's line (rejected, its removal pushed)
  // back: nothing is decided for the owner. Rule 2 stays open and is asked about; rule 1's line stays.
  const h = w.host;
  h.g('fetch', '-q', 'origin');
  h.g('checkout', '-q', '-B', 'by-hand', 'origin/rules-from-edits-2026-w47');
  const kit = fs.readFileSync(path.join(h.dir, 'doc-kit/product-rules.md'), 'utf8');
  const back = '- Кроки рецепта називають температуру перед часом. Чому: Читач спершу вмикає піч. <!-- learned:2026-W47-1 -->';
  const head = h.commit({ 'doc-kit/product-rules.md': `${kit.split('\n').map((l) => (l.includes('learned:2026-W47-2') ? '- Крок рецепта завжди називає налаштування першим.' : l)).join('\n').trimEnd()}\n${back}\n` }, 'Своїми словами');
  h.g('push', '-q', 'origin', 'HEAD:rules-from-edits-2026-w47');
  h.g('checkout', '-q', 'main');
  w.prs[0].headCommit = head;
  await pass();
  assert.deepEqual(items(), [[1, 'rejected', 'product'], [2, 'open', 'product']], 'nothing rejected by itself');
  const pr0 = readLearning(settings.state).prs[0];
  assert.deepEqual(pr0.missing.map((m) => [m.n, m.back ?? false]), [[2, false], [1, true]]);
  assert.ok(kitOn(w.host, 'rules-from-edits-2026-w47').includes(back), 'the line the owner put back stays');
  const { renderProgress } = await import('../lib/progress.mjs');
  assert.match(renderProgress({ rulePrs: [{ repo: 'guide-docs', number: 100, rules: 1, missing: pr0.missing }] }), /❓ rule 2: its line is not on the branch — reply «2 — ні» to drop it/);
  // A hand rewording that keeps the marker: the rule's text follows it.
  h.g('fetch', '-q', 'origin');
  h.g('checkout', '-q', '-B', 'by-hand', 'origin/rules-from-edits-2026-w47');
  const kit2 = fs.readFileSync(path.join(h.dir, 'doc-kit/product-rules.md'), 'utf8').replace('- Крок рецепта завжди називає налаштування першим.', '- Крок рецепта завжди називає налаштування першим. Чому: Читач спершу налаштовує прилад. <!-- learned:2026-W47-2 -->');
  const head2 = h.commit({ 'doc-kit/product-rules.md': kit2 }, 'Маркер назад');
  h.g('push', '-q', 'origin', 'HEAD:rules-from-edits-2026-w47');
  h.g('checkout', '-q', 'main');
  w.prs[0].headCommit = head2;
  await pass();
  const it2 = readLearning(settings.state).prs[0].items[1];
  assert.deepEqual([it2.state, it2.rule], ['open', 'Крок рецепта завжди називає налаштування першим.']);
  // Observe: the PR merged on the forge, nothing recorded, the worktree stays.
  const before = fs.readFileSync(path.join(settings.state, 'learning', 'proposals.json'), 'utf8');
  const tree = readLearning(settings.state).prs[0].tree;
  w.prs[0].state = 'merged';
  const obs = await learningCheck({ settings: { ...settings, mode: 'observe' }, clients: { forge }, io, now: MONDAY, morningDone: true });
  assert.match(obs.notes.join('\n'), /merged; recorded at a live pass/);
  assert.equal(fs.readFileSync(path.join(settings.state, 'learning', 'proposals.json'), 'utf8'), before);
  assert.ok(fs.existsSync(tree), 'observe removes no worktree');
});

test('N5: a pass is wanted only for real work: a week due, a rule PR the forge shows changed since the last pass, a rewording that waited, a queued toolkit rule; nothing in observe', async () => {
  const w = loopWorld();
  const { settings } = w;
  const save = (d) => {
    fs.mkdirSync(path.join(settings.state, 'learning'), { recursive: true });
    fs.writeFileSync(path.join(settings.state, 'learning', 'proposals.json'), JSON.stringify(d));
  };
  const WED = Date.parse('2026-11-18T12:00:00+02:00');
  const LAST = '2026-11-18T08:00:00.000Z';
  const changed = { 'guide-docs': [] };
  const forge = await forgeOf(settings, forgeAdapter({ changed }));
  const want = (over = {}) => learnWanted({ settings, clients: { forge }, now: WED, morningDone: true, ...over });
  // The week W47 done, one open rule PR, the last pass two hours ago: nothing changed, nothing to do.
  const data = { startWeek: '2026-W46', weeks: { '2026-W47': { at: LAST } }, prs: [{ repo: 'guide-docs', number: 100, state: 'open', items: [] }], rules: [], lastPass: LAST };
  save(data);
  assert.deepEqual(await want(), []);
  // A comment on the PR moves its `updatedAt`: wanted.
  changed['guide-docs'].push({ ...forgePr({ repo: 'guide-docs', number: 100 }), updatedAt: '2026-11-18T09:30:00.000Z' });
  assert.deepEqual(await want(), ['rule PR(s) changed: guide-docs#100']);
  // A PR changed before the last pass is not.
  changed['guide-docs'][0].updatedAt = '2026-11-18T07:00:00.000Z';
  assert.deepEqual(await want(), []);
  // A forge read that fails: the pass reads the PR itself.
  const failing = await forgeOf(settings, forgeAdapter({ changed, fail: { 'guide-docs': 'HTTP 502' } }));
  assert.deepEqual(await want({ clients: { forge: failing } }), ['rule PR(s) changed: guide-docs#100']);
  // A rewording that waited for the gate: wanted once the gate is open, not while it is closed.
  save({ ...data, prs: [{ ...data.prs[0], waiting: true }] });
  assert.deepEqual(await want(), ['a rewording that waited for the gate']);
  assert.deepEqual(await want({ morningDone: false }), []);
  // A queued toolkit rule, and the week not done: wanted with the gate open, not with a ticket run going.
  save({ ...data, weeks: {}, rules: [{ rid: '2026-W47-1', toolkit: { state: 'queued' } }] });
  assert.deepEqual(await want(), ['the week 2026-W47', 'a queued toolkit rule']);
  assert.deepEqual(await want({ busy: 'a ticket run' }), []);
  // Observe: nothing, whatever there is.
  assert.deepEqual(await learnWanted({ settings: { ...settings, mode: 'observe' }, clients: { forge }, now: WED, morningDone: true }), []);
  // A pass records its time, and the next read keeps it.
  save({ startWeek: '2026-W46', weeks: { '2026-W47': { at: LAST } }, prs: [], rules: [] });
  await learningCheck({ settings, clients: { forge }, io: { spawnClaude: fakeClaude(() => null) }, now: WED, morningDone: true });
  assert.equal(readLearning(settings.state).lastPass, new Date(WED).toISOString());
});

test('the loop in observe or a dry run: nothing runs and nothing is written', async () => {
  const w = loopWorld({ mode: 'observe' });
  fs.mkdirSync(path.dirname(logPath(w.settings.state)), { recursive: true });
  fs.writeFileSync(logPath(w.settings.state), [entry('a', 1), entry('b', 2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const calls = [];
  const forge = await forgeOf(w.settings, w.adapter);
  const r = await learningCheck({ settings: w.settings, clients: { forge }, io: { spawnClaude: fakeClaude(() => ({ patterns: [] }), calls) }, now: MONDAY, morningDone: true });
  assert.deepEqual([calls.length, w.prs.length, fs.existsSync(path.join(w.settings.state, 'learning', 'proposals.json')), r.week.due], [0, 0, false, false]);
});

test('point 5: a toolkit rule that names the host, or a taste rule for a corpus, is never pushed', async () => {
  const w = loopWorld();
  const { settings } = w;
  const forge = await forgeOf(settings, w.adapter);
  const calls = [];
  const seed = (result, { kind = 'general', others = [] } = {}) => {
    fs.mkdirSync(path.join(settings.state, 'learning'), { recursive: true });
    fs.writeFileSync(path.join(settings.state, 'learning', 'proposals.json'), JSON.stringify({ startWeek: '2026-W40', weeks: { [weekOf(MONDAY)]: {} }, rules: [{ rid: 'W-1', kind, rule: 'Р.', why: 'П.', examples: [], overrides: 'Ж1', toolkit: { state: 'queued', kind, rule: 'Р.', why: 'П.' } }, ...others], prs: [], consumed: [] }));
    return { spawnClaude: fakeClaude(() => result, calls), toolkitForgeAdapter: w.tadapter };
  };
  const pass = (io, over = {}) => learningCheck({ settings, clients: { forge }, io, now: MONDAY, morningDone: true, ...over });
  const r1 = await pass(seed({ file: FC, ...UA_RULE, body: `${UA_RULE.body}\n\nЯк у guide-docs.`, summary: 'Setting before time.' }));
  assert.match(r1.toolkit[0].failed, /names the host \(guide-docs\)/);
  // The corpus is there (the toolkit is a copy of this repo): the guard itself refuses.
  const r2 = await pass(seed({ file: 'context/google-developer-style-guide/ROUTING.md', name: 'X', body: 'Y', summary: 'A taste rule.' }));
  assert.match(r2.toolkit[0].failed, /no rule from the owner's edits goes into a distilled corpus/);
  const r3 = await pass(seed({ file: FC, ...UA_RULE, summary: 'Українською.' }));
  assert.match(r3.toolkit[0].failed, /English sentence/);
  // A correction: rules and corpora only, never a skill; a corpus with its source; the file's language.
  const r4 = await pass(seed({ file: 'skills/api-doc-writer/SKILL.md', find: 'name:', replace: 'name:', summary: 'A fix.' }, { kind: 'exception' }));
  assert.match(r4.toolkit[0].failed, /neither a rule file nor a distilled corpus file/);
  const r5 = await pass(seed({ file: 'context/google-developer-style-guide/ROUTING.md', find: '# ', replace: '# ', summary: 'A fix.' }, { kind: 'exception' }));
  assert.match(r5.toolkit[0].failed, /cites its primary source/);
  const r6 = await pass(seed({ file: FC, find: '- [ ] Назви репозиторіїв — у `code font` (Ж5)?', replace: '- [ ] Repository names are always written in code font (Ж5)?', summary: 'A fix.' }, { kind: 'exception' }));
  assert.match(r6.toolkit[0].failed, /the correction is in en, .* in uk/);
  const fcHead = fs.readFileSync(path.join(PLUGIN, FC), 'utf8').split('\n').find((l) => l.startsWith('### Ж2 '));
  const r7 = await pass(seed({ file: FC, find: fcHead, replace: '### Ж2 Плейсхолдери без тире', summary: 'A fix.' }, { kind: 'exception' }));
  assert.match(r7.toolkit[0].failed, /a rule heading keeps the file's form/);
  assert.equal(w.tprs.length, 0);
  assert.equal(g(w.toolkit.origin, 'branch', '--list', 'learned-*'), '');
  assert.ok(!fs.existsSync(path.join(settings.state, 'learning', 'trees', 'toolkit', 'learned-rule-w-1')), 'a failed step leaves no worktree');
  // One toolkit PR at a time (so two never take one rule number), and the session gate holds a queued rule too.
  const n = calls.length;
  const held = await pass(seed({}, { others: [{ rid: 'W-0', kind: 'general', rule: 'О.', why: 'П.', examples: [], toolkit: { state: 'open', number: 7, kind: 'general' } }] }));
  assert.match(held.notes.join('\n'), /waits for the toolkit PR of W-0 \(#7\): one at a time/);
  const night = await pass(seed({}), { morningDone: false });
  assert.match(night.notes.join('\n'), /the toolkit rule W-1 waits: today's morning run hasn't run yet/);
  assert.equal(calls.length, n, 'no session for either');
});

test('a correction replaces its text literally: `$&` in it is the text, not a pattern', async () => {
  const w = loopWorld();
  const { settings } = w;
  const forge = await forgeOf(settings, w.adapter);
  const PS_TEXT = fs.readFileSync(path.join(PLUGIN, PS), 'utf8');
  const find = PS_TEXT.split('\n').find((l) => /^1\. \*\*/.test(l));
  fs.mkdirSync(path.join(settings.state, 'learning'), { recursive: true });
  fs.writeFileSync(path.join(settings.state, 'learning', 'proposals.json'), JSON.stringify({ startWeek: '2026-W40', weeks: { [weekOf(MONDAY)]: {} }, rules: [{ rid: 'W-1', kind: 'exception', rule: 'Р.', why: 'П.', examples: [], overrides: 'procedure-steps.md 1', toolkit: { state: 'queued', kind: 'exception', rule: 'Р.', why: 'П.' } }], prs: [], consumed: [] }));
  const r = await learningCheck({ settings, clients: { forge }, io: { spawnClaude: fakeClaude(() => ({ file: PS, find, replace: `${find} Costs $& nothing.`, summary: 'A rule the owner reversed, corrected.' })), toolkitForgeAdapter: w.tadapter }, now: MONDAY, morningDone: true });
  assert.equal(r.toolkit[0].number, 7, JSON.stringify(r.toolkit));
  const now = g(w.toolkit.origin, 'show', `${w.tprs[0].head}:plugins/doc-writer-toolkit/${PS}`);
  assert.ok(now.includes(`${find} Costs $& nothing.`));
});

test('the learner role\'s command: its own agent, the brief given, no script rules', () => {
  const settings = settingsFor(tmp());
  const cmd = commandFor({ stage: 'learn-week', role: 'learner', keys: [], worktrees: [] }, settings, { agentsPath: '/x/agents.json', brief: 'Stage `learn week`.' });
  assert.equal(cmd.args[cmd.args.indexOf('-p') + 1], 'Stage `learn week`.');
  assert.equal(cmd.model, 'claude-opus-5-5');
  assert.ok(!cmd.args.some((a) => /ticket-state\.mjs record/.test(a)), 'no record: the result is a file');
  assert.ok(cmd.args.includes('Bash'), 'Bash denied');
  assert.ok(cmd.args.includes(`Edit(//${path.join(settings.state, 'learning').replace(/^\/+/, '')}/**)`), 'no session writes the learning state');
});
