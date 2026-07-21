---
title: {Meta title in bare infinitive, imperative mood, for example, Manage abstract products}
description: {Meta description}
last_update:
  date: {date in the m/d/yyyy format, for example, 2/22/2026}
---

{/* 
TEMPLATE SCOPE: User guides describe how to accomplish a task. They are procedural (step-by-step), not conceptual. For background and context, use the concept topic template.

PLACEHOLDER CONVENTIONS:
- {curly_braces}       = template placeholders for the writer to fill in. Remove before publishing.
- *`UPPER_CASE`*       = placeholders that remain in the published page for the reader to replace (per the style guide).

UNRESOLVED CONTENT: Use {/* ToDo: EXPLANATION */} for anything missing, unclear, or pending SME confirmation.

HEADING LEVEL RULES:
- Single task per guide: task heading is H2; its Reference information heading is H2.
- Single task split into multiple phases: each phase is its own H2 under the task; Reference information comes once at the end of the task as H2.
- Multiple task topics per guide: each task heading is H2; each Reference information heading is H3 under its task.

HEADING MOOD RULES:
- Task headings: bare infinitive, imperative mood (Create branches, Edit a link, Delete users).
- Phase sub-section headings (inside a single-task guide with phases): bare infinitive, imperative mood (Enter branch details, Configure screen settings). Do not use noun phrases for phases.
- Reference information headings: bare infinitive, imperative mood (Reference information: Create a branch).

SCREENSHOTS: Place screenshots in `./assets/` next to the document. Reference them as `./assets/<screenshot-name>.png`. The filename comes from the uploaded screenshot name.

ICONS IN STEPS: Use the Docusaurus `<Icon>` component to represent UI buttons or actions that are shown as icons only (copy, delete, drag handle, edit pencil, expander arrow). Place the `<Icon>` immediately before the bold action name: `<Icon icon="ic:sharp-edit" height="24" style={{ color: '#9564ff' }} /> **Edit**`. When the UI element has a text label, use bold text alone without an icon. Don't describe icons in words ("the pencil icon") — either show the icon or use the action name.
*/}

This guide describes how to {task, for example, manage} [{entity}s](/link/to/the/feature-overview.md).

{/* Replace "a/an {entity}" throughout the document with the correct article and entity name when filling in the template. */}

## Prerequisites

{/* Optional: Use Prerequisites only for actions that must be completed in a different area of the product before the reader can perform the tasks on this page. Do not duplicate content from the concept topic or other user guides — link to them instead. */}

{List any prerequisites here. Omit this section entirely if none apply.}

{/* Reference information prompt: use one of the following two sentences, depending on whether the guide has one or multiple Reference information sections. Delete whichever does not apply. */}

{/* Variant A — single Reference information section in the guide: */}
Before you start, review the reference information, or look up the necessary information as you go through the process.

{/* Variant B — multiple Reference information sections in the guide: */}
Each section contains reference information. Review it before you start, or look up the necessary information as you go through the process.

{/*
===========================================================================
VARIANT 1 — SINGLE TASK, SINGLE PHASE
Use this shape when the guide covers one task with no distinct phases. Both the task heading and the Reference information heading are H2.
===========================================================================
*/}

## {Task} a/an {entity} {/* bare infinitive, imperative mood, for example, Create a branch */}

To {task} a/an {entity}:

1. {First step.}
2. {Step with substeps.}
   1. {Substep.}
   2. {Substep.}
3. {Step that references a screenshot.}

   ![{Descriptive alt text}](./assets/{screenshot-name}.png)

4. {Final step.}

{/* Optional: Omit Reference information if the task has no meaningful attributes to describe (for example, simple delete actions). You can tell this from the provided screenshots — if the UI has no form fields or configurable options, the section is not needed. */}
## Reference information: {Task} a/an {entity}

The following table describes the attributes you enter and select when {task-ing} a/an {entity}:

| Attribute | Description |
|---|---|
| {attribute name} | {attribute description} |

{/*
===========================================================================
VARIANT 2 — SINGLE TASK, MULTIPLE PHASES
Use this shape when the guide covers one task split into distinct configuration phases (for example, a creation task with separate Info, Settings, and Permissions tabs). Each phase is its own H2. Reference information comes once at the end of the task, covering attributes across all phases, as H2.
Delete the other variants if using this one.
===========================================================================
*/}

This guide describes how to {task, for example, create} [{entity}s](/link/to/the/feature-overview.md).

{Task} creation involves several steps:

1. **{Phase 1 name}**: {one-line description of what this phase covers}.
2. **{Phase 2 name}**: {one-line description of what this phase covers}.

## {Phase 1} {/* bare infinitive, imperative mood, for example, Enter branch details */}

1. {First step of phase 1.}
2. {Step with substeps.}
   1. {Substep.}
   2. {Substep.}

   ![{Descriptive alt text}](./assets/{screenshot-name}.png)

3. {Final step of phase 1.}

## {Phase 2} {/* bare infinitive, imperative mood */}

1. {First step of phase 2.}
2. {Step that references a screenshot.}

   ![{Descriptive alt text}](./assets/{screenshot-name}.png)

3. {Final step of phase 2.}

{/* Optional: Omit Reference information if the task has no meaningful attributes to describe. One combined Reference information section covers all phases. */}
## Reference information: {Task} a/an {entity}

{/* If attributes naturally split across phases, use H3 subsections here: ### {Phase 1} tab, ### {Phase 2} tab, etc. Otherwise use a single flat table. */}

### {Phase 1} tab

| Attribute | Description |
|---|---|
| {attribute name} | {attribute description} |

### {Phase 2} tab

| Attribute | Description |
|---|---|
| {attribute name} | {attribute description} |

{/*
===========================================================================
VARIANT 3 — MULTIPLE TASKS
Use this shape when the guide covers more than one task. Task headings are H2; their Reference information headings are H3.
Delete the other variants if using this one.
===========================================================================
*/}

## {Task 1} {entities} {/* bare infinitive, imperative mood, for example, Create branches */}

To {task} a/an {entity}:

1. {First step.}
2. {Step with substeps.}
   1. {Substep.}
   2. {Substep.}

   ![{Descriptive alt text}](./assets/{screenshot-name}.png)

3. {Final step.}

{/* Optional: Omit the Reference information subsection below if this task has no meaningful attributes to describe. */}
### Reference information: {Task 1} a/an {entity}

The following table describes the attributes you enter and select when {task 1-ing} a/an {entity}:

| Attribute | Description |
|---|---|
| {attribute name} | {attribute description} |

## {Task 2} {entities}

To {task} a/an {entity}:

1. ...

{/* Optional: same rule applies for this task's Reference information subsection. */}
### Reference information: {Task 2} a/an {entity}

| Attribute | Description |
|---|---|
| {attribute name} | {attribute description} |

{/*
===========================================================================
END OF STRUCTURE VARIANTS
===========================================================================
*/}

## Next steps

{/* List related user guides the reader can use next. For laterally related non-user-guide documents, use a concept topic's Related documents pattern instead. */}

- [{User guide title}](/link/to/user-guide.md)
- [{User guide title}](/link/to/user-guide.md)