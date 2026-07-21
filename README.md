# doc-writer-toolkit

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) with skills, commands, and content rules for writing product documentation on Docusaurus sites. Built to be installed once per project instead of copy-pasted between repos.

## What's in the plugin

`plugins/doc-writer-toolkit/`:

- **`skills/`** — mechanics for writing and maintaining docs: `api-doc-writer`, `user-guide-writer`, `concept-doc-writer`, `doc-translator`, `doc-alignment-checker`, `convert-sme-input`. These are generic — they don't hardcode a product name or brand.
- **`commands/`** — slash-command wrappers around the skills above (`/create-api-doc`, `/translate-doc`, `/check-doc-alignment`, `/fix-doc-todos`).
- **`context/doc-rules/`** — style guide, Ukrainian grammar reference (`ua-grammar/`, product-agnostic), and `project-rules/` (glossary, product-integration context — currently UCPay-specific).
- **`context/doc-templates/`** — page templates for API reference pages, user guides, and concept topics.

### Generic vs. product-specific

The skills and most of `doc-rules/` (grammar, style guide) are reusable as-is for any Docusaurus documentation project. `context/doc-rules/project-rules/glossary-*.md`, `api-integration-context.md`, `context/doc-rules/doc-examples/`, and `context/doc-templates/` currently carry UCPay-specific terminology and examples. If a second, unrelated product ever needs this toolkit with different terminology, that seam is where to split into a second plugin — the skills already reference everything through `${CLAUDE_PLUGIN_ROOT}`, so no skill logic would need to change.

## `tools/`

Standalone utilities that support the skills above but aren't Claude Code plugin components (they have real system dependencies, so they're not auto-loaded — run them manually):

- **`sme-video-context/`** — turns a meeting recording into an LLM-readable package (timestamped transcript, deduplicated screenshots, OCR, transcript-to-image alignment). Feeds the `convert-sme-input` skill's raw material. Requires `ffmpeg`, `tesseract`, and a Python venv — see its own `README.md`.

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
