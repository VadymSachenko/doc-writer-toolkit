# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **source repository for a Claude Code plugin marketplace** (`doc-writer-toolkit`), not a documentation site itself. It contains skills, slash commands, and content-rule corpora that get installed into *other* Docusaurus documentation projects (currently only UniComPay's). There is no app to build, no test suite, and no lint config — the deliverable is the Markdown/JSON content under `plugins/doc-writer-toolkit/`, consumed by Claude Code at runtime in a different repo.

Because of this, most SKILL.md files reference paths like `docs/`, `partner-cabinet/`, `i18n/en/...`, and `CLAUDE.md` that **do not exist in this repo** — they refer to the target project where the plugin is installed. Do not go looking for those paths here; they're part of the runtime contract the skills expect the host project to satisfy.

## Repository structure

```
.claude-plugin/marketplace.json          # marketplace manifest (lists the plugin(s) below)
plugins/doc-writer-toolkit/
  .claude-plugin/plugin.json             # plugin manifest (name/description/author)
  skills/<name>/SKILL.md                 # one skill per directory
  commands/<name>.md                     # slash-command wrappers around skills
  context/doc-rules/                     # style guide, UA grammar, glossary, project rules
  context/doc-templates/                 # page templates (API reference, user guide, concept topic)
  context/google-developer-style-guide/  # distilled GDSG corpus (routed loading)
  context/microsoft-style-guide/         # distilled MSSG corpus, EN + UA localization (routed loading)
  scripts/sme-video-context/             # standalone Python tool, not auto-loaded
```

Two manifests gate everything: `marketplace.json` points at `./plugins/doc-writer-toolkit` as a plugin source, and that plugin's own `plugin.json` is what Claude Code reads once installed. If you add a new skill or command directory, no manifest edit is needed — both commands and skills are picked up by directory convention.

## Commands used when developing this repo

There's no build/lint/test tooling. What you'll actually run:

- **Validate a manifest edit:** `python3 -m json.tool plugins/doc-writer-toolkit/.claude-plugin/plugin.json` (or `.claude-plugin/marketplace.json`) — just a JSON syntax check.
- **Try a skill/command end-to-end:** it must be exercised from a *different* repo that has this plugin installed (see README's "Install into a project" section) or from a local checkout added via `extraKnownMarketplaces` pointing at a local path. There is no in-repo harness for running a skill.
- **`scripts/sme-video-context/sme_video_context.py`:** the one real piece of executable code here. Setup and run commands are documented in `plugins/doc-writer-toolkit/scripts/sme-video-context/README.md` (needs system `ffmpeg`/`tesseract` plus a Python venv) — follow that file rather than duplicating the steps here, since the `extract-sme-screenshots` skill's own instructions (with a known-bug workaround) are the current source of truth for how it's actually invoked.

## Architecture

### Generic vs. product-specific seam

Skill *logic* is generic and reusable for any Docusaurus doc project. Product-specific terminology and examples live only in `context/doc-rules/project-rules/` (`glossary-en.md`, `glossary-ua.md`, `api-integration-context.md`), `context/doc-rules/doc-examples/`, and `context/doc-templates/` — all currently UCPay-specific. Every skill references these exclusively through `${CLAUDE_PLUGIN_ROOT}`, so splitting a second product out into its own plugin would mean swapping that directory's contents, not touching skill logic. Keep new product-specific content inside that seam rather than hardcoding it into a skill.

`context/doc-rules/project-rules/glossary.md` is a bilingual EN↔UA *human-facing* alignment reference; skills themselves never load it directly — they load the language-specific `glossary-en.md`/`glossary-ua.md` instead.

### Skill file shape

Every `SKILL.md` follows the same contract; when writing a new one or editing an existing one, preserve it:

- Frontmatter `name` + `description` — the description doubles as the trigger spec. All authoring/translation/review skills are **explicit-invocation only** (they say so in their own description and end with an "Explicit invocation examples" section) — they must never fire on an implicit request. Preserve that if you touch the description.
- **Scope** section stating in-scope/out-of-scope up front, cross-referencing sibling skills by name so responsibilities don't overlap (e.g. style review vs. UA/EN structural alignment are deliberately separate skills).
- **Sources to load** — an explicit, short allowlist of files loaded at task start; skills are written to *not* load anything beyond this list unless the user references it.
- A numbered **Workflow** with a mandatory interview/question phase before drafting (the three `*-writer` skills), and a **self-review checklist** run before any file is saved.
- **Explicit invocation examples** at the end, showing the phrasing that should trigger the skill.

Commands in `commands/*.md` are thin: they bind `$ARGUMENTS` to concrete paths and hand off with "strictly follow the skill's workflow" — business logic belongs in the skill, not the command.

### Style-guide corpora use signal-driven routed loading, never bulk loading

`context/google-developer-style-guide/` and `context/microsoft-style-guide/` are large distilled corpora (121 and 168 files). Every consumer (`doc-style-reviewer`, and the loading sections of `api-doc-writer`/`doc-translator`) is required to read that corpus's own `ROUTING.md` (or, for UA grammar, `context/doc-rules/ua-grammar/INDEX.md`) first, map document signals to the routing table, and load only the matched topic files — the routing files themselves explicitly forbid loading the full manifest, terminology index, or word index wholesale. If you add rules to these corpora, add a routing-table row rather than expecting consumers to discover the file unaided, and never hand-copy corpus rules into a skill file — skills reference the corpus so it stays the single source of truth.

`doc-style-reviewer` is the one skill with four selectable modes (`gdsg`, `mssg-en`, `mssg-ua`, `ua-grammar`) chosen via a `guide:` argument; each mode reads a different combination of the two corpora plus `ua-grammar/`.

### Two parallel doc trees in the host project

Skills assume the host project has two independently-localized doc trees, each with its own i18n output path — this split explains why several skills hardcode different `i18n/en/...` paths:

| Tree | UA/source path | EN path | Used by |
|---|---|---|---|
| API reference | `docs/` | `i18n/en/docusaurus-plugin-content-docs/current/` | `api-doc-writer` (EN-native), `fix-doc-todos` |
| Partner cabinet | `partner-cabinet/` | `i18n/en/docusaurus-plugin-content-docs-partner-cabinet/current/` | `user-guide-writer`, `concept-doc-writer`, `doc-translator`, `doc-alignment-checker` (UA-native) |

Note: `commands/check-doc-alignment.md` currently hardcodes the `docs/` / `docusaurus-plugin-content-docs/current/` pair in its argument-hint text, while the `doc-alignment-checker` skill it wraps hardcodes the `partner-cabinet/` pair in its own Path mapping section — these disagree. Check which one you actually need before relying on either, and reconcile them if you're touching this area.

Across both trees, unresolved content is marked with `{/* ToDo: ... */}` and `{/* NEEDS CONFIRMATION: ... */}` HTML comments — every writing/translation/alignment skill knows to preserve, carry over, or check for these markers rather than resolving them silently.

### SME video pipeline

Three skills form a linear pipeline turning a raw meeting recording into doc-ready material, each independent and re-invocable on its own:

1. `extract-sme-screenshots` — shells out to `scripts/sme-video-context/sme_video_context.py` (system deps: `ffmpeg`, `tesseract`; a persistent Python venv at `~/.cache/doc-writer-toolkit/sme-video-venv`), keeps only `images/` (+ transcript if freshly generated), discards the rest of the script's output package.
2. `convert-sme-input` — turns the transcript/notes into a structured `.sources/sme-interview.md`.
3. `cleanup-unused-screenshots` — after a doc is written referencing only some screenshots, moves the rest into `_unused/` (never deletes).

All three operate on `.sources/` and `.assets/` folders that live *inside the host project*, next to the doc page being worked on — not inside this repo.

### Unused templates

`context/doc-templates/user-guide-template.md` and `concept-topic-template.md` (the non-`ua-` prefixed versions) are not referenced by any current skill — `user-guide-writer` and `concept-doc-writer` load `ua-user-guide-template.md` and `ua-concept-topic-template.md` respectively. Don't assume the EN-named templates are live; check what a skill actually loads before editing a template.
