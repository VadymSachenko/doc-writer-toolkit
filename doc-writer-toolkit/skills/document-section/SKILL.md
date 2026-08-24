---
name: document-section
description: Orchestrates the full documentation pipeline for one section folder — readiness check, app exploration, IA planning, per-page drafting and style review, marker resolution, sidebar update, and cleanup. Stores progress in .sources/section-state.json and resumes on re-invoke. Hard approval gate before any page is written. Use explicitly ("/document-section", "document-section: run on docs/transactions").
---

# document-section

You are running the full documentation pipeline for one section folder. Every phase delegates to a skill that already knows its own job — you provide the sequencing, the ledger, and the approval gate. Do not re-implement any skill's logic here.

## Scope

- **In scope:** one section folder, end-to-end, from readiness check to completion report. Writes pages, updates the sidebar, resolves markers, and produces a resumable progress ledger.
- **Out of scope:** cross-section work; changes outside the declared section folder; running without a section folder argument; overriding the approval gate.

## Sources to load

1. The host project's `CLAUDE.md` — read the **Documentation toolkit configuration** block: `Style guide:`, `Content language:`, `UA content root:`, `EN i18n root:`, `Admin UI:`, `API test collection:`, `API collection runner:`, `Code reference repo:`, `Sidebar file:`.
2. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve content roots and URL prefix.
3. `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — resolve the style-guide token (passed to writers and reviewer).
4. `${CLAUDE_PLUGIN_ROOT}/context/section-state-schema.md` — ledger format (read before writing any ledger entry).
5. `.sources/section-state.json` in the section folder — read at the very start to distinguish a fresh run from a resume.
6. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/sidebar-conventions.md` — sidebar format and update procedure. Load before Phase 7.

Do not pre-load style-guide corpora or skill-specific rules.

## Ledger and resumability

At the start of every invoke:

1. Check if `.sources/section-state.json` exists in the section folder.
   - **Exists:** read it, then tell the user: "Resuming. Current phase: `<phase>`. Completed phases: `<list>`. Pages already clean: `<list>`. Continue?" If the user says no, offer to restart (which reinitializes the ledger — ask for confirmation before resetting).
   - **Does not exist:** fresh run. Initialize the ledger per `${CLAUDE_PLUGIN_ROOT}/context/section-state-schema.md` and write it before Phase 1.

2. After each phase completes, write the ledger: update `phase` to the next phase name, append the current phase name to `completedPhases`, and add a `runLog` entry.
3. After each page reaches `clean`, update that page's `status` in the ledger and write it.
4. Never rely on conversation memory for resumability — always read and write the ledger.

## Workflow

### Phase 1 — Section readiness

Skip if `readiness` is in `completedPhases`.

Invoke the **`section-readiness`** skill on the section folder. It writes `.sources/section-readiness.json`.

Extract the verdict: `skeleton` | `needs-revision` | `greenfield`. Record it in the ledger's `runLog`.

- `skeleton` or `needs-revision`: continue to Phase 2. For `needs-revision`, also run Phase 2b (freshness check) after Phase 2.
- `greenfield`: the section has no pages yet — note the greenfield flag in the ledger and continue to Phase 2. See **Greenfield path** at the end of this workflow.

### Phase 2 — App exploration

Skip if `explore` is in `completedPhases`.

If `Admin UI:` is `none` in the host project's `CLAUDE.md`, skip this phase: record `explore: skipped — no live UI declared` in the `runLog` and add `"explore"` to `completedPhases`. Writers and the planner will work from existing `.sources/` material.

Otherwise, invoke the **`app-explorer`** skill on the section folder. `app-explorer` handles its own credentials check, preflight, scenario seeding, screenshot capture, and writes `.sources/app-notes.{md,json}`. Do not duplicate those checks here — if `app-explorer` stops with a blocker, surface the blocker to the user and pause the run.

Record the outcome in the `runLog`.

### Phase 2b — Freshness check *(needs-revision verdict only)*

Skip if `freshness` is in `completedPhases`, or if the section verdict is not `needs-revision`.

For each existing page in the section, invoke **`doc-freshness-checker`** with that page and `.sources/app-notes.json`. It diffs the existing page content against the app evidence and reports stale steps, changed labels, and stale screenshots as structured findings per page.

Record each page's findings in the `runLog`. In Phase 5, a page that has freshness findings enters the write/review loop (with `status: drafting`) rather than being skipped — the writer ingests the findings as revision guidance alongside any `{/* NEEDS CONFIRMATION */}` markers already in the file.

### Phase 3 — Section planning

Skip if `plan` is in `completedPhases`.

Invoke the **`section-planner`** skill on the section folder. It reads `.sources/section-readiness.json` and `.sources/app-notes.json` (if present), proposes a page inventory (keep/merge/split/add/delete), and writes `.sources/section-plan.{md,json}`.

Once the plan is written, record it in the `runLog` and proceed to Phase 4.

### Phase 4 — Hard approval gate

Skip if `approval` is in `completedPhases`.

**This gate is mandatory and non-negotiable. Never write, rename, or delete any doc page before it is passed.**

Present the plan from `.sources/section-plan.md` to the user in full. If there are open SME questions from the greenfield path (`.sources/sme-questions.md`), show them alongside the plan. Then ask:

> "Does this plan look right? Reply **approve** to start writing, or describe any changes you want."

- **Approved:** set `planApproved: true` in the ledger, add `"approval"` to `completedPhases`, write the ledger, and continue to Phase 5.
- **Revision requested:** send the feedback back to `section-planner` for revision and re-present the updated plan. Repeat until the user approves. Do not auto-approve after a revision.

If the session is interrupted after `planApproved: true` is written to the ledger, the approval survives the resume — do not re-ask.

### Phase 5 — Per-page write, review, fix

For each page in the approved plan (`pages[]` in the ledger), in order:

1. **Skip** pages already `clean` in the ledger.
2. **Pick the writer skill** by `docType`:
   - `concept` → `concept-doc-writer`
   - `user-guide` → `user-guide-writer`
   - `api` → `api-doc-writer`
3. **Invoke the writer in `orchestrated` mode.** In this mode, the writer drafts with best-guess resolutions, flags every assumption with `{/* NEEDS CONFIRMATION: ... */}`, and emits a batched assumptions list — it does not stop to interview the user. See **Orchestrated mode** in `authoring-common.md`.
4. **Invoke `doc-style-fixer`** with `auto:mechanical`. Bucket 1 fixes apply without prompting; Buckets 2 and 3 are deferred to `{/* NEEDS CONFIRMATION */}` markers or `pending[]`.
5. **Invoke `doc-style-reviewer`** with `format:json`. Capture the JSON report.
6. If the JSON report shows Errors or Style Deviations (excluding deferred Bucket 2/3 pending items): increment `reviewIterations` in the ledger and repeat from step 4. **Cap at 3 iterations.** After the cap, mark the page `blocked` in the ledger, record the unresolved finding count in the `runLog`, and move on to the next page.
7. When the JSON report shows zero Errors and zero Style Deviations: set `status: clean` in the ledger for this page.

Write the ledger after every page — not just at phase end.

**Parallel processing:** pages without cross-page dependencies can run concurrently — max 3 pages at a time. A page whose draft will reference another planned page (e.g., an internal link to a page not yet `clean`) waits until that dependency reaches `clean` before starting. Derive the dependency graph from the approved plan's `sidebarOrder` and any cross-reference links declared by the planner. If a page is blocked on a dependency that itself is `blocked`, mark it `blocked` with reason `dependency-blocked` and continue with remaining pages.

**Token discipline:** no broad repository reads; no bulk screenshot opens; summarize each phase's output in 2–3 lines rather than echoing it. Write intermediate results to files.

### Phase 6 — Resolve markers

Skip if `resolve` is in `completedPhases`.

Invoke the **`resolve-markers`** skill on the section folder. It reads `app-notes.json` and resolves every `{/* NEEDS CONFIRMATION */}` and `{/* ToDo: add a screenshot */}` marker it can answer. Markers it cannot resolve remain in the files.

After `resolve-markers` completes:
- Count total resolved and deferred markers per page; update `pages[].resolvedMarkers` and `pages[].deferredMarkers`.
- Collect all remaining unresolved `{/* NEEDS CONFIRMATION */}` markers from the entire section and write them to `.sources/sme-questions.md`, one line per question with its file and line number.
- Update `totals.resolvedMarkers`, `totals.deferredMarkers`, `totals.openSmeQuestions` in the ledger.

### Phase 7 — Sidebar and cleanup

Skip if `sidebar` is in `completedPhases`.

1. **Sidebar:** read `sidebarOrder` from `.sources/section-plan.json`. Update the sidebar file declared in `CLAUDE.md` (`Sidebar file:`, defaulting to `sidebars.ts`) following the format and rules in `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/sidebar-conventions.md` — insert or reorder entries only for pages in this section. Do not touch entries for other sections. If `Sidebar file:` is not declared, ask the user where the sidebar file is and offer to add the declaration to `CLAUDE.md`.

2. **Cleanup:** invoke the **`cleanup-unused-screenshots`** skill on the section folder. It identifies screenshots no longer referenced by any page and moves them to `_unused/` (never deletes).

Update `totals.screenshotManifest` in the ledger.

### Phase 8 — Completion report

Write `phase: complete` and the final `runLog` entry to the ledger.

Report:

- Section folder and readiness verdict.
- Pages written or revised (list with final `status` and `reviewIterations`).
- Pages `blocked` and why (unresolved finding count or dependency-blocked reason).
- Total markers resolved vs. deferred.
- Open SME questions (link to `.sources/sme-questions.md`; list up to 10 in the report).
- Screenshots placed vs. moved to `_unused/`.
- Sidebar changes made (entries added or reordered).
- Phases skipped and the reason for each.

State plainly what was **not** completed. A phase skipped or a page blocked is more useful reported than omitted. For greenfield sections, note which pages were written from full evidence vs. which have `{/* NEEDS CONFIRMATION */}` markers flagging gaps.

## Greenfield path

When `section-readiness` returns `greenfield`, the section has no existing pages. After app exploration (Phase 2) — or if `Admin UI: none` caused Phase 2 to be skipped — the planner may still lack information for some planned pages (terminology, business rules, exact API behavior not visible in the UI).

For topics still unclear after app notes:

1. Read `Code reference repo:` from the host project's `CLAUDE.md`. If declared, run a **targeted cross-repo term search**: grep for the single symbol or constant name across the declared repo. Read only the matching lines — never walk directory trees or open whole packages. Each search answers one specific unknown; stop when the unknown is resolved.
2. Collect every remaining unresolved term or concept into `.sources/sme-questions.md` (one question per line with context). Write this file before Phase 4 so the planner can flag which pages depend on unanswered questions.
3. At the approval gate (Phase 4), show the planner's best-effort plan alongside the open SME questions. The user can approve the plan and let writers draft with `{/* NEEDS CONFIRMATION */}` markers, or defer specific pages until SME answers are in.
4. After a greenfield run, the completion report notes which pages were fully evidenced vs. which have gaps. A partial-completion report is the expected outcome for a first-run greenfield section — finish gracefully.

## Stop conditions

Stop and ask when:

- The section folder does not exist, or has no `.sources/` directory;
- `planApproved` would be bypassed — the approval gate is never optional;
- `app-explorer` stops with a credentials or tool-availability blocker;
- any phase produces an error that prevents the next phase from running;
- the user asks to restart — confirm before reinitializing the ledger.

## Explicit invocation examples

This skill triggers only when named explicitly or via the `/document-section` command.

- "/document-section docs/transactions"
- "document-section: run on docs/balance"
- "Use document-section on the partner-cabinet/webhooks section"
- "/document-section docs/transactions" (re-invoke after interruption — resumes from the ledger)
