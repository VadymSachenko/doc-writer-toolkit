---
description: Explore the live app for a section and automatically resolve all NEEDS CONFIRMATION and ToDo markers in its doc pages. Runs app-explorer then resolve-markers in sequence. No manual answering needed — evidence from the app is applied directly.
argument-hint: "<section-folder>"
---

Run the explore-and-resolve flow for one documentation section.

- **Arguments:** $ARGUMENTS
- Parse the argument as the **section folder** (e.g. `docs/transactions`).

1. Run **`app-explorer`** on the section. Strictly follow its workflow — it handles credentials, environment checks, scenario seeding, screenshot capture, and writes `.sources/app-notes.md`.
2. Run **`resolve-markers`** on the section. Strictly follow its workflow — it reads `app-notes.md` and resolves every `{/* NEEDS CONFIRMATION */}` and `{/* ToDo: add a screenshot */}` marker it can answer from the evidence.

After both skills complete, report:
- How many markers were resolved automatically
- How many screenshots were placed
- What remains open (listed by file and marker text)
- Remind the user: review the changes, then commit and push.
