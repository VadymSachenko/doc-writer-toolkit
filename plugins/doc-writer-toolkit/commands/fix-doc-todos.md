---
description: Scan all docs for ToDo and NEEDS CONFIRMATION comments, categorize them, ask before acting, then resolve the ones that can be fixed with links to existing pages.
argument-hint: "[optional: path glob to limit scope, e.g. api-reference/create-payin-transactions]"
---

You are resolving documentation TODOs for the UniComPay Docusaurus project. Both locales live in the same repo:
- **UA docs:** `docs/`
- **EN docs:** `i18n/en/docusaurus-plugin-content-docs/current/`

**Link prefix rule:** UA doc links must start with `/docs/`; EN doc links must not include a `/docs/` prefix.

---

## Step 1 — Scan

Run the following command to collect every TODO and NEEDS CONFIRMATION comment across all docs (or within the optional scope from $ARGUMENTS if provided):

```bash
grep -rn "ToDo\|NEEDS CONFIRMATION" docs/ i18n/en/docusaurus-plugin-content-docs/current/ --include="*.md"
```

Read each matched line **in full context** — open the file and read the surrounding paragraph or table row so you understand exactly what the TODO is asking for and where it sits structurally.

---

## Step 2 — Inventory existing pages

Run:
```bash
find docs/ i18n/en/docusaurus-plugin-content-docs/current/ -name "*.md" | sort
```

Use this list to determine which target pages already exist.

---

## Step 3 — Categorize

Group every TODO into one of four buckets:

**A — Resolvable now (inline):** The TODO asks for a link, the target page already exists, and the surrounding prose is complete. You know the correct path and no text needs to change beyond inserting the link.

**B — Resolvable now (block comment):** The TODO is inside a `{/* ... */}` block comment that wraps live prose or a list. The target pages exist, but the commented-out text may need review or polishing before it goes live.

**C — Ambiguous:** The TODO asks for a link but multiple candidate pages exist (e.g. "create a transaction" when both payin and payout pages are candidates). You need the user to pick.

**D — Cannot fix:** The target page does not exist yet, or the TODO asks for content/SME clarification (not a link). Leave these untouched.

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
- For UA files: use `/docs/<path>.md` link format.
- For EN files: use `/<path>.md` link format (no `/docs/` prefix).

---

## Step 6 — Alignment check

For every doc slug where changes were made, invoke the `doc-alignment-checker` skill to verify that the UA and EN versions remain structurally aligned. Report any gaps found.

---

## Step 7 — Report results

List every file changed and what was resolved. List every bucket D item that was left untouched, with the reason.
