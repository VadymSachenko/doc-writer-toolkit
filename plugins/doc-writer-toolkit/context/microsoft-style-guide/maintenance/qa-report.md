# QA report

Validated: 2026-07-16.

## Coverage

- 949/949 English source records are `active` and map to an existing local target.
- The 949 records comprise 95 core/topic pages and 854 individual terminology
  pages, including the live-only URI entry.
- The 158-page Ukrainian guide is represented by section-addressed `uk-UA` rules.
- 125 rule files have unique stable IDs in `manifest.json`.
- 166 Markdown files provide rules, indexes, routing, provenance, and maintenance
  documentation.

## Integrity checks

- UTF-8 decoding: passed.
- Mojibake scan: passed.
- Local Markdown links: passed.
- Source-map targets: passed.
- Manifest targets and unique IDs: passed.
- Pending or non-active source records: none.
- Largest rule/lookup file: under 19 KB; the former monolithic 168 KB terminology
  index was split by letter.

## Retrieval checks

| Query | Expected route | Result |
|---|---|---|
| English `plugin` | P lookup → one A–Z chunk | Pass |
| English `URI` | U lookup → current live-only entry | Pass |
| Ukrainian `опція` | frequent-choice table → `параметр` | Pass |
| Ukrainian message with `%d` | software messages + placeholder rules | Pass |
| Ukrainian apostrophe or spelling | grammar authority → chief UA corpus | Pass |
| English rule applied to Ukrainian | applicability matrix blocks mechanical transfer | Pass |

## Scope checks

- Microsoft Learn contributor guidance is excluded.
- Raw source repository and PDF are not part of the deliverable.
- Project-specific terms from the external `00-cheatsheet.md` are not copied into
  the generic corpus.
