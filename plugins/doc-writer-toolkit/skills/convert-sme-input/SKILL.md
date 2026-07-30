---
name: convert-sme-input
description: Converts raw SME interview notes, meeting transcripts, or rough text into a structured Markdown source file for this project's documentation. Use when you need to turn unprocessed SME input into a clean `.sources/sme-interview.md`, compare raw SME files against processed source notes, or extract facts for guide writing.
---

# convert-sme-input

## Overview

Use this skill to transform raw SME input into a clean source Markdown file that other skills can consume.

The output is **not** a user guide or concept topic. It is a processed source note: a structured, evidence-preserving summary of what the SME said, organized so future documentation tasks can find business rules, UI behavior, statuses, validations, exceptions, and items that must appear in guides.

## Domain note

The extraction checklist, the section-name examples, and the "Згадати у документації" categories further down are written for this project's payments domain (UCPay's partner cabinet: transactions, webhooks, disputes). If this skill runs against a different product, treat them as illustrations of the underlying principle — group facts by business concept, name sections after what's actually being explained, flag what a guide writer must not miss — and substitute that product's own categories rather than forcing UCPay-specific ones onto unrelated content.

## Inputs

The user can provide one or more of the following:

- Raw transcript or conversation text.
- A raw source file (`.txt`, `.md`, etc.).
- An existing processed Markdown file to compare against or update.
- A target doc folder under this project's UA content root (resolve the root via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — do not assume `partner-cabinet/`).
- A topic or flow (e.g., inbound transactions, webhook configuration, dispute handling, partner cabinet receipts — see "Domain note" below).

If the target path is missing, propose a concise file name under `.sources/` in the relevant doc folder, e.g. `<UA content root>/transactions/.sources/sme-interview.md`.

## Source priority

When converting or comparing information, use this order:

1. Raw SME input for meeting-specific facts, intent, explanations, and unresolved questions.
2. Existing processed source Markdown, if present, for current structure and previously accepted wording.
3. API brief documents in `/api-docs/api-references/` if the topic covers API-facing behavior.
4. Screenshots in `.sources/frames/{video-basename}-frames/` for self-checking visual/UI claims against the recording — see "Self-check via screenshots" below. This is **not** the same folder as `.assets/`, which holds only the curated screenshots someone already chose to embed in the published doc; don't confuse the two.
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
2. Identify the document topic and the target section under this project's UA content root (`${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`).
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
5. Preserve important SME nuance, but rewrite the text into concise documentation-source prose. For a fact tied to a specific visual/UI moment, self-check it against a screenshot first — see "Self-check via screenshots" below.
6. Add a `### Згадати у документації` section with every item a guide writer must remember.
7. If updating an existing Markdown file, add missing facts without removing useful accepted structure.
8. After updating, summarize what was added and what remains uncertain.

## Self-check via screenshots

Before writing a fact tied to a specific visual/UI moment (the kind that gets a `(M:SS)` citation — see Writing rules), confirm it against a screenshot rather than trusting the transcript text alone:

1. Note the moment's timestamp in seconds (for a range, the midpoint).
2. List `.sources/frames/{video-basename}-frames/*.jpg` (see Source priority above — not `.assets/`) and parse each filename's `HH-MM-SS` into seconds.
3. If one falls within 15 seconds of the target moment, read it directly to confirm or inform the finding before writing it.
4. If none does, follow `extract-sme-screenshots`' "Targeted extraction" procedure to pull exactly what's missing — that procedure is documented once, in that skill; don't re-describe it here. **Batch this**: collect every timestamp that turns out to be missing while drafting, and make one targeted-extraction call with all of them together at the end of the pass, not one call per finding.
5. If `.sources/frames/{video-basename}-frames/` doesn't exist yet and no raw video is available either, proceed without visual confirmation — note in the final response that visual claims weren't screenshot-verified.

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
- **Cite a timestamp for facts tied to a specific visual/UI moment** — the SME shows, clicks, or points at something on screen, not just states a rule verbally. Use the format already in the raw transcript: `(M:SS)` for a moment, `(M:SS–M:SS)` for a range. Place it right after the sentence it supports: «Після оплати статус одразу змінюється на **Завершений** (14:32).» Don't cite a timestamp for a fact that's purely verbal (a business rule, a policy, an answer to a question) — only for something a screenshot could actually show. Before writing one of these facts, confirm it against an actual screenshot first — see "Self-check via screenshots" below; the citation is also what a later manual pass over `extract-sme-screenshots` reads to guarantee a screenshot exists at each one, so an uncited visual finding can silently end up without one.
- Do not use raw transcript fillers, false starts, or personal chatter unless they explain a decision.
- Do not invent behavior that is not in the raw SME input or supporting sources.
- Do not over-polish into a final guide. Processed SME notes must remain source material, not user-facing instructions.
- If the SME says a visual is not final, record that explicitly.
- If a fact is only inferred, label it as an inference.

## Section guidance

Use section names that match the content. Good examples for this project's payments domain (see Domain note above — adapt the categories, not just the names, for a different product):

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

Add concise bullets for points a future guide must not miss. The categories below are payments-domain examples (see Domain note above) of the underlying principle — anything that would silently mislead a partner or reader if omitted:

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
- Every fact tied to a specific visual/UI moment has a `(M:SS)` or `(M:SS–M:SS)` citation; purely verbal facts don't have one.
- The final response explains what changed and whether anything needs SME follow-up.
