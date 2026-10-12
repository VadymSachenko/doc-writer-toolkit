---
id: GDSG-PRINCIPLES-JARGON-PRESCRIPTIVE
title: Jargon and prescriptive documentation
languages: [en-US]
scope: mixed
language_specific_sections:
  - "Prescriptive documentation"
content_types: [all, tutorial, guide, recommendation]
source_urls:
  - https://developers.google.com/style/jargon
  - https://developers.google.com/style/prescriptive-documentation
captured: 2026-07-16
status: active
keywords: [jargon, must, should, can, might, recommendation]
---

# Jargon and prescriptive documentation

## Jargon

- Replace group-specific shorthand with plain, precise language when possible.
- If readers need a specialized term, define it at first use or link to a trustworthy
  definition, then use it consistently.
- Do not obscure a familiar technical term solely to avoid jargon; accuracy and the
  audience’s established vocabulary still matter.
- If jargon appears in required code or a command, preserve the literal value and
  explain it in ordinary prose.

## Prescriptive documentation

- Recommend the clearest path for the most relevant use case instead of presenting
  every possible option with equal weight.
- Use an imperative for a required procedural action.
- Use **must** for a requirement, **can** for permission or ability, and **might** for
  a possible outcome.
- Avoid ambiguous **should** in prescriptive content. Use **we recommend** for a
  recommendation or state the actual requirement.
- Distinguish an actual state, a required state, an expected outcome, and a merely
  possible outcome.

**Recommended:** Set the region before you create the instance.  
**Not recommended:** You should probably set the region first.

Sources: Google Developer Documentation Style Guide, “Jargon” and “Prescriptive documentation.”
