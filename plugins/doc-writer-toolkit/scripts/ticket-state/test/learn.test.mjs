import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeAdapter, gitRepo, pr as forgePr, settingsFor, tmp } from './fakes.mjs';
import { newLedger, newPr, writeLedger, readAllLedgers } from '../lib/ledger.mjs';
import { blocksOf, changedBlocks, collectEdits, logPath, readLog } from '../lib/learn-log.mjs';
import { checkPatterns, editKit, kindOf, learningCheck, learnStatus, markerOf, namesIn, namesOf, readLearning, renderBody, resolveRuleReply, trendOf, weekDue, weekOf } from '../lib/learn.mjs';
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
const PAGE_TEXT = '---\ntitle: Платежі\n---\n\n# Платежі\n\n## Створення платежу\n\nОператор бачить платіж, який партнер передав у систему.\n\nНатисніть **Створити**.\n\n## Скасування\n\nПлатіж можна скасувати до підтвердження.\n';

test('blocks: headings, paragraphs and fences apart; a change in whitespace only is none', () => {
  const b = blocksOf('---\ntitle: X\n---\n\n# A\n\nText one.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n## B\n\nText two.\n');
  assert.deepEqual(b.map((x) => [x.heading, x.text.split('\n')[0]]), [[null, '---'], ['A', '# A'], ['A', 'Text one.'], ['A', '```js'], ['B', '## B'], ['B', 'Text two.']]);
  assert.deepEqual(changedBlocks('# A\n\nOne  two.\n', '# A\n\nOne two.\n'), []);
  assert.deepEqual(changedBlocks('# A\n\nOne.\n\nTwo.\n', '# A\n\nOne, changed.\n\nTwo.\n\nThree.\n'), [{ block: 'A', before: 'One.', after: 'One, changed.' }, { block: 'A', before: '', after: 'Three.' }]);
});

// A PR with four kinds of owner's edits: an applied comment, a restored style fix, a hand commit before ready for
// merge and the final edit after it, and the pipeline's own commits around them.
function editedPr(root) {
  const r = hostRepo(root, 'guide-docs', { [PAGE]: PAGE_TEXT, 'i18n/en/docusaurus-plugin-content-docs/current/x/a.md': '# Payments\n\nText.\n' });
  r.g('checkout', '-q', '-b', 'ticket-57');
  const draft = r.commit({ [PAGE]: PAGE_TEXT.replace('до підтвердження', 'до його підтвердження') }, 'Draft: payments');
  const hand = r.commit({ [PAGE]: fs.readFileSync(path.join(r.dir, PAGE), 'utf8').replace('Оператор бачить платіж, який партнер передав у систему.', 'Оператор бачить платіж.'), 'i18n/en/docusaurus-plugin-content-docs/current/x/a.md': '# Payments\n\nText, edited.\n' }, 'оператору не треба знати, що передав партнер');
  const ready = r.commit({ 'docs/x/b.md': '# Інша\n\nТекст.\n' }, 'EN translation');
  const final = r.commit({ [PAGE]: fs.readFileSync(path.join(r.dir, PAGE), 'utf8').replace('Натисніть **Створити**.', 'Натисніть **Створити платіж**.') }, 'Update a.md');
  r.g('push', '-q', 'origin', 'ticket-57');
  r.g('fetch', '-q', 'origin');
  return { r, draft, hand, ready, final };
}

function edited(settings, key, number, extra = {}) {
  const l = newLedger({ key, card: { id: `c${key}`, shortLink: `s${key}`, url: `https://tracker.example/c/s${key}`, name: `Card ${key}` }, now: new Date(MONDAY - 9 * 86400000).toISOString() });
  l.prs.push({ ...newPr({ repo: 'guide-docs', targets: ['guide'], review: 'sme', branch: `ticket-${number}` }), number, url: `https://forge.example/acme/guide-docs/pull/${number}`, ...extra });
  writeLedger(settings.state, l);
  return l;
}

test('point 1: the collector logs the applied comment, the restored style fix, the hand edit and the final edit, block by block; a second run adds nothing', async () => {
  const root = tmp();
  const settings = settingsFor(root, { learning: { since: WINDOW } });
  const { draft, hand, ready, final } = editedPr(root);
  edited(settings, '857', 57, {
    pipelineCommits: [draft.slice(0, 7), ready],
    readyForMerge: [{ head: ready, at: new Date(MONDAY - 3 * 86400000).toISOString(), seq: 9 }],
    styleChecked: [{ sha: hand, reason: 'оператор і партнер — різні сторони' }],
    edits: [
      { n: 1, list: 'description', stage: 'pr', page: PAGE, block: 'Скасування', before: 'до підтвердження', after: 'до його підтвердження', at: 'x', seq: 1 },
      { n: 2, list: '7001', stage: 'answerComments', page: PAGE, block: 'Скасування', before: 'Платіж можна скасувати.', after: 'Платіж можна скасувати до підтвердження.', reason: 'без умови читач не знає меж', at: '2026-11-10T10:00:00Z', seq: 2 },
      { n: 3, list: '7001', stage: 'answerComments', page: PAGE, block: 'Створення платежу', before: 'Натисніть Створити.', after: 'Натисніть **Створити**.', rule: 'gdsg: ui-elements', at: '2026-11-10T10:00:00Z', seq: 2, rejected: { at: '2026-11-11T10:00:00Z', seq: 3, by: 4 } },
      { n: 4, list: '7002', stage: 'answerComments', page: PAGE, block: 'Створення платежу', before: 'Натисніть **Створити**.', after: 'Натисніть Створити.', restores: 3, at: '2026-11-11T10:00:00Z', seq: 3 },
    ],
  });
  const views = async () => ({ head: final, state: 'merged', mergedAt: '2026-11-13T12:00:00Z' });
  const r1 = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: views, now: MONDAY });
  const log = readLog(settings.state);
  assert.deepEqual(log.map((e) => e.source).sort(), ['comment', 'final', 'hand', 'restore'], 'the pipeline\'s own fix (1) and the restore item itself (4) are not owner edits of their own');
  const byS = Object.fromEntries(log.map((e) => [e.source, e]));
  assert.equal(byS.comment.comment, 'без умови читач не знає меж');
  assert.deepEqual([byS.restore.before, byS.restore.after, byS.restore.rule], ['Натисніть **Створити**.', 'Натисніть Створити.', 'gdsg: ui-elements']);
  assert.deepEqual([byS.hand.page, byS.hand.block, byS.hand.before, byS.hand.after, byS.hand.comment], [PAGE, 'Створення платежу', 'Оператор бачить платіж, який партнер передав у систему.', 'Оператор бачить платіж.', 'оператор і партнер — різні сторони'], 'UA only; the style check\'s reason over the commit\'s subject');
  assert.deepEqual([byS.final.before, byS.final.after, byS.final.sha, byS.final.comment], ['Натисніть **Створити**.', 'Натисніть **Створити платіж**.', final, 'Update a.md'], 'after the first ready head: the final edit');
  assert.ok(log.every((e) => e.pr === 57 && e.repo === 'guide-docs' && e.url && e.key === '857'));
  assert.equal(r1.added.length, 4);
  // Once more: nothing added twice, and a merged PR is not read again.
  let asked = 0;
  const r2 = await collectEdits({ settings, ledgers: readAllLedgers(settings.state), viewOf: async (...a) => (asked++, views(...a)), now: MONDAY });
  assert.deepEqual([r2.added.length, asked, readLog(settings.state).length], [0, 0, 4]);
});

test('the backfill: a PR merged in the window is collected, one merged before it is not, a PR closed unmerged is not; the command run twice adds nothing twice', async () => {
  const root = tmp();
  const settings = settingsFor(root, { learning: {} });
  const item = (n, at) => ({ n, list: '7100', stage: 'answerComments', page: PAGE, block: 'Скасування', before: `було ${n}`, after: `стало ${n}`, at, seq: n });
  edited(settings, '901', 61, { stage: 'merged', merged: { at: '2026-11-12T10:00:00Z', commit: 'm1' }, edits: [item(1, '2026-11-06T10:00:00Z')] });
  edited(settings, '902', 62, { stage: 'merged', merged: { at: '2026-11-06T10:00:00Z', commit: 'm2' }, edits: [item(2, '2026-11-05T10:00:00Z')] });
  edited(settings, '903', 63, { stage: 'finalReview', edits: [item(3, '2026-11-10T10:00:00Z')] });
  edited(settings, '904', 64, { stage: 'finalReview', edits: [item(4, '2026-11-10T10:00:00Z')] });
  // The forge: 61 merged this week, 63 open, 64 closed unmerged (62 is never asked: its ledger says when it merged).
  const prs = [forgePr({ number: 61, state: 'merged' }), forgePr({ number: 62, state: 'merged' }), forgePr({ number: 63 }), forgePr({ number: 64, state: 'closed' })];
  prs[0].mergedAt = '2026-11-12T10:00:00Z';
  const adapter = forgeAdapter({ prs });
  const quiet = { commits: () => [], pages: () => [], between: () => [], show: () => null };
  const out = [];
  const stdout = { write: (s) => out.push(s) };
  const run = async (...extra) => {
    out.length = 0;
    await main(['learn', 'collect', '--root', root, '--settings', settings.file, '--since', WINDOW, ...extra], { stdout, forgeAdapter: adapter, learnReader: quiet, env: {} });
    return JSON.parse(out.join(''));
  };
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(settings.file, JSON.stringify((await import('./fakes.mjs')).rawSettings({ learning: {} })));
  const dry = await run('--dry-run');
  assert.deepEqual([dry.dryRun, dry.added, fs.existsSync(logPath(settings.state))], [true, 2, false], 'a dry run lists and writes nothing');
  const first = await run();
  assert.deepEqual(readLog(settings.state).map((e) => e.after).sort(), ['стало 1', 'стало 3'], 'the PR merged this week, with its edits from before the window too, and the open one');
  assert.equal(first.added, 2);
  const second = await run();
  assert.deepEqual([second.added, readLog(settings.state).length], [0, 2], 'run twice: nothing twice');
  // A role session can't run it.
  await assert.rejects(main(['learn', 'collect', '--root', root, '--settings', settings.file], { stdout, forgeAdapter: adapter, env: { DOC_TOOLKIT_ROLE_SESSION: 'writer' } }), /refused in a role session/);
  const st = learnStatus(settings);
  assert.deepEqual([st.log.entries, st.log.prs, st.log.bySource], [2, 2, { comment: 2 }]);
});

test('a run\'s own pass reads its status only: a PR the status shows is read, one it doesn\'t waits for the weekly pass', async () => {
  const { viewsFrom } = await import('../lib/learn-log.mjs');
  const st = { tickets: [{ key: '857', prs: [{ id: 'guide-docs#57', head: 'h1', state: 'open' }] }] };
  const view = viewsFrom(st, null);
  assert.deepEqual(await view({ key: '857' }, { repo: 'guide-docs', number: 57 }), { head: 'h1', state: 'open', mergedAt: null });
  assert.equal(await view({ key: '858' }, { repo: 'guide-docs', number: 58 }), null);
});

// ------------------------------------------------------------------ AC-1: patterns seen twice

const entry = (id, pr, extra = {}) => ({ id, repo: 'guide-docs', pr, url: `https://forge.example/acme/guide-docs/pull/${pr}`, page: PAGE, block: 'Б', before: `було ${id}`, after: `стало ${id}`, source: 'hand', at: '2026-11-10T10:00:00Z', ...extra });

test('AC-1: only patterns seen at least twice on two PRs are kept, with their examples; used, unknown, rejected and kindless ones are refused', () => {
  const log = [entry('a', 1), entry('b', 2), entry('c', 2), entry('c2', 2), entry('d', 3), entry('e', 4), entry('f', 5), entry('g', 6)];
  const result = {
    patterns: [
      { kind: 'продукт', rule: 'Оператор не бачить дій партнера.', why: 'Оператор не бачить, що робив партнер.', examples: ['a', 'b'] },
      { kind: 'загальне', rule: 'Одна дія — один крок.', why: 'Так читач не губить місце.', examples: ['c'] },
      { kind: 'product', rule: 'Два приклади, один PR.', why: 'w', examples: ['c', 'c2'] },
      { kind: 'general', rule: 'Невідомий рядок.', why: 'w', examples: ['d', 'zzz'] },
      { kind: 'general', rule: 'Уже використаний.', why: 'w', examples: ['d', 'used'] },
      { kind: 'general', rule: 'Сторінки оператора не описують дій партнера: це різні сторони!', why: 'w', examples: ['d', 'e'] },
      { kind: 'taste', rule: 'Без виду.', why: 'w', examples: ['d', 'e'] },
      { kind: 'виняток із загального', rule: 'Без правила, яке скасовує.', why: 'w', examples: ['d', 'e'] },
      { kind: 'exception', rule: 'Назва кнопки без лапок і без жирного в заголовках таблиць.', why: 'w', examples: ['f', 'g'], overrides: 'formatting-conventions.md Ж1' },
    ],
  };
  const { kept, refused } = checkPatterns(result, { log: [...log, entry('used', 9)], consumed: ['used'], rejected: ['сторінки оператора не описують дій партнера: це різні сторони'] });
  assert.deepEqual(kept.map((k) => [k.kind, k.examples]), [['product', ['a', 'b']], ['exception', ['f', 'g']]]);
  assert.equal(kept[1].overrides, 'formatting-conventions.md Ж1');
  assert.deepEqual(refused.map((r) => r.why.split(':')[0].split(' (')[0]), [
    'seen 1 time(s) on 1 PR(s)',
    'seen 2 time(s) on 1 PR(s)',
    'examples not in the log',
    'examples an earlier proposal already used',
    'the owner rejected this rule before',
    'the kind "taste" is none of product, general, exception',
    'an exception names the general rule it overrides',
  ]);
  // An edit is used once: a second pattern that cites a kept one's example is refused.
  const twice = checkPatterns({ patterns: [{ kind: 'product', rule: 'X.', why: 'w', examples: ['a', 'd'] }, { kind: 'product', rule: 'Y.', why: 'w', examples: ['a', 'e'] }] }, { log });
  assert.deepEqual([twice.kept.length, twice.refused[0].why.startsWith('examples an earlier proposal already used')], [1, true]);
  assert.deepEqual([kindOf('тільки цей проєкт'), kindOf('Загальне'), kindOf('виняток із загального'), kindOf('other')], ['product', 'general', 'exception', null]);
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
});

test('point 3: the description starts with the trend line and the numbered rules, then the host\'s PR structure, and names no tool', async () => {
  const settings = settingsFor(tmp(), { learning: { labels: UA_LABELS } });
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
});

// ------------------------------------------------------------------ AC-3: the toolkit file's own form

const FC = 'context/doc-rules/project-rules/formatting-conventions.md';
const PS = 'context/doc-rules/project-rules/procedure-steps.md';
const UA_RULE = {
  name: 'Одна сторона на сторінку',
  english: 'One party per page',
  body: [
    'Сторінка для однієї сторони описує лише те, що бачить і робить ця сторона. Дії іншої сторони — лише як результат, який видно цій.',
    '',
    '| ⛔ Не так | ✅ Так |',
    '|---|---|',
    '| Оператор бачить платіж, який партнер передав у систему. | Оператор бачить платіж. |',
    '',
    '**Джерела корпусу:** `GDSG-PRINCIPLES-AUDIENCE` — «Write for your audience». Правило Ж3 тут не змінюється.',
    '',
    '**Проєктне рішення:** межа сторони сторінки — проєктна.',
  ].join('\n'),
  check: 'Сторінка описує дії лише своєї сторони (Ж11)?',
  loadRow: ['Хто з учасників яку сторінку читає', 'шаблони сторінок набору продукту'],
};

test('AC-3: a fixture rule added to formatting-conventions.md keeps its language, numbering, heading form, structure and checklist; the lint\'s checks pass on it', () => {
  const text = fs.readFileSync(path.join(PLUGIN, FC), 'utf8');
  const before = formOf(text);
  const out = insertRule(text, UA_RULE, { pluginRoot: PLUGIN });
  assert.equal(out.number, Math.max(...before.rules.map((r) => r.n)) + 1);
  assert.equal(out.heading, `### Ж${out.number} — Одна сторона на сторінку (One party per page)`);
  // Diffed against the file's existing rules: the same heading pattern, the next number, placed after the last rule.
  const re = /^### Ж\d+[a-z]? — .+ \([^()]*[A-Za-z][^()]*\)$/;
  assert.ok(before.rules.filter((r) => re.test(text.split('\n')[r.i])).length >= before.rules.length - 1, 'the pattern is the file\'s own');
  assert.match(out.heading, re);
  const after = formOf(out.text);
  assert.equal(after.rules.at(-1).n, out.number);
  const lines = out.text.split('\n');
  const at = lines.indexOf(out.heading);
  assert.ok(at > lines.findIndex((l) => l.startsWith('### Ж10 ')) && at < lines.indexOf('### Чекліст ядра'), 'after Ж10, before the core checklist');
  assert.ok(lines.indexOf(`- [ ] ${UA_RULE.check}`) > lines.indexOf('### Чекліст ядра') && lines.indexOf(`- [ ] ${UA_RULE.check}`) < lines.indexOf('## Українською'), 'its checklist line at the end of the checklist');
  assert.ok(lines.indexOf('| Хто з учасників яку сторінку читає | шаблони сторінок набору продукту |') < lines.findIndex((l) => l.startsWith('### Ж1 ')), 'the row in the table of what lives where');
  assert.equal(out.text.split('\n').length, text.split('\n').length + UA_RULE.body.split('\n').length + 5, 'the heading, two blank lines, the checklist line and the table row');
  assert.equal(scriptOf(out.text), 'uk');
  // The lint's per-file checks on the new text: every plugin path exists, every annotation frame is whole.
  assert.deepEqual(rootRefs(out.text).filter(({ ref }) => !fs.existsSync(path.join(PLUGIN, ref))), []);
  assert.deepEqual(annotationProblems(out.text), []);
});

test('AC-3: the form is refused where it differs: an English body in a Ukrainian file, a missing part, a cross-reference to no rule, no English name, no check line', () => {
  const text = fs.readFileSync(path.join(PLUGIN, FC), 'utf8');
  const no = (rule, re) => assert.throws(() => insertRule(text, { ...UA_RULE, ...rule }, { pluginRoot: PLUGIN }), re);
  no({ body: 'A page for one party says only what that party sees and does. **Джерела корпусу:** none. **Проєктне рішення:** ours.', name: 'One party per page' }, /written in English, the file in Ukrainian/);
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
  const out = insertRule(text, { name: 'One party per page', body: 'A step names only what the reader\'s party does and sees.\nAnother party\'s action is a result the reader sees, never a step.' }, { pluginRoot: PLUGIN });
  const n = before.rules.length + 1;
  assert.equal(out.heading, `${n}. **One party per page**`, 'the file\'s names carry no full stop of their own');
  const lines = out.text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${n}. **One party per page** A step names`));
  assert.ok(at > before.rules.at(-1).i);
  assert.equal(lines[at + 1], "   Another party's action is a result the reader sees, never a step.");
  assert.throws(() => insertRule(text, { name: 'Одна сторона', body: 'Сторінка описує лише дії своєї сторони, а дії іншої сторони — як результат.' }), /written in Ukrainian, the file in English/);
  assert.deepEqual(ruleFiles(PLUGIN).map((f) => f.file).filter((f) => [FC, PS].includes(f)).sort(), [FC, PS]);
});

test('point 5: the host\'s names never reach the toolkit', () => {
  const settings = settingsFor(tmp(), { learning: { names: ['Lunapay'] } });
  const names = namesOf(settings);
  assert.ok(['guide-docs', 'expert-one', 'owner-login', 'acme', 'Lunapay'].every((n) => names.includes(n)));
  assert.deepEqual(namesIn('Pages of guide-docs and the Lunapay app', names), ['guide-docs', 'Lunapay']);
  assert.deepEqual(namesIn('A page for one party', names), []);
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
  const toolkit = hostRepo(root, 'toolkit', { [`plugins/doc-writer-toolkit/${FC}`]: fcText, [`plugins/doc-writer-toolkit/${PS}`]: fs.readFileSync(path.join(PLUGIN, PS), 'utf8'), 'plugins/doc-writer-toolkit/context/project-paths.md': '# Paths\n', 'plugins/doc-writer-toolkit/context/doc-templates/README.md': '# T\n' });
  const settings = settingsFor(root, { mode, limits: { usageGuard: false }, learning: { section: '## Правила з правок', labels: UA_LABELS, toolkit: { repo: 'tools-org/toolkit', path: 'repos/toolkit', base: 'main' } } });
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
    if (mode === 'week') return { patterns: [{ kind: 'product', rule: 'Сторінки оператора не описують дій партнера.', why: 'Оператор і партнер — різні сторони.', examples: ['a', 'b'] }, { kind: 'general', rule: 'Сторінка однієї сторони описує лише її дії.', why: 'Читач не бачить дій іншої сторони.', examples: ['c', 'd'] }, { kind: 'product', rule: 'Один раз.', why: 'w', examples: ['e'] }], dropped: [] };
    if (mode === 'toolkit') return { file: FC, ...UA_RULE, summary: 'A page for one party describes only what that party does and sees.' };
    return null;
  };
  const forge = await forgeOf(settings, w.adapter);
  const io = { spawnClaude: fakeClaude(week1, calls), viewOf: async () => null, toolkitForgeAdapter: w.tadapter, lint: () => {} };
  const check = (over = {}) => learningCheck({ settings, clients: { forge }, io, now: MONDAY, morningDone: true, busy: null, ...over });

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
  assert.match(pr.body, /^The owner's edits per PR: .*\n\n1\. \*\*продукт\*\* — Сторінки оператора не описують дій партнера\.\n {3}Чому: Оператор і партнер — різні сторони\.\n {3}- було → стало: «було a» → «стало a»/);
  assert.ok(pr.body.includes('2. **загальне** — Сторінка однієї сторони описує лише її дії.'));
  assert.ok(!pr.body.includes('Один раз'), 'seen once: not proposed');
  // AC-2: the kit on the base is as it was; the branch holds the rules, under the section, marked.
  assert.equal(kitOn(w.host, 'main'), w.kitText.trim());
  const branchKit = kitOn(w.host, 'rules-from-edits-2026-w47');
  assert.ok(branchKit.includes('## Правила з правок\n\n- Сторінки оператора не описують дій партнера. Чому: Оператор і партнер — різні сторони. <!-- learned:2026-W47-1 -->'));
  assert.equal(g(w.host.origin, 'log', '-1', '--format=%B', 'rules-from-edits-2026-w47'), "Rules from the owner's edits", 'a plain message, no trailer');
  assert.ok(r.notify[0].title.includes('rules from your edits'));
  const data = readLearning(settings.state);
  assert.deepEqual(data.consumed.sort(), ['a', 'b', 'c', 'd'], 'the edits a proposal used; the one seen once stays for a later week');
  // The same week again: no second session.
  await check();
  assert.equal(calls.length, 1);
  assert.equal(weekDue({ settings, data: readLearning(settings.state), now: MONDAY, morningDone: true }).why, '2026-W47 is done');

  // The owner's reply by number: 1 no, 2 the owner's own text. A comment of the pipeline's, or without the owner, is no reply.
  w.activity['guide-docs#100'] = { comments: [
    { id: 501, author: 'someone-else', body: '1 — ні', createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z' },
    { id: 502, author: 'owner-login', body: '1 — ні\n2 — "Сторінка для однієї сторони описує лише те, що ця сторона бачить і робить."', createdAt: '2026-11-16T10:01:00Z', updatedAt: '2026-11-16T10:01:00Z' },
  ] };
  const r2 = await check();
  assert.deepEqual(r2.replied, [{ pr: 'guide-docs#100', items: [{ n: 1, do: 'reject' }, { n: 2, do: 'verbatim' }] }]);
  const kit2 = kitOn(w.host, 'rules-from-edits-2026-w47');
  assert.ok(!kit2.includes('learned:2026-W47-1') && kit2.includes('- Сторінка для однієї сторони описує лише те, що ця сторона бачить і робить. Чому: Читач не бачить дій іншої сторони. <!-- learned:2026-W47-2 -->'));
  const reply = w.adapter.log.find((x) => x[0] === 'comment')[1];
  assert.match(reply.body, /\*\*1\*\* — removed, not proposed again\n\*\*2\*\* — reworded: «Сторінка для однієї сторони/);
  assert.match(w.prs[0].body, /1\. ~~продукт — Сторінки оператора не описують дій партнера\.~~ \(removed\)/);
  assert.equal(kitOn(w.host, 'main'), w.kitText.trim(), 'still nothing on the base');
  // Seen once: the same comment is not answered again.
  await check();
  assert.equal(w.adapter.log.filter((x) => x[0] === 'comment').length, 1);

  // The merge is the yes: the general rule is queued for the toolkit, and the toolkit PR is made in the file's own form.
  w.prs[0].state = 'merged';
  const r3 = await check();
  const d3 = readLearning(settings.state);
  assert.deepEqual(d3.prs[0].items.map((x) => x.state), ['rejected', 'accepted']);
  assert.equal(r3.toolkit[0].number, 7);
  const tk = w.tprs[0];
  assert.match(tk.title, /^Add a rule learned from the owner's edits to formatting-conventions\.md$/);
  assert.doesNotMatch(tk.body, /guide-docs|acme|owner-login|expert/);
  const fcNow = g(w.toolkit.origin, 'show', `${tk.head}:plugins/doc-writer-toolkit/${FC}`);
  assert.ok(fcNow.includes('### Ж11 — Одна сторона на сторінку (One party per page)'));
  assert.equal(calls.at(-1).mode, 'toolkit');
  assert.deepEqual(calls.at(-1).input.files.map((f) => f.file).sort(), [FC, PS]);
  assert.equal(g(w.toolkit.origin, 'show', `main:plugins/doc-writer-toolkit/${FC}`), w.fcText.trim(), 'the toolkit base: unchanged until the owner merges');

  // The next week: the toolkit PR merged and in the installed plugin (the switch): its host copy is removed; the rejected
  // rule's edits are used, and a session that proposes it again is refused.
  w.tprs[0].state = 'merged';
  const installed = tmp();
  fs.mkdirSync(path.dirname(path.join(installed, FC)), { recursive: true });
  fs.writeFileSync(path.join(installed, FC), fcNow);
  g(w.host.dir, 'fetch', '-q', 'origin');
  g(w.host.dir, 'push', '-q', 'origin', 'origin/rules-from-edits-2026-w47:refs/heads/main');
  fs.appendFileSync(logPath(settings.state), [entry('f', 6), entry('g', 7)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const next = Date.parse('2026-11-23T09:00:00+02:00');
  io.pluginRoot = installed;
  io.spawnClaude = fakeClaude((mode) => (mode === 'week' ? { patterns: [{ kind: 'product', rule: 'Сторінки оператора не описують дій партнера.', why: 'w', examples: ['f', 'g'] }] } : null), calls);
  const r4 = await learningCheck({ settings, clients: { forge }, io, now: next, morningDone: true });
  assert.deepEqual(calls.at(-1).input.rejected, ['Сторінки оператора не описують дій партнера.']);
  const week = readLearning(settings.state).weeks['2026-W48'];
  assert.equal(week.refused[0].why, 'the owner rejected this rule before');
  assert.deepEqual(r4.proposed.map((p) => [p.rules, p.removes]), [[0, 1]], 'a PR that only removes the host copy');
  assert.ok(!kitOn(w.host, 'rules-from-edits-2026-w48').includes('learned:2026-W47-2'));
  assert.match(w.prs[1].body, /removed the copies of rules now in the shared rules/);
});

test('the loop in observe or a dry run: nothing runs and nothing is written', async () => {
  const w = loopWorld({ mode: 'observe' });
  fs.mkdirSync(path.dirname(logPath(w.settings.state)), { recursive: true });
  fs.writeFileSync(logPath(w.settings.state), [entry('a', 1), entry('b', 2)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const calls = [];
  const forge = await forgeOf(w.settings, w.adapter);
  const r = await learningCheck({ settings: w.settings, clients: { forge }, io: { spawnClaude: fakeClaude(() => ({ patterns: [] }), calls) }, now: MONDAY, morningDone: true });
  assert.deepEqual([calls.length, w.prs.length, fs.existsSync(path.join(w.settings.state, 'learning', 'proposals.json')), r.week.due], [0, 0, false, true]);
});

test('point 5: a toolkit rule that names the host, or a taste rule for a corpus, is never pushed', async () => {
  const w = loopWorld();
  const { settings } = w;
  const forge = await forgeOf(settings, w.adapter);
  const seed = (result) => {
    fs.mkdirSync(path.join(settings.state, 'learning'), { recursive: true });
    fs.writeFileSync(path.join(settings.state, 'learning', 'proposals.json'), JSON.stringify({ weeks: { [weekOf(MONDAY)]: {} }, rules: [{ rid: 'W-1', kind: 'general', rule: 'Р.', why: 'П.', examples: [], toolkit: { state: 'queued', kind: 'general', rule: 'Р.', why: 'П.' } }], prs: [], consumed: [] }));
    return { spawnClaude: fakeClaude(() => result), toolkitForgeAdapter: w.tadapter, lint: () => {} };
  };
  const r1 = await learningCheck({ settings, clients: { forge }, io: seed({ file: FC, ...UA_RULE, body: `${UA_RULE.body}\n\nЯк у guide-docs.`, summary: 'One party per page.' }), now: MONDAY, morningDone: true });
  assert.match(r1.toolkit[0].failed, /names the host \(guide-docs\)/);
  const r2 = await learningCheck({ settings, clients: { forge }, io: seed({ file: 'context/google-developer-style-guide/ROUTING.md', name: 'X', body: 'Y', summary: 'A taste rule.' }), now: MONDAY, morningDone: true });
  assert.match(r2.toolkit[0].failed, /no such toolkit file|distilled corpus/);
  const r3 = await learningCheck({ settings, clients: { forge }, io: seed({ file: FC, ...UA_RULE, summary: 'Українською.' }), now: MONDAY, morningDone: true });
  assert.match(r3.toolkit[0].failed, /English sentence/);
  assert.equal(w.tprs.length, 0);
  assert.equal(g(w.toolkit.origin, 'branch', '--list', 'learned-*'), '');
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
