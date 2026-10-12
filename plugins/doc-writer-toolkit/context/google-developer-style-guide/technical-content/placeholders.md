---
id: GDSG-TECH-PLACEHOLDERS
title: Placeholders
languages: [en-US]
scope: structural
content_types: [code, command-line, examples]
source_urls:
  - https://developers.google.com/style/placeholders
captured: 2026-07-16
status: active
keywords: [placeholder, variable, replace, code block, output]
---

# Placeholders

## GDSG-PLACEHOLDER-001 — Make replacement values obvious

- Use a descriptive uppercase name with underscore delimiters: `PROJECT_ID`.
- Do not use a single `x`, a row of x characters, mixed casing, hyphens, or spaces unless
  the domain has an established pattern such as an HTTP `2xx` status code.
- Do not include possessive adjectives such as `MY_` or `YOUR_`.
- If uppercase underscore form conflicts with the host language or interface, use a clear
  project convention consistently.

## Markup

- HTML inline code placeholder: `<code><var>PROJECT_ID</var></code>`.
- HTML non-code placeholder: `<var>PROJECT_ID</var>`.
- Markdown inline placeholder: italicized code, commonly *`PROJECT_ID`*.
- In a fenced Markdown code block, formatting cannot distinguish a placeholder; naming
  and the explanation must do so.
- Keep syntax brackets, braces, and ellipses outside `<var>`.

## Explain placeholders

Explain every placeholder at first use, even if its meaning seems obvious.

- One placeholder: **Replace `PROJECT_ID` with the ID of the project.**
- Multiple input placeholders: introduce a list with **Replace the following:**, list them
  in command order, then use `PLACEHOLDER: lowercase description`.
- Output placeholders: introduce the list with **This output includes the following
  values:** and list them in output order.

Repeat an explanation only when the page is long, placeholders are far apart, or readers
do not normally read the content sequentially.

