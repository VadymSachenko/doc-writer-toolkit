---
description: Review a documentation page against a style/grammar guide corpus and report findings (no edits).
argument-hint: "<path> [guide:<gdsg|mssg-en|mssg-ua|ua-grammar>] [--changed [<base>] | sections:\"…\" | report:<update-report.md>]"
---

Use the `doc-style-reviewer` skill to review a documentation page.

- **Arguments:** $ARGUMENTS
- Parse the leading path and, if present, a `guide:<value>` token out of $ARGUMENTS.
- **Scope tokens (optional):** `--changed [<base>]`, `sections:"…"` or `report:<path>` switch the skill to scope mode — only the changed blocks are reviewed, plus the terms consistency pass. Pass them through unchanged; the skill resolves the blocks itself.

The `guide:` argument is **optional**:

- **Not given** — resolve the guide from this project's own `Style guide:` declaration and the language from the file, per the skill's Step 1. Don't ask me which guide to use when the project already declares one.
- **Given** — it overrides the declaration for this run. Valid values:
  - `gdsg` — Google Developer Style Guide (English)
  - `mssg-en` — Microsoft Writing Style Guide (English)
  - `mssg-ua` — Microsoft Ukrainian Localization Style Guide + UA grammar authority
  - `ua-grammar` — Official Ukrainian orthography only (Український правопис 2019)
- **Given but not one of those four** — stop and ask, listing the options.

Only ask me to pick a guide when there's neither an argument nor a project declaration.

If the target file doesn't exist, stop and tell me before doing anything else.

Strictly follow the skill's workflow: pre-scan the doc, detect its language and resolve the profile, load only the routed corpus files for that profile plus the project rank-0 layer, run the review, then report findings by severity tier. Show in the report header which profile was applied and where it came from.
