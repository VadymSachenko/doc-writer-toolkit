---
description: Translate the approved UA pages into every further target locale of the site, only where UA changed, using the locale-translator skill.
argument-hint: "[<page|folder>…] [--locales tr,kk] [--dry-run] [--overwrite] [--ticket <n>] [--worker-model <model>] [--no-build]"
---

Use the `locale-translator` skill to bring the site's further locales up to date with the approved Ukrainian pages on the current branch.

- **Arguments:** $ARGUMENTS — all optional. Without arguments the skill finds every stale page itself; pages or folders, `--locales`, `--dry-run`, `--overwrite`, `--ticket`, `--worker-model` and `--no-build` only narrow or adjust the run. Pass them through unchanged.

The skill resolves the project's declarations and target locales itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` and the site's `docusaurus.config`); do not hardcode a root or a locale here.

Strictly follow the skill's workflow: the UI label check first, then status, the binding and terminology passes, one worker per locale, the build and the report. Ask before translating more than the confirmation threshold of pages. Do not commit or push the translations.
