---
name: document-section
description: 'Takes one documentation section folder to UA pages reviewed and approved, and EN pages translated and aligned. Chains the existing skills: section-readiness, app-explorer, section-planner, the writer for each page, resolve-markers, doc-style-fixer, doc-style-reviewer, doc-translator and doc-alignment-checker. Keeps a ledger in .sources/section-state.json through the section-state script, resumes where a run stopped, and stops only at the approval gates; the plan is never pre-approved. Never commits, deletes or moves a page, and never edits the sidebar. Explicit invocation only: use explicitly ("/document-section docs/reports", "use document-section on portal/settings").'
---

# document-section

You are running one section folder through the whole documentation chain. Every stage is a skill that already knows its job: you run them in order, keep the ledger, and stop at the gates. Do not re-implement any skill's logic here, and never answer a skill's questions for the user.

## Scope

- **In scope:** one section folder, from the readiness check to UA pages the user approved and EN pages translated and aligned. Running the stages of "The chain" in `${CLAUDE_PLUGIN_ROOT}/context/section-state.md`, recording each result in the ledger, resuming from it, the approval gates, and the final report.
- **Out of scope:**
  - Writing, fixing, reviewing, translating or checking a page yourself. Each stage's skill does it.
  - Further locales (`locale-translator`, `/translate-locales`). The final report suggests it.
  - A recording in `.sources/` (`/doc-from-interview`), and unused frames (`cleanup-unused-screenshots`). The final report suggests the cleanup when a page has a frames folder.
  - A `keep` page the readiness report calls `complete`. It is listed, not edited. Updating an approved page from a change brief is `doc-page-updater`'s job.
  - The sidebar. The writers treat it as auto-generated (`user-guide-writer` Step 9).
  - Commits, pushes, and deleting or moving a page. The user commits; merged-away, split and deleted pages are listed for the user.
  - More than one section per run, and a driver for `app-explorer`.

## Arguments

- `<section folder>` — required: from the repo root (`docs/reports`), or `<pair>:<folder>`.
- `interview:skip` — optional, and only when the user passes it. Passes on the writers' own rule: when the user says "skip questions", the writer drafts with its best guess and marks every assumption `{/* NEEDS CONFIRMATION */}` (`user-guide-writer` Step 5). It covers the interview only: a writer that finds its inputs insufficient still stops.
- `apply:mechanical` (default) or `apply:mechanical,substantive` — passed to `doc-style-fixer` as its `apply:`. Without `substantive`, bucket 2 goes through the fixer's own interactive flow.
- `approve:<id,…|all>` — optional: UA approval given in advance, for pages that were at gate G5 when this invoke started.
- `page:<id>` — optional: narrows the page stages to one page. Section stages still cover the section.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — the section folder's root pair: its UA content root, its EN i18n root, and its id when the host declares more than one pair.
2. `${CLAUDE_PLUGIN_ROOT}/context/section-state.md` — the chain, the ledger, when a stage is done or stale, and the gates.
3. The ledger, only through the script's `status` (below). Never read or edit `section-state.json` by hand.

Read `${CLAUDE_PLUGIN_ROOT}/scripts/section-state/README.md` only when an output field or a refusal is unclear. Nothing else: each stage's skill loads its own sources. Do not load style corpora, templates or glossaries.

## The ledger

Run the script from the repo root:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/section-state/section-state.mjs status <section> [--md]
node ${CLAUDE_PLUGIN_ROOT}/scripts/section-state/section-state.mjs record <section> --stage <stage> --status running|done|skipped|failed [--page <id>]… [--note "<reason>"] [--result '<json>']
```

- Record `running` before a stage starts, and `done`, `skipped` or `failed` right after it ends. The run never relies on conversation memory.
- The first record of a fresh run creates the ledger: pass `--ua-root`, `--en-root` (and `--pair`) from Step 0. The first record of every invoke passes `--options '{"interview":"ask|skip","apply":"…"}'`.
- A refused record (exit 1) means the files don't support it. Say why, and don't work around it. Exit 2 is a usage problem: fix the call.
- The script works out what is stale, what runs next and which gate is open. Follow its `next` and `gate`; don't decide them yourself.
- Summarize each stage in a line or two. Don't echo a skill's report.

## Workflow

### Step 0 — Resolve the section and read the state

1. No folder given → ask which, and stop. Resolve its root pair via `project-paths.md`. The folder doesn't exist → stop and say so.
2. Run `status <section> --md` and show the block. No ledger → a fresh run, and Step 1 creates it.
3. Continue without asking, unless `gate` is set (Steps 4, 5, 9, 10) or an approval went stale: a plan or a page changed after the user approved it. Say which before going on.
4. `blocked` is not empty → retry those pages first, at their blocked stage. Recording that stage `running` clears the block; a page that fails again is blocked again, and the run goes on.
5. Run the stage `next` names, for the pages it lists (only `page:` if passed), then `status` again. Repeat until a gate stops the run or `next.stage` is `null`.

### Step 1 — Readiness

Run `section-readiness` on the folder. Record `readiness` done. It stops (the folder is missing or unreadable) → record it failed with the reason, and stop.

### Step 2 — Explore

The readiness report's `appAccess.liveUI` is `none` → record `explore` skipped, with the note `liveUI: none`. Otherwise run `app-explorer`. It keeps its own preflight (its Step 0); don't repeat or bypass it. It stops on a blocker → record it failed with the blocker, stop, and say what to fix.

### Step 3 — Plan

Run `section-planner` on the folder. It writes `section-plan.md` and `section-plan.json`, and shows the table. Record `plan` done. The record is refused because the JSON doesn't validate → give the script's error to the planner once. Refused again → record it failed, and stop.

### Step 4 — Gate G1: the plan

The planner has shown the inventory and its open questions. Add what the plan means for this run: the pages that will be written, and the pages only listed (merged away, split, deleted, `keep` on a complete page). Then end the turn and wait. A reply in the same session continues the run; a later invoke shows the gate again.

- **Approved** → record `planApproval` done. The script takes the pages from `section-plan.json` and lists the rest. An answer to an open question that changes the plan goes to the planner first; record `plan` done and show the gate again.
- **Changes asked** → give them to `section-planner` as revision feedback, record `plan` done, and show the gate again.
- **Never pre-approvable.** No argument, and no wording in the request that started the run, approves the plan: only a reply to this gate does. `section-planner` writes nothing until the user confirms (its Step 6).
- The gate comes back when a plan file changed after approval. Show the changed plan. After the new approval, the record names the pages no longer in it (`dropped`); nothing written is touched.

### Step 5 — Write (each page, in plan order)

1. Pick the writer by `docType`: `concept` → `concept-doc-writer`, `user-guide` → `user-guide-writer`, `api` → `api-doc-writer`. Record `write` running for the page.
2. Give the writer the page's folder and title from the plan, and its inputs: for a `merge`, the pages in `from` as extra input; for a `split`, the old page in `from`, with one writer run per new page. Pass `interview:skip` on only if the user passed it.
3. **Gate G3** (`gate.name` is `unknownDraft`): the page is on disk, but the ledger doesn't know it. An interrupted run, or someone else, saved it. Show its path and ask: keep this draft (record `write` done), or draft again (the writer overwrites it). Ask each time.
4. **Gate G2** is the writer's own interview. Let it ask, and wait for the user. Never answer its questions from what earlier stages found: the user makes those calls.
5. The writer stops because its inputs are insufficient ("When inputs are insufficient", or no API brief for an `api` page) → record `write` failed with the gaps it named, and go on with the next page.
6. Saved → record `write` done with `--result '{"skill":"<writer>","interview":"asked N|skipped|not needed"}'`. Saved at another path than the plan's → add `--saved-as <path>`, and report the difference. Never rename.

The UI label check runs inside each writer (`ui-labels.md`), so nothing extra is needed here.

### Step 6 — Resolve markers (section)

Run `resolve-markers` on the folder once every page is written. It edits pages in place. Record `resolve` done. No page has a marker → record it skipped with that note.

### Step 7 — Fix (each page)

Run `doc-style-fixer <page> apply:mechanical` (or the `apply:` the user passed). It runs `doc-style-reviewer` itself when no report is in context (its Step 1).

- **Gate G4:** bucket 2, unless `substantive` was passed. The fixer asks, and the user answers.
- Bucket 3 is listed, never applied. Keep it for G5.

Record `fix` done with `--result '{"applied":N,"left":N}'`.

### Step 8 — Review (each page)

Run `doc-style-reviewer <page>` on the whole page. Take the counts from its `Summary:` line, and record `review` done with `--result '{"errors":E,"deviations":D,"suggestions":S,"round":R}'`.

- Errors or deviations after round 1 → Step 7 again for that page (the fixer works from this report), then review round 2.
- **At most 2 rounds.** What is left after round 2 doesn't block the page: it goes to G5 as open findings.

### Step 9 — Gate G5: UA approval

Once for all pages at the gate (`gate.name` is `uaApproval`). Per page, show the path, the review counts and round, the open `{/* ToDo */}` and `{/* NEEDS CONFIRMATION */}` markers (a grep), and the fixer's unapplied findings. Ask which pages are approved. End the turn and wait.

- The reply approves pages → record `uaApproval` done with a `--page` for each. A refused record names a page that changed after its review: it goes back to Step 7.
- `approve:` passed → it stands for the reply, only for pages that were at G5 in Step 0's status. Never for a page drafted, fixed or reviewed in this invoke.
- A page the user wants changed stays at the gate. The user edits it, or runs `doc-page-updater`. The next invoke sees the new hash and runs its fix and review again.

### Step 10 — Translate (each approved page)

1. **Commit first** (`gate.name` is `commit`). List the pages in `next.uncommitted` and ask the user to commit them, then end the turn. Never commit yourself. `doc-translator --sync` reads a git diff, so it sees committed UA only (`changed-blocks.md`).
2. Record `translate` running, then run `doc-translator <id>` (`<pair>:<id>` when the ledger has a `pair`):
   - the EN page exists (`enExists`) → `--sync --base <baseCommit>`. It asks nothing, and runs the alignment check itself (its sync step 6);
   - no EN page → a full translation.
3. Record `translate` done. The script accepts the translator's `last_update.date` change in the UA page. Refused because the UA page changed beyond the date → back to Step 7 for that page.
4. Sync reports unmapped blocks → record `translate` failed with them, and go on.

### Step 11 — Align (each translated page)

After a sync, use the alignment result the translator reported. After a full translation, run `doc-alignment-checker <id> main:ua`. Record `align` done with `--result '{"bugs":B,"warnings":W}'`. Any bug → record `align` failed with the count instead: the page is blocked, and the run goes on.

An EN page edited by hand (`enHandEdited`) only has its alignment checked again. Never translate over it without the user's word.

### Step 12 — Self-review before each record and the final report

1. Every record says what its skill did: no `done` for a stage that stopped, asked, or failed.
2. No plan approval and no UA approval was recorded without the user's reply to that gate, or `approve:` for a page already at G5.
3. No page was written outside the approved plan, renamed, moved or deleted. No sidebar file, `docusaurus.config` or commit was touched.
4. No writer or fixer question was answered for the user.
5. The final `status` agrees with the report.

### Step 13 — Final report

- The section, its readiness verdict, and the root pair.
- Per page: the path, the action, the stages done, the review counts and rounds, and the open markers.
- Blocked pages with their stage and reason, and skipped stages with theirs.
- The pages listed for the user: merged away, split, deleted, `keep` on a complete page, and pages outside the run.
- What was not completed, stated plainly. A blocked page or a skipped stage is more useful reported than left out.
- Next steps: commit the pages and the ledger (it is meant to be committed); `/translate-locales <folder>` for the further locales once EN is aligned; `cleanup-unused-screenshots` for each page with a `.sources/frames/` folder.

## Explicit invocation examples

This skill triggers only when named explicitly, or through `/document-section`.

- "/document-section docs/reports"
- "/document-section portal/settings interview:skip apply:mechanical,substantive"
- "use document-section on docs/reports" (again after a stop: it resumes from the ledger)
- "/document-section docs/reports approve:all"
