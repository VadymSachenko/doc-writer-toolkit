---
description: Read a section's readiness report and app evidence, then propose a page inventory — what to keep, merge, split, add, or delete — for human approval before any writing starts.
argument-hint: "<section-folder>"
---

Run the **`section-planner`** skill on the given section folder.

- **Arguments:** $ARGUMENTS
- Parse the argument as the **section folder** (e.g. `docs/balance`).

This command is a thin wrapper. Strictly follow the skill's workflow — read the readiness report, cross-check against app evidence, propose a page inventory, write `.sources/section-plan.md`, show the plan table in the conversation, and wait for approval. Do not write, rename, or delete any doc page.
