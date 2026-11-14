---
name: doc-todo-fixer
description: 'Scans every declared content root, UA and EN, for {/* ToDo */} and {/* NEEDS CONFIRMATION */} comments, sorts them into four buckets, reports them and asks before acting, then resolves the ones that can be fixed with links to existing pages, each link in the form its root pair declares, and runs doc-alignment-checker on every changed page. Never fills in facts: content gaps and NEEDS CONFIRMATION markers are reported for resolve-markers. Never invoked implicitly: it edits files. Use explicitly ("/fix-doc-todos", "/fix-doc-todos docs/webhooks", "use doc-todo-fixer").'
---

# doc-todo-fixer

You are resolving documentation TODOs for this Docusaurus project. Resolve the project's actual content roots via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` before doing anything else — do not assume `docs/`. Both locales live in the same repo, under every declared root pair's **UA content root** and **EN i18n root**.

This skill edits pages, so it starts only when the user asks for it explicitly: through `/fix-doc-todos`, or by name.

## Scope

- **In scope:** every `{/* ToDo */}` and `{/* NEEDS CONFIRMATION */}` comment under every declared root pair, UA and EN (or within the optional scope), sorted into Buckets A–D (Step 3); resolving Buckets A–C after the user's answer (Steps 4–5); the alignment check of every changed page (Step 6).
- **Out of scope:**
  - Facts. Content-gap TODOs and every `{/* NEEDS CONFIRMATION: ... */}` marker belong to `resolve-markers` and are reported in Bucket D.
  - Style fixes (`doc-style-fixer`), the alignment check itself (`doc-alignment-checker`, which Step 6 calls), translation (`doc-translator`).

## Arguments

- **Scope:** an optional path glob that limits the scan, e.g. `api-reference/create-payin-transactions`. With none, the scan covers every declared root.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`: every root pair, its **UA URL prefix** and its `Page link form:`.
2. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md`: how each inserted link is built.
3. The files Step 1 matches, each read in full context around its marker.

Nothing else.

**Link rule:** every page-to-page link you insert must follow `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/internal-links.md`, in the form the page's root pair declares (`Page link form:` in `project-paths.md`, `route` when absent). A route is the **UA URL prefix of the target page's root pair** joined to the target's path relative to that pair's content root, no `.md`/`.mdx`; in a `file-path` pair, a link to a page of the same pair is the target's path from that content root with its `.md`/`.mdx` kept, and a link to another pair is still a route. Anchors preserved, never `./`/`../`, never a hardcoded `/docs/`. That file is authoritative; do not restate its steps here. Never rewrite a `.md` link of a `file-path` pair into a route.

---

## Step 1 — Scan

Run the following command to collect every TODO and NEEDS CONFIRMATION comment across all docs (or within the optional scope from the arguments if provided), substituting this project's resolved roots:

```bash
grep -rn "ToDo\|NEEDS CONFIRMATION" <every UA content root> <every EN i18n root> --include="*.md"
```

Read each matched line **in full context** — open the file and read the surrounding paragraph or table row so you understand exactly what the TODO is asking for and where it sits structurally.

---

## Step 2 — Inventory existing pages

Run, substituting this project's resolved roots:
```bash
find <every UA content root> <every EN i18n root> -name "*.md" | sort
```

Use this list to determine which target pages already exist.

---

## Step 3 — Categorize

Group every TODO into one of four buckets:

**A — Resolvable now (inline):** The TODO asks for a link, the target page already exists, and the surrounding prose is complete. You know the correct path and no text needs to change beyond inserting the link.

**B — Resolvable now (block comment):** The TODO is inside a `{/* ... */}` block comment that wraps live prose or a list. The target pages exist, but the commented-out text may need review or polishing before it goes live.

**C — Ambiguous:** The TODO asks for a link but multiple candidate pages exist (e.g. "create a transaction" when both payin and payout pages are candidates). You need the user to pick.

**D — Cannot fix:** The target page does not exist yet, or the TODO asks for content/SME clarification (not a link). Leave these untouched. This skill only resolves link TODOs (Buckets A–C); it never fills in facts. Content-gap TODOs and every `{/* NEEDS CONFIRMATION: ... */}` marker are `resolve-markers`' job — it answers them from app-notes.md, sme-interview.md, and direct app observation. Report them in Bucket D so the user knows to run `resolve-markers` on the section.

---

## Step 4 — Report and ask

Before making any changes, present the user with:

1. **Bucket A** — a table listing each TODO, the file (UA and EN row separately), and the proposed link.
2. **Bucket B** — for each block-comment TODO, show the raw commented-out text verbatim and ask the user to approve it as-is or provide an edited version. Do not assume the text is ready to publish.
3. **Bucket C** — list each ambiguous case and the question you need answered (e.g. which page to link).
4. **Bucket D** — a table of items that cannot be resolved, with a brief reason for each.

Ask the user to confirm bucket A, review bucket B content, and answer bucket C questions before proceeding. Do not apply any changes until the user responds.

---

## Step 5 — Apply

For each confirmed fix:

- **Bucket A (inline):** Replace the TODO comment with the Markdown link. Preserve surrounding prose exactly.
- **Bucket B (block comment):** Replace the entire `{/* ... */}` block with the user-approved prose. Polish punctuation and sentence flow to match the surrounding text, but do not rewrite beyond what is needed.
- For both UA and EN files: build the inserted link with the `internal-links.md` algorithm of the pair's link form. A route: the target page's pair **UA URL prefix** + the target's path relative to that pair's content root, no `.md` — e.g. `/routing/pools` for a target in a pair whose prefix is `/`, or `/portal/transactions/transactions` for one whose prefix is `/portal/`, even when the page holding the link is in the other pair. In a `file-path` pair, a target of the same pair is `/routing/pools.md`.

### Self-review before saving

Before saving each file, check the edit against the rules above:

- Only fixes the user confirmed (Bucket A), approved (Bucket B) or answered (Bucket C) are applied; every Bucket D item is as it was.
- The prose around each replaced comment is unchanged, apart from the punctuation and flow Bucket B allows.
- Every inserted link is the output of the `internal-links.md` algorithm for its pair's form: no `./`/`../`, no hardcoded `/docs/`, anchors kept, and no `.md` link of a `file-path` pair rewritten into a route.

---

## Step 6 — Alignment check

For every doc slug where changes were made, invoke the `doc-alignment-checker` skill (the Skill tool, once per slug) to verify that the UA and EN versions remain structurally aligned. Don't compare the pages by hand or run `scripts/doc-align/` directly instead: the skill is the check. Report any gaps found.

---

## Step 7 — Report results

List every file changed and what was resolved. List every bucket D item that was left untouched, with the reason.

## Explicit invocation examples

- `/fix-doc-todos`
- `/fix-doc-todos docs/webhooks`
- "use doc-todo-fixer on `portal/transactions`"

A loose request ("clean up the TODOs") doesn't start this skill: ask whether to run it.
