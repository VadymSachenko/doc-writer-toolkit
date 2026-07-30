---
id: GDSG-TECH-MARKUP
title: HTML, Markdown, and semantic tagging
languages: [en-US]
scope: structural
content_types: [web-source, markdown, html]
source_urls:
  - https://developers.google.com/style/semantic-tagging
  - https://developers.google.com/style/html-formatting
  - https://developers.google.com/style/markdown
captured: 2026-07-16
status: active
keywords: [HTML, Markdown, semantic, accessibility, tags]
---

# HTML, Markdown, and semantic tagging

## GDSG-MARKUP-001 — Encode meaning, not appearance

Choose an element for its semantic meaning and use CSS for presentation. Preserve a
logical heading hierarchy, real lists, table headers, labels, and other relationships
that assistive technology can interpret. Do not simulate a heading with bold text or a
list with manually typed symbols.

## HTML source

- Use lowercase element and attribute names.
- Indent nested content with two spaces unless the project formatter requires otherwise.
- Keep lines near 80 characters where practical without damaging readability.
- Quote attribute values and write valid, well-nested markup.
- Use `<code>` for inline code, `<pre><code>` for blocks, `<var>` for variables, `<kbd>`
  for keys, `<b>` for named UI labels, and `<em>` only for semantic emphasis.
- Add accessible names, alt text, labels, captions, and ARIA only where native semantics
  do not already provide the relationship.

## Markdown versus HTML

Prefer Markdown for straightforward prose, headings, lists, links, and code because it is
easy to maintain. Use HTML when Markdown cannot express the necessary semantics,
accessibility, or publishing behavior. Follow the repository’s supported Markdown flavor;
do not assume every extension renders everywhere.

Inspect the rendered result for heading levels, list nesting, tables, inline HTML, code
fences, and link targets.

