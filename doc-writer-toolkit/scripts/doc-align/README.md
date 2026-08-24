# doc-align structural checker

`align_check.py` deterministically counts and pairs the structural elements of two
Markdown/MDX pages — a **main** (source of truth) and a **secondary** that must
conform to it — and emits an `alignment-report` JSON document to stdout. It exists
so the `doc-alignment-checker` skill can offload the mechanical counting (headings,
tables, images, links, code fences, admonitions, `<details>` blocks, frontmatter
dates, and `{/* ToDo */}` / `{/* NEEDS CONFIRMATION */}` markers) to a script that
never miscounts and costs no tokens, and spend the model only on the judgment that
actually needs it (translation fidelity, and whether a structural difference is a
real defect or intentional).

The script does arithmetic, not meaning. It never decides whether a difference is
acceptable — it reports the difference and lets the skill judge.

## Requirements

- **Python 3** — standard library only, no external dependencies, nothing to
  install. Runs anywhere Python 3 exists (Windows, macOS, Linux).

On this repo's Windows/Git Bash environment the interpreter is `python`
(`python3` resolves to the Microsoft Store shim and does not run). On macOS/Linux
use `python3`.

## Usage

```bash
python align_check.py <main-file> <secondary-file>
```

- `<main-file>` — the source-of-truth page (e.g. the UA original).
- `<secondary-file>` — the page that must conform (e.g. the EN counterpart).

Both paths are echoed verbatim into the report's `main` / `secondary` fields, so
pass them exactly as you want them to appear.

Options:

```text
--compact    Emit single-line JSON instead of the default 2-space indented output.
```

A missing or unreadable file prints a `align_check: ...` message to stderr and exits
non-zero (2). A successful run always exits 0, even when it finds bugs — the findings
live in the JSON, not the exit code.

## What it checks

| Dimension | Finding flag | Severity |
|---|---|---|
| Frontmatter `date` | `DATE MISMATCH` | warning |
| Heading count / nesting level (anchors stripped before compare) | `HEADING COUNT MISMATCH`, `HEADING LEVEL MISMATCH` | bug |
| Fenced code block count + byte-for-byte contents | `CODE BLOCK MISMATCH` | bug |
| Table count, and per-table column/row counts | `TABLE MISMATCH` | warning |
| Image count (Markdown `![]()` and `<img src>`) | `IMAGE COUNT MISMATCH` | warning |
| Inline link count | `LINK COUNT MISMATCH` | warning |
| Admonition count by type (`:::note/tip/info/warning/danger/caution`) | `ADMONITION MISMATCH` | warning |
| `<details>` block count | `DETAILS BLOCK COUNT MISMATCH` | warning |
| `{/* ToDo */}` and `{/* NEEDS CONFIRMATION */}` marker counts by kind | `MARKER MISSING IN SECONDARY`, `MARKER MISSING IN MAIN` | warning |

Severity mirrors the skill's own table: structural *identity* problems (heading
count/level, code-fence contents) are bugs; *count* drift the skill may still judge
intentional is a warning. Every check that matches goes into `passed[]` by name.

The parser is code-fence-aware — element syntax that only appears *inside* a code
sample is ignored, and fenced blocks are the one thing compared for exact content.

**Out of scope (stays in the skill, by design):** Type-column-must-be-English,
internal-link-prefix correctness, Cyrillic-in-EN, untranslated-prose-in-UA, and the
UA-heading-missing-anchor check. Those need language/project knowledge or a semantic
call the script deliberately does not make.

## Output

The report matches the `alignment-report` schema (version `1`) documented in
`context/artifact-schemas.md`:

```json
{
  "schema": "alignment-report",
  "version": "1",
  "main": "docs/.../page.md",
  "secondary": "i18n/en/.../page.md",
  "bugs": [
    {
      "flag": "HEADING LEVEL MISMATCH",
      "description": "heading #2: main 'Section Two' is H2, secondary 'Section Two' is H3",
      "line": 11,
      "file": "i18n/en/.../page.md"
    }
  ],
  "warnings": [
    {
      "flag": "DATE MISMATCH",
      "description": "main: 2026-07-01, secondary: 2026-06-15",
      "line": 2,
      "file": "docs/.../page.md"
    }
  ],
  "passed": [
    "Image count",
    "Link count",
    "<details> block count",
    "ToDo markers paired"
  ],
  "counts": { "bugs": 1, "warnings": 1, "passed": 4 }
}
```

Each `bugs[]` / `warnings[]` entry carries a `flag`, a `description`, and a
best-effort `line` + `file` pointing at the offending location. `passed[]` is a list
of check-name strings. `counts` totals each bucket.

## How the skill uses it

The `doc-alignment-checker` skill:

1. **Preflight** — confirms `python` (or `python3`) runs and the script exists.
2. **Run** — invokes
   `python ${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/align_check.py <main> <secondary>`
   and reads the JSON from stdout.
3. **Interpret** — treats each `bugs[]`/`warnings[]` entry as a candidate finding,
   deciding whether each structural difference is a genuine defect or an intentional
   divergence, and folds the result into its report.
4. **Semantic passes** — runs its own language/meaning checks (translation fidelity,
   Type-column language, Cyrillic-in-EN, untranslated prose, link prefixes, UA
   heading anchors) on top of the script's structural findings.

If Python is unavailable, the skill falls back to counting these same elements
itself (the original LLM method), documented as the fallback path in `SKILL.md`.
