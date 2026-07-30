---
name: project-paths
description: Shared procedure for resolving a project's UA content root and EN i18n root from its CLAUDE.md, with the ask-once fallback if undeclared. Referenced by every skill that reads/writes UA or EN doc files by path — never copy this procedure into another skill file.
---

# Project paths

Several skills (`doc-translator`, `doc-alignment-checker`, `concept-doc-writer`, `user-guide-writer`, and others that read or write documentation files by folder path) need to know two project-specific folders before they can do anything:

- **UA content root** — where Ukrainian source pages live (e.g. `docs/`, or `partner-cabinet/` in a project that splits API reference and partner-facing content into two Docusaurus plugin instances).
- **EN i18n root** — where the English translation of that content is published (e.g. `i18n/en/docusaurus-plugin-content-docs/current/`, or the `-partner-cabinet`-suffixed equivalent for a project with a custom-id docs plugin instance).
- **UA URL prefix** — the live route the UA content root resolves to (Docusaurus `routeBasePath`), needed by any skill that validates or generates internal links (e.g. `/` for a default-id docs plugin, `/partner-cabinet/` for a custom-id instance mounted there). Not always identical to the folder name — resolve it from the declaration, never infer it from the folder path.

Neither folder name is safe to hardcode in a skill file — different projects installing this plugin use different Docusaurus plugin layouts, and a path baked into a skill silently breaks (or silently writes to the wrong place) the moment that skill runs in a project shaped differently than the one it was written against.

## Resolving a project's roots

1. Check the invoking project's `CLAUDE.md` for the "Documentation toolkit configuration" section (the same section that declares the project's style guide — see `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md`) for `UA content root:` and `EN i18n root:` fields.
2. If both are present, use them for every path this skill reads or writes in this run.
3. If either is missing: **ask the user once** ("What's this project's UA content folder, and where does its English translation get published?"), and offer to write the answer back into that project's `CLAUDE.md` under the same "Documentation toolkit configuration" section, so the question isn't repeated on the next invocation.
4. Never guess a folder name (e.g. never assume `partner-cabinet/` or `docs/` by default) and never silently fall back to one project's layout because it's the one this skill happened to be written against.

## Example section (same block the style guide declaration lives in)

```md
## Documentation toolkit configuration

- **Style guide:** `gdsg`
- **UA content root:** `docs/`
- **EN i18n root:** `i18n/en/docusaurus-plugin-content-docs/current/`
- **UA URL prefix:** `/`
```

A project that splits content into two Docusaurus plugin instances (an English-only `docs/` for API reference plus a separate UA-first section) states that explicitly instead, e.g. `UA content root: partner-cabinet/`, `EN i18n root: i18n/en/docusaurus-plugin-content-docs-partner-cabinet/current/`, `UA URL prefix: /partner-cabinet/` — do not assume this split exists or doesn't; always read it from the project's own declaration.

Do not restate this procedure in the calling skill's own file — the calling skill's relevant step should be a short pointer into this file, not a paraphrase of it.