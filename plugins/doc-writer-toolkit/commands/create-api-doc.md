---
description: Generate an API reference page using the api-doc-writer skill.
argument-hint: "<slug>"
---

Use the `api-doc-writer` skill to write an API reference page.

- **Slug:** $ARGUMENTS
- **Input file:** `/api-docs/api-references/$ARGUMENTS.md`
- **Output:** `docs/api-reference/$ARGUMENTS/$ARGUMENTS.md`

Strictly follow the skill's workflow.

If the input file doesn't exist, stop and tell me before doing anything else.