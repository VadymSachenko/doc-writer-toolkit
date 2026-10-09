# doc-writer-toolkit

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) with skills, commands, and content rules for writing product documentation on Docusaurus sites. Built to be installed once per project instead of copy-pasted between repos.

## What's in the plugin

`plugins/doc-writer-toolkit/`:

- **`skills/`** — 16 skills for writing and maintaining docs. See [`SKILLS-INDEX.md`](plugins/doc-writer-toolkit/SKILLS-INDEX.md) for the canonical list. Skills are generic — they don't hardcode a product name, brand, style guide, or host project's folder layout; project-specific choices (which style guide, where UA/EN content live) are declared once in the host project's own `CLAUDE.md` and resolved from there (see `context/style-guide-registry.md` and `context/project-paths.md`).
- **`commands/`** — 12 slash-command wrappers around the skills above. See [`SKILLS-INDEX.md`](plugins/doc-writer-toolkit/SKILLS-INDEX.md) for the full command list.
- **`context/style-guide-registry.md`** — the single source of truth for the four `guide:` tokens (`gdsg`/`mssg-en`/`mssg-ua`/`ua-grammar`), their corpus/router, and the procedure every skill uses to resolve a host project's declared guide (or ask once, if none is declared). Referenced by `doc-style-reviewer` and every drafting skill — never copied.
- **`context/project-paths.md`** — the same pattern for a host project's UA content root, EN i18n root, and UA URL prefix. Referenced by `doc-translator`, `doc-alignment-checker`, and the UA-drafting skills — never copied.
- **`context/locale-translation.md`**, **`context/ui-labels.md`**, **`context/changed-blocks.md`** — shared rules and procedures of the locale translation pipeline (see below): how to translate into the further locales, how the UI label check runs at the start of a docs task, and what "the changed part of a page" means. Referenced by `locale-translator`, `doc-translator`, `doc-page-updater` and the writer skills — never copied.
- **`context/doc-rules/`** — Ukrainian grammar reference (`ua-grammar/`, product-agnostic) and `project-rules/` (glossary, product-integration context — currently UCPay-specific).
- **`context/google-developer-style-guide/`** — complete distilled corpus of the public Google Developer Documentation Style Guide (121 files), with routed loading for token efficiency.
- **`context/microsoft-style-guide/`** — complete distilled corpus of the Microsoft Writing Style Guide (English + Ukrainian localization, 168 files), with routed loading for token efficiency.
- **`context/doc-templates/`** — page templates for API reference pages, user guides, and concept topics.
- **`scripts/`** — non-skill utilities that plugin skills shell out to: `ui-labels/` and `locale-sync/` (Node, no dependencies, tested with `npm test`) for the locale translation pipeline, and `sme-video-context/` (Python) for the SME video pipeline.
- **`to-delete/`** — retired content staged for manual deletion (nothing here is loaded by any skill). Currently: `style-guide-rules/`, a hand-curated GDSG digest that drifted out of sync with `context/google-developer-style-guide/` and has been superseded by it everywhere.

### Generic vs. product-specific

The skills and `doc-rules/ua-grammar/` are reusable as-is for any Docusaurus documentation project. `context/doc-rules/project-rules/glossary-*.md`, `api-integration-context.md`, and `context/doc-templates/` currently carry UCPay-specific terminology and examples. If a second, unrelated product ever needs this toolkit with different terminology, that seam is where to split into a second plugin — the skills already reference everything through `${CLAUDE_PLUGIN_ROOT}`, so no skill logic would need to change.

(`context/doc-rules/doc-examples/` is *not* product-specific, despite being listed alongside those folders in an earlier version of this README — its worked examples are unrelated third-party content (a public API reference, an unrelated SaaS product's docs), kept only as a generic prose voice/density reference. Don't treat it as a source of UCPay facts or terminology.)

**Glossary, direction (not yet implemented):** `glossary-*.md` is currently always-bundled, UCPay-specific content, which cuts against this toolkit's goal of being product-agnostic — but it's also useful to keep an example on hand for bootstrapping the next similar project. The intended fix, when it lands, is a "starter-kit" framing rather than a silent runtime fallback: rename it out of `project-rules/` into something structurally marked as an example (e.g. `starter-glossary/`), and have glossary-consuming skills follow the same ask-once/offer-to-persist pattern already used for `style-guide-registry.md` and `project-paths.md` when a host project has no local glossary — copy the starter in as a one-time seed, or proceed without one. A prose label alone ("this is just an example") isn't durable — it drifted unnoticed for `doc-examples/` above, so the eventual fix should be structural, not a comment.

## SME video pipeline

Three pieces work together to turn a meeting recording into a documented page:

1. **`extract-sme-screenshots`** (skill) — given a video (+ optional transcript) in a `.sources/` folder, extracts deduplicated screenshots into `.sources/frames/{video-basename}-frames/`, auto-transcribing via Whisper if no transcript was supplied. Shells out to `plugins/doc-writer-toolkit/scripts/sme-video-context/sme_video_context.py`, which needs `ffmpeg`, `tesseract`, and a Python venv (`Pillow` + `imagehash` always, `faster-whisper` only when transcribing) — see that script's own `README.md`. It's not a plugin component itself (real system dependencies, not auto-loaded); the skill drives it.
2. **`convert-sme-input`** (skill) — turns the raw transcript/notes into a structured `.sources/sme-interview.md`.
3. **`cleanup-unused-screenshots`** (skill) — once the actual doc is written and references only some of the extracted screenshots, moves the rest into `_unused/` for manual review (never deletes).

## Locale translation pipeline

Translates a docs repo's approved Ukrainian pages into every further locale its `docusaurus.config` declares (all locales except the default and `en`), with no human review. Correctness comes from the mechanism, not from a reviewer:

1. **`ui-labels`** (script, no AI) imports the app's own translation dictionaries into a label store (`.doc-toolkit/ui-labels/`), checks at the start of a docs task whether the app's UI text changed, and patches renamed labels in the UA, EN and every locale page on the current branch. Every bold UI label in a translated page is the app's exact string in that locale. The procedure is `context/ui-labels.md`; the script's README documents the flags.
2. **`locale-sync`** (script, no AI) does everything that doesn't need a model: finds stale pages by git blob hashes against per-page state files, extracts exactly the changed UA blocks with their heading paths, records the label bindings and per-locale term memory, splices translated blocks back, links each locale's screenshots to the EN ones, checks every translated page (structure, code, anchors, labels, Ukrainian letters, markers) and records a page only when the checks pass. It also lists stray files a run leaves outside its roots, and warns about untranslated sidebar labels in `current.json`. See its README.
3. **`locale-translator`** (skill) / **`/translate-locales`** runs the sequence: label check, status (asks before more than 10 pages), the binding pass, the terminology pass, one translation worker per locale in parallel (`skills/locale-translator/worker.md`, rules in `context/locale-translation.md`), then a build and a per-page, per-locale report. It never commits; the user does. Corrections after a run (a wrong term, a label that needs another key) are redone block by block.

`doc-translator` (UA → EN) is unchanged and independent. A host project declares the app, the label source and, only where file names differ, the locale file map in its `CLAUDE.md` (`context/project-paths.md`, "Label store and locale translation"). State (`.doc-toolkit/pages/`, `terms/`, `ui-labels/`) lives in the host repo and is committed with the translations.

## Install into a project

Add to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "doc-writer-toolkit": {
      "source": {
        "source": "github",
        "repo": "VadymSachenko/doc-writer-toolkit"
      }
    }
  },
  "enabledPlugins": {
    "doc-writer-toolkit@doc-writer-toolkit": true
  }
}
```

Anyone opening the project in Claude Code will be prompted to trust it once; after that the skills and commands above are available without any local copies. Pull updates with `/plugin marketplace update`.
