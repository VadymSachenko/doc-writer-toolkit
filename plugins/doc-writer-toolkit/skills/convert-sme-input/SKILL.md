---
name: convert-sme-input
description: Converts raw SME interview notes, meeting transcripts, or rough text into a structured Markdown source file for UniComPay partner cabinet documentation. Use when you need to turn unprocessed SME input into a clean `.sources/sme-interview.md`, compare raw SME files against processed source notes, or extract facts for guide writing.
---

# convert-sme-input

## Overview

Use this skill to transform raw SME input into a clean source Markdown file that other skills can consume.

The output is **not** a user guide or concept topic. It is a processed source note: a structured, evidence-preserving summary of what the SME said, organized so future documentation tasks can find business rules, UI behavior, statuses, validations, exceptions, and items that must appear in guides.

## Inputs

The user can provide one or more of the following:

- Raw transcript or conversation text.
- A raw source file (`.txt`, `.md`, etc.).
- An existing processed Markdown file to compare against or update.
- A target doc folder under `partner-cabinet/` (e.g., `partner-cabinet/transactions/`).
- A topic or flow (e.g., inbound transactions, webhook configuration, dispute handling, partner cabinet receipts).

If the target path is missing, propose a concise file name under `.sources/` in the relevant doc folder:

- `partner-cabinet/transactions/.sources/sme-interview.md`
- `partner-cabinet/settings/webhooks/.sources/sme-interview.md`

## Source priority

When converting or comparing information, use this order:

1. Raw SME input for meeting-specific facts, intent, explanations, and unresolved questions.
2. Existing processed source Markdown, if present, for current structure and previously accepted wording.
3. API brief documents in `/api-docs/api-references/` if the topic covers API-facing behavior.
4. Screenshots in `.assets/`, if the raw SME input references visual flows or the user asks to validate against them.
5. Project glossary (`${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md`) for terminology consistency.

If sources conflict, do not silently choose. Record the conflict under `### Питання або потребує уточнення`.

## Output structure

Use this structure unless the existing processed file already has a better-established structure:

```markdown
### Загальний контекст

<short summary: scope of the session, participants if known, and why this topic matters>

---

### <topic-specific section>

<facts grouped by business concept, UI area, flow stage, status, validation, or exception>

---

### <another topic-specific section>

<facts>

---

### Питання або потребує уточнення

- <unclear, conflicting, or source-weak item>

---

### Згадати у документації

- <documentation-relevant point that future guide writers must include>
```

Only include `### Питання або потребує уточнення` if there are real unresolved items.

Always include `### Згадати у документації`. This section is the handoff to future guide-writing work.

## Workflow

1. Read the raw SME input and the existing processed Markdown if one exists.
2. Identify the document topic and the target section in `partner-cabinet/`.
3. Extract only documentation-relevant facts:
   - Business rules and ownership
   - Process boundaries and entry conditions
   - UI screens, buttons, fields, banners, modals, and tooltips
   - Statuses and their meaning in the partner cabinet context
   - Validations, errors, blockers, warnings, and exceptions
   - Partner-side vs UCPay-side responsibilities
   - Webhook events and delivery conditions
   - Dependencies on API calls, external systems, or configuration
   - Open questions and SME uncertainty
4. Group extracted facts into sections by concept, not by transcript order.
5. Preserve important SME nuance, but rewrite the text into concise documentation-source prose.
6. Add a `### Згадати у документації` section with every item a guide writer must remember.
7. If updating an existing Markdown file, add missing facts without removing useful accepted structure.
8. After updating, summarize what was added and what remains uncertain.

## Comparison workflow

When the user asks to compare raw and processed files:

1. Read the raw file and the processed Markdown file.
2. Build a checklist of facts in the raw input.
3. Mark each fact as:
   - already covered
   - missing and should be added
   - not relevant for user documentation
   - unclear or conflicting
4. Update the processed Markdown only with missing facts that help future docs.
5. In the final response, list:
   - added sections or bullets
   - important raw facts intentionally not added and why
   - open questions for the SME

## Writing rules

- Write in Ukrainian.
- Use canonical UCPay terms from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md`: **Партнер**, **Транзакція**, **Вебхук**, **API-токен**, **Кабінет партнера**, **Вхідна транзакція**, **Вихідна транзакція**, etc.
- Status values in `code font`: `new`, `in queue`, `in work`, `success`, `cancelled` (UK spelling).
- UI labels in **bold**: натисніть **Зберегти**.
- Keep source-ticket identifiers when they help trace a fact (e.g., `UCP-277`).
- Do not use raw transcript fillers, false starts, or personal chatter unless they explain a decision.
- Do not invent behavior that is not in the raw SME input or supporting sources.
- Do not over-polish into a final guide. Processed SME notes must remain source material, not user-facing instructions.
- If the SME says a visual is not final, record that explicitly.
- If a fact is only inferred, label it as an inference.

## Section guidance

Use section names that match the content. Good examples for UCPay topics:

- `### Типи транзакцій та вкладки`
- `### Статуси транзакцій та їх значення`
- `### Фільтри та таблиця транзакцій`
- `### Квитанції та їх обмеження`
- `### Сторно: як працює`
- `### Налаштування вебхуків`
- `### Автентифікація та API-токен`
- `### Обробка диспутів`
- `### Обмеження та крайові випадки`
- `### Залежності від зовнішніх систем`

Avoid vague section names such as `Notes`, `Other`, or `Misc`.

## What belongs in «Згадати у документації»

Add concise bullets for points a future guide must not miss:

- Critical differences between inbound and outbound transaction flows.
- Mandatory prerequisites or blockers (what must be configured before a feature works).
- Status behavior that affects what the partner can do.
- Error messages and validation differences.
- Webhook delivery conditions and retry behavior.
- Cases where partner cabinet behavior differs from API behavior.
- Warnings that prevent wrong partner expectations.
- SME-confirmed defaults or recommendations.

Do not add implementation-only details unless they directly affect user documentation.

## Output checklist

Before finishing:

- The processed Markdown has a clear topic and useful section headings.
- Transcript order was converted into conceptual order.
- No important documentation-relevant SME fact was lost.
- `### Згадати у документації` exists and contains actionable bullets.
- Open questions are separated from confirmed facts.
- UI labels, statuses, and exact messages are preserved where important.
- The final response explains what changed and whether anything needs SME follow-up.
