---
name: resolve-markers
description: Resolves every {/* NEEDS CONFIRMATION */} and {/* ToDo */} marker in a section's doc pages automatically using whatever evidence is available — app-notes.md (if app-explorer has run), sme-interview.md, existing screenshots in .assets/, and direct app observation via Playwright. No questions asked when the answer can be found. Only stops for markers that genuinely cannot be answered from any available source. Use explicitly ("resolve-markers: docs/transactions", "use resolve-markers on the archive section").
---

# resolve-markers

You are resolving documentation markers — `{/* NEEDS CONFIRMATION: ... */}` and `{/* ToDo: ... */}` — using every source of evidence available. When the answer can be found, you apply it directly. When it cannot, you leave the marker in place and report it. You do not ask the user to answer anything that the evidence already answers.

## Scope

- **In scope:** resolving `{/* NEEDS CONFIRMATION */}` and `{/* ToDo */}` markers in all doc pages of one section, using all available evidence sources. **Targeted, read-only observation of a single screen via Playwright to confirm one specific marker** (see "Full vs. targeted app access" below). Editing the pages in place. Reporting what was resolved and what remains.
- **Out of scope:** running full app exploration — systematic multi-screen navigation, scenario seeding, or screenshot sweeps (`app-explorer`'s job; see "Full vs. targeted app access" below). Writing new pages. Style review. Translation.

### Full vs. targeted app access

- **Full app exploration** — a systematic pass over a section: seeding test-env scenarios via the API collection, navigating every relevant screen, capturing labeled screenshots of each state, and recording it all into `.sources/app-notes.md`. This is **`app-explorer`'s sole job**.
- **Targeted observation** — navigating to one already-identified screen to confirm a single fact for a specific marker; no scenario seeding, no systematic sweep, no new screenshots unless a specific `{/* ToDo: add a screenshot */}` marker needs one. **This skill may do this** (Step 0, source 4) when no other evidence answers a marker.
- It reads `app-notes.md` when present but **does not require it** — a live targeted check is its fallback.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve content root.
2. The section's `.sources/app-notes.md` — **optional**. Load if present; skip if absent. This file is written by `app-explorer` when it has run — do not require it.
3. The section's `.sources/sme-interview.md` — **optional**. Load if present.
4. The section's `.assets/` folder — list what screenshots already exist there.
5. The doc pages in the section — read each one to find markers.
6. If `Admin UI: playwright` is declared in the project's `CLAUDE.md` — also load `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/value-realism.md` and `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-capture.md`.

Do not load style-guide corpora. This skill edits markers only — it does not rewrite prose beyond filling in the confirmed fact.

## Step 0 — Build the evidence index

Collect every source of evidence available. Work through them in order — later sources fill gaps the earlier ones leave:

1. **`app-notes.md`** (if present) — answers to specific questions, screenshot descriptions, observed UI labels. Best source: direct observation.
2. **`sme-interview.md`** (if present) — confirmed facts from SME or transcript. Good for conceptual and business-rule questions.
3. **`.assets/` contents** — screenshots already saved. A screenshot of the right UI state can answer a `{/* ToDo: add a screenshot */}` marker directly without needing `app-notes.md`.
4. **Live app via Playwright** (if `Admin UI: playwright` is declared in `CLAUDE.md`) — for markers that none of the above answer, navigate to the relevant screen, observe directly, and record the answer. Do not capture new screenshots unless a `{/* ToDo: add a screenshot */}` marker specifically needs one. When capturing a screenshot, apply the scope, annotation, and blur rules from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/screenshot-capture.md`. Read credentials from `.env` — never hardcode them, never use production. Apply the **"Value realism rule — mandatory"** from `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/value-realism.md` for any values entered into the UI.

Build an internal index:
- Every confirmed answer → source + answer text
- Every available screenshot → filename + what it shows
- Every question with no answer yet → mark as unresolved for now

If none of these sources exist and `Admin UI:` is `none`, continue — the skill still runs, it just classifies most markers as `unresolvable` and reports them.

## Step 1 — Find all markers

Scan every `.md`/`.mdx` file in the section folder for:
- `{/* NEEDS CONFIRMATION: ... */}` — a fact that was uncertain when the page was written
- `{/* ToDo: add a screenshot — ... */}` — a missing screenshot
- `{/* ToDo: ... */}` — any other outstanding writer task that needs a *fact or observation* to resolve (a missing UI label, an unconfirmed step, a value to check in the app)

This skill owns fact/observation markers. It does **not** handle pure cross-link TODOs — a `{/* ToDo: link to ... */}` whose only need is a link to another existing page belongs to `fix-doc-todos` (its Buckets A–C). If you encounter such a link-only ToDo, leave it and note it for `fix-doc-todos` rather than resolving it here.

For each marker, record: the file, the line, the full marker text, and the surrounding sentence or step.

## Step 2 — Classify each marker

For each marker, assign one of four verdicts using the evidence index:

| Verdict | Meaning |
|---|---|
| `resolvable` | The answer is clearly in the evidence — apply it now, no question needed |
| `screenshot-available` | The marker asks for a new screenshot and a matching one exists in `.assets/` |
| `screenshot-recapture` | The marker explicitly asks to recapture — always re-capture and overwrite, regardless of what is already in `.assets/` |
| `unresolvable` | No evidence source answers this — leave the marker, report it |

Rules for `resolvable`:
- The answer must come from observed app behavior, a confirmed SME fact, or direct Playwright observation — not a guess.
- If two sources conflict, classify as `unresolvable` and note the conflict.

Rules for `screenshot-available`:
- Applies only to `{/* ToDo: add a screenshot — ... */}` markers (not `recapture`).
- Match by what the screenshot shows against what the marker needs.
- Only classify as `screenshot-available` if the screenshot genuinely shows the right UI state.
- If the marker needs a screenshot and none exists but `Admin UI: playwright` is declared, capture it now (read `.env` for credentials, test env only) and then classify as `screenshot-available`.

Rules for `screenshot-recapture`:
- Applies only to `{/* ToDo: recapture screenshot — ... */}` markers. This marker is **authored by hand** for now (e.g. when you know a screen changed) — no skill emits it automatically yet; a future `doc-freshness-checker` will become its producer. Treat it as a valid, expected input even though the writers never generate it.
- Always re-capture via Playwright regardless of what is already in `.assets/` — overwrite the existing file.
- Use the context around the marker (alt text of the existing image, step text, `app-notes.md` navigation path and selectors) to determine what screen to navigate to and what element to capture.
- Apply all rules from `screenshot-capture.md`: scope ladder (Section 1), two-shot pattern if the marker is adjacent to a dialog step (Section 2), annotation (Section 3), blur (Section 4).
- If `Admin UI: playwright` is not declared, classify as `unresolvable` and report it.

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

For each `screenshot-recapture` marker:
- Re-capture the screenshot via Playwright (see Rules for `screenshot-recapture` above).
- Overwrite the existing file in `.assets/` with the new capture.
- Remove the `{/* ToDo: recapture screenshot */}` comment.
- Leave the existing image embed in place — the filename stays the same, the file on disk is now the fresh capture.

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
