---
name: user-guide-writer
description: Writes UA-first user guide pages (procedural docs) for the UniComPay partner cabinet following the authoring rules in CLAUDE.md. Use explicitly ("use user-guide-writer to document...", "user-guide-writer: write the Filter transactions page"). Follows ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-user-guide-template.md with Операції/Етапи structure, with a mandatory interview phase before drafting. Not for concept topics or API reference pages.
---

# user-guide-writer

You are writing a Ukrainian user guide page for the UniComPay partner cabinet. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing a procedural user guide end-to-end.

## Scope

- **In scope:** task-based procedural pages that walk a partner through a specific action in the partner cabinet. One topic per page, written in Ukrainian. Covers both single-procedure pages (Операції structure) and multi-procedure overview pages (Етапи structure).
- **Out of scope:** concept topics explaining how something works (`concept-doc-writer`'s job), API reference pages (`api-doc-writer`'s job), EN translations (`doc-translator`'s job), sidebar config changes.

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

**Templates:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-user-guide-template.md` — authoritative structure and Design rules. Read the Design rules section before drafting. When the template and examples disagree, the template wins.

**Project rules:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md` — canonical UA terminology.

**UA grammar:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/00-cheatsheet.md` — always-loaded quick reference: UCPay terminology, formatting, and the most common UA errors.

**Examples — voice and tone reference only:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/user-guide-examples/user-guide-example-create-branches.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/user-guide-examples/user-guide-example-edit-links.md`

These examples illustrate prose density, step phrasing, screenshot placement, admonition use, and result block formatting. They do **not** define the target structure. For sections, headings, and required content, follow the template. When an example and the template disagree, the template wins.

## Workflow

Execute the steps in order. Do not skip the interview.

### Step 1 — Locate inputs

Resolve this project's UA content root via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` (do not assume `partner-cabinet/`). Ask the user for the target doc folder under that root if not provided (e.g., `<UA content root>/transactions/manage-transactions/filter-transactions/`). Sources live inside that folder.

List the files present. Expected contents:
- `.sources/sme-interview.md` — primary source; SME brief or interview transcript. If absent, notify the user and request an alternative.
- `.sources/notes.md` — writer's own notes; treat as authoritative.
- `.assets/*.png` — screenshots to embed in the doc.
- `.assets/ref/*.png` — reference-only screenshots (read for context; never embed in the doc). This folder is optional. If it does not exist or is empty, treat all files in `.assets/` as both context and embeddable.

Also check existing approved pages under the UA content root for contextual consistency — only after exhausting the source files. Do not copy structure or prose from them.

If the sources folder does not exist or is empty, ask the user where the inputs are before proceeding.

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
- Whether this page has one procedure or multiple that together form a workflow (Операції vs Етапи)

Also view every screenshot in `.assets/` and for each file:

1. **Rename** — if the filename is non-descriptive (e.g., `image.png`, `image copy.png`, a random string, or a numeric timestamp), rename it following the pattern `{subject}-{ui-element-type}.png` in kebab-case:

   | UI element type | Suffix | Example |
   |---|---|---|
   | Full-page menu or table | `-page` or `-page-{tab}` | `transactions-page-payout-tab.png` |
   | Dialog / modal window | `-dialog` | `transaction-receipts-dialog.png` |
   | Side panel / filter panel | `-pane` | `filters-pane.png` |
   | Standalone form | `-form` | `add-receipt-form.png` |
   | Confirmation banner / toast | `-banner` | `receipt-uploaded-banner.png` |

   Use the Bash tool: `mv "./.assets/old-name.png" "./.assets/new-name.png"`. Rename before drafting so all embed references use the final filename.
2. **Classify** as **full-page** or **compact**:
   - **Full-page** — whole menu, dashboard, or table spanning the full content area.
   - **Compact** — dialog window, modal, or narrow panel that visually occupies significantly less than the full content width.

Note the final filename and classification per file; both are used in Step 6.

### Step 3 — Choose the structure

Based on the analysis, decide before drafting:

- **Операції** — use when the page covers one or more discrete, independent procedures (actions the partner can do individually).
  - **Single operation:** no `## Операції з {назва}` wrapper and no `<Accordion>`. Use `## {Назва операції}` with steps directly.
  - **Multiple operations:** wrap each in `<Accordion titleAs="h3" title="{Назва}">` under `## Операції з {назва}`.
- **Етапи** — use when the page covers a sequential multi-step workflow where each stage must be completed in order. Each stage is `<Accordion title="N. {Назва}">` (no `titleAs`, no numbered list before the Accordion blocks).

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
- **Each question must cite evidence.** Reference the source of the uncertainty: "The interview mentions clicking a button but doesn't name it. What is the exact label?"
- **No generic questions.** Style, tone, and structure are answered by the template and cheatsheet. Questions must be about facts or UI details the inputs don't resolve.
- **If the inputs are complete and unambiguous, skip the interview.** Say: "Inputs are complete. Drafting now." Do not invent questions for ritual.
- **If the user explicitly says "skip questions" or "draft with your best guess," proceed without interview** but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.

Wait for the user's answers before Step 6.

### Step 6 — Draft the page

Apply `ua-user-guide-template.md`. Choose Операції or Етапи structure as decided in Step 3.

**Intro sentence rules (critical):**

- **The `<Accordion title="...">` acts as the heading.** If the title already conveys the action (e.g., «Додати квитанцію»), **omit the intro entirely** and start directly with the step list or bullet.
- **If an intro is needed** (the title alone doesn't provide enough context): write it as plain, non-bold text inside the Accordion:
  - Multi-step: `Щоб {ціль}, виконайте такі дії:`
  - Single-step: `Щоб {ціль}:` + one bullet
  - Етапи overview (before the Accordion blocks, not inside): `Щоб {висока_ціль_процесу}, пройдіть такі етапи:`
  **Never bold the intro sentence.** Wrong: `**Щоб {ціль}, виконайте такі дії:**`

**Step writing rules:**
- **Merge a locate action with the click that acts on it.** When one step only finds/selects an item (a file, a row, a transaction) and the next step clicks a button to act on that same item, combine them into a single numbered step. Do not leave "find X" as its own step when the following step is "click Y" on that same X.
  - ✅ «У списку квитанцій знайдіть потрібний файл і натисніть **Завантажити**.»
  - ⛔ «Знайдіть потрібний файл у списку квитанцій.» *(as step 3)* / «Натисніть **Завантажити**.» *(as step 4)*
- **State the location before the action**, inside a merged or single step alike: «У вікні **Квитанції** знайдіть потрібний файл і натисніть **Завантажити**.» — not «Знайдіть потрібний файл і натисніть **Завантажити** у вікні **Квитанції**.»
- **Confirmation clicks: action first, reason last.** When a step's whole job is confirming a prior action in a dialog (e.g., a "Delete file" confirmation), state the click first and the reason afterward: «У вікні **Видалення файлу** натисніть **Видалити**, щоб підтвердити дію.» — not «Щоб підтвердити видалення, у вікні **Видалення файлу** натисніть **Видалити**.»
  - This is narrower than the мета → дія rule below: мета → дія applies when the "щоб" clause states the operation's actual goal (e.g., applying a filter). Use action-first-reason-last only for a secondary confirmation of something already stated in a previous step.
- Beyond locate+click and confirm+reason, keep one independent action per step — don't merge two unrelated clicks.
- UI labels in **bold**: натисніть **Зберегти**, виберіть **Транзакції**.
- Present tense, imperative mood, 2nd person plural: **натисніть**, **виберіть**, **введіть**, **перевірте**.
- No "you should" or "you need to" — just the imperative.
- **Filter panel steps:** when the procedure involves selecting filters, do not enumerate each filter as a separate step. Use a single general step with an inline link to the reference section: «У панелі фільтрів виберіть потрібні [фільтри](#довідкова-інформація).» Do not add a separate sentence like «Детальніше про кожен фільтр — у розділі **Довідкова інформація**.»

**Screenshot rules:**
- Only embed screenshots from `.assets/` (root). Never embed from `.assets/ref/` — those exist for your context only.
- Place a screenshot after the step it illustrates, not before.
- Alt text must describe what is shown, not repeat the step.
- Choose the embed syntax based on the classification from Step 2:
  - **Full-page**: `![Описовий alt-текст](./assets/image.png)`
  - **Compact** (dialog, modal, narrow panel): `<img src={require('./assets/image.png').default} width="480" alt="Описовий alt-текст" />`
- **Blank line rules — follow exactly to avoid unwanted spacing in the UI:**
  - **No blank line** between a step and the screenshot that immediately follows it.
  - **No blank line** between a screenshot and the next step that follows it.
  - **No blank line** between `**Результат:**` and a screenshot that follows it.
  - **One blank line** between a screenshot and a `**Результат:**` that follows it (screenshot precedes Результат).
- When a screenshot belongs to a numbered step, place it on the next line with 3-space indent (no blank line before it). For `<img>` JSX this keeps it visually inside the step:
  ```
  3. Натисніть **Завантажити**.
     <img src={require('./path.png').default} width="480" alt="..." />

  **Результат:** ...
  ```
  Markdown images use 2-space indent — same rule, no blank line before the image:
  ```
  2. Натисніть іконку <Icon icon="..." />.
    ![alt](./.assets/image.png)
  3. Наступний крок.
  ```
- If no embeddable screenshot exists for a step, add `{/* ToDo: додати скріншот — {що саме показати} */}` at the correct position.

**Result block rules:**
- Every procedure must end with a **Результат** block.
- Write the result as a plain paragraph: `**Результат:** {description}`. Do not wrap it in any admonition — never use `:::tip[success]` for results.
- If the outcome is confirmed asynchronously (webhook received, email sent, status updates after a delay), follow the **Результат** paragraph with a `:::info` admonition describing the follow-up confirmation step.
- Never omit the result block. A procedure without a result leaves the partner uncertain about success.

**Additional rules:**
- **Never invent facts.** Unconfirmed UI labels, field names, or behavior → `{/* NEEDS CONFIRMATION: ... */}`.
- **Apply the glossary.** Canonical UA terms: Партнер, Транзакція, Вхідна транзакція, Вихідна транзакція, Вебхук, API-токен, Кабінет партнера, Віджет, etc.
- **UCP naming:** write the system name as **UCP** only. Never UCPay, UniComPay, or any variant.
- **Prerequisites content:** `## Передумови` must always be present. If no special prerequisites exist beyond reviewing reference information, use the standard sentence: `Перш ніж розпочати обов'язково перегляньте [довідкову інформацію](#довідкова-інформація), або шукайте необхідну інформацію під час виконання операції.`
- **Field reference order:** when a step involves a field inside a card or other named container, state the container first, then the field, then the action: `У картці **X**, у полі **Y**, введіть значення.` — not `У полі **Y** у картці **X** введіть значення.`
- **"ви" not "Партнер" as subject:** in procedural steps and Результат blocks, always use the imperative or «ви» — never «Партнер» as the grammatical subject. Wrong: «Партнер вибирає тип.» Right: «Виберіть тип.»
- **No concept explanations in procedure steps.** If background context is needed, link to a concept topic instead.
- **No "Ви увійшли в кабінет партнера" as a prerequisite.** That is always assumed.
- **Do not mention «кабінет партнера» in page body text.** Since all partner-cabinet docs exist within that context, the reader already knows. Use «меню» for navigation references. Wrong: «в розділі X у кабінеті партнера». Right: «в меню X».
- **Status values:** distinguish by context — UI status labels shown in the interface (e.g., Завершений, Відмінений, Помилка) always **bold**: **Завершений**. API/system status values not visible as-is in the UI (`new`, `in queue`, `in work`, `success`, `cancelled`) always in `code font`.
- **Voice:** the UI element must not be the subject of an action. The action happens to/in the object. ✅ «транзакції відображаються у таблиці». ⛔ «Таблиця відображає транзакції». Apply to **Результат** blocks too.
- **Accordion usage:**
  - Single operation (ВАРІАНТ А): no Accordion, no `## Операції з {назва}`. Use `## {Назва операції}` with steps directly.
  - Multiple operations (ВАРІАНТ А): `<Accordion titleAs="h3" title="{Назва}">` per operation, under `## Операції з {назва}`.
  - Stages (ВАРІАНТ Б): `<Accordion title="N. {Назва}">` per stage (no `titleAs`), immediately after the intro sentence. No numbered list of stage names before the Accordion blocks. Reference to the next stage in the result block: «Перейдіть до **2. {Назва}**.»
- **Attribute column text:** text in the **Атрибути** column of reference tables must not be bold.
- **Colon over dash in bullet lists:** when labelling items, prefer `:` over `—`. Bolding rule: if the label is a UI element name, do not bold the colon (`**UI елемент**: опис`); if the label is plain text, bold both label and colon (`**Назва:** опис`).
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}`.

### Step 7 — Self-review before saving

Before writing to disk, check:

- Every UA canonical term in prose matches `glossary-ua.md`
- Intro sentences that remain are plain (non-bold) text ending in `виконайте такі дії:`; intro is omitted where the heading already conveys the action
- Every procedure ends with a plain `**Результат:**` paragraph — no `:::tip[success]` admonition
- Bullet list items use `:` not `—`; colon is not bold when adjacent to a UI element name
- «кабінет партнера» does not appear in body text
- Attribute column values in reference tables are not bold
- Filter selection steps use a general phrase, not per-filter enumeration
- No "find/select X" step immediately followed by a "click Y" step on that same X — merged into one step with the location stated first
- Confirmation steps (e.g., a delete confirmation dialog) state the click first and the reason last, not "Щоб підтвердити..., ..." at the start
- Screenshots are placed after, not before, the step they illustrate; absent screenshots have `{/* ToDo */}` placeholders
- No майбутній час (`буде`, `матиме`) in descriptions of current UI behaviour
- No Russian calques (не «являється», «даний», «в залежності від», «нажміть»)
- No concept explanations embedded in procedure steps
- Every unconfirmed fact has `{/* NEEDS CONFIRMATION: ... */}`
- "Ви увійшли в кабінет партнера" does not appear in Передумови
- `## Передумови` is present; if no special prerequisites exist, the standard sentence is used
- No «Партнер» used as the grammatical subject in steps or Результат blocks (use imperative or «ви»)
- UI status labels (Завершений, Відмінений, Помилка) are **bold**; system API values (`success`, `cancelled`) are in `code font`
- No UI element is the subject of an action in steps or Результат blocks
- References to Довідкова інформація in steps are inline links, not separate sentences
- Single-operation pages: no `## Операції з {назва}` wrapper and no Accordion
- Stages (Етапи): Accordion title is `"N. {Назва}"` (no `titleAs`, no "Етап" prefix); no numbered list before the Accordion blocks

### Step 8 — Reviewer pass

After the self-review passes, do a focused second read that targets the project-specific rules:

1. Page intro — if it mentions «кабінет партнера», rewrite to use «меню» or omit.
2. Each section heading — if the heading matches the immediately following intro sentence, delete the intro sentence.
3. Each remaining intro sentence — strip bold formatting if present.
4. Each result block — if wrapped in `:::tip[success]`, unwrap to a plain `**Результат:**` paragraph.
5. Each bullet list — replace `—` with `:`; adjust colon bolding per the UI-element rule.
6. Reference table **Атрибути** column — remove bold from all cell values.
7. Filter-related steps — replace per-filter enumeration with a single general step using an inline link: `[фільтри](#довідкова-інформація)`.
8. UI status labels (Завершений, Відмінений, Помилка) — change from `code font` to **bold** if used incorrectly.
9. Steps and Результат blocks — if a UI element (Таблиця, Форма, Меню) is the grammatical subject, rewrite so the action happens to the object instead.
10. Stages (Етапи) — if there is a numbered list of stage names before Accordion blocks, remove it. Ensure Accordion title format is `"N. {Назва}"` with no `titleAs` attribute.
11. Steps and Результат blocks — if «Партнер» appears as the grammatical subject, rewrite as imperative or «ви».
12. Prerequisites section — if the standard sentence is missing and no special prerequisites are listed, add it.
13. Adjacent steps — if one step only locates/selects an item and the next step clicks a button on that same item, merge them into one step with the location stated first.
14. Confirmation-dialog steps — if a step opens with «Щоб підтвердити..., ...», rewrite so the click comes first and the reason ("щоб підтвердити дію") comes last.

Fix every issue found before saving.

### Step 9 — Save

Save to `<UA content root>/<target-folder>/<slug>.md`, where the target folder was confirmed in Step 1.

Do not update the sidebar config file (`sidebars.ts`, or a project's custom-id equivalent) — it's auto-generated.

Do not create the EN translation — that is a separate step using the `doc-translator` skill after human approval.

After saving, report:
- The file path written
- Structure chosen (Операції or Етапи) and why
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
