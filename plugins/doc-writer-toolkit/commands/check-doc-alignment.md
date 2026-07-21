---
description: Check whether the UA and EN versions of a doc page are structurally aligned.
argument-hint: "<relative-path-from-docs> main:<ua|en>"
---

Use the `doc-alignment-checker` skill to check alignment between the Ukrainian and English versions of a documentation page.

- **Doc slug:** $ARGUMENTS
- **UA file:** `docs/<slug>.md`
- **EN file:** `i18n/en/docusaurus-plugin-content-docs/current/<slug>.md`

The `main:` argument tells the skill which version is the source of truth. If not provided in `$ARGUMENTS`, ask the user before proceeding.

Strictly follow the skill's workflow: load both files, run all 10 checks, then report bugs and warnings.
