---
description: Translate an approved English doc page into Ukrainian using the doc-translator skill.
argument-hint: "<relative-path-from-docs>"
---

Use the `doc-translator` skill to translate an approved English documentation page into Ukrainian.

- **Doc path relative to the project folder:** $ARGUMENTS.md
- **Source file:** `i18n/en/docusaurus-plugin-content-docs/current/$ARGUMENTS.md`
- **Output file:** `$ARGUMENTS.md`

Strictly follow the skill's workflow.

If the source file doesn't exist, stop and tell me before doing anything else.
