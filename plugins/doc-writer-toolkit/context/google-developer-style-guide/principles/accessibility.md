---
id: GDSG-PRINCIPLES-ACCESSIBILITY
title: Write accessible documentation
languages: [en-US]
scope: structural
content_types: [all, web, tutorial, reference]
source_urls: [https://developers.google.com/style/accessibility]
captured: 2026-07-16
status: active
keywords: [accessibility, screen reader, keyboard, alt text, semantic HTML, directional language]
---

# Write accessible documentation

## Language and structure

- Use plain language, short sentences, active voice, and unambiguous pronouns.
- Avoid double negatives. Do not identify an element only by a visual cue such as
  *the green button*; see GDSG-A11Y-001 for direction.
- Put prerequisites and preparation information before the task.
- Use descriptive, hierarchical headings; do not skip heading levels.
- Keep link text meaningful out of context. Do not use *click here* or a bare URL.
- Use ordered lists for sequences and unordered lists for collections; preserve clear
  nesting and parallel syntax.

## GDSG-A11Y-001 — Don't orient the reader by direction

Don't use directional language to orient the reader, such as *above*, *below*, or
*right-hand side*. It fails screen readers, and right-to-left layouts mirror the page.
This is not a "not the only clue" rule: the direction is dropped even when another cue
is present.

- For a UI element, name its label and the place it is in: the page, dialog, pane, tab,
  or toolbar. If an element is hard to find, provide a screenshot.
- For a position in the document, use *earlier*, *preceding*, or *following*.
- Don't use color, size, location, or another visual cue as the primary way to convey
  information.

**Recommended:** In the preceding diagram, clients run jobs on clusters.  
**Recommended:** Click **Menu**.  
**Not recommended:** In the diagram above, clients run jobs on clusters.  
**Not recommended:** In the left-side panel, click the button with three lines.

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
- Name a control by its visible label, and locate it by the page, dialog, pane, or
  toolbar it is in, not by direction (GDSG-A11Y-001), color, or shape.
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
