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
3. The host project's `CLAUDE.md` — for `Admin UI:`, `API test collection:`, and credentials (via `.env`).
4. The section's `.sources/section-readiness.json` — to know which pages exist, their states, and marker counts.
5. The section's existing `.sources/sme-interview.md` if present — to know what questions are already open.

Do not load style-guide corpora or templates — this skill writes no documentation.

## Credentials rule — mandatory

**Never hardcode credentials in any file you write or edit.** Credentials live in the project's `.env` file (git-ignored). Read them from there at the start of the run. If `.env` is missing or a needed variable is absent, stop and tell the user exactly which variable is missing — do not guess or invent values.

**Never point Playwright at a production URL.** Use only the test environment declared in `.env` or `CLAUDE.md`. If you cannot confirm a URL is the test environment, ask before proceeding.

## Value realism rule — mandatory

Apply the Value realism rule from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/value-realism.md`.

## Step 0 — Resolve config and check prerequisites

1. Read `.env` at the project root. Extract the variables needed for this section (at minimum: `OPERATOR_BASE_URL`, `OPERATOR_USERNAME`, `OPERATOR_PASSWORD`). If any are missing, stop and list them.
2. Confirm `Admin UI: playwright` is declared in `CLAUDE.md`. If not, stop — Playwright is required for this skill.
3. Confirm the `API test collection:` field points at an existing file. If it's not declared but a `.sources/UCPay.postman_collection.json` (or similar) exists, use it and note that it is not yet declared in `CLAUDE.md` — offer to add the declaration.
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
- **Payout timing note:** queued payouts auto-expire after ~2 minutes in this test environment. Seed payout scenarios immediately before capturing their UI state — do not seed them all upfront and capture later.
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
3. Capture screenshots:
   - Name each file descriptively: `{subject}-{ui-element-type}.png` (e.g. `transactions-page-payin-tab.png`, `accept-transaction-dialog.png`)
   - Save directly to `.assets/` in the section folder
   - Capture each relevant state separately — one screenshot per state
   - For dialogs and modals: capture open state (with content visible)
4. Answer the specific questions from the exploration plan:
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

## Step 5 — Self-review before finishing

Before finishing, verify:

1. Every scenario from Step 1's plan was attempted — if skipped, noted with a reason.
2. Every `{/* NEEDS CONFIRMATION */}` question from the existing pages has an answer or an `unanswered` entry in app-notes.md.
3. Every screenshot saved to `.assets/` is named descriptively and represents a real UI state.
4. No credentials appear anywhere in `app-notes.md` or in any screenshot filename.
5. No production URL was accessed — only the test environment.
6. `app-notes.md` is complete (no empty sections).

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
