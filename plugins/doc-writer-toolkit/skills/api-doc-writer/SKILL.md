---
name: api-doc-writer
description: Writes API reference documentation pages for UniComPay following the authoring rules in CLAUDE.md. Use explicitly ("use api-doc-writer to document...", "api-doc-writer: write the Create payin transaction page"). Produces one endpoint per page following ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/api-reference-template.md, with a mandatory interview phase before drafting. Saves to docs/. Not for user guides or concept topics.
---

# api-doc-writer

You are writing an English API reference page for UniComPay. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing an API page end-to-end.

## Scope

- **In scope:** one endpoint per page, following `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/api-reference-template.md`. Narrative API pages that describe concepts (authentication overview, webhook delivery model, status lifecycle, error handling) are also in scope when the user explicitly requests them.
- **Out of scope:** partner cabinet user guides, concept topics for the partner cabinet, Ukrainian translations, sidebar changes.

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

**Templates:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/api-reference-template.md` — the authoritative structure. When the template and examples disagree, the template wins.

**Project rules:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md` — canonical EN terminology.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-integration-context.md` — cross-cutting facts about the API (balances, transaction lifecycle, webhooks, disputes, auth, business rules). Always applicable background.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` — rank-0 project formatting conventions (what bold/italic/code font mean here, placeholder form, one-entity-one-render, code-entity vs. human concept). Outranks everything else loaded for this task, including this skill's own body. API reference pages are always English, so only its Core section and English section apply.

**Style guide (project-declared, resolved before drafting):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — "Resolving which guide a project uses" section — to find this project's declared `Style guide:` token (from its `CLAUDE.md`), then that file's "Loading procedure per guide" for the resolved token, mapping the content you're about to write (request/response tables, code samples, error lists, admonitions, formulas, terminology, etc.) to the matched topical files.
- Apply every matched rule while drafting, not just at a later review pass.
- If the project has no declared style guide, follow the registry's fallback: ask once, offer to persist the answer to that project's `CLAUDE.md`.
- Do not hand-copy a guide name, corpus path, or individual rule into this skill file — the registry is the single source of truth and changes independently of this file.

**Examples — voice and tone reference only:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/api-reference-docs/api-example-retrieve-guest-carts.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/api-reference-docs/api-example-submit-checkout-data.md`

These examples illustrate prose density, JSON formatting, `<details>` usage for long samples, and table formatting. They do **not** represent the target structure. For sections, headings, and required content, follow the template.

## Workflow

Execute the steps in order. Do not skip the interview.

### Step 1 — Locate inputs

Ask the user for the endpoint slug if not provided. Default input file: `/api-docs/api-references/<slug>.md`. This file contains all info a tech writer could gather, including request, response, and error details.

Also check for a supplemental transcript at `.sources/sme-interview.md` in the relevant section folder. If present, treat it as one input among others — it may be incomplete or contradict the brief.

If you still have open questions after reading the inputs, check existing published pages in `docs/api-reference/` for consistency — do not copy structure or content from them.

If the input file does not exist, ask the user where the inputs are before proceeding.

### Step 2 — Analyze inputs

Read every available input file. Extract:
- The endpoint under documentation (method, path, host)
- Request headers, query parameters, path parameters, body attributes
- Response structure and attributes
- Authentication requirements
- Error codes
- Any prerequisites (partner configuration, tokens, feature flags)
- Any related endpoints or flows the user should know about

**Screenshots (only if the brief includes any — most endpoint pages have none).** An API reference page occasionally needs a partner-cabinet screenshot (e.g., where to find a setting mentioned in Prerequisites). If `.assets/` or `.sources/frames/{video}-frames/` exist next to the input file, the same three-folder model as the other writers applies:

| Folder | Role |
|---|---|
| `.sources/frames/{video}-frames/` | Full archive of extracted frames + `frames-index.json`. Evidence base. Never embedded directly. |
| `.assets/` | Selected, renamed frames ready for embedding. The **only** folder the page links images from. |
| `.assets/ref/` | Reference-only frames: read for context, **never** embed. |

If `.assets/` is empty but `frames/` has an archive, do not silently draft with zero images if the brief implies one is needed — read `frames-index.json`, shortlist 3–8 candidates by matching the relevant prerequisite/step against `ocr_text`/`transcript_text` and `score`, open only those, then copy (not move) the confirmed ones into `.assets/` and rename them following the `{subject}-{ui-element-type}.png` pattern used by the other writer skills. If neither folder exists, this page simply has no screenshots — proceed without one.

### Step 3 — Compose a facts sheet

Before asking questions, produce a short internal facts sheet organized as:

- **Confirmed facts** — what the inputs clearly state
- **Unclear or contradictory** — where inputs disagree or leave a detail ambiguous
- **Gaps** — template sections the inputs do not cover

Do not show this sheet to the user unless asked. It is scaffolding for Step 4.

### Step 4 — Interview the user (mandatory)

Ask 3–5 targeted questions in one batch. Rules:

- **Maximum 5 questions.** If more real gaps exist, pick the 5 most blocking and save the rest for a follow-up round after drafting.
- **Each question must cite evidence.** Reference the source of the uncertainty: "The brief says X, but the Postman example shows Y. Which is correct?"
- **No generic questions.** Style and tone are answered by the style guide. Questions must be about facts the inputs don't resolve.
- **If the inputs are complete and unambiguous, skip the interview.** Say: "Inputs are complete. Drafting now." Do not invent questions for ritual.
- **If the user explicitly says "skip questions" or "draft with your best guess," proceed without interview** but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.

Wait for the user's answers before Step 5.

### Step 5 — Draft the page

Apply the API reference template. Single endpoint per page.

Rules:
- **Never invent API facts.** Fields, headers, error codes, status values — if a fact is not in the sources, flag it with `{/* NEEDS CONFIRMATION: ... */}`, don't guess. **Exception:** adjust obviously malformed example values in JSON samples (e.g. `Test`, `7777777`) to realistic values that correlate with field names and types. Flag every such adjustment with `// NEEDS CONFIRMATION: original value was <ORIGINAL_VALUE>` as an inline JSON comment. Use Ukraine-based values where applicable (Ukrainian phone format, common Ukrainian names, etc.).
- **Apply the glossary.** Replace synonyms with canonical EN terms (Partner, Transaction, Webhook, etc.).
- **Sentence style, UI labels, status values, placeholders, code-vs-concept rendering:** follow `formatting-conventions.md`'s Core section (Ж1–Ж7) and its English section — do not restate them here.
- **Match the template's section structure.** Prerequisites (if applicable), Authentication, endpoint action, Request, Response, Possible errors, Next steps.
- **For code fences:** use `json` for JSON bodies, `bash` for cURL examples, `text` for plain strings.
- **For long request or response samples:** wrap in `<details>` blocks.
- **For reader-replaced placeholders:** `*`\``UPPER_CASE`\``*`.
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}`.

### Step 6 — Self-review before saving

Before writing to disk, check:

- Every glossary term used in prose matches the canonical EN form
- No future tense (`will`, `would`) in descriptions of current behavior
- No marketing adjectives (`powerful`, `seamless`, `robust`)
- No stale links from example files (e.g., `/docs/wellfunnel-*`)
- Every fact is traceable to an input source or a user answer from Step 4
- All required template sections are present; optional ones are either filled or omitted (not left as empty placeholders)
- UI labels, status values, placeholders, and code-vs-concept rendering follow `formatting-conventions.md` Ж1–Ж4
- The draft conforms to every rule in the style-guide topical files loaded per "Sources to load" (resolved via `style-guide-registry.md`) — check against those files directly, don't rely on memory of past drafts
- **P1 — Inherited wording normalized.** For every heading and every bolded fragment, confirm it is not lifted from the brief or `.sources/sme-interview.md` without normalization. Intermediate notes are a source of *facts*, not of *wording*.
- **P2 — Heading language (Ж7).** Every heading is in English; a code entity inside one stays in `code font` but the surrounding words don't switch language.
- **P3 — Bold only on visible UI labels (Ж1).** For every `**...**` span, confirm it is a UI element's visible label, not emphasis on a fact, a term, or a module name.
- **P4 — Document as-is (Ж6).** No plans, upcoming changes, or "the team intends to..." in page body text (including inside admonitions) — only inside `{/* ToDo: ... */}`.
- **P5 — One render per entity (Ж3).** List the document's technical entities (constants, query parameter values, field names) and confirm each is written exactly one way everywhere in the page — not split across a code-font, quoted, and plain-text rendering of the same thing.

### Step 7 — Reviewer pass

After the self-review passes, do a focused second read:

1. **P1 — Inherited wording.** Diff every heading and bolded phrase against the brief/`.sources/`; rewrite any that were copied without normalization.
2. **P2 — Heading language.** Flag and rewrite any heading that mixes languages or leaves a glossary concept unglossaried.
3. **P3 — Bold audit.** Re-walk every `**...**` span; strip bold from anything that isn't a visible UI label (request/response field names and constants are `code font`, not bold — Ж1/Ж4).
4. **P4 — As-is audit.** Search the body (including admonitions) for future/planned-change language; move it to `{/* ToDo: ... */}`.
5. **P5 — Render audit.** Build the entity list (field names, constants, enum values); fix every entity with more than one rendering in the document.

Fix every issue found before saving.

### Step 8 — Save

Save the page to `docs/api-reference/<slug>/<slug>.md`. Create intermediate directories as needed.

Do not update `sidebars.ts` — the sidebar is auto-generated.

After saving, report:
- The file path written
- A short summary of what was produced (sections, key facts covered)
- A list of unresolved `{/* NEEDS CONFIRMATION: ... */}` items, if any
- A list of unresolved `{/* ToDo: ... */}` items, if any
- Any follow-up questions deferred from Step 4

## When inputs are insufficient

If after the interview the inputs still leave more than half the template sections unfilled, do not draft. Report the specific gaps to the user and ask whether to proceed with heavy `{/* NEEDS CONFIRMATION */}` flagging or to pause and gather more input.

## Explicit invocation examples

This skill triggers only when the user names it explicitly. Examples of valid invocations:

- "Use api-doc-writer to document POST /transaction/create"
- "api-doc-writer: write the Create payin transaction page"
- "Invoke api-doc-writer for the webhook delivery page"

If the user asks for API documentation without naming this skill, suggest invoking it but wait for explicit permission.
