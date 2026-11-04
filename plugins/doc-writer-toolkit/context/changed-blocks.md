---
name: changed-blocks
description: Shared procedure for turning "what changed in a page" into the set of whole blocks a skill should work on — used by doc-style-reviewer (scope mode), doc-style-fixer, doc-translator (sync mode) and doc-page-updater. Referenced, never copied.
---

# Changed blocks

Several skills need to act on **only the part of a page that changed** — review it, fix it, re-translate it — without touching the rest. A diff gives changed *lines*; that is the wrong unit: a changed word can change the sense and grammar of its whole sentence, a changed cell changes its row, a changed heading changes its section. This file defines the unit once.

## Input — where "what changed" comes from

One of, in this order of preference:

1. An `update-report.md` written by `doc-page-updater` — its "Changed sections" list names heading paths and blocks explicitly.
2. A git diff: `git diff <base>...HEAD -- <page>` (default base `origin/main`; the caller may pass another ref). Only the page's own hunks count.
3. An explicit list of heading paths passed by the caller (`sections: "Огляд > Поля; Кроки"`).

If the base ref does not exist, stop and name it — never fall back to a whole-page pass silently. If nothing changed, say so and stop.

## Expansion — from a changed span to whole blocks

Expand every changed span outward to the smallest complete unit that contains it:

| Change touches | Unit to work on |
|---|---|
| a word or sentence in a paragraph | the whole **paragraph** (blank-line-delimited block) |
| a list item | the whole **item**, including its sub-items and any paragraph inside it |
| a table cell | the whole **row**; a header cell → the whole **table** |
| a heading | the whole **section** under that heading (to the next heading of the same or higher level) |
| an admonition (`:::note` …) or an MDX component body | that whole **body** |
| frontmatter `title` / `description` | those **values** |
| a code block or inline code | that **block/span** only — code is never expanded to prose and never edited by prose rules |

Then apply two escalations:

- If more than half of the blocks in a section changed, work on the **whole section**.
- If a changed block introduces or renames a **term** (a UI label, a glossary term, a field name), note that term for a page-wide consistency pass — see below.

Two changed spans in one block count once. Blocks are identified by heading path + first words, e.g. `Поля заявки › "Реквізити — номер картки …"`.

## Heading ids and link fragments

A heading's `{/* #id */}` comment added or changed, and a link fragment rewritten to it, change no text: they are the id-only change and the splice that `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/heading-anchors.md` defines ("Id-only changes"). Such a difference is **not expanded**: a heading that only gained or changed its comment is not a changed section, and a block whose only difference is a rewritten fragment is not a changed paragraph, row or item. It doesn't count toward the more-than-half escalation either.

- **Review and fix** (`doc-style-reviewer`, `doc-style-fixer`): nothing to review in it.
- **EN sync** (`doc-translator --sync`): nothing to re-translate. The id is the EN heading's anchor (`heading-anchors.md`, "Who adds a missing id"), and the EN link already uses it; the alignment check confirms both (`HEADING-ID-MISMATCH` when they differ).
- **Further locales** (`locale-sync`): the script splices the comment onto the translated heading and the fragment into the translated link, with no translator (`${CLAUDE_PLUGIN_ROOT}/scripts/locale-sync/README.md`, "Id-only changes").

A heading whose text changed with its comment is a changed heading as above: its whole section.

## Page-wide consistency pass (terms only)

For every term introduced or renamed in the changed blocks, scan the **whole page** for the old term, a different form, or a different spelling, and report each location. This is the only page-wide check a scoped pass performs; nothing else outside the changed blocks is reviewed, fixed or re-translated.

## What a consuming skill must state

Every skill that uses this file reports: the source of "what changed" (report / diff base / explicit list), the list of blocks it worked on, and the terms it carried into the consistency pass — so the next skill in a chain (fixer after reviewer, alignment checker after translator) can see exactly what was covered.
