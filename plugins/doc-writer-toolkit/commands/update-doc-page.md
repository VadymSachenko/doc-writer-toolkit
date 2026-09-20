---
description: Apply a change brief to an existing documentation page using the doc-page-updater skill.
argument-hint: "<page path> <brief path> [project:<host project root>] [dry-run]"
---

Use the `doc-page-updater` skill to update an existing page from a change brief.

- **Arguments:** $ARGUMENTS — the page path, the brief path, an optional `project:<root>` when the page lives in another checkout, and an optional `dry-run`.

The skill resolves the project's declarations itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`); do not hardcode roots here.

Strictly follow the skill's workflow: plan from the brief, make the smallest edit, self-review, write `update-report.md`, report. Do not run the style reviewer, fixer or translator from this command.

If the page or the brief does not exist, stop and tell me before doing anything else.
