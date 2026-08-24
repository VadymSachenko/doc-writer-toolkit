---
id: MWSG-SHARED-ACCESSIBLE-WRITING
title: Writing for all abilities
languages: [shared]
scope: structural
source_urls:
  - https://learn.microsoft.com/en-us/style-guide/accessibility/accessibility-guidelines-requirements
  - https://learn.microsoft.com/en-us/style-guide/accessibility/writing-all-abilities
captured: 2026-07-16
status: active
keywords: [accessibility, screen reader, links, headings, alternative input]
---

# Writing for all abilities

## Rules

### MWSG-A11Y-001 — Default to people-first language

Refer to the person before a disability unless a known audience or individual prefers
identity-first language. Use the person's stated preference when writing about a real
person. Mention a disability only when relevant.

### MWSG-A11Y-002 — Make text easy to hear and scan

- Put important information first.
- Keep paragraphs short and sentence structures simple.
- Prefer one main action per sentence.
- Use parallel structures for related headings and list items.
- Read the text aloud and consider how a screen reader will announce it.

### MWSG-A11Y-003 — Use meaningful links

Write link text that identifies its destination without surrounding context. Avoid
generic labels such as *click here* and *learn more* when a specific label is possible.
Do not rely on color alone to distinguish links.

**Recommended:** [Configure multifactor authentication](#)  
**Not recommended:** For configuration details, [click here](#).

### MWSG-A11Y-004 — Encode structure as structure

Use heading levels, real lists, and accessible tables instead of visual formatting that
only resembles them. Introduce a table briefly and use specific column headings.

### MWSG-A11Y-005 — Do not rely on direction alone

Do not identify content only as *above*, *below*, *left*, or *right*. Add a named
landmark, control, heading, or sequence position.

**Recommended:** In the **Account** pane, select **Security**.  
**Not recommended:** Select the option on the left.

### MWSG-A11Y-006 — Support alternative input

Document every supported interaction method when it matters. In shared procedures,
prefer device-neutral verbs such as *select* or *choose* over mouse-only or touch-only
verbs. Document keyboard shortcuts and other supported alternatives.

### MWSG-A11Y-007 — Prefer words over ambiguous symbols

Spell out connective words when symbols might be skipped or misread by assistive
technology. Use a symbol when it is part of code, UI, a standard name, or an established
notation and explain unfamiliar uses.

### MWSG-A11Y-008 — Avoid forced line breaks

Do not insert hard returns inside sentences or paragraphs to control visual wrapping.
They break when text is resized, translated, or displayed in a different viewport.

