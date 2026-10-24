---
name: doc-translator
description: Translates an approved UA documentation page into English, at the corresponding path in the EN i18n root of the page's root pair. Preserves all MDX/code structure and enforces the project EN glossary. Use explicitly ("translate-doc", "use doc-translator to translate...").
---

# doc-translator

You are translating an approved Ukrainian documentation page for UniComPay into English. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing a correct English translation end-to-end.

## Scope

- **In scope:** any Markdown/MDX page under a declared root pair's UA content root that has been approved in Ukrainian. Produces the English version at the corresponding path under that pair's EN i18n root (see Path mapping).
- **Out of scope:** writing new content, changing structure, fixing errors in the Ukrainian source, a page outside every declared root pair.

## Path mapping

Resolve the page's root pair via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` ("Resolving a page's root pair") before doing anything else — do not assume any folder.

| Ukrainian source | English output |
|---|---|
| `<pair's UA content root>/<relative-path>.md` | `<pair's EN i18n root>/<relative-path>.md` |

Example, for a pair whose UA content root is `portal/` and EN i18n root is `i18n/en/docusaurus-plugin-content-docs-portal/current/`:
- `portal/transactions/transactions.md` → `i18n/en/docusaurus-plugin-content-docs-portal/current/transactions/transactions.md`

## Sources to load

Load these files at the start of the task.

**Project paths (resolve first):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` to resolve the page's **root pair**: its **UA content root** and **EN i18n root**. Do not assume any default. If either is undeclared, follow that file's fallback (ask once, offer to persist to the project's `CLAUDE.md`).

- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md` — canonical EN terminology. Use it to replace UA terms with their correct EN equivalents.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` — rank-0 project formatting conventions. Core section and English section apply. Outranks this skill's own body for any rule both cover.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md` — the shared page-to-page link contract. Translation **preserves an already-correct route verbatim** (see "Never translate" and Step 4); do not re-derive or localize a path.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/heading-anchors.md` — the shared heading-id contract (see Heading IDs below).
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md` — the shared slug/title convention. The EN and UA pages share one path/filename; the EN `title:` is the semantic equivalent of the UA title. Never re-slug or move the page.
- The Ukrainian source file, at the path resolved above.

**Style guide (project-declared, resolved before translating):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — "Resolving which guide a project uses" section — to find this project's declared `Style guide:` token, then that file's "Loading procedure per guide" for the resolved token, mapping the content you're about to translate (terminology, tone, notation, procedures, punctuation) to the matched topical files.
- If the project has no declared style guide, follow the registry's fallback: ask once, offer to persist the answer to that project's `CLAUDE.md`.
- Do not hand-copy a guide name, corpus path, or individual rule into this skill file.

## What to translate

**Always translate:**
- Frontmatter `title:`, `description:` and `sidebar_label:` values
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
- The inline icon of an icon-only control (Ж8 in `formatting-conventions.md`), whole: an `<Icon icon="…" … />` component, or an `<img src={require('./.assets/…-icon.png').default} … alt="" />` (`.svg` too, `?url` included). Its `alt=""` stays empty; the name next to it is translated as a UI label
- Frontmatter keys (`title`, `sidebar_position`, `slug`, etc.) — translate values only
- URLs and `href` values — copy link paths verbatim from the Ukrainian source. Per `internal-links.md`, the two locales share one site-root-relative route; an already-correct UA page link is the EN page link unchanged. Do not re-derive, localize, or "fix" a path here.
- Status values in code font: `new`, `in queue`, `in work`, `success`, `cancelled` — these are already English

## Translation rules

### Heading IDs

UA headings from `##` down carry an id comment, per `heading-anchors.md`: `## Передумови {/* #prerequisites */}`.

When translating to English:
- The text inside `{/* #... */}` is the canonical EN anchor slug. Derive the EN heading from it (convert kebab-case to title/sentence words).
- **Remove** the `{/* #... */}` comment from the EN output — EN headings do not carry anchor comments; Docusaurus generates their anchors automatically from the heading text.
- Use the id's words even when a closer translation of the UA text exists (`## Перегляд транзакцій {/* #transaction-list */}` → `## Transaction list`). Only when the id's words can't head the section (the id names a parent, such as `reference-information-<slug>`, or its words say something the UA heading no longer says), write the EN heading naturally and give it the id explicitly, never as a comment: `## Reference information {#reference-information-create-payment}`. The EN heading's id always equals the UA comment's id.

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

Expand by prepending the purpose, and name an icon-only control in the English sentence form of Ж8 (`formatting-conventions.md`): **`To {purpose}, click the <icon> **{Name}** button.`** The noun follows the UA descriptor: «кнопка» → **button**, «піктограма» → **icon**.

- ⛔ `2. Click <Icon icon="mdi:plus" height="20" />.`
- ✓ `2. To create a dispute ticket, click the <Icon icon="mdi:plus" height="20" /> **Create** button.`

Derive the purpose from the surrounding context (accordion title, adjacent steps, or the result statement). Take the name only from the UA step. When the UA step has none (Ж8 branch 3: a description and a `NEEDS CONFIRMATION` marker), translate the description, carry the marker over, and never supply a name yourself. Keep the icon markup as the UA page has it. The verb is the one Ж8 gives for the declared style guide (**click** or **select**).

### Fixed patterns

Translate these recurring UA patterns consistently:

| UA | EN |
|---|---|
| `**Результат:**` | `**Result:**` |
| `Детальніше дивіться [X](url)` | `For more information, see [X](url)` |
| `У таблиці описано атрибути, з якими ви взаємодієте під час X:` | `The following table describes the attributes you interact with when X:` |
| `ви можете виконувати такі операції` | `you can do the following` |
| `ви можете виконувати такі операції з X` | `you can do the following with X` |
| `## Передумови` + single reference section | `## Prerequisites` + `Before you start, review the [reference information](#reference-information-{slug}), or look up the necessary information as you go through the process.` |
| `## Передумови` + multiple reference sections | `## Prerequisites` + `Each section contains [reference information](#reference-information-{slug}). Review it before you start, or look up the necessary information as you go through the process.` |
| bare `За потреби перед виконанням кроків перегляньте довідкову інформацію.` (no `## Передумови` heading) | Still produce a full `## Prerequisites` section with the standard single-reference sentence. Never output a bare sentence without the heading. |

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

Read the Ukrainian source at `<pair's UA content root>/<relative-path>.md`, using the pair resolved from `project-paths.md`. If the file does not exist, stop and tell the user before doing anything else.

Check whether an English version already exists at the target path. If it does, read it and note any content that has diverged from the Ukrainian source (e.g., manual edits). Report this to the user and ask whether to overwrite or merge — **unless the caller asked for sync mode**, which answers that question by design (see "Sync mode" below).

### Sync mode — `--sync [--base <ref> | sections:"…" | report:<update-report.md>]`

Use when an EN page already exists and only part of the UA page changed. Nothing is asked; the default whole-page mode is untouched for callers that do not pass `--sync`.

1. **No EN page at the target path** → say so and fall back to the normal full translation.
2. **Find the changed UA blocks** through `${CLAUDE_PLUGIN_ROOT}/context/changed-blocks.md` (an `update-report.md` from `doc-page-updater`, else `git diff <base>...HEAD -- <page>` with `origin/main` as the default base, else the explicit `sections:` list). A base ref that does not exist → stop and name it. Nothing changed in the UA root → report and stop without touching files.
3. **Map each block to its EN counterpart** by heading path (headings are matched by position within the parent section when the UA heading itself was renamed) and, inside a section, by block order — paragraph to paragraph, list item to list item, table row to table row. A block that cannot be mapped is reported with the UA text quoted — never translated into a guessed place.
4. **Re-translate only the mapped blocks**, with every rule of this skill; leave every other EN byte identical. A UA section added / removed / moved → add / remove / move the EN section accordingly (translating an added one). A changed block inside an admonition or MDX component → the block boundary is that body. Frontmatter `title`/`description`/`sidebar_label` changed → update only the mirrored EN values.
5. **Manual EN edits inside a re-translated block are overwritten** — list them in the report under "EN edits overwritten" with the old EN text.
6. Steps 4 (self-review, applied to the re-translated blocks) and 5 (save, `last_update.date` in both files) run as usual; then run `doc-alignment-checker` on the pair and include its result in the report.
7. Report: blocks replaced, added, removed; unmapped blocks; EN edits overwritten; the alignment result. State the source of "what changed" (report / diff base / list) as `changed-blocks.md` requires.

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
- In a project with more than one root pair, the output path is under the source page's pair EN i18n root
- The EN `title:` is the semantic equivalent of the UA title, and an EN `sidebar_label:` of the UA one (`naming-conventions.md`); the output path, filename, and any `slug:` field are unchanged from the source's shared path — the page was not re-slugged or moved
- Every page-to-page link path is byte-identical to the UA source (`internal-links.md`); no route was localized or "corrected"
- All code blocks are byte-for-byte identical to the source
- No `{/* #anchor */}` comments appear in EN headings
- Every EN heading's id, generated from its text or explicit `{#id}`, equals its UA heading's comment id (`heading-anchors.md`)
- No explicit `{#id}` contains a `{…}` placeholder (`heading-anchors.md` rule 9); a placeholder in the UA comment is reported, not carried into EN
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
- Every inline icon of an icon-only control is byte-identical to the UA source, its `alt=""` still empty; no icon-only control got a name the UA step doesn't give (Ж8)
- Every `*-icon.*` file the EN page references exists in the EN page's `.assets/` (copied in Step 5 if it was missing)
- `## Prerequisites` always uses the heading + standard sentence — never a bare sentence without the heading, even if the UA source omits the heading

### Step 5 — Save

Write the English file to `<pair's EN i18n root>/<relative-path>.md`, using the pair resolved from `project-paths.md`. Create intermediate directories as needed.

Copy the icon files the page needs. An icon crop or SVG (`*-icon.png`, `*-icon.svg`, Ж8) doesn't depend on the language, but the EN page resolves `require('./.assets/…')` against its own folder. For each `*-icon.*` file the page references, copy it from the UA page's `.assets/` into the EN page's `.assets/` when it is missing there. Never overwrite a file that exists, and copy no other image: screenshots have their own EN versions.

Set `last_update.date` in the English output to today's date (format: `M/D/YYYY`).

Also update `last_update.date` in the Ukrainian source file to today's date. This is the only permitted change to the Ukrainian source.

Do not modify any sidebar config file (`sidebars.ts`, or a project's custom-id equivalent like `sidebarsPartnerCabinet.ts`), `docusaurus.config.ts`, or any JSON files.

### Step 6 — Report

After saving, report:

- Source path read (as `<pair>:<path>` when the project declares more than one root pair)
- Output path written
- Each icon file copied into the EN page's `.assets/`, or "none"
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
