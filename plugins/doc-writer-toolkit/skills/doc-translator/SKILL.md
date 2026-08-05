---
name: doc-translator
description: Translates an approved UA documentation page into English, at the corresponding path in the project's own declared EN i18n root. Preserves all MDX/code structure and enforces the project EN glossary. Use explicitly ("translate-doc", "use doc-translator to translate...").
---

# doc-translator

You are translating an approved Ukrainian documentation page for UniComPay into English. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing a correct English translation end-to-end.

## Scope

- **In scope:** any Markdown/MDX page under the project's UA content root that has been approved in Ukrainian. Produces the English version at the corresponding path under the project's EN i18n root (see Path mapping).
- **Out of scope:** writing new content, changing structure, fixing errors in the Ukrainian source, English-only reference sections with no UA counterpart (e.g. an API reference `docs/` tree in a project that splits UA and EN content into separate roots).

## Path mapping

Resolve the project's actual roots via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` before doing anything else — do not assume `partner-cabinet/`.

| Ukrainian source | English output |
|---|---|
| `<UA content root>/<relative-path>.md` | `<EN i18n root>/<relative-path>.md` |

Example, for a project whose declared UA content root is `partner-cabinet/` and EN i18n root is `i18n/en/docusaurus-plugin-content-docs-partner-cabinet/current/`:
- `partner-cabinet/transactions/transactions.md` → `i18n/en/docusaurus-plugin-content-docs-partner-cabinet/current/transactions/transactions.md`

## Sources to load

Load these files at the start of the task.

**Project paths (resolve first):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` to resolve this project's **UA content root** and **EN i18n root**. Do not assume `partner-cabinet/` or any other default. If either is undeclared, follow that file's fallback (ask once, offer to persist to the project's `CLAUDE.md`).

- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md` — canonical EN terminology. Use it to replace UA terms with their correct EN equivalents.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` — rank-0 project formatting conventions. Core section and English section apply. Outranks this skill's own body for any rule both cover.
- The Ukrainian source file, at the path resolved above.

**Style guide (project-declared, resolved before translating):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — "Resolving which guide a project uses" section — to find this project's declared `Style guide:` token, then that file's "Loading procedure per guide" for the resolved token, mapping the content you're about to translate (terminology, tone, notation, procedures, punctuation) to the matched topical files.
- If the project has no declared style guide, follow the registry's fallback: ask once, offer to persist the answer to that project's `CLAUDE.md`.
- Do not hand-copy a guide name, corpus path, or individual rule into this skill file. `context/doc-rules/style-guide-rules/` is a retired, unmaintained digest — do not load it.

## What to translate

**Always translate:**
- Frontmatter `title:` and `description:` values
- All prose paragraphs
- Heading text (strip the `{/* #anchor */}` comment — see Heading IDs below)
- List item text that is prose (not a code value, not a placeholder)
- Admonition body text
- Table cell text that is prose
- Link anchor text (but not the URL itself)

**Never translate:**
- Code blocks (` ``` `) — preserve byte-for-byte, including comments inside
- Inline code (`` `backtick` ``) — preserve exactly
- JSON keys and values inside code blocks
- HTTP methods and paths (`POST /transaction/create`)
- Reader-replaced placeholders: `*`\``UPPER_CASE`\``*`
- MDX component names and attribute names (`<details>`, `<summary>`, `:::note`, `<Icon>`, etc.)
- Frontmatter keys (`title`, `sidebar_position`, `slug`, etc.) — translate values only
- URLs and `href` values — copy link paths verbatim from the Ukrainian source
- Status values in code font: `new`, `in queue`, `in work`, `success`, `cancelled` — these are already English

## Translation rules

### Heading IDs

All UA headings in the UA content root carry an anchor comment: `## Передумови {/* #prerequisites */}`.

When translating to English:
- The text inside `{/* #... */}` is the canonical EN anchor slug. Derive the EN heading from it (convert kebab-case to title/sentence words).
- **Remove** the `{/* #... */}` comment from the EN output — EN headings do not carry anchor comments; Docusaurus generates their anchors automatically from the heading text.

```md
UA:  ## Передумови {/* #prerequisites */}
EN:  ## Prerequisites

UA:  ## Статуси транзакцій {/* #transaction-statuses */}
EN:  ## Transaction statuses

UA:  ## Сторінка Архів {/* #archive-page */}
EN:  ## Archive page
```

If a UA heading has no anchor comment (legacy content), derive the EN heading directly from the UA text. Flag it in the Step 6 report as a missing anchor.

### Terminology

Use `glossary-en.md` as the single source of truth. Before translating prose, scan the Ukrainian text for every canonical UA term and replace it with the canonical EN term.

**UCP naming:** always write the system name as **UCP**. Never write UCPay, UniComPay, or any other variant — in prose, comments, or UI labels.

Key mappings:

| UA | EN |
|---|---|
| Партнер | Partner |
| Кінцевий клієнт | End client |
| Транзакція | Transaction |
| Вхідна транзакція | Inbound transaction |
| Вихідна транзакція | Outbound transaction |
| Вебхук | Webhook |
| API-токен | API token |
| Кабінет партнера | Partner cabinet |
| Віджет | Widget |
| Моніторинг | Monitoring |
| Архів | Archive |
| Диспут | Dispute |
| Переміщення | Move |
| Робоча група | Work group |

### Voice and register

- **Person:** second person — _you_ (not _one_).
- **Voice:** active. Avoid passive constructions when a natural active alternative exists.
- **Tense:** present tense for descriptions of current behavior.
- **Mood:** imperative for step-by-step instructions.
- **Tone:** professional but direct; no marketing adjectives.

### Sentence structure

Do not mirror Ukrainian word order mechanically. Use natural English Subject–Verb–Object order.

### Capitalization

- Sentence case for headings (same rule as Ukrainian).
- Status values remain in code font and stay in English: `new`, `in queue`, `in work`, `success`, `cancelled`.

### Task-based headings

Use bare infinitive verb phrases in English, not gerunds:

| Ukrainian | English |
|---|---|
| Фільтрувати транзакції | Filter transactions |
| Переглянути деталі транзакції | View transaction details |
| Скасувати транзакцію | Cancel a transaction |
| Керувати квитанціями | Manage receipts |

### Markers

Carry all `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}` markers through into the English output. Translate the text inside the marker comment. Do not resolve or remove them — they require human sign-off regardless of language.

### Word choices

Common translation traps:

| UA pattern | Avoid | Use instead |
|---|---|---|
| `бокове меню` / `у боковому меню` | "side menu" | "sidebar" |
| `дозволяє` / `дає змогу` | "allows you to" | "lets you" |
| `введіть` (text input) | "type" | "enter" |
| `через` (method or channel) | "via" | "through" or "by using" |
| `для того, щоб` / `щоб` | "in order to" | "to" |
| `може` (possibility) | "may" | "might" or "can" |
| `слід` / `потрібно` (required) | "should" | "must" |
| `слід` / `можна` (optional) | "should" | "can" |
| `після того, як` | "once X is done" | "after X is done" |
| `отримати доступ до` | "access" | "open", "view", or "find" |
| `натисніть **X**` | "**X** the settings" (UI name as verb) | "Click **X**" |

Also avoid: `please`, `e.g.`, `i.e.`, `etc.`, `and/or`, `above` or `below` for document position.

### Accordion titles

The `<Accordion title="...">` attribute is prose and must be translated. Apply the same heading rules:

- Task-based titles: bare infinitive — `title="View receipts"`, `title="Add a receipt"`.
- Concept titles: noun phrase — `title="Transaction status model"`.
- Do not use gerunds: `"Viewing receipts"` is wrong.

### Procedure intro sentences

Ukrainian source often opens a procedure with "Щоб {ціль}, виконайте такі кроки:" or "Щоб {ціль}, виконайте такі дії:".

**Remove the intro sentence** when both conditions hold:
- The sentence restates the enclosing heading or `<Accordion title>` (same action, same object).
- No admonition (`:::note`, `:::warning`, etc.) or prose paragraph appears between the heading/title and the numbered steps.

**Keep the intro sentence** (translated as usual) when either condition holds:
- The sentence conveys context not in the heading — states a prerequisite, names a required tool, or adds a condition.
- An admonition or prose paragraph already appears before the sentence — that content provides context the reader sees first.

Examples:

| Heading / title | Sentence | Verdict |
|---|---|---|
| `## Filter disputes` | `To filter disputes, follow these steps:` | **Remove** — sentence matches heading, nothing before it |
| `Create a dispute ticket for an inbound transaction` | `To create a dispute ticket for an inbound transaction, follow these steps:` | **Remove** — sentence matches accordion title, nothing before it |
| `Enable two-factor authentication` | intro paragraph about Microsoft Authenticator, then `To enable two-factor authentication, follow these steps:` | **Keep** — paragraph before the sentence |
| `Change the time zone` | `:::warning` then `To change the time zone, follow these steps:` | **Keep** — admonition before the sentence |

### Isolated steps

A step that consists only of clicking or tapping a UI element — with no explanation of what it achieves — is an isolated step. It must be expanded.

Expand by prepending the purpose: **`To {purpose}, click <Icon…>.`**

- ⛔ `2. Click <Icon icon="ei:plus" color="#F79F14" width="20"/>.`
- ✓ `2. To create a dispute ticket, click <Icon icon="ei:plus" color="#F79F14" width="20"/>.`

Derive the purpose from the surrounding context (accordion title, adjacent steps, or the result statement).

### Fixed patterns

Translate these recurring UA patterns consistently:

| UA | EN |
|---|---|
| `**Результат:**` | `**Result:**` |
| `Детальніше дивіться [X](url)` | `For more information, see [X](url)` |
| `У таблиці описано атрибути, з якими ви взаємодієте під час X:` | `The following table describes the attributes you interact with when X:` |
| `ви можете виконувати такі операції` | `you can do the following` |
| `ви можете виконувати такі операції з X` | `you can do the following with X` |
| `## Передумови` + single reference section | `## Prerequisites` + `Before you start, review the [reference information](#reference-information), or look up the necessary information as you go through the process.` |
| `## Передумови` + multiple reference sections | `## Prerequisites` + `Each section contains [reference information](#reference-information). Review it before you start, or look up the necessary information as you go through the process.` |
| bare `За потреби перед виконанням кроків перегляньте довідкову інформацію.` (no `## Передумови` heading) | Still produce a full `## Prerequisites` section with the standard single-reference sentence. Never output a bare sentence without the heading. |
| Paperclip icon for receipts | `receipts icon <Icon icon="uiw:paper-clip" color="#F79F14" />` — always "receipts icon"; never "receipt management icon", "receipt icon", or other variants |

**Cross-reference link text:** Do not repeat the subject when it matches the link text. "For more information about X, see [X]" is redundant — omit "about X":

- ✓ Recommended: `For more information, see [Transactions](/partner-cabinet/transactions/).`
- ⛔ Not recommended: `For more information about transactions, see [Transactions](/partner-cabinet/transactions/).`

Use "about X" only when the subject differs from the link text: `For more information about filtering, see [Transactions](/partner-cabinet/transactions/).`

### Capitalize after a colon

After a `:` in prose, capitalize the first letter of the following word if it is a regular word — not a UI element name, proper name, code value, or HTML tag:

- ✓ `No Storno was applied.`
- ✓ `A receipt is attached to the transaction.`
- ⛔ `no Storno was applied.`

Do not capitalize after a colon that introduces a list, a code sample, or a UI element name: `Supported formats: PNG, JPEG, PDF` — PNG is already capitalized by convention and is not a sentence continuation.

## Workflow

### Step 1 — Locate the source file

Read the Ukrainian source at `<UA content root>/<relative-path>.md`, using the root resolved from `project-paths.md`. If the file does not exist, stop and tell the user before doing anything else.

Check whether an English version already exists at the target path. If it does, read it and note any content that has diverged from the Ukrainian source (e.g., manual edits). Report this to the user and ask whether to overwrite or merge.

### Step 2 — Pre-translation scan

Before translating, produce an internal checklist (do not show to the user unless asked):

- List every canonical UA term found in the prose (check against `glossary-en.md` UA→EN mapping).
- Note any term not in the glossary that may need an EN equivalent.
- Note any `{/* NEEDS CONFIRMATION */}` or `{/* ToDo */}` markers that will carry over.

### Step 3 — Translate

Produce the full English page. Apply every rule in the **What to translate** and **Translation rules** sections above.

Do not alter page structure, section order, heading levels, admonition types, code samples, or link paths.

### Step 4 — Self-review

Before saving, check:

- Every canonical UA term in prose has been replaced with its EN glossary counterpart
- No Ukrainian prose sentences remain (code blocks and inline code excepted)
- No Cyrillic characters appear outside code blocks
- No passive constructions where an active alternative is natural
- No future tense (`will`, `would`) in descriptions of current behavior
- No marketing adjectives
- All `{/* NEEDS CONFIRMATION */}` and `{/* ToDo */}` markers from the source are present in the output (translated)
- Frontmatter keys are untouched; only translatable values are changed
- All code blocks are byte-for-byte identical to the source
- No `{/* #anchor */}` comments appear in EN headings
- No "UCPay" or "UniComPay" in prose — only "UCP"
- `## Передумови` translated as `## Prerequisites` with the correct EN sentence (Variant A if a single reference section; Variant B if multiple)
- After colons in prose: first word is capitalized if it is a regular word (not a UI element name, proper name, or code value)
- No spaces around em dashes: `word—word`, not `word — word`
- `ви можете виконувати такі операції` → `you can do the following` (never "perform the following operations")
- No "side menu" (use "sidebar"); no "allows you to" (use "lets you"); no "via" (use "through" or "by using"); no "type" for text input (use "enter")
- No "in order to" (use "to"); no "may" for possibility (use "might" or "can"); no "once" when meaning "after"
- Number and abbreviation formatting follows `formatting-conventions.md` English section
- All `<Accordion title="...">` attribute values are translated; task-based titles use bare infinitive, not gerund
- `**Результат:**` → `**Result:**`; `Детальніше дивіться` → `For more information, see`
- Cross-reference link text does not repeat the subject when it matches the link label
- No intro sentence where the sentence restates the enclosing heading or accordion title AND no admonition or prose paragraph precedes the numbered steps — remove it
- No isolated step that consists only of clicking a UI element — expanded to "To {purpose}, click …"
- Paperclip icon labeled `receipts icon <Icon icon="uiw:paper-clip" color="#F79F14" />` — never "receipt management icon" or any other variant
- `## Prerequisites` always uses the heading + standard sentence — never a bare sentence without the heading, even if the UA source omits the heading

### Step 5 — Save

Write the English file to `<EN i18n root>/<relative-path>.md`, using the root resolved from `project-paths.md`. Create intermediate directories as needed.

Set `last_update.date` in the English output to today's date (format: `M/D/YYYY`).

Also update `last_update.date` in the Ukrainian source file to today's date. This is the only permitted change to the Ukrainian source.

Do not modify any sidebar config file (`sidebars.ts`, or a project's custom-id equivalent like `sidebarsPartnerCabinet.ts`), `docusaurus.config.ts`, or any JSON files.

### Step 6 — Report

After saving, report:

- Source path read
- Output path written
- Any `{/* NEEDS CONFIRMATION */}` items (including unconfirmed glossary terms)
- Any `{/* ToDo */}` items carried over from the source
- Any UA terms found in prose that had no glossary entry (flag these for the user to decide)
- Any errors in the Ukrainian source (step numbering, broken links, typos) — copied as-is into the EN output; listed here for human review. Do not fix source errors.

## When the source file has unresolved markers

Carry all `{/* NEEDS CONFIRMATION */}` and `{/* ToDo */}` markers into the English output unchanged (with text translated). Do not resolve or remove them.

## Explicit invocation examples

This skill triggers only when the user names it explicitly or via the `/translate-doc` command. Examples of valid invocations:

- `/translate-doc transactions/filter-transactions/filter-transactions`
- "Use doc-translator to translate partner-cabinet/transactions/transactions.md"
- "doc-translator: translate the manage-receipts page"

If the user asks for translation without naming this skill, suggest invoking it but wait for explicit permission.
