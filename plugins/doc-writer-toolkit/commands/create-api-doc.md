---
description: Generate an API reference page using the api-doc-writer skill.
argument-hint: "<slug>"
---

Use the `api-doc-writer` skill to write an API reference page.

- **Slug:** $ARGUMENTS
- **Input folder:** `.claude/claude-inputs/api-docs/api-reference/$ARGUMENTS/`
- **Output:** `docs/api-reference/$ARGUMENTS/$ARGUMENTS.md`

Strictly follow the skill's workflow.

If the inputs folder doesn't exist or is empty, stop and tell me before doing anything else.