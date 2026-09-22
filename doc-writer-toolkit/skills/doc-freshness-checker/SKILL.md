---
name: doc-freshness-checker
description: Diffs an existing documentation page against app-notes.json evidence and reports stale steps, changed UI labels, and stale screenshots as structured findings. Used by the document-section orchestrator on the needs-revision path before writers run. Use explicitly ("doc-freshness-checker: check docs/transactions/transactions.md").
---

# doc-freshness-checker

You are checking whether an existing documentation page still matches what the live app shows. You diff the page against `app-notes.json` evidence and produce a findings list. You do not edit the page — `document-section` routes your findings into the per-page fix loop.

## Scope

- **In scope:** one documentation page + one `app-notes.json` in the same section folder. Reports stale steps, changed labels, and stale screenshots as structured findings.
- **Out of scope:** writing or editing any file; checking translation alignment (that is `doc-alignment-checker`); checking style guide conformance (that is `doc-style-reviewer`); running without `app-notes.json` present.

## Sources to load

1. The target page file.
2. `.sources/app-notes.json` in the section folder — the structured evidence from `app-explorer`.
3. `.sources/app-notes.md` in the section folder — used for human-readable context when the JSON entry is ambiguous.

Do not load style-guide corpora, glossaries, or templates.

## Workflow

### Step 1 — Load inputs

Read the target page and `.sources/app-notes.json`. If `app-notes.json` does not exist, stop and report: "doc-freshness-checker requires app-notes.json — run app-explorer on this section first."

Identify which screen(s) in `app-notes.json` correspond to this page by matching the page's headings and content against `app-notes.json`'s `screens[].name` and `screens[].path` fields. If no screen matches, report as `no-evidence` and stop.

### Step 2 — Compare

For each matched screen, compare the page content against the app evidence across three dimensions:

**A — Stale steps:** Numbered procedure steps in the page that reference a UI action. For each step, check whether the button label, field name, or action described in the step matches what `app-notes.json` records in `screens[].uiElements`. Flag mismatches.

**B — Changed labels:** Any UI label in bold (per project convention), status values in code font, column headers, tab names, or dropdown options in the page. Check each one against `screens[].uiElements.buttons`, `.columns`, `.tabs`, `.statuses`, `.fields`. Flag any that differ.

**C — Stale screenshots:** Image embeds in the page (via `![...](.assets/...)` or `<img src=...>`). Cross-reference each against `screens[].screenshots` from `app-notes.json`. Flag images not in the current screenshot set (may have been recaptured with different content) and images the app notes list as showing different UI state than the embed's alt text describes.

### Step 3 — Report findings

Produce a structured findings list:

```
## Freshness check: <page path>

Matched screen: <screen name from app-notes.json>

### Stale steps (N)
- **Line <N>:** "<page text>" — app shows: "<what app-notes.json says>"

### Changed labels (N)
- **"<page label>"** — app shows: "<app-notes.json value>"

### Stale screenshots (N)
- **<filename>** — <reason: not in current screenshot set | alt text mismatch>

### No-evidence items (N)
- **Line <N>:** "<page text>" — no matching screen in app-notes.json to verify against

---
Summary: <A> stale steps, <B> changed labels, <C> stale screenshots, <D> no-evidence items.
```

If zero findings across all dimensions, report: "Page appears current — no stale content detected."

## Output (when invoked by the orchestrator)

Return the findings list as text. The orchestrator records it in the `runLog` and passes it to the writer skill as revision guidance. The writer reads this list alongside the existing page content, treating each finding as a correction to apply in `orchestrated` mode.

## Explicit invocation examples

This skill triggers only when named explicitly. It is most commonly invoked by the `document-section` orchestrator.

- "doc-freshness-checker: check docs/transactions/transactions.md"
- "Use doc-freshness-checker on partner-cabinet/balance/balance.md"
- "run doc-freshness-checker on the transactions page before rewriting it"
