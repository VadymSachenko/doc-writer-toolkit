---
id: GDSG-TECH-COMMAND-LINE
title: Command-line syntax and output
languages: [en-US]
content_types: [cli-reference, procedure, tutorial]
source_urls:
  - https://developers.google.com/style/code-syntax
captured: 2026-07-16
status: active
keywords: [command line, syntax, shell, output, prompt, optional, exclusive]
---

# Command-line syntax and output

## Commands

- Put a command on its own in a code block.
- Do not include a shell prompt in a copyable command unless the prompt is necessary to
  distinguish user input from output.
- Explain what the command accomplishes instead of writing only “Run the following.”
- Use placeholders for values the reader must replace and explain them immediately after
  the command.
- For a multiline command, use the shell’s valid continuation convention and align lines
  for scanning.

## Syntax notation

Use syntax notation in a reference synopsis, not in a command presented as executable:

- `[item]` — optional item
- `{a | b}` — choose exactly one item
- `item...` — repeatable item

Do not put brackets, braces, or an ellipsis inside the placeholder markup. Define any
project-specific notation next to the syntax block.

## Output

- Introduce output with a phrase such as **The output is similar to the following:** when
  values can vary.
- Include only output that helps the reader confirm success, diagnose a state, or use a
  returned value.
- Visually separate input and output.
- Replace unstable or sensitive output with explicit placeholders and explain them.
- Do not imply byte-for-byte output when timestamps, IDs, ordering, or versions vary.

