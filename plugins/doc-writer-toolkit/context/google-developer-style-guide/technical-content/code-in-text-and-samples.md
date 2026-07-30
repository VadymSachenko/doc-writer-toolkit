---
id: GDSG-TECH-CODE
title: Code in text and code samples
languages: [en-US]
scope: structural
content_types: [technical, api-reference, tutorial]
source_urls:
  - https://developers.google.com/style/code-in-text
  - https://developers.google.com/style/code-samples
captured: 2026-07-16
status: active
keywords: [code font, inline code, code sample, indentation, line length]
---

# Code in text and code samples

## GDSG-CODE-001 — Use code font for literal technical entities

Use code font for text readers enter or receive verbatim and for code-related entities,
including attributes and values, classes, constants, data types, database fields,
environment variables, filenames and paths, HTML/XML elements, HTTP verbs and status
codes, IP addresses, language keywords, methods, package names, placeholders, port
numbers, query parameters, literal strings, and command-line utility names.

Do not use code font for an ordinary product, service, organization, domain name, or a
URL that readers follow in a browser. If one of these is literal computer input or output,
code font is appropriate in that context.

Use both **bold** and `code` for a code-formatted literal that appears as a UI element.

## Context-sensitive cases

- Format `true` and `false` as code when they are literal Boolean values, but not when
  describing whether a condition is true or false.
- Use code font for a command such as `gcc`; use ordinary type for the related product.
- Use code font for an email address used as input or output; use an ordinary mail link
  when it is a contact address.
- For an HTTP code, write a form such as **HTTP `400 Bad Request` status code**. Use
  **status code**, not *response code* or *error code*.

## GDSG-CODE-002 — Do not inflect literal code

Do not turn a code entity into an English verb, plural, or possessive. Add and inflect a
common noun.

**Recommended:** Send a `POST` request. Read the value of `MAX_SIZE`.  
**Not recommended:** `POST` the data. Read `MAX_SIZE`’s value.

## Code samples

- Introduce a sample and explain its purpose before the block.
- Use the project language’s style guide; in Google-hosted examples, use spaces and
  generally two-space indentation unless the language convention differs.
- Keep lines at about 80 characters when practical; wrap for readability without making
  the sample invalid.
- Use a fenced code block or semantic `<pre><code>` markup with a language identifier.
- Mark an omission with a valid language comment, not prose that breaks copyability.
- Keep a click-to-copy command executable; put syntax notation in a separate syntax block.
- Test code that claims to run, and remove secrets, personal data, and unstable output.

