---
description: End-to-end flow — turn an SME video interview into a finished, style-checked documentation page.
argument-hint: "<doc-folder> [type:concept|user-guide|api]"
---

Use the `sme-interview-to-doc` skill to turn an SME video interview into a finished, style-checked documentation page.

- **Arguments:** $ARGUMENTS
- Parse the leading path as the **doc folder** (the folder containing `.sources/`, e.g. `docs/payments`). Parse an optional trailing `type:` token. Pass both to the skill unchanged.

The skill resolves the project's declarations itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`); do not hardcode a path here.

Strictly follow the skill's workflow.
