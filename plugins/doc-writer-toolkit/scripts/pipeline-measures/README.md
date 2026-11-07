# pipeline-measures

Measures a docs pipeline from a clone of the docs repo: the pull requests the pipeline opened in a date range, the commits on them, and the cards they link. Node, no dependencies. No AI is involved. It is the baseline and the after-check for every change that is meant to make the pipeline need less of the owner: it counts what is still left for a person.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-measures/pipeline-measures.mjs --from 2026-09-20 --to 2026-11-03 [options]
```

Run it from the clone (or pass `--root`). Needs Node 18.3+, `git` and, for pull requests, the `gh` CLI signed in. Tests: `npm test` in this folder (offline: a throwaway git repo, hand-made `gh` and Trello JSON, a local server standing in for Trello).

**It only reads.** `git` is asked for `show` and `cat-file`; `gh` for `pr list` and `pr view`; Trello for GET requests. The one other git command is the opt-in `--fetch`, which brings the pull requests' commits into the clone's refs. It runs no push, commit, checkout or merge, makes no `gh` write and sends no Trello write. Both programs are started from one place (`lib/runners.mjs`), which refuses anything else, and a test checks that. The only file it writes is the one named by `--out`.

## Settings

Declared in the `Documentation toolkit configuration` block of `<root>/CLAUDE.md` (the fields are in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Pipeline measures"); a flag overrides its field.

| Flag | Field | |
|---|---|---|
| `--branch-pattern <regex>` | `Pipeline branch pattern:` | Required. Which pull requests are the pipeline's, by head branch. |
| `--commit-pattern <regex>` | `Pipeline commit pattern:` | Required. Which commits are the pipeline's own, by the first line of the message. Every other non-merge commit is the owner's. |
| `--draft-pattern <regex>` | `Draft commit pattern:` | Which pipeline commit is the draft. |
| `--ready-pattern <regex>` | `Ready commit pattern:` | The commit that marks a PR ready for merge. |
| `--sme-list <name>` | `SME review list:` | The Trello list whose entry date is read from the card. |
| `--questions-heading <text>` | `Open questions heading:` | Default `Open questions`. |
| `--review <sme\|places>` | `Pipeline review policy:` | Default `sme`. |
| `--run-log <file>` | `Run log:` | |
| `--env <file>` | `Credentials file:` | Default `.env` in the root. |

A value that starts with a dash needs the `=` form: `--branch-pattern='-doc$'`.

Other flags: `--root <dir>` (default: the working folder), `--from` and `--to` (the window, by the day a PR was created, both days included, UTC; required), `--repo <owner/name>` (default: the clone's `origin`, as `gh` finds it), `--fetch`, `--out <file>`, `--table`, `--redact`, `-h`.

Trello's key and token come from `TRELLO_API_KEY` and `TRELLO_API_TOKEN` (or `TRELLO_TOKEN`) in the environment or the credentials file. They go in an `Authorization` header, never in a URL, and are never printed: not in the output, a warning or an error.

## Output

JSON on stdout, the readable table on stderr; `--table` prints the table alone on stdout. `--out` also saves the JSON. `--redact` leaves out branch names and titles, so the output holds counts, PR numbers and commit hashes only.

```json
{
  "ok": true,
  "range": { "from": "2026-09-20", "to": "2026-11-03" },
  "settings": { "branchPattern": "-doc$", "commitPattern": "…", "draftPattern": "^Draft:", "readyPattern": null, "smeList": "…", "questionsHeading": "Open questions", "reviewPolicy": "sme", "runLog": null },
  "summary": { "prs": {}, "commits": {}, "draft": {}, "owner": {}, "smeReview": {}, "openQuestions": {}, "finalEdit": {}, "review": {}, "places": {}, "cost": {} },
  "prs": [],
  "warnings": []
}
```

Exit codes: `0` ok · `1` a `gh` or `git` call failed · `2` bad usage or a missing declaration (a JSON `{"ok": false, "error": …}` goes on stdout).

**`n/a`.** A measure with no data source yet, or whose source is not set, is `{ "na": "<reason>" }` in the JSON and `n/a` in the table, with the reason listed under it. It is never a zero. In `summary`, a measure is n/a when no PR could make it; otherwise it says how many it covers (`measured`, `of`).

## The measures

Per pull request (`prs[]`), and totalled in `summary`.

| Field | What it is | Source | n/a when |
|---|---|---|---|
| `commits` | The non-merge commits as `pipeline` or `owner` (by the commit pattern), the merge commits, and their abbreviated hashes (`pipelineOids`, `ownerOids`). `notInClone`: commits `gh` lists that the clone lacks (run with `--fetch`). | `gh pr view`, `git show` | never |
| `draft` | `{ commits, markers }`: the marker lines the draft commits add. A marker line holds `NEEDS CONFIRMATION` or `{/* ToDo`. | git | no draft pattern, or no commit matches it |
| `owner` | The owner's commits (those the commit pattern doesn't match) with their changed lines: `commits`, `linesAdded`, `linesRemoved`, `lines`, `files`, and `beforePipeline`, the owner's commits that precede the pipeline's first. Text lines of every file; a binary file counts as a file only. | git | never |
| `smeReview` | `{ at, cards, cardsWithEntry, entries }`: the earliest time any card the PR description links entered the SME review list. A card is a `trello.com/c/<short link>` URL. | Trello | no list declared, no credentials, no card link, no card ever entered the list, no card readable |
| `markersAtSmeReview` | The marker lines the PR's commits up to that time added, less those they removed. | git, Trello | as `smeReview`, or a commit is missing from the clone |
| `openQuestions` | `{ section, items }`: whether the description has the section, and how many list items it holds, nested ones included. The section ends at the next heading of the same or a higher level. | the description | never |
| `finalEdit` | `{ readyCommit, until, commits, linesAdded, linesRemoved, lines, files, oids }`: the owner's commits after the last ready commit, up to the merge (`until: merge`) or the head of a PR still open (`head`). | git | no ready pattern, or no commit matches it |
| `review` | `{ hadReviewer, requested, reviewed }`: a reviewer is anyone but the PR's author, requested or having reviewed. | `gh pr list` | policy `sme` |
| `places` | `{ listed, passedToReviewer, corrected }`: the claims the pipeline couldn't confirm, those the owner passed to a reviewer, those the reviewer corrected. | none yet | always today: nothing the pipeline writes records its places |
| `cost` | `{ total, byStage }`: the cost, tokens and steps from the run log. | the run log | no run log, or no record for the PR |

**Provisional run log.** The unattended flow's run log doesn't exist yet. Until it does, `--run-log` reads a JSON Lines file with one record per step: `{"pr": 41, "stage": "write", "cost": 1.2, "inputTokens": 900, "outputTokens": 300}`. Records with no `pr` number or no `stage` are skipped. When the real log lands, only `lib/runlog.mjs` changes.

**How "the owner's" is told.** Commits carry one identity and no trailer, so the patterns are the only tell: a non-merge commit whose first line doesn't match `Pipeline commit pattern` is the owner's, whoever typed it. A hand edit and a stage the owner started by hand (a style fix, a translation) look the same.

## Sources

Every measure gets its data through one function of `lib/sources.mjs` (`createSources`), and `lib/measures.mjs` calls nothing else. To feed a measure from a better source, replace that function: `main(argv, { sources: { classify, smeEntry, places, runs } })` takes entries that override the defaults, and the tests do exactly that. The functions are `prs`, `commits`, `stats`, `classify` (which commits are the pipeline's, the draft, the ready commit), `smeEntry`, `places` and `runs`; the header of `lib/sources.mjs` states what each returns.

## Limits

- `gh pr list` returns up to 1000 PRs; the window is narrowed by `--search created:…` and again locally.
- A PR's commits come from `gh pr view`, which lists the branch's commits, merges of the base branch included (counted as merges, with no lines).
- Lines are `git show --unified=0` lines, with git's rename detection; they are lines, not words.
- A squash-merged or deleted branch keeps its commits on `refs/pull/<n>/head`; `--fetch` brings them in.
- The time a card entered a list is Trello's `updateCard` action; a card created straight in the list has no such action.
