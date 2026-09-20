# Skills and commands index

Canonical list of what the plugin ships. One line per skill; the invocation phrasing is what triggers it (all skills are explicit-invocation only). `WORKFLOW.md` at the repo root maps these to the writing process.

## Skills (15)

| Skill | What it does | Invoke with |
|---|---|---|
| `section-readiness` | Read-only scan of one section folder: pages classified stub vs complete, sources and screenshots inventoried, app access assessed; JSON report | "section-readiness: docs/transactions" |
| `app-explorer` | Explores the live app for a section (API-seeded scenarios, Playwright screenshots, observed behaviour) and writes `.sources/app-notes.md` | "app-explorer: explore docs/transactions" |
| `section-planner` | Proposes a page inventory for a section (keep / merge / split / add / delete) as `section-plan.md`, gated on approval | "section-planner: docs/balance" |
| `convert-sme-input` | Turns raw SME notes or transcripts into a structured `.sources/sme-interview.md` | "convert-sme-input: docs/routing/.sources/transcript.txt" |
| `extract-sme-screenshots` | Extracts deduplicated screenshots (and, if needed, an auto-transcribed transcript) from a recording in a page's `.sources/` | "extract-sme-screenshots for docs/routing" |
| `user-guide-writer` | Writes a procedural user guide page in the project's declared language (UA: Операції / Етапи structure) | "use user-guide-writer to document the Filter transactions page" |
| `concept-doc-writer` | Writes a concept topic (background, lifecycle, how-it-works) in the declared language | "use concept-doc-writer to explain routing" |
| `api-doc-writer` | Writes one API reference page per endpoint from an API brief | "use api-doc-writer to document Create payout transaction" |
| `doc-page-updater` | Applies a change brief to an existing approved page with the smallest edit; writes `update-report.md` for the scoped review and sync translation that follow | "doc-page-updater: page docs/currencies/currencies.md, brief …/change-brief.md" |
| `resolve-markers` | Resolves `{/* NEEDS CONFIRMATION */}` and `{/* ToDo */}` markers in a section from app-notes, SME notes, screenshots and the live app | "resolve-markers: docs/transactions" |
| `doc-style-reviewer` | Read-only style/grammar findings report under one guide profile (`gdsg`, `mssg-en`, `mssg-ua`, `ua-grammar`); scope mode reviews only changed blocks | "review-doc-style docs/balance/balance.md", "… --changed origin/main" |
| `doc-style-fixer` | Applies a reviewer report: mechanical fixes in batch, substantive rewrites with consent (or pre-approved via `apply:`), judgment calls asked | "fix-doc-style docs/balance/balance.md apply:mechanical,substantive" |
| `doc-translator` | Translates an approved UA page into EN at the declared i18n path; sync mode re-translates only changed blocks into an existing EN page | "translate-doc balance/balance", "… --sync --base origin/main" |
| `doc-alignment-checker` | Checks a UA page and its EN counterpart for structural alignment | "check-doc-alignment balance/balance" |
| `cleanup-unused-screenshots` | Moves candidate screenshots a page never referenced into `_unused/` (never deletes) | "cleanup-unused-screenshots for docs/routing" |

## Commands (11)

| Command | Underlying skill(s) |
|---|---|
| `/check-section-readiness` | `section-readiness` |
| `/plan-section` | `section-planner` |
| `/explore-and-resolve` | `app-explorer` → `resolve-markers` |
| `/doc-from-interview` | `convert-sme-input` → `user-guide-writer` (with verification and style review) |
| `/create-api-doc` | `api-doc-writer` |
| `/update-doc-page` | `doc-page-updater` |
| `/review-doc-style` | `doc-style-reviewer` |
| `/fix-doc-style` | `doc-style-fixer` |
| `/fix-doc-todos` | resolves link-type `{/* ToDo */}` markers across the project |
| `/translate-doc` | `doc-translator` |
| `/check-doc-alignment` | `doc-alignment-checker` |

Commands are thin wrappers: they bind arguments to paths and hand off to the skill's workflow. Shared procedures every skill points to instead of copying: `context/project-paths.md` (content roots, language), `context/style-guide-registry.md` (guide tokens and routed loading), `context/changed-blocks.md` (what "the changed part of a page" means).
