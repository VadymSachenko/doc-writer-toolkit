import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compare } from '../lib/compare.mjs';
import { cellCount } from '../lib/parse.mjs';
import { createSlugger, slugify, uaHeadingId } from '../lib/headings.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'doc-align.mjs');

async function cli(...args) {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args]);
    return { code: 0, out: stdout.trim().startsWith('{') ? JSON.parse(stdout) : stdout, stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout?.trim().startsWith('{') ? JSON.parse(e.stdout) : e.stdout, stderr: e.stderr };
  }
}

// An aligned pair that exercises every check. Each misaligned case below changes one thing in it.
const UA = `---
title: Фільтри
last_update:
  date: 2026-01-10
---

# Фільтрування записів

Вступ. Дивіться [архів](/archive/archive#record-statuses) і ![екран](./.assets/list.png).

## Передумови {/* #prerequisites */}

| Поле | Тип | Опис |
|---|---|---|
| \`id\` | String | Ідентифікатор {/* ToDo: уточнити формат */} |
| \`name\` | String | Назва, [докладніше](#record-statuses) |

## Статуси записів {/* #record-statuses */}

:::note
Примітка.
:::

\`\`\`json
{ "status": "active" }
\`\`\`

<details>
<summary>Більше</summary>

Текст. {/* NEEDS CONFIRMATION: чи є інші статуси */}

</details>

### Активний запис {/* #active-record */}

<img src="./.assets/active.png" alt="Активний" />

## Довідкова інформація {/* #reference-information-create-record */}

Текст.
`;

const EN = `---
title: Filters
last_update:
  date: 2026-01-10
---

# Filter records

Intro. See the [archive](/archive/archive#record-statuses) and ![screen](./.assets/list.png).

## Prerequisites

| Field | Type | Description |
|---|---|---|
| \`id\` | String | Identifier {/* ToDo: уточнити формат */} |
| \`name\` | String | Name, [more](#record-statuses) |

## Record statuses

:::note
Note.
:::

\`\`\`json
{ "status": "active" }
\`\`\`

<details>
<summary>More</summary>

Text. {/* NEEDS CONFIRMATION: чи є інші статуси */}

</details>

### Active record

<img src="./.assets/active.png" alt="Active" />

## Reference information {#reference-information-create-record}

Text.
`;

const edit = (text, from, to) => {
  assert.ok(text.includes(from), `fixture contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};
const findings = (r) => [...r.bugs, ...r.warnings];
const flags = (r) => findings(r).map((f) => f.flag);
const passedNames = (r) => r.passed.map((p) => p.name);

const ALL_PASSED = [
  'Frontmatter dates match',
  'Heading count and levels',
  'UA heading ids present, well formed and unique',
  'EN headings carry no comment',
  'EN heading ids match the UA ids',
  'Table count, columns and rows',
  'Code blocks identical',
  '<details> block count',
  'ToDo markers paired',
  'NEEDS CONFIRMATION markers paired',
  'Image count',
  'Link count',
  'Admonition count and types',
];

test('an aligned pair passes every check, in either direction', () => {
  const r = compare(UA, EN, { mainPath: 'ua.md', secondaryPath: 'en.md' });
  assert.deepEqual(findings(r), []);
  assert.deepEqual(passedNames(r), ALL_PASSED);
  assert.equal(r.ua, 'main');
  assert.deepEqual(r.passed.slice(0, 3), [
    { check: 1, name: 'Frontmatter dates match' },
    { check: 2, name: 'Heading count and levels' },
    { check: 2, name: 'UA heading ids present, well formed and unique' },
  ]);
  const back = compare(EN, UA);
  assert.deepEqual(findings(back), []);
  assert.equal(back.ua, 'secondary');
});

test('Check 1: frontmatter dates', () => {
  const r = compare(UA, edit(EN, 'date: 2026-01-10', 'date: 2026-02-01'), { secondaryPath: 'en.md' });
  assert.deepEqual(flags(r), ['DATE-MISMATCH']);
  assert.deepEqual(r.warnings[0], { check: 1, flag: 'DATE-MISMATCH', description: 'main: 2026-01-10, secondary: 2026-02-01', line: 4, file: 'en.md' });
  // Quotes around the value don't make a difference.
  assert.deepEqual(flags(compare(UA, edit(EN, 'date: 2026-01-10', "date: '2026-01-10'"))), []);
  assert.deepEqual(flags(compare(UA, edit(EN, '  date: 2026-01-10\n', ''))), ['DATE-MISMATCH']);
});

test('Check 2: heading count and levels', () => {
  const count = compare(UA, edit(EN, '### Active record\n', ''));
  assert.ok(flags(count).includes('HEADING-COUNT-MISMATCH'));
  assert.equal(count.bugs[0].check, 2);
  assert.ok(!passedNames(count).includes('EN heading ids match the UA ids'), 'id positions are not compared when the counts differ');

  const level = compare(UA, edit(EN, '### Active record', '## Active record'));
  assert.deepEqual(level.bugs.map((b) => b.flag), ['HEADING-LEVEL-MISMATCH']);
  assert.match(level.bugs[0].description, /heading 4: main '### Активний запис' is H3, secondary '## Active record' is H2/);

  // A heading inside a code block is not a heading.
  const fenced = '\n```md\n## Not a heading\n```\n';
  const r = compare(UA + fenced, EN + fenced);
  assert.deepEqual(findings(r), []);
});

test('Check 2: UA heading ids are present, well formed and unique', () => {
  const missing = compare(edit(UA, '## Передумови {/* #prerequisites */}', '## Передумови'), EN, { mainPath: 'ua.md' });
  assert.deepEqual(flags(missing), ['HEADING-ID-MISSING']);
  assert.deepEqual(missing.warnings[0], { check: 2, flag: 'HEADING-ID-MISSING', description: "'## Передумови' has no {/* #id */} comment", line: 11, file: 'ua.md' });

  for (const bad of ['{/* #Prerequisites */}', '{/* #pre_requisites */}', '{/* prerequisites */}', '{/* #pre--requisites */}']) {
    const r = compare(edit(UA, '{/* #prerequisites */}', bad), EN);
    assert.deepEqual(flags(r), ['HEADING-ID-MALFORMED'], bad);
  }
  const notAtEnd = compare(edit(UA, '## Передумови {/* #prerequisites */}', '## {/* #prerequisites */} Передумови'), EN);
  assert.deepEqual(flags(notAtEnd), ['HEADING-ID-MALFORMED']);
  assert.match(notAtEnd.warnings[0].description, /does not end the heading/);

  const dup = compare(edit(UA, '{/* #active-record */}', '{/* #prerequisites */}'), EN);
  assert.ok(flags(dup).includes('HEADING-ID-DUPLICATE'));
  assert.match(dup.warnings.find((w) => w.flag === 'HEADING-ID-DUPLICATE').description, /also used by the heading on line 11/);

  // The page title takes none, and a marker in a heading is not an id comment.
  const marked = compare(
    edit(UA, '## Передумови {/* #prerequisites */}', '## Передумови {/* ToDo: перевірити */} {/* #prerequisites */}'),
    edit(EN, '## Prerequisites', '## Prerequisites {/* ToDo: перевірити */}'),
  );
  assert.deepEqual(flags(marked), []);
});

test('Check 2: an EN heading carries no comment', () => {
  const r = compare(UA, edit(EN, '## Prerequisites', '## Prerequisites {/* #prerequisites */}'), { secondaryPath: 'en.md' });
  assert.deepEqual(flags(r), ['EN-HEADING-COMMENT']);
  assert.equal(r.warnings[0].file, 'en.md');
  assert.equal(r.warnings[0].line, 11);
});

test('Check 2: the EN heading id equals the UA id at the same position', () => {
  const generated = compare(UA, edit(EN, '## Record statuses', '## Statuses of records'), { secondaryPath: 'en.md' });
  assert.deepEqual(flags(generated), ['HEADING-ID-MISMATCH']);
  assert.match(generated.warnings[0].description, /generated id 'statuses-of-records', the UA heading's id is 'record-statuses'/);

  const explicit = compare(UA, edit(EN, '{#reference-information-create-record}', '{#reference-information}'));
  assert.deepEqual(flags(explicit), ['HEADING-ID-MISMATCH']);
  assert.match(explicit.warnings[0].description, /explicit id 'reference-information'/);

  // Without the explicit id, the generated slug of "Reference information" does not match.
  assert.deepEqual(flags(compare(UA, edit(EN, ' {#reference-information-create-record}', ''))), ['HEADING-ID-MISMATCH']);

  // EN as main: the findings point at the main file.
  const enMain = compare(edit(EN, '## Record statuses', '## Statuses'), UA, { mainPath: 'en.md' });
  assert.deepEqual(flags(enMain), ['HEADING-ID-MISMATCH']);
  assert.equal(enMain.warnings[0].file, 'en.md');

  // Markup and punctuation are slugged like Docusaurus does.
  const styled = compare(
    edit(UA, '## Статуси записів {/* #record-statuses */}', '## Статуси записів {/* #record-statuses-and-api */}'),
    edit(EN, '## Record statuses', '## Record **statuses** & `API`'),
  );
  assert.deepEqual(flags(styled), ['HEADING-ID-MISMATCH'], 'the & leaves two hyphens');
  const styledOk = compare(
    edit(UA, '## Статуси записів {/* #record-statuses */}', '## Статуси записів {/* #record-statuses-api */}'),
    edit(EN, '## Record statuses', '## Record **statuses**: `API`'),
  );
  assert.deepEqual(flags(styledOk), []);
});

test('Check 2: which page is UA', () => {
  // Detected from the headings, overridden with --ua.
  assert.equal(compare(UA, EN).ua, 'main');
  assert.equal(compare(EN, UA).ua, 'secondary');
  const forced = compare(UA, EN, { ua: 'secondary' });
  assert.equal(forced.ua, 'secondary');
  assert.ok(flags(forced).includes('HEADING-ID-MISSING'), 'the EN page read as UA has no id comments');

  // Neither page has Cyrillic text: the id checks are skipped with one warning.
  const plain = '# Title\n\n## Section\n';
  const r = compare(plain, plain);
  assert.deepEqual(flags(r), ['HEADING-ID-SKIPPED']);
  assert.equal(r.ua, null);
  assert.ok(!passedNames(r).some((n) => /heading ids/i.test(n)));
});

test('heading id helpers', () => {
  assert.equal(slugify('Record statuses'), 'record-statuses');
  assert.equal(slugify("What's new (v2)?"), 'whats-new-v2');
  assert.equal(slugify('A – B'), 'a--b');
  assert.equal(slugify('snake_case name'), 'snake_case-name');
  const slug = createSlugger();
  assert.deepEqual(['Notes', 'Notes', 'Notes'].map(slug), ['notes', 'notes-1', 'notes-2']);
  assert.deepEqual(uaHeadingId('Передумови {/* #prerequisites */}'), { id: 'prerequisites', problem: null });
  assert.deepEqual(uaHeadingId('Передумови {/*#prerequisites*/}'), { id: 'prerequisites', problem: null });
  assert.equal(uaHeadingId('Передумови').problem, 'missing');
});

test('Check 3: table count, columns and rows', () => {
  const rows = compare(UA, edit(EN, "| `name` | String | Name, [more](#record-statuses) |\n", ''));
  assert.ok(flags(rows).includes('TABLE-MISMATCH'));
  assert.match(rows.warnings.find((w) => w.flag === 'TABLE-MISMATCH').description, /table 1: main 3 columns x 2 rows, secondary 3 columns x 1 rows/);

  const cols = compare(UA, edit(EN, '| Field | Type | Description |', '| Field | Type |'));
  assert.deepEqual(flags(cols), ['TABLE-MISMATCH']);

  const count = compare(UA, EN + '\n| A | B |\n|---|---|\n| 1 | 2 |\n');
  assert.deepEqual(flags(count), ['TABLE-MISMATCH']);
  assert.match(count.warnings[0].description, /main has 1 table\(s\), secondary has 2/);

  assert.equal(cellCount('| a | b \\| c | d |'), 3);
  assert.equal(cellCount('a | b'), 2);
});

test('Check 6: code blocks are identical', () => {
  const content = compare(UA, edit(EN, '{ "status": "active" }', '{ "status": "inactive" }'), { secondaryPath: 'en.md' });
  assert.deepEqual(content.bugs, [
    { check: 6, flag: 'CODE-BLOCK-MISMATCH', description: 'code block 1 differs from line 1 of the block (contents must be byte-for-byte identical)', line: 25, file: 'en.md' },
  ]);
  // Whitespace counts.
  assert.deepEqual(flags(compare(UA, edit(EN, '{ "status": "active" }', '{ "status": "active" } '))), ['CODE-BLOCK-MISMATCH']);
  // The info string is not part of the contents.
  assert.deepEqual(flags(compare(UA, edit(EN, '```json', '```json title="Response"'))), []);

  const count = compare(UA, edit(EN, '```json\n{ "status": "active" }\n```\n', ''));
  assert.deepEqual(flags(count), ['CODE-BLOCK-MISMATCH']);
  assert.match(count.bugs[0].description, /main has 1 code block\(s\), secondary has 0/);
});

test('Check 7: <details> block count', () => {
  const r = compare(UA, edit(EN, '<details>\n<summary>More</summary>\n\nText. {/* NEEDS CONFIRMATION: чи є інші статуси */}\n\n</details>\n', 'Text. {/* NEEDS CONFIRMATION: чи є інші статуси */}\n'));
  assert.deepEqual(flags(r), ['DETAILS-BLOCK-COUNT-MISMATCH']);
  assert.equal(r.warnings[0].check, 7);
  // A tag in inline code or a code block is not a block.
  const mention = 'Use `<details>` for long lists.\n\n```html\n<details></details>\n```\n';
  assert.deepEqual(flags(compare(UA, EN + mention)), ['CODE-BLOCK-MISMATCH']);
  assert.deepEqual(flags(compare(UA + mention, EN + mention)), []);
});

test('Check 8: ToDo and NEEDS CONFIRMATION markers', () => {
  const inSecondary = compare(UA, edit(EN, ' {/* ToDo: уточнити формат */}', ''), { mainPath: 'ua.md' });
  assert.deepEqual(inSecondary.warnings, [
    { check: 8, flag: 'MARKER-MISSING-IN-SECONDARY', description: "ToDo marker in main has no counterpart in secondary (under '## Передумови'): 'уточнити формат'", line: 15, file: 'ua.md' },
  ]);

  const inMain = compare(UA, EN + '\n{/* NEEDS CONFIRMATION: extra */}\n', { secondaryPath: 'en.md' });
  assert.deepEqual(flags(inMain), ['MARKER-MISSING-IN-MAIN']);
  assert.equal(inMain.warnings[0].file, 'en.md');

  // Same totals, different sections: a gap on each side.
  const moved = compare(UA, edit(edit(EN, ' {/* ToDo: уточнити формат */}', ''), 'Intro.', 'Intro. {/* ToDo: уточнити формат */}'));
  assert.deepEqual(flags(moved).sort(), ['MARKER-MISSING-IN-MAIN', 'MARKER-MISSING-IN-SECONDARY']);

  // A marker over several lines counts once, on its first line.
  const multi = '\n{/* ToDo: перший рядок\n   другий рядок */}\n';
  const r = compare(UA + multi, EN);
  assert.deepEqual(flags(r), ['MARKER-MISSING-IN-SECONDARY']);
  assert.equal(r.warnings[0].line, UA.split('\n').length + 1);
  assert.match(r.warnings[0].description, /'перший рядок другий рядок'/);
  // A marker in inline code is not a marker.
  assert.deepEqual(flags(compare(UA + '\nПриклад: `{/* ToDo: x */}`.\n', EN + '\nExample: `{/* ToDo: y */}`.\n')), []);
});

test('image, link and admonition counts', () => {
  const img = compare(UA, edit(EN, '<img src="./.assets/active.png" alt="Active" />\n', ''));
  assert.deepEqual(flags(img), ['IMAGE-COUNT-MISMATCH']);
  assert.equal(img.warnings[0].check, null);
  assert.equal(img.warnings[0].file, 'main');

  // A link in a table row counts.
  const link = compare(UA, edit(EN, 'Name, [more](#record-statuses)', 'Name'));
  assert.deepEqual(flags(link), ['LINK-COUNT-MISMATCH']);
  assert.match(link.warnings[0].description, /main has 2, secondary has 1/);

  const adm = compare(UA, edit(EN, ':::note', ':::tip'));
  assert.deepEqual(flags(adm), ['ADMONITION-MISMATCH']);
  assert.match(adm.warnings[0].description, /main \{"note":1\}, secondary \{"tip":1\}/);
});

test('CLI: one JSON report, exit 0 with or without findings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-align-'));
  const ua = path.join(dir, 'ua.md');
  const en = path.join(dir, 'en.md');
  await fs.writeFile(ua, UA);
  await fs.writeFile(en, EN);
  const ok = await cli(ua, en);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(Object.keys(ok.out), ['main', 'secondary', 'ua', 'bugs', 'warnings', 'passed']);
  assert.equal(ok.out.main, ua);
  assert.equal(ok.out.passed.length, ALL_PASSED.length);

  await fs.writeFile(en, edit(EN, '### Active record', '## Active record'));
  const bad = await cli(ua, en);
  assert.equal(bad.code, 0);
  assert.deepEqual(bad.out.bugs.map((b) => b.flag), ['HEADING-LEVEL-MISMATCH']);
  assert.equal(bad.out.bugs[0].file, en);

  const forced = await cli(ua, en, '--ua', 'secondary');
  assert.equal(forced.out.ua, 'secondary');

  const help = await cli('--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /doc-align <main-file> <secondary-file>/);
});

test('CLI: exit 2 for bad usage or an unreadable file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-align-'));
  const ua = path.join(dir, 'ua.md');
  await fs.writeFile(ua, UA);
  for (const [args, message] of [
    [[ua], /expected two files, got 1/],
    [[ua, ua, ua], /expected two files, got 3/],
    [[ua, path.join(dir, 'missing.md')], /file not found/],
    [[ua, dir], /not a file/],
    [[ua, ua, '--ua', 'en'], /--ua takes 'main' or 'secondary'/],
    [[ua, ua, '--compact'], /Unknown option/],
  ]) {
    const r = await cli(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out.error, message);
    assert.match(r.stderr, /^doc-align: /);
  }
});
