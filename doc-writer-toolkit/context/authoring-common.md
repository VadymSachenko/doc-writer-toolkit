---
name: authoring-common
description: Shared authoring rules for the three writer skills (user-guide-writer, concept-doc-writer, api-doc-writer) — marker conventions, path & content-language resolution, style-guide loading, voice & audience, the absolute internal-link rule, the partner-cabinet body-text rule, the P1–P5 self-review and reviewer-pass scaffolds, and the explicit-invocation preamble. Referenced by those skills — never copy these blocks back into a skill file.
---

# Authoring common

Single source of truth for the authoring rules that are identical across the three writer skills (`user-guide-writer`, `concept-doc-writer`, `api-doc-writer`). Each writer loads this file and points at the section it needs instead of restating the rule. Where a writer needs a doc-type-specific twist on a baseline below, it keeps that twist inline and references the baseline here — do not hand-copy any block from this file back into a skill.

## Path & content-language resolution

Follow `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` to resolve the project declarations this run needs from the invoking project's `CLAUDE.md`, for the target file:

- **Content language** (`uk`, `en`, or `uk,en`) — resolved by `user-guide-writer` and `concept-doc-writer`; it decides which template, glossary, and grammar sources apply. For `uk,en`, the target file's location relative to the declared **UA content root** / **EN i18n root** decides which language you're drafting in.
- **Content root / EN i18n root / API reference root** — never assume `partner-cabinet/`, never hardcode `docs/` or `docs/api-reference/`; read the declaration for the target location.
- **UA URL prefix** — needed to build absolute links to other doc pages (see **Internal links** below).

If a field this run needs is undeclared, follow `project-paths.md`'s fallback: ask once, and offer to persist the answer to that project's `CLAUDE.md`. Do not restate the resolution procedure — point here.

## Style-guide loading (project-declared, resolved before drafting)

- Follow `${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md` — "Resolving which guide a project uses" section — to find this project's declared `Style guide:` token, compose it with the resolved content language into a profile (`<guide>@<lang>`), then follow that guide's "Loading procedure per guide" entry, mapping the content you're about to write to the matched topical files.
- Apply every matched rule while drafting, not just at a later review pass.
- If the project has no declared style guide, follow the registry's fallback: ask once, offer to persist the answer to that project's `CLAUDE.md`.
- Do not hand-copy a guide name, corpus path, profile logic, or individual rule into a skill file — the registry is the single source of truth and changes independently.
- **Follow the style-guide topical files loaded above** for anything not covered by the project-specific rules — formatting, punctuation, accessibility, notation, code-sample conventions, etc. — check the corpus rather than guessing.

## Marker conventions

- **Never invent facts.** Unconfirmed UI labels, field names, values, or behavior → `{/* NEEDS CONFIRMATION: what's unclear */}` — don't guess.
- **Mark writer decisions needing follow-up** with `{/* ToDo: ... */}`.
- If the user explicitly says "skip questions" or "draft with your best guess," proceed but flag every assumption with `{/* NEEDS CONFIRMATION: ... */}`.
- Preserve, carry over, or check for these markers rather than resolving them silently.

## Orchestrated mode (opt-in — set by the `/document-section` orchestrator)

**Default is blocking.** When a writer is invoked directly, its full per-page blocking interview/question phase runs exactly as written — that is the default and does not change. Orchestrated mode is opt-in: it applies only when the future `/document-section` orchestrator invokes the writer in `orchestrated` mode, because in an orchestrated run there is no human in the loop mid-draft.

When invoked in `orchestrated` mode, a writer:

- **Skips the per-page blocking interview/question phase** — and every other "wait for the user" gate. It never stops to wait for a human mid-draft.
- **Drafts with its best-guess resolution of every gap** — the same resolution it would otherwise have offered as a question's proposed answer.
- **Flags each assumption with a `{/* NEEDS CONFIRMATION: ... */}` marker** at the point in the draft where the assumption was made. `resolve-markers` batch-processes these later.
- **Surfaces all assumptions as one consolidated batch list at the end of the run** — every `{/* NEEDS CONFIRMATION */}` it introduced, gathered in one place — for the orchestrator's approval gate / `resolve-markers` to act on.

Everything else in the writer's workflow (facts sheet, drafting rules, screenshot handling, self-review, reviewer pass, save, and the end-of-run report) runs unchanged. Orchestrated mode removes only the human-blocking gates; it never lowers the drafting or review bar and never resolves a marker silently.

## Voice & audience

- **Active voice, second person — never the product as subject.** In steps, Result blocks, and prose alike, never use a system/product noun ("the Partner", "Партнер") as the grammatical subject. See `formatting-conventions.md`'s sentence-style section for the resolved language.
- **A UI element is never the subject of an action** — the action happens to/in the object. ✅ "Transactions appear in the table." ⛔ "The table displays transactions."
- **No marketing adjectives** (`powerful`, `seamless`, `robust`).

## Internal links

**Internal links to other doc pages must be absolute.** Form every link to another page as the project's declared **UA URL prefix** (resolved via `project-paths.md`) + the target page's path relative to the content root, **with no `.md`/`.mdx` extension** — e.g. `/balance/add-cards/add-cards`, or `/partner-cabinet/transactions/transactions` for a project whose prefix is `/partner-cabinet/`. Append an anchor as `#slug` when linking to a section. **Never** write a document-relative link (`./…`, `../…`) to another page, and never hardcode `/docs/`. This governs page-to-page links only — screenshot/asset links stay document-relative (`./.assets/…`), and intra-page anchors stay bare (`#slug`).

## Partner-cabinet body-text rule

**Do not name the partner-cabinet context explicitly in page body text.** The reader is already in it. `uk`: avoid «кабінет партнера», use «меню» for navigation references — wrong: «в розділі X у кабінеті партнера», right: «в меню X». `en`: avoid explicit "in the partner cabinet"; use "the menu" or the feature's own name instead. (Applies to `user-guide-writer` and `concept-doc-writer`; an `api-doc-writer` page is an English endpoint reference and doesn't narrate the partner-cabinet UI in body prose.)

## Self-review scaffold (P1–P5)

Run these five checks before saving, in addition to the skill's own doc-type-specific checklist:

- **P1 — Inherited wording normalized.** For every heading and every bolded fragment, confirm it is not lifted from `.sources/` (or the brief, where one exists) — a heading, a bold label, an entire phrase — without normalization. The interview/notes are a source of *facts*, not of *wording*; a heading or emphasis pattern copied verbatim is a defect even if the fact is correct.
- **P2 — Heading language (Ж7).** Every heading is in the resolved content language; a code entity inside one stays in `code font` but the surrounding words don't switch language.
- **P3 — Bold only on visible UI labels (Ж1).** For every `**...**` span, confirm it is a UI element's visible label, not emphasis on a fact, a term, or a module name.
- **P4 — Document as-is (Ж6).** No plans, upcoming changes, or "the team intends to..." in page body text (including inside admonitions) — only inside `{/* ToDo: ... */}`.
- **P5 — One render per entity (Ж3).** List the document's technical entities and confirm each is written exactly one way everywhere in the page — not split across a code-font, quoted, and plain-text rendering of the same thing.

## Reviewer-pass scaffold (P1–P5)

After the self-review passes, do a focused second read that targets P1–P5:

- **P1 — Inherited wording.** Diff every heading and bolded phrase against `.sources/` (and the brief, where one exists); rewrite any that were copied without normalization.
- **P2 — Heading language.** Flag and rewrite any heading that mixes languages or leaves a glossary concept in its source language.
- **P3 — Bold audit.** Re-walk every `**...**` span; strip bold from anything that isn't a visible UI label.
- **P4 — As-is audit.** Search the body (including admonitions) for future/planned-change language; move it to `{/* ToDo: ... */}`.
- **P5 — Render audit.** Build the entity list; fix every entity with more than one rendering in the document.

## Explicit-invocation preamble

Every writer skill is **explicit-invocation only**: it triggers only when the user names it explicitly and must never fire on an implicit request. If the user asks for documentation of the relevant type without naming the skill, suggest invoking it but wait for explicit permission. Each skill lists its own valid invocation examples.
