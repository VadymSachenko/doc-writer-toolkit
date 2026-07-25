---
id: GDSG-PRINCIPLES-ACCESSIBILITY
title: Write accessible documentation
languages: [en-US]
content_types: [all, web, tutorial, reference]
source_urls: [https://developers.google.com/style/accessibility]
captured: 2026-07-16
status: active
keywords: [accessibility, screen reader, keyboard, alt text, semantic HTML]
---

# Write accessible documentation

## Language and structure

- Use plain language, short sentences, active voice, and unambiguous pronouns.
- Avoid double negatives and visual-only directions such as *above*, *below*,
  *right*, or *the green button*.
- Put prerequisites and preparation information before the task.
- Use descriptive, hierarchical headings; do not skip heading levels.
- Keep link text meaningful out of context. Do not use *click here* or a bare URL.
- Use ordered lists for sequences and unordered lists for collections; preserve clear
  nesting and parallel syntax.

## Images and media

- Provide concise alt text for informative images. Use empty alt text for a purely
  decorative image.
- Explain complex diagrams in nearby text or a figure description; alt text is not a
  substitute for a long technical explanation.
- Do not put essential prose, code, or terminal output only in an image.
- For video or audio, provide captions or a transcript and do not rely on audio or
  color alone.

## Interfaces and interaction

- Use semantic controls and elements. Keep interaction available by keyboard.
- Name a control by its visible label and provide enough context to locate it without
  relying only on direction, color, shape, or position.
- Introduce an expandable or otherwise interactive element before it appears.
- Ensure forms have explicit labels and useful instructions; do not use placeholder
  text as the only label.
- Avoid custom CSS or JavaScript that breaks zoom, reflow, keyboard focus, contrast,
  or assistive-technology semantics.

## Tables

- Use tables only for genuinely tabular relationships.
- Provide clear header cells and a simple structure. Avoid merged cells, layout tables,
  and tables that require horizontal scanning when a list would work.
- Introduce a table and summarize any conclusion that readers should not have to
  infer visually.

Source: Google Developer Documentation Style Guide, “Write accessible documentation.”
