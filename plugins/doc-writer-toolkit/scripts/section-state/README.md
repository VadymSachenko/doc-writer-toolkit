# section-state

Keeps the ledger of a `document-section` run, `<section>/.sources/section-state.json`, and checks it against the files: which stages are done, which went stale, what runs next and which gate is open. Node, no dependencies. No AI is involved: the skill runs the stages and makes the judgment calls, the script does the hash bookkeeping, where a model slips across ten pages and six stages.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/section-state/section-state.mjs <command> <section> [options]
```

Run it from the docs repo root (or pass `--root`). Needs Node 18.3+ and `git`. Tests: `npm test` in this folder (offline, throwaway git repos).

The ledger's fields, the done and stale rules and the gates are in `${CLAUDE_PLUGIN_ROOT}/context/section-state.md`. This file covers the commands, flags and output.

## Commands

| Command | What it does |
|---|---|
| `status <section>` | Checks the ledger against the files and prints each stage's state, the pages, the next stage and the open gate. Writes nothing. `--md` prints a Markdown status block instead of JSON. |
| `record <section>` | Records one stage result (`--stage`, `--status`, and `--page` for a page stage). A `done` is checked against the files first; on any problem nothing is written. The first record creates the ledger. |

`<section>` is the section folder, relative to the repo root (`docs/reports`).

Output is JSON on stdout. A refusal or a usage error prints `{"ok": false, "error": …}` on stdout and a `section-state: …` line on stderr. An unexpected failure (a crash, a git error the script doesn't expect) prints only to stderr, with nothing on stdout.

**Exit codes:** `0` ok · `1` a record was refused (nothing written), or an unexpected failure · `2` bad usage or configuration (a missing argument, an unknown stage or page, a ledger that doesn't parse, no git repository).

## `record` flags

| Flag | Meaning |
|---|---|
| `--stage <name>` | A section stage (`readiness`, `explore`, `plan`, `planApproval`, `resolve`) or a page stage (`write`, `fix`, `review`, `uaApproval`, `translate`, `align`). |
| `--status <status>` | `running` (before the stage starts), `done`, `skipped` (`explore` and `resolve` only) or `failed`. |
| `--page <id\|path>` | A page of the run, by id or path; repeat it for several pages. Required for a page stage, refused for a section stage. A `<pair>:` prefix is accepted and ignored. With several pages, either all are recorded or none. |
| `--note <text>` | The reason. Required for `skipped` and `failed`. |
| `--result <json>` | A JSON object stored as the stage's `result` (`{"errors":0,"deviations":1,"suggestions":2}`). For `review`, the script counts the round itself and sets `round`, replacing any given. For `fix`, `open` lists the findings the fixer left unapplied, one line each. |
| `--options <json>` | A JSON object merged into the ledger's `options` (`{"interview":"skip","apply":"mechanical"}`). |
| `--ua-root <dir>`, `--en-root <dir>` | The section's root pair. Required by the record that creates the ledger, ignored after. The section must be a folder inside the UA root. |
| `--pair <id>` | The root pair id, stored when the ledger is created. Only when the host declares more than one pair. |
| `--saved-as <path>` | With `--stage write --status done` and one page: the writer saved the page at another path than the plan's. The ledger entry follows the file (new `id` and `enPath`) and the run log notes the plan's path. Nothing is renamed. A path outside the section is refused (exit 1). |

What a `done` checks and records, the review rounds and the date check are in `${CLAUDE_PLUGIN_ROOT}/context/section-state.md` ("When a stage is done", "Review rounds", "What makes a done stage stale"). A `done` is written only when that holds. `running` and `failed` check nothing. `failed` on a page stage blocks the page (`blocked: { stage, reason }`); `running` or `done` at that stage clears it. `translate` done stores `HEAD` as the record's `head` and the page's `syncBase`.

**The plan file.** `section-plan.json` needs a `pages` array. Each entry has `action` (`keep`, `merge`, `split`, `add` or `delete`), `path` (the page from the repo root, inside the section and the UA root), `docType` (`concept`, `user-guide` or `api`; not for `delete`), `mergesFrom` (a non-empty array, for `merge`) and `splitsFrom` (a path, for `split`). `order` defaults to the entry's position. Other fields (`title`, `rationale`, …) are kept or ignored. An `api` entry is listed, not run, so its `path` may be anywhere (the API reference root). A plan path that differs from a readiness report's page only in the extension (`.md`, `.mdx`) is that page, at the readiness report's path.

`record` prints `{ ok, file, recorded, next, gate, warnings }`, plus `pages`, `listed` and `dropped` (ids no longer in the plan) for a plan approval.

## `status` output

```json
{
  "section": "docs/reports",
  "ledger": "present",
  "file": "docs/reports/.sources/section-state.json",
  "pair": null,
  "roots": { "ua": "docs/", "en": "i18n/en/docusaurus-plugin-content-docs/current/" },
  "baseCommit": "4f1c2ab…",
  "stages": {
    "readiness": { "state": "done", "note": null, "result": null },
    "explore": { "state": "skipped", "note": "liveUI: none", "result": null },
    "plan": { "state": "done", "note": null, "result": null },
    "planApproval": { "state": "done", "note": null, "result": null },
    "resolve": { "state": "done", "note": null, "result": null }
  },
  "pages": [
    {
      "id": "reports/export-report/export-report",
      "path": "docs/reports/export-report/export-report.md",
      "enPath": "i18n/en/docusaurus-plugin-content-docs/current/reports/export-report/export-report.md",
      "action": "add", "docType": "user-guide", "order": 2, "from": [],
      "exists": true, "enExists": false,
      "handEdited": false, "enHandEdited": false, "unknownDraft": false, "dateBump": false,
      "blocked": null,
      "stages": { "write": "done", "fix": "done", "review": "done", "uaApproval": "pending", "translate": "pending", "align": "pending" },
      "results": {
        "write": { "skill": "user-guide-writer", "interview": "asked 4" },
        "fix": { "applied": 6, "left": 1, "open": ["Line 14: is «Звіт» a UI label here, or the concept?"] },
        "review": { "errors": 0, "deviations": 1, "suggestions": 2, "round": 2 }
      },
      "reviewRound": 2, "reviewAgain": false,
      "syncBase": "4f1c2ab…"
    }
  ],
  "listed": [],
  "outside": [],
  "blocked": [],
  "next": { "stage": "uaApproval", "pages": ["reports/export-report/export-report"] },
  "gate": { "name": "uaApproval", "pages": ["reports/export-report/export-report"] },
  "warnings": []
}
```

| Field | Meaning |
|---|---|
| `ledger` | `present` or `absent`. Absent: a fresh run, `next` is `readiness`, and every other list is empty. |
| `stages.<name>.state`, `pages[].stages.<name>` | `pending` (no record), `running`, `done`, `skipped`, `failed` or `stale` (recorded done, but the files no longer match). `running` when an invoke starts means the last run was interrupted. |
| `stages.<name>.note` | Why a stage is stale, or the recorded reason. |
| `stages.<name>.result`, `pages[].results` | Each stage's `result` as recorded (`null`, or no key, when none was given), whatever its state. |
| `exists`, `enExists` | Whether the UA and EN files are there. |
| `handEdited` | The page was written by the pipeline and its hash now differs from the last pipeline write. |
| `enHandEdited` | The EN page's hash differs from the one `translate` or `align` recorded. |
| `unknownDraft` | `write` isn't done, yet the file exists with a hash the ledger doesn't know. |
| `dateBump` | A `translate` is `running` or `failed`, and the UA page differs from the approved version only in its frontmatter dates: the translator saved before the run stopped. The records still hold. |
| `reviewRound` | The round of the last review (`1` or `2`), or `null` before the first. |
| `reviewAgain` | The last review is done, below round 2, with errors or deviations, and no fix ran after it: the page is due for `fix` again, and `uaApproval` is refused until the next review. |
| `syncBase` | The `--base` for the page's next `doc-translator --sync`: the `HEAD` of its last `translate`, or `baseCommit` before the first. |
| `listed` | The plan's deletes, merged-away and split pages, complete `keep` pages and `api` pages, from the ledger. |
| `outside` | After plan approval: page files in the section that are neither pages of the run nor listed. |
| `blocked` | `{ id, stage, reason }` per blocked page. |
| `next` | `{ stage, pages }`: the first stage in chain order that isn't done or skipped, and for a page stage the pages it is due for (blocked pages left out). `stage` is `null` when the chain is complete. A section stage adds its `state`; `translate` adds `uncommitted`, the due pages whose UA file differs from `HEAD` (a `dateBump` page that differs only in its dates doesn't count). |
| `gate` | `{ name, pages }` or `null`: `plan`, `unknownDraft`, `uaApproval` or `commit`. |
| `warnings` | Hand edits, a missing page, evidence that changed after the plan approval, pages outside the run. |

## Limits

- The hashes are of the working-tree bytes, with no git filters: on an LF repository they equal `git hash-object`.
- The docs site may be a subfolder of its git repository (`--root`, or the working folder): paths stay relative to it.
- The page set is every `.md`/`.mdx` file under the section folder, skipping names that start with `.` (`.sources/`, `.assets/`).
- One run at a time: there is no lock file.
