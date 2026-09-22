---
name: naming-conventions
description: The single shared slug/title/filename/sidebar-label convention — how the canonical English title, the kebab-case slug, the shared locale paths, and the Ukrainian title relate. Referenced by every skill that names, creates, translates, aligns, or reviews a page (section-planner, concept-doc-writer, user-guide-writer, api-doc-writer, doc-translator, doc-alignment-checker, doc-style-reviewer) — never restate the algorithm in a skill file.
metadata:
  type: reference
---

# Naming conventions

Single source of truth for the relationship between a page's **canonical English title**, its
**slug**, its **filename and folder**, its **paired locale path**, its **Ukrainian title**, and an
optional **`sidebar_label`**. Every naming decision across planning, creation, translation, alignment,
and style review resolves here; no skill restates the algorithm.

A filename and a title are **not** "literally identical." They stand in a defined normalized and
semantic relationship, set out below.

## The slug-normalization algorithm

1. **The canonical English title determines the slug.** Lowercase the English title, drop articles
   (`a`, `an`, `the`), and convert to **kebab-case**: words separated by single hyphens (`-`), no
   uppercase, no underscores, no spaces. "Platform rules" → `platform-rules`; "View account balances"
   → `view-account-balances`.
2. **A newly created page's parent folder and filename basename both use that slug** — the page lives
   at `platform-rules/platform-rules.md`, not `platform-rules/index.md` and not
   `platform-rules/platformRules.md`.
3. **Both locales use the same relative path and filename.** The Ukrainian source and its English
   translation sit at the same path under their respective roots (the roots themselves are resolved
   via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`). The slug is derived once, from the English
   title, and shared — it is never re-derived from the Ukrainian title.

## Titles

- **The English title names the same topic the slug was derived from.** Slug and English title track
  each other; they cannot describe different things.
- **The Ukrainian title is a natural, semantically equivalent translation of the canonical English
  title** — the same topic, idiomatic in Ukrainian, not a transliteration of the slug.
- **Title form by doc type** (applied when composing or checking a title):
  - **User guide** (task-based): imperative verb phrase — "Add funds", "Manage cards". Not "Adding
    funds", "Fund addition", or "How to add funds".
  - **Concept topic** (background knowledge): noun phrase — "Balance overview", "Transaction
    lifecycle". Not "Understanding balances".
  - **API reference**: noun phrase matching the endpoint's resource — "Create payin transaction",
    "Retrieve transaction details".
- **An explicit `slug:` frontmatter field does not license a semantically unrelated filename or
  title.** If a page declares a slug, it still names the same topic as the title and the filename.

## `sidebar_label`

- If the full, accurate title is **too long for navigation**, keep the accurate title in `title:` and
  add a shorter `sidebar_label:`.
- `sidebar_label` must stay **unambiguous** and **must not change the page's subject** — it is a
  shorter name for the same topic, never a different one.

## Pass / fail fixtures

**Pass** — slug, English title, and Ukrainian title all name one topic:

| Path | EN title | UA title |
|---|---|---|
| `platform-rules/platform-rules.md` | Platform rules | Правила платформи |

**Fail** — the slug/filename says `platform-rules` but the titles name a *different* topic (operator
rules), and the two locale titles don't match each other either:

| Path | EN title | UA title |
|---|---|---|
| `platform-rules/platform-rules.md` | Operator rules | Правила роботи оператора |

## Existing pages — report, never silently rename

- **Do not silently rename an existing file** during an unrelated edit. If an existing page's
  filename, slug, and title don't line up, **report the mismatch** and recommend one of two explicit
  fixes: change the title to match the established slug, or perform a deliberate, **link-aware rename**
  (which must update every inbound link — see
  `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md`). The choice is the user's.

## Intentional exceptions

- **`index.md`** and other **generated files** are legitimate exceptions to the folder-basename-matches-
  slug rule where the toolkit or the host project's build produces them. Do not flag a generated
  `index.md` as a naming violation. Apply the convention to author-created content pages.

## Who applies this

- **Planning** (`section-planner`) — proposes every slug and title with this algorithm.
- **Creation** (`concept-doc-writer`, `user-guide-writer`, `api-doc-writer`) — derives the output
  filename and titles from it.
- **Translation** (`doc-translator`) — keeps the shared path/filename, writes the UA/EN title as the
  semantic equivalent of its counterpart, never re-slugs.
- **Alignment** (`doc-alignment-checker`) and **style review** (`doc-style-reviewer`) — check title
  form and slug/title/filename agreement, and report a mismatch rather than renaming.
