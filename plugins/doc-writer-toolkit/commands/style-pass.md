---
description: 'One style pass on a doc page: review, apply the mechanical and substantive fixes, and end in one numbered before → after list you answer by number; undone changes are logged, and a rule you keep rejecting is proposed as a product rule.'
argument-hint: "<path> [guide:<gdsg|mssg-en|mssg-ua|ua-grammar>] [--changed [<base>] | sections:\"…\" | report:<update-report.md>] [undo:<n,…> | keep:all]"
---

Use the `doc-style-pass` skill on one documentation page.

- **Arguments:** $ARGUMENTS — the page path, then the optional tokens. Pass `guide:`, the scope tokens (`--changed`, `sections:`, `report:`), `undo:` and `keep:all` through unchanged.

The skill runs `doc-style-reviewer` and `doc-style-fixer` itself. Don't run them separately here, and don't edit the page outside the skill's workflow.

If the page doesn't exist, stop and tell me before doing anything else.

Strictly follow the skill's workflow.
