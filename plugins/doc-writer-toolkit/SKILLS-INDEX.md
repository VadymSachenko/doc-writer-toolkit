# Skills and commands index

Canonical list of what the plugin ships. One line per skill; the invocation phrasing is what triggers it (all skills are explicit-invocation only). `WORKFLOW.md` at the repo root maps these to the writing process.

## Skills (17)

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
| `locale-translator` | Translates the approved UA pages into every further locale the site declares (not EN), only where UA changed and block by block: label check first, UI labels from the app's dictionaries, per-locale term memory, one worker per locale, scripted checks, build and a per-page report. Never commits | "/translate-locales", "locale-translator: translate the settings section into kk only" |
| `doc-alignment-checker` | Checks a UA page and its EN counterpart for structural alignment | "check-doc-alignment balance/balance" |
| `cleanup-unused-screenshots` | Moves candidate screenshots a page never referenced into `_unused/` (never deletes) | "cleanup-unused-screenshots for docs/routing" |
| `identify-ui-icon` | Finds the picture for an icon-only control in the project's `Icon rendering:` form: an Iconify id (evidence first, then the Iconify API), its SVG, or a screenshot crop; falls back to a crop or a marker, never guesses an id and never names the control. The writers call it by name | "identify-ui-icon: the trash button in docs/payments/.assets/payments-page.png" |

## Commands (13)

| Command | Underlying skill(s) |
|---|---|
| `/check-section-readiness` | `section-readiness` |
| `/plan-section` | `section-planner` |
| `/explore-and-resolve` | `app-explorer` → `resolve-markers` |
| `/doc-from-interview` | `extract-sme-screenshots` → `convert-sme-input` → the writer chosen by `type:` (`concept-doc-writer`, `user-guide-writer` or `api-doc-writer`) → `doc-style-reviewer` → `doc-style-fixer`, with optional code verification and live UI screenshots |
| `/create-api-doc` | `api-doc-writer` |
| `/update-doc-page` | `doc-page-updater` |
| `/review-doc-style` | `doc-style-reviewer` |
| `/fix-doc-style` | `doc-style-fixer` |
| `/fix-doc-todos` | its own steps resolve link-type `{/* ToDo */}` markers across the project, then `doc-alignment-checker` checks each changed page |
| `/translate-doc` | `doc-translator` |
| `/check-doc-alignment` | `doc-alignment-checker` |
| `/translate-locales` | `locale-translator` |
| `/identify-icon` | `identify-ui-icon` |

Commands are thin wrappers: they bind arguments to paths and hand off to the skill's workflow. Shared procedures every skill points to instead of copying: `context/project-paths.md` (content roots, language), `context/style-guide-registry.md` (guide tokens and routed loading), `context/changed-blocks.md` (what "the changed part of a page" means), `context/ui-labels.md` (the UI label check at the start of a docs task), `context/locale-translation.md` (rules for translating into the further locales), `context/doc-rules/project-rules/screenshot-locales.md` (which locales a screenshot is captured in, and when a new set replaces the old one). The scripts the locale pipeline runs, `scripts/ui-labels/` and `scripts/locale-sync/`, the one `doc-alignment-checker` runs, `scripts/doc-align/`, and the one the screenshot captures run, `scripts/screenshot-locales/`, each have a README.
