---
name: section-state
description: The ledger of a document-section run, .sources/section-state.json — its fields, when a stage counts as done, what makes a done stage stale, and the gates derived from it. The scripts/section-state script reads and writes it; the document-section skill never edits it by hand. Referenced, never copied.
---

# Section state

`document-section` runs one section folder through a chain of skills and stops at approval gates. Between invokes it keeps a ledger in `<section>/.sources/section-state.json`. The ledger records only what the files can't show: verdicts, approvals, and the hash of each file when a stage finished. On every invoke the ledger is checked against the files, and **the files win**.

The ledger is written and read only through `${CLAUDE_PLUGIN_ROOT}/scripts/section-state/section-state.mjs` (`status` and `record`, see its `README.md`). A stale stage is never stored: `status` derives it on every call.

**Commit the ledger** with the pages, in the host repo. It is small, it changes only when a stage ends, and a teammate who picks up the section resumes where the run stopped. Don't add it to `.gitignore`.

A hash is the git blob hash of the working-tree file (what `git hash-object <file>` prints), the same kind `locale-sync` uses for its state.

## The chain

| # | Stage | Kind | Skill |
|---|---|---|---|
| 1 | `readiness` | section | `section-readiness` |
| 2 | `explore` | section | `app-explorer` (skipped when the readiness report says `liveUI: none`) |
| 3 | `plan` | section | `section-planner` |
| 4 | `planApproval` | section | gate G1, the user |
| 5 | `write` | page | the writer for the page's `docType` |
| 6 | `resolve` | section | `resolve-markers` |
| 7 | `fix` | page | `doc-style-fixer` |
| 8 | `review` | page | `doc-style-reviewer` |
| 9 | `uaApproval` | page | gate G5, the user |
| 10 | `translate` | page | `doc-translator` |
| 11 | `align` | page | `doc-alignment-checker` |

A page stage runs across all pages, in plan order, before the next stage starts. The next stage is the first one, in this order, that isn't `done` or `skipped`. A blocked page doesn't hold the others back.

## Section fields

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | integer | `1`. |
| `section` | string | The section folder, from the repo root. |
| `pair` | string or null | The root pair id, when the host declares more than one (`project-paths.md`, "Resolving a page's root pair"). |
| `roots` | object | `ua` and `en`: that pair's UA content root and EN i18n root. Page ids and EN paths derive from them. |
| `baseCommit` | string | `HEAD` when the ledger was created. The base for `doc-translator --sync`. |
| `createdAt`, `updatedAt` | string | ISO 8601 date-time. |
| `seq` | integer | Counts records. Each stage record carries the `seq` it was made at, so "ran after" needs no clock. |
| `options` | object | The run's arguments, as the skill passed them: `interview` (`ask` or `skip`), `apply` (`mechanical` or `mechanical,substantive`). |
| `stages` | object | `readiness`, `explore`, `plan`, `planApproval`, `resolve`: one stage record each. |
| `pages` | array | One entry per page the run writes, from the approved plan. |
| `listed` | array | Pages the run doesn't touch, for the final report: `{ path, reason, into? }`, `reason` being `delete`, `merged-away`, `split` or `keep-complete`. |
| `runLog` | array | Append-only: `at`, `seq`, `stage`, `page` (page stages), `outcome`, `note`. |

**Stage record:** `status` (`running` · `done` · `skipped` · `failed`), `seq`, `at`, `note` (the reason for `skipped` and `failed`), `result` (the stage's counts, below), and `evidence` (`[{ path, hash }]` of the files a section stage produced or approved). The readiness record also keeps `pages`, the section's page files when it ran.

## Page fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The path relative to the pair's UA content root, without the extension: the form `doc-translator` takes. |
| `path`, `enPath` | string | The UA and EN paths from the repo root. |
| `action` | string | `keep`, `merge`, `split` or `add`, from the plan. |
| `docType` | string | `concept`, `user-guide` or `api`. Picks the writer. |
| `title` | string or null | The plan's title. |
| `from` | string[] | The pages it merges or splits from. |
| `order` | integer | Its position in the plan. |
| `uaHash`, `enHash` | string or null | The hash after the last write **by the pipeline**. At plan approval, `uaHash` is the hash of the page as it was (a stub), or null when it doesn't exist yet. |
| `stages` | object | `write`, `fix`, `review`, `uaApproval`, `translate`, `align`: a stage record each, plus the `uaHash` (and, for `translate` and `align`, the `enHash`) it saw. |
| `blocked` | object or null | `{ stage, reason }` when a page stage failed. |

`result` by stage: write `{ skill, interview }`; fix `{ applied, left }`; review `{ errors, deviations, suggestions, round }`; align `{ bugs, warnings }`. The script stores what it is given.

Plan actions become pages like this:

| Plan action | In the ledger |
|---|---|
| `add`, `keep` on a `stub` page | a page |
| `merge` | a page; the merged-away pages are listed (`merged-away`) |
| `split` | one page per new page; the old page is listed (`split`) |
| `keep` on a `complete` page | listed (`keep-complete`), not edited in this version |
| `delete` | listed (`delete`) |

The page's state comes from the readiness report. Nothing is deleted or moved: the user removes listed pages.

## Example

```json
{
  "schemaVersion": 1,
  "section": "docs/reports",
  "pair": null,
  "roots": { "ua": "docs/", "en": "i18n/en/docusaurus-plugin-content-docs/current/" },
  "baseCommit": "4f1c2ab…",
  "createdAt": "2026-10-24T10:02:00Z",
  "updatedAt": "2026-10-24T11:40:00Z",
  "seq": 9,
  "options": { "interview": "ask", "apply": "mechanical" },
  "stages": {
    "readiness": { "status": "done", "seq": 2, "at": "2026-10-24T10:03:00Z", "evidence": [{ "path": "docs/reports/.sources/section-readiness.json", "hash": "a91e…" }], "pages": ["docs/reports/export-report/export-report.md"] },
    "explore": { "status": "skipped", "seq": 3, "at": "2026-10-24T10:03:10Z", "note": "liveUI: none" },
    "plan": { "status": "done", "seq": 5, "at": "2026-10-24T10:12:00Z", "evidence": [{ "path": "docs/reports/.sources/section-plan.md", "hash": "77d0…" }, { "path": "docs/reports/.sources/section-plan.json", "hash": "1b2c…" }] },
    "planApproval": { "status": "done", "seq": 6, "at": "2026-10-24T10:20:00Z", "evidence": [{ "path": "docs/reports/.sources/section-plan.md", "hash": "77d0…" }, { "path": "docs/reports/.sources/section-plan.json", "hash": "1b2c…" }] },
    "resolve": { "status": "done", "seq": 8, "at": "2026-10-24T11:05:00Z" }
  },
  "pages": [
    {
      "id": "reports/export-report/export-report",
      "path": "docs/reports/export-report/export-report.md",
      "enPath": "i18n/en/docusaurus-plugin-content-docs/current/reports/export-report/export-report.md",
      "action": "add", "docType": "user-guide", "title": "Export a report", "from": [], "order": 2,
      "uaHash": "c3b8…", "enHash": null,
      "stages": {
        "write": { "status": "done", "seq": 7, "at": "2026-10-24T10:58:00Z", "uaHash": "0e41…", "result": { "skill": "user-guide-writer", "interview": "asked 4" } },
        "fix": { "status": "done", "seq": 9, "at": "2026-10-24T11:30:00Z", "uaHash": "c3b8…", "result": { "applied": 6, "left": 1 } }
      },
      "blocked": null
    }
  ],
  "listed": [{ "path": "docs/reports/old-export/old-export.md", "reason": "merged-away", "into": "docs/reports/export-report/export-report.md" }],
  "runLog": [{ "at": "2026-10-24T10:03:00Z", "seq": 2, "stage": "readiness", "outcome": "done" }]
}
```

## When a stage is done

| Stage | Done when |
|---|---|
| `readiness` | its evidence hash matches, and before plan approval the section's page files are the ones it saw |
| `explore` | `skipped` with a reason, or its evidence (`app-notes.md`) hash matches |
| `plan` | `section-plan.md` and `section-plan.json` exist; before approval, neither readiness nor explore ran after it |
| `planApproval` | both plan files still have the approved hashes, and the plan didn't run after the approval |
| `write` | the page exists |
| `resolve` | no page was written after it ran |
| `fix`, `review`, `uaApproval` | the record's `uaHash` equals the page's current hash |
| `translate` | the record's `uaHash` equals the current hash, and the EN page exists |
| `align` | the record's `uaHash` and `enHash` equal the current hashes |

A page stage is done only when the page stage before it is done. A `done` is recorded only when that holds, so an approval can't be recorded on a page whose review is stale.

## What makes a done stage stale

| Change found | Becomes stale |
|---|---|
| The section's page set changed, or readiness or explore ran again, before plan approval | readiness, then the plan and its approval |
| A plan file changed after approval | `planApproval`. Gate G1 comes back. Nothing written is touched; on the new approval, pages no longer in the plan are dropped from the ledger and reported |
| The readiness report, the app notes or the page set changed after approval | nothing; `status` warns that the plan may be out of date |
| The UA page changed outside the pipeline (its hash differs from `uaHash`) | that page's `fix`, `review`, `uaApproval`, `translate`, `align` |
| A pipeline write (`write`, `resolve`, `fix`) | that page's later stages, by chain order |
| The EN page changed by hand (its hash differs from `enHash`) | `align` only. EN is never translated again over a hand edit without the user's word |
| A page written after `resolve` ran | `resolve` |
| A page added by hand after approval | nothing; `status` lists it under `outside` |

Each pipeline write updates the page's `uaHash`, so the pipeline's own edits never look like hand edits. The translator also sets `last_update.date` in the UA page (`doc-translator`, Step 5). When `record --stage translate` finds that the UA page differs from the approved version only in a frontmatter `date:`, the records made on the approved version carry over to the new hash, and nothing goes stale. The approved version must be committed for that check: the script reads it from git.

## Gates

`status` names the gate the run waits at, from the stage states:

| `gate.name` | When |
|---|---|
| `plan` (G1) | the plan is done and its approval isn't |
| `unknownDraft` (G3) | a page due for `write` exists on disk with a hash the ledger doesn't know: an interrupted writer saved it, or someone else did |
| `uaApproval` (G5) | the next stage is `uaApproval` |
| `commit` | the next stage is `translate` and an approved page has uncommitted changes. `doc-translator --sync` diffs committed UA only |

The writer's interview (G2) and the fixer's bucket 2 choices (G4) happen inside those skills; they aren't in the ledger.

## Failures and interruptions

- A section stage that fails is `failed`, with the reason. The run stops; the next invoke runs it again.
- A page stage that fails blocks the page (`blocked`), and the run goes on with the other pages. Recording the stage `running` again clears the block.
- A stage found `running` when an invoke starts was interrupted. It runs again.
- To start over, the user removes the ledger. The skill never removes it.
