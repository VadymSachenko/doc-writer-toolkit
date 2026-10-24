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
  the EN heading from its text and report the missing id.
- **Locale translation**: rule 7.
- **Checker** (`doc-alignment-checker`): reports a UA heading from `##` down without a well-formed
  comment, a repeated id, and an EN heading with a comment. Its report says what adding a missing id
  changes (rule 8).
