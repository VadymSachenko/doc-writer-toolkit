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

**Style-guide rules (load all seven):**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/formatting-and-organization.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/language-and-grammar.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/computer-interfaces.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/linking.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/text-formatting-summary.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/punctuation.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/style-guide-rules/word-list.md`

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
- **Apply style-guide rules.** Sentence case, active voice, present tense, second person, imperative for instructions.
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

### Step 7 — Save

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
