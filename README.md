# doc-writer-toolkit

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) with skills, commands, and content rules for writing product documentation on Docusaurus sites. Built to be installed once per project instead of copy-pasted between repos.

## What's in the plugin

`plugins/doc-writer-toolkit/`:

- **`skills/`** — 18 skills for writing and maintaining docs. See [`SKILLS-INDEX.md`](plugins/doc-writer-toolkit/SKILLS-INDEX.md) for the canonical list. Skills are generic — they don't hardcode a product name, brand, style guide, or host project's folder layout; project-specific choices (which style guide, where UA/EN content live) are declared once in the host project's own `CLAUDE.md` and resolved from there (see `context/style-guide-registry.md` and `context/project-paths.md`).
- **`commands/`** — 14 slash-command wrappers around the skills above. See [`SKILLS-INDEX.md`](plugins/doc-writer-toolkit/SKILLS-INDEX.md) for the full command list.
- **`context/style-guide-registry.md`** — the single source of truth for the four `guide:` tokens (`gdsg`/`mssg-en`/`mssg-ua`/`ua-grammar`), their corpus/router, and the procedure every skill uses to resolve a host project's declared guide (or ask once, if none is declared). Referenced by `doc-style-reviewer` and every drafting skill — never copied.
- **`context/project-paths.md`** — the same pattern for a host project's UA content root, EN i18n root, UA URL prefix, which root pair a page belongs to, and its product kit. Referenced by `doc-translator`, `doc-alignment-checker`, and the UA-drafting skills — never copied.
- **`context/locale-translation.md`**, **`context/ui-labels.md`**, **`context/changed-blocks.md`** — shared rules and procedures of the locale translation pipeline (see below): how to translate into the further locales, how the UI label check runs at the start of a docs task, and what "the changed part of a page" means. Referenced by `locale-translator`, `doc-translator`, `doc-page-updater` and the writer skills — never copied.
- **`context/doc-rules/`** — Ukrainian grammar reference (`ua-grammar/`), `project-rules/` (formatting, link, heading, naming and screenshot conventions), and `glossary-format.md` (how a host's glossary table is read). All product-agnostic.
- **`context/starter-kit/`** — neutral skeletons for a host's product kit: two glossaries, product facts and product rules (see below).
- **`context/google-developer-style-guide/`** — complete distilled corpus of the public Google Developer Documentation Style Guide (121 files), with routed loading for token efficiency.
- **`context/microsoft-style-guide/`** — complete distilled corpus of the Microsoft Writing Style Guide (English + Ukrainian localization, 168 files), with routed loading for token efficiency.
- **`context/doc-templates/`** — page templates for API reference pages, user guides, and concept topics, with neutral examples. A host can override one in its product kit.
- **`scripts/`** — non-skill utilities that plugin skills shell out to: `ui-labels/` and `locale-sync/` (Node, no dependencies, tested with `npm test`) for the locale translation pipeline, `doc-align/` (Node, no dependencies, tested with `npm test`) for the structural counts of `doc-alignment-checker`, `screenshot-locales/` (Node, no dependencies, tested with `npm test`) for screenshots in every declared UI language, `section-state/` (Node, no dependencies, tested with `npm test`) for the ledger of `document-section`, and `sme-video-context/` (Python) for the SME video pipeline.

### Generic vs. product-specific

The plugin carries no product content. Each host project keeps its own **product kit**: a visible folder in its repo, outside every content root, declared in its `CLAUDE.md`:

```md
- **Product kit:** `doc-kit/`
```

The kit holds `glossary-ua.md` and `glossary-en.md` (the approved terms and their render), `product-facts.md` (background facts the writers read), `product-rules.md` (rules for that product only, such as its name and key terms) and, optionally, `templates/` with a host version of a plugin template under the same file name. The glossaries and `product-rules.md` are rank 0, like the plugin's formatting conventions; `product-facts.md` is background. With no kit declared, skills run without a glossary, product facts or product rules and say so; a declared kit folder that is missing stops the run. To start a kit, copy `context/starter-kit/` by hand and fill it in. `context/project-paths.md` ("Product kit") is the procedure.

`context/doc-templates/` keeps neutral examples. `context/doc-rules/doc-examples/` is *not* product-specific either: its worked examples are unrelated third-party content (a public API reference, an unrelated SaaS product's docs), kept only as a generic prose voice/density reference. Don't treat it as a source of product facts or terminology.

## SME video pipeline

Three pieces work together to turn a meeting recording into a documented page:

1. **`extract-sme-screenshots`** (skill) — given a video (+ optional transcript) in a `.sources/` folder, extracts deduplicated screenshots into `.sources/frames/{video-basename}-frames/`, auto-transcribing via Whisper if no transcript was supplied. Shells out to `plugins/doc-writer-toolkit/scripts/sme-video-context/sme_video_context.py`, which needs `ffmpeg`, `tesseract`, and a Python venv (`Pillow` + `imagehash` always, `faster-whisper` only when transcribing) — see that script's own `README.md`. It's not a plugin component itself (real system dependencies, not auto-loaded); the skill drives it.
2. **`convert-sme-input`** (skill) — turns the raw transcript/notes into a structured `.sources/sme-interview.md`.
3. **`cleanup-unused-screenshots`** (skill) — once the actual doc is written and references only some of the extracted screenshots, moves the rest into `_unused/` for manual review (never deletes).

## Section pipeline

`section-readiness`, `app-explorer`, `section-planner` and `resolve-markers` each move one section folder a step forward. **`document-section`** (skill) / **`/document-section`** chains them with the writers, the style fixer and reviewer, `doc-translator` and `doc-alignment-checker`, from the readiness check to UA pages approved and EN pages translated and aligned. It stops at the approval gates: the plan (never pre-approved), the writers' own interviews, and UA approval, after which it asks the user to commit before translating. It keeps a ledger in `.sources/section-state.json` through the `section-state` script, checks it against the files on every invoke, and resumes where a run stopped. It never commits, deletes or moves a page, and never edits the sidebar. Further locales (`/translate-locales`) and screenshot cleanup are suggested in its final report, and API reference pages in the plan are listed there for a separate `api-doc-writer` run.

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

Anyone opening the project in Claude Code will be prompted to trust it once; after that the skills and commands above are available without any local copies. To install it for yourself only, run `/plugin install doc-writer-toolkit@doc-writer-toolkit` after adding the marketplace.

The plugin has no version number, so an install tracks this repository's commits. With auto-update on for the marketplace (`/plugin` → Marketplaces), new commits on `main` arrive by themselves; otherwise run `claude plugin update doc-writer-toolkit@doc-writer-toolkit` and restart Claude Code.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). The regression set (`node tools/regression.mjs`) runs in CI on every pull request.
