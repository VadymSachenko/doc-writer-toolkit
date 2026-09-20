---
description: Apply fixes for a doc-style-reviewer findings report against a single documentation page, using the doc-style-fixer skill.
argument-hint: "<path to the doc page> [guide:<gdsg|mssg-en|mssg-ua|ua-grammar>] [apply:mechanical[,substantive]] [--changed [<base>] | sections:\"…\" | report:<update-report.md>]"
---

Invoke the `doc-style-fixer` skill for the file given in `$ARGUMENTS`, passing through any `guide:` token present. Strictly follow that skill's workflow: use a `doc-style-reviewer` report already in this conversation if one exists for this file, otherwise have the skill invoke `doc-style-reviewer` itself first. Do not apply any edits yourself outside that skill's workflow — classification, diff presentation, per-bucket confirmation, and the final report all belong to the skill, not to this command.

Pass through unchanged any `apply:` token (non-interactive pre-approval of buckets — the skill lists every applied substantive rewrite before → after) and any scope token (`--changed`, `sections:`, `report:`), which the skill forwards to `doc-style-reviewer` when it has to produce the report.
