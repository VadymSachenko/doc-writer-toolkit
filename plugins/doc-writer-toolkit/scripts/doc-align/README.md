# doc-align

Counts and pairs the structural elements of two Markdown/MDX pages, a **main** page (the source of truth) and a **secondary** page that must conform to it, and checks the heading ids of the UA one. Node, no dependencies. No AI is involved. The `doc-alignment-checker` skill runs it so the counting is exact on long pages, and spends the model only on what needs judgment.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/doc-align.mjs <main-file> <secondary-file> [--ua main|secondary]
```

Needs Node 18.3+. Tests: `npm test` in this folder (offline, fixtures inline).

## What it does and doesn't do

It reports differences in structure. It never judges meaning or language, and never decides whether a difference is intended: each finding is a candidate for the skill to interpret.

Out of scope, by design (the skill does these): Type-column language, link targets and prefixes (`internal-links.md`), Cyrillic text in the EN page, untranslated prose in the UA page, and title, slug and filename naming. Whether an EN heading's wording may use an explicit id (`heading-anchors.md`, rule 6) is a judgment too: the script only checks that the ids agree.

The reader is line based and code aware: fenced code blocks and the frontmatter are skipped, and inline code is blanked before links, images, `<details>` and markers are counted. A heading inside a code block is not a heading.

## Usage

- `<main-file>`: the source-of-truth page.
- `<secondary-file>`: the page that must conform.
- `--ua main|secondary`: which file is the UA page, for the heading-id checks. Without it, the UA page is the one with more Cyrillic letters in its heading text, and if that is a tie, in its whole text. If that is a tie too (no Cyrillic in either page), the heading-id checks are skipped with a `HEADING-ID-SKIPPED` warning. Pass the flag when a page's headings are mostly Latin text.
- `-h`, `--help`: the usage text.

Both paths are echoed as given into the report's `main` and `secondary` fields and each finding's `file`.

Output is one JSON report on stdout. A failure prints `{"error": …}` on stdout and a `doc-align: …` line on stderr.

**Exit codes:** `0` the comparison ran, with findings or without (they are in the JSON, not the exit code) · `1` unexpected failure · `2` bad usage or a file that can't be read (missing, a directory).

## Output

```json
{
  "main": "docs/records/filter-records.md",
  "secondary": "i18n/en/docusaurus-plugin-content-docs/current/records/filter-records.md",
  "ua": "main",
  "bugs": [
    {
      "check": 2,
      "flag": "HEADING-LEVEL-MISMATCH",
      "description": "heading 4: main '### Активний запис' is H3, secondary '## Active record' is H2",
      "line": 37,
      "file": "i18n/en/docusaurus-plugin-content-docs/current/records/filter-records.md"
    }
  ],
  "warnings": [],
  "passed": [
    { "check": 1, "name": "Frontmatter dates match" },
    { "check": null, "name": "Image count" }
  ]
}
```

| Field | Meaning |
|---|---|
| `main`, `secondary` | The two paths as passed. |
| `ua` | `main` or `secondary`: the file the heading-id checks read as UA. `null` when they were skipped. |
| `bugs[]`, `warnings[]` | One finding each: `check`, `flag`, `description`, `line`, `file`. |
| `check` | The Check number in `skills/doc-alignment-checker/SKILL.md` (1, 2, 3, 6, 7 or 8), or `null` for the image, link and admonition counts, which have no Check of their own. |
| `flag` | One of the flags below. |
| `description` | What differs, with the counts or the headings involved. |
| `line`, `file` | Where to look: 1-based line in that file. For a count difference, the last item of the file that has more; line `1` when there is nothing to point at. |
| `passed[]` | `{ check, name }` for every sub-check that ran and found nothing. A sub-check that could not run (the heading-id comparison when the heading counts differ, the id checks when `ua` is `null`) is in neither list. |

## Checks and flags

Severity follows the skill: heading count and levels and code blocks are bugs, everything else is a warning.

| Check | Sub-check (`passed` name) | Flag | Severity |
|---|---|---|---|
| 1 | Frontmatter dates match | `DATE-MISMATCH` | warning |
| 2 | Heading count and levels | `HEADING-COUNT-MISMATCH`, `HEADING-LEVEL-MISMATCH` | bug |
| 2 | UA heading ids present, well formed and unique | `HEADING-ID-MISSING`, `HEADING-ID-MALFORMED`, `HEADING-ID-DUPLICATE` | warning |
| 2 | EN headings carry no comment | `EN-HEADING-COMMENT` | warning |
| 2 | EN heading ids match the UA ids | `HEADING-ID-MISMATCH` | warning |
| 2 | (the id checks could not run) | `HEADING-ID-SKIPPED` | warning |
| 3 | Table count, columns and rows | `TABLE-MISMATCH` | warning |
| 6 | Code blocks identical | `CODE-BLOCK-MISMATCH` | bug |
| 7 | `<details>` block count | `DETAILS-BLOCK-COUNT-MISMATCH` | warning |
| 8 | ToDo markers paired, NEEDS CONFIRMATION markers paired | `MARKER-MISSING-IN-SECONDARY`, `MARKER-MISSING-IN-MAIN` | warning |
| `null` | Image count | `IMAGE-COUNT-MISMATCH` | warning |
| `null` | Link count | `LINK-COUNT-MISMATCH` | warning |
| `null` | Admonition count and types | `ADMONITION-MISMATCH` | warning |

What each one compares:

- **Dates.** The first `date:` line in the frontmatter (top level or under `last_update`), quotes removed. A date on one side only is a mismatch.
- **Headings.** ATX headings (`#` to `######` at the start of a line) in order. The count must match, then the level at each position. Comments and an explicit `{#id}` are left out of the heading text in descriptions.
- **UA heading ids** (`context/doc-rules/project-rules/heading-anchors.md`). Every UA heading from `##` down ends with one `{/* #id */}` comment, and `id` is lowercase ASCII kebab-case (`[a-z0-9]` words joined by single hyphens). The page title (`#`) is not checked. `HEADING-ID-MISSING`: no comment. `HEADING-ID-MALFORMED`: the comment has no `#`, does not end the heading, there are several, or the id has another form (upper case, `_`, a double hyphen). `HEADING-ID-DUPLICATE`: an id that an earlier heading on the page already has, reported on the later heading.
- **EN heading comments.** `EN-HEADING-COMMENT`: an EN heading, at any level, that carries a `{/* … */}` comment.
- **EN heading ids.** `HEADING-ID-MISMATCH`: the EN heading's id differs from the well-formed UA id at the same position. The EN id is its explicit `{#id}`, else the slug Docusaurus generates from its text (github-slugger: link and image text kept, tags dropped, lower case, every character that is not a letter, digit, space, hyphen or `_` removed, each space turned into a hyphen; a slug that already occurs on the page gets `-1`, `-2`, …). Runs only when the heading counts match, so the positions line up.
- **Tables.** A run of lines starting with `|` whose second line is a separator row. The count must match, then, table by table, the columns of the header row (escaped `\|` is not a separator) and the body rows.
- **Code blocks.** Fenced with ```` ``` ```` or `~~~` (closed by the same character, at least as long, with nothing after it). The count must match, then each block's contents byte for byte, whitespace included. The info string (```` ```json title="…" ````) is not compared. The finding's `line` is the first line that differs.
- **`<details>`.** Each `<details` tag outside code.
- **Markers.** `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}`, also over several lines, by kind. When the heading counts match, they pair section by section (the section is the last heading above the marker), so a marker that moved to another section shows as one gap on each side. Otherwise only the totals compare. The surplus markers on the side that has more are reported, with their text. A marker in a heading is a marker, not a heading comment.
- **Images.** `![alt](src)` and `<img src="…">`.
- **Links.** Inline `[text](target)` links, not images, in prose, headings and table rows.
- **Admonitions.** Opening lines `:::type`, tallied by type.

## How the skill uses it

`doc-alignment-checker` runs it as Step 1.5, after both files are loaded. It reads the JSON, treats each finding as a candidate (a difference may be intended), and supplies Checks 1, 2, 3, 6, 7 and 8 from it. It still runs its semantic checks itself. When the script can't run, the skill counts by hand as each Check describes and says so in its report.
