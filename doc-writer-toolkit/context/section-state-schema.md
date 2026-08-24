# section-state-schema.md

Defines the shape of `.sources/section-state.json` — the resumable progress ledger that the `document-section` skill reads and writes throughout a run. Every field is also written by the skill after each phase; consumers should treat the file as append-on-phase-complete.

## Full schema

```json
{
  "schemaVersion": 1,
  "section": "docs/transactions",
  "lastUpdated": "2026-08-22",
  "phase": "draft",
  "completedPhases": ["readiness", "explore", "plan", "approval"],
  "planApproved": false,
  "pages": [
    {
      "slug": "transactions/transactions",
      "docType": "concept",
      "status": "clean",
      "file": "partner-cabinet/transactions/transactions.md",
      "reviewIterations": 2,
      "resolvedMarkers": 3,
      "deferredMarkers": 1
    }
  ],
  "totals": {
    "resolvedMarkers": 12,
    "deferredMarkers": 4,
    "screenshotManifest": ["transactions-list.png", "filter-dropdown.png"],
    "openSmeQuestions": ["What triggers a timeout on a queued payout?"]
  },
  "runLog": [
    { "phase": "readiness", "completedAt": "2026-08-22", "verdict": "needs-revision" },
    { "phase": "explore",   "completedAt": "2026-08-22", "screenshotsCaptured": 14 }
  ]
}
```

## Field reference

### Top-level

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | integer | Always `1` for this schema. Increment if the shape changes. |
| `section` | string | Relative path to the section folder from the repo root. |
| `lastUpdated` | string | ISO date of the last ledger write (`YYYY-MM-DD`). |
| `phase` | string | Current phase cursor — one of the **Phase cursors** below. |
| `completedPhases` | string[] | Phase names that completed successfully. Resume logic skips these. |
| `planApproved` | boolean | `true` once the user has given go-ahead at the approval gate. Never default to `true`; only set it on an explicit user approval in Phase 4. |

### Phase cursors

`readiness` → `explore` → `plan` → `approval` → `draft` → `resolve` → `sidebar` → `complete`

On re-invoke, skip phases whose name is in `completedPhases`; resume at the current `phase` value.

### `pages[]` — one entry per page in the approved plan

| Field | Type | Description |
|---|---|---|
| `slug` | string | Page path relative to the content root, no extension (e.g. `transactions/filter-transactions`). |
| `docType` | string | `concept` \| `user-guide` \| `api` |
| `status` | string | `planned` \| `drafting` \| `review` \| `clean` \| `blocked` |
| `file` | string | Absolute-or-root-relative path of the written file. Set when the writer skill saves the page. |
| `reviewIterations` | integer | How many style-review → fix cycles this page has completed. Capped at 3 before the page is marked `blocked`. |
| `resolvedMarkers` | integer | Markers resolved by `resolve-markers` on this page. |
| `deferredMarkers` | integer | Markers not resolvable from app/interview evidence on this page. |

### `totals{}`

| Field | Type | Description |
|---|---|---|
| `resolvedMarkers` | integer | Sum of `resolvedMarkers` across all pages. |
| `deferredMarkers` | integer | Sum of `deferredMarkers` across all pages. |
| `screenshotManifest` | string[] | Basenames of all screenshots in `.assets/` at the end of the run. |
| `openSmeQuestions` | string[] | Questions written to `.sources/sme-questions.md`. Mirrors the file's content for quick programmatic access. |

### `runLog[]`

One entry per completed phase. Fields vary by phase; always include `phase` and `completedAt`. Useful for diagnostics and for the completion report.

## Resume logic

```
on re-invoke:
  read .sources/section-state.json
  if planApproved == false and phase in ["draft", "resolve", "sidebar", "complete"]:
    re-show the plan and ask for approval before continuing
  for each phase in [readiness, explore, plan, approval, draft, resolve, sidebar]:
    if phase.name in completedPhases: skip
    else: run phase
  for each page in pages[]:
    if page.status == "clean": skip
    else: run write/review loop
```
