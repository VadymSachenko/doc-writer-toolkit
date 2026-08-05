---
name: section-readiness
description: Read-only diagnostic that scans one documentation section folder and reports what exists — every page classified stub vs complete, all .sources/ inputs and screenshots inventoried, and whether app-access (live UI, API test collection) is declared. Emits a machine-consumable JSON report that the later section steps (`section-planner`, `app-explorer`) consume. Makes no edits and asks no questions beyond path resolution. Use explicitly ("section-readiness", "check readiness of <folder>").
---

# section-readiness

You are producing a **readiness report** for one documentation section folder: a factual, machine-consumable inventory of what already exists and what later steps have to work with. This is the first step in documenting a section — run via `/check-section-readiness` — and its JSON output is the contract the later steps read: `app-explorer` (`/explore-and-resolve`) reads it to know which pages and markers exist, then `section-planner` (`/plan-section`) consumes it (plus the `app-notes.md` app-explorer produced) to propose structure. These steps are separate commands you run in sequence; there is no single orchestrator command today.

This skill **only reports facts**. It makes no edits, writes no doc pages, and asks the user nothing except the path-resolution fallback that `project-paths.md` already defines. It does not decide what pages *should* exist — that is `section-planner`'s job, which consumes this report.

## Scope

- **In scope:** one section folder (a menu-area folder that contains one or more doc pages, e.g. `docs/transactions/`), its `.sources/` and `.assets/` subfolders, and the host project's declared app-access configuration. Classifying each existing page as `stub` or `complete`. Inventorying source material and screenshots. Detecting whether app exploration is possible.
- **Out of scope:** deciding the *expected* page inventory or flagging `missing` pages (that requires a proposed structure — it belongs to `section-planner`). Writing or editing any file. Style review (`doc-style-reviewer`). Structural UA↔EN comparison (`doc-alignment-checker`). Running app exploration (`app-explorer`).

Because "what's missing" needs a notion of what *should* be there, this skill never reports `missing`. It reports only what is present and its state; `section-planner` cross-checks that against the app and proposes the gaps.

## Sources to load

Load only these at task start. Do not load rule corpora, templates, or glossaries — this skill writes nothing and needs no style rules.

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — to resolve the project's content roots and language. Follow it; don't restate it.
2. The host project's `CLAUDE.md`, section **Documentation toolkit configuration** — for the declared roots, language, and app-access fields.
3. The target section folder and its `.sources/` / `.assets/` subfolders — directory listings and lightweight file reads (see Step 2 for how to read cheaply).

## Step 0 — Resolve the folder and project config

1. The caller names a section folder (relative to the repo root, e.g. `docs/transactions`). If none is given, ask which folder, then stop until answered.
2. Resolve the project's content root(s), content language, and UA URL prefix via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`. If a needed field is undeclared, follow that file's ask-once/offer-to-persist fallback — this is the *only* interaction this skill performs.
3. Read the **Documentation toolkit configuration** section for the two app-access fields:
   - `Admin UI:` — `playwright` if live-UI capture is available, or `none`.
   - `API test collection:` — a path to a Postman/newman collection for seeding test-env scenarios, or `none`. *(This field may not exist yet in a given project. If absent, report it as `not declared` — do not ask, do not persist. Reporting its absence is the signal the later steps need.)*

## Step 1 — Confirm the folder exists

If the named folder does not exist under the resolved content root, stop and say so plainly — a readiness scan of a non-existent folder has nothing to report. Do not create it.

## Step 2 — Inventory, reading cheaply

Token discipline: this is a diagnostic scan, not a content pass. **Never** paste full page bodies into your reasoning. For each page, read only the frontmatter and enough of the body to classify it (see Step 3). To count screenshots, read each `.sources/frames/{video-basename}-frames/frames-index.json` (text, cheap) rather than opening images — note the index lives inside each per-video `*-frames/` subfolder, **not** directly under `.sources/`.

Collect:

- **Pages** — every `.md`/`.mdx` file in the section folder (recurse into subfolders; a section is one menu area with many pages). Record each page's relative path.
- **Sources** — contents of `.sources/`: video files, `.txt` transcripts, an existing `sme-interview.md`, an existing `app-notes.md`, a `frames/` folder, `section-plan.md`, `section-state.json`.
- **Screenshots** — count from two independent locations and sum them:
  1. **Video frames.** Enumerate every `.sources/frames/*-frames/` subfolder (there is one per source video, so there may be several). For each, read its `frames-index.json` (at `.sources/frames/{video-basename}-frames/frames-index.json`) and count its entries — that is the authoritative per-video screenshot count. Only if a given `*-frames/` folder has no `frames-index.json` (an older or partial run), fall back to listing its `screen-*.jpg` files, excluding any `_unused/` subfolder. Record each folder in `framesFolders`.
  2. **Curated/app-explorer screenshots.** Independently count image files in `.assets/` folders (excluding any `.assets/ref/` subfolder). A section has one `.assets/` per page (co-located with each page file) plus possibly a section-level `.assets/` from `app-explorer` — sum across all of them. A section may have screenshots here with no video at all — the app-explorer path — so this count stands on its own even when there are zero `*-frames/` folders.
  `screenshotCount` is the sum of (1) and (2). If neither location exists, it is 0.
- **Markers** — count `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}` markers per page (a grep, not a full read).

## Step 3 — Classify each page

For every existing page, assign exactly one state:

| State | Criteria |
|---|---|
| `complete` | Has real frontmatter **and** substantive body prose/procedures beyond the template skeleton; few or no unresolved markers relative to its length. |
| `stub` | Exists but is mostly empty, is an unfilled template skeleton, is placeholder text, or is dominated by `{/* ToDo */}` / `{/* NEEDS CONFIRMATION */}` markers. |

Record, per page: the state, a one-line reason for the classification, the marker count, and a best-effort `docType` guess (`concept` | `user-guide` | `api` | `unknown`) from the frontmatter and headings. The `docType` is a hint for `section-planner`, not a decision — mark it `unknown` when the evidence is thin rather than guessing.

## Step 4 — Assess app-access readiness

Report a small readiness verdict the later steps (`section-planner`, `app-explorer`) can branch on:

- `liveUI`: `available` if `Admin UI: playwright` is declared, else `none`.
- `apiSeed`: `available` if `API test collection:` points at an existing file, `declared-but-missing` if the field names a path that isn't there, else `not-declared`.
- `existingAppNotes`: `present` | `absent` — whether `.sources/app-notes.md` already exists (a prior exploration run).

This skill does **not** launch Playwright or call the collection — it only reports whether doing so is possible.

## Step 5 — Judge the section's overall state

Beyond the per-page facts, assign the section exactly one **verdict** — a one-line read on what starting state the section is in. This tells the caller (and the later steps — `section-planner`, `app-explorer`) which path the section is on:

| Verdict | Criteria |
|---|---|
| `greenfield` | The section folder has no doc pages at all (just the folder, or only non-page files). Nothing exists to build on — the section needs investigation from scratch. |
| `skeleton` | Pages exist but (nearly) all are `stub` — a structure was set up but not filled in. The structure itself may be wrong and can only be validated against the app UI and sources. |
| `needs-revision` | Some or all pages are `complete` — real content exists that likely needs adjustment (merging guides, filling gaps, updating stale info, style review) rather than writing from nothing. |

Record a one-line reason for the verdict. This verdict is a signal, not an instruction — it does **not** tell the later steps what to do, only what they're starting from.

## Step 6 — Write the report

Write the machine-consumable report to **`<section folder>/.sources/section-readiness.json`**, creating `.sources/` if it doesn't exist. Use this schema:

```json
{
  "section": "docs/transactions",
  "generatedFrom": "section-readiness",
  "verdict": "greenfield | skeleton | needs-revision",
  "verdictReason": "all 4 pages are unfilled template skeletons",
  "project": {
    "contentLanguage": "uk",
    "contentRoot": "docs/",
    "uaUrlPrefix": "/"
  },
  "appAccess": {
    "liveUI": "available | none",
    "apiSeed": "available | declared-but-missing | not-declared",
    "existingAppNotes": "present | absent"
  },
  "pages": [
    {
      "path": "docs/transactions/filter-transactions/filter-transactions.md",
      "state": "stub | complete",
      "docType": "concept | user-guide | api | unknown",
      "markerCount": 3,
      "reason": "unfilled user-guide template skeleton; 3 NEEDS CONFIRMATION markers"
    }
  ],
  "sources": {
    "videos": ["..."],
    "transcripts": ["..."],
    "smeInterview": "present | absent",
    "appNotes": "present | absent",
    "framesFolders": ["..."],
    "screenshotCount": 0,
    "sectionPlan": "present | absent",
    "sectionState": "present | absent"
  },
  "summary": {
    "pageCount": 0,
    "stubCount": 0,
    "completeCount": 0,
    "totalMarkers": 0
  }
}
```

Then print a short human-readable summary to the conversation (two or three lines): the **verdict** and why, page count and their states, what sources exist, and the app-access verdict. Do not echo the full JSON back — point to the file.

## Self-review checklist

Before finishing, verify:

1. Every `.md`/`.mdx` page in the folder (including subfolders) appears in `pages`, and each has exactly one `state`.
2. The section `verdict` is present and consistent with the pages (`greenfield` only if zero pages; `skeleton` only if (nearly) all pages are `stub`; `needs-revision` if any page is `complete`).
3. No page was read in full and pasted into reasoning — classification used frontmatter + a bounded body sample only.
4. `appAccess` reflects the *declared* config, and no Playwright run or API call was actually performed.
5. No `missing` verdicts were emitted (out of scope — that's `section-planner`).
6. `screenshotCount` was derived by reading each `.sources/frames/*-frames/frames-index.json` (not `.sources/frames-index.json`, which never exists) plus counting `.assets/` images — not from a bare directory listing when an index was available.
7. The JSON validates (well-formed, matches the schema keys) and was written to `.sources/section-readiness.json`.
8. Nothing outside `.sources/section-readiness.json` was created or edited, and no question was asked beyond the `project-paths.md` fallback.

## Explicit invocation examples

This skill triggers only when named explicitly, or via its wrapper command `/check-section-readiness`. It is the first step you run when documenting a section, before `/explore-and-resolve` and `/plan-section`. Examples:

- "section-readiness: scan docs/transactions"
- "Use section-readiness to check what exists in the transactions folder"
- "check readiness of docs/payouts"
