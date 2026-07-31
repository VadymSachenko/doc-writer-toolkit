---
name: concept-doc-writer
description: Writes concept topic pages for the UniComPay partner cabinet, in the project's declared content language, following the authoring rules in CLAUDE.md. Use explicitly ("use concept-doc-writer to document...", "concept-doc-writer: write the Transaction lifecycle page"). Follows ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-concept-topic-template.md (Ukrainian) or concept-topic-template.md (English), with a mandatory interview phase before drafting. Not for API reference pages or user guides.
---

# concept-doc-writer

You are writing a concept topic page for the UniComPay partner cabinet, in the content language this project declares. The authoring contract in `CLAUDE.md` is already loaded; this skill adds the procedure for producing a concept page end-to-end.

## Scope

- **In scope:** concept topics that explain background information — how a feature works, what a term means, lifecycle models, data flows, system behaviour, constraints, and domain context. One topic per page.
- **Out of scope:** API reference pages (`docs/`), user guides (step-by-step procedures), EN translations of a UA-authored page (that is `doc-translator`'s job — only relevant on a project that translates rather than dual-authors), `sidebars.ts` changes.

## Sources to load

Load these files at the start of the task. Do not load others unless the user references them explicitly.

**Content language (resolve first — decides which of the remaining bullets apply):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` to resolve this project's declared `Content language:` (`uk`, `en`, or `uk,en`) for the target file. For `uk,en`, the target file's location relative to the declared UA content root / EN i18n root decides which language you're drafting in. If undeclared, follow that file's fallback (ask once, offer to persist).

**Templates (load the one matching the resolved language):**
- `uk` → `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/ua-concept-topic-template.md`
- `en` → `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/concept-topic-template.md`
- Authoritative structure and Design rules either way. When the template and examples disagree, the template wins.

**Project rules:**
- `uk` → `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md`; `en` → `glossary-en.md` — canonical terminology for the resolved language.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/api-integration-context.md` — cross-cutting facts about the API (balances, transaction lifecycle, webhooks, disputes, auth, business rules). Always applicable background.
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md` — rank-0 project formatting conventions (what bold/italic/code font mean here, placeholder form, one-entity-one-render, code-entity vs. human concept). Outranks everything else loaded for this task, including this skill's own body. Loaded regardless of resolved language — it carries both a language-neutral core and a per-language section.

**UA grammar — only when the resolved language is `uk`:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/00-cheatsheet.md` — always-loaded quick reference for UA orthography. Do not load this on an `en` page; it is Ukrainian-specific and has no EN counterpart (English sentence-style rules live in `formatting-conventions.md`'s English section instead).

**Style guide (project-declared, resolved before drafting):**
- Follow `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — "Resolving which guide a project uses" section — to find this project's declared `Style guide:` token, compose it with the resolved content language into a profile (`<guide>@<lang>`), then follow that guide's "Loading procedure per guide" entry, mapping the content you're about to write (formulas, tables, lists, code samples, admonitions, etc.) to the matched topical files.
- Apply every matched rule while drafting, not just at a later review pass.
- If the project has no declared style guide, follow the registry's fallback: ask once, offer to persist the answer to that project's `CLAUDE.md`.
- Do not hand-copy a guide name, corpus path, profile logic, or individual rule into this skill file — the registry is the single source of truth and changes independently of this file.

**Examples — voice and tone reference only, regardless of the resolved content language:**
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/concept-topic-examples/concept-topic-example-localizations-overview.md`
- `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/doc-examples/concept-topic-examples/concept-topic-example-upsell-upgrade-subscription.md`

These examples illustrate prose density, section selection, admonition use, and table formatting. They do **not** represent the target structure, and their own language does not dictate yours. For sections, headings, and required content, follow the template. When an example and the template disagree, the template wins.

## Workflow

Execute the steps in order. Do not skip the interview.

### Step 1 — Locate inputs

Resolve this project's UA content root (or, on an `en` page, its EN i18n root — see `project-paths.md`) for the target location; do not assume `partner-cabinet/`. Ask the user for the target doc folder if not provided (e.g., `<content root>/transactions/transaction-lifecycle/`). Sources live inside that folder.

List the files present. Expected contents:
- `.sources/sme-interview.md` — primary source; SME brief or interview transcript. If absent, notify the user and request an alternative.
- `.sources/notes.md` — writer's own notes; treat as authoritative.
- `.sources/frames/{video-basename}-frames/` — the full archive of frames extracted from a source recording, plus a `frames-index.json` alongside them. This is evidence, not embeddable material — never insert a file from here directly into the page. See "Selecting screenshots" in Step 2.
- `.assets/*.png` — screenshots already selected and ready to embed in the doc.
- `.assets/ref/*.png` — reference-only screenshots (read for context; never embed in the doc). This folder is optional. If it does not exist or is empty, treat all files directly in `.assets/` as both context and embeddable.

Also check existing approved pages under the content root for contextual consistency — only after exhausting the source files. Do not copy structure or prose from them.

If neither `.sources/` nor `.assets/` exists, ask the user where the inputs are before proceeding.

### Step 2 — Analyze inputs

Read every file in `.sources/`. Extract:
- The core concept to explain (what it is, why it exists, why a reader needs to understand it)
- Key entities, states, roles, or phases involved
- Rules, constraints, or configuration aspects
- Relationships to other features or concepts
- Any flows that can be illustrated with a Mermaid diagram
- Terminology specific to this concept that needs defining
- Any prerequisites a reader needs before this page makes sense
- Natural next steps or related documents a reader would want after this page

**Selecting screenshots.** Three folders, three distinct roles — do not conflate them:

| Folder | Role |
|---|---|
| `.sources/frames/{video}-frames/` | Full archive of extracted frames + `frames-index.json`. Evidence base. Never embedded directly. |
| `.assets/` | Selected, renamed frames ready for embedding. The **only** folder the page links images from. |
| `.assets/ref/` | Reference-only frames: read for context, **never** embed (existing rule). |

Decide which case applies:

1. **`.assets/` (root) already has files** — these are the curated set. Skip to the rename/classify steps below and use them as-is; do not re-derive from `frames/`.
2. **`.assets/` is empty and `.sources/frames/{video}-frames/` exists** — do not draft without images and do not silently proceed with zero screenshots. Run the selection procedure:
   1. Read `frames-index.json` (schema: `screenshot`, `seconds`, `timestamp`, `ocr_text`, `transcript_text`, `score`, `reasons`, `source`). It's text — tens of KB even for ~100 frames — read the whole thing, not a sample.
   2. For each section you plan to write, find candidates by matching the section's subject against `ocr_text` (what's visibly on screen) and `transcript_text` (what the SME was saying), prioritizing higher `score`.
   3. **Open only the shortlisted candidates** — aim for 3–8 images for the whole page, not all of them. Confirm each one actually shows what the section needs before using it.
   4. **Copy** (not move) the confirmed files into `.assets/` — `frames/` must stay a complete archive for `cleanup-unused-screenshots` to sweep later.
   5. Continue to the rename/classify steps below on the copied files.
3. **`.assets/` is empty and there is no `frames/` folder** (older run, or none extracted) — fall back to the plain "list `.assets/`" behavior and tell the user no `frames-index.json` exists, so they know why you can't do index-driven selection.
4. **Neither folder exists** — ask the user where screenshots are before proceeding, per Step 1.

For every file that ends up in `.assets/` (root), whichever case applied, work through these steps **in order** — do not rename or embed a file that hasn't passed step 1, even if it "looks clean" on a first glance:

1. **Screen for sensitive content (required — never skip this, and never skip it because the frame looks clean).** A frame pulled from a meeting recording is raw evidence, not embeddable material — it was never composed as a screenshot for a public page. Before anything else:
   - **Crop to the part that matters.** Participant bars, toolbars, the dock, browser tabs, side panels — none of that is the subject. Isolate only the UI area the section actually needs.
   - **Check the cropped result against this list** — faces and people's names; usernames and logins; hostnames, domains, IP addresses; environment labels (`PROD`, `TEST`); internal URLs; tokens, keys, session IDs; card and account numbers; customer personal data; other apps and personal desktop items. Look in toolbars and corners, not just the center of the frame — a sensitive label sitting in a place nobody looks is still disqualifying.
   - **If cropping can't remove something on the list** — for example a sensitive label sitting inside a table you need — **do not decide alone**. Ask the person you're working with and do not insert the image until they answer.
   - **Save the cropped result as PNG**, regardless of the source frame's format (frames arrive as `screen-HH-MM-SS.jpg`). Cropping already rewrites the file, so converting at this step costs nothing extra, and PNG suits UI screenshots better — this is also what keeps the `.png` extension in the rename pattern below accurate.
   - These checks implement `GDSG-VISUALS` and `GDSG-EXAMPLE-001` from the loaded style guide corpus — consult those entries directly for the underlying rules; they are not repeated here.
2. **Rename** — if the filename is non-descriptive (e.g., `image.png`, `image copy.png`, a random string, or a numeric timestamp — this includes the `screen-HH-MM-SS.jpg`-style names frames arrive with), rename it following the pattern `{subject}-{ui-element-type}.png` in kebab-case:

   | UI element type | Suffix | Example |
   |---|---|---|
   | Full-page menu or table | `-page` or `-page-{tab}` | `transactions-page-payout-tab.png` |
   | Dialog / modal window | `-dialog` | `transaction-receipts-dialog.png` |
   | Side panel / filter panel | `-pane` | `filters-pane.png` |
   | Standalone form | `-form` | `add-receipt-form.png` |
   | Confirmation banner / toast | `-banner` | `receipt-uploaded-banner.png` |

   Use the Bash tool: `mv "./.assets/old-name.png" "./.assets/new-name.png"`. Rename before drafting so all embed references use the final filename.
3. **Classify** as **full-page** or **compact**:
   - **Full-page** — whole menu, dashboard, or table spanning the full content area.
   - **Compact** — dialog window, modal, or narrow panel that visually occupies significantly less than the full content width.

Note the final filename and classification per file; both are used in Step 5.

### Step 3 — Compose a facts sheet

Before asking questions, produce a short internal facts sheet organized as:

- **Confirmed facts** — what the inputs clearly state
- **Unclear or contradictory** — where inputs disagree or leave a detail ambiguous
- **Gaps** — aspects of the concept the inputs don't cover that would be needed for a complete page

Do not show this sheet to the user unless asked. It is scaffolding for Step 4.

### Step 4 — Interview the user (mandatory)

Ask 3–5 targeted questions in one batch. Rules:

- **Maximum 5 questions.** If more real gaps exist, pick the 5 most blocking and save the rest for a follow-up round after drafting.
- **Each question must cite evidence.** Reference the source of the uncertainty: "The interview says X, but the notes say Y. Which is correct?"
- **No generic questions.** Style and tone are answered by the template and, for a `uk` page, the cheatsheet. Questions must be about facts or concepts the inputs don't resolve.
- **If the inputs are complete and unambiguous, skip the interview.** Say: "Inputs are complete. Drafting now." Do not invent questions for ritual.
- **If the user explicitly says "skip questions" or "draft with your best guess," proceed without interview** but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.

Wait for the user's answers before Step 5.

### Step 5 — Draft the page

Apply the template resolved in "Sources to load". Concept topics do not have a fixed spine — choose sections from the template's section menu that fit the topic.

Rules:
- **Overview is mandatory.** Every page must open with a lead paragraph that states: what this concept is, why it exists in the system, and why the partner needs to understand it.
- **Write in the resolved content language.** Follow the template's Design rules section, and the sentence-style, heading-language, and terminology rules for that language in `formatting-conventions.md` (imperative mood, present tense for current behavior, intro-sentence phrasing before numbered lists, UCP/UniComPay naming) — do not restate them here.
- **Never invent facts.** If a fact is not in the sources or user answers, flag it with `{/* NEEDS CONFIRMATION: what's unclear */}` — don't guess.
- **Apply the glossary** resolved in "Sources to load". Replace synonyms with the canonical term for the resolved language.
- **No step-by-step procedures.** Instructions belong in user guides. Concept topics explain; they do not instruct.
- **For flows and lifecycles:** prefer a Mermaid `sequenceDiagram` for multi-actor flows and a Mermaid `flowchart` for decision trees or status transitions.
- **For screenshots:** only embed from `.assets/` (root) — never from `.assets/ref/`. Choose syntax based on the classification from Step 2:
  - **Full-page**: `![Descriptive alt text](./.assets/image.png)`
  - **Compact** (dialog, modal, narrow panel): `<img src={require('./.assets/image.png').default} width="480" alt="Descriptive alt text" />`
- **For tables:** use them for structured comparisons, field definitions, or status lists.
- **Section headings:** noun phrases in sentence case, in the resolved content language (Ж7 in `formatting-conventions.md` — a heading is never mixed-language; a code entity inside one may stay in `code font`). No numbered headings.
- **Do not name the partner-cabinet context explicitly in page body text.** The reader is already in it. `uk`: avoid «кабінет партнера», use «меню» for navigation references — wrong: «в розділі X у кабінеті партнера», right: «в меню X». `en`: avoid explicit "in the partner cabinet"; use "the menu" or the feature's own name instead.
- **Attribute column text:** text in a reference table's attribute-description column (**Атрибути** / **Attribute**) must not be bold.
- **Colon over dash in bullet lists:** when labelling items, prefer `:` over `—`. If the label is a UI element name, do not bold the colon (`**UI element**: description`); if the label is plain text, bold both label and colon (`**Label:** description`).
- **UI labels and status values, placeholders, code-vs-concept rendering:** follow `formatting-conventions.md`'s Core section (Ж1–Ж7) — do not restate its rules here.
- **Follow the style-guide topical files loaded above** for anything not covered by the project-specific rules in this list (formula/notation formatting, code sample conventions, accessibility, etc.) — check the corpus rather than guessing.
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}`.

### Step 6 — Self-review before saving

Before writing to disk, check:

- Every glossary term used in prose matches the canonical form in the resolved-language glossary
- Intro sentences before numbered lists follow the resolved language's phrasing rule in `formatting-conventions.md`, or are omitted where the heading already conveys the action
- Bullet list items use `:` not `—`; colon is not bold when adjacent to a UI element name
- The partner-cabinet context is not named explicitly in body text (see Step 5)
- Attribute column values in tables are not bold
- No description of current system behavior uses future tense (`formatting-conventions.md`, sentence-style section for the resolved language)
- On a `uk` page: no calques from `formatting-conventions.md`'s "Кальки й слова-заборони" (не «являється», «даний», «в залежності від»)
- No marketing adjectives
- UI labels, status values, placeholders, and code-vs-concept rendering follow `formatting-conventions.md` Ж1–Ж4
- No product/UI element used as the grammatical subject where the reader should be (active voice, second person — `formatting-conventions.md` sentence-style section)
- Every fact in the page is traceable to an input source or a user answer from Step 4
- The overview is present and covers: what the concept is, why it exists, and why the reader needs it
- All chosen sections are complete; bare placeholders are either filled or removed
- Next steps links only to user guides; Related documents links to other concepts or references
- The draft conforms to every rule in the style-guide topical files loaded per "Sources to load" (resolved via `style-guide-registry.md`) — check against those files directly, don't rely on memory of past drafts
- **P1 — Inherited wording normalized.** For every heading and every bolded fragment, confirm it is not lifted from `.sources/` (a heading, a bold label, an entire phrase) without normalization. The interview/notes are a source of *facts*, not of *wording* — a heading or emphasis pattern copied verbatim from `sme-interview.md` is a defect even if the fact itself is correct.
- **P2 — Heading language (Ж7).** Every heading is in the resolved content language; a code entity inside one stays in `code font` but the surrounding words don't switch language.
- **P3 — Bold only on visible UI labels (Ж1).** For every `**...**` span, confirm it is a UI element's visible label, not emphasis on a fact, a term, or a module name.
- **P4 — Document as-is (Ж6).** No plans, upcoming changes, or "the team intends to..." in page body text (including inside `:::note`/`:::warning`) — only inside `{/* ToDo: ... */}`.
- **P5 — One render per entity (Ж3).** List the document's technical entities and confirm each is written exactly one way everywhere in the page — not split across a code-font, quoted, and plain-text rendering of the same thing.

### Step 7 — Reviewer pass

After the self-review passes, do a focused second read that targets the project-specific rules:

1. Page intro — if it names the partner-cabinet context explicitly, rewrite to use «меню» / "the menu" or omit.
2. Each section heading — if the heading matches the immediately following intro sentence, delete the intro sentence.
3. Each remaining intro sentence — strip bold formatting if present.
4. Each bullet list — replace `—` with `:`; adjust colon bolding per the UI-element rule.
5. Reference table attribute-description column — remove bold from all cell values.
6. UI labels and status values — reconcile against `formatting-conventions.md` Ж1/Ж4 (visible UI label → bold; system/API value not shown as-is in the UI → code font).
7. Product/UI element as grammatical subject — rewrite to active voice, second person.
8. **P1 — Inherited wording.** Diff every heading and bolded phrase against `.sources/`; rewrite any that were copied without normalization.
9. **P2 — Heading language.** Flag and rewrite any heading that mixes languages or leaves a glossary concept in its source language.
10. **P3 — Bold audit.** Re-walk every `**...**` span; strip bold from anything that isn't a visible UI label.
11. **P4 — As-is audit.** Search the body (including admonitions) for future/planned-change language; move it to `{/* ToDo: ... */}`.
12. **P5 — Render audit.** Build the entity list; fix every entity with more than one rendering in the document.

Fix every issue found before saving.

### Step 8 — Save

Save to `<content root>/<target-folder>/<slug>.md`, where the target folder was confirmed in Step 1.

Do not update the sidebar config file (`sidebars.ts`, or a project's custom-id equivalent) — it's auto-generated.

Do not create a translation of this page — that is a separate step using the `doc-translator` skill after human approval, on a project that translates rather than dual-authors.

After saving, report:
- The file path written
- The resolved content language and its source (project declaration vs. asked)
- A short summary of what was produced (sections chosen, key concepts covered)
- Which screenshot case from Step 2 applied, and how many images were selected out of how many available frames (if the index-driven procedure ran)
- A list of unresolved `{/* NEEDS CONFIRMATION: ... */}` items, if any
- A list of unresolved `{/* ToDo: ... */}` items, if any
- Any follow-up questions deferred from Step 4

## When inputs are insufficient

If after the interview the inputs still leave the overview plus more than half the planned sections unfilled, do not draft. Report the specific gaps to the user and ask whether to proceed with heavy `{/* NEEDS CONFIRMATION */}` flagging or to pause and gather more input.

## Explicit invocation examples

This skill triggers only when the user names it explicitly. Examples of valid invocations:

- "Use concept-doc-writer to document the transaction lifecycle"
- "concept-doc-writer: write the Webhook delivery model page"
- "Invoke concept-doc-writer for the dispute resolution overview"

If the user asks for concept documentation without naming this skill, suggest invoking it but wait for explicit permission.
