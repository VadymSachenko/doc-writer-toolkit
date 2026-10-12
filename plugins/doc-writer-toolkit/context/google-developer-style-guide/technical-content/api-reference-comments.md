---
id: GDSG-TECH-API-REFERENCE
title: API reference comments
languages: [en-US]
scope: structural
content_types: [api-reference, code-comments]
source_urls:
  - https://developers.google.com/style/api-reference-comments
  - https://developers.google.com/style/reference-verbs
captured: 2026-07-16
status: active
keywords: [API, reference, class, method, parameter, return, exception, deprecation]
---

# API reference comments

## Document the contract

Document every public class, interface, constant, method, function, parameter, return
value, exception, and deprecation that the reference system exposes.

- **Type:** state its purpose and important relationships or lifecycle constraints.
- **Member or constant:** state what it represents, including units or allowed values.
- **Method or function:** begin with a third-person singular verb that states what it does.
- **Parameter:** state accepted input, format, range, units, default, and special values.
- **Boolean parameter:** explain what happens when true and when false.
- **Return value:** state what is returned, including empty, null, or error behavior.
- **Exception or error:** state the condition that causes it and any recovery action.
- **Deprecation:** identify the replacement and link to migration guidance when available.

## GDSG-API-001 — Do not merely restate the signature

Explain observable behavior, constraints, side effects, and edge cases that the type
system or declaration does not already reveal. Keep source comments accurate enough that
generated reference documentation stands on its own.

**Recommended:** Returns the cached record, or `null` if the key has expired.  
**Not recommended:** Returns a record.

Use present tense, literal terminology, and the exact code spelling. Do not promise an
implementation detail that is not part of the supported contract.

