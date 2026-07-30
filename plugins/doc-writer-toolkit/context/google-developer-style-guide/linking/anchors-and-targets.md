---
id: GDSG-LINKING-TARGETS
title: Heading targets and anchors
languages: [en-US]
content_types: [web, reference]
source_urls:
  - https://developers.google.com/style/headings-targets
captured: 2026-07-16
status: active
keywords: [anchor, fragment, heading ID, deep link]
---

# Heading targets and anchors

- Link to the relevant section heading when the publishing system provides a stable
  generated target.
- Add an explicit custom anchor when a durable external target is needed or a generated
  heading ID can change.
- Make anchor IDs unique, short, descriptive, lowercase, and stable according to the
  project’s publishing rules.
- Do not reuse a removed anchor for unrelated content.
- When linking to another section on the same page, tell the reader the link stays on the
  current page (for example, "see the [Code in text](#code-in-text) section of this
  document") rather than phrasing it like an external reference.
- When a heading or anchor changes, update inbound links or preserve a compatible alias.
- Test the final fragment link in the rendered output, not only in source.

