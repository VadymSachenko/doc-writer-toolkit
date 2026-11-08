---
name: doc-alignment-checker
description: Checks whether a UA documentation page and its EN counterpart are structurally aligned, using the project's own declared content roots. The caller specifies which version is the source of truth (main). Reports structural gaps, type-column violations, bad link prefixes, mismatched tables, missing markers, and names of organizations that differ from the names table of the product kit or are missing from it. Use explicitly ("check-doc-alignment", "use doc-alignment-checker to check...").
---

# doc-alignment-checker

You are checking whether a Ukrainian documentation page and its English counterpart are structurally aligned. The caller specifies which version is the **main** (source of truth); the other is the **secondary** that must conform to it.

## Scope

- **In scope:** any Markdown/MDX page that exists under both roots of a declared root pair: its UA content root and its EN i18n root (see Path mapping). The caller may name either the UA or the EN page.
- **Out of scope:** content quality review, translation accuracy, style-guide compliance beyond the rules listed below. A page outside every declared root pair is not checked here.

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

- Follow `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` to resolve the page's **root pair** (its **UA content root** and **EN i18n root**) and the **UA URL prefix of every declared pair**, for Check 5. Do not assume any default.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md` — the shared page-to-page link contract. Check 5 checks links against this file's algorithms, in the form the page's root pair declares (`Page link form:`); do not restate it here.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/heading-anchors.md` — the shared heading-id contract. Check 2 checks UA heading ids against it; do not restate it here.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md` — the shared slug/title/filename convention. Check 11 checks title form and slug/filename agreement against this file; do not restate it here.
- The product kit's names table, for Check 12: the `## Назви` / `## Names` section of `<kit>/glossary-ua.md` and `<kit>/glossary-en.md` (`${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Product kit"; the format is `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/glossary-format.md`, "Names"). Read only that section. With no kit declared, say so and run Check 12 without a table.
- The UA page being checked (at the path resolved above).
- The EN counterpart page (at the path resolved above).

## Path mapping

Resolve the page's root pair via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` ("Resolving a page's root pair") before doing anything else — do not assume any folder. A UA or an EN path both identify the pair; the counterpart comes from the same pair.

| Role | Path |
|---|---|
| Ukrainian | `<pair's UA content root>/<relative-path>.md` |
| English | `<pair's EN i18n root>/<relative-path>.md` |

## Step 0 — Identify main and secondary

The user will state which version is **main** (e.g., "main: UA", "UA is main", "check against the EN version"). If not stated, ask before proceeding.

- **Main** = source of truth. Its structure drives all comparisons.
- **Secondary** = the version that must conform to main.

## Step 1 — Load both files

Read both files. If either file does not exist, stop immediately and tell the user which file is missing before doing anything else.

## Step 1.5 — Run the structural script

A Node script does the mechanical counting, so it is exact on long pages: dates, headings, heading ids, tables, code blocks, `<details>` blocks, markers, and image, link and admonition counts. Don't count these by hand when the script runs. Interpret its output.

Run it with the main file first and the secondary file second:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/doc-align.mjs <main-file> <secondary-file> --names <kit>/glossary-ua.md --names <kit>/glossary-en.md
```

Leave out each `--names` whose file isn't there, and both with no kit declared.

It prints one JSON report: `bugs[]`, `warnings[]` and `passed[]`. Each finding has a `check` (the Check number below), a `flag`, a `description`, a `line` and a `file`. The fields, flags and exit codes are in `${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/README.md`. Read that file only when a finding is unclear.

- Treat each finding as a candidate, not a verdict. The script never decides whether a difference is intended. You do, from both files, and you word the finding for the report.
- Exit `0` means it ran, with findings or without. The `ua` field says which file it read as UA, from the Cyrillic text. If that is wrong, or a `HEADING-ID-SKIPPED` warning says it couldn't tell, run it again with `--ua main` or `--ua secondary`.
- Findings with `check: null` (image, link and admonition counts) have no Check of their own. Report them as warnings.
- A `passed[]` entry is a sub-check with no findings. List it under **Passed** with its Check number.

If the script can't run (no Node, or an exit other than `0`), count by hand as each Check below describes, and say in the report that the counts were done by hand.

The semantic checks are always yours, whether the script ran or not: Check 4 (Type column language), Check 5 (link prefixes, per `internal-links.md`), Check 9 (Cyrillic text in the EN file), Check 10 (untranslated prose), Check 11 (naming) and the names the table lacks in Check 12.

## Step 2 — Run all checks

Run every check below in order. For the mechanical checks, interpret the script's findings (or count by hand if it didn't run). For the semantic checks, read the files yourself. Collect every finding before reporting.

### Check 1 — Frontmatter dates match

Extract `last_update.date` from both files. They must be identical.

**Flag:** `[DATE MISMATCH]` — show both values.

Script flag: `DATE-MISMATCH`.

### Check 2 — Section count and heading levels

Extract every heading (`#`, `##`, `###`, `####`) from both files in order. Count and nesting level must match exactly.

When comparing UA headings, strip the anchor comment (`{/* #slug */}`) before comparing structure. Additionally:

- Every UA heading from `##` down must end with a well-formed `{/* #id */}` comment, per `heading-anchors.md`; the page title (`#`) takes none. The expected id is the one generated from the EN heading at the same position, or that heading's explicit id (`\{#id}` or `{#id}`). Flag a UA heading whose comment is missing or malformed, and an id used twice on the page.
- EN headings must **not** have `{/* … */}` anchor comments.

**Flag:** `[HEADING COUNT/LEVEL MISMATCH]` — list the position and differing headings side by side.
**Flag:** `[UA HEADING MISSING ANCHOR]` — show the heading and the expected anchor, and say that adding it changes the heading's fragment, so links to the old fragment change with it (`heading-anchors.md`, rule 8). Say who adds it: `doc-translator`, Step 5b, which gives every UA heading of the page without an id its EN anchor and rewrites those links in the same change (`heading-anchors.md`, "Who adds a missing id"). Without a translation, the same script does it alone: `doc-align --propose-ids --write` (`${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/README.md`). Don't add the id yourself: this skill edits nothing.

Script flags: `HEADING-COUNT-MISMATCH`, `HEADING-LEVEL-MISMATCH`, `HEADING-ID-MISSING`, `HEADING-ID-MALFORMED`, `HEADING-ID-DUPLICATE`, `EN-HEADING-COMMENT`, `HEADING-ID-MISMATCH` (the EN heading's id differs from the UA id at the same position), `HEADING-ID-SKIPPED`.

### Check 3 — Table structure

For every Markdown table in the main file, find the corresponding table (by order of appearance) in the secondary file.

- Column count must match.
- Row count must match.

**Flag:** `[TABLE MISMATCH]` — identify the table by its position or the preceding heading, and show the counts (main vs secondary).

Script flag: `TABLE-MISMATCH`.

### Check 4 — Type column values must be English

In every table that has a column named `Type` (UA: `Тип`), every cell in that column must contain only English type names: `String`, `Number`, `Boolean`, `Object`, `Array`, or their combinations. Ukrainian equivalents are not allowed, even in the UA file.

This check applies regardless of which file is main.

**Flag:** `[TYPE COLUMN — NOT ENGLISH]` — show the offending file, row, and cell value.

### Check 5 — Internal link prefixes

Every page-to-page link in both files must have the form the page's root pair declares (`Page link form:`, `route` when absent, resolved through `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`) and match the output of that form's algorithm in `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md`, validated as that file's "Validating a page link" prescribes. In a `file-path` pair, a `.md` link to a page of the same pair is correct: never flag its extension. Per that file, this is a **structural match check only** — do not verify the target page exists, and do not touch asset links (`./.assets/…`), external URLs, same-page anchors, or MDX imports.

**Flag:** `[LINK — INCORRECT PREFIX]` — show the full offending link and line number, and the pair's link form when it is `file-path`.

### Check 6 — Code blocks are identical

Extract every fenced code block (` ``` `) from both files in order. Their contents must be byte-for-byte identical (whitespace included). Code blocks are never translated.

**Flag:** `[CODE BLOCK MISMATCH]` — show the position (nth code block) and a side-by-side diff of the differing lines.

Script flag: `CODE-BLOCK-MISMATCH`. Its `line` is the first line that differs; you still write the diff.

### Check 7 — `<details>` block count matches

Count `<details>` elements in both files. They must match.

**Flag:** `[DETAILS BLOCK COUNT MISMATCH]` — show both counts.

Script flag: `DETAILS-BLOCK-COUNT-MISMATCH`.

### Check 8 — ToDo and NEEDS CONFIRMATION markers

Extract every `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}` comment from both files. Each marker in the main file must have a counterpart in the secondary file at the same structural position (same section, same table row). A marker present in one file but absent in the other is a gap.

**Flag:** `[MARKER MISSING IN SECONDARY]` — show the marker text and location.
**Flag:** `[MARKER MISSING IN MAIN]` — show the marker text and location.

Script flags: `MARKER-MISSING-IN-SECONDARY`, `MARKER-MISSING-IN-MAIN`. It pairs markers section by section; you check the table row.

### Check 9 — No Ukrainian prose in the EN file

Scan the EN file for any Unicode characters in the Ukrainian/Cyrillic range (U+0400–U+04FF) that appear outside of fenced code blocks. Any such character is a bug.

**Flag:** `[CYRILLIC TEXT IN EN FILE]` — show the line number and offending text.

### Check 10 — No untranslated prose in the UA file

Scan the UA prose sections (outside of fenced code blocks and inline code) for runs of five or more consecutive English words that form English sentences. This catches accidentally untranslated paragraphs.

Do not flag: inline code, technical terms that have no UA form (API, UUID, JSON, etc.), heading anchors `{/* #… */}`, or partial phrases mixed into code references.

**Flag:** `[UNTRANSLATED PROSE IN UA FILE]` — show the line number and the English text found.

### Check 11 — Title, slug, and filename agree

A structural check only, against `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md`:

- Both files share one relative path and filename basename (the two locales are the same page in two roots). Flag a divergent basename.
- The filename basename is the kebab-case slug of the **canonical English title** (drop articles); an explicit `slug:` frontmatter field, if present, still names the same topic. Flag a basename that names a different topic than the EN title, or an EN/UA title that name different topics from each other.
- The title form matches the doc type per that file (user guide = imperative phrase; concept = noun phrase; API reference = resource noun phrase). Flag a form mismatch.
- A `sidebar_label:`, in either file, names the same subject as that file's title, and the EN and UA labels name the same subject. Flag a label that names a different or a broader subject, or one present in only one of the two files.

Per that file, **report the mismatch — never rename**. `index.md` and other generated files are exempt.

**Flag:** `[NAMING — TITLE/SLUG MISMATCH]` — show the filename, both titles (and labels), and what disagrees.

### Check 12 — Names of organizations

Names of banks, payment systems, companies and other organizations or products follow Ж10 of `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md`: the form depends on what the text refers to. This check covers prose, where the text refers to the organization itself; the names table pairs its own UA and EN forms (the first two columns).

- **A name the table has.** The script finds it in both pages (its `names.found` lists the rows it found). A UA form and an EN form from one row are a pair, never a mismatch, however different they look (Лунобанк — Lunobank). A spelling that isn't the row's form for its page's language is `NAME-SPELLING`. A row named in one page only is `NAME-MISSING-IN-SECONDARY` / `-MAIN`: report it unless the other page names the organization in a way the table should list too.
- **A name the table lacks.** Read both pages for names of organizations or third-party products that no row covers (the script can't see them). List each one with its form in each page and its line. Don't judge which form is right: Ж10 says where the form comes from, and a row is added to the kit, not decided here. The host's own product name is not in scope (`product-rules.md`).
- **Not a finding:** a name inside a bold UI label or in code font (the app's form or the API's value, Ж1 and Ж4; the table's UI forms and API values columns list them), a URL, and a name inside a quoted system message.
- **A value or a label written as prose.** When the prose names an API value or a UI element (a form from the table's API values or UI forms column) without code font or bold, report it with the form Ж10 gives that role, under the first flag below.

**Flag:** `[NAME — NOT THE TABLE'S FORM]` — show the form found, the table's form for that language, and the line. Script flag: `NAME-SPELLING`.
**Flag:** `[NAME — IN ONE VERSION ONLY]` — show the row and the version that names it. Script flags: `NAME-MISSING-IN-SECONDARY`, `NAME-MISSING-IN-MAIN`.
**Flag:** `[NAME — NOT IN THE NAMES TABLE]` — show the name as each version writes it, with lines, and say that its row belongs in the kit's names table (Ж10). With no names table (`NAMES-TABLE-MISSING`, or no kit declared), list every name here and say so once.

## Step 3 — Report

Format the report as follows:

```
## Alignment report: <slug>

Main:      <path to main file>
Secondary: <path to secondary file>
Pair:      <pair id>          (only when the project declares more than one root pair)

### Bugs (must fix before publishing)
- [FLAG TYPE] Description — line N (file)

### Warnings (review before publishing)
- [FLAG TYPE] Description — line N (file)

### Passed
- Check N — <check name>: OK
```

Severity rules:

| Severity | Checks |
|---|---|
| **Bug** | Type column not English; incorrect link prefix; code block mismatch; heading count/level mismatch; Cyrillic text in EN file |
| **Warning** | Date mismatch; table row/column mismatch; `<details>` count mismatch; marker mismatch; untranslated prose in UA file; UA heading missing anchor; title/slug/filename mismatch; every names finding (Check 12) |

If no issues are found for a check, list it under **Passed**. Do not omit passed checks — a full green list is useful confirmation.

After the report, state the total: `X bug(s), Y warning(s)`.

## Explicit invocation examples

This skill triggers only when the user names it explicitly or via the `/check-doc-alignment` command. Examples:

- `/check-doc-alignment transactions/filter-transactions/filter-transactions main:ua`
- "Use doc-alignment-checker to check the receipts page, UA is main"
- "doc-alignment-checker: check transactions/transactions, EN is main"
