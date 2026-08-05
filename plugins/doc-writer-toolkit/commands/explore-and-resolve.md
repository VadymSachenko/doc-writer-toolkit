---
description: Explore the live app for a section and automatically resolve all NEEDS CONFIRMATION and ToDo markers in its doc pages. Runs app-explorer then resolve-markers in sequence. No manual answering needed — evidence from the app is applied directly.
argument-hint: "<section-folder>"
---

Run the explore-and-resolve flow for one documentation section.

- **Arguments:** $ARGUMENTS
- Parse the argument as the **section folder** (e.g. `docs/transactions`).

## What this command does

1. Runs **`app-explorer`** on the section — seeds test-env scenarios via the API test collection, explores the live UI with Playwright, captures screenshots, and writes `.sources/app-notes.md`.
2. Runs **`resolve-markers`** on the section — reads `app-notes.md` and resolves every `{/* NEEDS CONFIRMATION */}` and `{/* ToDo: add a screenshot */}` marker it can answer from the evidence. Leaves only genuinely unanswerable markers in place and reports them.

This command is a thin orchestrator. Business logic lives in the two skills — do not re-implement it here.

## Credentials

Before starting, read the project's `.env` file for `OPERATOR_BASE_URL`, `OPERATOR_USERNAME`, `OPERATOR_PASSWORD`, and any API keys needed for the section's scenarios. If any are missing, stop and list them — do not proceed without credentials.

Never write credentials into any file. Never point Playwright at a production URL.

## Finish

After both skills complete, report:
- How many markers were resolved automatically
- How many screenshots were placed
- What remains open (listed by file and marker text)
- Remind the user: review the changes, then commit and push.
