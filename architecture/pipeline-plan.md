# Section Documentation Pipeline — Plan & Task Breakdown

**Status:** planning · **Date:** 2026-08-02 · **First test target:** transactions section
**Build order:** Option 1 + spike (plan-first, inside-out, with an early exploration spike to de-risk)

---

## 1. What we're actually building

Not a from-scratch pipeline. The toolkit map revealed that **`/doc-from-interview` is already an 8-phase orchestrator** (config → screenshots → source-note → code-enrich → live-screenshots → draft → style-review → report). It is single-page and single-video.

**v1 = generalize that orchestrator to section level, and fill the two genuine gaps:**

| Gap | New unit | Why it doesn't exist today |
|---|---|---|
| Nothing decides a section's page inventory or validates structure | **`section-planner`** skill | Atomic unit everywhere today is one page |
| Nothing drives the live app to discover flows/labels/state | **`app-explorer`** skill | `doc-from-interview` Phase 4 only *mentions* Playwright screenshots; no navigation/enumeration/scenario-seeding exists |
| No orchestrator loops across a section or resumes | **`document-section`** skill + **state file** | `doc-from-interview` is single-page, stateless |

Everything else (writers, style reviewer/fixer, screenshot cleanup) is **reused as-is**, invoked as sub-steps.

---

## 2. Confirmed decisions (from interview)

- **Trigger:** point at an existing folder (structure already exists in current projects). Future: AI proposes structure from scratch.
- **Section unit:** one app menu area → many docs (1 concept + N user guides + optional API pages).
- **Doc type:** auto-decide per file; human confirms at the plan gate.
- **Language:** follow project's declared content language. Main project = UA-first, EN translated only after SME approves UA. Other project = EN-only. **Translation/alignment are NOT in v1's definition of done.**
- **App exploration:** Postman test-env collection seeds scenarios (transactions, disputes) via API; Playwright explores UI and captures screenshots; app code is secondary; **UI is the primary source and the live app is ground truth.**
- **Structure planning:** read existing folder + `.sources/`, cross-check against app UI, propose additions/merges/splits. Workflow split/merge = propose a default, ask human to confirm.
- **Plan gate:** HARD gate — orchestrator stops after proposing structure + per-file type + screenshot list, waits for approval before writing anything.
- **Style enforcement:** auto-run reviewer + fixer inside the pipeline; apply mechanical + substantive automatically; report judgment-required findings.
- **Missing info:** drop `{/* NEEDS CONFIRMATION: ... */}` marker and list it in the report — don't guess, don't pause.
- **Orchestration:** single orchestrator skill + resumable state file.
- **Definition of done:** all planned files drafted + style-reviewed + screenshots placed + self-review passed; markers resolved or reported; completion report produced.

---

## 3. Target pipeline (section level)

```
/document-section <folder>
  │
  ├─ P0  Config resolution        reuse doc-from-interview Phase 0 (host CLAUDE.md, ask-once/persist)
  ├─ P1  Section readiness        NEW: read folder + .sources/, classify each file (missing/stub/complete),
  │                                    detect app access (Postman? Playwright installed?), emit JSON
  ├─ P2  App exploration          NEW app-explorer: seed scenarios via Postman, drive Playwright,
  │                                    enumerate screens/flows/labels/states → .sources/app-notes.md + screenshots
  ├─ P3  Structure plan  ◀━ GATE   NEW section-planner: existing folder + app-notes → proposed page inventory
  │                                    (per-file type, keep/merge/split w/ defaults, screenshot list) → section-plan.md
  │                                    ══ HARD APPROVAL GATE: human confirms before any writing ══
  ├─ P4  Per-page loop            for each planned page (resumable via state file):
  │        ├─ draft   → route to concept-doc-writer | user-guide-writer | api-doc-writer
  │        ├─ review  → doc-style-reviewer (auto)
  │        ├─ fix     → doc-style-fixer (mechanical+substantive auto; judgment → marker+report)
  │        └─ mark page status in state file
  ├─ P5  Screenshot cleanup       reuse cleanup-unused-screenshots (once per section)
  └─ P6  Completion report        files created/changed, per-page status, unresolved markers, judgment calls, skipped phases
```

**State file:** `.sources/section-state.json` — records phase, approved plan, per-page status (`planned|drafted|reviewed|done|blocked`), decisions, unresolved markers. Re-running resumes from the last incomplete step instead of restarting.

---

## 4. Task breakdown (build order: Option 1 + spike)

Tasks are ordered so each produces a testable artifact. **T-numbers are stable IDs.**

### Milestone A — Plan-first core (cheapest, pure reading, immediately useful)

- **T1 — `section-readiness` capability (P1). ✅ DONE (2026-08-02).**
  Skill at `skills/section-readiness/SKILL.md` + command `commands/check-section-readiness.md`. Read-only diagnostic: resolves paths via `project-paths.md`, classifies every existing page as `stub`/`complete` (with reason, marker count, docType hint), inventories `.sources`/`.assets`/screenshots, and assesses app-access. **Output: `.sources/section-readiness.json`** (machine-consumable — fixes the "reports are Markdown only" gap).
  **Design decisions made:**
  - Readiness reports *only what exists* — it never emits `missing`. Deciding the expected inventory (and thus gaps) needs a proposed structure, which is `section-planner`'s job (T2). Clean seam: **readiness reports facts, planner decides gaps.**
  - Introduced a new optional host-config field **`API test collection:`** (path to Postman/newman collection, or `none`). Reported as `not-declared` when absent — never asked/persisted by this skill.
  *Test (for you on Mac):* run `/check-section-readiness docs/transactions`; verify every page is listed with a sane state, screenshot counts match, and app-access verdict is correct.

- **T2 — `section-planner` skill (P3), plan artifact only (no gate wiring yet).**
  Reads existing folder + readiness report (+ `app-notes.md` when available), proposes the page inventory: per-file doc type (concept/user-guide/api), keep/merge/split decisions with a **proposed default** for each, and a per-page screenshot list. **Output: `.sources/section-plan.md`** (human-readable) + a JSON mirror for the orchestrator.
  *Test:* run on transactions; confirm the proposed structure matches your mental model; confirm split/merge defaults are sane.

- **T3 — State file schema + resume logic.**
  Define `.sources/section-state.json` schema and the read/resume/write procedure. Orchestrator reads it at start, resumes from last incomplete step.
  *Test:* write a partial state by hand, confirm resume skips completed steps.

- **T4 — `document-section` orchestrator skill, skeleton with HARD plan gate.**
  Wire P0 (reuse) → P1 (T1) → P3 (T2) → **GATE** → P4 (calls existing writers) → P5 (reuse) → P6. App exploration (P2) stubbed for now (uses existing `.sources`/screenshots if present).
  *Test:* end-to-end on transactions using only existing sources; confirm the gate stops correctly and per-page loop drives the right writer per file type.

### Milestone B — Exploration spike (de-risk the biggest unknown early)

- **T5 — Playwright spike.**
  Prove we can drive Playwright to open the app, navigate to the transactions screen, and capture one screenshot into `.assets/`. Document the Windows-specific setup (note the venv `Scripts/python.exe` vs `bin/python` mismatch flagged in the map).
  *Test:* one real screenshot of a real screen lands in the right folder.

- **T6 — Postman spike.**
  Prove we can trigger one test-env scenario (e.g. add a transaction to the operator queue) via the Postman collection, then observe the resulting UI state.
  *Test:* API call changes state; Playwright captures the changed screen.

### Milestone C — Full exploration + wire into pipeline

- **T7 — `app-explorer` skill (P2), full.**
  Given a section + scenario list, seed state via Postman, drive Playwright to enumerate screens/flows/labels/states (empty, success, error, permission variants), capture labeled screenshots, and write **`.sources/app-notes.md`** as structured evidence. Screens the primary source; live app is ground truth.
  *Test:* full app-notes for transactions; screenshots cover the key states; labels match the live UI.

- **T8 — Wire P2 into orchestrator + feed app-notes into section-planner and writers.**
  Replace the P2 stub with `app-explorer`; make `section-planner` cross-check structure against `app-notes.md`; ensure writers consume the captured screenshots.
  *Test:* full run on transactions from folder → ready-to-publish drafts with real screenshots.

- **T7b — Cross-repo targeted search (for greenfield sections).**
  For a section with little/no existing material (e.g. `balance`), the tool must consult sibling repos (API, dev, client) that sit next to the toolkit. **Hard cost rule: never read those repos file-by-file** — search for one named term at a time and read only the matching lines. This is a capability `app-explorer` / `section-planner` call when a section is `greenfield` and the app + local sources don't answer the questions.
  *Test:* on `balance`, confirm it finds relevant facts via targeted search without a broad directory walk.

- **T7c — SME-interview-as-output (graceful finish when questions remain).**
  After checking app + existing docs + repos, if questions still can't be answered, the tool writes a **questions-for-the-SME** document (`.sources/sme-questions.md`) instead of stalling or guessing. A run can finish with "draft plan + here are the N things only a human can answer." This flips the current model where SME material is only an *input*.
  *Test:* on a section with a genuine unknown, confirm a clean questions doc is produced and the run still completes.

### Milestone D — Hardening

- **T9 — Auto style pass integration.**
  Confirm reviewer+fixer run inside P4: mechanical+substantive auto-applied, judgment findings converted to markers + surfaced in the report.
- **T10 — Definition-of-done gate + completion report.**
  Machine check: all planned pages drafted+reviewed+screenshots, markers resolved-or-listed. Report enumerates everything, including deviations logged (project rules vs toolkit defaults).
- **T11 — Failure-mode guards.** Windows venv paths, D-5 `--transcript` re-pass, routed-loading mis-map guard, cleanup basename-matching + copy-not-move check.

---

## 4b. Conclusions from the 3-section test design (2026-08-02)

Testing against three real sections (blank skeleton, near-complete drafts, empty `balance` folder) revealed these are not just tests — they're the **three starting states** the tool will always face. Design consequences:

1. **Three starting states, one verdict.** Every section is `skeleton` (structure exists, may be wrong), `needs-revision` (drafts exist, need fixing), or `greenfield` (nothing to go on). T1 now emits this `verdict` up front so the caller knows which path it's on. Later phases branch on it.

2. **App UI is the backbone — 2 of 3 states can't move without it.** Structure is decided from *app flows*, not from videos or existing files. So `skeleton` and `greenfield` sections get little value from T1 alone; their real answer is P2 (app exploration). **This raises P2's priority** — it's not an enhancement, it's the unblock for most real cases.

3. **Video and app UI feed different docs.** Video/transcript explains *how things work / logic* → feeds **concept (overview) pages**. App exploration shows *actual screens/steps* → feeds **how-to guides**. Routing rule for the writing step: don't write a how-to from a video, don't explain logic purely from screenshots. A section can be documented from app UI alone (no video needed) as long as Playwright can reach the app.

4. **Greenfield needs cheap cross-repo search** → new task **T7b**. Reading sibling repos file-by-file is forbidden (too expensive); targeted term search only.

5. **SME interview is an output, not just an input** → new task **T7c**. If questions remain after all sources are checked, write a questions-for-SME doc and finish gracefully instead of stalling.

**What to expect from the 3 test runs of T1 (Step 1 only):**
- *Drafts section* → useful report; watch the finished/empty labels and marker counts. Verdict: `needs-revision`.
- *Skeleton section* → correct but thin ("N empty pages"); won't judge whether the structure is wrong (needs the app). Verdict: `skeleton`.
- *`balance` (greenfield)* → nearly empty report ("no pages, no sources, app reachable"). Correct but underwhelming — real value needs P2. Verdict: `greenfield`.

---

## 5. Risks the interview surfaced (watch these)

1. **Exploration is the real unknown** — T5/T6 spike exists to fail fast if Playwright/Postman automation hits a wall. Do not build T7 before the spike passes.
2. **Windows environment mismatch** — venv path, ffmpeg/tesseract for the SME script are all documented for macOS/POSIX; the host is win32.
3. **HARD gate discipline** — the orchestrator must never write before plan approval; this is the control you asked for.
4. **Markdown-only reports** — new units (T1, T2) emit JSON so the orchestrator can branch deterministically instead of parsing prose.
5. **Reused writers still have mandatory interviews** — inside an automated loop, either pre-satisfy their inputs from `app-notes.md` or let them drop NEEDS CONFIRMATION markers rather than blocking. Decide per writer during T4/T8.
6. **Deviation logging** (from architecture notes) — project rules/glossary win over toolkit defaults; the report must log where they diverged.

---

## 6. Open items to resolve before/while building

- **Where does app-explorer live** relative to the existing SME video skills — sibling skill, or does it partly reuse `extract-sme-screenshots`' screenshot-indexing? (Decide at T7.)
- **How writers' mandatory interviews behave unattended** — pre-satisfy vs marker-and-continue. (Decide at T4.)
- **`fix-doc-todos` refactor** — today it's business logic in a command (anti-pattern); to call marker resolution from the orchestrator cleanly it may need extracting into a skill. (Optional, post-v1.)
- **Postman invocation mechanism** — CLI (newman) vs an MCP server vs direct HTTP from the collection. (Decide at T6.)

---

## Appendix — Current toolkit file-by-file map

See the full synthesis captured 2026-08-02 (10 skills, 7 commands, shared contracts, 359 files). Stored in session; key points mirrored in the `toolkit-map` memory. Regenerate with the `map-toolkit` workflow if the toolkit changes substantially.
