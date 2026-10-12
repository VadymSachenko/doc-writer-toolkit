---
description: Generate an API reference page using the api-doc-writer skill.
argument-hint: "<slug>"
---

Use the `api-doc-writer` skill to write an API reference page.

- **Slug:** $ARGUMENTS
- **Input file:** `/api-docs/api-references/$ARGUMENTS.md`
- **Output:** `<API reference root>/$ARGUMENTS/$ARGUMENTS.md`, where the root is the project's declared **API reference root** (resolve it per `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`; `docs/api-reference/` only when the project declares none)

Strictly follow the skill's workflow.

If the input file doesn't exist, stop and tell me before doing anything else.