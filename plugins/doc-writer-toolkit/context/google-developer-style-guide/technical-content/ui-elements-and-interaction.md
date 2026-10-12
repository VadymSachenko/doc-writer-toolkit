---
id: GDSG-TECH-UI
title: UI elements and interaction
languages: [en-US]
scope: structural
content_types: [procedure, user-guide, ui-reference]
source_urls:
  - https://developers.google.com/style/ui-elements
captured: 2026-07-16
status: active
keywords: [UI, button, menu, checkbox, keyboard, click, select, field]
---

# UI elements and interaction

## Focus on the task

Describe what the reader accomplishes and omit widget mechanics when the action remains
clear. Add UI detail when readers need it to locate or operate the control. Outside a
procedure, provide enough interface context to locate a named element.

## GDSG-UI-001 — Format and reproduce labels

- Put a visible UI label in **bold** and preserve its displayed wording.
- If labels are all uppercase or inconsistently cased, normalize references to sentence
  case.
- Do not put quotation marks or code font around an ordinary UI label.
- If a UI value is also literal code or user input, apply both bold and code formatting.
- Do not bold a product or feature name unless it is the visible name of the UI element.

## GDSG-UI-002 — Use exact element terms and actions

- **click** a button, icon, link, or toggle with a pointer;
- **select** a checkbox, radio button, list item, or option;
- **enter** or **type** text in a field;
- **press** a keyboard key or key combination;
- **tap** a touch target;
- **turn on** or **turn off** a setting; do not use **toggle** as a verb.

Do not use a label as an English verb: write “click **Save**,” not “save the settings” when
the action specifically requires the button. Use **selected** and **not selected** for a
checkbox state.

Use **page** for a web or console page, **dialog** for a smaller detached window, **pane**
or **panel** for a rectangular region, and **section** for a labeled group of controls.
Avoid slang such as *hamburger* or *zippy*.

## Menus and navigation

- Write **the File menu** and call an item in it a **command**.
- Use **navigation menu**, not navigation bar/pane/panel/window, for a control that links
  to application pages.
- A compact sequential menu path can use `>` with nonbreaking spaces and an accessible
  “and then” label in HTML. Bold the whole sequence, not each segment separately.
- Do not use one `>` chain across unrelated control types.

## Keyboard

- Use `<kbd>` or the equivalent monospace keyboard style.
- Capitalize letter keys and spell out modifiers: `Control+C`, not `Ctrl+c` or a symbol.
- Put the macOS alternative in parentheses after Windows/Linux when both are needed.
- Spell out potentially confusing character names in prose.
- Use **press** for an action and **type** or **enter** when the key becomes text input.

## Prepositions

Use **in** for dialogs, fields, lists, menus, panes, and windows. Use **on** for pages,
tabs, and toolbars.

