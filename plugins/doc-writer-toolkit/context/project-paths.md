---
name: project-paths
description: Shared procedure for resolving a project's declarations — content language, UA content root, EN i18n root, UA URL prefix, the root pair a page belongs to, and the label-store and locale-translation fields — from its CLAUDE.md, with the ask-once fallback if any is undeclared. Referenced by every skill that reads/writes UA or EN doc files by path, needs the project's content language, or uses the UI label store — never copy this procedure into another skill file.
---

# Project paths

Several skills (`doc-translator`, `doc-alignment-checker`, `concept-doc-writer`, `user-guide-writer`, `doc-style-reviewer`, and others that read or write documentation files by folder path) need a few project-specific facts before they can do anything:

- **Content language** — which language(s) this project's documentation is authored in: `uk`, `en`, or `uk,en` for a project that authors both. It selects the language layer of the style-guide profile a skill runs under (see `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md`), and for a `uk,en` project it says that both are legitimate rather than one being a misplaced file.
- **UA content root** — where Ukrainian source pages live (e.g. `docs/`, or `portal/` in a project with a second Docusaurus docs plugin instance). One per root pair; see "More than one root pair".
- **EN i18n root** — where the English translation of that content is published (e.g. `i18n/en/docusaurus-plugin-content-docs/current/`, or the `-portal`-suffixed equivalent for a custom-id docs plugin instance).
- **UA URL prefix** — the live route the UA content root resolves to (Docusaurus `routeBasePath`), needed by any skill that validates or generates internal links (e.g. `/` for a default-id docs plugin, `/portal/` for a custom-id instance mounted there). Not always identical to the folder name — resolve it from the declaration, never infer it from the folder path.
- **API reference root** — where API reference pages are written (e.g. `docs/api-reference/`). Only skills that author API reference pages (`api-doc-writer`) need it. If a project doesn't declare it, fall back to `docs/api-reference/` and offer to persist the declaration — do not treat its absence as a hard stop. Its root pair is the pair whose UA content root holds it.

None of these is safe to hardcode in a skill file — different projects installing this plugin use different Docusaurus plugin layouts and write in different languages, and a path or a language baked into a skill silently breaks (or silently writes to the wrong place) the moment that skill runs in a project shaped differently than the one it was written against.

## Resolving a project's declarations

1. Check the invoking project's `CLAUDE.md` for the "Documentation toolkit configuration" section (the same section that declares the project's style guide — see `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md`) and read the fields this run needs: `Content language:`, `UA content root:`, `EN i18n root:`, `UA URL prefix:` and the same fields of every further root pair (`<Name> UA content root:` …), and, for a run that uses the label store or translates into further locales, the fields in "Label store and locale translation" below.
2. If the fields this run needs are present, use them for every path this skill reads or writes, and for every language decision it makes, in this run.
3. If a needed field is missing: **ask the user once** — for the paths, "What's this project's UA content folder, and where does its English translation get published?"; for the language, "What language is this project's documentation authored in — `uk`, `en`, or both?" — and offer to write the answer back into that project's `CLAUDE.md` under the same "Documentation toolkit configuration" section, so the question isn't repeated on the next invocation.
4. Never guess a folder name (e.g. never assume `portal/` or `docs/` by default), never guess the content language from the one file in hand, never silently fall back to one project's layout because it's the one this skill happened to be written against, and never use the primary pair for a page under another pair's root.
5. `Content language:` is the one field a skill may proceed without: if it's absent, a skill working on a single file may fall back to that file's own language, but must say so and offer to persist a declaration (see the style-guide registry's "Resolving which guide a project uses," step 3).

## Resolving a page's root pair

A project may declare more than one root pair (see "More than one root pair" below). A skill that reads or writes a page by path works inside the pair that holds the page: that pair's UA content root, EN i18n root and UA URL prefix. With one declared pair, that pair is the answer and the rest of this section does not apply.

Find the pair from the path the user gives, or from the page the skill is about to read or write, in this order:

1. **`<pair>:<path>`**, where `<pair>` is a declared pair id (`primary`, `api-reference`): that pair. The path is relative to its roots; a path that repeats the root (`api-reference:docs/webhooks/webhooks`, where `docs/` is that pair's root) has it stripped. A `<pair>` that is no declared id: stop and list the declared ids.
2. **A path from the repo root inside a declared root** (a UA content root or an EN i18n root): that root's pair. Compare whole path segments: `docs/a.md` is inside `docs/`, `docs-old/a.md` is not. No root of one pair sits inside a root of another (see "More than one root pair"), so at most one matches.
3. **Any other path is relative to a content root.** Look it up under every pair's UA content root, and also under every EN i18n root when the skill takes an EN page as input.
   - Found under one pair: use that pair.
   - Found under more than one: list each as `<pair>:<path>` with its repo path, ask which one, and stop until answered. Never pick one.
   - Found under none: a skill that needs the page stops and names the roots it searched. A skill that creates the page looks up the page's nearest existing parent folder the same way, and asks which pair if that is found under none or more than one.
4. **A path from the repo root under no declared root** (`blog/post.md`):
   - Under the declared `API reference root:`, or in an English-native tree (the project declares `Content language: uk,en`; see below): it belongs to no pair: work on it without one, and save nothing. Links into such a tree aren't built from any pair (see `internal-links.md`).
   - Otherwise ask once whether it belongs to a declared pair, to a new one, or to no pair (an English-native tree). Offer to persist a new pair's fields as described in "More than one root pair". Never fall back to the primary pair.

With more than one pair declared, name the pair you resolved, as `<pair>:<path>` (`api-reference:webhooks/webhooks`), in your first status line and in your report.

A link's target is a page too: its route uses the target's own pair (see `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md`).

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

`Content language:` describes the language(s) the project's pages are **authored** in — `uk`, `en`, or `uk,en`. Content published under the EN i18n root is a translation of UA-authored pages, not a second authored language: a project that writes in Ukrainian and translates to English declares `uk`, and only a project that authors pages natively in both declares `uk,en`. It is one value for the whole project, every root pair included.

A project that splits content into two Docusaurus plugin instances states which tree is which, and never leaves it to be assumed:

- A second tree that is UA-authored, with its own EN translation, is a further root pair (see "More than one root pair"). The content language stays as declared.
- A second tree that is English-native, with no UA source, is not a root pair. The project declares `Content language: uk,en`, and that tree stays outside every root pair: the translator and the alignment checker don't cover it.

## Label store and locale translation

These fields are read by the `ui-labels` and `locale-sync` scripts (`${CLAUDE_PLUGIN_ROOT}/scripts/`), the label check (`${CLAUDE_PLUGIN_ROOT}/context/ui-labels.md`) and `locale-translator`. A project that keeps no label store and translates into no further locales declares none of them.

| Field | Required | Value | If absent |
|---|---|---|---|
| `App:` | for `locale-translator` | The app this repo documents, one per repo. Names it in run reports. | ask once |
| `UI label source:` | for the label store | `github <owner/repo>@<branch> <dir>/*.json`, or `command <shell command>`, where the command contains `{locale}` and prints that locale's strings as a JSON object | ask once (writer skills skip the label check instead) |
| `Locale files:` | only when file names don't match by language | `<docs locale>=<file name without .json>` pairs: `uk=ua, es=ar` | files match by language: `es-AR.json` → `es` |
| `UI label fallback:` | no | `en` when the app shows the EN string for a key that a locale lacks | such a label is translated (`locale-translation.md`, L4) |
| `Locale register:` | no | `<locale>: <address form>` pairs, only the overrides: `es: tú` | the register table in `${CLAUDE_PLUGIN_ROOT}/context/locale-translation.md` |
| `Translation scope:` | no | Comma-separated folders or pages under the UA content root, or `none` for no page at all | the whole UA content root |
| `Toolkit state root:` | no | Folder for the label store, page state and term memory | `.doc-toolkit/` |

**More than one root pair.** A repo with two Docusaurus docs plugin instances has two UA content roots, each with its own EN i18n root. Each UA/EN pair is a *root pair*. The unprefixed `UA content root:`, `EN i18n root:`, `UA URL prefix:` and `Translation scope:` are the **primary** pair (id `primary`). Every further pair is the same four fields with a name in front, any name: `API reference UA content root:`, `API reference EN i18n root:`, `API reference UA URL prefix:`, `API reference Translation scope:`. The pair's id is its name in lower case with dashes (`API reference` → `api-reference`). A pair needs both roots; its URL prefix defaults to `/` and its scope to its whole UA root. No root of one pair may equal or sit inside a root of another pair (UA or EN), and two pairs can't share a UA URL prefix: a further pair whose prefix defaults to `/` while the primary's is `/` too must declare its own. A skill that finds a declaration breaking these rules stops and names the fields to fix. A pair the project doesn't translate into further locales declares `<Name> Translation scope:` `none`.

- `ui-labels`, `locale-sync` and `locale-translator` cover every declared pair: each pair's pages are checked, translated, synced and reported against that pair's own roots, and its page state is kept apart (`<state root>/pairs/<id>/pages/`; the primary pair keeps `<state root>/pages/`). With more than one pair, the scripts print page ids as `<pair>:<id>`. The label store, the term memory, the target locales and the build are shared.
- Every other skill that resolves roots through this file finds a page's pair from its path (see "Resolving a page's root pair"), so a page of any pair works without naming its roots.

**Derived, never declared:**

- **Target locales** are `i18n.locales` in the project's `docusaurus.config.*` minus the default locale and `en`. `docusaurus.config` is the single source, so `CLAUDE.md` has no locale list. If it lists only the default locale and `en`, the run stops: no target locales are configured yet.
- **A locale's content root** is the EN i18n root with its `en` path segment replaced: `i18n/en/docusaurus-plugin-content-docs/current/` → `i18n/tr/docusaurus-plugin-content-docs/current/`. An EN i18n root with no `en` segment is a configuration error. Each root pair derives its own locale roots from its own EN i18n root.
- **A locale's sidebar label file** is its content root with `.json`: `i18n/tr/docusaurus-plugin-content-docs/current.json`, one per root pair and locale.
- **The ticket** whose frontend branches overlay the label store comes from the leading numbers of the current branch name (`1163-…` → `1163`), or from the ticket the user shares.

**Writing the values:**

- Put a value made of several parts inside one backtick span (`` `uk=ua, es=ar` ``). The scripts read only the first backtick span of a line.
- A locale with no matching locale file, or with several, is never guessed. The scripts exit `2` and list the `candidates`. Ask once for the `Locale files:` mapping and offer to persist it, the same fallback as step 3 above.

```md
- **App:** `web-app`
- **UI label source:** `github example-org/web-app@test src/locales/*.json`
- **Locale files:** `uk=ua, es=ar`
```

A second root pair, next to the primary pair's fields in the same block:

```md
- **UA content root:** `portal/`
- **EN i18n root:** `i18n/en/docusaurus-plugin-content-docs-portal/current/`
- **UA URL prefix:** `/portal/`
- **API reference UA content root:** `docs/`
- **API reference EN i18n root:** `i18n/en/docusaurus-plugin-content-docs/current/`
- **API reference UA URL prefix:** `/`
```

**Setup note, sidebar labels.** Where the sidebar is autogenerated and the UA tree has no `_category_.json` for a folder, delete the docs-plugin `current.json` that `write-translations` creates for each locale (`i18n/<locale>/docusaurus-plugin-content-docs*/current.json`), and don't commit a regenerated one. It holds the category labels in the default language, and Docusaurus shows them in every locale's sidebar; without the file the labels come from the translated titles of the section pages. Keep the file only for categories declared by a `_category_.json`: `locale-translator` translates those into it. `locale-sync status` warns (`sidebarLabels`) when a locale's file still has untranslated labels that no `_category_.json` owns. The theme files (`code.json`, `navbar.json`, `footer.json`) are not affected.

Do not restate this procedure in the calling skill's own file — the calling skill's relevant step should be a short pointer into this file, not a paraphrase of it.
