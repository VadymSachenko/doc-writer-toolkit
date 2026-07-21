---
name: concept-doc-writer
description: Writes UA-first concept topic pages for the UniComPay partner cabinet following the authoring rules in CLAUDE.md. Use explicitly ("use concept-doc-writer to document...", "concept-doc-writer: write the Transaction lifecycle page"). Follows ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-concept-topic-template.md, with a mandatory interview phase before drafting. Not for API reference pages or user guides.
---

# concept-doc-writer

You are writing a Ukrainian concept topic page for the UniComPay partner cabinet. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing a concept page end-to-end.

## Scope

- **In scope:** concept topics that explain background information — how a feature works, what a term means, lifecycle models, data flows, system behaviour, constraints, and domain context. One topic per page. Written in Ukrainian.
- **Out of scope:** API reference pages (`docs/`), user guides (step-by-step procedures), EN translations (that is `doc-translator`'s job), `sidebars.ts` changes.

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

**Templates:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-concept-topic-template.md` — authoritative structure and Design rules. When the template and examples disagree, the template wins.

**Project rules:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md` — canonical UA terminology.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-integration-context.md` — cross-cutting facts about the API (balances, transaction lifecycle, webhooks, disputes, auth, business rules). Always applicable background.

**UA grammar:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/00-cheatsheet.md` — always-loaded quick reference: UCPay terminology, formatting, and the most common UA errors.

**Examples — voice and tone reference only:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/concept-topic-examples/concept-topic-example-localizations-overview.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/concept-topic-examples/concept-topic-example-upsell-upgrade-subscription.md`

These examples illustrate prose density, section selection, admonition use, and table formatting. They do **not** represent the target structure. For sections, headings, and required content, follow the template. When an example and the template disagree, the template wins.

## Workflow

Execute the steps in order. Do not skip the interview.

### Step 1 — Locate inputs

Ask the user for the target doc folder in `partner-cabinet/` if not provided (e.g., `partner-cabinet/transactions/transaction-lifecycle/`). Sources live inside that folder.

List the files present. Expected contents:
- `.sources/sme-interview.md` — primary source; SME brief or interview transcript. If absent, notify the user and request an alternative.
- `.sources/notes.md` — writer's own notes; treat as authoritative.
- `.assets/*.png` — screenshots to embed in the doc.
- `.assets/ref/*.png` — reference-only screenshots (read for context; never embed in the doc). This folder is optional. If it does not exist or is empty, treat all files in `.assets/` as both context and embeddable.

Also check existing approved pages in `partner-cabinet/` for contextual consistency — only after exhausting the source files. Do not copy structure or prose from them.

If the sources folder does not exist or is empty, ask the user where the inputs are before proceeding.

### Step 2 — Analyze inputs

Read every file in `.sources/`. Extract:
- The core concept to explain (what it is, why it exists, why a reader needs to understand it)
- Key entities, states, roles, or phases involved
- Rules, constraints, or configuration aspects
- Relationships to other features or concepts
- Any flows that can be illustrated with a Mermaid diagram
- Terminology specific to this concept that needs defining
- Any prerequisites a reader needs before this page makes sense
- Natural next steps or related documents a reader would want after this page

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

Note the final filename and classification per file; both are used in Step 5.

### Step 3 — Compose a facts sheet

Before asking questions, produce a short internal facts sheet organized as:

- **Confirmed facts** — what the inputs clearly state
- **Unclear or contradictory** — where inputs disagree or leave a detail ambiguous
- **Gaps** — aspects of the concept the inputs don't cover that would be needed for a complete page

Do not show this sheet to the user unless asked. It is scaffolding for Step 4.

### Step 4 — Interview the user (mandatory)

Ask 3–5 targeted questions in one batch. Rules:

- **Maximum 5 questions.** If more real gaps exist, pick the 5 most blocking and save the rest for a follow-up round after drafting.
- **Each question must cite evidence.** Reference the source of the uncertainty: "The interview says X, but the notes say Y. Which is correct?"
- **No generic questions.** Style and tone are answered by the template and cheatsheet. Questions must be about facts or concepts the inputs don't resolve.
- **If the inputs are complete and unambiguous, skip the interview.** Say: "Inputs are complete. Drafting now." Do not invent questions for ritual.
- **If the user explicitly says "skip questions" or "draft with your best guess," proceed without interview** but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.

Wait for the user's answers before Step 5.

### Step 5 — Draft the page

Apply `ua-concept-topic-template.md`. Concept topics do not have a fixed spine — choose sections from the template's section menu that fit the topic.

Rules:
- **Overview is mandatory.** Every page must open with a lead paragraph that states: what this concept is, why it exists in the system, and why the partner needs to understand it.
- **Write in Ukrainian.** Follow the rules in `00-cheatsheet.md` and the template's Design rules section.
- **Never invent facts.** If a fact is not in the sources or user answers, flag it with `{/* NEEDS CONFIRMATION: what's unclear */}` — don't guess.
- **Apply the glossary.** Replace synonyms with canonical UA terms (Партнер, Транзакція, Вебхук, Кабінет партнера, etc.).
- **Imperative mood:** наказовий спосіб 2-ї ос. мн. for any instructional phrases: **натисніть**, **виберіть**, **перевірте**.
- **Intro sentences before numbered lists:** if the section heading already conveys the action, omit the intro and start directly with the list. If an intro is needed, write it as plain (non-bold) text: «Щоб {ціль}, виконайте такі дії:» — never «Щоб {ціль}:» and never bold.
- **No step-by-step procedures.** Instructions belong in user guides. Concept topics explain; they do not instruct.
- **For flows and lifecycles:** prefer a Mermaid `sequenceDiagram` for multi-actor flows and a Mermaid `flowchart` for decision trees or status transitions.
- **For screenshots:** only embed from `.assets/` (root) — never from `.assets/ref/`. Choose syntax based on the classification from Step 2:
  - **Full-page**: `![Описовий alt-текст](./assets/image.png)`
  - **Compact** (dialog, modal, narrow panel): `<img src={require('./assets/image.png').default} width="480" alt="Описовий alt-текст" />`
- **For tables:** use them for structured comparisons, field definitions, or status lists.
- **Section headings:** noun phrases in sentence case in Ukrainian (e.g., `## Модель статусів транзакцій`). No numbered headings.
- **Do not mention «кабінет партнера» in page body text.** The reader is already in that context. Use «меню» for navigation references. Wrong: «в розділі X у кабінеті партнера». Right: «в меню X».
- **Attribute column text:** text in the **Атрибути** column of tables must not be bold.
- **Colon over dash in bullet lists:** when labelling items, prefer `:` over `—`. If the label is a UI element name, do not bold the colon (`**UI елемент**: опис`); if the label is plain text, bold both label and colon (`**Назва:** опис`).
- **Status values:** UI status labels visible in the interface (Завершений, Відмінений, Помилка, Новий, В черзі, В роботі) must be **bold**. System/API status values not shown verbatim in the UI (`success`, `cancelled`, `new`, `in queue`, `in work`) must be in `code font`.
- **"ви" not "Партнер" as subject:** when describing actions the reader can take, prefer «ви можете» over «Партнер може». Do not use «Партнер» as the grammatical subject in instructional phrases.
- **UCP naming:** write the system name as **UCP** only. Never UCPay, UniComPay, or any variant.
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}`.

### Step 6 — Self-review before saving

Before writing to disk, check:

- Every glossary-ua term used in prose matches the canonical form in `glossary-ua.md`
- Intro sentences before numbered lists are plain (non-bold) text, or are omitted where the heading already conveys the action
- Bullet list items use `:` not `—`; colon is not bold when adjacent to a UI element name
- «кабінет партнера» does not appear in body text
- Attribute column values in tables are not bold
- No майбутній час (`буде`, `матиме`) in descriptions of current system behaviour
- No Russian calques from `00-cheatsheet.md` Section 11 (не «являється», «даний», «в залежності від»)
- No marketing adjectives
- UI status labels (Завершений, Відмінений, В роботі) are **bold**; system/API values (`success`, `cancelled`, `in work`) are in `code font`
- No «Партнер» used as subject in instructional phrases (use «ви можете» instead)
- Every fact in the page is traceable to an input source or a user answer from Step 4
- The overview is present and covers: what the concept is, why it exists, and why the reader needs it
- All chosen sections are complete; bare placeholders are either filled or removed
- Next steps links only to user guides; Related documents links to other concepts or references

### Step 7 — Reviewer pass

After the self-review passes, do a focused second read that targets the project-specific rules:

1. Page intro — if it mentions «кабінет партнера», rewrite to use «меню» or omit.
2. Each section heading — if the heading matches the immediately following intro sentence, delete the intro sentence.
3. Each remaining intro sentence — strip bold formatting if present.
4. Each bullet list — replace `—` with `:`; adjust colon bolding per the UI-element rule.
5. Reference table **Атрибути** column — remove bold from all cell values.
6. UI status labels — if visible-in-UI statuses (Завершений, Відмінений, В роботі) are in `code font`, change to **bold**.
7. «Партнер» as subject in instructional phrases — rewrite as «ви можете» or an equivalent active form.

Fix every issue found before saving.

### Step 8 — Save

Save to `partner-cabinet/<target-folder>/<slug>.md`, where the target folder was confirmed in Step 1.

Do not update `sidebarsPartnerCabinet.ts` — the sidebar is auto-generated.

Do not create the EN translation — that is a separate step using the `doc-translator` skill after human approval.

After saving, report:
- The file path written
- A short summary of what was produced (sections chosen, key concepts covered)
- A list of unresolved `{/* NEEDS CONFIRMATION: ... */}` items, if any
- A list of unresolved `{/* ToDo: ... */}` items, if any
- Any follow-up questions deferred from Step 4

## When inputs are insufficient

If after the interview the inputs still leave the overview plus more than half the planned sections unfilled, do not draft. Report the specific gaps to the user and ask whether to proceed with heavy `{/* NEEDS CONFIRMATION */}` flagging or to pause and gather more input.

## Explicit invocation examples

This skill triggers only when the user names it explicitly. Examples of valid invocations:

- "Use concept-doc-writer to document the transaction lifecycle"
- "concept-doc-writer: write the Webhook delivery model page"
- "Invoke concept-doc-writer for the dispute resolution overview"

If the user asks for concept documentation without naming this skill, suggest invoking it but wait for explicit permission.
