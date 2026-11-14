---
description: Scan all docs for ToDo and NEEDS CONFIRMATION comments, categorize them, ask before acting, then resolve the ones that can be fixed with links to existing pages.
argument-hint: "[optional: path glob to limit scope, e.g. api-reference/create-payin-transactions]"
---

Use the `doc-todo-fixer` skill to resolve the documentation TODOs that a link to an existing page can fix.

- **Scope:** $ARGUMENTS — an optional path glob that limits the scan; with none, every declared content root.

The skill resolves the project's content roots itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`); do not hardcode a root here.

Strictly follow the skill's workflow.
