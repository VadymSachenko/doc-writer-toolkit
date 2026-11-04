---
name: glossary-format
description: How to read a product kit glossary — the Term, Render, Code entity and Definition columns, the values of Render, and the names table (UA form, EN form, Source). Read with a kit glossary, in drafting and in review. The rules behind the Render column are Ж1, Ж3 and Ж4 in formatting-conventions.md.
---

# Glossary format

A product's terms live in the host's product kit, not in the plugin: `glossary-ua.md` for Ukrainian pages and `glossary-en.md` for English pages. How a skill finds them is in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Product kit". This file says how to read them. The skeletons in `${CLAUDE_PLUGIN_ROOT}/context/starter-kit/` follow it.

Each glossary holds its terms in one table, under `## Terms` (`## Терміни` in the Ukrainian glossary), with four columns. Names of organizations have a second table (see "Names").

| `glossary-en.md` | `glossary-ua.md` | What the column holds |
|---|---|---|
| Term | Термін | The canonical form of the term |
| Render | Рендер | How the term is formatted in text |
| Code entity | Код-сутність | What the same concept is called in code or in the API |
| Definition | Визначення | What the term means, and the words not to use for it |

## How to read the table

- **Term** is the canonical form. Headwords are capitalized as dictionary entries. **In prose**, common nouns are lowercase ("the refund reaches the account…"). Only proper names and verbatim UI labels keep their capital letters in running text.
- **Render** is binding: take the render from here rather than deciding it in place. The rules behind it are Ж1, Ж3 and Ж4 in `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md`.
- **Code entity** is always in `code font` and always in English, spelled as in the code (Ж4). An empty cell means the concept has no code counterpart.
- One concept can have both a term and a code entity. They are **different entities**, each with its own render (Ж3). Write "the refund" for the concept and `REFUND` for the constant, and don't mix them within one role.
- **Definition** says what the term means. "Don't use:" (`Не використовуйте:`) lists the synonyms a page must not use in its place. "UI label:" (`UI-мітка:`) gives the label the app shows for a code value. "Colloquial:" (`Розм.:`) names a spoken form that SME input may use; pages don't.

## Values of the Render column

| `glossary-en.md` | `glossary-ua.md` | Meaning |
|---|---|---|
| `text` | `текст` | Ordinary type, no styling |
| **`bold`** (UI) | **`жирний`** (UI) | A visible UI label: bold, wording kept verbatim (Ж1; decorative trailing punctuation: Ж1a) |
| `` `code` `` | `` `code` `` | A literal system value or a code entity: code font (Ж4) |
| `*italic*` | `*курсив*` | A new term at its first definition, once (`GDSG-FORMAT-001`) |

## Names

Names of organizations and products (banks, payment systems, companies) have a table of their own, under `## Names` in `glossary-en.md` and `## Назви` in `glossary-ua.md`, after the terms. Both glossaries hold the same rows in the same order: a skill that loads only one of them still finds every name. When you add or change a row, do it in both. The rule that decides a name's form is Ж10 in `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md`.

The table has three columns, in this order in both files.

| `glossary-en.md` | `glossary-ua.md` | What the column holds |
|---|---|---|
| UA form | Форма UA | The name as Ukrainian pages write it, character for character |
| EN form | Форма EN | The name as English pages write it, character for character |
| Source | Джерело | Where each form comes from |

- **One row per organization or product.** The UA form and the EN form may differ (Лунобанк, Lunobank): the row pairs them, so the alignment check doesn't report them as a mismatch. When the two are the same, write it in both cells.
- **The forms are plain text.** No bold, no code font, no quotes: the render comes from where the name stands (Ж1, Ж4 and Ж10). A Cyrillic UA form is the nominative; pages inflect it.
- **Source** names the source of each form, in Ж10's order: `app: <key or screen>` for the app's string, `code: <repo>@<commit>:<path>` for a value in the code, `site: <URL>` for the organization's official site, one per language when they differ (`site: https://example.ua/ (UA), https://example.ua/en/ (EN)`). A form with no source is not approved: mark it `NEEDS CONFIRMATION` in the cell.
- **A name used only in API pages** takes the code's form (Ж10, step 1); its source is `code:`.

## A term that isn't there

A term a page needs that the glossary doesn't list is the fourth situation of Ж4 in `formatting-conventions.md`, which says what to do.

A kit may also hold `glossary.md`, a bilingual list for people that aligns the two glossaries. No skill reads it.
