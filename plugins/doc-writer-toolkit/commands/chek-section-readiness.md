---
description: Scan a documentation section folder and report what exists — pages classified stub vs complete, sources and screenshots inventoried, app-access assessed — as a machine-consumable JSON report.
argument-hint: "<section-folder>"
---

Run the **`section-readiness`** skill on the given section folder.

- **Arguments:** $ARGUMENTS
- Parse the argument as the **section folder** (relative to the repo root, e.g. `docs/transactions`).

This command is a thin wrapper. Strictly follow the skill's workflow — resolve paths via `project-paths.md`, classify each page, inventory sources and app-access, and write the report to `<section folder>/.sources/section-readiness.json`. Do not re-implement the skill's logic here, and do not edit any doc file — this is a read-only diagnostic.
