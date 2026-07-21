---
title: Computer interfaces
description: Guidelines for formatting code, placeholders, and UI elements consistently in Unicompay documentation.
last_update:
  date: 4/19/2026
---

This document covers guidelines for formatting code, placeholders, and UI elements consistently, ensuring readers understand how to interact with and interpret technical information.

For the full version of the guidelines, see the "Computer interfaces" section in the [Google developer documentation style guide](https://developers.google.com/style) sidebar.

## Code in text

**Rule:** Use code font to mark up anything code-related or anything that requires user input.

**Rule:** Don't use code elements (keywords, filenames, method names) as English verbs or nouns, and don't inflect them (no plurals, no possessives). Instead, place a noun after the code element and inflect that noun.

| ✓ **Recommended** | ⛔️ **Not recommended** |
|---|---|
| The `ADDRESS` constant's value is defined in the `settings.h` file. | `ADDRESS`'s value is defined in `settings.h`. |
| To add the data, send a `POST` request. | `POST` the data. |
| To retrieve the data, send a `GET` request. | Retrieve information by `GET`ting the data. |
| In the **Branch name** field, enter `test`. | In the **Branch name** field, enter **test**. |

For detailed information, see [Specific items to put in code font](https://developers.google.com/style/code-in-text#some-specific-items-to-put-in-code-font).

## Placeholder formatting

**Rule:** Placeholders represent values the reader must replace when using the sample input.

For example, the placeholder *`PROJECT_ID`* represents a project ID in sample code, commands, and example output.

**Rule:** Don't use a single _x_ or a series of _x_'s as placeholders. Use an informative placeholder name instead.

**Exception:** In contexts where _x_ is the convention (for example, HTTP status codes like `2xx`), it's OK to use _x_.

**Rule:** Use the following placeholder syntax, depending on the context:

- **Inline in Markdown:** wrap in backticks, and add an asterisk before the opening backtick and after the closing backtick: `*`\``PLACEHOLDER_NAME`\``*`
- **Inside a Markdown code fence:** use plain uppercase. Code fences don't support inline formatting like bold or italic.
- **In Confluence:** use code formatting.

### Inline placeholder example

1. ...
2. In the **Payment part** section, add a new field and enter *`PAYMENT_SCREEN_ID`*.

   Replace *`PAYMENT_SCREEN_ID`* with the ID of the screen that you created in the preceding step.

### Code-fence placeholder example

1. ...
2. Stream the build logs to the Google Cloud console:
```bash
gcloud builds log --stream=BUILD_ID
```

Replace *`BUILD_ID`* with the ID of the `WORKING` build that you copied in the preceding step.

For more details, see [Format placeholders](https://developers.google.com/style/placeholders).

## UI elements and interaction

This section covers how to describe and reference UI elements (buttons, dialogs, fields, sections) and how to write instructions for interacting with them.

### Focus on the task, not the widget

**Rule:** State instructions in terms of what the reader should accomplish, not the widget or gesture used.

**Rule:** Don't use UI element names as English verbs or nouns.

- ✓ **Recommended:** Refresh the page.
- ✓ **Recommended:** Expand the **Advanced options** section.
- ✓ **Recommended:** Click **Refresh**.
- ⛔️ **Not recommended:** **Save** the settings.

### Format names of UI elements

**Rule:** When referring to any UI element by name, put the name in **bold**.

**Rule:** Match the capitalization as it appears on the page, with one exception: when a label is all uppercase or capitalization is inconsistent across the UI, use sentence case.

| ✓ **Recommended** | ⛔️ **Not recommended** |
|---|---|
| In the **Link deleting** dialog that appears, click **Delete**. | In the "Link deleting" dialog that appears, click the "Delete" button. |
| Navigate to **Branches**, and for the branch you want to edit, click <Icon icon="fa-solid:copy" height="24" style={{ color: '#009b72' }} /> **Copy**. | Navigate to **Branches**, and for the branch you want to edit, click **COPY**. |
| To save the settings, click **Save**. | **Save** the settings. |
| To expand the **Advanced options** section, click the <Icon icon="solar:alt-arrow-down-linear" height="24" style={{ color: 'grey' }} /> expander arrow. | Click the zippy (informal term for the expander arrow) to expand the **Advanced options** section. |

For more information, see [UI elements and interaction](https://developers.google.com/style/ui-elements).