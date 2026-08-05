---
description: End-to-end flow — turn an SME video interview into a finished, style-checked documentation page.
argument-hint: "<doc-folder> [type:concept|user-guide|api]"
---

Run the full authoring pipeline for one documentation page, from a recorded SME interview to a style-checked draft.

- **Arguments:** $ARGUMENTS
- Parse the leading path as the **doc folder** (the folder containing `.sources/`, e.g. `docs/payment-methods/quasi`). Parse an optional trailing `type:` token.

This command is **thin orchestration**. Every phase hands off to a skill that already knows its own job. Do not re-implement any skill's logic here, and do not load rule corpora directly — the skills route their own loading.

## Where to split the run

This command runs at whatever model and effort the session already has — it cannot change them for itself. The phases are uneven, so **tell the user this once, at the start, then continue**:

> Phases 0–4 gather material: reading config, running a script, targeted code searches, capturing UI screenshots. Light reasoning, mostly tool work.
>
> Phases 5–6 write the page and check it against the style guide. That is where the judgement is, and where mistakes have historically slipped through.
>
> If you want to spend effort where it matters, stop after Phase 4 and start Phases 5–6 in a fresh run at a higher setting. The natural break is already there: the writer skill stops to interview you before drafting.

Do not decide this for the user and do not stall waiting for an answer — mention it, then get on with Phase 0.

If the user does split the run, Phase 5 needs only `.sources/sme-interview.md`, the screenshots, and the project config. It does not need Phases 0–4 in context, so a fresh session starts cheaply.

## Token discipline — applies to every phase

This flow touches a video, a code repository, and a live web UI. Each can burn enormous context if handled carelessly. Hard rules:

- **Never read a source code repository broadly.** No directory walks, no reading whole packages "for context". Search for one named symbol at a time (`grep` for a constant, a struct, a function name), then read only the matching lines plus enough surrounding lines to understand them.
- **Never open screenshots in bulk.** Read `frames-index.json` first — it is text and cheap — and open only the images you selected from it. Target 3–8 per page.
- **Never paste large file contents into your reasoning.** Quote the specific lines that answer a specific question.
- If a phase's output is long, write it to its file and summarise in two or three lines. Do not echo the file back.

---

## Phase 0 — Resolve configuration and check prerequisites

Read the host project's `CLAUDE.md`, section **Documentation toolkit configuration**. You need:

| Field | Used for |
|---|---|
| `Style guide:` | which rule corpus the draft and review run under |
| `Content language:` | the language to write in |
| `UA content root:` / `EN i18n root:` | where pages live |
| `Code reference repo:` | *(this command)* local path to the product's source repo, for verifying facts |
| `Admin UI:` | *(this command)* `playwright` if the project has live-UI screenshot automation, or `none` |

Resolve the first four through `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` and `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — follow those files, don't restate their procedures.

For the last two: if either is missing, **ask once**, and offer to write the answer into that project's `CLAUDE.md` under the same section so the question isn't repeated. If the user says the project has no code repo or no live UI, record that and skip the matching phase — both are optional enrichment, not requirements.

Then check the doc folder:

- `.sources/` must exist and contain one of:
  - A **video or transcript** → run all phases (1 → 2 → 3 → 4 → 5 → 6).
  - An **`app-notes.md`** (written by `app-explorer`) → skip Phases 1 and 2; start at Phase 3 (code verification, if declared) or Phase 5 (writer skill) directly. `app-notes.md` is a complete evidence source — the writers accept it as a first-class input. Say so to the user: "No video or transcript found. Using app-notes.md as the evidence source — skipping Phases 1 and 2."
  - If **neither** exists, stop and say so.
- List what's present: video, `.txt` transcripts, an existing `sme-interview.md`, an existing `frames/` folder, an existing `.assets/`.
- If a finished page already exists at the target path, **stop and ask** whether to overwrite, write alongside, or abort. Never silently overwrite someone's page.

Report what you found and what you plan to run, then continue.

---

## Phase 1 — Screenshots from the recording

Skip this phase if the folder has no video and no transcript (i.e., the app-notes.md path was chosen in Phase 0).

Hand off to the **`extract-sme-screenshots`** skill.

That skill owns the choice between its two modes and is required to ask the user which one to run when frames are missing and a transcript exists. Do not pre-empt that choice or pick for them.

Skip this phase entirely if `frames/` already holds frames and the user doesn't want them regenerated — ask rather than assume.

Long runs go in the background; read the progress file when the user asks, not in a loop.

---

## Phase 2 — Structured source notes

Skip this phase if the folder has no video and no transcript. `app-notes.md` already serves as the structured source; no `sme-interview.md` is needed in this path.

Hand off to the **`convert-sme-input`** skill to produce `.sources/sme-interview.md` from the transcripts, using the frames for visual verification.

Two things this command additionally requires, because past runs got them wrong:

- **Timestamp citations are the point, not decoration.** Every fact tied to something visible on screen needs a `(M:SS)` citation, verified against an actual frame before it is written. A file with almost no citations means the visual check never happened — say so plainly rather than passing it on.
- **These notes are source material, not draft prose.** Later phases take *facts* from this file, never its wording, headings, or formatting. This is where English headings and stray bold have leaked into finished pages before.

---

## Phase 3 — Verify against the source code *(skip if no `Code reference repo:`)*

Use the code repo to **resolve ambiguity and confirm details** the interview left unclear: exact constant names, field names, query parameter spellings, enum values, which values are actually reachable.

### Confidentiality rule — mandatory

This project treats direct code inspection as **not disclosable**. Every fact that reaches the published page must be attributable to a **non-code source**: the recorded interview, a tracker ticket, or a question answered by a developer.

In practice:

- Use the code to **check** whether what the SME said is right, and to fix spellings and exact identifiers.
- Do **not** introduce a fact into the page that exists only in the code and has no interview or ticket behind it. If the code reveals something important that no non-code source covers, record it in `sme-interview.md` under open questions as *"needs confirmation from the dev"* — and leave it out of the page until it has one.
- Never cite a file path, line number, or repository name as the source of a statement in the finished page.

This is a hard constraint, not a preference. If it conflicts with completeness, completeness loses.

### How to search efficiently

Work from a list of specific unknowns produced in Phase 2. For each one, grep for the single symbol, read the matching lines, move on. Do not browse.

---

## Phase 4 — Live UI screenshots *(skip if `Admin UI:` is `none`)*

**Prefer live screenshots over video frames for anything visible in the product's UI.** A live capture is clean, full resolution, and free of meeting artefacts — participant panels, personal desktops, other people's faces. Video frames are best used to work out *what* to capture and to cover screens the live environment can't reach.

Follow the host project's own screenshot automation conventions — read its `screenshot-tests/README.md` (or equivalent) and match the existing pattern rather than inventing one. Typically: a spec file per section reusing the established `login()` helper, a matching npm script, credentials from a gitignored `.env`, output written straight into the page's `.assets/`.

Rules:

- **Never write credentials into a spec file, a report, or the page.** They come from environment variables. If they're missing, stop and ask the user to fill in `.env` — do not invent or guess them.
- **Never point automation at production.** Use the test environment the project declares. If you cannot tell which one a URL is, ask.
- Name files by what they show, using the same convention the writer skills use.
- A shared test environment means table contents shift between runs. Say so when you report, so the user reviews diffs before committing.

Even for live captures, the writer skill's screening step still applies — a test admin panel can still show real customer data, internal hostnames, or environment labels.

---

## Phase 5 — Write the page

Choose the writer skill by the `type:` argument, or infer it and **confirm with the user** before drafting:

| Type | Skill | For |
|---|---|---|
| `concept` | `concept-doc-writer` | how something works, models, lifecycles, background |
| `user-guide` | `user-guide-writer` | step-by-step procedures |
| `api` | `api-doc-writer` | endpoint reference |

The writer skill owns the template, the interview step, image selection, the screening step, and its own self-review. Let it run its process — including its questions to the user. Do not answer its interview questions on the user's behalf from what you learned in earlier phases; supply the facts, let the user decide the judgement calls.

---

## Phase 6 — Style check, then fix

1. Run **`doc-style-reviewer`** on the finished page. Pass no guide argument — it resolves the profile from the project's declaration.
2. Run **`doc-style-fixer`** on the resulting report.

The fixer classifies findings and asks before changing anything. Let it ask. Do not accept fixes on the user's behalf.

Then **run the review once more.** The first fix pass changes the text, and the second pass is what catches anything the changes introduced or revealed.

---

## Phase 7 — Report

Keep it short and factual:

- Files created or changed, with paths.
- Which mode Phase 1 ran, and how long it took.
- How many screenshots exist, how many were selected, how many were opened to choose them.
- Unresolved `{/* NEEDS CONFIRMATION */}` and `{/* ToDo */}` markers, listed.
- Anything Phase 3 found that has no non-code source yet, and is therefore deliberately absent from the page.
- Style findings left unapplied, and why.
- Anything you skipped and the reason.

State plainly what was **not** verified. A phase that was skipped, or a check that didn't complete, is more useful reported than quietly omitted.

## Stop conditions

Stop and ask, rather than guessing, when:

- `.sources/` has neither a video, a transcript, nor an `app-notes.md`;
- a page already exists at the target path;
- UI credentials are missing or a URL might be production;
- the code contradicts the SME on a material fact — that is a question for the SME, not something to resolve silently;
- any phase would need to invent a fact to continue.
