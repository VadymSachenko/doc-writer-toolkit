# Changelog

The plugin has no version number on purpose: an install tracks this repository's commits, so every change merged to `main` reaches the projects that use the plugin. Entries are dated.

## 2026-10-12

- Repo audit: removed the stale root copy of the plugin, stray files and the to-delete folder; neutral wording in writer skills; LF line endings.
- Fixed: 7 skills (`api-doc-writer`, `app-explorer`, `concept-doc-writer`, `doc-style-fixer`, `resolve-markers`, `section-planner`, `user-guide-writer`) had frontmatter that wasn't valid YAML, so Claude Code loaded them without a description and the model never offered them.
- Fixed: the plugin no longer pins a version, so installs receive every commit merged to `main`.
- Fixed: 24 Microsoft style guide rule files and one Google style guide rule file had no `ROUTING.md` row, so reviews never loaded them.
- Fixed: `extract-sme-screenshots` Mode A named the wrong dependencies and ran an unset `$VENV`; stale instructions in several skills and commands (check count, `fix-doc-todos` named as a skill, a hardcoded API reference path, where `unresolved` locales are reported).
- Changed: the three SME helper skills are explicit-invocation only; examples no longer name a specific product or its tickets.
- Added: a plugin lint (`tools/lint-plugin.mjs`) and a CI workflow that runs it and both script test suites.
