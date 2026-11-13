# doc-align

Counts and pairs the structural elements of two Markdown/MDX pages, a **main** page (the source of truth) and a **secondary** page that must conform to it, and checks the heading ids of the UA one. Given a names table, it also checks the names of organizations in both pages against it. Given an example values file, it counts the file's existing pairs as the same value in code blocks. Node, no dependencies. No AI is involved. The `doc-alignment-checker` skill runs it so the counting is exact on long pages, and spends the model only on what needs judgment.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/doc-align.mjs <main-file> <secondary-file> [--ua main|secondary] [--names <glossary-file>]... [--examples <example-values-file>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/doc-align.mjs <main-file> <secondary-file> --propose-ids [--ua main|secondary] [--root <dir>[=<url prefix>]]... [--write]
```

The second form proposes the missing UA heading ids instead of comparing: see [Proposing the missing ids](#proposing-the-missing-ids---propose-ids).

Needs Node 18.3+. Tests: `npm test` in this folder (offline, fixtures inline). It takes the Docusaurus route of a page from `../locale-sync/lib/links.mjs`, and `locale-sync` reads code blocks with this script's `lib/fences.mjs`, so the two scripts must stay in the same plugin.

## What it does and doesn't do

It reports differences in structure. It never judges meaning or language, and never decides whether a difference is intended: each finding is a candidate for the skill to interpret.

Out of scope, by design (the skill does these): Type-column language, link targets and prefixes (`internal-links.md`), Cyrillic text in the EN page's prose (the script checks only its code blocks), untranslated prose in the UA page, title, slug and filename naming, and names of organizations that the names table lacks (the script knows only the table's rows). Whether an EN heading's wording may use an explicit id (`heading-anchors.md`, rule 6) is a judgment too: the script only checks that the ids agree.

The reader is line based and code aware: fenced code blocks and the frontmatter are skipped, and inline code is blanked before links, images, `<details>` and markers are counted. A heading inside a code block is not a heading. Code blocks are read only by Checks 6 and 9, through [the code-block reader](#the-code-block-reader-libfencesmjs).

## Usage

- `<main-file>`: the source-of-truth page.
- `<secondary-file>`: the page that must conform.
- `--ua main|secondary`: which file is the UA page, for the heading-id checks. Without it, the UA page is the one with more Cyrillic letters in its heading text, and if that is a tie, in its whole text. If that is a tie too (no Cyrillic in either page), the heading-id checks are skipped with a `HEADING-ID-SKIPPED` warning. Pass the flag when a page's headings are mostly Latin text.
- `--names <glossary-file>`: a product kit glossary that holds the names table (a table under `## Names` or `## Назви`, columns UA form, EN form, UI forms, API values, Source: `context/doc-rules/glossary-format.md`, "Names"; only the first two, the organization's own forms, are compared, and a three-column table reads the same). Turns on Check 12. Give it more than once to read both glossaries: the rows are merged, one per UA/EN pair. A glossary without the table is not an error: the report then has a `NAMES-TABLE-MISSING` warning.
- `--examples <example-values-file>`: a product kit's example values file (`context/doc-rules/example-values-format.md`). Check 6 reads its existing pairs (the table under `## Existing pairs` or `## Наявні пари`, columns UA value, EN value, Type, Pages) and counts each pair as the same value: see "Code blocks" below. A file without the section is not an error: the report then has an `EXAMPLE-PAIRS-MISSING` warning. A row that is no pair (a value missing, the same value twice, a type other than `example` or `system`) is skipped with an `EXAMPLE-PAIR-INVALID` warning on its line. A pair goes from UA to EN, so when the script can't tell which page is UA, the pairs are not used and an `EXAMPLES-SKIPPED` warning says so.
- `--propose-ids`: propose the missing UA heading ids and find the links to their old fragments, instead of comparing (below). `--names` and `--examples` don't go with it.
- `--root <dir>[=<url prefix>]`: with `--propose-ids`, a UA content root to search for links, and its UA URL prefix (default `/`). Give it once per root pair. An EN i18n root may be given too (with the same prefix as its UA root): an EN link copied from UA with an old fragment is broken in EN and gets the id as well.
- `--write`: with `--propose-ids`, write the proposals into the UA page and the link rewrites into the pages that hold the links.
- `-h`, `--help`: the usage text.

Both paths are echoed as given into the report's `main` and `secondary` fields and each finding's `file`.

Output is one JSON report on stdout. A failure prints `{"error": …}` on stdout and a `doc-align: …` line on stderr.

**Exit codes:** `0` the comparison ran, with findings or without (they are in the JSON, not the exit code) · `1` unexpected failure · `2` bad usage or a file that can't be read (missing, a directory).

## Output

```json
{
  "main": "docs/records/filter-records.md",
  "secondary": "i18n/en/docusaurus-plugin-content-docs/current/records/filter-records.md",
  "ua": "main",
  "bugs": [
    {
      "check": 2,
      "flag": "HEADING-LEVEL-MISMATCH",
      "description": "heading 4: main '### Активний запис' is H3, secondary '## Active record' is H2",
      "line": 37,
      "file": "i18n/en/docusaurus-plugin-content-docs/current/records/filter-records.md"
    }
  ],
  "warnings": [],
  "passed": [
    { "check": 1, "name": "Frontmatter dates match" },
    { "check": null, "name": "Image count" }
  ]
}
```

| Field | Meaning |
|---|---|
| `main`, `secondary` | The two paths as passed. |
| `ua` | `main` or `secondary`: the file the heading-id checks read as UA. `null` when they were skipped. |
| `bugs[]`, `warnings[]` | One finding each: `check`, `flag`, `description`, `line`, `file`. |
| `check` | The Check number in `skills/doc-alignment-checker/SKILL.md` (1, 2, 3, 6, 7, 8, 9 or 12), or `null` for the image, link and admonition counts, which have no Check of their own. |
| `flag` | One of the flags below. |
| `description` | What differs, with the counts or the headings involved. |
| `line`, `file` | Where to look: 1-based line in that file. For a count difference, the last item of the file that has more; line `1` when there is nothing to point at. |
| `passed[]` | `{ check, name }` for every sub-check that ran and found nothing. A sub-check that could not run (the heading-id comparison when the heading counts differ, the id checks when `ua` is `null`) is in neither list. |
| `names` | Only with `--names`. `rows`: the number of table rows read. `found[]`: `{ ua, en, main, secondary }` for every row named in either page, with the number of times in each. |
| `examples` | Only with `--examples`. `pairs`: the number of existing pairs read. `matched[]`: `{ ua, en, type, lines }` for every pair that made a line of a passing code block the same, with the number of such lines. |

## Checks and flags

Severity follows the skill: heading count and levels, code blocks and Cyrillic left in the EN page are bugs, everything else is a warning.

| Check | Sub-check (`passed` name) | Flag | Severity |
|---|---|---|---|
| 1 | Frontmatter dates match | `DATE-MISMATCH` | warning |
| 2 | Heading count and levels | `HEADING-COUNT-MISMATCH`, `HEADING-LEVEL-MISMATCH` | bug |
| 2 | UA heading ids present, well formed and unique | `HEADING-ID-MISSING`, `HEADING-ID-MALFORMED`, `HEADING-ID-DUPLICATE` | warning |
| 2 | EN headings carry no comment | `EN-HEADING-COMMENT` | warning |
| 2 | EN heading ids match the UA ids | `HEADING-ID-MISMATCH` | warning |
| 2 | (the id checks could not run) | `HEADING-ID-SKIPPED` | warning |
| 3 | Table count, columns and rows | `TABLE-MISMATCH` | warning |
| 6 | Code blocks keep their code | `CODE-BLOCK-MISMATCH` | bug |
| 6 | (the EN page keeps the UA value of an `example` pair) | `EXAMPLE-PAIR-NOT-APPLIED` | warning |
| 6 | (no existing pairs section in the `--examples` file) | `EXAMPLE-PAIRS-MISSING` | warning |
| 6 | (a row of the existing pairs that is no pair) | `EXAMPLE-PAIR-INVALID` | warning |
| 6 | (cannot tell which page is UA, so the pairs are not used) | `EXAMPLES-SKIPPED` | warning |
| 9 | No Cyrillic in EN diagram labels or code comments (not run when `ua` is `null`) | `CYRILLIC-IN-EN-CODE-TEXT` | bug |
| 7 | `<details>` block count | `DETAILS-BLOCK-COUNT-MISMATCH` | warning |
| 8 | ToDo markers paired, NEEDS CONFIRMATION markers paired | `MARKER-MISSING-IN-SECONDARY`, `MARKER-MISSING-IN-MAIN` | warning |
| `null` | Image count | `IMAGE-COUNT-MISMATCH` | warning |
| `null` | Link count | `LINK-COUNT-MISMATCH` | warning |
| `null` | Admonition count and types | `ADMONITION-MISMATCH` | warning |
| 12 | Names follow the names table (only with `--names`) | `NAME-SPELLING`, `NAME-MISSING-IN-SECONDARY`, `NAME-MISSING-IN-MAIN` | warning |
| 12 | (no names table in the given files) | `NAMES-TABLE-MISSING` | warning |
| 12 | (cannot tell which page is UA) | `NAMES-SKIPPED` | warning |

What each one compares:

- **Dates.** The first `date:` line in the frontmatter (top level or under `last_update`), quotes removed. A date on one side only is a mismatch.
- **Headings.** ATX headings (`#` to `######` at the start of a line) in order. The count must match, then the level at each position. Comments and an explicit `\{#id}` (or `{#id}`) are left out of the heading text in descriptions.
- **UA heading ids** (`context/doc-rules/project-rules/heading-anchors.md`). Every UA heading from `##` down ends with one `{/* #id */}` comment, and `id` is lowercase ASCII kebab-case (`[a-z0-9]` words joined by single hyphens). The page title (`#`) is not checked. `HEADING-ID-MISSING`: no comment. `HEADING-ID-MALFORMED`: the comment has no `#`, does not end the heading, there are several, or the id has another form (upper case, `_`, a double hyphen). `HEADING-ID-DUPLICATE`: an id that an earlier heading on the page already has, reported on the later heading.
- **EN heading comments.** `EN-HEADING-COMMENT`: an EN heading, at any level, that carries a `{/* … */}` comment.
- **EN heading ids.** `HEADING-ID-MISMATCH`: the EN heading's id differs from the well-formed UA id at the same position. The EN id is its explicit `\{#id}` (or `{#id}`: both are read), else the slug Docusaurus generates from its text (github-slugger: link and image text kept, tags dropped, lower case, every character that is not a letter, digit, space, hyphen or `_` removed, each space turned into a hyphen; a slug that already occurs on the page gets `-1`, `-2`, …). Runs only when the heading counts match, so the positions line up.
- **Tables.** A run of lines starting with `|` whose second line is a separator row. The count must match, then, table by table, the columns of the header row (escaped `\|` is not a separator) and the body rows.
- **Code blocks.** Fenced with ```` ``` ```` or `~~~` (closed by the same character, at least as long, with nothing after it). The count must match, then each block's code part (`context/doc-rules/project-rules/code-blocks.md`): its contents with the reader text taken out, compared byte for byte, whitespace and line count included. The reader text is translated, so it may differ. The info string (```` ```json title="…" ````) is not compared; its first word is the block's language. The finding's `line` is the first line whose code part differs. What counts as reader text, per kind of block (`lib/fences.mjs`):
  - `mermaid`: node and edge labels (`[…]`, `(…)`, `{…}`, `>…]`, `|…|`, `-- … -->`), quoted text, subgraph titles, `participant … as` aliases, the text after the colon of a message, a note, a transition or a relation, the labels of `alt`, `else`, `loop` and the other sequence blocks, gantt and journey task names and sections, a `title`, frontmatter `title:` and `%%` comments. Ids, keywords, arrows, `%%{init}%%` directives and `classDef`, `class`, `style`, `linkStyle` and `click` lines are code. Diagram types without rules of their own (`mindmap`, `timeline`, …) compare by their type line, line count and indentation.
  - A language with comments (the table in `code-blocks.md`): the comment bodies. Strings are skipped first, so `//` or `#` inside quotes is code; `#` opens a comment only at the start of a word, and a first-line `#!` is code. A block comment may span lines.
  - `text`, `txt`, `plaintext`, `plain` or no language: the text after ` — ` on each line (a folder tree's descriptions).
  - Any other language, `json` included: no reader text; the whole block is code.

  With `--examples`, a line also counts as the same when the only differences are existing pairs (`lib/examples.mjs`). A pair's UA value counts as a whole quoted value of the UA page's code part (`"…"`, `'…'` or `` `…` ``): the EN page's line may hold, in the same quotes, that value or the pair's EN value. A value that holds a pair's UA value inside a longer string, an EN value on the UA side, other quotes, or any other byte that differs is still a `CODE-BLOCK-MISMATCH`. The EN line may also keep the UA value. For a `system` pair that is the right value: the pair only keeps an EN page that translated a system value aligned. For an `example` pair it is an `EXAMPLE-PAIR-NOT-APPLIED` warning on the EN line, not a bug: `doc-translator` writes the EN value, so a re-translated block that put the UA value back shows here.
- **Cyrillic in the EN page's code blocks** (Check 9). The EN page is the one `ua` doesn't name. Each piece of reader text in its code blocks that holds a Cyrillic letter is a `CYRILLIC-IN-EN-CODE-TEXT` bug on its line. Cyrillic in the code part (a JSON value, a string) is data and is not reported. Cyrillic in the EN prose is the skill's to find.
- **`<details>`.** Each `<details` tag outside code.
- **Markers.** `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}`, also over several lines, by kind. When the heading counts match, they pair section by section (the section is the last heading above the marker), so a marker that moved to another section shows as one gap on each side. Otherwise only the totals compare. The surplus markers on the side that has more are reported, with their text. A marker in a heading is a marker, not a heading comment.
- **Images.** `![alt](src)` and `<img src="…">`.
- **Links.** Inline `[text](target)` links, not images, in prose, headings and table rows.
- **Admonitions.** Opening lines `:::type`, tallied by type.
- **Names** (Ж10 in `context/doc-rules/project-rules/formatting-conventions.md`). Each table row is looked for in the prose of both pages: not in bold spans (a UI label keeps the app's form, Ж1), inline or fenced code (a code value keeps the code's form, Ж4), comments, link targets, URLs, HTML tags or the frontmatter. An occurrence is one or more words, separated by single spaces, whose loose key equals the key of the row's UA or EN form. The loose key is the text in lower case, Cyrillic transliterated, letters and digits only, with i/y, g/h, w/v and kh/h folded, so «Соно банк», «СоноБанк» and "Sonobank" are one name. A name written as more or fewer words than its form counts only when each word has three letters or more, so "a pay slip" is not A-Pay. A name whose forms are in capitals only (TAP, KVB) counts only when the text has two capitals or more, so the verb "tap" is not TAP. A one-word name that differs from its form only in case may be an ordinary word: it is not read as the name in lower case (when no form is in lower case), nor when it opens a line, a list item, a sentence or a table cell ("Tap **Save**"). An occurrence is right when it is the form for its page's language, character for character; a Cyrillic UA form may carry a case ending (Лунобанку), an EN form a possessive (Lunobank's). `NAME-SPELLING`: any other spelling, on its line. A UA form and an EN form that differ are a pair, never a finding. `NAME-MISSING-IN-SECONDARY` / `-MAIN`: a row named in one page and not in the other.

## Proposing the missing ids (`--propose-ids`)

For every UA heading from `##` down without a `{/* #id */}` comment, the id is the anchor of the EN heading at the same position (`context/doc-rules/project-rules/heading-anchors.md`, rules 2 and 6): its explicit `\{#id}` (or `{#id}`), else the slug Docusaurus generates from its text, numbered on repeats (the same id `HEADING-ID-MISMATCH` compares). It then lists the links that use each heading's **old fragment**: the slug Docusaurus generated from the UA text. Docusaurus slugs every heading without an id in page order, the page title included, and numbers a repeat `-1`, `-2`, …; a heading with an id takes no slug.

- **Nothing is proposed** when the heading counts differ (the positions don't line up): every missing id is in `skipped` and `reason` says why. A heading whose EN counterpart has another level is skipped too.
- **A proposal with a `problem` is not written:** an EN anchor that is not lowercase ASCII kebab-case (`Fees & limits` slugs to `fees--limits`), or an id another UA heading of the page already has. Change the EN heading (a wording that slugs to a valid id, or an explicit `\{#id}`, rule 6: written with the backslash) and run again.
- **A UA heading with an explicit `\{#id}` or `{#id}`** is in `skipped`: the comment replaces it by hand.

**Links.** Searched on the UA page and the EN page themselves (EN copies UA link targets verbatim) and in every `.md`/`.mdx` file under the `--root` folders (folders starting with `.` and `node_modules` left out). Fenced and inline code is skipped. A link target is `[text](target)`, `href="target"`, `to="target"` or `[label]: target`; its fragment is compared decoded, so a percent-encoded fragment matches. It reaches the UA page when it is:

- a bare fragment (`#огляд-балансів`) on the UA page or the EN page;
- a relative `.md`/`.mdx` path that resolves to the UA or the EN file;
- a site-root path equal to one of the UA page's routes, in the root that holds it: the route Docusaurus gives it (number prefixes dropped, `folder/folder.md` and `index.md` collapse to the folder, `slug:` wins, after the root's URL prefix), the route `internal-links.md` builds (URL prefix + path without extension), or the file-path form (`/` + path with extension). A trailing slash doesn't matter.

A link with a matching fragment that can't be resolved (a relative route, or a site-root path while the UA page is under no `--root`) is in `unresolved`, for a person to check. A link to another page or site is ignored.

**`--write`** appends ` {/* #<id> */}` to each UA heading line of a proposal without a problem, and replaces the old fragment with the id in each listed link (the path stays as written). No other byte changes and no line is added or removed, so the result is an id-only change (`heading-anchors.md`, "Id-only changes"). On the EN page and the other pages, only the listed links change.

```json
{
  "ua": "docs/balances/balances.md",
  "en": "i18n/en/docusaurus-plugin-content-docs/current/balances/balances.md",
  "proposals": [
    { "line": 9, "heading": "## Огляд балансів", "id": "balances-overview", "from": "generated", "enLine": 9, "enHeading": "## Balances overview", "oldFragment": "огляд-балансів" }
  ],
  "links": [
    { "file": "docs/other/other.md", "line": 3, "url": "/balances/#огляд-балансів", "heading": 9, "newUrl": "/balances/#balances-overview" }
  ],
  "unresolved": [],
  "skipped": [],
  "written": ["docs/balances/balances.md", "docs/other/other.md"]
}
```

| Field | Meaning |
|---|---|
| `ua`, `en` | The two paths as passed, after `--ua` (or the Cyrillic text) decided which is UA. |
| `proposals[]` | One per UA heading without an id: `line` and `heading` (UA), `id`, `from` (`explicit` or `generated`), `enLine` and `enHeading`, `oldFragment`, and `problem` when it is not written. |
| `links[]` | One per link to an old fragment of a proposal without a problem: `file`, `line`, `url` as written, `heading` (the UA line of the heading it reaches), `newUrl`. |
| `unresolved[]` | Links with a matching fragment whose target can't be resolved: `file`, `line`, `url`, `heading`, `reason`. |
| `skipped[]` | Headings without an id that get no proposal: `line`, `heading`, `reason`. |
| `reason` | Only when nothing is proposed because the heading counts differ. |
| `warnings[]` | Only when present: no `--root` given, or the UA page under none of them. |
| `written[]` | Only with `--write`: the files written. |

Exit codes are as above: `0` it ran (proposals or not), `2` bad usage (`--root` or `--write` without `--propose-ids`, a `--root` that is not a folder, no way to tell the UA page).

## The code-block reader (`lib/fences.mjs`)

`fenceParts(info, lines)` splits one code block into its code part and its reader text, as `code-blocks.md` defines them and "Code blocks" above lists per language. It is the one implementation the scripts share: Checks 6 and 9 here, and in `locale-sync` the `code` check, the Ukrainian letters in code blocks, `terms --usage` and the choice of which code blocks a worker translates. `codeDiff(a, b)` gives the first line whose code part differs, `cyrillicText(info, lines)` the reader text that holds Cyrillic. It imports nothing.

## The id-only predicate (`lib/idonly.mjs`)

`isIdOnlyChange(page, changeSet)` is the id-only change of `heading-anchors.md` ("Id-only changes"), the one implementation the scripts share (`section-state` uses it). `page` and every entry of `changeSet` are `{ path, before, after }`; a link to another page counts when its path (a relative `.md`/`.mdx` path, or a site-root route or file path matched against the end of a page path) reaches a page of `changeSet` whose heading got that id. It compares line by line; a difference in code or in the frontmatter is a real change. `--write` above produces exactly such a change.

## The heading-id helpers (`lib/ids.mjs`)

What the ticket flow's runner uses, with no model, after a person's edit of an EN heading on a translated PR (`scripts/ticket-state/README.md`, "The translated label"). No CLI flag reaches them.

- `headingIdMismatches(ua, en)`: from two parsed pages, the headings whose ids differ, the same comparison as `HEADING-ID-MISMATCH` (Check 2, which uses it): `{ index, level, uaLine, uaHeading, uaId, enLine, enHeading, enId, explicit }`. Null when the heading counts differ.
- `renameIds(uaText, enText, { uaPath, enPath, locales, roots, renames, write })`: each `{ from, to }` of `renames` turns the UA heading's `{/* #from */}` into `{/* #to */}`, on the UA page and on each further locale's page of it (`locales`: `[{ path, text }]`, which carry the comment verbatim, rule 7), and rewrites every link to `#from` that reaches the page, found as `--propose-ids` finds them (the locale pages count as the page itself for a bare fragment). A rename to an id that is not kebab-case, from an id no heading has, or to an id that a heading still has once every rename is made (or that another rename takes too), is in `skipped`. The targets are checked after all the renames, so a chain (`example` → `sample`, `example-1` → `example`) is made whole. Returns `{ renamed: [{ from, to, line, locales }], links, unresolved, skipped, written }`. No word changes and no line is added or removed. A changed id is no id-only change (`heading-anchors.md`): the caller keeps such commits apart.
- `withExplicitId(line, id)`: an EN heading line with `\{#id}` at its end, in place of an explicit id it had (rule 6).
- `linksTo(...)`: the link search itself, shared by `--propose-ids` and `renameIds`.

## How the skill uses it

`doc-translator` runs `--propose-ids --write` after it saves the EN page, so every UA heading gets its id from the EN anchor, with the links rewritten in the same change. `doc-alignment-checker` runs it as Step 1.5, after both files are loaded. It reads the JSON, treats each finding as a candidate (a difference may be intended), and supplies Checks 1, 2, 3, 6, 7 and 8 from it, the code-block part of Check 9, the table part of Check 12 when the host's product kit has a names table, and Check 6 with the kit's existing pairs when it has an example values file. It still runs its semantic checks itself. When the script can't run, the skill counts by hand as each Check describes and says so in its report.
