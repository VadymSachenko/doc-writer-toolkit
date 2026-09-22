---
name: fix-doc-todos
description: Scans all docs for ToDo and NEEDS CONFIRMATION comments, categorizes them into four buckets (resolvable inline, resolvable block comment, ambiguous, cannot-fix), asks before acting, then resolves the ones that can be fixed with links to existing pages. Use explicitly ("fix-doc-todos", "use fix-doc-todos to resolve links", "/fix-doc-todos").
---

# fix-doc-todos

## Scope

- **In scope:** resolving `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}` markers that can be fixed by inserting links to existing pages or publishing commented-out prose blocks. Works across both UA and EN locales simultaneously.
- **Out of scope:** filling in facts, answering content questions, or resolving markers that require app observation or SME input — those are `resolve-markers`'s job. This skill only resolves link TODOs (Buckets A–C); it never fills in facts. Content-gap TODOs and every `{/* NEEDS CONFIRMATION: … */}` marker are `resolve-markers`' job — it answers them from app-notes.md, sme-interview.md, and direct app observation.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve the **UA content root**, **EN i18n root**, and **UA URL prefix** before scanning. Do not assume `docs/` or any other default.

## Workflow

### Step 1 — Scan

Run the following command to collect every TODO and NEEDS CONFIRMATION comment across all docs (or within the optional scope argument if provided), substituting this project's resolved roots:

```bash
grep -rn "ToDo\|NEEDS CONFIRMATION" <UA content root> <EN i18n root> --include="*.md"
```

Read each matched line **in full context** — open the file and read the surrounding paragraph or table row so you understand exactly what the TODO is asking for and where it sits structurally.

### Step 2 — Inventory existing pages

Run, substituting this project's resolved roots:
```bash
find <UA content root> <EN i18n root> -name "*.md" | sort
```

Use this list to determine which target pages already exist.

### Step 3 — Categorize

Group every TODO into one of four buckets:

**A — Resolvable now (inline):** The TODO asks for a link, the target page already exists, and the surrounding prose is complete. You know the correct path and no text needs to change beyond inserting the link.

**B — Resolvable now (block comment):** The TODO is inside a `{/* ... */}` block comment that wraps live prose or a list. The target pages exist, but the commented-out text may need review or polishing before it goes live.

**C — Ambiguous:** The TODO asks for a link but multiple candidate pages exist (e.g. "create a transaction" when both payin and payout pages are candidates). You need the user to pick.

**D — Cannot fix:** The target page does not exist yet, or the TODO asks for content/SME clarification (not a link). Leave these untouched. Report them in Bucket D so the user knows to run `resolve-markers` on the section.

### Step 4 — Report and ask

Before making any changes, present the user with:

1. **Bucket A** — a table listing each TODO, the file (UA and EN row separately), and the proposed link.
2. **Bucket B** — for each block-comment TODO, show the raw commented-out text verbatim and ask the user to approve it as-is or provide an edited version. Do not assume the text is ready to publish.
3. **Bucket C** — list each ambiguous case and the question you need answered (e.g. which page to link).
4. **Bucket D** — a table of items that cannot be resolved, with a brief reason for each.

Ask the user to confirm Bucket A, review Bucket B content, and answer Bucket C questions before proceeding. Do not apply any changes until the user responds.

### Step 5 — Apply

For each confirmed fix:

- **Bucket A (inline):** Replace the TODO comment with the Markdown link. Preserve surrounding prose exactly.
- **Bucket B (block comment):** Replace the entire `{/* ... */}` block with the user-approved prose. Polish punctuation and sentence flow to match the surrounding text, but do not rewrite beyond what is needed.
- For both UA and EN files: use the project's declared **UA URL prefix** (from `project-paths.md`) + the doc's relative path, no `.md` extension — e.g. `/routing/pools` for a project whose prefix is `/`, or `/partner-cabinet/transactions/transactions` for a project whose prefix is `/partner-cabinet/`. Never hardcode `/docs/` — that prefix is wrong for a project whose `routeBasePath` is `/`.

### Step 6 — Alignment check

For every doc slug where changes were made, invoke the `doc-alignment-checker` skill to verify that the UA and EN versions remain structurally aligned. Report any gaps found.

### Step 7 — Report results

List every file changed and what was resolved. List every Bucket D item that was left untouched, with the reason.

## Explicit invocation examples

This skill triggers only when named explicitly or via the `/fix-doc-todos` command.

- `/fix-doc-todos` — scan and resolve TODOs across all docs
- `/fix-doc-todos api-reference/create-payin-transactions` — limit scope to one section
- "Use fix-doc-todos to resolve the link TODOs in partner-cabinet/transactions"
- "fix-doc-todos: find and fix all resolvable TODOs"
