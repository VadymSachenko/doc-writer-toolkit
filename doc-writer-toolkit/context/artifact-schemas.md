# Artifact schemas

Shared JSON schemas emitted by diagnostic and planning skills. Every schema carries a `schema` field (identifier) and a `version` field. Skills reference this file rather than redeclaring schemas inline — single source of truth.

---

## Style review (`doc-style-reviewer`)

**When emitted:** when `format:json` is passed.  
**File-path pattern:** `<file-parent>/.sources/<file-slug>-style-review.json`  
**Example:** `docs/transactions/filter-transactions/.sources/filter-transactions-style-review.json`

```json
{
  "schema": "style-review",
  "version": "1",
  "file": "docs/transactions/filter-transactions/filter-transactions.md",
  "profile": "gdsg@uk",
  "guideResolved": "argument | project declaration | asked",
  "findings": {
    "errors": [
      {
        "tag": "UA-SPELLING",
        "rule": "§7",
        "ruleFile": "ua-grammar/01a-vowels-alternations.md",
        "lines": [12, 45],
        "text": "об'єкт",
        "fix": "об'єкт"
      }
    ],
    "deviations": [],
    "suggestions": []
  },
  "counts": {
    "errors": 1,
    "deviations": 0,
    "suggestions": 0
  }
}
```

**Finding fields:**

| Field | Content |
|---|---|
| `tag` | The `[TAG]` label from the Markdown report (e.g. `UA-SPELLING`, `VOICE`, `TERMINOLOGY`) |
| `rule` | Rule ID or § number |
| `ruleFile` | Corpus file the rule came from |
| `lines` | List of line numbers — one entry for a single occurrence, multiple when the occurrence sweep matched the same term elsewhere |
| `text` | Offending text verbatim (the "Offending text" field from the finding card) |
| `fix` | Suggested fix (the "Suggested fix" field from the finding card) |

---

## Style fixes (`doc-style-fixer`)

**When emitted:** when `format:json` is passed.  
**File-path pattern:** `<file-parent>/.sources/<file-slug>-style-fixes.json`

```json
{
  "schema": "style-fixes",
  "version": "1",
  "file": "docs/transactions/filter-transactions/filter-transactions.md",
  "applied": [
    {
      "tag": "UA-SPELLING",
      "rule": "§7",
      "ruleFile": "ua-grammar/01a-vowels-alternations.md",
      "line": 12,
      "text": "об'єкт",
      "fix": "об'єкт"
    }
  ],
  "skipped": [],
  "pending": [
    {
      "tag": "TERMINOLOGY",
      "rule": "glossary-ua.md",
      "ruleFile": "project-rules/glossary-ua.md",
      "line": 34,
      "text": "...",
      "reason": "bucket-3 — no decision given"
    }
  ],
  "counts": {
    "applied": 1,
    "skipped": 0,
    "pending": 1
  }
}
```

`pending` items are bucket-3 findings with no user decision, or bucket-2 findings the user explicitly skipped. The `reason` field distinguishes them (`"bucket-3 — no decision given"` vs. `"skipped by user"`).

---

## Alignment report (`doc-alignment-checker`)

**When emitted:** when `format:json` is passed.  
**File-path pattern:** `<main-file-parent>/.sources/<slug>-alignment-report.json`  
**Example:** `docs/transactions/filter-transactions/.sources/filter-transactions-alignment-report.json`

```json
{
  "schema": "alignment-report",
  "version": "1",
  "main": "docs/transactions/filter-transactions/filter-transactions.md",
  "secondary": "i18n/en/docusaurus-plugin-content-docs/current/transactions/filter-transactions/filter-transactions.md",
  "bugs": [
    {
      "flag": "TYPE COLUMN — NOT ENGLISH",
      "description": "Cell value 'Рядок' in row 3 must be 'String'",
      "line": 45,
      "file": "docs/transactions/filter-transactions/filter-transactions.md"
    }
  ],
  "warnings": [
    {
      "flag": "DATE MISMATCH",
      "description": "UA: 2026-07-01, EN: 2026-06-15",
      "line": 2,
      "file": "docs/transactions/filter-transactions/filter-transactions.md"
    }
  ],
  "passed": [
    "Check 2 — Section count and heading levels",
    "Check 3 — Table structure"
  ],
  "counts": {
    "bugs": 1,
    "warnings": 1,
    "passed": 8
  }
}
```

`passed` is a list of check-name strings (the same names used in the "Passed" block of the Markdown report).

---

## Section plan (`section-planner`)

**When emitted:** always, alongside `section-plan.md`.  
**File path:** `.sources/section-plan.json` (same section folder as `section-plan.md`)

```json
{
  "schema": "section-plan",
  "version": "1",
  "section": "docs/transactions",
  "status": "awaiting-approval",
  "basedOn": ["section-readiness", "app-notes"],
  "verdict": "skeleton",
  "sidebarOrderDeviates": false,
  "pages": [
    {
      "action": "keep",
      "slug": "balance/balance.md",
      "docType": "concept",
      "title": "Balance",
      "rationale": "Concept page first — users need context before acting",
      "mergesFrom": [],
      "splitsFrom": null,
      "sourceEvidence": "app-notes",
      "sidebarOrder": 1
    },
    {
      "action": "merge",
      "slug": "manage-cards/manage-cards.md",
      "docType": "user-guide",
      "title": "Manage cards",
      "rationale": "Same screen, same flow",
      "mergesFrom": ["add-cards/add-cards.md", "manage-cards/manage-cards.md"],
      "splitsFrom": null,
      "sourceEvidence": "app-notes",
      "sidebarOrder": 3
    }
  ],
  "openQuestions": [
    {
      "question": "Is the card overview a separate concept page or a section in Manage cards?",
      "proposedDefault": "separate concept page"
    }
  ]
}
```

**Field notes:**

| Field | Values / Notes |
|---|---|
| `pages[].action` | `keep` \| `merge` \| `split` \| `add` \| `delete` \| `inferred` |
| `pages[].docType` | `concept` \| `user-guide` \| `api` |
| `pages[].sourceEvidence` | `app-notes` \| `sme-interview` \| `existing-stub` \| `inferred` |
| `pages[].mergesFrom` | List of existing slugs being merged; empty array when not a merge |
| `pages[].splitsFrom` | Single existing slug being split; `null` otherwise |
| `sidebarOrderDeviates` | `true` when the proposed order differs from the existing folder order |

---

## App notes index (`app-explorer`)

**When emitted:** always, alongside `app-notes.md`.  
**File path:** `.sources/app-notes.json` (same section folder as `app-notes.md`)

```json
{
  "schema": "app-notes-index",
  "version": "1",
  "section": "docs/transactions",
  "exploredDate": "2026-08-15",
  "testEnvironment": "https://test.example.com",
  "screens": [
    {
      "name": "Transactions",
      "path": "Menu → Transactions",
      "statesCaptured": ["empty", "loaded"],
      "screenshots": ["transactions-page.png", "transactions-page-empty.png"],
      "answeredMarkers": [
        {
          "question": "Does the Accept button appear for all transaction types or only payins?",
          "answer": "The Accept button appears only on the Payins tab, not on Payouts.",
          "evidence": "transactions-page-payins.png"
        }
      ]
    }
  ],
  "unansweredMarkers": [
    {
      "question": "What permissions are required to see the Reconciliation tab?",
      "reason": "Not reachable with the test account's permission level"
    }
  ],
  "counts": {
    "screensExplored": 1,
    "scenariosSeeded": 2,
    "screenshots": 2,
    "answeredMarkers": 1,
    "unansweredMarkers": 1
  }
}
```

`answeredMarkers` covers every `{/* NEEDS CONFIRMATION */}` item answered during exploration (one entry per question). `unansweredMarkers` covers items the app couldn't answer — permission limits, features not available in the test environment, etc.
