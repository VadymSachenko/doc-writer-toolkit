import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parsePage, canonicalTags, splitCode, boldSpans, assetRefs } from '../lib/parse.mjs';
import { composeChanges, diffBodies, diffFrontmatter } from '../lib/diff.mjs';
import { docRoute, parseBuildErrors } from '../lib/report.mjs';
import { setLastUpdate } from '../lib/record.mjs';
import { gitBlobHash } from '../../ui-labels/lib/util.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locale-sync.mjs');
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

async function cli(cwd, ...args) {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd });
    return { code: 0, out: stdout.trim().startsWith('{') ? JSON.parse(stdout) : stdout, stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout?.trim().startsWith('{') ? JSON.parse(e.stdout) : e.stdout, stderr: e.stderr };
  }
}

// ------------------------------------------------------------------ fixture pages

const UA = `---
sidebar_position: 2
title: Фільтри
description: Дізнайтеся, як працювати з фільтрами
last_update:
  date: 9/8/2026
---

import Tabs from '@theme/Tabs';

Ця сторінка описує [фільтри](/filters/).

## Що потрібно знати {/* #what-to-know */}

- Дії доступні лише в статусі **В роботі**.
- Фільтр \`status\` приймає значення \`done\`.
- Докладніше — на сторінці [Огляд](/overview/).

## Операції {/* #operations */}

У списку ви можете виконувати такі операції:

<Accordion titleAs="h3" title="Фільтрувати записи">

1. Натисніть **Фільтри**.
   <img src={require('./.assets/panel.png').default} width="480" alt="Панель фільтрів" />
2. Оберіть **Статус** і натисніть **Застосувати**.

**Результат:** Список оновлюється.

</Accordion>

{/* ToDo: уточнити текст */}

:::note

Допустимі формати: PNG, JPEG.

:::

\`\`\`mermaid
flowchart LR
  work["В роботі"] -->|Завершити| done["Завершений"]
\`\`\`

### Додаткові дії {/* #extra */}

Ви також можете скинути фільтри.

## Довідкова інформація {/* #reference */}

| Атрибут | Опис |
|---|---|
| Статус | Поточний статус. |
| Дата | Дата створення. |

![Вікно фільтрів](./.assets/dialog.png)
`;

const TR = `---
sidebar_position: 2
title: Filtreler
description: Filtrelerle nasıl çalışacağınızı öğrenin
last_update:
  date: 10/7/2026
---

import Tabs from '@theme/Tabs';

Bu sayfa [filtreleri](/filters/) açıklar.

## Bilmeniz gerekenler {/* #what-to-know */}

- Eylemler yalnızca **İşlemde** durumunda kullanılabilir.
- \`status\` filtresi \`done\` değerini kabul eder.
- Ayrıntılar için [Genel bakış](/overview/) sayfasına bakın.

## İşlemler {/* #operations */}

Listede aşağıdaki işlemleri yapabilirsiniz:

<Accordion titleAs="h3" title="Kayıtları filtreleme">

1. **Filtreler** düğmesine tıklayın.
   <img src={require('./.assets/panel.png').default} width="480" alt="Filtre paneli" />
2. **Durum** seçin ve **Uygula** düğmesine tıklayın.

**Sonuç:** Liste güncellenir.

</Accordion>

{/* ToDo: metni netleştirin */}

:::note

Desteklenen biçimler: PNG, JPEG.

:::

\`\`\`mermaid
flowchart LR
  work["İşlemde"] -->|Tamamla| done["Tamamlandı"]
\`\`\`

### Ek işlemler {/* #extra */}

Filtreleri sıfırlayabilirsiniz.

## Referans bilgi {/* #reference */}

| Öznitelik | Açıklama |
|---|---|
| Durum | Geçerli durum. |
| Tarih | Oluşturulma tarihi. |

![Filtre penceresi](./.assets/dialog.png)
`;

const RU = `---
sidebar_position: 2
title: Фильтры
description: Узнайте, как работать с фильтрами
last_update:
  date: 10/7/2026
---

import Tabs from '@theme/Tabs';

Эта страница описывает [фильтры](/filters/).

## Что нужно знать {/* #what-to-know */}

- Действия доступны только в статусе **В работе**.
- Фильтр \`status\` принимает значение \`done\`.
- Подробнее — на странице [Обзор](/overview/).

## Операции {/* #operations */}

В списке можно выполнять такие операции:

<Accordion titleAs="h3" title="Фильтрация записей">

1. Нажмите **Фильтры**.
   <img src={require('./.assets/panel.png').default} width="480" alt="Панель фильтров" />
2. Выберите **Статус** и нажмите **Применить**.

**Результат:** Список обновляется.

</Accordion>

{/* ToDo: уточнить текст */}

:::note

Допустимые форматы: PNG, JPEG.

:::

\`\`\`mermaid
flowchart LR
  work["В работе"] -->|Завершить| done["Завершён"]
\`\`\`

### Дополнительные действия {/* #extra */}

Вы также можете сбросить фильтры.

## Справочная информация {/* #reference */}

| Атрибут | Описание |
|---|---|
| Статус | Текущий статус. |
| Дата | Дата создания. |

![Окно фильтров](./.assets/dialog.png)
`;

const edit = (text, from, to) => {
  assert.ok(text.includes(from), `fixture text lacks: ${from}`);
  return text.replace(from, to);
};

function plan(a, b, t, opts = {}) {
  const pageA = parsePage(a);
  const pageB = parsePage(b);
  const pageT = parsePage(t);
  return composeChanges({ pageA, pageB, pageT, groups: diffBodies(pageA, pageB), fmChanges: diffFrontmatter(pageA.fm, pageB.fm), ...opts });
}

// ------------------------------------------------------------------ parser

test('parser: sections, leaf blocks and opaque containers', () => {
  const page = parsePage(UA);
  const top = page.root.children.map((c) => `${c.type}${c.title ? ':' + c.title : ''}`);
  assert.deepEqual(top, ['import', 'paragraph', 'section:Що потрібно знати', 'section:Операції', 'section:Довідкова інформація']);
  const ops = page.root.children[3];
  assert.deepEqual(ops.children.map((c) => c.type), ['paragraph', 'component', 'comment', 'admonition', 'code', 'section']);
  const acc = ops.children[1];
  assert.equal(page.lines[acc.start], '<Accordion titleAs="h3" title="Фільтрувати записи">');
  assert.equal(page.lines[acc.end], '</Accordion>');
  const ref = page.root.children[4];
  assert.deepEqual(ref.children.map((c) => c.type), ['table', 'paragraph']);
  assert.equal(ref.children[0].children.length, 2);
  assert.equal(ref.anchor, 'reference');
});

test('parser: headings inside code and components are not sections; list items keep their continuation lines', () => {
  const page = parsePage('# A\n\n```md\n## not a heading\n```\n\n<Tabs>\n\n## inside a component\n\n</Tabs>\n\n1. One\n   continued\n\n   :::note\n\n   inside\n\n   :::\n2. Two\n');
  assert.deepEqual([...page.root.children[0].children.map((c) => c.type)], ['code', 'component', 'item', 'item']);
  assert.equal(page.root.children[0].children[2].end - page.root.children[0].children[2].start, 7);
});

test('inline facts: bold spans, tags with prose attributes elided, asset refs, code masking', () => {
  const sc = splitCode('Натисніть **Зберегти** і `**код**`.\n\n```\n**ні**\n```\n<Accordion title="Тема" titleAs="h3" />\n<img src={require(\'./.assets/a.png\').default} alt="Опис" width="480" />\n![x](./.assets/b.png) ![y](https://a/b.png)\n');
  assert.deepEqual(boldSpans(sc.prose), ['Зберегти']);
  assert.deepEqual(canonicalTags(sc.prose.join('\n')), ['<Accordion title=… titleAs="h3" />', `<img alt=… src={require('./.assets/a.png').default} width="480" />`]);
  assert.deepEqual(assetRefs(sc.prose), ['./.assets/a.png', './.assets/b.png']);
  assert.deepEqual(sc.inline, ['**код**']);
});

// ------------------------------------------------------------------ changed blocks (A -> B mapped onto the translation)

test('blocks: a changed list item maps to the matching translated item, nothing else', () => {
  const b = edit(UA, '- Дії доступні лише в статусі **В роботі**.', '- Дії доступні лише для записів у статусі **В роботі**.');
  const { changes, unmapped } = plan(UA, b, TR);
  assert.equal(unmapped.length, 0);
  assert.equal(changes.length, 1);
  const c = changes[0];
  assert.equal(c.op, 'replace');
  assert.equal(c.kind, 'item');
  assert.deepEqual(c.headingPath, ['Що потрібно знати']);
  assert.equal(c.ua.text, '- Дії доступні лише для записів у статусі **В роботі**.');
  assert.equal(c.target.text, '- Eylemler yalnızca **İşlemde** durumunda kullanılabilir.');
  assert.deepEqual(c.bold, ['В роботі']);
  assert.equal(TR.split('\n')[c.target.lines[0] - 1], c.target.text);
});

test('blocks: more than half of a section changed -> the whole section body', () => {
  let b = edit(UA, '- Дії доступні', '- Усі дії доступні');
  b = edit(b, '- Фільтр `status` приймає', '- Фільтр `status` також приймає');
  const { changes } = plan(UA, b, TR);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'section-body');
  assert.match(changes[0].note, /more than half/);
  assert.equal(changes[0].ua.text.split('\n').length, 3);
  assert.equal(changes[0].target.text.split('\n').length, 3);
  assert.ok(!changes[0].target.text.includes('##'), 'the heading itself is not part of the body');
});

test('blocks: a renamed heading re-translates its whole section, subsections included', () => {
  const b = edit(UA, '## Операції {/* #operations */}', '## Дії над записами {/* #operations */}');
  const { changes } = plan(UA, b, TR);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'section');
  assert.ok(changes[0].ua.text.startsWith('## Дії над записами') && changes[0].ua.text.includes('### Додаткові дії'));
  assert.ok(changes[0].target.text.startsWith('## İşlemler') && changes[0].target.text.endsWith('Filtreleri sıfırlayabilirsiniz.'));
});

test('blocks: table row vs table header; MDX component body; frontmatter values', () => {
  const row = plan(UA, edit(UA, '| Дата | Дата створення. |', '| Дата | Дата й час створення. |'), TR).changes;
  assert.deepEqual([row.length, row[0].kind, row[0].target.text], [1, 'table-row', '| Tarih | Oluşturulma tarihi. |']);

  const header = plan(UA, edit(UA, '| Атрибут | Опис |', '| Поле | Опис |'), TR).changes;
  assert.deepEqual([header.length, header[0].kind, header[0].target.text.split('\n').length], [1, 'table', 4]);

  const step = plan(UA, edit(UA, '2. Оберіть **Статус** і', '2. Виберіть **Статус** і'), TR).changes;
  assert.equal(step.length, 1);
  assert.equal(step[0].kind, 'component');
  assert.ok(step[0].target.text.startsWith('<Accordion') && step[0].target.text.endsWith('</Accordion>'));

  const fm = plan(UA, edit(UA, 'title: Фільтри', 'title: Фільтри записів'), TR);
  assert.deepEqual([fm.changes.length, fm.changes[0].kind, fm.changes[0].key, fm.changes[0].target.text, fm.changes[0].verbatim], [1, 'frontmatter', 'title', 'title: Filtreler', false]);
  const pos = plan(UA, edit(UA, 'sidebar_position: 2', 'sidebar_position: 3'), TR).changes[0];
  assert.equal(pos.verbatim, true);
});

test('blocks: additions carry their anchor; removals carry the target text; several additions chain', () => {
  const added = plan(UA, edit(UA, '- Фільтр `status` приймає значення `done`.\n', '- Фільтр `status` приймає значення `done`.\n- Новий пункт.\n'), TR).changes;
  assert.equal(added.length, 1);
  assert.equal(added[0].op, 'add');
  assert.equal(added[0].insertAfter.text, '- `status` filtresi `done` değerini kabul eder.');
  assert.ok(added[0].insertBefore.text.startsWith('- Ayrıntılar'));

  const removed = plan(UA, edit(UA, '- Фільтр `status` приймає значення `done`.\n', ''), TR).changes;
  assert.deepEqual([removed.length, removed[0].op, removed[0].target.text], [1, 'remove', '- `status` filtresi `done` değerini kabul eder.']);

  const first = plan(UA, edit(UA, '## Що потрібно знати {/* #what-to-know */}\n\n', '## Що потрібно знати {/* #what-to-know */}\n\nНовий вступ.\n\nЩе один вступ.\n\n'), TR).changes;
  assert.equal(first.length, 1, 'two adjacent new paragraphs are one group');
  assert.equal(first[0].insertAfter.text, '## Bilmeniz gerekenler {/* #what-to-know */}');

  const section = plan(UA, UA + '\n## Нова частина {/* #new-part */}\n\nТекст.\n', TR).changes;
  assert.deepEqual([section[0].op, section[0].kind], ['add', 'section']);
  assert.ok(section[0].insertAfter.text.startsWith('## Referans bilgi') && section[0].insertAfter.text.endsWith('dialog.png)'), 'inserted after the whole previous section');

  const both = plan(UA, edit(UA, 'Ви також можете скинути фільтри.\n', 'Ви також можете скинути фільтри.\n\nДодатковий абзац.\n\n#### Підрозділ {/* #sub */}\n\nТекст.\n'), TR).changes;
  assert.deepEqual(both.map((c) => c.kind), ['paragraph', 'section']);
  assert.equal(both[1].insertAfterChange, both[0].id);
});

test('blocks: formatting-only and last_update-only changes are no-ops', () => {
  assert.equal(plan(UA, UA.replace('Ця сторінка описує [фільтри](/filters/).', 'Ця сторінка описує [фільтри](/filters/).   ').replace('\n\n## Операції', '\n\n\n## Операції'), TR).changes.length, 0);
  assert.equal(plan(UA, edit(UA, 'date: 9/8/2026', 'date: 10/1/2026'), TR).changes.length, 0);
});

test('blocks: a translation that no longer mirrors UA is reported, not guessed', () => {
  const brokenTr = edit(TR, '- `status` filtresi `done` değerini kabul eder.\n', '');
  const b = edit(UA, '- Дії доступні', '- Усі дії доступні');
  const { changes, unmapped } = plan(UA, b, brokenTr);
  assert.equal(changes.length, 0);
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0].reason, /UA has \[item, item, item\] but the translation has \[item, item\]/);
  assert.ok(unmapped[0].ua.text.includes('Усі дії доступні'));
});

test('blocks: import and plain code blocks are verbatim, mermaid is not', () => {
  const imp = plan(UA, edit(UA, "import Tabs from '@theme/Tabs';", "import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';"), TR).changes[0];
  assert.equal(imp.verbatim, true);
  const mer = plan(UA, edit(UA, '-->|Завершити|', '-->|Закрити|'), TR).changes[0];
  assert.deepEqual([mer.kind, mer.verbatim], ['code', false]);
});

// ------------------------------------------------------------------ small helpers

test('setLastUpdate changes only the target date, in the UA date format', () => {
  assert.ok(setLastUpdate(TR, '10/9/2026').includes('last_update:\n  date: 10/9/2026\n---'));
  assert.ok(setLastUpdate('---\ntitle: A\n---\n\nx\n', '2026-10-09').includes('title: A\nlast_update:\n  date: 2026-10-09\n---'));
  assert.ok(setLastUpdate('---\nlast_update: { date: 1/1/2026, author: x }\n---\n', '2/2/2026').includes('last_update: { date: 2/2/2026, author: x }'));
});

test('docRoute follows the Docusaurus conventions', () => {
  const s = { urlPrefix: '/' };
  assert.equal(docRoute(s, { id: 'archive/archive' }, ''), '/archive/');
  assert.equal(docRoute(s, { id: 'archive/filter/filter' }, ''), '/archive/filter/');
  assert.equal(docRoute(s, { id: 'archive/export' }, ''), '/archive/export/');
  assert.equal(docRoute(s, { id: '01-intro/02-start' }, ''), '/intro/start/');
  assert.equal(docRoute({ urlPrefix: '/partner-cabinet/' }, { id: 'a/a' }, ''), '/partner-cabinet/a/');
  assert.equal(docRoute(s, { id: 'a/b' }, '---\nslug: /custom/path\n---\n'), '/custom/path/');
});

test('build log parsing finds unresolved images and broken links per page', () => {
  const s = { root: '/r', en: 'i18n/en/docusaurus-plugin-content-docs/current' };
  const log = `Module not found: Error: Can't resolve './.assets/a.png' in '/r/i18n/tr/docusaurus-plugin-content-docs/current/disputes'\nException in thread: Docusaurus found broken links!\n- On source page path = /disputes/:\n   -> linking to /nope (resolved as: /nope)\n`;
  const errors = parseBuildErrors(s, 'tr', log);
  assert.deepEqual(errors[0], { kind: 'unresolved', ref: './.assets/a.png', folder: 'disputes', message: "Can't resolve './.assets/a.png'" });
  assert.deepEqual([errors[1].kind, errors[1].route], ['broken-link', '/disputes/']);
});

// ------------------------------------------------------------------ fixture repo (CLI tests)

// A category as the real repos write it (with a key and a generated index), and the tr current.json that write-translations
// produced for it: other entries in the file must survive, and the messages start out as the UA text.
const CATEGORY = { label: 'Фільтри', position: 2, key: 'filters', link: { type: 'generated-index', description: 'Перегляньте фільтри.' } };
const ENTRY_LABEL = 'sidebar.tutorialSidebar.category.filters';
const ENTRY_DESC = 'sidebar.tutorialSidebar.category.filters.link.generated-index.description';
const TR_CURRENT = {
  'version.label': { message: 'Sonraki', description: 'The label for version current' },
  [ENTRY_LABEL]: { message: 'Фільтри', description: "The label for category 'Фільтри' in sidebar 'tutorialSidebar'" },
  [ENTRY_DESC]: { message: 'Перегляньте фільтри.', description: "The generated-index page description for category 'Фільтри' in sidebar 'tutorialSidebar'" },
};
const CAT_ID = 'filters/_category_';
const EN_ROOT = 'i18n/en/docusaurus-plugin-content-docs/current';
const TR_ROOT = 'i18n/tr/docusaurus-plugin-content-docs/current';
const LABELS = {
  uk: { 'status.inwork': 'В роботі', 'filters.title': 'Фільтри', 'filters.status': 'Статус', 'filters.apply': 'Застосувати' },
  en: { 'status.inwork': 'In progress', 'filters.title': 'Filters', 'filters.status': 'Status', 'filters.apply': 'Apply' },
  tr: { 'status.inwork': 'İşlemde', 'filters.title': 'Filtreler', 'filters.status': 'Durum', 'filters.apply': 'Uygula' },
  ru: { 'status.inwork': 'В работе', 'filters.title': 'Фильтры', 'filters.status': 'Статус', 'filters.apply': 'Применить' },
};
const SPANS = { 'В роботі': 'label:status.inwork', Фільтри: 'label:filters.title', Статус: 'label:filters.status', Застосувати: 'label:filters.apply', 'Результат:': 'emphasis' };

async function fixtureRepo({ extraPages = 0, config = true, category = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'locale-sync-test-'));
  const write = async (rel, content, mode) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + '\n', mode);
  };
  await write('CLAUDE.md', `# Project\n\n## Documentation toolkit configuration\n\n- **UA content root:** \`docs/\`\n- **EN i18n root:** \`${EN_ROOT}/\`\n- **UA URL prefix:** \`/\`\n\n## Other\n`);
  if (config) await write('docusaurus.config.ts', `export default { baseUrl: '/', i18n: { defaultLocale: 'uk', locales: ['uk', 'en', 'tr', 'ru'] } };\n`);
  await write('docs/filters/filters.md', UA);
  await write('docs/filters/.assets/panel.png', 'png-ua-panel');
  await write('docs/filters/.assets/dialog.png', 'png-ua-dialog');
  await write(`${EN_ROOT}/filters/filters.md`, '# Filters\n');
  await write(`${EN_ROOT}/filters/.assets/panel.png`, 'png-en-panel');
  await write(`${EN_ROOT}/filters/.assets/dialog.png`, 'png-en-dialog');
  for (let i = 0; i < extraPages; i++) await write(`docs/extra/p${i}/p${i}.md`, `---\ntitle: Сторінка ${i}\n---\n\nТекст ${i}.\n`);
  if (category) {
    await write('docs/filters/_category_.json', CATEGORY);
    await write(`${TR_ROOT}.json`, TR_CURRENT);
  }
  await write('docs/.sources/notes.md', '# input, not a page\n');
  await write('docs/_partial.md', '# partial\n');
  const labels = '.doc-toolkit/ui-labels';
  await write(`${labels}/meta.json`, { source: { type: 'command' }, commit: 'content:abc1234', locales: ['uk', 'en', 'tr', 'ru'], missing: {} });
  for (const [l, m] of Object.entries(LABELS)) await write(`${labels}/${l}.json`, m);
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t');
  await git(dir, 'config', 'user.name', 't');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return { dir, write, read: (rel) => fs.readFile(path.join(dir, rel), 'utf8'), commit: async (msg = 'edit') => { await git(dir, 'add', '-A'); await git(dir, 'commit', '-qm', msg); } };
}

const uaBlob = (text = UA) => gitBlobHash(text);
const writeState = (f, locales = {}, spans = SPANS) => f.write('.doc-toolkit/pages/filters/filters.json', { spans, locales });
const trEntry = (blob, extra = {}) => ({ sourceBlob: blob, labelSnapshot: 'content:abc1234', translatedAt: '2026-10-01', unverified: [], assetFallbacks: [], ...extra });

test('status: bootstrap, current, stale, skipped, overwrite, scope and the 10-page confirmation', async () => {
  const f = await fixtureRepo();
  let r = await cli(f.dir, 'status');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.locales, ['tr', 'ru']);
  assert.equal(r.out.pages.length, 1, '.sources and _partial pages are not in scope');
  assert.deepEqual(r.out.pages[0].locales.tr, { state: 'new', reason: 'bootstrap', base: null, mode: 'full', file: `${TR_ROOT}/filters/filters.md`, targetExists: false, words: r.out.pages[0].locales.tr.words, changedBlocks: null });
  assert.equal(r.out.summary.bootstrap, true);
  assert.equal(r.out.summary.pageTranslations, 2);
  assert.equal(r.out.summary.needsConfirmation, false);
  assert.match(r.out.summary.message, /^1 pages × 2 languages = 2 page translations, about \d+ words$/);

  // Translated and recorded for tr: current. ru has no state and no file: new.
  await f.write(`${TR_ROOT}/filters/filters.md`, TR);
  await writeState(f, { tr: trEntry(uaBlob()) });
  r = await cli(f.dir, 'status');
  assert.deepEqual([r.out.pages[0].locales.tr.state, r.out.pages[0].locales.ru.state, r.out.summary.bootstrap], ['current', 'new', false]);

  // A hand-made ru file with no state is a manual bootstrap: skipped, unless --overwrite.
  await f.write('i18n/ru/docusaurus-plugin-content-docs/current/filters/filters.md', '# Фильтры\n');
  r = await cli(f.dir, 'status');
  assert.deepEqual([r.out.pages[0].locales.ru.state, r.out.pages[0].locales.ru.reason], ['skipped', 'manual-bootstrap']);
  r = await cli(f.dir, 'status', '--overwrite');
  assert.deepEqual([r.out.pages[0].locales.ru.state, r.out.pages[0].locales.ru.reason], ['new', 'overwrite']);

  // UA changes and is committed: tr is stale from the recorded blob, with an estimate of the changed words only.
  const ua2 = edit(UA, '- Дії доступні', '- Усі дії доступні');
  await f.write('docs/filters/filters.md', ua2);
  r = await cli(f.dir, 'status');
  assert.match(r.stderr, /Uncommitted UA change in docs\/filters\/filters\.md/);
  assert.equal(r.out.pages[0].locales.tr.state, 'current', 'uncommitted UA text is ignored');
  await f.commit();
  r = await cli(f.dir, 'status', '--locales', 'tr');
  const cell = r.out.pages[0].locales.tr;
  assert.deepEqual([cell.state, cell.reason, cell.base, cell.mode, cell.changedBlocks], ['stale', 'source-changed', uaBlob(), 'incremental', 1]);
  assert.ok(cell.words > 0 && cell.words < 10);

  // The recorded blob is gone from the repository: the page is re-translated in full, with a warning.
  await writeState(f, { tr: trEntry('1'.repeat(40)) });
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual([r.out.pages[0].locales.tr.reason, r.out.pages[0].locales.tr.mode], ['base-missing', 'full']);
  assert.ok(r.out.warnings.some((w) => w.includes('not in this repository')));

  // The translation file was deleted after it was recorded.
  await writeState(f, { tr: trEntry(uaBlob(ua2)) });
  await fs.rm(path.join(f.dir, TR_ROOT, 'filters/filters.md'));
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual([r.out.pages[0].locales.tr.state, r.out.pages[0].locales.tr.reason], ['stale', 'target-missing']);

  // Narrowing: unknown locale and unknown page are input errors.
  assert.equal((await cli(f.dir, 'status', '--locales', 'xx')).code, 2);
  assert.equal((await cli(f.dir, 'status', 'nothing/here')).code, 2);
  assert.equal((await cli(f.dir, 'status', 'filters')).code, 0);
});

test('status: the confirmation threshold, Translation scope, orphaned and moved pages', async () => {
  const f = await fixtureRepo({ extraPages: 10 });
  let r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.equal(r.out.summary.stalePages, 11);
  assert.equal(r.out.summary.needsConfirmation, true);
  assert.equal((await cli(f.dir, 'status', '--locales', 'tr', '--scope', 'extra/p1,extra/p2')).out.summary.stalePages, 2);
  assert.equal((await cli(f.dir, 'status', '--locales', 'tr', '--threshold', '11')).out.summary.needsConfirmation, false);
  assert.equal((await cli(f.dir, 'status', '--locales', 'tr', 'docs/extra')).out.summary.stalePages, 10);

  // A page recorded earlier and deleted in UA is orphaned; the same page under a new path is "moved".
  await f.write('.doc-toolkit/pages/gone/gone.json', { spans: {}, locales: { tr: trEntry('2'.repeat(40)) } });
  await f.write(`${TR_ROOT}/lost/lost.md`, '# Kayıp\n');
  const moved = await f.read('docs/extra/p3/p3.md');
  await f.write('.doc-toolkit/pages/old/place.json', { spans: {}, locales: { tr: trEntry(uaBlob(moved)) } });
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual(r.out.orphaned.map((o) => o.page).sort(), ['gone/gone', 'lost/lost']);
  assert.deepEqual(r.out.moved.map((m) => [m.from, m.to]), [['old/place', 'extra/p3/p3']]);
});

test('status: Translation scope declared in CLAUDE.md narrows the run', async () => {
  const f = await fixtureRepo({ extraPages: 3 });
  await f.write('CLAUDE.md', (await f.read('CLAUDE.md')).replace('- **UA URL prefix:**', '- **Translation scope:** `extra/p0, extra/p2`\n- **UA URL prefix:**'));
  const r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual(r.out.pages.map((p) => p.page), ['extra/p0/p0', 'extra/p2/p2']);
});

test('blocks: full for a new page, incremental with exact target text, none when current, no-op for formatting', async () => {
  const f = await fixtureRepo();
  assert.equal((await cli(f.dir, 'blocks')).code, 2, 'a page is required');

  let r = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  assert.deepEqual([r.mode, r.fullReason, r.overwrites, r.ua.text === UA, r.bold], ['full', 'bootstrap', false, true, ['В роботі', 'Фільтри', 'Статус', 'Застосувати', 'Результат:']]);

  await f.write(`${TR_ROOT}/filters/filters.md`, TR);
  await writeState(f, { tr: trEntry(uaBlob()) });
  r = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  assert.deepEqual([r.mode, r.changes], ['none', []]);

  const ua2 = edit(UA, '- Дії доступні лише в статусі **В роботі**.', '- Дії доступні лише для записів у статусі **В роботі**.');
  await f.write('docs/filters/filters.md', ua2);
  await f.commit();
  r = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--with-old')).out.results[0];
  assert.deepEqual([r.mode, r.source, r.noop, r.summary], ['incremental', { kind: 'blob-diff', from: uaBlob(), to: uaBlob(ua2) }, false, { replace: 1, add: 0, remove: 0, unmapped: 0, words: r.summary.words }]);
  assert.deepEqual([r.changes[0].target.text, r.changes[0].uaOld.text, r.changes[0].ua.text], ['- Eylemler yalnızca **İşlemde** durumunda kullanılabilir.', '- Дії доступні лише в статусі **В роботі**.', '- Дії доступні лише для записів у статусі **В роботі**.']);

  // Only formatting changed in UA: the page is stale (new blob) but there is nothing to translate.
  await f.write('docs/filters/filters.md', ua2.replace('Ця сторінка описує [фільтри](/filters/).', 'Ця сторінка описує [фільтри](/filters/).  '));
  await f.commit();
  await writeState(f, { tr: trEntry(uaBlob(ua2)) });
  r = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  assert.deepEqual([r.mode, r.noop, r.changes.length], ['incremental', true, 0]);
});

test('large JSON output is not truncated when stdout is a pipe', async () => {
  // process.exit() right after a big write to a pipe cuts the output off (the pipe buffer is 64 KB).
  const f = await fixtureRepo({ extraPages: 150 });
  const r = await cli(f.dir, 'status', '--locales', 'tr,ru');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(typeof r.out === 'object', 'stdout is complete, parseable JSON');
  assert.equal(r.out.pages.length, 151);
  assert.ok(JSON.stringify(r.out, null, 2).length > 70_000, 'big enough to exceed the 64 KB pipe buffer');
});

test('status: without target locales in docusaurus.config.ts and no --locales it stops with exit 2', async () => {
  const f = await fixtureRepo({ config: false });
  await f.write('docusaurus.config.ts', `export default { i18n: { defaultLocale: 'uk', locales: ['uk', 'en'] } };\n`);
  const r = await cli(f.dir, 'status');
  assert.equal(r.code, 2);
  assert.match(r.out.error, /No target locales are configured yet/);
});

test('link-assets: relative per-file symlinks to EN, UA fallback, override, repoint, orphan, dry-run', async () => {
  const f = await fixtureRepo();
  const link = (name) => path.join(f.dir, TR_ROOT, 'filters/.assets', name);

  let r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr', '--dry-run');
  assert.deepEqual(r.out.results[0].links.map((l) => l.status), ['would-create', 'would-create']);
  await assert.rejects(fs.lstat(link('panel.png')));

  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.results[0].links.map((l) => [l.asset, l.status, l.fallback]), [['filters/.assets/panel.png', 'created', false], ['filters/.assets/dialog.png', 'created', false]]);
  assert.equal(await fs.readlink(link('panel.png')), `../../../../../en/docusaurus-plugin-content-docs/current/filters/.assets/panel.png`);
  assert.equal(await fs.readFile(link('panel.png'), 'utf8'), 'png-en-panel');

  // Idempotent.
  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.deepEqual(r.out.results[0].links.map((l) => l.status), ['unchanged', 'unchanged']);

  // A real file is a locale override and is never replaced.
  await fs.rm(link('dialog.png'));
  await f.write(`${TR_ROOT}/filters/.assets/dialog.png`, 'png-tr-own');
  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.equal(r.out.results[0].links[1].status, 'override');
  assert.equal(await fs.readFile(link('dialog.png'), 'utf8'), 'png-tr-own');

  // No EN asset yet: the link falls back to UA and says so; once EN has it, the next run repoints it.
  await fs.rm(link('panel.png'));
  await fs.rm(path.join(f.dir, EN_ROOT, 'filters/.assets/panel.png'));
  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.deepEqual([r.out.results[0].links[0].status, r.out.results[0].links[0].fallback, r.out.results[0].assetFallbacks], ['created', true, ['filters/.assets/panel.png']]);
  assert.equal(await fs.readFile(link('panel.png'), 'utf8'), 'png-ua-panel');
  await f.write(`${EN_ROOT}/filters/.assets/panel.png`, 'png-en-panel');
  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.deepEqual([r.out.results[0].links[0].status, r.out.results[0].assetFallbacks], ['repointed', []]);
  assert.equal(await fs.readFile(link('panel.png'), 'utf8'), 'png-en-panel');

  // A symlink the page no longer references is reported, never deleted.
  await fs.symlink('../../../../../en/docusaurus-plugin-content-docs/current/filters/.assets/panel.png', link('old.png'));
  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.deepEqual(r.out.results[0].orphans.map((o) => o.asset), ['filters/.assets/old.png']);
  await fs.lstat(link('old.png'));

  // An asset that exists nowhere is a problem (exit 1).
  await fs.rm(path.join(f.dir, EN_ROOT, 'filters/.assets/panel.png'));
  await fs.rm(path.join(f.dir, 'docs/filters/.assets/panel.png'));
  await fs.rm(link('panel.png'));
  r = await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.equal(r.code, 1);
  assert.equal(r.out.problems[0].status, 'missing');
});

async function translatedFixture() {
  const f = await fixtureRepo();
  await f.write(`${TR_ROOT}/filters/filters.md`, TR);
  await writeState(f);
  assert.equal((await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr')).code, 0);
  return f;
}
const checks = async (f, mutate, locale = 'tr') => {
  await f.write(`${locale === 'tr' ? TR_ROOT : `i18n/${locale}/docusaurus-plugin-content-docs/current`}/filters/filters.md`, mutate(TR));
  const r = await cli(f.dir, 'check', 'filters', '--locales', locale);
  return { code: r.code, checks: r.out.results?.[0]?.checks, failures: r.out.results?.[0]?.failures };
};

test('check: a faithful translation passes every check', async () => {
  const f = await translatedFixture();
  const r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0, JSON.stringify(r.out.results[0].failures, null, 2));
  assert.deepEqual(r.out.results[0].checks, []);
});

test('check: each Requirement 8 failure is caught by its own check', async () => {
  const f = await translatedFixture();
  const cases = [
    ['headings: a heading is missing', (t) => edit(t, '### Ek işlemler {/* #extra */}\n\nFiltreleri sıfırlayabilirsiniz.\n\n', ''), 'headings'],
    ['headings: the anchor comment changed', (t) => edit(t, '{/* #operations */}', '{/* #islemler */}'), 'headings'],
    ['headings: the level changed', (t) => edit(t, '### Ek işlemler', '#### Ek işlemler'), 'headings'],
    ['counts: a list item is gone', (t) => edit(t, '- `status` filtresi `done` değerini kabul eder.\n', ''), 'counts'],
    ['counts: a table row is gone', (t) => edit(t, '| Tarih | Oluşturulma tarihi. |\n', ''), 'counts'],
    ['structure: one paragraph split in two', (t) => edit(t, 'Filtreleri sıfırlayabilirsiniz.', 'Filtreleri\n\nsıfırlayabilirsiniz.'), 'structure'],
    ['code: a code block changed', (t) => edit(t, '-->|Tamamla| done', '-->|Tamamla| finished'), 'code'],
    ['inline code changed', (t) => edit(t, '`done`', '`bitti`'), 'inline-code'],
    ['inline code removed', (t) => edit(t, '`status` filtresi', 'status filtresi'), 'inline-code'],
    ['links: a URL changed', (t) => edit(t, '(/overview/)', '(/genel-bakis/)'), 'links'],
    ['images: an image path changed', (t) => edit(t, '![Filtre penceresi](./.assets/dialog.png)', '![Filtre penceresi](./.assets/pencere.png)'), 'images'],
    ['tags: a component attribute changed', (t) => edit(t, 'titleAs="h3"', 'titleAs="h4"'), 'tags'],
    ['tags: a prose attribute value may change', (t) => edit(t, 'title="Kayıtları filtreleme"', 'title="Filtreleme"'), null],
    ['markers: a ToDo marker is missing', (t) => edit(t, '{/* ToDo: metni netleştirin */}\n\n', ''), 'markers'],
    ['frontmatter: title not translated', (t) => edit(t, 'title: Filtreler', 'title: Фільтри'), 'frontmatter'],
    ['frontmatter: a key is missing', (t) => edit(t, 'sidebar_position: 2\n', ''), 'frontmatter'],
    ['frontmatter: sidebar_position changed', (t) => edit(t, 'sidebar_position: 2', 'sidebar_position: 5'), 'frontmatter'],
    ['labels: the UI label is not the app string', (t) => edit(t, '**Uygula**', '**Onayla**'), 'labels'],
    ['labels: the label lost its bold', (t) => edit(t, '**İşlemde**', 'İşlemde'), 'labels'],
    ['ukrainian letters: untranslated text remains', (t) => edit(t, 'Filtreleri sıfırlayabilirsiniz.', 'Ви також можете скинути фільтри, це є так.'), 'ukrainian-letters'],
    ['mermaid: a node id changed', (t) => edit(t, 'work["İşlemde"]', 'busy["İşlemde"]'), 'code'],
  ];
  for (const [name, mutate, expected] of cases) {
    const r = await checks(f, mutate);
    if (expected === null) {
      assert.equal(r.code, 0, `${name} is an allowed edit`);
      continue;
    }
    assert.equal(r.code, 1, name);
    assert.ok(r.checks.includes(expected), `${name}: expected '${expected}' in ${JSON.stringify(r.checks)}`);
  }
});

test('check: inline code that holds Cyrillic UI text is translatable; the Ukrainian language name keeps its letters; Cyrillic left on a Latin page is a warning', async () => {
  const f = await fixtureRepo();
  await writeState(f);
  const ua = edit(UA, 'Ви також можете', 'Ви також можете').replace('Ви також можете скинути фільтри.', 'Ви також можете скинути фільтри. Час: `Часовий пояс: Europe/Kyiv`. Мови: Українська.');
  await f.write('docs/filters/filters.md', ua);
  await f.commit();
  await f.write(`${TR_ROOT}/filters/filters.md`, edit(TR, 'Filtreleri sıfırlayabilirsiniz.', 'Filtreleri sıfırlayabilirsiniz. Saat: `Saat dilimi: Europe/Kyiv`. Diller: Українська.'));
  assert.equal((await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr')).code, 0);
  let r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0, JSON.stringify(r.out.results[0].failures));
  assert.match(r.out.results[0].warnings.join('\n'), /Cyrillic text remains in a translation written in Latin letters/);

  await f.write(`${TR_ROOT}/filters/filters.md`, edit(TR, '["Tamamlandı"]', '["Завершений"]'));
  r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0);
  assert.match(r.out.results[0].warnings.join('\n'), /Cyrillic text remains/, 'a leftover mermaid label is reported');
});

test('check: a title equal to the UA one passes only when it is a term-memory or app string of the locale', async () => {
  const f = await translatedFixture();
  const loan = (t) => edit(t, 'title: Filtreler', 'title: Фільтри');
  let r = await checks(f, loan);
  assert.ok(r.checks.includes('frontmatter'), 'an untranslated title still fails');
  await f.write('.doc-toolkit/terms/tr.tsv', 'фільтри\tФільтри\n');
  r = await checks(f, loan);
  assert.ok(!r.checks.includes('frontmatter'), 'the term memory has it');
});

test('check: a dangling asset symlink fails; the translation missing fails', async () => {
  const f = await translatedFixture();
  await fs.rm(path.join(f.dir, EN_ROOT, 'filters/.assets/dialog.png'));
  let r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.results[0].checks, ['assets']);
  assert.equal(r.out.results[0].failures[0].broken[0].problem, 'dangling symlink');
  r = await cli(f.dir, 'check', 'filters', '--locales', 'ru');
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.results[0].checks, ['target-missing']);
});

test('check: a label missing for the locale needs an unverified entry; ru and tg also reject Ukrainian і', async () => {
  const f = await translatedFixture();
  await f.write('.doc-toolkit/ui-labels/tr.json', { ...LABELS.tr, 'filters.apply': undefined });
  let r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.deepEqual(r.out.results[0].checks, ['labels']);
  assert.match(r.out.results[0].failures[0].labels[0].problem, /recorded as unverified/);
  await f.write('unverified.json', ['Застосувати']);
  r = await cli(f.dir, 'check', 'filters', '--locales', 'tr', '--unverified-file', 'unverified.json');
  assert.equal(r.code, 0, JSON.stringify(r.out.results[0].failures));

  const ruFile = 'i18n/ru/docusaurus-plugin-content-docs/current/filters/filters.md';
  await f.write(ruFile, RU);
  assert.equal((await cli(f.dir, 'link-assets', 'filters', '--locales', 'ru')).code, 0);
  r = await cli(f.dir, 'check', 'filters', '--locales', 'ru');
  assert.equal(r.code, 0, JSON.stringify(r.out.results[0].failures));
  await f.write(ruFile, edit(RU, 'Вы также можете сбросить фильтры.', 'Ви також можете скинути фільтри.'));
  r = await cli(f.dir, 'check', 'filters', '--locales', 'ru');
  assert.deepEqual(r.out.results[0].checks, ['ukrainian-letters']);
  assert.equal(r.out.results[0].failures[0].hits[0].letters, 'і');
});

test('check: a label may drop the trailing punctuation of the app string when the UA page drops it', async () => {
  const f = await translatedFixture();
  const store = (uk, tr) => Promise.all([f.write('.doc-toolkit/ui-labels/uk.json', { ...LABELS.uk, 'filters.status': uk }), f.write('.doc-toolkit/ui-labels/tr.json', { ...LABELS.tr, 'filters.status': tr })]);

  // The app shows `Статус:` / `Durum:`, the UA page **Статус**: the translation may mirror it (**Durum**) or keep the colon.
  await store('Статус:', 'Durum:');
  let r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0, JSON.stringify(r.out.results[0].failures));
  r = await checks(f, (t) => edit(t, '**Durum**', '**Durum:**'));
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  r = await checks(f, (t) => edit(t, '**Durum**', '**Dur**'));
  assert.deepEqual(r.checks, ['labels'], 'only the trailing punctuation may go');

  // The UA page shows the app string as it is, so the translation must too.
  await store('Статус', 'Durum:');
  r = await checks(f, (t) => t);
  assert.deepEqual(r.checks, ['labels']);
  assert.equal(r.failures[0].labels[0].expected, '**Durum:**');
});

test('record: refuses and changes nothing when a check fails', async () => {
  const f = await translatedFixture();
  await f.write(`${TR_ROOT}/filters/filters.md`, edit(TR, '**Uygula**', '**Onayla**'));
  const r = await cli(f.dir, 'record', 'filters', '--locales', 'tr');
  assert.equal(r.code, 1);
  assert.equal(r.out.results[0].recorded, false);
  assert.deepEqual(r.out.results[0].failures.map((x) => x.check), ['labels']);
  assert.deepEqual(JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json')).locales, {});
});

test('record: advances the state, sets last_update in the translation only, keeps spans', async () => {
  const f = await translatedFixture();
  const r = await cli(f.dir, 'record', 'filters', '--locales', 'tr', '--date', '2026-10-09');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const state = JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json'));
  assert.deepEqual(state.spans, SPANS);
  assert.deepEqual(state.locales.tr, { sourceBlob: uaBlob(), labelSnapshot: 'content:abc1234', translatedAt: '2026-10-09', unverified: [], assetFallbacks: [] });
  assert.ok((await f.read(`${TR_ROOT}/filters/filters.md`)).includes('last_update:\n  date: 10/9/2026\n'));
  assert.equal(await f.read('docs/filters/filters.md'), UA, 'the UA page is never modified');
  assert.equal((await cli(f.dir, 'status', '--locales', 'tr')).out.pages[0].locales.tr.state, 'current');
});

test('record --candidate installs a passing candidate and rejects a failing one without writing', async () => {
  const f = await fixtureRepo();
  await writeState(f);
  await f.write('cand.md', edit(TR, '**Uygula**', '**Onayla**'));
  assert.equal((await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr')).code, 0);
  let r = await cli(f.dir, 'record', 'filters', '--locales', 'tr', '--candidate', 'cand.md');
  assert.equal(r.code, 1);
  await assert.rejects(fs.stat(path.join(f.dir, TR_ROOT, 'filters/filters.md')), 'a failing candidate is not written');
  assert.deepEqual(JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json')).locales, {});

  await f.write('cand.md', TR);
  r = await cli(f.dir, 'record', 'filters', '--locales', 'tr', '--candidate', 'cand.md', '--date', '2026-10-09');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.ok((await f.read(`${TR_ROOT}/filters/filters.md`)).includes('date: 10/9/2026'));
  assert.equal(JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json')).locales.tr.sourceBlob, uaBlob());
  assert.equal((await cli(f.dir, 'record', 'filters', '--candidate', 'cand.md')).code, 2, '--candidate needs one locale');
});

test('record: unverified entries are merged, kept while they apply and pruned when they verify or leave the page', async () => {
  const f = await translatedFixture();
  await f.write('.doc-toolkit/ui-labels/tr.json', { ...LABELS.tr, 'filters.apply': undefined });
  await f.write('unv.json', [{ span: 'Застосувати', reason: 'no tr string' }]);
  let r = await cli(f.dir, 'record', 'filters', '--locales', 'tr', '--unverified-file', 'unv.json');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json')).locales.tr.unverified, [{ span: 'Застосувати', reason: 'no tr string' }]);
  // The app gains the string and the translation uses it: the entry verifies and drops out.
  await f.write('.doc-toolkit/ui-labels/tr.json', LABELS.tr);
  r = await cli(f.dir, 'record', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json')).locales.tr.unverified, []);
});

test('record: asset fallbacks to the UA tree are recorded', async () => {
  const f = await fixtureRepo();
  await writeState(f);
  await fs.rm(path.join(f.dir, EN_ROOT, 'filters/.assets/panel.png'));
  await f.write(`${TR_ROOT}/filters/filters.md`, TR);
  await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr');
  assert.equal((await cli(f.dir, 'record', 'filters', '--locales', 'tr')).code, 0);
  assert.deepEqual(JSON.parse(await f.read('.doc-toolkit/pages/filters/filters.json')).locales.tr.assetFallbacks, ['filters/.assets/panel.png']);
});

test('report: ✓/✗ per page and locale, local URLs for the changed pages', async () => {
  const f = await translatedFixture();
  let r = await cli(f.dir, 'report', 'filters');
  assert.equal(r.code, 1, 'ru is missing');
  const row = r.out.pages[0];
  assert.deepEqual([row.cells.tr.exists, row.cells.tr.imagesResolve, row.cells.tr.checksPassed], [true, true, true]);
  assert.deepEqual([row.cells.ru.exists, row.cells.ru.checksPassed], [false, false]);
  assert.equal(row.cells.tr.url, 'http://localhost:3000/tr/filters/');
  assert.equal(r.out.failing, 1);

  await fs.rm(path.join(f.dir, EN_ROOT, 'filters/.assets/dialog.png'));
  r = await cli(f.dir, 'report', '--md', '--locales', 'tr');
  assert.match(r.out, /### Page exists[\s\S]*\| filters\/filters \| ✓ \|/);
  assert.match(r.out, /### All images resolve[\s\S]*\| filters\/filters \| ✗ \|/);
  assert.match(r.out, /- filters\/filters \[tr\]: assets/);
  assert.match(r.out, /\*\*tr\*\*\n\n- http:\/\/localhost:3000\/tr\/filters\//);
});

test('report --build runs the locale build and reports its result', async () => {
  const f = await translatedFixture();
  await f.write('build-stub.js', "console.log('built', process.argv.slice(2).join(' '));\nprocess.exit(process.argv.slice(2).join(' ') === '--locale tr' ? 0 : 1);\n");
  await f.write('package.json', { scripts: { build: 'node build-stub.js' } });
  const r = await cli(f.dir, 'report', 'filters', '--build', '--locales', 'tr');
  assert.equal(r.out.build.tr.ok, true);
  assert.equal(r.out.build.ru, undefined, 'only locales with changed, existing pages are built');
});

// ------------------------------------------------------------------ sidebar category files

const catStatePath = '.doc-toolkit/pages/filters/_category_.json';
const writeCatState = (f, locales = {}) => f.write(catStatePath, { spans: SPANS, locales });
const catCand = (f, map) => f.write('cat.json', map);
const GOOD_CAT = { [ENTRY_LABEL]: 'Filtreler', [ENTRY_DESC]: 'Filtreleri görüntüleyin.' };

test('categories: status tracks _category_.json next to pages, translated into current.json', async () => {
  const f = await fixtureRepo({ category: true });
  let r = await cli(f.dir, 'status');
  assert.equal(r.code, 0, r.stderr);
  const row = r.out.pages.find((p) => p.kind === 'category');
  assert.equal(row.page, CAT_ID);
  // tr: write-translations has run and nothing is translated yet; ru: no current.json at all.
  assert.deepEqual([row.locales.tr.state, row.locales.tr.reason, row.locales.tr.mode, row.locales.tr.file, row.locales.tr.base], ['new', 'bootstrap', 'full', `${TR_ROOT}.json`, null]);
  assert.deepEqual([row.locales.ru.state, row.locales.ru.targetExists], ['new', false]);
  assert.deepEqual([r.out.summary.pages, r.out.summary.pageTranslations, r.out.summary.categories.total, r.out.summary.categories.translations], [1, 2, 1, 2]);
  assert.match(r.out.summary.message, /^1 pages × 2 languages = 2 page translations, plus 2 sidebar category translations, about \d+ words$/);
  assert.equal(r.out.summary.needsConfirmation, false);

  // A category never counts toward the 10-page confirmation, and a folder selector reaches it.
  assert.deepEqual((await cli(f.dir, 'status', 'filters/_category_', '--locales', 'tr')).out.pages.map((p) => p.kind), ['category']);

  // Messages already translated by hand, no state: a manual bootstrap, skipped unless --overwrite.
  await f.write(`${TR_ROOT}.json`, { ...TR_CURRENT, [ENTRY_LABEL]: { ...TR_CURRENT[ENTRY_LABEL], message: 'Filtreler' } });
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual([r.out.pages.find((p) => p.kind === 'category').locales.tr.state, r.out.summary.categories.skipped], ['skipped', 1]);
  r = await cli(f.dir, 'status', '--locales', 'tr', '--overwrite');
  assert.deepEqual([r.out.pages.find((p) => p.kind === 'category').locales.tr.state, r.out.pages.find((p) => p.kind === 'category').locales.tr.reason], ['new', 'overwrite']);

  // Recorded: current. The UA category changes and is committed: stale, translated whole (no base, no incremental mode).
  await writeCatState(f, { tr: trEntry(uaBlob(JSON.stringify(CATEGORY, null, 2) + '\n')) });
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.equal(r.out.pages.find((p) => p.kind === 'category').locales.tr.state, 'current');
  await f.write('docs/filters/_category_.json', { ...CATEGORY, link: { ...CATEGORY.link, description: 'Усі фільтри.' } });
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.match(r.stderr, /Uncommitted UA change in docs\/filters\/_category_\.json/);
  await f.commit();
  r = await cli(f.dir, 'status', '--locales', 'tr');
  const cell = r.out.pages.find((p) => p.kind === 'category').locales.tr;
  assert.deepEqual([cell.state, cell.reason, cell.mode, cell.base], ['stale', 'source-changed', 'full', null]);

  // The entries are gone from current.json (key renamed, write-translations not re-run): stale, target missing.
  await f.write(`${TR_ROOT}.json`, { 'version.label': TR_CURRENT['version.label'] });
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual([r.out.pages.find((p) => p.kind === 'category').locales.tr.state, r.out.pages.find((p) => p.kind === 'category').locales.tr.reason], ['stale', 'target-missing']);
});

test('categories: orphaned states, YAML category files, files without a label, .sources are left alone', async () => {
  const f = await fixtureRepo({ category: true });
  await f.write('.doc-toolkit/pages/old/_category_.json', { spans: {}, locales: { tr: trEntry(uaBlob('x')) } });
  await f.write('docs/yaml-section/_category_.yml', 'label: Розділ\n');
  await f.write('docs/empty/_category_.json', { position: 3 });
  await f.write('docs/.sources/_category_.json', { label: 'Не сторінка' });
  await f.commit();
  const r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.deepEqual(r.out.orphaned.map((o) => o.page), ['old/_category_']);
  assert.deepEqual(r.out.moved, []);
  assert.ok(r.out.warnings.some((w) => w.includes('docs/yaml-section/_category_.yml is a YAML category file')));
  assert.deepEqual(r.out.pages.filter((p) => p.kind === 'category').map((p) => p.page), [CAT_ID], 'no label to translate, or under .sources: not tracked');
});

test('categories: blocks lists the entries to write, with the label-store binding', async () => {
  const f = await fixtureRepo({ category: true });
  await writeCatState(f);
  let r = (await cli(f.dir, 'blocks', CAT_ID, '--locales', 'tr')).out.results[0];
  assert.deepEqual([r.kind, r.mode, r.fullReason, r.target.path, r.target.exists], ['category', 'full', 'bootstrap', `${TR_ROOT}.json`, true]);
  assert.deepEqual(r.entries, [
    { entryKey: ENTRY_LABEL, field: 'label', ua: 'Фільтри', current: 'Фільтри', binding: 'label:filters.title' },
    { entryKey: ENTRY_DESC, field: 'link.description', ua: 'Перегляньте фільтри.', current: 'Перегляньте фільтри.' },
  ]);
  assert.match(r.apply, /--candidate/);

  r = (await cli(f.dir, 'blocks', CAT_ID, '--locales', 'ru')).out.results[0];
  assert.deepEqual([r.mode, r.entries, r.missing], ['full', [], ['label', 'link.description']]);
  assert.match(r.problem, /write-translations --locale ru/);
});

test('categories: check enforces translation, label store first, Ukrainian letters and known entries', async () => {
  const f = await fixtureRepo({ category: true });
  await writeCatState(f);
  const check = async (map, ...extra) => {
    await catCand(f, map);
    const r = await cli(f.dir, 'check', CAT_ID, '--locales', 'tr', '--candidate', 'cat.json', ...extra);
    return { code: r.code, checks: r.out.results?.[0]?.checks, failures: r.out.results?.[0]?.failures, out: r.out };
  };
  let r = await check(GOOD_CAT);
  assert.equal(r.code, 0, JSON.stringify(r.failures));

  r = await check({ ...GOOD_CAT, [ENTRY_LABEL]: 'Filtre' });
  assert.deepEqual([r.code, r.checks, r.failures[0].expected], [1, ['labels'], 'Filtreler']);
  r = await check({ [ENTRY_DESC]: 'Filtreleri görüntüleyin.' });
  assert.deepEqual([r.code, r.checks], [1, ['category', 'labels']], 'the label is still the UA text: untranslated and not the app string');
  r = await check({ ...GOOD_CAT, [ENTRY_DESC]: 'Filtreleri görüntüleyin, це є так.' });
  assert.deepEqual([r.code, r.checks], [1, ['ukrainian-letters']]);
  r = await check({ ...GOOD_CAT, [ENTRY_DESC]: '' });
  assert.deepEqual([r.code, r.checks], [1, ['category']]);
  r = await check({ ...GOOD_CAT, 'sidebar.other.category.nope': 'x' });
  assert.deepEqual([r.code, r.checks], [1, ['category']]);

  // The app shows `Фільтри:` / `Filtreler:` and the UA label drops the colon: the message may drop it too.
  await f.write('.doc-toolkit/ui-labels/uk.json', { ...LABELS.uk, 'filters.title': 'Фільтри:' });
  await f.write('.doc-toolkit/ui-labels/tr.json', { ...LABELS.tr, 'filters.title': 'Filtreler:' });
  r = await check(GOOD_CAT);
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  r = await check({ ...GOOD_CAT, [ENTRY_LABEL]: 'Filtreler:' });
  assert.equal(r.code, 0, JSON.stringify(r.failures));
  await f.write('.doc-toolkit/ui-labels/uk.json', LABELS.uk);
  await f.write('.doc-toolkit/ui-labels/tr.json', LABELS.tr);

  // No current.json for the locale: tell the writer to run write-translations.
  const ru = await cli(f.dir, 'check', CAT_ID, '--locales', 'ru');
  assert.deepEqual(ru.out.results[0].checks, ['target-missing']);
  assert.match(ru.out.results[0].failures[0].message, /write-translations --locale ru/);

  // Without a candidate the entries on disk are checked: still the untranslated UA text.
  assert.deepEqual((await cli(f.dir, 'check', CAT_ID, '--locales', 'tr')).out.results[0].checks, ['category', 'labels']);

  // A key the app has no tr string for needs an unverified entry.
  await f.write('.doc-toolkit/ui-labels/tr.json', { ...LABELS.tr, 'filters.title': undefined });
  r = await check({ ...GOOD_CAT, [ENTRY_LABEL]: 'Filtreler' });
  assert.deepEqual(r.checks, ['labels']);
  await f.write('unv.json', ['Фільтри']);
  r = await check({ ...GOOD_CAT, [ENTRY_LABEL]: 'Filtreler' }, '--unverified-file', 'unv.json');
  assert.equal(r.code, 0, JSON.stringify(r.failures));
});

test('categories: record applies the candidate to current.json only, then advances the state', async () => {
  const f = await fixtureRepo({ category: true });
  await writeCatState(f);
  const before = JSON.parse(await f.read(`${TR_ROOT}.json`));

  // A failing candidate changes nothing.
  await catCand(f, { ...GOOD_CAT, [ENTRY_LABEL]: 'Filtre' });
  let r = await cli(f.dir, 'record', CAT_ID, '--locales', 'tr', '--candidate', 'cat.json');
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(await f.read(`${TR_ROOT}.json`)), before);
  assert.deepEqual(JSON.parse(await f.read(catStatePath)).locales, {});

  await catCand(f, GOOD_CAT);
  r = await cli(f.dir, 'record', CAT_ID, '--locales', 'tr', '--candidate', 'cat.json', '--date', '2026-10-09');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const raw = await f.read(`${TR_ROOT}.json`);
  const after = JSON.parse(raw);
  assert.equal(after[ENTRY_LABEL].message, 'Filtreler');
  assert.equal(after[ENTRY_DESC].message, 'Filtreleri görüntüleyin.');
  assert.deepEqual([after['version.label'], after[ENTRY_LABEL].description], [before['version.label'], before[ENTRY_LABEL].description], 'everything else in the file is kept');
  assert.ok(raw.endsWith('}\n') && raw.includes('\n  "version.label"'), 'same JSON layout');
  assert.deepEqual(JSON.parse(await f.read(catStatePath)).locales.tr, { sourceBlob: uaBlob(JSON.stringify(CATEGORY, null, 2) + '\n'), labelSnapshot: 'content:abc1234', translatedAt: '2026-10-09', unverified: [], assetFallbacks: [] });
  assert.equal(await f.read('docs/filters/_category_.json'), JSON.stringify(CATEGORY, null, 2) + '\n', 'the UA file is never modified');
  const status = (await cli(f.dir, 'status', '--locales', 'tr')).out;
  assert.deepEqual(status.pages.find((p) => p.kind === 'category').locales.tr.state, 'current');

  // Edited in place instead (no candidate): the entries on disk are what gets checked and recorded.
  await f.write(`${TR_ROOT}.json`, { ...after, [ENTRY_DESC]: { ...after[ENTRY_DESC], message: 'Tüm filtreler.' } });
  await f.write('docs/filters/_category_.json', { ...CATEGORY, link: { ...CATEGORY.link, description: 'Усі фільтри.' } });
  await f.commit();
  r = await cli(f.dir, 'record', CAT_ID, '--locales', 'tr');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(JSON.parse(await f.read(catStatePath)).locales.tr.sourceBlob, uaBlob(await f.read('docs/filters/_category_.json')));
});

test('categories: a page and its category are separate units; link-assets and report stay page-only', async () => {
  const f = await fixtureRepo({ category: true });
  assert.equal((await cli(f.dir, 'link-assets', 'filters', '--locales', 'tr')).out.results.length, 1);
  assert.equal((await cli(f.dir, 'report', '--locales', 'tr')).out.pages.length, 1);
});

test('categories: after ui-labels sync patches a renamed label, locale-sync sees the category as current and passing', async () => {
  const UI_LABELS = path.join(path.dirname(CLI), '..', 'ui-labels', 'ui-labels.mjs');
  const uiLabels = async (cwd, ...args) => {
    try {
      const { stdout } = await run('node', [UI_LABELS, ...args], { cwd });
      return { code: 0, out: JSON.parse(stdout) };
    } catch (e) {
      return { code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null };
    }
  };
  const f = await fixtureRepo({ category: true });
  await f.write('CLAUDE.md', (await f.read('CLAUDE.md')).replace('- **UA content root:**', '- **UI label source:** `command cat labels/{locale}.json`\n- **UA content root:**'));
  const release = (title) => Promise.all(Object.keys(LABELS).map((l) => f.write(`labels/${l}.json`, { ...LABELS[l], 'filters.title': title[l] })));
  await release({ uk: 'Фільтри', en: 'Filters', tr: 'Filtreler', ru: 'Фильтры' });

  // The category is translated and recorded for tr.
  const uaCat = await f.read('docs/filters/_category_.json');
  await f.write(`${TR_ROOT}.json`, { ...TR_CURRENT, [ENTRY_LABEL]: { ...TR_CURRENT[ENTRY_LABEL], message: 'Filtreler' }, [ENTRY_DESC]: { ...TR_CURRENT[ENTRY_DESC], message: 'Filtreleri görüntüleyin.' } });
  await writeCatState(f, { tr: trEntry(uaBlob(uaCat)) });
  await f.commit();
  assert.equal((await uiLabels(f.dir, 'import')).code, 0);
  await f.commit('labels');
  let r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.equal(r.out.pages.find((p) => p.kind === 'category').locales.tr.state, 'current');

  // App release: the label is renamed in every language.
  await release({ uk: 'Усі фільтри', en: 'All filters', tr: 'Tüm filtreler', ru: 'Все фильтры' });
  assert.equal((await uiLabels(f.dir, 'import')).code, 0);
  const sync = await uiLabels(f.dir, 'sync', '--commit');
  assert.equal(sync.code, 0);
  assert.deepEqual(sync.out.skipped, []);
  assert.equal(sync.out.pendingRemains, false);
  assert.equal((await uiLabels(f.dir, 'import', '--dry-run')).code, 0, 'a later import is not blocked by a pending diff');

  // locale-sync: the UA file changed, but the recorded tr translation was patched with it, so nothing needs translating,
  // and the checks pass against the new app string.
  assert.equal(JSON.parse(await f.read('docs/filters/_category_.json')).label, 'Усі фільтри');
  assert.equal(JSON.parse(await f.read(`${TR_ROOT}.json`))[ENTRY_LABEL].message, 'Tüm filtreler');
  r = await cli(f.dir, 'status', '--locales', 'tr');
  assert.equal(r.out.pages.find((p) => p.kind === 'category').locales.tr.state, 'current');
  r = await cli(f.dir, 'check', CAT_ID, '--locales', 'tr');
  assert.equal(r.code, 0, JSON.stringify(r.out.results[0].failures));
  assert.deepEqual(JSON.parse(await f.read(catStatePath)).spans['Усі фільтри'], 'label:filters.title');
});

// ------------------------------------------------------------------ binding pass, label rows, term memory, parallel record

const STATE = '.doc-toolkit/pages/filters/filters.json';
const readStateFile = async (f, rel = STATE) => JSON.parse(await f.read(rel));

test('bind: records unique matches in a UI context, asks about the rest, and records the model decisions', async () => {
  const f = await fixtureRepo();
  let r = await cli(f.dir, 'bind', '--dry-run');
  assert.equal(r.code, 0, r.stderr);
  await assert.rejects(fs.stat(path.join(f.dir, STATE)), '--dry-run writes nothing');

  r = await cli(f.dir, 'bind');
  assert.equal(r.code, 0, r.stderr);
  const page = r.out.pages.find((p) => p.page === 'filters/filters');
  const auto = { 'В роботі': 'label:status.inwork', Фільтри: 'label:filters.title', Статус: 'label:filters.status', Застосувати: 'label:filters.apply' };
  assert.deepEqual(Object.fromEntries(page.resolved.map((x) => [x.span, x.decision])), auto);
  // «**Результат:**» is in no dictionary and has no UI context: the model decides.
  assert.deepEqual(page.ask.map((x) => [x.span, x.lookup.status, x.why, x.suggest]), [['Результат:', 'no-match', 'no dictionary match', undefined]]);
  assert.equal(page.ask[0].contexts[0].text, '**Результат:** Список оновлюється.');
  assert.deepEqual((await readStateFile(f)).spans, auto);

  await f.write('decisions.json', {
    'filters/filters': { 'В роботі': 'label:status.inwork', 'Результат:': 'emphasis', 'Немає такого': 'term', Статус: 'label:no.such.key', Фільтри: 'maybe' },
    'no/such/page': { X: 'term' },
  });
  r = await cli(f.dir, 'bind', '--decisions', 'decisions.json');
  assert.equal(r.code, 1, 'rejections exit 1');
  assert.deepEqual(r.out.written.map((w) => w.span), ['В роботі', 'Результат:']);
  assert.deepEqual(r.out.rejected.map((x) => [x.span, x.reason]), [
    ['Немає такого', 'the span is not on the committed UA page'],
    ['Статус', 'the label store has no such key'],
    ['Фільтри', 'a decision is label:<key>, unverified, term or emphasis'],
    [undefined, 'no UA page or category with this id'],
  ]);
  assert.deepEqual((await readStateFile(f)).spans, SPANS, 'the valid decisions are recorded, the rest untouched');

  r = await cli(f.dir, 'bind');
  assert.deepEqual([r.out.pages, r.out.summary.ask], [[], 0], 'a second run has nothing left to decide');

  // Another page repeats «**Результат:**»: still asked, with the decision the first page has as the suggestion.
  await f.write('docs/other/other.md', `---\ntitle: Інше\n---\n\n**Результат:** Готово.\n`);
  await f.commit();
  r = await cli(f.dir, 'bind', 'other');
  assert.deepEqual(r.out.pages[0].ask.map((x) => [x.span, x.suggest, x.seenOn]), [['Результат:', 'emphasis', { emphasis: 1 }]]);
});

test('bind: definition items are labels when the dictionary has them, otherwise terms; identical keys are chosen by namespace, unverified spans are re-checked', async () => {
  const f = await fixtureRepo();
  const same = (v) => ({ uk: 'Статус', en: 'Status', tr: 'Durum', ru: 'Статус' })[v];
  for (const l of ['uk', 'en', 'tr', 'ru']) await f.write(`.doc-toolkit/ui-labels/${l}.json`, { ...LABELS[l], 'users.status': same(l), 'users.role': { uk: 'Роль', en: 'Role', tr: 'Rol', ru: 'Роль' }[l], 'groups.role': { uk: 'Роль', en: 'Role', tr: 'Görev', ru: 'Роль' }[l] });
  await f.write('docs/users/users.md', `---\ntitle: Користувачі\n---\n\n- **Роль** — набір прав користувача.\n\n1. Оберіть **Статус** у списку.\n2. Натисніть **Роль**.\n3. Натисніть **Нове**.\n`);
  await f.commit();
  await f.write('.doc-toolkit/pages/users/users.json', { spans: { Нове: 'unverified' }, locales: {} });
  let r = await cli(f.dir, 'bind', 'users');
  assert.equal(r.code, 0, r.stderr);
  let page = r.out.pages[0];
  // «Статус» has two keys with identical strings: the page's area (users) picks users.status, not filters.status.
  assert.deepEqual(page.resolved.map((x) => [x.span, x.decision]), [['Статус', 'label:users.status']]);
  // «Роль» is a definition-list term and a UI label on the same page, with keys whose strings differ: the model decides.
  assert.deepEqual(page.ask.map((x) => [x.span, x.lookup.status, x.why]), [['Роль', 'ambiguous', '2 keys with different strings']]);
  assert.equal(page.ask[0].suggest, undefined, 'no namespace guess among keys whose strings differ');

  // The app gains «Нове»: the earlier `unverified` decision becomes a label.
  for (const l of ['uk', 'en', 'tr', 'ru']) {
    const cur = JSON.parse(await f.read(`.doc-toolkit/ui-labels/${l}.json`));
    await f.write(`.doc-toolkit/ui-labels/${l}.json`, { ...cur, 'users.new': { uk: 'Нове', en: 'New', tr: 'Yeni', ru: 'Новое' }[l] });
  }
  r = await cli(f.dir, 'bind', 'users');
  page = r.out.pages[0];
  assert.deepEqual(page.resolved.map((x) => [x.span, x.decision, x.why]), [['Нове', 'label:users.new', 'now in the dictionary']]);

  // A definition item that is a dictionary string names a UI element (a control the list describes): a label. One the
  // dictionary doesn't know is a term. Several identical keys with no namespace fit: the model decides.
  await f.write('docs/defs/defs.md', `---\ntitle: Терміни\n---\n\n- **Фільтри**: відкриває панель фільтрів.\n- **Статус:** поточний стан запису.\n- **Дата** — дата створення.\n\nЗаписи **Застосувати** зберігаються.\n`);
  await f.commit();
  r = await cli(f.dir, 'bind', 'defs');
  assert.deepEqual(r.out.pages[0].resolved.map((x) => [x.span, x.decision, x.why]), [['Фільтри', 'label:filters.title', 'definition item naming a UI string'], ['Дата', 'term', 'definition list']]);
  assert.deepEqual(r.out.pages[0].ask.map((x) => [x.span, x.why, x.suggest]), [
    ['Застосувати', 'dictionary match without UI context', 'label:filters.apply'],
    ['Статус:', '2 keys with the same strings, no namespace fits', undefined],
  ]);
});

test('blocks: label rows give the exact string to write; term rows come from term memory, the UI string winning', async () => {
  const f = await fixtureRepo();
  await writeState(f);
  await f.write('.doc-toolkit/ui-labels/uk.json', { ...LABELS.uk, 'filters.status': 'Статус:' });
  await f.write('.doc-toolkit/ui-labels/tr.json', { ...LABELS.tr, 'filters.status': 'Durum:', 'filters.apply': undefined });
  await f.write('.doc-toolkit/terms/tr.tsv', 'запис\tkayıt\nробоча група\tçalışma grubu\nстатус\tstatü\n');
  const r = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  const rows = Object.fromEntries(r.labels.map((x) => [x.span, x]));
  assert.equal(rows['Фільтри'].write, 'Filtreler');
  assert.equal(rows['Статус'].write, 'Durum', 'the UA page drops the colon of the app string, so the translation does too');
  assert.deepEqual([rows['Застосувати'].missing, rows['Застосувати'].write], [true, undefined]);
  assert.equal(rows['Результат:'].decision, 'emphasis');
  assert.deepEqual(r.undecided, []);
  // «записи» matches «запис»; «робоча група» is not on the page; «статус» equals a UI string, so the app's wins.
  assert.deepEqual(r.terms, [
    { ua: 'запис', target: 'kayıt', source: 'memory' },
    { ua: 'статус', target: 'Durum', source: 'ui', recorded: 'statü' },
  ]);

  await f.write('CLAUDE.md', (await f.read('CLAUDE.md')).replace('## Other', '- **UI label fallback:** `en`\n\n## Other'));
  const r2 = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  assert.deepEqual(r2.labels.find((x) => x.span === 'Застосувати'), { span: 'Застосувати', kind: 'bold', decision: 'label:filters.apply', key: 'filters.apply', missing: true, write: 'Apply', fallback: 'en' });

  await writeState(f, {}, {});
  const r3 = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  assert.equal(r3.undecided.length, 5, 'without a binding pass every span is undecided');
});

test('blocks: plain first cells of table body rows that are UI strings get the app string as a term row', async () => {
  const f = await fixtureRepo();
  await f.write('docs/cols/cols.md', `---\ntitle: Колонки\n---\n\n| Фільтри | Опис |\n|---|---|\n| Фільтри | Панель фільтрів. |\n| **Статус** | Стан запису. |\n| Невідоме | Немає в застосунку. |\n`);
  await f.commit();
  const r = (await cli(f.dir, 'blocks', 'cols', '--locales', 'tr')).out.results[0];
  // The header row is skipped, a cell with markup is a span (not a table term), and an unknown cell has no row.
  assert.deepEqual(r.terms, [{ ua: 'Фільтри', target: 'Filtreler', source: 'ui', where: 'table' }]);
});

test('terms: a library string is not a UI string for T1', async () => {
  const f = await fixtureRepo();
  for (const l of ['uk', 'tr', 'ru']) {
    const cur = JSON.parse(await f.read(`.doc-toolkit/ui-labels/${l}.json`));
    await f.write(`.doc-toolkit/ui-labels/${l}.json`, { ...cur, 'lib.antd.Icon.icon': { uk: 'іконка', tr: 'simgesi', ru: 'иконка' }[l] });
  }
  const r = await cli(f.dir, 'terms', 'іконка');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.terms[0].ui, null);
  assert.deepEqual(r.out.missing.tr, ['іконка'], 'the term needs a translation of its own');
});

test('terms: lookup per locale, append sorted with conflicts kept out, .gitattributes union merge', async () => {
  const f = await fixtureRepo();
  await f.write('.doc-toolkit/terms/tr.tsv', 'робоча група\tçalışma grubu\n');
  let r = await cli(f.dir, 'terms', 'Статус', 'робоча група', 'запис');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.terms[0].ui, { key: 'filters.status', values: { tr: 'Durum', ru: 'Статус' } });
  assert.deepEqual(r.out.terms[1].recorded, { tr: 'çalışma grubu', ru: null });
  assert.deepEqual(r.out.missing, { tr: ['Статус', 'запис'], ru: ['Статус', 'робоча група', 'запис'] });

  assert.equal((await cli(f.dir, 'terms', '--add', 'x.json')).code, 2, 'one locale only');
  await f.write('add.json', { запис: 'kayıt', 'робоча група': 'iş grubu', архів: 'arşiv', 'Робоча група': 'çalışma grubu' });
  r = await cli(f.dir, 'terms', '--add', 'add.json', '--locales', 'tr');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.added.map((x) => x.ua), ['запис', 'архів']);
  assert.deepEqual(r.out.conflicts, [{ ua: 'робоча група', recorded: 'çalışma grubu', proposed: 'iş grubu' }]);
  assert.deepEqual(r.out.existing.map((x) => x.ua), ['Робоча група']);
  assert.equal(await f.read('.doc-toolkit/terms/tr.tsv'), 'архів\tarşiv\nзапис\tkayıt\nробоча група\tçalışma grubu\n');
  assert.equal(r.out.gitattributes, 'added');
  assert.equal(await f.read('.gitattributes'), '.doc-toolkit/terms/*.tsv merge=union\n');
  await f.write('more.tsv', 'дата\ttarih\n');
  r = await cli(f.dir, 'terms', '--add', 'more.tsv', '--locales', 'tr');
  assert.deepEqual([r.out.added.length, r.out.gitattributes], [1, 'present']);
  // A state root outside the repo (a scratch run) never touches the repo's .gitattributes.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'locale-sync-state-'));
  r = await cli(f.dir, 'terms', '--add', 'more.tsv', '--locales', 'tr', '--state-root', scratch);
  assert.deepEqual([r.out.added.length, r.out.gitattributes], [1, 'outside-repo']);
  assert.equal(await f.read('.gitattributes'), '.doc-toolkit/terms/*.tsv merge=union\n');

  // Two branches merged with merge=union: the same term twice; the first line wins and the conflict is reported.
  await f.write('.doc-toolkit/terms/tr.tsv', 'запис\tkayıt\nзапис\tgiriş\n');
  r = await cli(f.dir, 'terms', 'запис', '--locales', 'tr');
  assert.deepEqual([r.out.terms[0].recorded.tr, r.out.conflicts.tr[0].ignored], ['kayıt', 'giriş']);
});

test('record: workers of different locales recording the same page in parallel keep both entries', async () => {
  const f = await translatedFixture();
  const ruFile = 'i18n/ru/docusaurus-plugin-content-docs/current/filters/filters.md';
  await f.write(ruFile, RU);
  assert.equal((await cli(f.dir, 'link-assets', 'filters', '--locales', 'ru')).code, 0);
  for (let i = 0; i < 3; i++) {
    await writeState(f);
    const [tr, ru] = await Promise.all([cli(f.dir, 'record', 'filters', '--locales', 'tr'), cli(f.dir, 'record', 'filters', '--locales', 'ru')]);
    assert.equal(tr.code + ru.code, 0, JSON.stringify([tr.out, ru.out]));
    const state = await readStateFile(f);
    assert.deepEqual([Object.keys(state.locales).sort(), state.spans], [['ru', 'tr'], SPANS]);
  }
  await assert.rejects(fs.stat(path.join(f.dir, `${STATE}.lock`)), 'the lock is released');
});

test('bind: a sidebar category label is bound to the app string, or recorded as a term when the app has none', async () => {
  const f = await fixtureRepo({ category: true });
  let r = await cli(f.dir, 'bind', CAT_ID);
  assert.deepEqual(r.out.pages[0].resolved, [{ span: 'Фільтри', decision: 'label:filters.title', why: 'sidebar category label in the dictionary' }]);
  const b = (await cli(f.dir, 'blocks', CAT_ID, '--locales', 'tr')).out.results[0];
  assert.deepEqual(b.labels, [{ span: 'Фільтри', kind: 'category', decision: 'label:filters.title', key: 'filters.title', write: 'Filtreler' }]);

  await f.write('docs/filters/_category_.json', { ...CATEGORY, label: 'Огляд фільтрів' });
  await f.commit();
  r = await cli(f.dir, 'bind', CAT_ID);
  assert.deepEqual(r.out.pages[0].resolved.map((x) => [x.span, x.decision]), [['Огляд фільтрів', 'term']]);
});

test('bind and blocks: UI text with markup inside the bold is a term, written part by part from the label store', async () => {
  const f = await fixtureRepo();
  await f.write('docs/menu/menu.md', `---\ntitle: Меню\n---\n\n1. Відкрийте **[Фільтри](/filters/)**.\n2. Виберіть **Фільтри&nbsp;>&nbsp;Застосувати**.\n3. Виберіть **Фільтри&nbsp;>&nbsp;Невідоме**.\n`);
  await f.commit();
  const r = await cli(f.dir, 'bind', 'menu');
  const page = r.out.pages[0];
  assert.deepEqual(page.resolved.map((x) => [x.span, x.decision]), [['[Фільтри](/filters/)', 'term'], ['Фільтри&nbsp;>&nbsp;Застосувати', 'term']]);
  assert.deepEqual(page.ask.map((x) => [x.span, x.parts.map((p) => p.lookup.status)]), [['Фільтри&nbsp;>&nbsp;Невідоме', ['unique', 'no-match']]]);
  const b = (await cli(f.dir, 'blocks', 'menu', '--locales', 'tr')).out.results[0];
  assert.deepEqual(Object.fromEntries(b.labels.map((x) => [x.span, x.parts])), {
    '[Фільтри](/filters/)': [{ ua: 'Фільтри', write: 'Filtreler' }],
    'Фільтри&nbsp;>&nbsp;Застосувати': [{ ua: 'Фільтри', write: 'Filtreler' }, { ua: 'Застосувати', write: 'Uygula' }],
  });
  assert.deepEqual(b.undecided.map((x) => x.span), ['Фільтри&nbsp;>&nbsp;Невідоме']);
});

test('apply: splices the translated blocks into a candidate; every other byte of the translation stays', async () => {
  const f = await translatedFixture();
  await writeState(f, { tr: trEntry(uaBlob()) });
  let ua2 = edit(UA, '- Дії доступні лише в статусі **В роботі**.', '- Дії доступні лише для записів у статусі **В роботі**.');
  ua2 = edit(ua2, '- Фільтр `status` приймає значення `done`.\n', '- Фільтр `status` приймає значення `done`.\n- Новий пункт про **Фільтри**.\n');
  ua2 = edit(ua2, 'У списку ви можете виконувати такі операції:\n', 'У списку ви можете виконувати такі операції:\n\nНовий абзац.\n');
  ua2 = edit(ua2, '{/* ToDo: уточнити текст */}\n\n', '');
  ua2 = edit(ua2, '| Дата | Дата створення. |\n', '| Дата | Дата створення. |\n| Сума | Сума запису. |\n');
  await f.write('docs/filters/filters.md', ua2);
  await f.commit();

  const b = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  assert.equal(b.mode, 'incremental');
  const tr = {
    'Новий пункт': '- **Filtreler** hakkında yeni madde.',
    'Дії доступні': '- Eylemler yalnızca **İşlemde** durumundaki kayıtlar için kullanılabilir.',
    'Новий абзац': 'Yeni paragraf.',
    Сума: '| Tutar | Kaydın tutarı. |',
  };
  const translations = {};
  for (const c of b.changes) if (c.op !== 'remove') translations[c.id] = Object.entries(tr).find(([k]) => c.ua.text.includes(k))[1];
  assert.deepEqual(b.changes.map((c) => c.op).sort(), ['add', 'add', 'add', 'remove', 'replace']);

  await f.write('t.json', { c99: 'x' });
  assert.equal((await cli(f.dir, 'apply', 'filters', '--locales', 'tr', '--translations', 't.json', '--out', 'cand.md')).code, 2, 'unknown or missing ids are refused');
  await f.write('t.json', translations);
  const r = await cli(f.dir, 'apply', 'filters', '--locales', 'tr', '--translations', 't.json', '--out', 'cand.md');
  assert.equal(r.code, 0, JSON.stringify(r.out));

  let want = edit(TR, '- Eylemler yalnızca **İşlemde** durumunda kullanılabilir.', tr['Дії доступні']);
  want = edit(want, '- `status` filtresi `done` değerini kabul eder.\n', `- \`status\` filtresi \`done\` değerini kabul eder.\n${tr['Новий пункт']}\n`);
  want = edit(want, 'Listede aşağıdaki işlemleri yapabilirsiniz:\n', 'Listede aşağıdaki işlemleri yapabilirsiniz:\n\nYeni paragraf.\n');
  want = edit(want, '{/* ToDo: metni netleştirin */}\n\n', '');
  want = edit(want, '| Tarih | Oluşturulma tarihi. |\n', `| Tarih | Oluşturulma tarihi. |\n${tr['Сума']}\n`);
  assert.equal(await f.read('cand.md'), want);
  const c = await cli(f.dir, 'check', 'filters', '--locales', 'tr', '--candidate', 'cand.md');
  assert.equal(c.code, 0, JSON.stringify(c.out.results[0].failures));

  await f.write('full.json', { full: 'x' });
  assert.equal((await cli(f.dir, 'apply', 'filters', '--locales', 'tr', '--translations', 'full.json', '--out', 'cand.md')).code, 2, 'an incremental page needs block translations');
});

test('apply: a new section and several additions at one anchor keep the UA order and blank lines', async () => {
  const f = await translatedFixture();
  await writeState(f, { tr: trEntry(uaBlob()) });
  let ua2 = edit(UA, '- Фільтр `status` приймає значення `done`.\n', '- Фільтр `status` приймає значення `done`.\n- Перший новий.\n- Другий новий.\n');
  ua2 = edit(ua2, '### Додаткові дії {/* #extra */}\n\nВи також можете скинути фільтри.\n', '### Додаткові дії {/* #extra */}\n\nВи також можете скинути фільтри.\n\n### Нова дія {/* #new-action */}\n\nТекст нової дії.\n');
  await f.write('docs/filters/filters.md', ua2);
  await f.commit();
  const b = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr')).out.results[0];
  const lines = { '- Перший новий.': '- İlk yeni.', '- Другий новий.': '- İkinci yeni.', '### Нова дія {/* #new-action */}': '### Yeni işlem {/* #new-action */}', 'Текст нової дії.': 'Yeni işlemin metni.', '': '' };
  assert.deepEqual(b.changes.map((c) => [c.op, c.kind]), [['add', 'item'], ['add', 'section']]);
  // The text form: '@@@ <id>' lines, so no JSON escaping is needed.
  await f.write('t.txt', b.changes.map((c) => `@@@ ${c.id}\n${c.ua.text.split('\n').map((l) => lines[l]).join('\n')}\n`).join('\n'));
  const r = await cli(f.dir, 'apply', 'filters', '--locales', 'tr', '--translations', 't.txt', '--out', 'cand.md');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  let want = edit(TR, '- `status` filtresi `done` değerini kabul eder.\n', '- `status` filtresi `done` değerini kabul eder.\n- İlk yeni.\n- İkinci yeni.\n');
  want = edit(want, 'Filtreleri sıfırlayabilirsiniz.\n', 'Filtreleri sıfırlayabilirsiniz.\n\n### Yeni işlem {/* #new-action */}\n\nYeni işlemin metni.\n');
  assert.equal(await f.read('cand.md'), want);
  assert.equal((await cli(f.dir, 'check', 'filters', '--locales', 'tr', '--candidate', 'cand.md')).code, 0);
});

// ------------------------------------------------------------------ WP7b: scoped decisions, term corrections, link titles

// One UA label text, two app keys: the tab «Отримання» and the switch «Отримання», which ru shows differently.
const TABS_UA = `---\ntitle: Вкладки\n---\n\nВкладка **Отримання** показує вхідні транзакції.\n\n## Перемикачі {/* #switches */}\n\nУвімкніть перемикач **Отримання**.\n\n## Інше {/* #other */}\n\nТекст.\n`;
const TABS_RU = (tab, sw) => `---\ntitle: Вкладки транзакций\n---\n\nВкладка **${tab}** показывает входящие транзакции.\n\n## Переключатели {/* #switches */}\n\nВключите переключатель **${sw}**.\n\n## Другое {/* #other */}\n\nТекст.\n`;
const TABS_LABELS = { uk: ['Отримання', 'Отримання'], en: ['Receive', 'Receive'], tr: ['Alma', 'Alma'], ru: ['Получение', 'Прием'] };
async function tabsFixture() {
  const f = await fixtureRepo();
  for (const [l, [tab, sw]] of Object.entries(TABS_LABELS)) await f.write(`.doc-toolkit/ui-labels/${l}.json`, { ...LABELS[l], 'tabs.advance': tab, 'switch.inbound': sw });
  await f.write('docs/tabs/tabs.md', TABS_UA);
  await f.commit();
  return f;
}
const TABS_STATE = '.doc-toolkit/pages/tabs/tabs.json';
const RU_TABS = 'i18n/ru/docusaurus-plugin-content-docs/current/tabs/tabs.md';

test('scoped decisions: bind lists the headings, records <span>@<heading>, blocks and check follow it per section', async () => {
  const f = await tabsFixture();
  let r = await cli(f.dir, 'bind', 'tabs');
  const ask = r.out.pages[0].ask.find((a) => a.span === 'Отримання');
  assert.equal(ask.why, '2 keys with different strings');
  assert.deepEqual(ask.sections, [{ heading: null, count: 1 }, { heading: 'Перемикачі', anchor: '#switches', count: 1 }]);
  assert.equal(ask.contexts[1].section, 'Перемикачі');

  await f.write('dec.json', { 'tabs/tabs': { Отримання: 'label:tabs.advance', 'Отримання@#switches': 'label:switch.inbound', 'Отримання@#other': 'term', 'Отримання@Немає': 'term' } });
  r = await cli(f.dir, 'bind', '--decisions', 'dec.json');
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.written.map((w) => w.span), ['Отримання', 'Отримання@#switches']);
  assert.deepEqual(r.out.rejected.map((x) => [x.span, x.reason]), [
    ['Отримання@#other', "the span does not occur under the heading '#other'"],
    ['Отримання@Немає', 'the span is not on the committed UA page'],
  ]);
  r = await cli(f.dir, 'bind', 'tabs');
  assert.deepEqual([r.out.pages, r.out.summary.ask], [[], 0], 'every occurrence is decided');

  // The label rows: one per decision, with the heading it applies under and the UA lines.
  const b = (await cli(f.dir, 'blocks', 'tabs', '--locales', 'ru')).out.results[0];
  assert.deepEqual(
    b.labels.map((x) => [x.span, x.write, x.scope, x.lines]),
    [
      ['Отримання', 'Получение', undefined, [5]],
      ['Отримання', 'Прием', '#switches', [9]],
    ],
  );
  assert.deepEqual(b.undecided, []);

  // check: each section shows the string of the key that applies there.
  await f.write(RU_TABS, TABS_RU('Получение', 'Прием'));
  assert.equal((await cli(f.dir, 'check', 'tabs', '--locales', 'ru')).code, 0);
  await f.write(RU_TABS, TABS_RU('Получение', 'Получение'));
  r = await cli(f.dir, 'check', 'tabs', '--locales', 'ru');
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.results[0].failures[0].labels.map((x) => [x.key, x.section, x.expected, x.redo]), [['switch.inbound', 'Перемикачі', '**Прием**', '9']]);
  await f.write(RU_TABS, TABS_RU('Прием', 'Прием'));
  r = await cli(f.dir, 'check', 'tabs', '--locales', 'ru');
  assert.deepEqual(r.out.results[0].failures[0].labels.map((x) => [x.key, x.section]), [['tabs.advance', '(before the first heading)']]);
});

test('scoped decisions: ui-labels sync patches a renamed string only where its key applies, and keeps the heading in the key', async () => {
  const f = await tabsFixture();
  await f.write(TABS_STATE, { spans: { Отримання: 'label:tabs.advance', 'Отримання@Перемикачі': 'label:switch.inbound' }, locales: {} });
  await f.write(RU_TABS, TABS_RU('Получение', 'Прием'));
  await f.commit();
  await f.write('diff.json', { from: 'a', to: 'b', added: [], removed: [], rekeyed: [], changed: [{ key: 'switch.inbound', locales: { uk: { old: 'Отримання', new: 'Надходження' }, ru: { old: 'Прием', new: 'Приём' } } }] });
  const UL = path.join(path.dirname(CLI), '..', 'ui-labels', 'ui-labels.mjs');
  const { stdout } = await run('node', [UL, 'sync', '--diff', 'diff.json'], { cwd: f.dir });
  const out = JSON.parse(stdout);
  assert.deepEqual(out.patched.filter((p) => p.page === 'tabs/tabs').map((p) => [p.locale, p.line]), [['uk', 9], ['ru', 9]]);
  assert.equal(await f.read('docs/tabs/tabs.md'), TABS_UA.replace('перемикач **Отримання**', 'перемикач **Надходження**'));
  assert.equal(await f.read(RU_TABS), TABS_RU('Получение', 'Приём'));
  assert.deepEqual(JSON.parse(await f.read(TABS_STATE)).spans, { Отримання: 'label:tabs.advance', 'Надходження@Перемикачі': 'label:switch.inbound' });
});

test('term corrections: terms --replace and --drop, terms --usage finds the blocks, blocks/apply --redo re-translate only those', async () => {
  const f = await translatedFixture();
  await writeState(f, { tr: trEntry(uaBlob()) });
  await f.write('.doc-toolkit/terms/tr.tsv', 'запис\tkayıt\nсписок\tliste\nхлам\tçöp\n');
  await f.write('fix.json', { список: 'dizelge' });
  let r = await cli(f.dir, 'terms', '--add', 'fix.json', '--locales', 'tr');
  assert.deepEqual([r.out.added, r.out.conflicts.length], [[], 1], 'without --replace a different translation stays a conflict');
  r = await cli(f.dir, 'terms', '--add', 'fix.json', '--locales', 'tr', '--replace');
  assert.deepEqual(r.out.replaced, [{ ua: 'список', old: 'liste', new: 'dizelge' }]);
  assert.match(r.out.next, /terms --usage/);
  r = await cli(f.dir, 'terms', '--drop', 'хлам', 'немає', '--locales', 'tr');
  assert.deepEqual([r.out.dropped, r.out.notFound], [[{ ua: 'хлам', target: 'çöp' }], ['немає']]);
  assert.equal(await f.read('.doc-toolkit/terms/tr.tsv'), 'запис\tkayıt\nсписок\tdizelge\n');

  // «liste» (and «Listede») in a paragraph and inside the Accordion: two blocks, no code.
  r = await cli(f.dir, 'terms', '--usage', 'liste', '--locales', 'tr');
  assert.equal(r.code, 0, r.stderr);
  const [page] = r.out.pages;
  const at = (s) => TR.split('\n').findIndex((l) => l.includes(s)) + 1;
  assert.deepEqual(page.hits.map((h) => h.line), [at('Listede aşağıdaki'), at('Liste güncellenir')]);
  assert.deepEqual(page.blocks.map((b) => [b.kind, b.headingPath]), [['paragraph', ['Операції']], ['component', ['Операції']]]);
  assert.equal(page.redo, `${at('Listede aşağıdaki')},${at('<Accordion')}`);
  assert.equal(page.upToDate, true);

  const b = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--redo', page.redo)).out.results[0];
  assert.equal(b.mode, 'redo');
  assert.deepEqual(b.changes.map((c) => [c.op, c.kind, c.ua.text.split('\n')[0]]), [
    ['replace', 'paragraph', 'У списку ви можете виконувати такі операції:'],
    ['replace', 'component', '<Accordion titleAs="h3" title="Фільтрувати записи">'],
  ]);
  assert.deepEqual(b.terms.find((t) => t.ua === 'список'), { ua: 'список', target: 'dizelge', source: 'memory' });
  const fixed = Object.fromEntries(b.changes.map((c) => [c.id, c.target.text.replace('Listede', 'Dizelgede').replace('Liste güncellenir', 'Dizelge güncellenir')]));
  await f.write('t.json', fixed);
  r = await cli(f.dir, 'apply', 'filters', '--locales', 'tr', '--redo', page.redo, '--translations', 't.json', '--out', 'cand.md');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(await f.read('cand.md'), TR.replace('Listede', 'Dizelgede').replace('Liste güncellenir', 'Dizelge güncellenir'));
  assert.equal((await cli(f.dir, 'record', 'filters', '--locales', 'tr', '--candidate', 'cand.md')).code, 0);
  assert.equal((await cli(f.dir, 'terms', '--usage', 'liste', '--locales', 'tr')).out.pages.length, 0);
  assert.equal((await cli(f.dir, 'status', 'filters', '--locales', 'tr')).out.summary.pageTranslations, 0, 'the page stays current');

  // A frontmatter line picks its value, a heading line the heading alone, a blank or code line nothing.
  const lines = TR.split('\n');
  const r2 = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--redo', `3,${at('## İşlemler')},${at('## İşlemler') + 1},${lines.indexOf('flowchart LR') + 1}`)).out.results[0];
  // A mermaid diagram has translatable labels, so its line picks the whole diagram; an import line is verbatim.
  assert.deepEqual(r2.changes.map((c) => [c.kind, c.key ?? null, c.ua.text.split('\n')[0]]), [['frontmatter', 'title', 'title: Фільтри'], ['heading', null, '## Операції {/* #operations */}'], ['code', null, '```mermaid']]);
  assert.deepEqual(r2.skipped.map((x) => x.reason), ['blank line']);
  const imp = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--redo', String(at('import Tabs')))).out.results[0];
  assert.deepEqual([imp.changes, imp.skipped.map((x) => x.reason)], [[], ['code or import, copied verbatim']]);
  assert.equal((await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--redo', 'all')).out.results[0].mode, 'full');
  assert.equal((await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--redo', 'x')).code, 2);

  // A page that is not current can't be redone: its pending changes come first.
  await f.write('docs/filters/filters.md', edit(UA, 'Ви також можете скинути фільтри.', 'Ви можете скинути фільтри.'));
  await f.commit();
  assert.equal((await cli(f.dir, 'blocks', 'filters', '--locales', 'tr', '--redo', '12')).out.results[0].mode, 'error');
  assert.equal((await cli(f.dir, 'apply', 'filters', '--locales', 'tr', '--redo', '12', '--translations', 't.json', '--out', 'c.md')).code, 2);
  assert.equal((await cli(f.dir, 'terms', '--usage', 'Filtreleri', '--locales', 'tr')).out.pages[0].upToDate, false);
});

test('link titles: blocks gives the target page title per locale; check warns when a link names a page differently', async () => {
  const f = await translatedFixture();
  await f.write('docs/overview/overview.md', '---\ntitle: Огляд кабінету\n---\n\nТекст.\n');
  await f.write(`${TR_ROOT}/overview/overview.md`, '---\ntitle: Kabine genel bakışı\n---\n\nMetin.\n');
  await f.write('docs/filters/filters.md', edit(UA, 'на сторінці [Огляд](/overview/)', 'у розділі [огляду кабінету](/overview/)'));
  await f.commit();
  const b = (await cli(f.dir, 'blocks', 'filters', '--locales', 'tr,ru', '--overwrite')).out.results;
  // «огляду кабінету» names the page «Огляд кабінету» in another case; «фільтри» names the page itself.
  assert.deepEqual(b.find((x) => x.locale === 'tr').links, [
    { text: 'фільтри', url: '/filters/', page: 'filters/filters', title: 'Filtreler' },
    { text: 'огляду кабінету', url: '/overview/', page: 'overview/overview', title: 'Kabine genel bakışı' },
  ]);
  assert.equal(b.find((x) => x.locale === 'ru').links[1].title, null, 'the target has no ru translation yet');

  const trPage = (text) => edit(TR, '[Genel bakış](/overview/) sayfasına', text);
  await f.write(`${TR_ROOT}/filters/filters.md`, trPage('[kabine genel bakışına](/overview/) bölümüne'));
  let r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.deepEqual(r.out.results[0].warnings, [], 'an added suffix is still the title');
  await f.write(`${TR_ROOT}/filters/filters.md`, trPage('[Genel bakış](/overview/) sayfasına'));
  r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.code, 0, 'a warning, not a failure');
  assert.match(r.out.results[0].warnings[0], /1 link text names its target page differently from the page title: line \d+ "Genel bakış" for "Kabine genel bakışı"/);
  assert.deepEqual(r.out.results[0].linkTitles.map((o) => [o.text, o.url, o.title]), [['Genel bakış', '/overview/', 'Kabine genel bakışı']], 'the check result carries linkTitles[]');

  // Every mismatch is listed, not just three per page.
  const many = (n) => Array.from({ length: n }, () => '[Genel bakış](/overview/)').join(' ');
  await f.write('docs/filters/filters.md', edit(UA, 'на сторінці [Огляд](/overview/)', `на сторінці ${Array.from({ length: 5 }, () => '[огляду кабінету](/overview/)').join(' ')}`));
  await f.commit();
  await f.write(`${TR_ROOT}/filters/filters.md`, trPage(`${many(5)} bölümüne`));
  r = await cli(f.dir, 'check', 'filters', '--locales', 'tr');
  assert.equal(r.out.results[0].linkTitles.length, 5);
  assert.equal(r.out.results[0].warnings[0].match(/line \d+ "/g).length, 5);
  assert.doesNotMatch(r.out.results[0].warnings[0], /…/);
  r = await cli(f.dir, 'report', '--md', '--locales', 'tr');
  assert.match(r.out, /### Link texts that name a page differently from its title\n\n- filters\/filters \[tr\] line \d+: "Genel bakış" → \/overview\/ is titled "Kabine genel bakışı"/);
});
