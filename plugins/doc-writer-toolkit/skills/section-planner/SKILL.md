---
name: section-planner
description: Reads a section's readiness report and app-notes.md (if available), cross-checks existing pages against the live app's actual flows, and proposes a page inventory — what to keep, merge, split, add, or delete — with a doc type and one-line rationale per page. Writes a section-plan.md for human approval. Nothing is written or deleted until you confirm. Use explicitly ("section-planner: docs/balance", "use section-planner on the archive section").
---

# section-planner

You are proposing the documentation structure for one section. You read what already exists, cross-check it against what the app actually does, and produce a plan: a proposed page inventory with a type and rationale per page. You write that plan to `.sources/section-plan.md` and stop — nothing is created, merged, or deleted until the user approves.

## Scope

- **In scope:** proposing the page inventory (what pages should exist, their types, their slugs, keep/merge/split/add/delete decisions). Writing `.sources/section-plan.md`. Nothing else.
- **Out of scope:** writing doc pages (`user-guide-writer`, `concept-doc-writer`, `api-doc-writer`). Resolving markers (`resolve-markers`). Style review. App exploration (`app-explorer`). Editing existing pages.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve content root and language.
2. `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — resolve the project's declared style guide token, then load **only the naming and titles topic file** from that corpus (via its ROUTING.md). Do not load the full corpus — only the file(s) that cover filename conventions, page title conventions, and topic-type naming rules (e.g. imperative mood for task-based titles). This is the only style-guide loading this skill does.
3. The section's `.sources/section-readiness.json` — **required**. If absent, tell the user to run `section-readiness` first.
4. The section's `.sources/app-notes.md` — **optional**. Load if present — it's the richest source for understanding real app flows.
5. The section's `.sources/sme-interview.md` — **optional**. Load if present — good for business-rule context.
6. Existing pages in the section folder — read each stub lightly (frontmatter + comment blocks) to understand the intended structure already captured there. Do not read complete pages in full — skim only.
7. Live app via Playwright (if `Admin UI: playwright` is declared and neither `app-notes.md` nor sufficient evidence exists) — navigate to the section's screens to understand the real flows before proposing structure. Read credentials from `.env`. Test env only.

Do not load templates — this skill proposes page types, it does not write pages. Templates are the writers' concern.

## Step 0 — Prerequisites

1. Confirm `.sources/section-readiness.json` exists. If not, stop: "Run section-readiness on this section first."
2. Read the readiness report fully. Note: verdict, page list with states and docTypes, marker counts, sources present, app-access.
3. Load optional sources in order: `app-notes.md` → `sme-interview.md` → existing page stubs.
4. If no `app-notes.md` exists and `Admin UI: playwright` is declared, do a lightweight app navigation pass now — enough to understand what screens and flows the section covers. Do not capture screenshots (that is `app-explorer`'s job) — just observe and note the flows. Apply the value-realism rule from `app-explorer`: every value entered into the UI must look like real operator activity — no test markers, no placeholder strings, no obviously synthetic amounts. Read `app-explorer`'s "Value realism rule" section before entering any data.

## Step 1 — Understand what the section actually covers

Before proposing any structure, answer these questions from the evidence:

- What does the **sidebar order** look like for this section? Read the existing folder structure — the subfolder order reflects how you organized the UI navigation. Use this as the default page order in the plan unless there's a clear reason to change it.
- What are the distinct **user goals** in this section? (e.g. "view balance", "deposit funds", "manage cards")
- What are the distinct **flows** in the app — how many separate procedures does a user actually perform?
- Which flows are **independent** (can be done in any order) vs. **sequential** (must be done in steps)?
- Is there **background knowledge** a user needs before they can use the section? (candidates for a concept page)
- Are any existing pages **covering the same flow** — i.e. candidates to merge?
- Are any existing pages **covering multiple flows** that should be split?
- Does the **app's UI navigation order** suggest a different or better structure than the existing folder order? If yes, propose it — but flag it as a deviation with a reason. The existing sidebar order is the default; only deviate when there's a clear user-experience benefit.

Record your answers as internal notes. Do not show them unless asked.

## Step 2 — Propose the page inventory

For each page that should exist in the final section, propose:

| Field | What to decide |
|---|---|
| `action` | `keep` / `merge` / `split` / `add` / `delete` |
| `slug` | the final folder/filename — **always lowercase kebab-case** (e.g. `view-account-balances/view-account-balances.md`) |
| `docType` | `concept` / `user-guide` / `api` |
| `title` | proposed human-readable page title — see title rules below |
| `rationale` | one line — why this page exists and why this action was chosen |
| `mergesFrom` | (if `merge`) list of existing slugs being merged |
| `splitsFrom` | (if `split`) the existing slug being split |
| `sourceEvidence` | what the proposal is based on: `app-notes` / `app-observed` / `sme-interview` / `existing-stub` / `inferred` |

### Slug rules (apply to every proposed slug)

- **Always lowercase.** No uppercase letters anywhere in the path.
- **Words separated by hyphens** (`-`), never underscores or spaces.
- **Folder name and filename match** — the page at `add-funds/add-funds.md`, not `add-funds/index.md` or `add-funds/addFunds.md`.
- **Derived from the title** — convert the title to kebab-case and drop articles (a, an, the).

### Title rules (apply to every proposed title, using the loaded style-guide naming file)

- **User guides (task-based):** imperative verb phrase — "Add funds", "Manage cards", "View account balances". Not "Adding funds", not "Fund addition", not "How to add funds".
- **Concept topics (background knowledge):** noun phrase — "Balance overview", "Transaction lifecycle", "Card types". Not "Understanding balances", not "How balances work".
- **API reference:** noun phrase matching the endpoint's resource — "Create payin transaction", "Retrieve transaction details".
- Apply any additional title conventions from the loaded style-guide naming file. If the style guide conflicts with the rules above, the style guide wins — it is loaded precisely for this purpose.

### Action rules

- **`keep`** — existing page covers a real, distinct user flow. Content may need writing but the structure is right.
- **`merge`** — two or more existing pages cover the same flow or are too granular to be useful separately. Propose a default merge; the user confirms.
- **`split`** — one existing page covers multiple independent flows that would be clearer as separate pages.
- **`add`** — a flow or concept exists in the app but has no page yet.
- **`delete`** — an existing page covers a flow that doesn't exist in the app, or is a duplicate. Never delete without a clear reason.
- **`inferred`** — only use when neither app-notes nor direct observation backs the proposal. Flag it clearly.

For user guides specifically: the decision between keeping separate vs. merging follows the flow structure in the app. If a user can complete goal A without ever touching goal B, they are separate pages. If the flows share prerequisites, the same screen, or are always done together, propose a merge with a default recommendation.

## Step 3 — Flag open questions

List anything the plan cannot decide from available evidence:

- Flows that were not observed in the app and have no SME backing (mark as `inferred`)
- Pages where the merge/split decision is genuinely ambiguous — present both options with a default
- Anything that requires a human or SME decision before writing can start

## Step 4 — Write section-plan.md

Write the plan to `.sources/section-plan.md`. Use this structure:

```markdown
# Section plan — {section name}

**Status:** awaiting approval
**Based on:** {which sources were used}
**Verdict from readiness check:** {skeleton | needs-revision | greenfield}
**Sidebar order:** follows existing folder structure | deviates — see notes below

---

## Proposed page inventory

| # | Action | Slug | Type | Title | Rationale |
|---|---|---|---|---|---|
| 1 | keep | balance/balance.md | concept | Balance | Concept page first — users need context before acting |
| 2 | keep | view-account-balances/view-account-balances.md | user-guide | View account balances | Follows sidebar order |
| 3 | merge | add-cards + manage-cards → manage-cards/manage-cards.md | user-guide | Manage cards | Same screen, same flow |

The `#` column is the proposed sidebar order. If it differs from the current folder order, explain why in "Sidebar notes" below.

## Sidebar notes

Only present if the proposed order deviates from the existing folder structure. For each deviation: current position → proposed position, and the reason.

## Merge details

For each `merge` action: list which existing files are being merged and why.

## Split details

For each `split` action: describe what the two new pages would cover.

## Open questions (need your input before writing)

- {question} — proposed default: {yes/no answer}

## What happens next

Once you approve this plan (or make changes), run the writers:
- For each `concept` page: `concept-doc-writer`
- For each `user-guide` page: `user-guide-writer`
- For each `api` page: `api-doc-writer`
```

Do not create, rename, or delete any page files — write only `.sources/section-plan.md`.

## Step 5 — Self-review before finishing

1. Every existing page in the readiness report has an `action` (none silently dropped).
2. Every proposed slug is lowercase kebab-case; folder name and filename match.
3. Every user-guide title uses an imperative verb phrase; every concept title uses a noun phrase — verified against the loaded style-guide naming file.
4. The proposed page order follows the existing folder/sidebar order unless a deviation is explicitly noted with a reason.
5. No `delete` without a clear reason stated.
6. Every `merge` has a `mergesFrom` list.
7. Every `inferred` proposal is clearly flagged as such.
8. Open questions have a proposed default so the user can just say yes/no.
9. Only `.sources/section-plan.md` was written — no other files touched.

## Step 6 — Show the plan

After writing the file, show the proposed inventory table in the conversation so the user can review it without opening the file. Keep it tight — table only, plus the open questions. Say: "Approve this plan to start writing, or tell me what to change."

## Explicit invocation examples

- "section-planner: docs/balance"
- "use section-planner on the archive section"
- "run section-planner after app-explorer"
