---
description: Review a documentation page against a style/grammar guide corpus and report findings (no edits).
argument-hint: "<path> guide:<gdsg|mssg-en|mssg-ua|ua-grammar>"
---

Use the `doc-style-reviewer` skill to review a documentation page against the selected guide.

- **Arguments:** $ARGUMENTS
- Parse the leading path and the trailing `guide:<value>` token out of $ARGUMENTS.

The `guide:` argument selects the corpus:
- `gdsg` — Google Developer Style Guide (English)
- `mssg-en` — Microsoft Writing Style Guide (English)
- `mssg-ua` — Microsoft Ukrainian Localization Style Guide + UA grammar authority
- `ua-grammar` — Official Ukrainian orthography only (Український правопис 2019)

If `guide:` is not provided, or not one of these four values, ask before proceeding and list the options.

If the target file doesn't exist, stop and tell me before doing anything else.

Strictly follow the skill's workflow: pre-scan the doc, apply the language-mismatch guard, load only the routed corpus files, run the review, then report findings by severity tier.
