---
title: Procedures
description: Guidelines for writing procedures — sequences of numbered steps that accomplish a task.
last_update:
  date: 4/19/2026
---

This document covers guidelines for writing procedures: sequences of numbered steps that accomplish a task.

For the full version of the guidelines, see the [Procedures](https://developers.google.com/style/procedures) page in the Google developer documentation style guide.

**Related rules in other style-guide files:**

- Introductory sentences and optional steps are covered in [Formatting and organization](<link to formatting-and-organization.md>).
- Word-level rules (for example, "Don't use _please_") are covered in [Word list](<link to word-list.md>).

## Single-step procedures

**Rule:** When a procedure has only one step, write it in one sentence and format it as a bulleted list — not a numbered list with one item.

✓ **Recommended:**

- To clear (flush) the entire log, click **Clear logcat**.

⛔️ **Not recommended:**

To clear (flush) the entire log, follow this step:

1. Click **Clear logcat**.

⛔️ **Not recommended:**

To clear (flush) the entire log, follow this step:

- Click **Clear logcat**.

## Substeps in numbered procedures

**Rule:** When a step has substeps, treat the parent step like an introductory sentence. End it with a colon or a period, as appropriate.

✓ **Recommended:**

1. To add a VM instance, do the following:
   1. Click **Create instance**.
   2. For **Name**, enter a name for the VM instance, and then do the following:
      1. For **Region**, specify where you want to deploy the VM instance.
      2. For **Machine type**, select an option.
   3. Click **Create**.
2. To connect to the VM instance by using SSH, click **SSH**.

## Order of components in a complex step

**Rule:** When a step contains a command and related context, use the following order:

1. Describe the action to take.
2. List a command, if necessary.
3. Explain any placeholders used in the command. For more information, see [Placeholder formatting](<link to computer-interfaces.md#placeholder-formatting>).
4. Explain the command in more detail, if necessary.
5. List the output of the command, if necessary. For more information, see [Output from commands](https://developers.google.com/style/code-syntax#output).
6. In a separate paragraph, explain the result of the action or any output, if necessary.

✓ **Recommended:**

1. Plan the Terraform deployment:

```
terraform plan -out=NAME
```

   Replace *`NAME`* with the name of your Terraform plan.

   The `terraform plan` command does the following:

   1. Parses the Terraform configuration, building a list of resources to provision.
   2. Refreshes the current state of resources already provisioned in Google Cloud.
   3. Creates a plan to make the currently provisioned resources match the parsed configuration.

   The output is similar to the following:

```
Plan: 26 to add, 0 to change, 0 to destroy.
------------------------------------------------------------
This plan was saved to: NAME
```

   The output shows what resources to add, change, or destroy.

## Multi-action steps

**Rule:** In general, use one step per action.

**Rule:** Small sequential actions can be combined into one step using the angle-bracket (`>`) syntax for sequential menu selections. Don't combine actions that aren't menu selections.

✓ **Recommended:**

1. Click **Next > Finish**.

✓ **Recommended:**

1. Click **File > New > Document**.

**Rule:** Don't make combined steps too long. If a step feels long, split it into multiple steps.

## Multiple procedures for the same task

**Rule:** If more than one way exists to complete a task, document one procedure that is accessible to all readers. Choose:

- A procedure that works with only a keyboard.
- The shortest procedure.
- A procedure that uses a programming language most of the audience is familiar with.

**Rule:** If multiple ways genuinely need documentation, separate them into different pages, headings, or tabs. Don't mix them in a single list.

## Repetitive procedures

**Rule:** Avoid repeating procedures. Reference them instead and link to the original.

✓ **Recommended:**

1. Create a user as you did in the previous step.

✓ **Also recommended:**

1. [Create a user](<link to the original procedure>) as you did in the previous step.

## Steps that say where to complete an action

**Rule:** State the location of the action before the action itself. This helps readers find the right context before performing the step.

✓ **Recommended:**

1. In Google Docs, click **File > New > Document**.
2. In the Google Cloud console, go to the **Monitoring** page.

⛔️ **Not recommended:**

1. Click **File > New > Document** in Google Docs.
2. Go to the **Monitoring** page in the Google Cloud console.

**Rule:** If a set of procedures is split across multiple headings, restate the location in the first step of each procedure, even if the context is the same as the previous one.

## Steps with goals

**Rule:** When a step has a clear purpose, state the goal before the action. This structure helps readers understand and complete the step more easily.

✓ **Recommended:**

1. To start a new document, click **File > New > Document**.

⛔️ **Not recommended:**

1. Click **File > New > Document** to start a new document.

**Rule:** When the "To..." format could be misread as optional, use the colon format instead.

✓ **Recommended:**

1. Start a new document: click **File > New > Document**.

The "To..." format is more natural when the step is clearly required within the procedure's context. Use the colon format only when the goal-first phrasing might otherwise imply the step is optional.

## Steps with results or justifications

**Rule:** When a step includes a resulting reaction that helps the reader navigate to the next step, state the action first and the result second. Keep both in the same paragraph.

✓ **Recommended:**

1. Click **Run**. The query results appear after the query runs.

**Rule:** Don't repeat the result in the next step when the next step already names the dialog, page, or element the result produced. Avoid excessive UI-element bolding across back-to-back steps.

✓ **Recommended:**

1. Click **Enter**.
2. In the **New file** dialog that appears, click **Next**.

⛔️ **Not recommended:**

1. Click **Enter**. The **New file** dialog appears.
2. In the **New file** dialog, click **Next**.

**Rule:** When a step benefits from explaining *why* it matters, state the action first and the justification second.

✓ **Recommended:**

1. Store the private key in a secure location. You need it later.

## Summary of procedure-writing guidelines

| Guidance | ✓ **Recommended** | ⛔️ **Not recommended** |
|---|---|---|
| Make sure the first sentence in a step includes an imperative verb. | Clone the repository that contains the sample data. | You need the project ID later in this document. Retrieve the project ID. |
| Use complete sentences. | — | — |
| Use parallel structure and consistent verb form. | Download the service account key to your local machine. Click **More**, and then click **Download**. | Download the service account key to your local machine by clicking **More** and then clicking **Download** file. |
| For an optional step, type *Optional:* as the first word. | Optional: Type an arbitrary string ... | (Optional) Type an arbitrary string ... |
| Set the context (tool, environment, page) before the action. If procedures are split across headings, restate context in the first step even if it's unchanged. | In Cloud Shell, connect to the development cluster. | — |
| State the location before the action. | In Google Docs, click **File > New > Document**. | Click **File > New > Document** in Google Docs. |
| State the purpose or goal before the action. | To start a new document, click **File > New > Document**. | Click **File > New > Document** to start a new document. |
| Don't use directional language (*above*, *below*, *right-hand side*). It fails for accessibility and localization. If a UI element is hard to find, provide a screenshot. | In the preceding diagram, ... | Click the button with three lines. |
| Don't use *please*. | To open a document, click **File > Open**. | To open a document, please click **File > Open**. |
| Focus on what a command does rather than introducing it with "run the following command". | In Cloud Shell, deploy the load generator: ... | In Cloud Shell, deploy the load generator by running the following command: ... |
| If the reader must press **Enter** after typing, include the press in the same step. | Click the search box, type `custom function`, and then press **Enter**. | 1. Click the search box and type `custom function`. 2. Press **Enter**. |
| Don't include keyboard shortcuts. | Copy the command, and then paste it ... | Press Ctrl+C, and then press Ctrl+V ... |
| When more than one way exists to do something, give only the best way. Alternatives can confuse readers. | — | — |
| Ensure the reader has any prerequisites before the task begins. | The following hardware and software are required: ... | — |
| Include as few steps as possible. Limit interruptions in the path. | — | — |
| Focus on one reader decision at a time. Each instruction is a separate list item. | — | — |

For more details, see the [Procedures](https://developers.google.com/style/procedures) page in the Google developer documentation style guide.