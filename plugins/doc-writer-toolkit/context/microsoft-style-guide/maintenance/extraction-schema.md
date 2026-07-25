# Extraction schema

Each rule file uses compact YAML metadata followed by task-oriented guidance.

## Required metadata

- `id`: stable file or rule-family identifier.
- `title`: human-readable topic.
- `languages`: `shared`, `en-US`, or `uk-UA`.
- `source_urls`: official Microsoft sources.
- `captured`: extraction date.
- `status`: `active`, `superseded`, or `needs-review`.
- `keywords`: retrieval terms.

## Rule fields

Use the fields that add information; omit empty fields.

- Rule ID and short title.
- Strength: required, recommended, allowed, or contextual.
- Directive.
- Recommended example.
- Not-recommended example when it clarifies a likely error.
- Exception.
- Rationale.
- Review hint.
- Related rule.
- Source link.

Ukrainian rule explanations are written in Ukrainian. Translation rules provide a
recommended Ukrainian form and include the English source only when it is needed to
understand the decision.

