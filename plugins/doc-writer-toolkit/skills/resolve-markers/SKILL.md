---
name: resolve-markers
description: Resolves every {/* NEEDS CONFIRMATION */} and {/* ToDo */} marker in a section's doc pages automatically using whatever evidence is available — app-notes.md (if app-explorer has run), sme-interview.md, existing screenshots in .assets/, and direct app observation via Playwright. No questions asked when the answer can be found. Only stops for markers that genuinely cannot be answered from any available source. Use explicitly ("resolve-markers: docs/transactions", "use resolve-markers on the archive section").
---

# resolve-markers

You are resolving documentation markers — `{/* NEEDS CONFIRMATION: ... */}` and `{/* ToDo: ... */}` — using every source of evidence available. When the answer can be found, you apply it directly. When it cannot, you leave the marker in place and report it. You do not ask the user to answer anything that the evidence already answers.

## Scope

- **In scope:** resolving `{/* NEEDS CONFIRMATION */}` and `{/* ToDo */}` markers in all doc pages of one section, using all available evidence sources. Editing the pages in place. Reporting what was resolved and what remains.
- **Out of scope:** running full app exploration (`app-explorer`'s job). Writing new pages. Style review. Translation.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve content root.
2. The section's `.sources/app-notes.md` — **optional**. Load if present; skip if absent. This file is written by `app-explorer` when it has run — do not require it.
3. The section's `.sources/sme-interview.md` — **optional**. Load if present.
4. The section's `.assets/` folder — list what screenshots already exist there.
5. The doc pages in the section — read each one to find markers.

Do not load style-guide corpora. This skill edits markers only — it does not rewrite prose beyond filling in the confirmed fact.

## Step 0 — Build the evidence index

Collect every source of evidence available. Work through them in order — later sources fill gaps the earlier ones leave:

1. **`app-notes.md`** (if present) — answers to specific questions, screenshot descriptions, observed UI labels. Best source: direct observation.
2. **`sme-interview.md`** (if present) — confirmed facts from SME or transcript. Good for conceptual and business-rule questions.
3. **`.assets/` contents** — screenshots already saved. A screenshot of the right UI state can answer a `{/* ToDo: add a screenshot */}` marker directly without needing `app-notes.md`.
4. **Live app via Playwright** (if `Admin UI: playwright` is declared in `CLAUDE.md`) — for markers that none of the above answer, navigate to the relevant screen, observe directly, and record the answer. Do not capture new screenshots unless a `{/* ToDo: add a screenshot */}` marker specifically needs one. Read credentials from `.env` — never hardcode them, never use production.

Build an internal index:
- Every confirmed answer → source + answer text
- Every available screenshot → filename + what it shows
- Every question with no answer yet → mark as unresolved for now

If none of these sources exist and `Admin UI:` is `none`, continue — the skill still runs, it just classifies most markers as `unresolvable` and reports them.

## Step 1 — Find all markers

Scan every `.md`/`.mdx` file in the section folder for:
- `{/* NEEDS CONFIRMATION: ... */}` — a fact that was uncertain when the page was written
- `{/* ToDo: add a screenshot — ... */}` — a missing screenshot
- `{/* ToDo: ... */}` — any other outstanding writer task

For each marker, record: the file, the line, the full marker text, and the surrounding sentence or step.

## Step 2 — Classify each marker

For each marker, assign one of three verdicts using the evidence index:

| Verdict | Meaning |
|---|---|
| `resolvable` | The answer is clearly in the evidence — apply it now, no question needed |
| `screenshot-available` | The marker asks for a screenshot and a matching one exists in `.assets/` |
| `unresolvable` | No evidence source answers this — leave the marker, report it |

Rules for `resolvable`:
- The answer must come from observed app behavior, a confirmed SME fact, or direct Playwright observation — not a guess.
- If two sources conflict, classify as `unresolvable` and note the conflict.

Rules for `screenshot-available`:
- Match by what the screenshot shows against what the marker needs.
- Only classify as `screenshot-available` if the screenshot genuinely shows the right UI state.
- If the marker needs a screenshot and none exists but `Admin UI: playwright` is declared, capture it now (read `.env` for credentials, test env only) and then classify as `screenshot-available`.

## Step 3 — Apply resolutions

For each `resolvable` marker:
- Remove the `{/* NEEDS CONFIRMATION: ... */}` comment.
- Replace the uncertain text with the confirmed answer.
- Keep surrounding prose intact — only change what the marker flagged.
- Use the exact UI label/term as observed, not a paraphrase.

For each `screenshot-available` marker:
- Remove the `{/* ToDo: add a screenshot */}` comment.
- Insert the image embed using the correct syntax:
  - Full-page: `![{descriptive alt}](./.assets/{filename})`
  - Dialog/modal (compact): `<img src={require('./.assets/{filename}').default} width="480" alt="{descriptive alt}" />`
- No blank line between a step and its screenshot; no blank line between a screenshot and the next step.

For `unresolvable` markers: leave them exactly as they are.

## Step 4 — Self-review before saving

1. Every `resolvable` marker replaced with a real, sourced answer.
2. Every `screenshot-available` marker replaced with a correct image embed.
3. No invented facts — every replacement is traceable to a source.
4. No `unresolvable` markers touched.
5. Surrounding prose still reads naturally.

## Step 5 — Report

Tell the user:
- How many markers found, how many resolved (confirmed facts vs. screenshots placed)
- Which evidence sources were used
- What remains unresolved — list each with file, marker text, and why it couldn't be answered
- Which files were edited

## Explicit invocation examples

- "resolve-markers: docs/transactions"
- "use resolve-markers on the archive section"
- "run resolve-markers after app-explorer finishes"
