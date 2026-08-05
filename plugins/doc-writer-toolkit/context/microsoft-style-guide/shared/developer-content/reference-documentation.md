---
id: MWSG-SHARED-REFERENCE-DOCS
title: Reference documentation
languages: [shared]
scope: structural
source_urls:
  - https://learn.microsoft.com/en-us/style-guide/developer-content/reference-documentation
captured: 2026-07-16
status: active
keywords: [reference, API, parameter, return value, syntax]
---

# Reference documentation

## Structure

Use a predictable template. Include applicable sections from this list:

1. Element name and type in the title; add a parent or technology qualifier when needed.
2. A concise description of what the element does or represents.
3. Declaration or syntax for each supported language.
4. Parameters, including type, direction, requirement, default, valid range, special
   values, and behavior when omitted.
5. Return value and the meaning of each possible condition.
6. Remarks for behavior, lifecycle, interactions, limits, side effects, and cautions.
7. A tested example.
8. Requirements or applicability.
9. Exceptions, errors, permissions, and security requirements.
10. Links to related elements and task guidance.

## Rules

- Do not repeat an identifier or type as its description.
- Describe behavior from the caller's perspective, not merely implementation details.
- State conditions precisely: what triggers behavior, what changes, and what is returned.
- Review generated comments before publishing; remove internal details and add missing
  customer-facing facts.
- Apply the same order, headings, and terminology across related elements.

**Recommended parameter description:** Optional path to the output directory. If
omitted, the command writes to the current directory.  
**Not recommended:** `outputPath`: String output path.

