import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compare } from '../lib/compare.mjs';
import { cellCount, parse } from '../lib/parse.mjs';
import { createSlugger, enHeadingIds, headingText, slugify, uaHeadingId } from '../lib/headings.mjs';
import { findNames, looseKey, mergeRows, parseNamesTable, searchable } from '../lib/names.mjs';
import { headingIdMismatches, proposeIds, renameIds, withExplicitId } from '../lib/ids.mjs';
import { isIdOnlyChange } from '../lib/idonly.mjs';
import { codeDiff, fenceBlock, fenceParts } from '../lib/fences.mjs';

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
  'Code blocks keep their code',
  'No Cyrillic in EN diagram labels or code comments',
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

test('Check 6: code blocks keep their code', () => {
  const content = compare(UA, edit(EN, '{ "status": "active" }', '{ "status": "inactive" }'), { secondaryPath: 'en.md' });
  assert.deepEqual(content.bugs, [
    {
      check: 6,
      flag: 'CODE-BLOCK-MISMATCH',
      description: 'code block 1 differs from line 1 of the block (the code, data and line count must be identical; only labels, comments and descriptions are translated)',
      line: 25,
      file: 'en.md',
    },
  ]);
  // Whitespace counts.
  assert.deepEqual(flags(compare(UA, edit(EN, '{ "status": "active" }', '{ "status": "active" } '))), ['CODE-BLOCK-MISMATCH']);
  // The info string is not part of the contents.
  assert.deepEqual(flags(compare(UA, edit(EN, '```json', '```json title="Response"'))), []);

  const count = compare(UA, edit(EN, '```json\n{ "status": "active" }\n```\n', ''));
  assert.deepEqual(flags(count), ['CODE-BLOCK-MISMATCH']);
  assert.match(count.bugs[0].description, /main has 1 code block\(s\), secondary has 0/);
});

// A pair whose code blocks hold reader text (code-blocks.md): diagram labels, comments and a tree's descriptions are
// translated in EN, the code and the data are not.
const fence = (info, body) => `\`\`\`${info}\n${body}\n\`\`\`\n`;
const CODE_UA = [
  '# Заявки',
  '',
  '## Потік {/* #flow */}',
  '',
  fence('mermaid', '%%{init: {"theme": "base"}}%%\nflowchart TD\n    A[Нова заявка] --> B{Сума більша за ліміт?}\n    B -->|Так| C(("Перевірка"))\n    B -- ні --> D[Заявку прийнято]\n    subgraph S1["Ручна перевірка"]\n        C\n    end'),
  fence('mermaid', 'sequenceDiagram\n    participant App as Застосунок\n    participant Srv as Ваш сервер\n    App->>Srv: Надіслати заявку\n    alt Відповідь 200\n        Srv-->>App: 200 OK\n    else Немає відповіді\n        Note over App,Srv: Повтор через 10 хвилин\n    end'),
  fence('mermaid', 'stateDiagram-v2\n    [*] --> draft: створено\n    state "Чернетка" as draft\n    draft --> [*]'),
  fence('bash', '# Запустити сервіс\nnode app.js --port 8080   # порт за замовчуванням\necho "# не коментар" ${#items}'),
  fence('jsonc', '{\n  // Сума в копійках\n  "amount": 1500, /* обов\'язково */\n  "callback": "https://example.com/hook" // адреса для сповіщень\n}'),
  fence('sql', "SELECT id FROM requests -- усі заявки\nWHERE note = 'не -- коментар';"),
  fence('text', 'service/\n├── api/        — обробники запитів\n└── store/      — збереження заявок'),
  fence('json', '{ "payer": "Олена Коваль", "purpose": "Оплата // рахунку 42", "url": "https://example.com/a" }'),
].join('\n');
const CODE_EN = [
  '# Requests',
  '',
  '## Flow',
  '',
  fence('mermaid', '%%{init: {"theme": "base"}}%%\nflowchart TD\n    A[New request] --> B{Amount above the limit?}\n    B -->|Yes| C(("Review"))\n    B -- no --> D[Request accepted]\n    subgraph S1["Manual review"]\n        C\n    end'),
  fence('mermaid', 'sequenceDiagram\n    participant App as App\n    participant Srv as Your server\n    App->>Srv: Send the request\n    alt Response 200\n        Srv-->>App: 200 OK\n    else No response\n        Note over App,Srv: Retry in 10 minutes\n    end'),
  fence('mermaid', 'stateDiagram-v2\n    [*] --> draft: created\n    state "Draft" as draft\n    draft --> [*]'),
  fence('bash', '# Start the service\nnode app.js --port 8080   # default port\necho "# не коментар" ${#items}'),
  fence('jsonc', '{\n  // Amount in cents\n  "amount": 1500, /* required */\n  "callback": "https://example.com/hook" // notification address\n}'),
  fence('sql', "SELECT id FROM requests -- all requests\nWHERE note = 'не -- коментар';"),
  fence('text', 'service/\n├── api/        — request handlers\n└── store/      — request storage'),
  fence('json', '{ "payer": "Олена Коваль", "purpose": "Оплата // рахунку 42", "url": "https://example.com/a" }'),
].join('\n');
const codeFindings = (en) => findings(compare(CODE_UA, en, { secondaryPath: 'en.md' })).filter((f) => f.check === 6 || f.check === 9);

test('Check 6: translated diagram labels, comments and tree descriptions pass; the data keeps its Cyrillic (AC-1)', () => {
  const r = compare(CODE_UA, CODE_EN, { mainPath: 'ua.md', secondaryPath: 'en.md' });
  assert.deepEqual(codeFindings(CODE_EN), []);
  assert.ok(passedNames(r).includes('Code blocks keep their code'));
  assert.ok(passedNames(r).includes('No Cyrillic in EN diagram labels or code comments'));
  // EN as main works the same.
  assert.deepEqual(findings(compare(CODE_EN, CODE_UA)).filter((f) => f.check === 6 || f.check === 9), []);
});

test('Check 6: a changed id, arrow, keyword, line count, code token, value or whitespace fails (AC-1)', () => {
  const cases = [
    ['a flowchart id', 'A[New request] --> B{', 'A[New request] --> X{'],
    ['a flowchart arrow', 'B -->|Yes|', 'B ==>|Yes|'],
    ['a subgraph id', 'subgraph S1["Manual review"]', 'subgraph S2["Manual review"]'],
    ['the init directive', '{"theme": "base"}', '{"theme": "dark"}'],
    ['a sequence keyword', '    else No response', '    opt No response'],
    ['a participant id', 'participant Srv as Your server', 'participant Server as Your server'],
    ['a message arrow', 'App->>Srv: Send', 'App->Srv: Send'],
    ['a state transition', '[*] --> draft: created', '[*] --> drafted: created'],
    ['a diagram line added', '    draft --> [*]', '    draft --> [*]\n    draft --> draft'],
    ['a code token next to a comment', 'node app.js --port 8080', 'node app.js --port 9090'],
    ['whitespace before a comment', '8080   # default port', '8080 # default port'],
    ['a comment marker', '  // Amount in cents', '  # Amount in cents'],
    ['a JSON value in a commented block', '"amount": 1500', '"amount": 15'],
    ['a string that holds //', "'не -- коментар'", "'not -- a comment'"],
    ['a code line added', '// notification address\n}', '// notification address\n  // more\n}'],
    ['a tree path', '├── api/        — request handlers', '├── handlers/   — request handlers'],
    ['a JSON data value', '"payer": "Олена Коваль"', '"payer": "Olena Koval"'],
    ['a URL in a JSON block', '"url": "https://example.com/a"', '"url": "https://example.org/a"'],
  ];
  for (const [name, from, to] of cases) {
    const got = codeFindings(edit(CODE_EN, from, to));
    assert.deepEqual(got.map((f) => f.flag), ['CODE-BLOCK-MISMATCH'], name);
  }
  // The finding points at the first line that differs.
  const [f] = codeFindings(edit(CODE_EN, '8080   # default port', '8080 # default port'));
  assert.equal(f.line, CODE_EN.split('\n').indexOf('node app.js --port 8080   # default port') + 1);
  assert.match(f.description, /^code block 4 differs from line 2 of the block \(the code, data and line count/);
  const [d] = codeFindings(edit(CODE_EN, 'A[New request] --> B{', 'A[New request] --> X{'));
  assert.match(d.description, /the diagram ids, keywords, arrows and lines must be identical/);
});

test('Check 9: Cyrillic left in an EN diagram label, comment or tree description is a bug; data is not (AC-1)', () => {
  const cases = [
    ['a node label', 'A[New request]', 'A[Нова заявка]', 'Нова заявка'],
    ['an edge label', '-->|Yes|', '-->|Так|', 'Так'],
    ['a participant alias', 'as Your server', 'as Ваш сервер', 'Ваш сервер'],
    ['a message', 'Send the request', 'Надіслати заявку', 'Надіслати заявку'],
    ['a note', 'Retry in 10 minutes', 'Повтор через 10 хвилин', 'Повтор через 10 хвилин'],
    ['a state label', 'state "Draft"', 'state "Чернетка"', 'Чернетка'],
    ['a # comment', '# Start the service', '# Запустити сервіс', 'Запустити сервіс'],
    ['a // comment', '// Amount in cents', '// Сума в копійках', 'Сума в копійках'],
    ['a /* */ comment', '/* required */', "/* обов'язково */", "обов'язково"],
    ['a -- comment', '-- all requests', '-- усі заявки', 'усі заявки'],
    ['a tree description', '— request handlers', '— обробники запитів', 'обробники запитів'],
  ];
  for (const [name, from, to, text] of cases) {
    const en = edit(CODE_EN, from, to);
    const got = codeFindings(en);
    assert.deepEqual(got.map((f) => [f.check, f.flag]), [[9, 'CYRILLIC-IN-EN-CODE-TEXT']], name);
    assert.ok(got[0].description.includes(`'${text}'`), `${name}: ${got[0].description}`);
    assert.equal(en.split('\n')[got[0].line - 1].includes(to.split('\n')[0]), true, `${name}: the line`);
    assert.equal(got[0].file, 'en.md');
  }
  // Cyrillic in the code part (a JSON value, a string a comment marker sits in) is data, not a finding: CODE_EN has it.
  assert.ok(CODE_EN.includes('"Олена Коваль"') && CODE_EN.includes('"# не коментар"'));
  // The UA page is never checked for it, and with no way to tell which page is UA the check doesn't run.
  const latin = (t) => t.replace(/\p{Script=Cyrillic}+/gu, 'x');
  const r = compare(latin(CODE_EN), latin(CODE_EN));
  assert.equal(r.ua, null);
  assert.ok(!passedNames(r).includes('No Cyrillic in EN diagram labels or code comments'));
});

test('fences: the code part and the reader text of each kind of block', () => {
  const parts = (info, body) => {
    const p = fenceParts(info, body.split('\n'));
    return [p.kind, p.code.join('\n'), p.texts.map((t) => t.text)];
  };
  assert.deepEqual(parts('mermaid', 'flowchart LR\n  A(("Коло")) -.  пунктир .-> B>Прапорець]\n  classDef warn fill:#f96'), [
    'diagram',
    'flowchart LR\n  A((…)) -.  … .-> B>…]\n  classDef warn fill:#f96',
    ['Коло', 'пунктир', 'Прапорець'],
  ]);
  // Keywords of other diagram types are node ids in a flowchart; in a sequence diagram `link` is a kept line.
  assert.deepEqual(parts('mermaid', 'flowchart LR\n  details[Деталі] --> link[Посилання]'), ['diagram', 'flowchart LR\n  details[…] --> link[…]', ['Деталі', 'Посилання']]);
  assert.deepEqual(parts('mermaid', 'sequenceDiagram\n  link A: Панель @ https://example.com'), ['diagram', 'sequenceDiagram\n  link A: Панель @ https://example.com', []]);
  // A subgraph title without an id is the title; one ASCII word is an id.
  assert.deepEqual(parts('mermaid', 'graph TD\n  subgraph Перша група\n  end\n  subgraph g2\n  end'), ['diagram', 'graph TD\n  subgraph …\n  end\n  subgraph g2\n  end', ['Перша група']]);
  // Frontmatter title, %% comments and a multi-line state note are text; the init directive is code.
  assert.deepEqual(parts('mermaid', '---\ntitle: Життєвий цикл\n---\n%%{init: {"theme": "dark"}}%%\nstateDiagram-v2\n  %% коментар\n  note right of a\n    Примітка\n  end note'), [
    'diagram',
    '---\ntitle: …\n---\n%%{init: {"theme": "dark"}}%%\nstateDiagram-v2\n  %%…\n  note right of a\n    …\n  end note',
    ['Життєвий цикл', 'коментар', 'Примітка'],
  ]);
  // A diagram type without its own rules keeps its indentation; the rest of each line is text.
  assert.deepEqual(parts('mermaid', 'mindmap\n  root\n    Гілка'), ['diagram', 'mindmap\n  …\n    …', ['root', 'Гілка']]);
  // A shebang is code; `#` inside a word or a string is not a comment.
  assert.deepEqual(parts('sh', '#!/bin/sh\nx=${#arr} # довжина\necho "a # b"'), ['comments', '#!/bin/sh\nx=${#arr} #…\necho "a # b"', ['довжина']]);
  // A block comment spans lines.
  assert.deepEqual(parts('go', '/* Перший\n * другий */\nx := 1'), ['comments', '/*…\n…*/\nx := 1', ['Перший', '* другий']]);
  assert.deepEqual(parts('html', '<p>Don\'t</p> <!-- примітка -->'), ['comments', "<p>Don't</p> <!--…-->", ['примітка']]);
  // json has no comments, and a language not in the table is all code.
  assert.deepEqual(parts('json', '{ "a": 1 } // Сума'), ['code', '{ "a": 1 } // Сума', []]);
  assert.deepEqual(parts('http', '# Запит\nGET /a'), ['code', '# Запит\nGET /a', []]);
  // Plain text: only the part after ` — ` is a description; the info string's first word is the language.
  assert.deepEqual(parts('', 'a/ — опис\nb—c'), ['plain', 'a/ — …\nb—c', ['опис']]);
  assert.equal(fenceParts('json title="Відповідь"', ['{}']).lang, 'json');
  // An emptied label or comment is a difference.
  assert.equal(codeDiff({ info: 'js', lines: ['x // а'] }, { info: 'js', lines: ['x //'] }), 0);
  assert.equal(codeDiff({ info: 'js', lines: ['x // а'] }, { info: 'js', lines: ['x // b'] }), -1);
  assert.deepEqual(fenceBlock(['~~~yaml title="x"', 'a: 1', '~~~']), { info: 'yaml title="x"', lines: ['a: 1'] });
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

// Check 12: names of organizations against a names table (Ж10). Invented organizations.
const NAMES_UA = `---
name: Глосарій — українська
---

## Терміни

| Термін | Рендер | Код-сутність | Визначення |
|---|---|---|---|
| Обліковий запис | \`текст\` | | Набір даних користувача. |

## Назви

| Форма UA | Форма EN | Джерело |
|---|---|---|
| Лунобанк | Lunobank | site: https://lunobank.example/ (UA), https://lunobank.example/en/ (EN) |
| Банк Світанок | Svitanok Bank | site: https://svitanok.example/ |
| fluxpay | fluxpay | app: \`providers.fluxpay\` |
| A-Pay | A-Pay | site: https://a-pay.example/ |
`;

const NAMES_EN = NAMES_UA.replace('## Назви', '## Names').replace('| Форма UA | Форма EN | Джерело |', '| UA form | EN form | Source |');

const tableOf = (text, file = 'glossary-ua.md') => {
  const t = parseNamesTable(text);
  return { tables: [{ file, found: t.found }], rows: t.rows };
};

const NUA = `# Оплата

## Банки {/* #banks */}

Клієнт платить через Лунобанк або Банк Світанок. Гроші надходять у Лунобанку за хвилину.

Провайдер fluxpay приймає картки. У полі \`provider\` передайте \`LunoBANK\`. Кнопка **Оплатити в LunoBank** відкриває форму.

Докладніше — на [сайті банку](https://lunobank.example/ua/).
`;

const NEN = `# Payment

## Banks

The client pays through Lunobank or Svitanok Bank. Money reaches Lunobank's account within a minute.

The fluxpay provider accepts cards. In the \`provider\` field, pass \`LunoBANK\`. The **Pay in LunoBank** button opens the form.

Open a pay slip on the [bank's site](https://lunobank.example/en/).
`;

test('Check 12: names table parsing', () => {
  const ua = parseNamesTable(NAMES_UA);
  assert.equal(ua.found, true);
  assert.deepEqual(ua.rows.map((r) => [r.ua, r.en]), [['Лунобанк', 'Lunobank'], ['Банк Світанок', 'Svitanok Bank'], ['fluxpay', 'fluxpay'], ['A-Pay', 'A-Pay']]);
  assert.equal(ua.rows[0].line, 15);
  assert.deepEqual(parseNamesTable(NAMES_EN).rows, ua.rows);
  assert.deepEqual(parseNamesTable('## Terms\n\n| a | b |\n|---|---|\n| x | y |\n'), { found: false, rows: [] });
  // The same table in both glossaries gives each row once.
  assert.equal(mergeRows([parseNamesTable(NAMES_UA), parseNamesTable(NAMES_EN)]).length, 4);
  assert.equal(looseKey('Соно банк'), looseKey('Sonobank'));
  assert.equal(looseKey('ВітрБанк'), looseKey('VitrBank'));
});

test('Check 12: a UA/EN pair from the table is not a mismatch', () => {
  const r = compare(NUA, NEN, { mainPath: 'ua.md', secondaryPath: 'en.md', names: tableOf(NAMES_UA) });
  assert.deepEqual(findings(r).filter((f) => f.check === 12), []);
  assert.ok(r.passed.some((p) => p.check === 12 && p.name === 'Names follow the names table'));
  assert.deepEqual(r.names, {
    rows: 4,
    found: [
      { ua: 'Лунобанк', en: 'Lunobank', main: 2, secondary: 2 },
      { ua: 'Банк Світанок', en: 'Svitanok Bank', main: 1, secondary: 1 },
      { ua: 'fluxpay', en: 'fluxpay', main: 1, secondary: 1 },
    ],
  });
  // EN as main gives the same result.
  assert.deepEqual(compare(NEN, NUA, { names: tableOf(NAMES_EN) }).warnings.filter((f) => f.check === 12), []);
  // Without --names there is no Check 12 and no names field.
  const plain = compare(NUA, NEN);
  assert.equal(plain.names, undefined);
  assert.ok(!plain.passed.some((p) => p.check === 12));
});

test('Check 12: a code value or a UI label keeps its own form (Ж1, Ж4)', () => {
  // `LunoBANK` (the code's value) and **LunoBank** (a label) differ from the table's forms and are not reported.
  const r = compare(NUA, NEN, { names: tableOf(NAMES_UA) });
  assert.ok(!r.warnings.some((f) => /LunoBANK|LunoBank/.test(f.description)));
  // The same spelling in prose is reported.
  const prose = compare(edit(NUA, 'Гроші надходять у Лунобанку', 'Гроші надходять у LunoBank'), NEN, { names: tableOf(NAMES_UA) });
  assert.deepEqual(flags(prose), ['NAME-SPELLING']);
  assert.match(prose.warnings[0].description, /'LunoBank' is not the names table's UA form 'Лунобанк'/);
});

test('Check 12: a spelling that differs from the table is reported on its line', () => {
  const ua = edit(edit(NUA, 'через Лунобанк', 'через Луно банк'), 'Провайдер fluxpay', 'Провайдер Fluxpay');
  const en = edit(NEN, 'through Lunobank', 'through LunoBank');
  const r = compare(ua, en, { mainPath: 'ua.md', secondaryPath: 'en.md', names: tableOf(NAMES_UA) });
  assert.deepEqual(r.warnings.map((f) => [f.flag, f.line, f.file]), [
    ['NAME-SPELLING', 5, 'ua.md'],
    ['NAME-SPELLING', 7, 'ua.md'],
    ['NAME-SPELLING', 5, 'en.md'],
  ]);
  assert.match(r.warnings[0].description, /'Луно банк' is not the names table's UA form 'Лунобанк'/);
  assert.match(r.warnings[1].description, /'Fluxpay' is not the names table's UA form 'fluxpay'/);
  assert.match(r.warnings[2].description, /'LunoBank' is not the names table's EN form 'Lunobank'/);
});

test('Check 12: a name in one page only, and words that only look like a name', () => {
  const r = compare(NUA, edit(NEN, 'through Lunobank or Svitanok Bank', 'through Lunobank'), { names: tableOf(NAMES_UA) });
  assert.deepEqual(flags(r), ['NAME-MISSING-IN-SECONDARY']);
  assert.match(r.warnings[0].description, /'Банк Світанок' \/ 'Svitanok Bank' is named in main \(1x\), not in secondary/);
  // "a pay slip" is not A-Pay; a link target and a URL are not prose.
  assert.ok(!compare(NUA, NEN, { names: tableOf(NAMES_UA) }).names.found.some((f) => f.en === 'A-Pay'));
  // A name in capitals only is not the ordinary word: "Tap" and "tap" are not TAP.
  const caps = { tables: [{ file: 'g.md', found: true }], rows: [{ ua: 'TAP', en: 'TAP', source: '' }] };
  const en = 'Tap **Save**, then tap the row. Pay with TAP or Tap-Pay. Pay with TaP.\n';
  assert.deepEqual(findNames(searchable(en.split('\n')), caps.rows, 'en').map((h) => [h.text, h.exact]), [['TAP', true], ['TaP', false]]);
  // A one-word name that is also an ordinary word ("Tap" the organization): the verb in lower case and the word
  // that opens a step, a sentence or a cell are not the name; "TAP" and "Tap" mid-sentence are.
  const word = [{ ua: 'Tap', en: 'Tap', source: '' }];
  const steps = '1. Tap **Save**.\n2. Then tap the row. Tap opens it.\n| Tap | the Tap merchant ID, issued by TAP |\n';
  assert.deepEqual(findNames(searchable(steps.split('\n')), word, 'en').map((h) => [h.text, h.line, h.exact]), [['Tap', 3, true], ['TAP', 3, false]]);
});

test('Check 12: a five-column names table (UI forms, API values)', () => {
  const t = parseNamesTable('## Names\n\n| UA form | EN form | UI forms | API values | Source |\n|---|---|---|---|---|\n| Лунобанк | Lunobank | LUNOBANK (admin) | `LUNO` (`bank`) | site: https://lunobank.example/ |\n');
  assert.deepEqual(t.rows, [{ ua: 'Лунобанк', en: 'Lunobank', source: 'site: https://lunobank.example/', line: 5, ui: 'LUNOBANK (admin)', api: '`LUNO` (`bank`)' }]);
  // Only the organization's own forms are compared with prose: the UI form in bold and the value in code are not
  // findings, and the same UI form in prose is.
  const ua = '# A\n\nВиберіть **LUNOBANK** і передайте `LUNO`. Оплата через Лунобанк.\n';
  const en = '# A\n\nSelect **LUNOBANK** and pass `LUNO`. Payment through Lunobank.\n';
  const names = { tables: [{ file: 'g.md', found: true }], rows: t.rows };
  assert.deepEqual(findings(compare(ua, en, { names })).filter((f) => f.check === 12), []);
  assert.deepEqual(flags(compare(ua, edit(en, 'through Lunobank', 'through LUNOBANK'), { names })), ['NAME-SPELLING']);
});

test('Check 12: no names table, or no UA page', () => {
  const none = compare(NUA, NEN, { names: { tables: [{ file: 'glossary-ua.md', found: false }], rows: [] } });
  assert.deepEqual(flags(none), ['NAMES-TABLE-MISSING']);
  assert.equal(none.warnings[0].file, 'glossary-ua.md');
  const skipped = compare(NEN, NEN, { names: tableOf(NAMES_UA) });
  assert.ok(flags(skipped).includes('NAMES-SKIPPED'));
});

test('CLI: --names reads the names table from one or more glossaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-align-'));
  const files = { ua: path.join(dir, 'ua.md'), en: path.join(dir, 'en.md'), gua: path.join(dir, 'glossary-ua.md'), gen: path.join(dir, 'glossary-en.md') };
  await fs.writeFile(files.ua, NUA);
  await fs.writeFile(files.en, edit(NEN, 'through Lunobank', 'through Monolith'));
  await fs.writeFile(files.gua, NAMES_UA);
  await fs.writeFile(files.gen, NAMES_EN);
  const r = await cli(files.ua, files.en, '--names', files.gua, '--names', files.gen);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.out), ['main', 'secondary', 'ua', 'bugs', 'warnings', 'passed', 'names']);
  assert.equal(r.out.names.rows, 4);
  assert.deepEqual(r.out.warnings.map((w) => w.flag), []);
  assert.deepEqual(r.out.names.found[0], { ua: 'Лунобанк', en: 'Lunobank', main: 2, secondary: 1 });
  const missing = await cli(files.ua, files.en, '--names', path.join(dir, 'nope.md'));
  assert.equal(missing.code, 2);
  assert.match(missing.out.error, /file not found/);
});

// --propose-ids: the missing UA heading ids, taken from the EN anchors, and the links to the old fragments
// (heading-anchors.md, rules 2, 6 and 8). Invented pages.
const IDS_UA = `---
title: Баланси
---

# Баланси

Дивіться [огляд](#огляд-балансів), [перший довідник](#довідкова-інформація) і [другий](#довідкова-інформація-1).

## Огляд балансів

Текст. \`[код](#огляд-балансів)\`

### Фільтри

\`\`\`md
[у коді](#фільтри)
\`\`\`

## Довідкова інформація

## Готовий розділ {/* #ready-section */}

## Довідкова інформація

## Комісії й ліміти

## Повтор
`;

const IDS_EN = `---
title: Balances
---

# Balances

See the [overview](#balances-overview), the [first reference](#reference-information-create-balance) and the [second](#reference-information-close-balance). The [filters](#фільтри) link was copied from UA.

## Balances overview

Text. \`[code](#balances-overview)\`

### Filters

\`\`\`md
[in code](#фільтри)
\`\`\`

## Reference information {#reference-information-create-balance}

## Ready section

## Reference information {#reference-information-close-balance}

## Fees & limits

## Ready section
`;

async function idsFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-align-ids-'));
  const put = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  await put('docs/02-balances/balances.md', IDS_UA);
  await put('i18n/en/current/02-balances/balances.md', IDS_EN);
  await put(
    'docs/other/other.md',
    [
      '# Інша',
      '',
      '[a](/balances/#огляд-балансів) [b](/02-balances/balances#%D1%84%D1%96%D0%BB%D1%8C%D1%82%D1%80%D0%B8) [c](../02-balances/balances.md#огляд-балансів)',
      '[d](/other/#огляд-балансів) [e](../02-balances/#фільтри) [f](https://example.com/balances/#огляд-балансів) [g](/02-balances/balances.md#фільтри)',
      '<Link to="/balances/#фільтри">h</Link>',
      '',
    ].join('\n'),
  );
  await put('docs/.sources/notes.md', '[x](/balances/#огляд-балансів)\n');
  return { dir, ua: path.join(dir, 'docs/02-balances/balances.md'), en: path.join(dir, 'i18n/en/current/02-balances/balances.md'), other: path.join(dir, 'docs/other/other.md'), root: path.join(dir, 'docs') };
}

test('--propose-ids: each id is the EN anchor at the same position, explicit or generated (AC-1)', async () => {
  const r = await proposeIds(IDS_UA, IDS_EN, { uaPath: 'ua.md', enPath: 'en.md' });
  const rows = r.proposals.map((p) => [p.line, p.id, p.from, p.oldFragment, p.problem ?? null]);
  assert.deepEqual(rows.slice(0, 4), [
    [9, 'balances-overview', 'generated', 'огляд-балансів', null],
    [13, 'filters', 'generated', 'фільтри', null],
    [19, 'reference-information-create-balance', 'explicit', 'довідкова-інформація', null],
    [23, 'reference-information-close-balance', 'explicit', 'довідкова-інформація-1', null],
  ]);
  assert.equal(r.proposals.length, 6);
  // A slug that is not kebab-case is not written.
  assert.deepEqual(rows[4].slice(0, 2), [25, 'fees--limits']);
  assert.match(rows[4][4], /not lowercase ASCII kebab-case/);
  // The second "Ready section" gets `ready-section-1` in EN, numbered like Docusaurus numbers it: a valid id.
  assert.deepEqual(rows[5], [27, 'ready-section-1', 'generated', 'повтор', null]);
  assert.deepEqual(
    r.links.map((l) => [l.file, l.line, l.url, l.newUrl]),
    [
      ['ua.md', 7, '#огляд-балансів', '#balances-overview'],
      ['ua.md', 7, '#довідкова-інформація', '#reference-information-create-balance'],
      ['ua.md', 7, '#довідкова-інформація-1', '#reference-information-close-balance'],
      ['en.md', 7, '#фільтри', '#filters'],
    ],
    'links in inline code and code blocks are not links; an EN link copied from UA is found too',
  );
  assert.deepEqual(r.warnings, ['no --root given: only links on the UA and EN pages themselves are found']);

  // An id another UA heading already has is not written either.
  const taken = await proposeIds('# Т\n\n## Огляд {/* #overview */}\n\n## Вступ\n', '# T\n\n## Overview\n\n## Overview {#overview}\n', { uaPath: 'ua.md', enPath: 'en.md' });
  assert.match(taken.proposals[0].problem, /already the id of the UA heading on line 3/);
});

test('--propose-ids: links across the roots by route, file path and relative .md path; the rest unresolved', async () => {
  const f = await idsFixture();
  const r = await proposeIds(IDS_UA, IDS_EN, { uaPath: f.ua, enPath: f.en, roots: [{ dir: f.root, prefix: '/' }] });
  const other = r.links.filter((l) => l.file.endsWith('other/other.md')).map((l) => [l.line, l.url, l.newUrl]);
  assert.deepEqual(other, [
    [3, '/balances/#огляд-балансів', '/balances/#balances-overview'],
    [3, '/02-balances/balances#%D1%84%D1%96%D0%BB%D1%8C%D1%82%D1%80%D0%B8', '/02-balances/balances#filters'],
    [3, '../02-balances/balances.md#огляд-балансів', '../02-balances/balances.md#balances-overview'],
    [4, '/02-balances/balances.md#фільтри', '/02-balances/balances.md#filters'],
    [5, '/balances/#фільтри', '/balances/#filters'],
  ]);
  assert.deepEqual(r.unresolved.map((u) => [u.line, u.url]), [[4, '../02-balances/#фільтри']]);
  assert.ok(!r.links.some((l) => l.url.startsWith('/other/') || l.url.startsWith('https:')), 'a link to another page or site is not listed');
  assert.ok(!r.links.some((l) => l.file.includes('.sources')), 'folders starting with a dot are not searched');
  assert.equal(r.warnings, undefined);
});

test('--propose-ids: nothing is proposed when the heading counts differ; an explicit {#id} on a UA heading is skipped', async () => {
  const r = await proposeIds(IDS_UA, IDS_EN.replace('## Fees & limits\n\n', ''), { uaPath: 'ua.md', enPath: 'en.md' });
  assert.equal(r.proposals.length, 0);
  assert.match(r.reason, /positions don't line up/);
  assert.equal(r.skipped.length, 6);
  const ex = await proposeIds('# Т\n\n## Огляд {#overview}\n', '# T\n\n## Overview\n', { uaPath: 'ua.md', enPath: 'en.md' });
  assert.deepEqual([ex.proposals.length, ex.skipped.length], [0, 1]);
  assert.match(ex.skipped[0].reason, /explicit id/);
  const none = await proposeIds('# Т\n\n## Огляд {/* #overview */}\n', '# T\n\n## Overview\n', { uaPath: 'ua.md', enPath: 'en.md' });
  assert.deepEqual([none.proposals, none.links, none.skipped], [[], [], []]);
});

test('CLI --propose-ids --write: only the id comments and the link fragments change', async () => {
  const f = await idsFixture();
  const before = { ua: await fs.readFile(f.ua, 'utf8'), other: await fs.readFile(f.other, 'utf8'), en: await fs.readFile(f.en, 'utf8') };
  const dry = await cli(f.ua, f.en, '--propose-ids', '--root', `${f.root}=/`);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(Object.keys(dry.out), ['ua', 'en', 'proposals', 'links', 'unresolved', 'skipped']);
  assert.equal(await fs.readFile(f.ua, 'utf8'), before.ua, 'nothing is written without --write');

  const r = await cli(f.en, f.ua, '--propose-ids', '--root', f.root, '--write');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.ua, f.ua, 'the UA page is found from its Cyrillic text');
  assert.deepEqual(r.out.written, [f.ua, f.en, path.relative(process.cwd(), f.other)]);
  const ua = await fs.readFile(f.ua, 'utf8');
  let want = before.ua;
  for (const [from, to] of [
    ['## Огляд балансів\n', '## Огляд балансів {/* #balances-overview */}\n'],
    ['### Фільтри\n', '### Фільтри {/* #filters */}\n'],
    ['## Довідкова інформація\n\n## Готовий', '## Довідкова інформація {/* #reference-information-create-balance */}\n\n## Готовий'],
    ['## Довідкова інформація\n\n## Комісії', '## Довідкова інформація {/* #reference-information-close-balance */}\n\n## Комісії'],
    ['## Повтор\n', '## Повтор {/* #ready-section-1 */}\n'],
    ['(#огляд-балансів),', '(#balances-overview),'],
    ['(#довідкова-інформація)', '(#reference-information-create-balance)'],
    ['(#довідкова-інформація-1)', '(#reference-information-close-balance)'],
  ]) want = edit(want, from, to);
  assert.equal(ua, want);
  assert.equal(ua.split('\n').length, before.ua.split('\n').length);
  assert.ok(ua.includes('## Комісії й ліміти\n'), 'a proposal with a problem is not written');
  assert.ok(ua.includes('`[код](#огляд-балансів)`') && ua.includes('[у коді](#фільтри)'), 'code is untouched');
  const other = await fs.readFile(f.other, 'utf8');
  assert.equal(other.split('\n').length, before.other.split('\n').length);
  assert.ok(other.includes('[a](/balances/#balances-overview)') && other.includes('<Link to="/balances/#filters">') && other.includes('[e](../02-balances/#фільтри)') && other.includes('[d](/other/#огляд-балансів)'));
  assert.equal(await fs.readFile(f.en, 'utf8'), edit(before.en, '[filters](#фільтри)', '[filters](#filters)'), 'in EN, only the copied link changes');

  // Afterwards the alignment check finds a missing id only on the heading whose proposal had a problem.
  const after = await cli(f.ua, f.en, '--ua', 'main');
  assert.deepEqual(after.out.warnings.filter((w) => w.flag === 'HEADING-ID-MISSING').map((w) => w.line), [25]);
  assert.ok(!after.out.warnings.some((w) => w.flag === 'HEADING-ID-MISMATCH'));
});

test('CLI --propose-ids: usage errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-align-'));
  const ua = path.join(dir, 'ua.md');
  const en = path.join(dir, 'en.md');
  await fs.writeFile(ua, '# Тест\n\n## Огляд\n');
  await fs.writeFile(en, '# Test\n\n## Overview\n');
  for (const [args, message] of [
    [[ua, en, '--write'], /--root and --write go with --propose-ids/],
    [[ua, en, '--propose-ids', '--root', path.join(dir, 'nope')], /--root: not a folder/],
    [[ua, en, '--propose-ids', '--names', ua], /--names does not go with --propose-ids/],
    [[en, en, '--propose-ids'], /cannot tell which page is UA/],
  ]) {
    const r = await cli(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out.error, message);
  }
});

// isIdOnlyChange: the id-only change of heading-anchors.md, the one implementation the scripts share.
test('isIdOnlyChange: ids added and links rewritten to them; anything else is a real change', () => {
  const before = '---\ntitle: Т\n---\n\n# Т\n\nДив. [огляд](#огляд-балансів) і `[код](#огляд-балансів)`.\n\n## Огляд балансів\n\nТекст.\n\n## Експорт {/* #export */}\n';
  const after = before.replace('## Огляд балансів\n', '## Огляд балансів {/* #balances-overview */}\n').replace('[огляд](#огляд-балансів)', '[огляд](#balances-overview)');
  const page = { path: 'docs/balances/balances.md', before, after };
  assert.equal(isIdOnlyChange(page), true);
  assert.equal(isIdOnlyChange({ ...page, after: before }), true, 'no change at all');
  for (const [what, text] of [
    ['a changed id', after.replace('{/* #export */}', '{/* #export-data */}')],
    ['a removed id', after.replace(' {/* #export */}', '')],
    ['a changed heading text', after.replace('## Огляд балансів {', '## Огляд рахунків {')],
    ['a prose change', after.replace('Текст.', 'Інший текст.')],
    ['a fragment in inline code', after.replace('`[код](#огляд-балансів)`', '`[код](#balances-overview)`')],
    ['a fragment no heading got', after.replace('(#balances-overview)', '(#export)')],
    ['an added line', `${after}\n`],
  ]) assert.equal(isIdOnlyChange({ ...page, after: text }), false, what);

  // A link on another page counts when its path resolves to a page of the same change whose heading got that id.
  const other = { path: 'docs/other/other.md', before: 'Див. [огляд](/balances/#огляд-балансів).\n', after: 'Див. [огляд](/balances/#balances-overview).\n' };
  assert.equal(isIdOnlyChange(other, [other, page]), true);
  assert.equal(isIdOnlyChange({ ...other, before: other.before.replace('/balances/', '../balances/balances.md'), after: other.after.replace('/balances/', '../balances/balances.md') }, [other, page]), true, 'a relative file path');
  assert.equal(isIdOnlyChange(other, [other]), false, 'the linked page is not part of the change');
  assert.equal(isIdOnlyChange(other, [other, { ...page, after: before }]), false, 'the linked heading got no id');
});

// An explicit id is written `\{#id}`: a bare `{#id}` fails the MDX build in some hosts ("Could not parse expression with
// acorn"). Every reader takes both forms, because existing pages may have either.
const FORMS = ['\\{#reference-information-create-record}', '{#reference-information-create-record}'];

test('explicit ids: both `\\{#id}` and `{#id}` are read as the EN id, and the backslash is not part of the heading text', () => {
  for (const mark of FORMS) {
    assert.equal(headingText(`Reference information ${mark}`), 'Reference information', mark);
    const en = EN.replace(FORMS[1], mark);
    assert.deepEqual(flags(compare(UA, en)), [], mark);
    const other = compare(UA, EN.replace(FORMS[1], mark.replace('create-record', 'other')));
    assert.deepEqual(flags(other), ['HEADING-ID-MISMATCH'], mark);
    assert.match(other.warnings[0].description, /explicit id 'reference-information-other'/, mark);
  }
  const ids = enHeadingIds([{ raw: 'Overview \\{#overview-page}' }, { raw: 'Fees {#fees-page}' }, { raw: 'Plain words' }]);
  assert.deepEqual(ids.map((x) => [x.id, x.explicit]), [['overview-page', true], ['fees-page', true], ['plain-words', false]]);
});

test('explicit ids: --propose-ids reads an EN id in either form and skips a UA heading that has one; the id-only predicate does not take it for an added id', async () => {
  for (const mark of ['\\{#overview-page}', '{#overview-page}']) {
    const r = await proposeIds('# Т\n\n## Огляд\n', `# T\n\n## Overview ${mark}\n`, { uaPath: 'ua.md', enPath: 'en.md' });
    assert.deepEqual([r.proposals.length, r.proposals[0].id, r.proposals[0].from, r.proposals[0].problem], [1, 'overview-page', 'explicit', undefined], mark);
    const ex = await proposeIds(`# Т\n\n## Огляд ${mark}\n`, '# T\n\n## Overview\n', { uaPath: 'ua.md', enPath: 'en.md' });
    assert.deepEqual([ex.proposals.length, ex.skipped.length], [0, 1], mark);
    assert.match(ex.skipped[0].reason, /explicit id/);
    const page = { path: 'a.md', before: `## Огляд ${mark}\n`, after: `## Огляд ${mark} {/* #overview-page */}\n` };
    assert.equal(isIdOnlyChange(page), false, mark);
  }
});

test('explicit ids: the texts that tell how to write one show the escaped form', async () => {
  const plugin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const files = ['context/doc-rules/project-rules/heading-anchors.md', 'context/doc-templates/user-guide-template.md', 'skills/doc-translator/SKILL.md', 'skills/user-guide-writer/SKILL.md'];
  // A heading example (a heading line, or a heading inside inline code) that ends in an id with no backslash.
  const bare = /^\s*#{2,6} .*(?<!\\)\{#|`#{2,6} [^`]*(?<!\\)\{#/;
  let escaped = 0;
  for (const f of files) {
    for (const line of (await fs.readFile(path.join(plugin, f), 'utf8')).split('\n')) {
      if (line.includes('\\{#')) escaped++;
      assert.equal(bare.test(line), false, `${f}: ${line}`);
    }
  }
  assert.ok(escaped >= 8, 'the escaped form is the one the texts show');
});

// ------------------------------------------------------------------ renaming ids (the ticket flow's id step)

const RN_UA = '# Сторінка\n\n## Нові поля {/* #new-fields */}\n\nДив. [поля](#new-fields).\n\n## Статуси {/* #statuses */}\n';
const RN_EN = '# Page\n\n## Added fields\n\nSee [fields](#new-fields).\n\n## Statuses\n';
const RN_DE = '# Seite\n\n## Neue Felder {/* #new-fields */}\n\nSiehe [Felder](#new-fields).\n\n## Status {/* #statuses */}\n';

test('headingIdMismatches: the UA and EN headings whose ids differ, with both lines; none when the counts differ', () => {
  assert.deepEqual(headingIdMismatches(parse(RN_UA), parse(RN_EN)).map((x) => [x.index, x.uaLine, x.uaId, x.enLine, x.enId, x.explicit]), [[1, 3, 'new-fields', 3, 'added-fields', false]]);
  assert.deepEqual(headingIdMismatches(parse(RN_UA), parse(RN_EN.replace('## Added fields', '## Added fields \\{#new-fields}'))), []);
  assert.equal(headingIdMismatches(parse(RN_UA), parse('# Page\n')), null);
});

test('withExplicitId: the EN heading gets `\\{#id}` at its end, in place of another explicit id; no word changes', () => {
  assert.equal(withExplicitId('## Added fields', 'new-fields'), '## Added fields \\{#new-fields}');
  assert.equal(withExplicitId('## Added fields {#added}  \r', 'new-fields'), '## Added fields \\{#new-fields}\r');
});

test('renameIds: the UA comment, the same comment on every further locale page, and every link to the old id; no word changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-align-rename-'));
  const put = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
    return path.join(dir, rel);
  };
  const ua = await put('docs/x/page.md', RN_UA);
  const en = await put('i18n/en/current/x/page.md', RN_EN);
  const de = await put('i18n/de/current/x/page.md', RN_DE);
  const other = await put('docs/y/other.md', '# Інша\n\n[a](/x/page#new-fields) [b](/x/page#statuses) [c](/y/other#new-fields)\n');
  const roots = [{ dir: path.join(dir, 'docs'), prefix: '/' }, { dir: path.join(dir, 'i18n/en/current'), prefix: '/' }, { dir: path.join(dir, 'i18n/de/current'), prefix: '/' }];
  const r = await renameIds(RN_UA, RN_EN, { uaPath: ua, enPath: en, locales: [{ path: de, text: RN_DE }], roots, renames: [{ from: 'new-fields', to: 'added-fields' }, { from: 'gone', to: 'x' }, { from: 'statuses', to: 'Bad Id' }], write: true });
  assert.deepEqual(r.renamed.map((x) => [x.from, x.to, x.line, x.locales.map((l) => l.line)]), [['new-fields', 'added-fields', 3, [3]]]);
  assert.deepEqual(r.skipped.map((x) => x.from), ['gone', 'statuses']);
  assert.equal(await fs.readFile(ua, 'utf8'), RN_UA.replaceAll('new-fields', 'added-fields'));
  assert.equal(await fs.readFile(de, 'utf8'), RN_DE.replaceAll('new-fields', 'added-fields'), 'the locale carries the comment verbatim, and its own link');
  assert.equal(await fs.readFile(en, 'utf8'), RN_EN.replace('#new-fields', '#added-fields'), 'EN: only the link it copied from UA');
  assert.equal(await fs.readFile(other, 'utf8'), '# Інша\n\n[a](/x/page#added-fields) [b](/x/page#statuses) [c](/y/other#new-fields)\n', 'a link to another page keeps its fragment');
  assert.deepEqual(r.written.length, 4);
});

