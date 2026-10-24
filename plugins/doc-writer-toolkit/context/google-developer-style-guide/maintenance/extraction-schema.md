# Extraction schema

Each rule file uses YAML metadata followed by task-oriented guidance.

## Metadata

- `id`: stable rule-family ID.
- `title`: human-readable title.
- `languages`: normally `en-US`.
- `content_types`: applicable content kinds.
- `source_urls`: official Google pages.
- `captured`: extraction date.
- `status`: `active`, `contextual`, or `superseded`.
- `keywords`: retrieval signals.

## Rule shape

Use only fields that add information:

- short rule title and stable rule ID;
- strength or scope;
- directive;
- reduced recommended example;
- reduced not-recommended example;
- exception or scope qualifier;
- related local rule;
- source URL.

Examples are generic and intentionally shorter than source examples. Word-list files
omit most examples and retain only actionable usage distinctions.
