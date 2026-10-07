---
name: project-paths
description: Shared procedure for resolving a project's declarations — content language, UA content root, EN i18n root, UA URL prefix, and the label-store and locale-translation fields — from its CLAUDE.md, with the ask-once fallback if any is undeclared. Referenced by every skill that reads/writes UA or EN doc files by path, needs the project's content language, or uses the UI label store — never copy this procedure into another skill file.
---

# Project paths

Several skills (`doc-translator`, `doc-alignment-checker`, `concept-doc-writer`, `user-guide-writer`, `doc-style-reviewer`, and others that read or write documentation files by folder path) need a few project-specific facts before they can do anything:

- **Content language** — which language(s) this project's documentation is authored in: `uk`, `en`, or `uk,en` for a project that authors both. It selects the language layer of the style-guide profile a skill runs under (see `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md`), and for a `uk,en` project it says that both are legitimate rather than one being a misplaced file.
- **UA content root** — where Ukrainian source pages live (e.g. `docs/`, or `partner-cabinet/` in a project that splits API reference and partner-facing content into two Docusaurus plugin instances).
- **EN i18n root** — where the English translation of that content is published (e.g. `i18n/en/docusaurus-plugin-content-docs/current/`, or the `-partner-cabinet`-suffixed equivalent for a project with a custom-id docs plugin instance).
- **UA URL prefix** — the live route the UA content root resolves to (Docusaurus `routeBasePath`), needed by any skill that validates or generates internal links (e.g. `/` for a default-id docs plugin, `/partner-cabinet/` for a custom-id instance mounted there). Not always identical to the folder name — resolve it from the declaration, never infer it from the folder path.
- **API reference root** — where API reference pages are written (e.g. `docs/api-reference/`). Only skills that author API reference pages (`api-doc-writer`) need it. If a project doesn't declare it, fall back to `docs/api-reference/` and offer to persist the declaration — do not treat its absence as a hard stop.

None of these is safe to hardcode in a skill file — different projects installing this plugin use different Docusaurus plugin layouts and write in different languages, and a path or a language baked into a skill silently breaks (or silently writes to the wrong place) the moment that skill runs in a project shaped differently than the one it was written against.

## Resolving a project's declarations

1. Check the invoking project's `CLAUDE.md` for the "Documentation toolkit configuration" section (the same section that declares the project's style guide — see `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md`) and read the fields this run needs: `Content language:`, `UA content root:`, `EN i18n root:`, `UA URL prefix:`, and, for a run that uses the label store or translates into further locales, the fields in "Label store and locale translation" below.
2. If the fields this run needs are present, use them for every path this skill reads or writes, and for every language decision it makes, in this run.
3. If a needed field is missing: **ask the user once** — for the paths, "What's this project's UA content folder, and where does its English translation get published?"; for the language, "What language is this project's documentation authored in — `uk`, `en`, or both?" — and offer to write the answer back into that project's `CLAUDE.md` under the same "Documentation toolkit configuration" section, so the question isn't repeated on the next invocation.
4. Never guess a folder name (e.g. never assume `partner-cabinet/` or `docs/` by default), never guess the content language from the one file in hand, and never silently fall back to one project's layout because it's the one this skill happened to be written against.
5. `Content language:` is the one field a skill may proceed without: if it's absent, a skill working on a single file may fall back to that file's own language, but must say so and offer to persist a declaration (see the style-guide registry's "Resolving which guide a project uses," step 3).

## Example section (same block the style guide declaration lives in)

```md
## Documentation toolkit configuration

- **Style guide:** `gdsg`
- **Content language:** `uk`
- **UA content root:** `docs/`
- **EN i18n root:** `i18n/en/docusaurus-plugin-content-docs/current/`
- **UA URL prefix:** `/`
- **API reference root:** `docs/api-reference/`
- **Screenshot frame:** `3px, #CC0000`
- **Screenshot scope:** `container`
- **Screenshot padding:** `24`
- **Compact image width:** `480`
- **Blur radius:** `8`
- **Doc content width:** `840`
```

The last six fields configure screenshot capture and embedding. They are resolved and documented by `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-capture.md` (Section 0) — that file is their authority, including defaults and the ask-once/persist fallback. They live in this same declaration block so a project declares everything in one place; do not restate their meaning or defaults here.

`Content language:` describes the language(s) the project's pages are **authored** in — `uk`, `en`, or `uk,en`. Content published under the EN i18n root is a translation of UA-authored pages, not a second authored language: a project that writes in Ukrainian and translates to English declares `uk`, and only a project that authors pages natively in both declares `uk,en`.

A project that splits content into two Docusaurus plugin instances (an English-only `docs/` for API reference plus a separate UA-first section) states that explicitly instead, e.g. `UA content root: partner-cabinet/`, `EN i18n root: i18n/en/docusaurus-plugin-content-docs-partner-cabinet/current/`, `UA URL prefix: /partner-cabinet/` — do not assume this split exists or doesn't; always read it from the project's own declaration. Such a project authors in both languages and declares `Content language: uk,en`.

## Label store and locale translation

These fields are read by the `ui-labels` and `locale-sync` scripts (`${CLAUDE_PLUGIN_ROOT}/scripts/`), the label check (`${CLAUDE_PLUGIN_ROOT}/context/ui-labels.md`) and `locale-translator`. A project that keeps no label store and translates into no further locales declares none of them.

| Field | Required | Value | If absent |
|---|---|---|---|
| `App:` | for `locale-translator` | The app this repo documents, one per repo. Names it in run reports. | ask once |
| `UI label source:` | for the label store | `github <owner/repo>@<branch> <dir>/*.json`, or `command <shell command>`, where the command contains `{locale}` and prints that locale's strings as a JSON object | ask once (writer skills skip the label check instead) |
| `Locale files:` | only when file names don't match by language | `<docs locale>=<file name without .json>` pairs: `uk=ua, es=ar` | files match by language: `es-AR.json` → `es` |
| `UI label fallback:` | no | `en` when the app shows the EN string for a key that a locale lacks | such a label is translated (`locale-translation.md`, L4) |
| `Locale register:` | no | `<locale>: <address form>` pairs, only the overrides: `es: tú` | the register table in `${CLAUDE_PLUGIN_ROOT}/context/locale-translation.md` |
| `Translation scope:` | no | Comma-separated folders or pages under the UA content root | the whole UA content root |
| `Toolkit state root:` | no | Folder for the label store, page state and term memory | `.doc-toolkit/` |

**Derived, never declared:**

- **Target locales** are `i18n.locales` in the project's `docusaurus.config.*` minus the default locale and `en`. `docusaurus.config` is the single source, so `CLAUDE.md` has no locale list. If it lists only the default locale and `en`, the run stops: no target locales are configured yet.
- **A locale's content root** is the EN i18n root with its `en` path segment replaced: `i18n/en/docusaurus-plugin-content-docs/current/` → `i18n/tr/docusaurus-plugin-content-docs/current/`. An EN i18n root with no `en` segment is a configuration error.
- **The ticket** whose frontend branches overlay the label store comes from the leading numbers of the current branch name (`1163-…` → `1163`), or from the ticket the user shares.

**Writing the values:**

- Put a value made of several parts inside one backtick span (`` `uk=ua, es=ar` ``). The scripts read only the first backtick span of a line.
- A locale with no matching locale file, or with several, is never guessed. The scripts exit `2` and list the `candidates`. Ask once for the `Locale files:` mapping and offer to persist it, the same fallback as step 3 above.

```md
- **App:** `web-app`
- **UI label source:** `github example-org/web-app@test src/locales/*.json`
- **Locale files:** `uk=ua, es=ar`
```

Do not restate this procedure in the calling skill's own file — the calling skill's relevant step should be a short pointer into this file, not a paraphrase of it.
