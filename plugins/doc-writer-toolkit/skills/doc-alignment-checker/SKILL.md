---
name: doc-alignment-checker
description: Checks whether a UA documentation page and its EN counterpart are structurally aligned, using the project's own declared content roots. The caller specifies which version is the source of truth (main). Reports structural gaps, type-column violations, bad link prefixes, mismatched tables, and missing markers. Use explicitly ("check-doc-alignment", "use doc-alignment-checker to check...").
---

# doc-alignment-checker

You are checking whether a Ukrainian documentation page and its English counterpart are structurally aligned. The caller specifies which version is the **main** (source of truth); the other is the **secondary** that must conform to it.

## Scope

- **In scope:** any Markdown/MDX page that exists in both the project's UA content root and its EN i18n root (see Path mapping).
- **Out of scope:** content quality review, translation accuracy, style-guide compliance beyond the rules listed below. English-only reference sections with no UA counterpart (e.g. an API reference `docs/` tree in a project that splits UA and EN content into separate roots) are not checked here.

## Path mapping

Resolve the project's actual roots via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` before doing anything else — do not assume `partner-cabinet/`.

| Role | Path |
|---|---|
| Ukrainian | `<UA content root>/<relative-path>.md` |
| English | `<EN i18n root>/<relative-path>.md` |

## Step 0 — Identify main and secondary

The user will state which version is **main** (e.g., "main: UA", "UA is main", "check against the EN version"). If not stated, ask before proceeding.

- **Main** = source of truth. Its structure drives all comparisons.
- **Secondary** = the version that must conform to main.

## Step 1 — Load both files

Read both files. If either file does not exist, stop immediately and tell the user which file is missing before doing anything else.

## Step 2 — Run all checks

Run every check below in order. Collect every finding before reporting.

### Check 1 — Frontmatter dates match

Extract `last_update.date` from both files. They must be identical.

**Flag:** `[DATE MISMATCH]` — show both values.

### Check 2 — Section count and heading levels

Extract every heading (`#`, `##`, `###`, `####`) from both files in order. Count and nesting level must match exactly.

When comparing UA headings, strip the anchor comment (`{/* #slug */}`) before comparing structure. Additionally:

- Every UA heading must have an `{/* #anchor */}` comment derived from the EN heading text in lowercase kebab-case. Flag any UA heading that is missing its anchor.
- EN headings must **not** have `{/* … */}` anchor comments.

**Flag:** `[HEADING COUNT/LEVEL MISMATCH]` — list the position and differing headings side by side.
**Flag:** `[UA HEADING MISSING ANCHOR]` — show the heading and the expected anchor.

### Check 3 — Table structure

For every Markdown table in the main file, find the corresponding table (by order of appearance) in the secondary file.

- Column count must match.
- Row count must match.

**Flag:** `[TABLE MISMATCH]` — identify the table by its position or the preceding heading, and show the counts (main vs secondary).

### Check 4 — Type column values must be English

In every table that has a column named `Type` (UA: `Тип`), every cell in that column must contain only English type names: `String`, `Number`, `Boolean`, `Object`, `Array`, or their combinations. Ukrainian equivalents are not allowed, even in the UA file.

This check applies regardless of which file is main.

**Flag:** `[TYPE COLUMN — NOT ENGLISH]` — show the offending file, row, and cell value.

### Check 5 — Internal link prefixes

Internal links within the UA content root must use this project's declared **UA URL prefix** (resolved in Path mapping above — e.g. `/partner-cabinet/`, or `/` for a project with no split instance). Flag any internal link that uses a bare relative path or an incorrect prefix.

Check both files for this pattern.

**Flag:** `[LINK — INCORRECT PREFIX]` — show the full offending link and line number.

### Check 6 — Code blocks are identical

Extract every fenced code block (` ``` `) from both files in order. Their contents must be byte-for-byte identical (whitespace included). Code blocks are never translated.

**Flag:** `[CODE BLOCK MISMATCH]` — show the position (nth code block) and a side-by-side diff of the differing lines.

### Check 7 — `<details>` block count matches

Count `<details>` elements in both files. They must match.

**Flag:** `[DETAILS BLOCK COUNT MISMATCH]` — show both counts.

### Check 8 — ToDo and NEEDS CONFIRMATION markers

Extract every `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}` comment from both files. Each marker in the main file must have a counterpart in the secondary file at the same structural position (same section, same table row). A marker present in one file but absent in the other is a gap.

**Flag:** `[MARKER MISSING IN SECONDARY]` — show the marker text and location.
**Flag:** `[MARKER MISSING IN MAIN]` — show the marker text and location.

### Check 9 — No Ukrainian prose in the EN file

Scan the EN file for any Unicode characters in the Ukrainian/Cyrillic range (U+0400–U+04FF) that appear outside of fenced code blocks. Any such character is a bug.

**Flag:** `[CYRILLIC TEXT IN EN FILE]` — show the line number and offending text.

### Check 10 — No untranslated prose in the UA file

Scan the UA prose sections (outside of fenced code blocks and inline code) for runs of five or more consecutive English words that form English sentences. This catches accidentally untranslated paragraphs.

Do not flag: inline code, technical terms that have no UA form (API, UUID, JSON, etc.), heading anchors `{/* #… */}`, or partial phrases mixed into code references.

**Flag:** `[UNTRANSLATED PROSE IN UA FILE]` — show the line number and the English text found.

## Step 3 — Report

Format the report as follows:

```
## Alignment report: <slug>

Main:      <path to main file>
Secondary: <path to secondary file>

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
| **Warning** | Date mismatch; table row/column mismatch; `<details>` count mismatch; marker mismatch; untranslated prose in UA file; UA heading missing anchor |

If no issues are found for a check, list it under **Passed**. Do not omit passed checks — a full green list is useful confirmation.

After the report, state the total: `X bug(s), Y warning(s)`.

## Explicit invocation examples

This skill triggers only when the user names it explicitly or via the `/check-doc-alignment` command. Examples:

- `/check-doc-alignment transactions/filter-transactions/filter-transactions main:ua`
- "Use doc-alignment-checker to check the receipts page, UA is main"
- "doc-alignment-checker: check transactions/transactions, EN is main"
