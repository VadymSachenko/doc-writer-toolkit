---
title: {Meta title in sentence case noun phrase—for example, Transaction lifecycle}
description: {Meta description—for example, Learn about how transactions flow through the Unicompay system}
last_update:
  date: {date in the m/d/yyyy format—for example, 2/22/2026}
---

{/*
TEMPLATE SCOPE: Concept topics explain background information and provide context-specific knowledge on a particular topic. The goal is to help readers understand a task or a feature, not to give step-by-step instructions.

PLACEHOLDER CONVENTIONS:
- {curly_braces}       = template placeholders for the writer to fill in. Remove before publishing.
- *`UPPER_CASE`*       = placeholders that remain in the published page for the reader to replace (per the style guide).

UNRESOLVED CONTENT: Use {/* ToDo: EXPLANATION */} for anything missing, unclear, or pending SME confirmation.

STRUCTURE PRINCIPLE: Concept topics don't have a fixed spine. Pick sections from the menu below that fit the topic. Only the overview is mandatory.
*/}

{/*
State the purpose of the document. Explain how the reader will benefit from reading it. Explain the background about the topic: what is it? Why do we have it? Why do users need it? Keep this to one or two paragraphs.
*/}

{Overview}

{/* Optional: Include Prerequisites only if readers need to understand other concepts or features before this one makes sense. Use cross-references, not duplicated content. */}
## Prerequisites

Before reading this document, review the following:

- [{Document title}](/link/to/document.md): {one-line reason the reader needs this context}
- [{Document title}](/link/to/document.md): {one-line reason the reader needs this context}

{/*
SECTION MENU: Choose the sections that fit the topic. All are optional. Use as many or as few as the topic needs. Apply admonition rules from the style guide (`formatting-and-organization.md`) for any :::note, :::info, :::warning, or :::tip blocks.

Common concept topic section types:

- "How it works" or phase-based sections (for example, "User-side flow" and "System-side flow" as siblings)
- "<Feature> page" — describes a UI page central to the concept, including a screenshot and a field list
- Rules, constraints, or configuration aspects — bullet list of things the reader must know to use the feature correctly
- A flow diagram — prefer Mermaid sequenceDiagram for multi-actor flows, Mermaid flowchart for decision trees
- Use case — one concrete, end-to-end scenario walked through in plain language. Useful for features with non-obvious interactions.
- Edge cases, restrictions, or limitations — often inside a :::info or :::warning admonition
- Terminology — if the concept introduces domain-specific terms, define them before using them in later sections
*/}

## {Section heading in sentence case noun phrase}

{Section content. Use real examples, diagrams, tables, and images. Do not include step-by-step instructions or procedures — those belong in a user guide.}

## {Additional section heading if needed}

{...}

{/* Optional: Include Next steps if the reader, after understanding this concept, would naturally move on to a related user guide to get started with the feature. */}
## Next steps

- [{User guide title}](/link/to/user-guide.md)
- [{User guide title}](/link/to/user-guide.md)

{/* Optional: Include Related documents for laterally relevant documents that are not user guides — other concept topics, reference pages, or architectural overviews. Use Next steps for user guides; use Related documents for everything else. Don't create both sections if only one applies. */}
## Related documents

- [{Document title}](/link/to/document.md)
- [{Document title}](/link/to/document.md)

{/*
===========================================================================
DESIGN RULES — DO NOT INCLUDE IN THE FINAL DOCUMENT
===========================================================================
*/}

## Design rules

### Purpose

- A concept topic **explains**, it doesn't **instruct**. Step-by-step instructions belong in a user guide.
- Only the overview is mandatory. Choose every other section by what the topic actually needs.
- Don't duplicate a user guide's content — link out to it via Next steps or Related documents instead.

### Admonitions

| Type | When to use |
|---|---|
| `:::note` | Useful but non-critical information |
| `:::info` | Process context, timing, clarifications |
| `:::warning` | Irreversible or risky situations |
| `:::tip` | An alternative path, a suggestion |

Admonitions supplement the text; they don't replace it.

### Diagrams

- Multi-actor processes → Mermaid `sequenceDiagram`.
- Decision trees → Mermaid `flowchart`.
- Render diagrams in Docusaurus; don't paste in a screenshot of one instead.

### "Next steps" vs. "Related documents"

- **Next steps**: user guides the reader would naturally move to after understanding the concept.
- **Related documents**: other concept topics, API references, architectural overviews.
- If only one applies, don't create the other.

### Terminology and formatting

- Terms come from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md`.
- Expand an abbreviation at its first mention: "API token (Application Programming Interface)"; use the short form after that.
- UI labels, status values, placeholders, and code-vs-concept rendering follow `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` (Ж1–Ж7) — don't restate those rules here.