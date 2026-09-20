---
name: doc-page-updater
description: Applies a change brief to an existing, approved documentation page in the project's authored language — the smallest edit that makes the page true after a product change (a new field, step, currency, error, renamed control, re-captured screenshot), preserving the page's structure, terms and every untouched sentence. Writes an update-report.md listing the changed blocks for the review, fix and translation skills that follow. Not for creating pages (the *-writer skills) and not a style pass. Use explicitly ("doc-page-updater", "update-doc-page", "use doc-page-updater to apply the brief to...").
---

# doc-page-updater

You are changing an existing, approved page so that it is true again after a product change. You are not rewriting it. The brief tells you what changed and where each fact comes from; the page tells you how this project already says things. Your output is the smallest diff that reconciles the two, plus a report of exactly which blocks you touched.

## Scope

- **In scope:** editing one authored-language page (UA in a UA-first project) from one change brief: extending a table, adding a step or a paragraph, replacing a label or a value, adding a section where the template has a place for it, referencing a new or re-captured screenshot, adding markers for unknowns, updating `last_update`.
- **Out of scope:** writing a new page (`user-guide-writer`, `concept-doc-writer`, `api-doc-writer`); style review or fixes (`doc-style-reviewer`, `doc-style-fixer` — run after this skill); the EN page (`doc-translator` in sync mode, later); creating or editing image files (screenshots come from the project's capture setup); resolving existing `{/* ToDo */}` / `{/* NEEDS CONFIRMATION */}` markers the brief does not mention (`resolve-markers`); any page the brief does not name.

## Sources to load

- The change brief (path given by the caller; format in `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/input-templates/change-brief-template.md`).
- The target page.
- `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve the host project's declarations from the **host project path the caller passes** (or the current project if none is passed). Refuse a page that lives under the EN i18n root: this skill edits the authored language only.
- The template matching the page's type, to know where a new block belongs: `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-user-guide-template.md`, `ua-concept-topic-template.md`, `api-reference-template.md` (or the EN equivalents on an `en` project). Detect the type from the page's structure and frontmatter.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md` (or `glossary-en.md`) and `formatting-conventions.md` — terms and formatting are rank 0.
- `${CLAUDE_PLUGIN_ROOT}/context/changed-blocks.md` — the block vocabulary used in the report.

Nothing else. Do not load style corpora; the reviewer does that afterwards.

## Arguments

- `page:` — path of the page (required).
- `brief:` — path of the change brief (required).
- `project:` — host project root (optional; defaults to the current project).
- `report:` — where to write `update-report.md` (optional; default: next to the brief).
- `dry-run` — print the planned edits and the report, write nothing.

## Step 1 — Read and plan

1. Read the brief. Every item under "What changed" must carry a source; an item without one, or marked unknown, becomes a marker (Step 2.3) — never prose.
2. Read the page once, whole. Note its type, section order, table shapes, how it names the UI elements the brief mentions, and any existing markers.
3. For each brief item decide: **already present** (no edit — the page already states it; report it), **extend** (add a row, item, sentence or paragraph inside an existing block), **replace** (the page says X, the brief says Y with a source — Y wins; report "replaced X with Y (source …)"), **add section** (no existing block fits; place it where the template puts that kind of content), or **marker** (unknown).
4. Honour the brief's "Do not touch" list absolutely.

## Step 2 — Edit

1. **Smallest edit.** Change only the blocks your plan names. Every other sentence stays byte-identical — no reflow, no re-punctuation, no "while I'm here". Keep heading structure, order, tone and sentence patterns of the surrounding text.
2. **Terms.** Use the glossary term. A UI label the brief quotes goes in exactly as the app shows it, in the page's language, with the project's formatting convention for labels. Record every new or renamed term for the report.
3. **Markers.** For an unknown or unsourced item write `{/* NEEDS CONFIRMATION: <plain writer's note> */}` at the end of the affected line — a note a colleague would write, no tool or model names. A screenshot the brief marks as showing the old state gets `{/* ToDo: re-capture <file> */}` next to its reference.
4. **Screenshots.** Reference new or re-captured files exactly by the names the brief gives, in the page's `.assets/` folder, with the project's screenshot embedding conventions. Never create or modify image files.
5. **Frontmatter.** Update `last_update.date` if the page has it. Touch nothing else in the frontmatter unless the brief names the field (e.g. `description` must change because the page's scope changed).
6. **MDX.** Never touch import lines or component props unless the brief names them.

## Step 3 — Self-review before saving

- The diff contains only the blocks named in the plan; no sentence outside them changed.
- Every fact added traces to a brief item with a source; every unsourced item is a marker, not prose.
- No item from "Do not touch" changed.
- Table columns and list numbering are still consistent after the edit.
- New terms match the glossary; UI labels match the brief exactly.
- Markers read as plain writer's notes.
- Code blocks and inline code are byte-identical unless the brief changed them.

Fix anything that fails, then save.

## Step 4 — Write `update-report.md`

```
# Update report — <page>

Brief: <path>
Applied: <N> items · Already present: <N> · Markers added: <N> · Could not apply: <N>

## Changed sections
- <heading path> › <block: first words…> — extended | replaced | added
…

## Terms introduced or renamed
- <term> (was: <old>, if any)

## Screenshots
- <file> — new | re-captured | ToDo re-capture

## Markers added
- <heading path>: <marker text>

## Not applied
- <brief item> — <why: already present | contradicts "Do not touch" | no place in template — ask>
```

The "Changed sections" list is the input of `doc-style-reviewer` (scope mode) and `doc-translator` (sync mode) — see `${CLAUDE_PLUGIN_ROOT}/context/changed-blocks.md`.

## Step 5 — Report to the caller

Counts from the report header, the list of changed sections, and every "Not applied" item with its reason. Recommend the next steps in order: `doc-style-reviewer --changed` → `doc-style-fixer` → (after approval) `doc-translator --sync`. Do not run them yourself.

## Edge cases

- The brief targets a section that does not exist → add it per the template's placement; report "added".
- The page is a multi-procedure guide and the brief adds a whole procedure → add it as a sibling of the existing ones with the same heading pattern; report "added".
- The brief's fact contradicts an existing marker → apply the fact, remove that marker, report both.
- A page in the EN root → refuse with the reason; suggest running on the UA page and then the translator's sync mode.
- The brief is empty or every item is "already present" → no edit, report only.

## Explicit invocation examples

- "doc-page-updater: page docs/currencies/currencies.md, brief docs/.sources/tickets/1120/change-brief-currencies.md"
- "use doc-page-updater to apply docs/.sources/tickets/1096/change-brief-add-cards.md to docs/balance/add-cards/add-cards.md in /Users/vadym/Projects/UCPAY-DOC-OPERATOR"
- "/update-doc-page docs/currencies/currencies.md docs/.sources/tickets/1120/change-brief-currencies.md"
