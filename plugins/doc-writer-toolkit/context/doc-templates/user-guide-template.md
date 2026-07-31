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

SCREENSHOTS: Place screenshots in `./.assets/` next to the document. Reference them as `./.assets/<screenshot-name>.png`. The filename comes from the uploaded screenshot name.

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

   ![{Descriptive alt text}](./.assets/{screenshot-name}.png)

4. {Final step.}

{/* Every procedure ends with a Result statement — don't omit it, and don't wrap it in an admonition (never :::tip[success]). If the outcome is confirmed asynchronously (webhook, email, delayed status update), follow it with a :::info admonition describing the follow-up. */}
**Result:** {What the reader sees once the task is complete.}

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

   ![{Descriptive alt text}](./.assets/{screenshot-name}.png)

3. {Final step of phase 1.}

{/* Every phase ends with a Result statement, including one that hands off to the next phase — not just the final one. */}
**Result:** {What the reader sees once this phase is complete.} Continue to **{Phase 2}**.

## {Phase 2} {/* bare infinitive, imperative mood */}

1. {First step of phase 2.}
2. {Step that references a screenshot.}

   ![{Descriptive alt text}](./.assets/{screenshot-name}.png)

3. {Final step of phase 2.}

**Result:** {What the reader sees once the task is complete.}

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

   ![{Descriptive alt text}](./.assets/{screenshot-name}.png)

3. {Final step.}

**Result:** {What the reader sees once this task is complete.}

{/* Optional: Omit the Reference information subsection below if this task has no meaningful attributes to describe. */}
### Reference information: {Task 1} a/an {entity}

The following table describes the attributes you enter and select when {task 1-ing} a/an {entity}:

| Attribute | Description |
|---|---|
| {attribute name} | {attribute description} |

## {Task 2} {entities}

To {task} a/an {entity}:

1. ...

**Result:** {What the reader sees once this task is complete.}

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

{/*
===========================================================================
DESIGN RULES — DO NOT INCLUDE IN THE FINAL DOCUMENT
===========================================================================
*/}

## Design rules

### Choosing a structure

- **Variant 1 (single task, single phase)** — one task, no distinct phases (for example, filter transactions, view details, cancel a transaction).
- **Variant 2 (single task, multiple phases)** — one task split into ordered configuration phases with pauses or checkpoints between them (for example, a creation flow with separate Info/Settings/Permissions tabs).
- **Variant 3 (multiple tasks)** — more than one independent task belongs on this page, each performed on its own.
- Don't mix variants on one page. If a single task's steps run past roughly ten with no natural phase boundaries, it's still Variant 1 — phase-splitting is for logical pauses and checkpoints, not step count alone.

### Heading levels

- Single task per guide: the task heading is H2; its Reference information heading is H2.
- Single task split into multiple phases: each phase is its own H2 under the task; Reference information comes once at the end, as H2.
- Multiple task topics per guide: each task heading is H2; each Reference information heading is H3 under its task.
- Task and phase headings: bare infinitive, imperative mood. Reference information headings: bare infinitive too ("Reference information: Create a branch").

### Introductory sentences

- If the task/phase heading already conveys the action, don't add an intro sentence before the steps.
- If an intro is needed, write it as plain (non-bold) text ending in a colon: "To {goal}, do the following:".
- Never bold the intro sentence.

### Prerequisites

- List only conditions common to **every** task/phase on the page. A condition specific to one task belongs inside that task's own description, not in the shared Prerequisites section.
- "You're signed in to the partner cabinet" is never listed — it's assumed.
- Always include the reference-information prompt sentence (Variant A for a single Reference information section, Variant B for multiple) — don't invent new wording for it.

### The Result block

- Every task, and every phase within a multi-phase task, ends with a **Result** statement describing the outcome — it doesn't repeat the steps.
- Never wrap it in an admonition (never `:::tip[success]`). If the outcome is confirmed asynchronously (webhook, email, delayed status update), follow the Result paragraph with a `:::info` admonition describing the follow-up.
- In a multi-phase task, every phase but the last hands off to the next one by name; the last phase's Result states the overall outcome.

### Optional blocks

Don't add a block with nothing substantive in it:

| Block | Include when |
|---|---|
| Reference information | The task has form fields or configurable options worth describing |
| Next steps | There's a related user guide the reader would naturally move to |

### Procedure steps

- A step is one logical user action, not necessarily one click. "Find X" immediately before an action on that same X isn't its own step — merge it into the next step. ✅ "In the receipts list, find the file and click **Upload**." ⛔ "Find the file in the receipts list." as its own step, followed by "Click **Upload**." as the next.
- Order within a step: location → action. ✅ "In the **Receipts** window, click..." ⛔ "Click... in the **Receipts** window."
- A confirmation step inside a dialog: action → reason (the opposite of the goal → action rule, which is about the operation's actual goal, not a secondary confirmation of something already stated). ✅ "In the **Delete file** window, click **Delete** to confirm." ⛔ "To confirm the deletion, in the **Delete file** window, click **Delete**."
- Outside those two cases: one step, one independent action.
- A system reaction ("The form opens.") stays on the same line after the step's period — it isn't its own bullet.
- A screenshot under a step only when it helps identify an element or confirm a result — not mechanically after every step.
- **Voice:** the UI element isn't the subject of the action; the action happens to the object. ✅ "Transactions appear in the table." ⛔ "The table displays transactions." Applies to Result blocks too.
- **Links to Reference information** inside a step: inline, in the relevant phrase — not a separate sentence. ✅ "select the [filters](#reference-information) you need." ⛔ "For more on each filter, see **Reference information**."

### Screenshots

- Store screenshots in `./.assets/` next to the document.
- Add one only when it: (1) confirms a result, (2) helps locate a hard-to-find UI element, (3) illustrates a non-obvious screen.
- Format: `![Descriptive alt text](./.assets/{screenshot-name}.png)`.

### Reference information (form attributes)

- Fields shared across every task/phase on the page → one table in a shared `## Reference information` at the end.
- Fields differ per task/phase → put the table right under the task/phase it belongs to instead, and drop the shared section.
- Write the attribute name exactly as it appears in the UI, with no added formatting.

### Terminology and formatting

- Terms come from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md`.
- UI labels and UI-visible status values: **bold**, no quotation marks. System/API values not shown as such in the UI: `code font`.
- Reader-replaced placeholders: `*`\``UPPER_CASE`\``*`.
- Expand an abbreviation at its first mention, then use the short form only.
- UI labels, status values, placeholders, and code-vs-concept rendering follow `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` (Ж1–Ж7) in full — don't restate those rules here.