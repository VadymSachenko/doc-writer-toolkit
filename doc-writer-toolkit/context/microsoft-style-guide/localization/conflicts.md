---
id: MWSG-LOC-CONFLICTS
title: Localization conflict resolution
languages: [en-US, uk-UA]
scope: structural
content_types: [localization]
captured: 2026-07-16
status: active
keywords: [conflict, precedence, terminology]
---

# Localization conflict resolution

Resolve a conflict in this order:

1. Preserve product behavior, legal meaning, identifiers, code, tags, and placeholders.
2. Follow an explicit project requirement or approved current product term.
3. For Ukrainian grammar, spelling, morphology, syntax, and punctuation, use
   `../uk-ua/grammar-authority.md`.
4. For Ukrainian localization behavior, use the `../uk-ua/` rule matching the content
   type.
5. Apply shared Microsoft principles at the intent level.
6. Use English-only rules only for English output.

If two sources remain equally authoritative, record the exact terms, contexts, dates,
and chosen resolution in `../maintenance/unresolved-items.md`; do not silently blend
them.
