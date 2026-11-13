---
name: example-values-format
description: How to read a product kit's example values file (system values, example values, existing pairs) and what each skill does with it. The writers take their values from it, doc-translator writes an existing pair's EN value and copies a system value verbatim, further locales copy UA, and the alignment check counts a pair as the same value. The single source of this rule; skills cite it.
---

# Example values format

The values that code samples and examples use live in the host's product kit, in `example-values.md`. How a skill finds the kit is in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Product kit". The file is optional. Without it, a skill goes on and says in its report that the file is not present; the table below says what a writer does then. The skeleton is `${CLAUDE_PLUGIN_ROOT}/context/starter-kit/example-values.md`.

This file is the single place for the rule. It says how to read the kit file and what each skill does with it. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/code-blocks.md` (rule 4) and the skills cite it; none restates it.

One file serves every language. It has three sections, each with one table. A section's heading may be English or Ukrainian.

## System values

Under `## System values` (`## Системні значення`). These are strings the system returns as they are, Ukrainian ones included: an error message, a default value the system fills in, a status text. **A system value is never translated.** It is written as it is in a code block and in inline code that quotes it in prose, in every language.

| Column | What it holds |
|---|---|
| Value | The string in code font, character for character as the system returns it. A letter from another script (a Latin `i` among Cyrillic letters) makes it another value. Write it exactly as the code has it, and note any difference from the pages in Source. |
| Field | Where the value appears: the field, in code font (`` `error` ``), and when (`` `UAH` `` only, for one). |
| Source | Where the value comes from. Look in the code first: `code: <repo>@<commit>:<path>`. If it isn't in the code: `data: <where>`, with how it was read. A value with no source is not approved: write `NEEDS CONFIRMATION` in its cell instead. |

Names of organizations that the API returns (a bank's name in a `bank` field) are in the names table's API values column (`${CLAUDE_PLUGIN_ROOT}/context/doc-rules/glossary-format.md`, "Names"). They are system values too, and this table doesn't repeat them.

## Example values

Under `## Example values` (`## Значення для прикладів`). These are the values examples invent: people's names, phone numbers, card numbers, IBANs, tax numbers, amounts, payment purposes and comments.

- **The same in every language.** An example value is written in English, on Ukrainian pages too. A person's name is a Ukrainian name in Latin letters (Olena Marchenko), and a number is the same digits on every page.
- **Obviously a test value.** Never use a real person's phone number, card or name.
- **A new value is added here first.** A writer that needs a value the table lacks adds a row in the same change as the page and names it in its report.

| Column | What it holds |
|---|---|
| Kind | What the value is: a person's name, a phone number, a card, an IBAN, an amount, a comment. |
| Value | The value in code font, as a code sample writes it, without its quotes. |
| Fields | The fields it fills, in code font. Optional. |

## Existing pairs

Under `## Existing pairs` (`## Наявні пари`). These come from pages written before the file, whose UA and EN code samples hold different values. Each row is a UA value and the EN value that the EN page keeps with it. The pages stay as they are. Nothing adds a pair for new content: a new page uses example values, which need no pair.

| Column | What it holds |
|---|---|
| UA value | The value as the UA page writes it, in code font, without its quotes. |
| EN value | The value as the EN page writes it, the same way. |
| Type | `example` for an invented value. `system` when the EN page translated a system value: the pair only keeps that page aligned, and nothing writes its EN value again. |
| Pages | The pages that hold the pair. For people. No skill reads it. |

A pair counts only as a whole quoted value, from UA to EN, in a code block's code part. A value that holds a pair's UA value inside a longer string is not the pair. Neither is the EN value on the UA side.

## What each skill does

A system value outranks a pair. Neither a `system` pair nor a pair whose UA value is a system value ever makes a skill translate that value.

| Skill | What it does with the file |
|---|---|
| The writers: `api-doc-writer`, `concept-doc-writer`, `user-guide-writer`, `doc-page-updater` | Take each invented value in a code sample or an example from Example values, the same on a UA page as on an EN page. Take a value the system returns from System values, or from the code, and write it exactly as it is there. Add a value neither table has to Example values first (see above). Never write an existing pair's value into new content. `doc-page-updater` does this for each value it adds; a value the page already has stays as it is. With no example values file, write each invented value as an obviously test value in English, put a `{/* NEEDS CONFIRMATION */}` marker after the sample, and say in the report that the kit has no example values file. |
| `doc-translator` (UA → EN) | Copies a code block's data as it stands (`code-blocks.md`, rule 4), with one exception. A quoted value that is the UA value of an `example` pair becomes that pair's EN value, in a whole-page translation and in each block that `--sync` re-translates. A system value, and the UA value of a `system` pair, stay verbatim. Inline code that quotes a system value stays verbatim in prose. The report lists the pairs written. It also lists any Cyrillic value in a code block that is in none of the three tables: copied verbatim, a candidate for the file. |
| The locale worker (`locale-translator`, further locales) | Copies a code block's data from UA as it stands, as before. The pairs are for EN only. A further locale never takes a pair's EN value. The worker doesn't read this file. |
| `doc-alignment-checker` (`doc-align --examples`) | Check 6 counts an existing pair as the same value. In a code block's code part, a quoted UA value of a pair may be, on the EN side, that value or the pair's EN value. Every other difference is still a `CODE-BLOCK-MISMATCH` bug. An EN line that kept the UA value of an `example` pair is an `EXAMPLE-PAIR-NOT-APPLIED` warning: the translator writes the EN value there. |
