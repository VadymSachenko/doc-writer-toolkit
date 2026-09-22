# Skills & Commands Index

Canonical enumeration of every skill and command in `doc-writer-toolkit`. Update this file whenever you add, rename, or remove a skill or command. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the update checklist.

## Skills (18)

All skills live in `plugins/doc-writer-toolkit/skills/<name>/SKILL.md`. They are picked up by directory convention — no manifest edit needed when adding one.

| Skill | Purpose | Typical invocation |
|---|---|---|
| `api-doc-writer` | Write an API reference page (one endpoint per page, English) | "use api-doc-writer to document POST /transaction/create" |
| `app-explorer` | Explore the live app via API seeding + Playwright, write `.sources/app-notes.{md,json}` | "app-explorer: explore docs/transactions" |
| `cleanup-unused-screenshots` | Move unreferenced screenshots from `.assets/` to `_unused/` (never deletes) | "cleanup-unused-screenshots: clean docs/transactions" |
| `concept-doc-writer` | Write a concept/background doc page (how something works, models, lifecycles) | "concept-doc-writer: write the Transaction statuses page" |
| `convert-sme-input` | Convert raw SME transcripts / notes into a structured `.sources/sme-interview.md` | "convert-sme-input: process the recording for docs/transactions" |
| `doc-alignment-checker` | Check structural alignment between a UA page and its EN counterpart (10 checks) | "/check-doc-alignment docs/transactions/transactions.md main:ua" |
| `doc-freshness-checker` | Diff an existing page against `app-notes.json`, report stale steps/labels/screenshots | "doc-freshness-checker: check docs/transactions/transactions.md" |
| `doc-from-interview` | Orchestrate the full per-page pipeline from SME video to style-reviewed draft | "/doc-from-interview docs/payment-methods/quasi type:concept" |
| `doc-style-fixer` | Apply `doc-style-reviewer` findings (mechanical/substantive/judgment buckets) | "/fix-doc-style docs/transactions/transactions.md" |
| `doc-style-reviewer` | Review a doc against a style corpus, produce a findings report (no edits) | "/review-doc-style docs/transactions/transactions.md guide:gdsg" |
| `doc-translator` | Translate an approved UA page to English at the project's EN i18n root | "/translate-doc transactions/transactions" |
| `document-section` | Orchestrate the full section pipeline with a resumable ledger and approval gate | "/document-section docs/transactions" |
| `extract-sme-screenshots` | Extract deduplicated screenshots + transcript from a video file | "extract-sme-screenshots: process docs/transactions" |
| `fix-doc-todos` | Scan for `{/* ToDo */}` / `{/* NEEDS CONFIRMATION */}` markers, resolve link-type ones | "/fix-doc-todos" |
| `resolve-markers` | Batch-resolve `{/* NEEDS CONFIRMATION */}` and screenshot `{/* ToDo */}` markers from app evidence | "resolve-markers: resolve docs/transactions" |
| `section-planner` | Propose IA structure (keep/merge/split/add) for a section, gated on human approval | "/plan-section docs/transactions" |
| `section-readiness` | Classify a section folder as skeleton/needs-revision/greenfield, write readiness JSON | "/check-section-readiness docs/transactions" |
| `user-guide-writer` | Write a task-based user guide page | "user-guide-writer: write the Filter transactions guide" |

## Commands (11)

All commands live in `plugins/doc-writer-toolkit/commands/<name>.md`. Picked up by directory convention.

| Command | Underlying skill(s) | Purpose |
|---|---|---|
| `/check-doc-alignment` | `doc-alignment-checker` | Check UA/EN structural alignment for a page |
| `/check-section-readiness` | `section-readiness` | Scan a section folder and emit a readiness JSON report |
| `/create-api-doc` | `api-doc-writer` | Generate an API reference page for a given slug |
| `/doc-from-interview` | `doc-from-interview` | Full per-page pipeline: video → screenshots → notes → draft → review |
| `/document-section` | `document-section` | Full section pipeline end-to-end with resumable progress ledger |
| `/explore-and-resolve` | `app-explorer` → `resolve-markers` | Explore app and auto-resolve all answerable markers |
| `/fix-doc-style` | `doc-style-fixer` | Apply style review findings to a page |
| `/fix-doc-todos` | `fix-doc-todos` | Resolve link-type `{/* ToDo */}` markers across the project |
| `/plan-section` | `section-planner` | Propose IA for a section (requires human approval before writing) |
| `/review-doc-style` | `doc-style-reviewer` | Review a page against a style corpus (read-only) |
| `/translate-doc` | `doc-translator` | Translate an approved UA page to English |
