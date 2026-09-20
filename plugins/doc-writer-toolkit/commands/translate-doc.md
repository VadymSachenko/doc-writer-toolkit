---
description: Translate an approved Ukrainian doc page into English using the doc-translator skill.
argument-hint: "<relative-path>"
---

Use the `doc-translator` skill to translate an approved Ukrainian documentation page into English.

- **Doc path relative to the UA content root:** $ARGUMENTS.md

The skill resolves this project's actual UA content root and EN i18n root itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`) — do not hardcode a path here.

Strictly follow the skill's workflow.

If the source file doesn't exist, stop and tell me before doing anything else.

**Sync mode.** When $ARGUMENTS also carries `--sync` (optionally `--base <ref>`, `sections:"…"` or `report:<update-report.md>`), the skill re-translates only the UA blocks that changed into the existing EN page and leaves the rest byte-identical, without asking "overwrite or merge?". Pass those tokens through unchanged.
