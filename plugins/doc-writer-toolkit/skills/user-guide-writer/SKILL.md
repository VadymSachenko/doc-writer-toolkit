---
name: user-guide-writer
description: Writes user guide pages (procedural docs) for the UniComPay partner cabinet, in the project's declared content language, following the authoring rules in CLAUDE.md. Use explicitly ("use user-guide-writer to document...", "user-guide-writer: write the Filter transactions page"). Follows ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-user-guide-template.md (Ukrainian, Операції/Етапи structure) or user-guide-template.md (English, single/multi-task structure), with a mandatory interview phase before drafting. Not for concept topics or API reference pages.
---

# user-guide-writer

You are writing a procedural user guide page for the UniComPay partner cabinet, in the content language this project declares. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing a procedural user guide end-to-end.

## Scope

- **In scope:** task-based procedural pages that walk a partner through a specific action in the partner cabinet. One topic per page. Covers both single-procedure pages and multi-procedure overview pages.
- **Out of scope:** concept topics explaining how something works (`concept-doc-writer`'s job), API reference pages (`api-doc-writer`'s job), EN translations of a UA-authored page (`doc-translator`'s job — only relevant on a project that translates rather than dual-authors), sidebar config changes.

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

**Content language (resolve first — decides which of the remaining bullets apply):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` to resolve this project's declared `Content language:` (`uk`, `en`, or `uk,en`) for the target file, plus its **UA URL prefix** (needed to build absolute links to other doc pages — see the internal-link rule in Step 6). For `uk,en`, the target file's location relative to the declared UA content root / EN i18n root decides which language you're drafting in. If undeclared, follow that file's fallback (ask once, offer to persist).

**Templates (load the one matching the resolved language):**
- `uk` → `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-user-guide-template.md` — Операції/Етапи structure.
- `en` → `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/user-guide-template.md` — single/multi-task, single/multi-phase structure.
- Read the Design rules section of whichever one you load before drafting. Authoritative structure either way. When the template and examples disagree, the template wins.

**Project rules:**
- `uk` → `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md`; `en` → `glossary-en.md` — canonical terminology for the resolved language.
- **`uk` only** → `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/native-ukrainian.md` — rank-0 natural-Ukrainian prose rules (literal-English syntax, ambiguous reference, mechanical repetition, «вікно» not «діалог», self-reference «ця сторінка» not «цей посібник», discretionary dashes). Load only on a `uk` page; it has no `en` counterpart. Drives the native-Ukrainian reread in Step 8.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-integration-context.md` — cross-cutting facts about the API (balances, transaction lifecycle, webhooks, disputes, auth, business rules). Always applicable background.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` — rank-0 project formatting conventions (what bold/italic/code font mean here, placeholder form, one-entity-one-render, code-entity vs. human concept). Outranks everything else loaded for this task, including this skill's own body. Loaded regardless of resolved language.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-selection.md` — shared screenshot selection procedure: three-folder model, four selection cases, sensitive-content screening, rename pattern, full-page vs. compact classification.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md` — the shared page-to-page link contract (see the link rule in Step 6).
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md` — the shared slug/title/filename convention (used to name the output file and title in Step 9).

**UA grammar — only when the resolved language is `uk`:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/00-cheatsheet.md` — always-loaded quick reference for UA orthography. Do not load this on an `en` page; English sentence-style rules live in `formatting-conventions.md`'s English section instead.

**Style guide (project-declared, resolved before drafting):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — "Resolving which guide a project uses" section — to find this project's declared `Style guide:` token, compose it with the resolved content language into a profile (`<guide>@<lang>`), then follow that guide's "Loading procedure per guide" entry, mapping the content you're about to write (steps, tables, admonitions, screenshots' surrounding prose, etc.) to the matched topical files.
- Apply every matched rule while drafting, not just at a later review pass.
- If the project has no declared style guide, follow the registry's fallback: ask once, offer to persist the answer to that project's `CLAUDE.md`.
- Do not hand-copy a guide name, corpus path, profile logic, or individual rule into this skill file — the registry is the single source of truth and changes independently of this file.

**Examples — voice and tone reference only, regardless of the resolved content language:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/user-guide-examples/user-guide-example-create-branches.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/user-guide-examples/user-guide-example-edit-links.md`

These examples illustrate prose density, step phrasing, screenshot placement, admonition use, and result block formatting. They do **not** define the target structure, and their own language does not dictate yours. For sections, headings, and required content, follow the template. When an example and the template disagree, the template wins.

## Workflow

Execute the steps in order. Do not skip the interview.

### Step 1 — Locate inputs

Resolve this project's UA content root (or, on an `en` page, its EN i18n root — see `project-paths.md`) for the target location; do not assume `partner-cabinet/`. Ask the user for the target doc folder if not provided (e.g., `<content root>/transactions/manage-transactions/filter-transactions/`). Sources live inside that folder.

**Each user guide page has its own `.assets/` folder**, co-located with the page file (e.g., `filter-transactions/.assets/`). If the folder does not exist, create it before copying any screenshots into it. Never place a page's screenshots in a parent folder's `.assets/` or in a shared assets directory — every page owns its own copy of the screenshots it embeds, even if those screenshots duplicate files from another page.

List the files present. Expected contents:
- `.sources/app-notes.md` — **optional**; structured evidence written by `app-explorer` when it has run. Load if present; skip if absent — do not require it. Direct app observation, so the highest-confidence source for UI facts (exact screen names, button labels, column headers, status values, and answers to previously open questions). When it and `sme-interview.md` disagree on a UI detail, prefer `app-notes.md`. **Primary source whenever it is present.**
- `.sources/sme-interview.md` — SME brief or interview transcript. Primary source only when `app-notes.md` is absent. Notify the user and request an alternative **only if both `app-notes.md` and `sme-interview.md` are absent** — if either is present, proceed without asking.
- `.sources/notes.md` — writer's own notes; treat as authoritative. If `notes.md` and `app-notes.md` disagree, `notes.md` wins — it is the writer's deliberate override of a raw observation.
- `.sources/frames/{video-basename}-frames/` — the full archive of frames extracted from a source recording, plus a `frames-index.json` alongside them. This is evidence, not embeddable material — never insert a file from here directly into the page. See "Selecting screenshots" in Step 2.
- `.assets/*.png` — screenshots already selected and ready to embed in the doc.
- `.assets/ref/*.png` — reference-only screenshots (read for context; never embed in the doc). This folder is optional. If it does not exist or is empty, treat all files directly in `.assets/` as both context and embeddable.

Also check existing approved pages under the content root for contextual consistency — only after exhausting the source files. Do not copy structure or prose from them.

If neither `.sources/` nor `.assets/` exists, ask the user where the inputs are before proceeding.

### Step 2 — Analyze inputs

Read every file in `.sources/`. Extract:
- The task or goal the partner is trying to accomplish
- Every action the partner must take (clicks, fields, selections, submissions)
- UI elements involved: screen names, button labels, field names, dropdowns, banners, modals
- Preconditions the partner must meet before starting
- Expected outcomes and what success looks like
- Warnings, irreversible actions, or constraints
- Any branching paths or alternative flows
- Webhook events or API calls triggered by the action (if relevant to the partner)
- Whether this page has one procedure or multiple that together form a workflow

**Selecting screenshots:** follow `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-selection.md` — it covers the three-folder model, the four selection cases, the sensitive-content screening requirement, the rename pattern, and the full-page vs. compact classification. Apply every rule in that file before embedding or renaming any screenshot.

Note the final filename and classification per file; both are used in Step 6.

Choose the embed syntax based on the classification:
- **Full-page**: `![Descriptive alt text](./.assets/image.png)`
- **Compact** (dialog, modal, narrow panel): `<img src={require('./.assets/image.png').default} width="{compact-width}" alt="Descriptive alt text" />` — `{compact-width}` is the project's resolved `Compact image width:` (default `480`); see `screenshot-selection.md`.

### Step 3 — Choose the structure

Based on the analysis, decide before drafting, using the vocabulary of the template resolved for this language:

- **`uk` (ua-user-guide-template.md) — Операції vs Етапи:**
  - **Операції** — one or more discrete, independent procedures. Single operation: no `## Операції з {назва}` wrapper and no `<Accordion>`, use `## {Назва операції}` directly. Multiple operations: wrap each in `<Accordion titleAs="h3" title="{Назва}">` under `## Операції з {назва}`.
  - **Етапи** — a sequential multi-step workflow where each stage must be completed in order. Each stage is `<Accordion title="N. {Дія}">` (no `titleAs`, no numbered list of stage names before the Accordion blocks). Each stage title is an **imperative verb phrase** (`1. Створіть рахунок`), never a bare noun (`1. Рахунок`); read top to bottom, the titles alone must convey the whole flow before the reader expands any stage.
- **`en` (user-guide-template.md) — Variant 1/2/3:**
  - **Variant 1 (single task, single phase)** — one task, no distinct phases.
  - **Variant 2 (single task, multiple phases)** — one task split into ordered configuration phases (e.g., separate Info/Settings/Permissions tabs during creation).
  - **Variant 3 (multiple tasks)** — more than one independent task on the page, each its own H2.

State your choice and the reason before drafting. If the inputs are ambiguous, ask the user before proceeding.

### Step 4 — Compose a facts sheet

Before asking questions, produce a short internal facts sheet organized as:

- **Confirmed facts** — what the inputs clearly state
- **Unclear or contradictory** — where inputs disagree or leave a detail ambiguous
- **Gaps** — actions, UI elements, or outcomes the inputs don't cover

Do not show this sheet to the user unless asked. It is scaffolding for Step 5.

### Step 5 — Interview the user (mandatory)

Ask 3–5 targeted questions in one batch. Rules:

- **Maximum 5 questions.** If more real gaps exist, pick the 5 most blocking and save the rest for a follow-up round after drafting.
- **Each question must cite evidence, then propose an answer.** Cite the source of the uncertainty, state your best-guess resolution from the available evidence, and ask the user to confirm or correct: "The interview mentions clicking a button but doesn't name it — based on app-notes.md the label is 'Submit'; confirm or correct?" Do not ask an open question where the user must make the choice from scratch.
- **No generic questions.** Style, tone, and structure are answered by the template and, for a `uk` page, the cheatsheet. Questions must be about facts or UI details the inputs don't resolve.
- **If the inputs are complete and unambiguous, skip the interview.** Say: "Inputs are complete. Drafting now." Do not invent questions for ritual. Treat a fact answered in `app-notes.md` as resolved — do not ask a question the app already answered.
- **If the user explicitly says "skip questions" or "draft with your best guess," proceed without interview** but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.

Wait for the user's answers before Step 6.

### Step 6 — Draft the page

Apply the template resolved in "Sources to load". Choose the structure decided in Step 3.

**Intro sentence rules (critical):**

- **`uk`:** the `<Accordion title="...">` acts as the heading. If the title already conveys the action, omit the intro entirely. Otherwise write a plain, non-bold intro inside the Accordion, per `formatting-conventions.md`'s Ukrainian sentence-style section (`Щоб {ціль}, виконайте такі дії:` for multi-step, `Щоб {ціль}:` + one bullet for single-step, `Щоб {висока_ціль_процесу}, пройдіть такі етапи:` for an Етапи overview before the Accordion blocks).
- **`en`:** the task/phase heading acts as the same anchor. If it already conveys the action, omit the intro. Otherwise write a plain, non-bold intro per `formatting-conventions.md`'s English sentence-style section ("To {goal}, do the following:").
- **Never bold the intro sentence**, in either language.

**Step writing rules (structural, both languages):**
- **Merge a locate action with the click that acts on it.** When one step only finds/selects an item (a file, a row, a transaction) and the next step clicks a button to act on that same item, combine them into a single numbered step. Do not leave "find X" as its own step when the following step is "click Y" on that same X.
  - ✅ "In the receipts list, find the file and click **Upload**."
  - ⛔ "Find the file in the receipts list." *(as its own step)* / "Click **Upload**." *(as the next step)*
- **Merge an input/selection with the commit click that immediately completes it — when all conditions hold.** When a step supplies input or makes a selection and the very next step commits it (**Save**, **Apply**, **OK**, **Submit**), combine them into one step. This project decision is **compatible with**, not directly mandated by, the routed source guides — cite both when this rule drives a change:
  - Google Developer Style Guide — `${CLAUDE_PLUGIN_ROOT}/context/google-developer-style-guide/procedures/procedures.md`: "one action or one closely coupled action group per step… If pressing Enter is required, include it in the same step" (its own example combines a selection and the following **Save**).
  - Microsoft Writing Style Guide — `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/shared/procedures/step-by-step-instructions.md`: "Combine short actions only when they occur in the same place," and "Include the action that commits or completes the task, such as **Apply** or **OK**."
  - **Merge only when every condition holds:** the actions occur in the same window, form, or panel (one uninterrupted UI context); together they complete one logical user action; the commit immediately follows the input/selection; no meaningful intermediate result, decision, warning, validation state, or explanation intervenes; and the combined step still scans easily.
  - **Keep separate when any of these intervene:** the user moves to another location or phase; validation or review must happen before committing; the commit is destructive or needs a warning; an optional branch intervenes; the first step is already long or has complex substeps; or the commit produces a result that needs its own explanation or screenshot.
  - ✅ (merge) "In the **Change password** window, enter the old and new password and click **Save**."
  - ⛔ (needless split) "In the **Change password** window, enter the old and new password." *(step 3)* / "Click **Save**." *(step 4)*
  - ✅ (keep separate — validation intervenes) "In the **Transfer** window, enter the amount." *(step 3)* / "Review the fee shown below the field, then click **Confirm**." *(step 4, a distinct review state before an irreversible commit)*
- **State the location before the action**, inside a merged or single step alike: "In the **Receipts** window, find the file and click **Upload**." — not "Find the file and click **Upload** in the **Receipts** window."
- **Confirmation clicks: action first, reason last.** When a step's whole job is confirming a prior action in a dialog (e.g., a "Delete file" confirmation), state the click first and the reason afterward: "In the **Delete file** window, click **Delete** to confirm." — not "To confirm the deletion, in the **Delete file** window, click **Delete**."
  - This is narrower than the goal → action rule below: goal → action applies when the "to" clause states the operation's actual goal (e.g., applying a filter). Use action-first-reason-last only for a secondary confirmation of something already stated in a previous step.
- Beyond locate+click, input+commit, and confirm+reason, keep one independent action per step — don't merge two unrelated clicks.
- UI labels in **bold**: click **Save**, select **Transactions**.
- **Icon-only buttons — decision tree:**
  1. Button has a text label → bold text only.
  2. No text label + Iconify icon name is known → `<Icon icon="..." height="24" style={{ color: '#9564ff' }} />` before the bold action name: `<Icon icon="ic:sharp-edit" height="24" style={{ color: '#9564ff' }} /> **Редагувати**`.
  3. No text label + icon name unknown → descriptive text: «натисніть кнопку із зображенням олівця» / «натисніть кнопку видалення».
- Imperative mood, present tense for system reactions — see `formatting-conventions.md`'s sentence-style section for the resolved language.
- No "you should" or "you need to" — just the imperative.
- **Filter panel steps:** when the procedure involves selecting filters, do not enumerate each filter as a separate step. Use a single general step with an inline link to the reference section: "In the filter panel, select the [filters](#reference-information-<slug>) you need." Do not add a separate sentence pointing the reader at the reference section.
- **Reference-information anchors:** the Reference information heading must carry an explicit ID so inline links resolve deterministically. Give it `{#reference-information-<slug>}` (uk: `{#довідкова-інформація-<slug>}`), where `<slug>` is the page's kebab-case slug (the same slug used for the output filename). On a page with multiple Reference information sections, give each its own id using that task's slug (`#reference-information-<task-slug>`) and link each inline where its fields are first mentioned. Every inline reference-information link must match the target heading's explicit id exactly — never a bare `#reference-information`.

**Screenshot rules:**
- Only embed screenshots from `.assets/` (root). Never embed from `.assets/ref/` — those exist for your context only.
- Place a screenshot after the step it illustrates, not before.
- Alt text must describe what is shown, not repeat the step.
- Choose the embed syntax based on the classification from Step 2:
  - **Full-page**: `![Descriptive alt text](./.assets/image.png)`
  - **Compact** (dialog, modal, narrow panel): `<img src={require('./.assets/image.png').default} width="{compact-width}" alt="Descriptive alt text" />` — `{compact-width}` is the resolved `Compact image width:` (default `480`); see `screenshot-selection.md`.
- **Blank line rules — follow exactly to avoid unwanted spacing in the UI:**
  - **No blank line** between a step and the screenshot that immediately follows it.
  - **No blank line** between a screenshot and the next step that follows it.
  - **No blank line** between a **Result** paragraph and a screenshot that follows it.
  - **One blank line** between a screenshot and a **Result** paragraph that follows it (screenshot precedes Result).
- When a screenshot belongs to a numbered step, place it on the next line with 3-space indent (no blank line before it). For `<img>` JSX this keeps it visually inside the step:
  ```
  3. Click **Upload**.
     <img src={require('./path.png').default} width="480" alt="..." />

  **Result:** ...
  ```
  Markdown images use 2-space indent — same rule, no blank line before the image:
  ```
  2. Click the <Icon icon="..." /> icon.
    ![alt](./.assets/image.png)
  3. Continue to the next step.
  ```
- If no embeddable screenshot exists for a step, add `{/* ToDo: add a screenshot — {what it should show} */}` at the correct position.

**Result block rules (structural, both languages):**
- Every procedure must end with a result statement — `**Результат:** {опис}` on a `uk` page, `**Result:** {description}` on an `en` page.
- Write the result as a plain paragraph. Do not wrap it in any admonition — never use `:::tip[success]` for results.
- If the outcome is confirmed asynchronously (webhook received, email sent, status updates after a delay), follow the result paragraph with a `:::info` admonition describing the follow-up confirmation step.
- Never omit the result block. A procedure without a result leaves the partner uncertain about success.

**Additional rules:**
- **Never invent facts.** Unconfirmed UI labels, field names, or behavior → `{/* NEEDS CONFIRMATION: ... */}`.
- **Apply the glossary** resolved in "Sources to load".
- **UCP naming, UI-label/status/placeholder rendering:** follow `formatting-conventions.md`'s Core section (Ж1–Ж7) and the Names/brands entry for the resolved language — do not restate them here.
- **Prerequisites content:** the Prerequisites section must always be present. If no special prerequisites exist beyond reviewing reference information, use the template's own standard reference-information sentence (Variant A/B in the `en` template; Варіант А/Б from the Prerequisites section of `ua-user-guide-template.md`) rather than inventing new wording.
- **Field reference order:** when a step involves a field inside a card or other named container, state the container first, then the field, then the action: "In the **X** card, in the **Y** field, enter the value." — not "In the **Y** field in the **X** card, enter the value."
- **Active voice, second person — not the product as subject:** in procedural steps and Result blocks, always use the imperative or the second person; never a system/product noun ("the Partner", "Партнер") as the grammatical subject. See `formatting-conventions.md`'s sentence-style section for the resolved language.
- **No concept explanations in procedure steps.** If background context is needed, link to a concept topic instead.
- **Internal links to other doc pages follow the shared contract.** Build every page-to-page link exactly as `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md` prescribes — site-root-relative, the declared UA URL prefix joined to the target's path relative to the content root, no `.md`/`.mdx`, anchors preserved (e.g. `#reference-information-add-cards`). That file is authoritative for what is and isn't a page link (asset links `./.assets/…` and intra-page anchors `#…` are exempt); do not restate its algorithm here.
- **No "you're signed in to the partner cabinet" as a prerequisite.** That is always assumed.
- **Do not name the partner-cabinet context explicitly in page body text.** The reader is already in it. `uk`: avoid «кабінет партнера», use «меню» — wrong: «в розділі X у кабінеті партнера», right: «в меню X». `en`: avoid explicit "in the partner cabinet"; use "the menu" or the feature's own name instead.
- **Voice:** the UI element must not be the subject of an action. The action happens to/in the object. ✅ "Transactions appear in the table." ⛔ "The table displays transactions." Applies to Result blocks too.
- **Structure-specific containers:**
  - `uk`, single operation: no Accordion, no `## Операції з {назва}`. Use `## {Назва операції}` with steps directly.
  - `uk`, multiple operations: `<Accordion titleAs="h3" title="{Назва}">` per operation, under `## Операції з {назва}`.
  - `uk`, Етапи: `<Accordion title="N. {Дія}">` per stage (no `titleAs`), immediately after the intro sentence. No numbered list of stage names before the Accordion blocks. Each stage title is an **imperative verb phrase** describing what the reader does at that stage (`1. Створіть рахунок`, `2. Вкажіть банківську інформацію`, `7. Задайте суму`), never a bare noun (`1. Рахунок`, `2. Банк інфо`, `7. Сума`). Titles are the flow map: reading titles 1→N in order, without expanding any Accordion, must make the overall process clear. Reference to the next stage in the result block: «Перейдіть до **2. {Назва}**.»
  - `en`: follow the template's own Variant 1/2/3 heading-level rules — no Accordion component is used; each task or phase is its own heading at the level the template specifies.
- **Attribute column text:** text in a reference table's attribute-description column (**Атрибути** / **Attribute**) must not be bold.
- **Reference table placement:** never embed an Атрибут/Опис reference table inside a numbered step, inside an Accordion stage body, or anywhere in the procedure flow. If a step involves a form or table with many fields, write the action normally and add an inline link to the Довідкова інформація section (e.g., «заповніть [поля](#довідкова-інформація-{slug})»). The table always belongs in the dedicated section.
- **Reference information completeness:** the Довідкова інформація table must cover every field, column, and control *visible* on each screen or form the user encounters — not only the elements directly acted upon in steps. Read-only fields, status columns, display-only labels, and informational rows all belong in the table. An interactive control already fully described in a step (e.g., a button whose sole purpose is clear from "click **Save**") does not need a separate row.
- **Enum / multi-value cells:** when an attribute accepts a defined set of values (status codes, enum options, dropdown choices, etc.), list them in the description cell using HTML `<ul><li>` tags — not as comma-separated prose. Use the format `Можливі значення:<ul><li>\`VALUE\`: опис;</li><li>\`VALUE\`: опис.</li></ul>` The last `<li>` ends with a full stop; all others end with a semicolon.
- **Colon over dash in bullet lists:** when labelling items, prefer `:` over `—`. Bolding rule: if the label is a UI element name, do not bold the colon (`**UI element**: description`); if the label is plain text, bold both label and colon (`**Label:** description`).
- **Follow the style-guide topical files loaded above** for anything not covered by the project-specific rules in this list (formatting, punctuation, accessibility, etc.) — check the corpus rather than guessing.
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}`.

### Step 7 — Self-review before saving

Before writing to disk, check:

- Every canonical term in prose matches the resolved-language glossary
- Intro sentences that remain follow the resolved language's phrasing rule in `formatting-conventions.md`; intro is omitted where the heading/Accordion title already conveys the action
- Every procedure ends with a plain result statement (**Результат:** / **Result:**) — no `:::tip[success]` admonition
- Bullet list items use `:` not `—`; colon is not bold when adjacent to a UI element name
- The partner-cabinet context is not named explicitly in body text
- Attribute column values in reference tables are not bold
- Filter selection steps use a general phrase, not per-filter enumeration
- No "find/select X" step immediately followed by a "click Y" step on that same X — merged into one step with the location stated first
- No input/selection step immediately followed by a bare commit step (**Save**/**Apply**/**OK**/**Submit**) when all merge conditions hold — merged into one step. Conversely, no commit wrongly merged in when validation, a warning, a branch, or a result-needing-its-own-explanation intervenes
- Confirmation steps (e.g., a delete confirmation dialog) state the click first and the reason last
- Screenshots are placed after, not before, the step they illustrate; absent screenshots have `{/* ToDo */}` placeholders
- No description of current UI behavior uses future tense (`formatting-conventions.md`, sentence-style section for the resolved language)
- On a `uk` page: no calques from `formatting-conventions.md`'s "Кальки й слова-заборони" (не «являється», «даний», «в залежності від», «нажміть»)
- No concept explanations embedded in procedure steps
- Every unconfirmed fact has `{/* NEEDS CONFIRMATION: ... */}`
- "You're signed in to the partner cabinet" does not appear in Prerequisites
- Prerequisites section is present and handled per the resolved language: `en` page — if no special prerequisites exist, Variant A or Variant B standard sentence from `user-guide-template.md` is used (not invented wording); `uk` page — if no special prerequisites exist, Варіант А or Варіант Б from `ua-user-guide-template.md` Prerequisites section is used
- No product/system noun used as the grammatical subject in steps or Result blocks (active voice, second person instead)
- UI labels, status values, placeholders, and code-vs-concept rendering follow `formatting-conventions.md` Ж1–Ж4
- No UI element is the subject of an action in steps or Result blocks
- References to the reference-information section in steps are inline links, not separate sentences — and each link's anchor matches the target heading's explicit `{#reference-information-<slug>}` id (never a bare `#reference-information`)
- Every link to another doc page follows `internal-links.md` (declared UA URL prefix + path, no `.md`); no `./`/`../` page links, no hardcoded `/docs/` (asset links `./.assets/…` and intra-page anchors `#…` are exempt)
- No Атрибут/Опис reference table appears inside a numbered step or Accordion stage body
- The Довідкова інформація table covers every visible field on each screen/form/table the user encounters, not only directly-interacted elements; read-only and display-only fields are included
- Every attribute with a defined set of values uses `<ul><li>` in its description cell, not comma-separated prose
- `uk`, single-operation pages: no `## Операції з {назва}` wrapper and no Accordion
- `uk`, Етапи: Accordion title is `"N. {Назва}"` (no `titleAs`, no "Етап" prefix); no numbered list before the Accordion blocks; every stage title is an imperative verb phrase (`1. Створіть рахунок`), not a bare noun (`1. Рахунок`), and reading titles 1→N conveys the whole flow without expanding any stage
- `en`: heading levels match the resolved Variant's own rules (single task, phases, or multiple tasks)
- The draft conforms to every rule in the style-guide topical files loaded per "Sources to load" (resolved via `style-guide-registry.md`) — check against those files directly, don't rely on memory of past drafts
- **P1 — Inherited wording normalized.** For every heading and every bolded fragment, confirm it is not lifted from `.sources/` without normalization. The interview/notes are a source of *facts*, not of *wording*.
- **P2 — Heading language (Ж7).** Every heading is in the resolved content language; a code entity inside one stays in `code font` but the surrounding words don't switch language.
- **P3 — Bold only on visible UI labels (Ж1).** For every `**...**` span, confirm it is a UI element's visible label, not emphasis on a fact, a term, or a module name.
- **P4 — Document as-is (Ж6).** No plans, upcoming changes, or "the team intends to..." in page body text (including inside admonitions) — only inside `{/* ToDo: ... */}`.
- **P5 — One render per entity (Ж3).** List the document's technical entities and confirm each is written exactly one way everywhere in the page.

### Step 8 — Reviewer pass

After the self-review passes, do a focused second read that targets the project-specific rules:

1. Page intro — if it names the partner-cabinet context explicitly, rewrite to use «меню» / "the menu" or omit.
2. Each section heading — if the heading matches the immediately following intro sentence, delete the intro sentence.
3. Each remaining intro sentence — strip bold formatting if present.
4. Each result block — if wrapped in `:::tip[success]`, unwrap to a plain result paragraph.
5. Each bullet list — replace `—` with `:`; adjust colon bolding per the UI-element rule.
6. Reference table attribute-description column — remove bold from all cell values.
7. Filter-related steps — replace per-filter enumeration with a single general step using an inline link.
8. UI labels and status values — reconcile against `formatting-conventions.md` Ж1/Ж4.
9. Steps and Result blocks — if a UI element is the grammatical subject, rewrite so the action happens to the object instead.
10. `uk`, Етапи — if there is a numbered list of stage names before Accordion blocks, remove it. Ensure Accordion title format is `"N. {Назва}"` with no `titleAs` attribute. For each stage title, if it is a bare noun (`1. Рахунок`, `2. Банк інфо`), rewrite it as an imperative verb phrase describing the action (`1. Створіть рахунок`, `2. Вкажіть банківську інформацію`). Then read the titles 1→N in order: if the overall flow isn't clear from titles alone, sharpen the verbs until it is.
11. Steps and Result blocks — if a product/system noun appears as the grammatical subject, rewrite as imperative or second person.
12. Prerequisites section — if no special prerequisites are listed: `en` page — add Variant A or Variant B standard sentence from the template; `uk` page — add Варіант А or Варіант Б from `ua-user-guide-template.md`.
13. Adjacent steps — if one step only locates/selects an item and the next step clicks a button on that same item, merge them into one step with the location stated first.
14. Adjacent steps — if one step supplies input or a selection and the next is a bare commit click (**Save**/**Apply**/**OK**/**Submit**) with no intervening validation, warning, branch, or result needing its own explanation, and both sit in the same UI context, merge them into one step (cite the GDSG/MSSG procedure rules named in Step 6). Do **not** merge when any keep-separate condition holds — flag a wrongly-merged commit and split it back out.
15. Confirmation-dialog steps — if a step opens with "To confirm..., ...", rewrite so the click comes first and the reason comes last.
16. **P1 — Inherited wording.** Diff every heading and bolded phrase against `.sources/`; rewrite any that were copied without normalization.
17. **P2 — Heading language.** Flag and rewrite any heading that mixes languages or leaves a glossary concept in its source language.
18. **P3 — Bold audit.** Re-walk every `**...**` span; strip bold from anything that isn't a visible UI label.
19. **P4 — As-is audit.** Search the body (including admonitions) for future/planned-change language; move it to `{/* ToDo: ... */}`.
20. **P5 — Render audit.** Build the entity list; fix every entity with more than one rendering in the document.
21. **Reference tables and completeness.** If an Атрибут/Опис table appears inside a step or Accordion stage body, move it to the Довідкова інформація section and replace the step content with the appropriate action plus an inline link. Verify the table covers all visible fields on every screen/form/table the user encounters — add any missing read-only, status, or display-only fields. Convert any comma-separated list of enum values to `<ul><li>` format with semicolons after each entry except the last (which ends with a full stop).
22. **Native-Ukrainian reread (`uk` pages only).** A distinct pass done *after* the meaning and structure are settled: reread the finished prose for naturalness against `native-ukrainian.md`, not for facts. Walk its §5 checklist — literal English word order, unnecessary nominalizations, anthropomorphic UI agency («Список показує…») vs. natural causality, «діалог» → «вікно»/«модальне вікно», self-reference «цей посібник»/«цей гайд» → «ця сторінка»/«цей документ», «проведе вас через» → direct purpose, and discretionary/double dashes (prefer splitting the sentence; preserve required dashes). Do not touch literal UI labels, code, selectors, links, or Markdown. Rewrite each unnatural sentence; leave negative-control cases (§4b) alone.

Fix every issue found before saving.

### Step 9 — Save

Save to `<content root>/<target-folder>/<slug>.md`, where the target folder was confirmed in Step 1 and the `<slug>` and page title follow `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md` (canonical English title → kebab-case slug; folder and basename share the slug; UA/EN titles are semantic equivalents; imperative-verb-phrase title for a user guide). If this page already exists with a mismatched filename/title, do not silently rename it — report the mismatch per that file's "Existing pages" rule.

Do not update the sidebar config file (`sidebars.ts`, or a project's custom-id equivalent) — it's auto-generated.

Do not create a translation of this page — that is a separate step using the `doc-translator` skill after human approval, on a project that translates rather than dual-authors.

After saving, report:
- The file path written
- The resolved content language and its source (project declaration vs. asked)
- Structure chosen (Операції/Етапи, or Variant 1/2/3) and why
- Which screenshot case from Step 2 applied, and how many images were selected out of how many available frames (if the index-driven procedure ran)
- A list of unresolved `{/* NEEDS CONFIRMATION: ... */}` items, if any
- A list of unresolved `{/* ToDo: ... */}` items (especially missing screenshots)
- Any follow-up questions deferred from Step 5

## When inputs are insufficient

If after the interview the inputs still leave the steps of any procedure unfilled (actions, UI labels, or outcome unknown), do not draft. Report the specific gaps and ask whether to proceed with heavy `{/* NEEDS CONFIRMATION */}` flagging or to pause and gather more input.

## Explicit invocation examples

This skill triggers only when the user names it explicitly. Examples of valid invocations:

- "Use user-guide-writer to write the Filter transactions page"
- "user-guide-writer: write Manage receipts"
- "Invoke user-guide-writer for partner-cabinet/transactions/manage-transactions/cancel-transaction/"

If the user asks for a user guide or procedural documentation without naming this skill, suggest invoking it but wait for explicit permission.
