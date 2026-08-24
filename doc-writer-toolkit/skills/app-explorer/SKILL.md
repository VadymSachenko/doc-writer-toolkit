---
name: app-explorer
description: Explores the live app for a documentation section by seeding real scenarios via the project's API test collection (Postman/newman), then capturing screenshots and recording observed UI behavior using Playwright. Writes everything it finds to .sources/app-notes.md — a structured evidence file that later steps (section-planner, writers, marker resolution) read instead of guessing. Use explicitly ("app-explorer: explore docs/transactions", "use app-explorer on the balance section").
---

# app-explorer

You are gathering evidence about the live app for one documentation section. You seed real scenarios via the API, navigate the UI with Playwright, capture screenshots, and write down exactly what you observe. The result is `.sources/app-notes.md` — a structured, factual evidence file. Every later step reads this file instead of guessing.

This skill does **not** write documentation pages. It does not plan structure. It does not resolve markers. It only observes and records.

## Scope

- **In scope:** one documentation section folder; seeding test-env state via the declared API test collection; navigating and observing the live UI via Playwright; capturing labeled screenshots into `.assets/`; writing `.sources/app-notes.md`.
- **Out of scope:** writing or editing doc pages; resolving `{/* NEEDS CONFIRMATION */}` markers directly (that is `resolve-markers`'s job, which reads this file); planning page structure (`section-planner`); running in production — test environment only, always.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve content root and language.
2. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/value-realism.md` — mandatory rules for all values entered into the UI via Playwright. Load before any UI interaction step.
3. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-capture.md` — scope ladder, two-shot pattern, annotation patterns, blur patterns. Load before any screenshot step.
4. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-seeding-notes.md` — project-specific timing and ordering caveats for API-seeded scenarios. Load before any seeding step.
5. The host project's `CLAUDE.md` — for `Admin UI:`, `API test collection:`, and credentials (via `.env`).
6. The section's `.sources/section-readiness.json` — to know which pages exist, their states, and marker counts.
7. The section's existing `.sources/sme-interview.md` if present — to know what questions are already open.

Do not load style-guide corpora or templates — this skill writes no documentation.

## Credentials rule — mandatory

**Never hardcode credentials in any file you write or edit.** Credentials live in the project's `.env` file (git-ignored). Read them from there at the start of the run. If `.env` is missing or a needed variable is absent, stop and tell the user exactly which variable is missing — do not guess or invent values.

**Never point Playwright at a production URL.** Use only the test environment declared in `.env` or `CLAUDE.md`. If you cannot confirm a URL is the test environment, ask before proceeding.

## Value realism rule — mandatory

Apply the Value realism rule from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/value-realism.md`.

## Tools required

This skill needs two concrete tools to do its work. Neither is assumed present — the preflight in Step 0 checks both and stops if either is missing.

- **Navigation + screenshots — a Playwright MCP server.** Drives the browser (navigate, click, fill fields, capture screenshots) against the test-environment Admin UI. This is what the skill actually operates when it says "navigate to the screen" or "capture the screenshot".
- **API seeding — a collection runner.** Runs the project's API test collection to set up test-env state (e.g. `newman` for a Postman collection, or whatever runner the project uses). This is what the skill operates when it says "call the API test collection".

**Both are resolved from the host project's `CLAUDE.md` "Documentation toolkit configuration" block**, declared the same way `Admin UI:` and `API test collection:` are — for example:

```md
## Documentation toolkit configuration

- **Admin UI:** playwright            # navigation/screenshot driver — Playwright MCP server
- **API test collection:** .sources/<product>.postman_collection.json
- **API collection runner:** newman   # runner for the collection above
```

Defaults when a field is present but unspecified: **Playwright MCP** for navigation/screenshots, and a **collection runner** (`newman` or equivalent) for API seeding. Read the concrete tool from that config; do not hardcode a different one.

## Step 0 — Preflight: resolve config and confirm tools are available

Run these checks before anything else. If any check fails, **stop and report exactly what is missing and how to fix it** — do not attempt to explore or seed without its driving tool.

1. Read `.env` at the project root. Extract the variables needed for this section (at minimum: `OPERATOR_BASE_URL`, `OPERATOR_USERNAME`, `OPERATOR_PASSWORD`). If any are missing, stop and list them.
2. **Navigation tool preflight.** Confirm `Admin UI: playwright` is declared in `CLAUDE.md` **and** that a Playwright MCP server is actually connected/available in the current session. If the field is missing, stop: "app-explorer needs a navigation tool. Declare `Admin UI: playwright` in the host project's CLAUDE.md 'Documentation toolkit configuration' block." If the field is declared but no Playwright MCP server is reachable, stop: "Playwright MCP server is not available in this session — connect it before running app-explorer; this skill cannot navigate or capture screenshots without it."
3. **Seeding tool preflight.** Confirm the `API test collection:` field points at an existing file. if it's not declared but a `.sources/*.postman_collection.json` or equivalent exists, use it and note that it is not yet declared in `CLAUDE.md` — offer to add the declaration. Then confirm a collection runner is available (the `API collection runner:` field, defaulting to `newman`). If no collection file can be found, stop: "app-explorer needs an API test collection to seed scenarios — declare `API test collection:` in CLAUDE.md pointing at the collection file." If a collection exists but no runner is available, stop: "No API collection runner is available — install/enable the declared runner (e.g. `newman`) before running app-explorer; this skill cannot seed scenarios without it."
4. Read `.sources/section-readiness.json`. Extract: the section verdict, list of pages, marker counts, and whether `sme-interview.md` is present.
5. Read `.sources/sme-interview.md` if present. Extract every open question or `{/* NEEDS CONFIRMATION */}` item mentioned — these are the specific things to watch for during exploration.

Report what you found and your plan for the run, then continue.

## Step 1 — Decide what to explore

Based on the section's pages and any open questions from `sme-interview.md`, produce a short internal exploration plan:

- **Scenarios to seed** via API — e.g. "create a queued payin", "create a queued payout", "set availability to closed"
- **Screens to visit** — every screen relevant to this section's pages
- **States to capture** — empty state (no data), loaded state, success state, error state, edge cases (e.g. payin vs payout tab, different statuses)
- **Specific questions to answer** — every open `{/* NEEDS CONFIRMATION */}` marker, listed as explicit questions: "Does the Accept button appear for all transaction types or only payins?"

This plan is internal scaffolding. Do not show it unless asked.

## Step 2 — Seed scenarios via API

For each scenario in the plan, call the API test collection to set up the test-env state. Rules:

- Use only the test environment (`OPERATOR_BASE_URL` and matching keys from `.env`).
- Call only the endpoints needed — do not make broad exploratory API calls.
- Record each scenario's outcome: which API call, what it created, the relevant IDs or reference numbers.
- **Time-sensitive scenarios:** seed them immediately before capturing their UI state — do not seed everything upfront and capture later. Some seeded state expires or changes on a timer in the test environment, and seeding a batch in parallel can let earlier scenarios lapse before later screens are captured. Follow the project's seeding notes in `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-seeding-notes.md` for the specific timing and ordering caveats that apply.
- If an API call fails, record the error and continue with other scenarios — do not stop the whole run for one failed seed.

## Step 3 — Explore and capture with Playwright

For each screen in the plan:

1. Navigate to the screen using the credentials from `.env`.
2. Observe and record:
   - Exact screen name (as shown in the UI, not guessed)
   - All visible UI elements: button labels, field names, column headers, status values, dropdown options, tab names
   - What happens in each state (empty, loaded, success, error)
   - Any warnings, banners, or contextual messages
   - The exact wording of any label you are unsure about
3. Before capturing, identify sensitive fields on the screen (financial amounts, IDs, card/account numbers, customer names and emails, internal hostnames). Apply blur per `screenshot-capture.md` Section 4 before shooting; restore after.
4. Capture screenshots following `screenshot-capture.md`:
   - **Dialogs, modals, drawers, dropdowns:** use the two-shot pattern (Section 2). Shot 1 = trigger context (clipped to containing section via the scope ladder in Section 1, trigger annotated red). Shot 2 = the dialog/dropdown itself (clipped to bounding box + 24 px). Name Shot 1 `{subject}-trigger.png`, Shot 2 `{subject}-dialog.png` or `{subject}-dropdown.png`.
   - **Direct state captures (no overlay):** one screenshot per state. Annotate the primary interactive element (Section 3, red border). Apply the scope ladder from Section 1 to decide crop.
   - Save all files to `.assets/` in the section folder.
5. Answer the specific questions from the exploration plan:
   - For each `{/* NEEDS CONFIRMATION */}` question, record the exact answer you observed: "The Accept button appears only on the Payins tab, not on Payouts."
   - If a question cannot be answered from what you can see (e.g. requires a specific permission level you don't have), record it as `unanswered` with the reason.

**Token discipline:** do not open screenshots to "check" them after saving — trust the file was written. Only open an image if you genuinely cannot describe what it shows without seeing it.

## Step 4 — Write app-notes.md

Write `.sources/app-notes.md` in the section folder. This is the evidence file every later step reads. Use this structure:

```markdown
# App notes — {section name}

**Explored:** {date}
**Test environment:** {OPERATOR_BASE_URL value}
**Scenarios seeded:** {list}

---

## Screens observed

### {Screen name as shown in UI}

**Path:** {how to reach it in the UI}
**States captured:** {empty | loaded | success | error | other}

**UI elements:**
- Buttons: {label}, {label}
- Columns: {name}, {name}
- Tabs: {name}, {name}
- Statuses: {value}, {value}
- Fields: {name}, {name}

**Screenshots:** {filename.png}, {filename.png}

**Notes:** {anything notable — edge cases, unexpected behavior, things that differ from what sme-interview.md said}

---

## Answers to open questions

For each {/* NEEDS CONFIRMATION */} item from the existing pages or sme-interview.md:

**Question:** {exact text of the marker}
**Answer:** {what you observed} | `unanswered — {reason}`
**Evidence:** {screenshot filename or "observed directly"}

---

## New findings

Things discovered during exploration that are not in any existing source file and are relevant to the documentation:

- {finding}

---

## Unanswered questions

Questions that could not be answered from the app (permission limitations, features not reachable in test env, etc.):

- {question} — {reason it could not be answered}
```

Do not leave any section empty — if nothing was found for a section, write "None." rather than omitting the section.

Also write `.sources/app-notes.json` alongside `app-notes.md`. Schema: `${CLAUDE_PLUGIN_ROOT}/context/artifact-schemas.md` ("App notes index"). For each screen in "Screens observed", produce one entry in `screens[]` with `name`, `path`, `statesCaptured`, `screenshots` (basenames of files saved to `.assets/`), and `answeredMarkers` (one entry per `{/* NEEDS CONFIRMATION */}` item answered for that screen). Put unanswered markers in the top-level `unansweredMarkers[]`. `resolve-markers` reads this index to match programmatically — keep the question text verbatim so it matches what appears in the doc.

## Step 5 — Self-review before finishing

Before finishing, verify:

1. Every scenario from Step 1's plan was attempted — if skipped, noted with a reason.
2. Every `{/* NEEDS CONFIRMATION */}` question from the existing pages has an answer or an `unanswered` entry in app-notes.md.
3. Every screenshot saved to `.assets/` is named descriptively and represents a real UI state.
4. Every dialog/modal/dropdown has two shots: a `-trigger.png` and a `-dialog.png` or `-dropdown.png`.
5. Every screenshot that contains sensitive data (amounts, IDs, card numbers, customer names) had blur applied before shooting — no raw sensitive values visible in any saved file.
6. Every trigger-context shot (Shot 1) has the trigger element annotated with a red outline.
7. Any scope-ladder fallback to full viewport is logged in `app-notes.md` under the relevant screen.
8. No credentials appear anywhere in `app-notes.md` or in any screenshot filename.
9. No production URL was accessed — only the test environment.
10. `app-notes.md` is complete (no empty sections).
11. `app-notes.json` was written alongside `app-notes.md`; `screens[].answeredMarkers` covers every answered `{/* NEEDS CONFIRMATION */}` item and the question text is verbatim.

## Step 6 — Report

Tell the user:
- How many screens were explored, how many scenarios were seeded
- How many `{/* NEEDS CONFIRMATION */}` questions were answered vs. unanswered
- How many screenshots were saved and where
- Any API calls that failed
- Any questions that could not be answered (so the user knows what still needs human input)

## Explicit invocation examples

This skill triggers only when named explicitly, or via its wrapper command `/explore-and-resolve` (which runs app-explorer, then `resolve-markers`). Run it after `/check-section-readiness` and before `/plan-section` — `section-planner` requires the `app-notes.md` this skill produces (when a live UI is declared). Examples:

- "app-explorer: explore docs/transactions"
- "use app-explorer on the balance section"
- "run app-explorer for docs/archive before writing"
