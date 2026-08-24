---
description: Generate an API reference page using the api-doc-writer skill.
argument-hint: "<slug>"
---

Use the `api-doc-writer` skill to write an API reference page.

- **Slug:** $ARGUMENTS

The skill resolves this project's API reference root and input-file location itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`) — do not hardcode a path here.

Strictly follow the skill's workflow.

If the input file doesn't exist, stop and tell me before doing anything else.