# Local Google developer documentation style rules

This library distills the public Google Developer Documentation Style Guide into
small, task-routed Markdown files for Claude and Codex skills.

## Scope

- Voice, accessibility, inclusion, global readiness, precision, and timelessness.
- US English grammar, punctuation, formatting, and content organization.
- Procedures, UI documentation, API reference comments, code, commands, and
  placeholders.
- Linking, images, HTML, Markdown, product names, filenames, trademarks, and safe
  example data.
- The complete public word list, consolidated into compact terminology chunks.

## How an AI should use this library

1. Read `ROUTING.md`.
2. Determine the task, content type, and applicable product scope.
3. Load only the files selected by the router.
4. Search a terminology index before opening an A–Z chunk.
5. Resolve conflicts through `AUTHORITY-AND-PRECEDENCE.md`.
6. Apply Android- or Google Cloud-specific guidance only in that scope.

Do not load the full manifest, source map, all terminology indexes, or all rule files
into model context.

## Main indexes

- `ROUTING.md` — task router.
- `RULE-INDEX.md` — searchable rule-file index.
- `manifest.json` — machine-readable rule metadata.
- `terminology/INDEX.md` — compact terminology router.
- `maintenance/source-map.md` — human-readable page coverage and provenance.
- `source-map.json` — machine-readable page coverage and provenance.
- `maintenance/qa-report.md` — coverage and integrity results.

## Source policy

The library contains concise paraphrases and reduced examples, not website mirrors.
Source pages are attributed to the [Google Developer Documentation Style Guide](https://developers.google.com/style),
whose pages identify their prose as licensed under CC BY 4.0. Temporary source HTML
is not retained in the final library.

Snapshot date: 2026-07-16. Current guidance verified through the July 7, 2026 update.
