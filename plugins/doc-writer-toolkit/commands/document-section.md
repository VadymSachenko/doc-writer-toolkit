---
description: 'Run one section folder through the whole chain (readiness, app exploration, the plan, then per page the writer, marker resolution, style fix and review, UA approval, EN translation and alignment) with a resumable ledger, stopping only at the approval gates.'
argument-hint: "<section-folder> [interview:skip] [apply:mechanical|apply:mechanical,substantive] [approve:<id,…|all>] [page:<id>]"
---

Use the `document-section` skill to document one section folder end to end.

- **Arguments:** $ARGUMENTS — the section folder (from the repo root, or `<pair>:<folder>`), then the optional `interview:skip`, `apply:`, `approve:` and `page:`. Pass them through unchanged.

The skill resolves the project's declarations itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`) and keeps the ledger through `${CLAUDE_PLUGIN_ROOT}/scripts/section-state/`; do not hardcode a root here.

Strictly follow the skill's workflow: read the ledger first, run the next stage, and stop at every gate. Never approve the plan for the user. Do not commit, delete or move any page, and do not edit the sidebar.
