---
name: api-doc-writer
description: Writes API reference documentation pages for the project this skill is installed in, following the authoring rules in CLAUDE.md. Use explicitly ("use api-doc-writer to document...", "api-doc-writer: write the Create payin transaction page"). Produces one endpoint per page following ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/api-reference-template.md, with a mandatory interview phase before drafting. Saves to the project-declared API reference root. Not for user guides, concept topics, or narrative API pages (route those to concept-doc-writer).
---

# api-doc-writer

You are writing an English API reference page for the project this skill is installed in. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing an API page end-to-end.

## Scope

- **In scope:** one endpoint per page, following `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/api-reference-template.md`.
- **Out of scope:** partner cabinet user guides, concept topics for the partner cabinet, Ukrainian translations, sidebar changes. Narrative API pages that describe concepts (authentication overview, webhook delivery model, status lifecycle, error handling) are **out of scope** — use `concept-doc-writer` instead, which loads `api-integration-context.md` and handles concept topics for any domain including API. When the user requests a narrative API page, say: "This is a concept topic — I'll use concept-doc-writer which has the right template and API context loaded."

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

**Shared authoring rules (load first, referenced throughout):**
- `${CLAUDE_PLUGIN_ROOT}/context/authoring-common.md` — marker conventions, path resolution, style-guide loading, voice & audience, the absolute internal-link rule, and the P1–P5 self-review / reviewer-pass scaffolds and explicit-invocation preamble. This skill references these baselines instead of restating them; only the doc-type-specific twists live below. (API pages are always English endpoint references, so the content-language and partner-cabinet-body-text parts of that file don't apply here.)

**Project paths (resolve first):**
- Per **Path & content-language resolution** in `authoring-common.md`, resolve this project's **API reference root** (where API pages are written) and its **UA URL prefix** (feeds the internal-link rule in Step 5). Do not hardcode `docs/api-reference/`; if the project doesn't declare it, use `project-paths.md`'s fallback (default `docs/api-reference/`, offer to persist).

**Templates:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/api-reference-template.md` — the authoritative structure. When the template and examples disagree, the template wins.

**Project rules:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md` — canonical EN terminology.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-integration-context.md` — cross-cutting facts about the API (balances, transaction lifecycle, webhooks, disputes, auth, business rules). Always applicable background.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` — rank-0 project formatting conventions (what bold/italic/code font mean here, placeholder form, one-entity-one-render, code-entity vs. human concept). Outranks everything else loaded for this task, including this skill's own body. API reference pages are always English, so only its Core section and English section apply.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-selection.md` — shared screenshot selection procedure: three-folder model, four selection cases, sensitive-content screening, rename pattern, full-page vs. compact classification.

**Style guide (project-declared, resolved before drafting):**
- Follow the **Style-guide loading** procedure in `authoring-common.md`, mapping the content you're about to write (request/response tables, code samples, error lists, admonitions, formulas, terminology, etc.) to the matched topical files.

**Examples — voice and tone reference only:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/api-reference-docs/api-example-retrieve-guest-carts.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/api-reference-docs/api-example-submit-checkout-data.md`

These examples illustrate prose density, JSON formatting, `<details>` usage for long samples, and table formatting. They do **not** represent the target structure. For sections, headings, and required content, follow the template.

## Workflow

Execute the steps in order. Do not skip the interview.

### Step 1 — Locate inputs

Ask the user for the endpoint slug if not provided. Default input file: `api-docs/api-references/<slug>.md` (relative to the project root). This file contains all info a tech writer could gather, including request, response, and error details.

Also check for a supplemental transcript at `.sources/sme-interview.md` in the relevant section folder. If present, treat it as one input among others — it may be incomplete or contradict the brief.

Also check for `.sources/app-notes.md` in the relevant section folder — **optional**; structured evidence written by `app-explorer` when it has run. Load if present; skip if absent — do not require it. It is direct app observation and the highest-confidence source for any UI facts an API page cites (e.g. a partner-cabinet setting named in Prerequisites); prefer it over the brief or `sme-interview.md` when they disagree on such a detail.

If you still have open questions after reading the inputs, check existing published pages in the project's API reference root (resolved in Sources to load) for consistency — do not copy structure or content from them.

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

**Screenshots (only if the brief includes any — most endpoint pages have none).** An API reference page occasionally needs a partner-cabinet screenshot (e.g., where to find a setting mentioned in Prerequisites). Each API doc page has its own `.assets/` folder, co-located with the page file — create it if it does not exist before copying any screenshots into it. If `.assets/` or `.sources/frames/{video}-frames/` exist next to the input file, follow `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-selection.md` — it covers the three-folder model, the four selection cases, the sensitive-content screening requirement, the rename pattern, the full-page vs. compact classification, and recording each embed's origin frame in `frames-index.json`. Apply every step in that file — including the post-embed origin-recording step (step 4), which lets `cleanup-unused-screenshots` trace a renamed embed back to its source frame — whenever you select, copy, rename, or embed a screenshot. If neither folder exists, this page simply has no screenshots — proceed without one.

Choose the embed syntax based on the classification:
- **Full-page**: `![Descriptive alt text](./.assets/image.png)`
- **Compact** (dialog, modal, narrow panel): `<img src={require('./.assets/image.png').default} width="{compact-width}" alt="Descriptive alt text" />` — `{compact-width}` is the resolved `Compact image width:` (default `480`); see `screenshot-selection.md`.

Note the leading dot on `./.assets/` — images embed from `./.assets/`, not `./assets/`.

### Step 3 — Compose a facts sheet

Before asking questions, produce a short internal facts sheet organized as:

- **Confirmed facts** — what the inputs clearly state
- **Unclear or contradictory** — where inputs disagree or leave a detail ambiguous
- **Gaps** — template sections the inputs do not cover

Do not show this sheet to the user unless asked. It is scaffolding for Step 4.

### Step 4 — Interview the user (mandatory by default)

The blocking interview below is the **default** and runs on every direct invocation. **If invoked in `orchestrated` mode** (see **Orchestrated mode** in `authoring-common.md`), skip this blocking step: draft with your best-guess resolution of each gap, flag every assumption with a `{/* NEEDS CONFIRMATION: ... */}` marker, and emit the consolidated batch list of those assumptions at the end of the run instead of waiting here. This mode is opt-in and set only by the orchestrator.

Ask 3–5 targeted questions in one batch. Rules:

- **Maximum 5 questions.** If more real gaps exist, pick the 5 most blocking and save the rest for a follow-up round after drafting.
- **Each question must cite evidence, then propose an answer.** Cite the source of the uncertainty, state your best-guess resolution from the available evidence, and ask the user to confirm or correct: "The brief says X, but the Postman example shows Y — I'll use Y since it's more specific; confirm or correct?" Do not ask an open question where the user must make the choice from scratch.
- **No generic questions.** Style and tone are answered by the style guide. Questions must be about facts the inputs don't resolve.
- **If the inputs are complete and unambiguous, skip the interview.** Say: "Inputs are complete. Drafting now." Do not invent questions for ritual. Treat a fact answered in `app-notes.md` as resolved — do not ask a question the app already answered.
- **If the user explicitly says "skip questions" or "draft with your best guess," proceed without interview** but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.

Wait for the user's answers before Step 5. (In `orchestrated` mode there is no wait — proceed straight to Step 5 with best-guess resolutions and `{/* NEEDS CONFIRMATION */}` markers, per **Orchestrated mode** in `authoring-common.md`.)

### Step 5 — Draft the page

Apply the API reference template. Single endpoint per page.

Rules:
- **Never invent API facts.** Fields, headers, error codes, status values — if a fact is not in the sources, flag it with `{/* NEEDS CONFIRMATION: ... */}`, don't guess. **Exception:** adjust obviously malformed example values in JSON samples (e.g. `Test`, `7777777`) to realistic values that correlate with field names and types. Flag every such adjustment with `// NEEDS CONFIRMATION: original value was <ORIGINAL_VALUE>` as an inline JSON comment. Use Ukraine-based values where applicable (Ukrainian phone format, common Ukrainian names, etc.).
- **Apply the glossary.** Replace synonyms with canonical EN terms (Partner, Transaction, Webhook, etc.).
- **Sentence style, UI labels, status values, placeholders, code-vs-concept rendering:** follow `formatting-conventions.md`'s Core section (Ж1–Ж7) and its English section — do not restate them here.
- **Match the template's section structure.** Prerequisites (if applicable), Authentication, endpoint action, Request, Response, Possible errors, Next steps.
- **Internal links to other doc pages must be absolute** — follow the **Internal links** rule in `authoring-common.md` (project UA URL prefix + path relative to the content root, no `.md`/`.mdx`; anchor as `#slug`; never `./`/`../` page links or hardcoded `/docs/`; asset links stay `./.assets/…`). Applies to Authentication, Next steps, Other management options, the error-codes page, etc.
- **For code fences:** use `json` for JSON bodies, `bash` for cURL examples, `text` for plain strings.
- **For long request or response samples:** wrap in `<details>` blocks.
- **For reader-replaced placeholders:** `*`\``UPPER_CASE`\``*`.
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}` — see **Marker conventions** in `authoring-common.md`.

### Step 6 — Self-review before saving

Before writing to disk, check:

- Every glossary term used in prose matches the canonical EN form
- No future tense (`will`, `would`) in descriptions of current behavior
- No marketing adjectives (`powerful`, `seamless`, `robust`)
- No stale links from example files (e.g., `/docs/wellfunnel-*`)
- Every link to another doc page is absolute (project UA URL prefix + path, no `.md`); no `./`/`../` page links, no hardcoded `/docs/` (asset links `./.assets/…` are exempt)
- Every fact is traceable to an input source or a user answer from Step 4
- All required template sections are present; optional ones are either filled or omitted (not left as empty placeholders)
- UI labels, status values, placeholders, and code-vs-concept rendering follow `formatting-conventions.md` Ж1–Ж4
- The draft conforms to every rule in the style-guide topical files loaded per "Sources to load" (resolved via `style-guide-registry.md`) — check against those files directly, don't rely on memory of past drafts
- **Run the P1–P5 self-review scaffold** in `authoring-common.md` (P1 inherited-wording — check against the brief and `.sources/sme-interview.md`; P2 heading-language, here always English; P3 bold-audit; P4 as-is; P5 one-render-per-entity — the entity list here is constants, query parameter values, and field names).

### Step 7 — Reviewer pass

After the self-review passes, do a focused second read: **run the P1–P5 reviewer-pass steps** from `authoring-common.md` (P1 inherited-wording diff against the brief/`.sources/`; P2 heading-language; P3 bold-audit; P4 as-is; P5 render-audit). Two API-specific twists on that scaffold:

- **P3 — Bold audit:** request/response field names and constants are `code font`, not bold (Ж1/Ж4) — strip bold from them.
- **P5 — Render audit:** the entity list is field names, constants, and enum values.

Fix every issue found before saving.

### Step 8 — Save

Save the page to `<API reference root>/<slug>/<slug>.md` (resolved in Sources to load). Create intermediate directories as needed.

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

This skill is **explicit-invocation only** — see the **Explicit-invocation preamble** in `authoring-common.md`. Examples of valid invocations:

- "Use api-doc-writer to document POST /transaction/create"
- "api-doc-writer: write the Create payin transaction page"
- "Invoke api-doc-writer for the webhook delivery page"

If the user asks for API documentation without naming this skill, suggest invoking it but wait for explicit permission.
