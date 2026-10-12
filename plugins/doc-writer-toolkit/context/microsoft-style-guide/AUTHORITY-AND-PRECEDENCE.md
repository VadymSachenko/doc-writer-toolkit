# Authority and precedence

Use the first applicable authority in the following list.

## Ukrainian content

1. Ukrainian orthography, grammar, morphology, and punctuation:
   `../doc-rules/ua-grammar/`.
2. Current Ukrainian usage corrections recorded in that same ruleset.
3. Microsoft Ukrainian Localization Style Guide for Microsoft voice,
   localization, UI, documentation, software, terminology, and locale formats.
4. Language-neutral Microsoft guidance for accessibility, clarity, organization,
   procedures, developer content, and global communication.
5. English rules only when explicitly marked transferable to Ukrainian.

Project-specific terminology in the external grammar cheatsheet
(`00-cheatsheet.md`) applies only to the project it was written for. It is not
a global Microsoft rule.

## English content

1. Microsoft Writing Style Guide topic rules.
2. A–Z entries and term collections for exact usage and spelling.
3. The most recently updated, most specific rule wins when two Microsoft pages
   address the same case.

## Conflict handling

- Keep the Microsoft rule for traceability.
- Mark an inapplicable or outdated Ukrainian rule as `superseded`.
- Link to the controlling Ukrainian grammar file.
- Record unresolved conflicts in `maintenance/unresolved-items.md`.
- Never silently combine incompatible English and Ukrainian mechanics.

The operational language-transfer matrix is in `localization/rule-applicability.md`.

## Applicability labels

- `shared`: applies without a language-specific change.
- `adapted`: the principle applies but its implementation differs by language.
- `en-US-only`: do not apply to Ukrainian.
- `uk-UA-only`: use only for Ukrainian.
- `translation-only`: use while translating English into Ukrainian.
- `needs-context`: inspect the audience or content type before applying.
- `superseded`: retained for provenance but not applied.
