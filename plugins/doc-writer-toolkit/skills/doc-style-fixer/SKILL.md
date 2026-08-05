---
name: doc-style-fixer
description: Applies fixes for findings from a doc-style-reviewer report against a single documentation page — classifying each finding as mechanical (batch-applicable), substantive (rewrite, shown and confirmed one at a time), or judgment-required (asked as a question, never auto-resolved). Reads a report already in the conversation, or runs doc-style-reviewer itself if none exists. Never invoked implicitly — it edits files. Use explicitly ("fix-doc-style", "use doc-style-fixer to apply the findings for...").
---

# doc-style-fixer

You are applying fixes for a `doc-style-reviewer` findings report against exactly one documentation page. This skill never runs on its own — it edits a file, so it only starts when the user explicitly asks for it.

## Scope

- **In scope:** applying findings from one `doc-style-reviewer` report (its Step 5 numbered-card format) to the one file that report was written against. Classifying each finding by fix-applicability, showing diffs, and confirming before every edit.
- **Out of scope:**
  - The style review itself — that's `doc-style-reviewer`'s job. This skill never invents a finding; it only acts on findings that skill already produced. If no report exists yet, this skill calls `doc-style-reviewer` and waits for its output rather than reviewing the file itself.
  - Resolving `{/* ToDo: ... */}` or `{/* NEEDS CONFIRMATION: ... */}` markers — this skill leaves every such marker untouched, even ones a finding happens to sit near. For marker resolution, use the correct handler:
    - Link and prose-block TODOs (Buckets A–C in its categorization) → `fix-doc-todos`.
    - Content-gap TODOs and all `{/* NEEDS CONFIRMATION: ... */}` markers → `resolve-markers` (it uses app-notes.md, sme-interview.md, and Playwright to answer these directly). Note the granularity difference: `resolve-markers` operates on a whole **section folder**, not a single page — running it to clear markers on this one page will also process every sibling page in the section. That's expected; just don't invoke it expecting a single-file edit.
  - UA/EN structural alignment — `doc-alignment-checker`'s job.
  - Any file other than the one the report was written against. No neighboring file, no "while I'm here" cleanup.
  - Rewriting or "polishing" anything the report didn't flag. Finding → fix. No finding → no touch.

## Sources to load

- The `doc-style-reviewer` report (from conversation context, or produced by invoking that skill — see Step 1).
- The target file itself.
- Nothing else. This skill does not re-load style-guide corpora or project rules — the report already did that classification work; this skill only reads the report's own citations back to the user when showing why a fix applies.

## Step 1 — Get the report

Two ways in:

1. **Report already in context.** If a `doc-style-reviewer` report for this exact file is present earlier in the conversation, use it directly. Confirm with the user which report you're using if more than one is present (e.g. the user reviewed the file twice, or reviewed a different file more recently).
2. **No report yet.** Invoke `doc-style-reviewer` for the given path (pass through any `guide:` argument the user supplied), wait for its report, then proceed with that report's findings.

Either way, read the file itself before touching anything — you need current line numbers and exact surrounding text, and the report's line numbers may have drifted if the file changed since the review ran.

## Step 2 — Classify every finding

Sort every card from the report's Errors / Style Deviations / Suggestions sections into exactly one of three buckets. The report's severity tier (Error/Deviation/Suggestion) is orthogonal to this classification — a Suggestion can be judgment-required, and an Error can be mechanical. Classify by what the *fix* requires, not by how serious the *violation* is.

### Bucket 1 — Mechanical

The fix is unambiguous and carries no risk of changing meaning. There is exactly one correct replacement, character-for-character.

Examples: removing emphasis-only bold, replacing a row of asterisks or `xxxxx` with a proper `*PLACEHOLDER_NAME*`, replacing a hyphen with an em dash in a number range, wrapping a code-entity name in code font, replacing a straight apostrophe with the typographic one.

These can be applied as a batch on a single confirmation.

### Bucket 2 — Substantive

The fix requires rewriting a phrase, and more than one phrasing could satisfy the rule. Meaning must be preserved, but the exact words are a judgment call worth showing, not assuming.

Examples: splitting nested parentheses into two sentences, removing an idiom ("під капотом", "по суті") and rephrasing around it, moving a paragraph about future plans into a `{/* ToDo: ... */}` comment, restructuring a sentence to drop a filler phrase.

Every bucket 2 finding gets its own explicit decision — the point is that the user is choosing among viable rewrites, not rubber-stamping a mechanical substitution. Whether those decisions are collected one exchange at a time or together is decided in Step 3's "Bucket 2 — approval form".

### Bucket 3 — Judgment-required

The fix would change terminology or structure, and the skill has no basis to prefer one outcome over another — that basis lives in a person's knowledge of the product or the glossary, not in the report.

Examples: translating an English term that has no approved glossary entry yet, renaming a heading, deciding whether a bolded phrase is a UI label (bold stays) or emphasis on a concept (bold must go and the phrase becomes plain text).

For this bucket, **do not propose a single fix** — ask a question instead, and if the user gives no answer, leave the text exactly as-is and list it in the final report under "left unresolved."

**Calibration example** (from a real case, useful for judging bucket 3 correctly): `**A-Bank Collection ID**` is bold and *correct* — it's the literal label a field carries in the admin panel, i.e. a UI label (project convention Ж1). `**Payment type**` is bold and *wrong* — it's a concept being emphasized, not a UI label, so the bold must come off and the phrase becomes plain text. The markup looks identical in both cases; only the glossary and the surrounding context tell them apart. That's exactly why this can't be mechanical, and why it isn't even always the same bucket — a heading rename or a fresh glossary gap is bucket 3, but once the "is this a UI label" question has been answered for a term, removing an emphasis-only bold on that same term elsewhere is bucket 1.

## Step 3 — Present, grouped, with diffs

- Show findings grouped by bucket, and within a bucket, grouped by rule/tag (not one finding per line in a flat list) — the user is approving a category of change, not scrolling a checklist.
- For every group, show a **diff** (before → after) before asking for confirmation — never apply first and show the result after.
- Offer, per group: apply the whole group, pick individual findings within it, or skip the group entirely.
- Bucket 1 groups can be confirmed and applied together in one exchange.
- Bucket 3 findings are asked as questions, one at a time; no default action, no fix applied without an explicit answer.
- **Never apply a fix that hasn't been confirmed**, no matter how obvious it looks.

### Bucket 2 — approval form

Per-fix consent is mandatory for every bucket 2 finding — that does not change. What can change is how many rounds of back-and-forth it takes to collect it.

**Default, when there are four or more bucket 2 findings:** show every bucket 2 finding's diff together, numbered, in a single message, then collect approval for all of them in a single reply — e.g. "apply 1, 3 and 5; skip 2; rewrite 4 as follows: …". Each finding still gets its own explicit disposition (apply / skip / rewrite-differently); what's batched is the number of exchanges, not the granularity of consent. If the reply leaves a finding's disposition ambiguous, ask about that one finding specifically before applying anything in the group.

**Still go one at a time when:**
- there are only two or three bucket 2 findings — showing them together saves nothing worth the setup;
- the findings change meaning enough that each genuinely needs its own discussion (e.g. removing an idiom where the rewrite could shift the sentence's claim) rather than a quick yes/no.

Use judgment at the boundary; the four-or-more default is a starting point, not a hard trigger — a document with five very small, very similar rewrites (e.g. the same filler phrase removed in five sentences) can still go one-at-a-time if that reads more clearly than a five-item batch, and three substantial rewrites can be batched if the user signals they'd rather review together.

## Step 4 — Apply

- Edit only the file named in the report. Never a neighboring file.
- Never touch the contents of fenced code blocks or inline code spans — unless the finding itself says the code formatting is the violation (e.g. a formula rendered in code font, per `GDSG-FORMAT-SPECIAL-NOTATION`), in which case the fix is exactly what the finding specifies and nothing more.
- Never touch frontmatter except `title`/`description`, and only when a finding names one of those two fields specifically.
- Never resolve a `{/* ToDo: ... */}` or `{/* NEEDS CONFIRMATION: ... */}` marker, even one adjacent to an applied fix. See the Scope section for the correct handler for each type.
- Apply exactly what the confirmed finding specifies. Do not extend a fix to cover similar-looking text the report didn't flag, even in the same sentence.

## Step 5 — Final report

- Counts: how many findings applied, how many skipped, how many still pending a human decision.
- A note recommending the user re-run `/review-doc-style` on the file to verify the result — do **not** invoke it yourself; this is a suggestion, not an automatic next step.
- A list of every finding left unresolved (skipped, or bucket 3 with no answer given), each with the reason it wasn't applied.

## Explicit invocation examples

- `/fix-doc-style docs/payment-methods/quasi/quasi.md` — a `doc-style-reviewer` report for this file is already in the conversation; apply fixes from it.
- `/fix-doc-style docs/transactions/filter-transactions.md guide:gdsg` — no report yet in context; the skill runs `doc-style-reviewer` with `guide:gdsg` first, then works from its output.
- "Use doc-style-fixer to apply the findings from that last review to quasi.md"
