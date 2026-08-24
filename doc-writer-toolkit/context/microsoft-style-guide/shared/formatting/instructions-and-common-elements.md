---
id: MWSG-SHARED-FORMATTING-COMMON
title: Formatting instructions and common text elements
languages: [shared]
scope: structural
source_urls:
  - https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions
  - https://learn.microsoft.com/en-us/style-guide/text-formatting/formatting-common-text-elements
captured: 2026-07-16
status: active
keywords: [formatting, UI, filenames, keys, commands, errors]
---

# Formatting instructions and common text elements

Apply code formatting supported by the target format; in Markdown, use backticks.

| Element | Convention |
|---|---|
| UI labels, commands, buttons, checkboxes, menus, tabs, panes | Bold when named in documentation. Match the UI; omit trailing colon or ellipsis unless needed. Omit the control type unless it clarifies the action. |
| Command-line commands and options | Code style; preserve required case. |
| Database names | Bold in prose; code style in executable syntax. |
| Dialogs | Prefer describing the action. If naming one, say *dialog*, bold its name, and avoid *dialog box* or *pop-up window*. |
| Error messages | Sentence case; quotation marks when cited in prose; code style when it is a code string. |
| File attributes and extensions | Lowercase. |
| User-defined filenames | Preserve the shown form; bold when the reader interacts with the name and use code style in syntax. |
| Folders and directories | Sentence case by default; bold for interaction and code style in syntax. |
| Keys and shortcuts | Capitalize and bold in instructions; no spaces around `+`. Use commas for sequential key presses. |
| Markup elements | Code style; preserve case. |
| Mathematical variables | Italic. |
| A newly defined term | Italicize its first occurrence only when defining it immediately. |
| Placeholders | Italic in ordinary UI syntax; use angle brackets in code syntax only when the language does not use them. |
| Products, services, apps, trademarks | Use the official spelling and capitalization. |
| Strings | Quotation marks in prose or code style for code strings. |
| User input | Preserve required case; distinguish literal text from placeholders. |
| XML schema elements | Code style; preserve case and required angle brackets. |

## General-content exception

UI and marketing surfaces may not support bold. In that case, describe the action
without naming the label, use syntax that clearly separates the label, or use quotation
marks sparingly. Choose one treatment and apply it consistently.

