# doc-writer-toolkit

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) with skills, commands, and content rules for writing product documentation on Docusaurus sites. Built to be installed once per project instead of copy-pasted between repos.

## What's in the plugin

`plugins/doc-writer-toolkit/`:

- **`skills/`** — mechanics for writing and maintaining docs: `api-doc-writer`, `user-guide-writer`, `concept-doc-writer`, `doc-translator`, `doc-alignment-checker`, `convert-sme-input`, `extract-sme-screenshots`, `cleanup-unused-screenshots`. These are generic — they don't hardcode a product name or brand.
- **`commands/`** — slash-command wrappers around the skills above (`/create-api-doc`, `/translate-doc`, `/check-doc-alignment`, `/fix-doc-todos`).
- **`context/doc-rules/`** — style guide, Ukrainian grammar reference (`ua-grammar/`, product-agnostic), and `project-rules/` (glossary, product-integration context — currently UCPay-specific).
- **`context/doc-templates/`** — page templates for API reference pages, user guides, and concept topics.
- **`scripts/`** — non-skill utilities that plugin skills shell out to (see below).

### Generic vs. product-specific

The skills and most of `doc-rules/` (grammar, style guide) are reusable as-is for any Docusaurus documentation project. `context/doc-rules/project-rules/glossary-*.md`, `api-integration-context.md`, `context/doc-rules/doc-examples/`, and `context/doc-templates/` currently carry UCPay-specific terminology and examples. If a second, unrelated product ever needs this toolkit with different terminology, that seam is where to split into a second plugin — the skills already reference everything through `${CLAUDE_PLUGIN_ROOT}`, so no skill logic would need to change.

## SME video pipeline

Three pieces work together to turn a meeting recording into a documented page:

1. **`extract-sme-screenshots`** (skill) — given a video (+ optional transcript) in a `.sources/` folder, extracts deduplicated screenshots into `.sources/{video-basename}-screenshots/`, auto-transcribing via Whisper if no transcript was supplied. Shells out to `plugins/doc-writer-toolkit/scripts/sme-video-context/sme_video_context.py`, which needs `ffmpeg`, `tesseract`, and a Python venv (`Pillow` + `imagehash` always, `faster-whisper` only when transcribing) — see that script's own `README.md`. It's not a plugin component itself (real system dependencies, not auto-loaded); the skill drives it.
2. **`convert-sme-input`** (skill) — turns the raw transcript/notes into a structured `.sources/sme-interview.md`.
3. **`cleanup-unused-screenshots`** (skill) — once the actual doc is written and references only some of the extracted screenshots, moves the rest into `_unused/` for manual review (never deletes).

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
