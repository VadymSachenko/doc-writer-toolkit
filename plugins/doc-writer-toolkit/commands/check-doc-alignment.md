---
description: Check whether the UA and EN versions of a doc page are structurally aligned.
argument-hint: "<path | pair:path> main:<ua|en>"
---

Use the `doc-alignment-checker` skill to check alignment between the Ukrainian and English versions of a documentation page.

- **Page:** $ARGUMENTS without its `main:` argument — relative to a content root, from the repo root, or `<pair>:<path>`; add `.md` if it is absent

The skill resolves the page's root pair itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`) — do not hardcode a path here.

The `main:` argument tells the skill which version is the source of truth. If not provided in `$ARGUMENTS`, ask the user before proceeding.

Strictly follow the skill's workflow: load both files, run all checks, then report bugs and warnings.
