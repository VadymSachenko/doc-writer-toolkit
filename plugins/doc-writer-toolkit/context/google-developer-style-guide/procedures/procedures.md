---
id: GDSG-PROCEDURES
title: Procedures
languages: [en-US]
content_types: [procedure, tutorial, user-guide]
source_urls:
  - https://developers.google.com/style/procedures
  - https://developers.google.com/style/prescriptive-documentation
captured: 2026-07-16
status: active
keywords: [procedure, steps, instructions, imperative, prerequisite, optional]
---

# Procedures

## Design the task

- Document the shortest accessible method that best serves the audience. Do not list
  alternatives that add no decision value.
- If multiple ways genuinely need documentation, separate them into different pages,
  headings, or tabs — don't mix them in a single list.
- State prerequisites before the steps.
- Keep the sequence short; link to a reusable procedure instead of repeating it.
- Give one action or one closely coupled action group per step. If a step starts to feel
  long, split it into multiple steps.
- Use a numbered list for a multistep sequence. A single-step procedure can be one
  sentence in a bullet.
- Use lowercase letters for substeps and Roman numerals for a third level when the output
  format supports that hierarchy. Treat a step that introduces substeps like an
  introductory sentence: end it with a colon or a period, as appropriate.

## GDSG-PROC-001 — Write actionable steps

1. Begin the first sentence with an imperative verb.
2. Put a short location, condition, or goal before the action when the reader needs it.
3. Put the action before its explanation or expected result.
4. Use complete sentences and parallel grammar.
5. Keep a required result, explanation, or command output with the step it supports.

**Recommended:** In the **Access** pane, select **Private**, and then click **Save**.  
**Not recommended:** You should now be in the access pane. Please choose the private
option below and save it.

## Step details

- Introduce the procedure with a complete sentence, but do not restate its heading. If a
  set of procedures is split across multiple headings, restate the location in the first
  step of each one, even if the context is the same as the previous procedure's.
- Prefix a truly optional step with **Optional:**, not **(Optional)**.
- Avoid **please** and directional words such as *above*, *below*, *left*, or *right*.
- For sequential menu commands, use an accessible `>` sequence; see the UI rules.
- If pressing Enter is required, include it in the same step as the input.
- Say what a command accomplishes; avoid “Run the following command” as a generic lead-in.
- Do not add keyboard shortcuts to ordinary procedures. Document one only when the
  shortcut itself is the task or audience need.
- If a step contains a decision, make each branch explicit rather than asking the reader
  to infer it.
- When a goal phrased as “To accomplish X” could be misread as making the step optional,
  use a colon instead: **Enable the setting:** ...
- Don't repeat a result in the next step if that step already names the dialog, page, or
  element the result produced.

## Complex technical step order

When a step includes a command, use this order where applicable: action and purpose;
command; placeholder explanations; explanatory detail; example output; resulting state.

