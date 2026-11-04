---
name: heading-anchors
description: The single shared contract for heading ids on Ukrainian pages — the `{/* #id */}` comment every heading from `##` down carries, what the id is, how links use it, and what the EN translation and further locales do with it. Referenced by every skill that writes, edits, translates, or checks headings (user-guide-writer, concept-doc-writer, api-doc-writer, doc-page-updater, doc-translator, doc-alignment-checker, locale-translator) — never copy these rules into a skill file.
metadata:
  type: reference
---

# Heading anchors

Single source of truth for **heading ids** on Ukrainian pages. Every skill that writes, edits,
translates, or checks a heading resolves the rule here; none of them restates it.

## Why the comment exists

Docusaurus renders `## Передумови {/* #prerequisites */}` with the id `prerequisites`: the comment
**is** the heading's id. Without it, the id is a slug of the Ukrainian text (`#передумови`), and every
locale gets its own slug of its own text.

With it, one id serves every locale: the EN heading is written so that Docusaurus generates the same
id, and further locales keep the comment verbatim. So a `#anchor` link, which every translation copies
verbatim, lands on the right heading in every locale.

## The rules

1. **Where.** Every heading from `##` down on a page whose content language is `uk`. The page title
   (`#`) takes none: its link is the page route. Pages written in English take none. Only Markdown
   headings count: a title that a component renders (`<Accordion title="…">`) takes none.
2. **Form.** The comment ends the heading line: `## <text> {/* #<id> */}`. `<id>` is lowercase ASCII
   kebab-case (`[a-z0-9]` words joined by single hyphens): the id Docusaurus generates from the
   **English** heading text. `Transaction statuses` → `transaction-statuses`. Take the English wording
   from the project's EN glossary.
3. **Unique on the page.** A section that repeats (a Reference information section per procedure) adds
   what it belongs to: `reference-information-<slug>`.
4. **Stable.** Once a page is published, its ids don't change, even when a heading's wording does.
   Changing an id breaks every link to it.
5. **Links use the id.** A link to a heading, on the same page (`#transaction-statuses`) or on another
   page (`/archive/archive#transaction-statuses`), uses the id. Never a slug of the Ukrainian text.
6. **English.** The EN heading carries no comment. Write it as the id's words (`#transaction-statuses`
   → `## Transaction statuses`), so Docusaurus generates the same id, even when a closer translation of
   the UA text exists: `## Перегляд транзакцій {/* #transaction-list */}` → `## Transaction list`. Give
   the EN heading the id explicitly only when the id's words can't head the section: the id names a
   parent (`## Reference information {#reference-information-create-payment}`), or its words say
   something the UA heading no longer says.
7. **Further locales.** The comment stays verbatim; only the heading text is translated.
8. **Adding an id to an existing heading** changes that heading's fragment. Whoever adds it also
   rewrites, in the same change, every link that used the old fragment (search the content roots for
   `#<old fragment>`).
9. **No placeholder left in an id.** A template's `{slug}` (or any `{…}`) left inside an explicit
   `{#…}` id breaks the MDX build: MDX evaluates the inner braces as an expression
   (`ReferenceError: slug is not defined`). Inside a `{/* #… */}` comment it builds, but the id comes out
   wrong (`reference-information-{slug}`). Every id is filled in before the page is saved.
10. **A missing id is added at EN translation.** See "Who adds a missing id".

## Who adds a missing id

The **translator** (`doc-translator`), while it translates the page to EN, whole or in sync mode. Every
UA heading of the page from `##` down without a comment gets the **anchor of its EN heading**: the EN
heading's explicit `{#id}`, else the id Docusaurus generates from its text. So an existing EN anchor,
which links may already use, never changes; a heading new to EN gets its id from the EN text the
translator writes (rule 2). In the same change it rewrites every link to the heading's old fragment
(rule 8). `scripts/doc-align` (`--propose-ids --write`) computes both, so the result is an id-only
change (below).

Nobody adds a missing id as a side job of another task: the writers give the headings they draft their
comment (rule 2), and the updater adds one to an existing heading only when the brief asks.

## Id-only changes

Two predicates, defined here once. Skills and scripts cite them by name and never restate them.

**Id-only change.** A UA change is id-only when its only differences from the approved version are (1)
`{/* #id */}` comments added to headings that had none, and (2) link fragments rewritten from such a
heading's old fragment to its new id. Anything else makes it a real change: a changed or removed id, a
changed heading text, or any other edit. A heading's old fragment is the slug Docusaurus made of its
text. A link to another page counts when its path resolves to a page of the same change whose heading
got that id; one that doesn't resolve is a real change. An id-only change keeps the approvals: what was
reviewed and approved on the page before it still stands.

**What locale-sync splices.** The id-only change, plus a changed comment: (1) a `{/* #id */}` comment
added to a heading that had none, or changed on a heading that had one, its level and text unchanged,
and (2) link fragments rewritten from such a heading's old fragment (the slug of its text, or its old
id) to its new id. A further locale copies the comment and every link target verbatim (rule 7), so
`scripts/locale-sync` writes these into every locale with no translator. A changed comment is not an
id-only change: it changes a published id (rule 4), so it is made only to correct an id that differs
from the EN anchor.

## Examples

```md
## Передумови {/* #prerequisites */}
## Статуси транзакцій {/* #transaction-statuses */}
## Сторінка Архів {/* #archive-page */}
## Довідкова інформація {/* #reference-information-create-payment */}

Виберіть потрібні [фільтри](#reference-information-create-payment).
Детальніше дивіться [статуси](/archive/archive#transaction-statuses).
```

EN:

```md
## Prerequisites
## Transaction statuses
## Archive page
## Reference information {#reference-information-create-payment}

Select the [filters](#reference-information-create-payment) you need.
For more information, see [statuses](/archive/archive#transaction-statuses).
```

## Who does what

- **Writers** (`user-guide-writer`, `concept-doc-writer`, `api-doc-writer`): give every heading they
  draft on a `uk` page its comment, and build every heading link from the id.
- **Updater** (`doc-page-updater`): gives a heading it adds its comment; keeps an existing heading's
  comment when it rewords the heading; adds a comment to an existing heading only when the brief asks,
  and then follows rule 8.
- **Translator** (`doc-translator`): rule 6. A UA heading without a comment is legacy content: derive
  the EN heading from its text, then give the UA heading the EN anchor and rewrite the links to its old
  fragment ("Who adds a missing id").
- **Locale translation**: rule 7. `locale-sync` splices what "What locale-sync splices" covers, with no
  translator.
- **Checker** (`doc-alignment-checker`): reports a UA heading from `##` down without a well-formed
  comment, a repeated id, and an EN heading with a comment. Its report says what adding a missing id
  changes (rule 8) and that the translator's step adds it.
