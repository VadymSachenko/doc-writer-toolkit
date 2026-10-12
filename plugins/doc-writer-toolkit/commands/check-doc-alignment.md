---
description: Check whether the UA and EN versions of a doc page are structurally aligned.
argument-hint: "<relative-path> main:<ua|en>"
---

Use the `doc-alignment-checker` skill to check alignment between the Ukrainian and English versions of a documentation page.

- **Doc slug:** $ARGUMENTS

The skill resolves this project's actual UA content root and EN i18n root itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`) — do not hardcode a path here.

The `main:` argument tells the skill which version is the source of truth. If not provided in `$ARGUMENTS`, ask the user before proceeding.

Strictly follow the skill's workflow: load both files, run all 10 checks, then report bugs and warnings.
