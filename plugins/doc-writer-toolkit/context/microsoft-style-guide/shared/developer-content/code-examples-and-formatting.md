---
id: MWSG-SHARED-CODE
title: Code examples and developer text formatting
languages: [shared]
scope: structural
source_urls:
  - https://learn.microsoft.com/en-us/style-guide/developer-content/code-examples
  - https://learn.microsoft.com/en-us/style-guide/developer-content/formatting-developer-text-elements
captured: 2026-07-16
status: active
keywords: [code, sample, syntax, identifier, output]
---

# Code examples and developer text formatting

## Plan examples around real tasks

- Start with the simplest realistic scenario and add complexity only when it teaches a
  necessary decision or behavior.
- Prioritize common, difficult, or easily misused APIs.
- Avoid contrived examples and examples that merely restate obvious syntax.
- State prerequisites, dependencies, setup, and the scenario before the code.
- Make the example easy to copy, run, and modify.

## Write trustworthy code

- Compile, run, and test every example and its displayed output.
- Use secure defaults, validate untrusted input, and never embed real secrets.
- Explain non-obvious decisions in comments; do not narrate obvious lines.
- Show expected output or observable results.
- Include exception handling only when it is intrinsic to the lesson.
- Apply accessibility requirements to any UI created by the example.
- Keep downloadable and embedded versions synchronized.

## Formatting

- Use code style for code, keywords, literals, variables, user-defined elements,
  command lines, options, syntax placeholders, and environment variables when treated
  as executable text.
- Preserve the exact spelling and case required by the language or API.
- Use fenced code blocks with the correct language identifier for multiline code.
- Do not add typographic quotation marks, ellipses, or emphasis inside executable code.
- Distinguish placeholders unambiguously and explain what the reader must replace.
- Use ordinary prose formatting for conceptual mentions when code style would imply a
  literal token.

