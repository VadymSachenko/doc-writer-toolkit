---
name: ticket-flow
description: The contract of the ticket flow — the tracker statuses it reads, the ticket states, the next-step rule, the ledger <state>/tickets/<key>.json and its fields, when a record is accepted, the locks, the limits and priority, the cleanup after the merge and the morning report. The scripts/ticket-state scripts hold it in code; the ticket-flow skill and the role sessions read it. Referenced, never copied.
---

# Ticket flow

A docs ticket is a card on the team's board that changes the documentation. The ticket flow takes it from the intake to the merged PRs, mostly unattended: a script decides what runs next, and each step that needs a model is one `claude -p` session in one role. `${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/` holds the decisions (`ticket-state.mjs` and `runner.mjs`, see its `README.md`); the host holds the rules of the work itself (triage, templates, the page locator, git), named in its settings under `hostRules`.

**The world wins.** The tracker, the forge, git and the files are the truth. The ledger keeps only what they can't show (verdicts, the PRs' review kind, the heads a stage saw, the questions, the places, the costs), and the rule reads the world on every call. A person can move a card, edit a branch or answer on the card at any time; the next run follows.

## Statuses

The tracker module speaks in statuses, which the host maps to its lists (`tracker.statuses`): `intake`, `drafts` (never read), `ready`, `inProgress`, `blocked`, `smeReview`, `finalReview`, `done`, `outOfScope`. The flow reads every status except `drafts`; it reads `done` and `outOfScope` only for the cards of open ledgers.

## Ticket states

| State | | Counts as |
|---|---|---|
| `new` | In the intake, not triaged. | |
| `ready` / `needsInfo` | Triaged; `needsInfo` while the needs-info label is on. | |
| `planning` | Started: gathering, the plan, the answers back. | in progress |
| `questions` / `planGate` / `videoGate` | Waiting on the owner: answers, the section plan, the video transcripts. | waiting |
| `writing` | The UA pages, the UA review, the PRs. | in progress |
| `placesWait` | A `places` PR whose places are still open. | waiting |
| `smeReview` | An `sme` PR in the expert's review. | |
| `reworkWait` / `ownerBlock` / `paused` | A person moved the card back to In progress, to Blocked, or to the ready status. | waiting (`paused`: nothing) |
| `finalReview` | The TW final review chain on the PR. | |
| `readyForMerge` | The chain done for the head: the owner's final edit and merge. | |
| `merged` / `closed` | Every PR merged; closed after the close step or a person's move to done. | |
| `outside` | The card archived, gone or outside the flow, or a PR closed unmerged. | |
| `locked` | A run holds the group; `derivedState` is what it is doing. | as derived |

A ticket in `mode hand` (the owner's, or rebuilt with no ledger) is observed only: its state is shown, nothing runs, it counts for nothing. `handover` gives it to the pipeline.

## The rule

A pure function of the ledger and the world. First match wins:

| # | When | State; next step |
|---|---|---|
| 1 | A live lock on the group | `locked`; nothing |
| 2 | `mode hand` | the derived state; nothing; reported |
| 3 | The card archived, gone, or in a list outside the flow | `outside`; reported |
| 4 | Every PR merged | `merged`; `close` |
| 5 | A PR closed unmerged | `outside`; reported |
| 6 | The card's list differs from the one the ledger left it in | a person moved it: follow the move (below) |
| 7 | A stage recorded `running` with no live lock | interrupted: run it again |
| 8–12 | Per PR, each on its own: commits the pipeline didn't make (a hand edit: kept and noted; after ready for merge, `resync`); `placesWait` with a review requested → `move` to `smeReview`; `placesWait` with no open place → `move` to `finalReview`; new review comments (not the pipeline's own; the owner's are instructions) → `answerComments`; `finalReview` → the first chain stage not done for the head, then `readyForMerge` | the least advanced PR's |
| 13 | `videoGate` | the automatic try (`partsPerDay` parts a day), the fallback to the person (Blocked, with the gate comment), or the import once every part has its transcript |
| 14 | `ready` and a free slot | `start` (the `startable` groups) |
| 15 | Otherwise | the state's own step: `start`, `plan`, `write`, `uaReview`, `pr` |

**A person's move (row 6).** Ready → In progress: a manual start. Blocked → In progress: the answers (the question's PR only, if it was a PR's), the plan approved (or a new gate if the plan file changed), the video import (or on without the video). To Blocked or back to ready: the owner's block or a pause, nothing runs. To review, final review or done: the PRs at the card's stage follow, with their stage label; done closes the ticket.

**Two PRs** (one repo per review kind, or two repos). Each PR moves on its own; the card stands where the least advanced PR is. An approved `sme` PR goes on to the final review by itself while the slower one waits, and the report lists it. A question on one PR stops only that PR.

**The chain** of a PR in the final review: `translate`, `enReview`, `locales`, `align`, `labelSync`, `build`, `visualPack`. Each stage keeps the head it saw; a UA page changed after that head makes it and every later stage stale, unless the change is id-only (`scripts/ticket-state/README.md`, "The id-only change"). The approval (the move to the final review) keeps its head the same way: a later word change in UA is reported as a mismatch, not undone.

## The ledger

`<state>/tickets/<key>.json`, in the host's git-ignored state folder (`state` in the settings, default `<Toolkit state root>/ticket-flow/`). Written only by `record` and `handover`, to a temp file and renamed. `key` is the card's team number, else its short link.

| Field | |
|---|---|
| `schemaVersion` | `1`. |
| `key`, `group` | The ticket, and the group it runs with (its keys joined with `-`). |
| `seq`, `createdAt`, `updatedAt` | `seq` counts records; each record carries its `seq`, so "after" needs no clock. |
| `mode`, `startedBy` | `pipeline` or `hand`; `schedule` or `manual` (a manual start stays out of the counts for its whole life). |
| `priority` | `high`, `medium` or `low`, from the card when it was triaged. The card's current label wins in `status`. |
| `card`, `original` | The card's id, short link, url, name, creation time; the card it copies, if any. |
| `stage`, `stages` | The last ticket-level stage; each stage's record: `status`, `seq`, `at`, `note`, `result`. |
| `left` | The status and list the pipeline last left the card in (row 6 compares it). |
| `triage`, `plan` | The verdict, targets, size, relations, pages; the plan, and the section plan's file and hash. |
| `questions` | Each question, its sources, its card comment, its PR if it stops one, its answer. |
| `prs[]` | Per PR: `repo`, `targets`, `review` (`sme` or `places`), `branch`, `base`, `number`, `url`, `stage`, `resumeTo`, `label`, `pipelineCommits`, `approval` (the head the review approved), `chain` (each stage's record and head), `steps`, `readyForMerge` (heads), `merged`. |
| `video` | The videos, their parts (file, start, transcript, tries), the gate comment. |
| `places` | Each place: `repo`, `pr`, `page`, `line`, `claim`, `why`, `state`. |
| `reviewComments`, `summaries`, `posted` | Review comments handled (by id and edit time); the summary comments; the ids of every comment the pipeline posted, so it never answers itself. |
| `files` | The work files outside git the stages created or downloaded: `path`, `kind`, `bytes`, `stage`, `at`. |
| `runs` | Each session: role, model, effort, start, turns, the CLI's cost estimate, tokens, the week bar before and after, outcome, `retryOf`, the share of a group session. |
| `log` | Append-only: `seq`, `at`, `stage`, `pr`, `outcome`, `note`. |
| `legacy` | Set when the ledger was rebuilt at handover. |

## When a record is accepted

`record` writes a stage `done` only when the world supports it: the card in the status the stage leaves it in, each PR on the forge with its branch and stage label, the head the stage names being the branch's head, every chain stage done before `readyForMerge`, every PR merged before `close`. Otherwise nothing is written and the reason is named (`scripts/ticket-state/README.md`, "`record`: what each stage checks"). A session fixes the cause, never the record. `running` and `failed` (with a note) are always accepted.

## Locks

One lock per group, `<state>/locks/<group>/owner.json`, taken with `mkdir` so two takers can't both win: a `kind` (`schedule` or `manual`), the stage, and a lease (`limits.lockLeaseMinutes`) that every record renews. A lock past its lease is stale; only the runner moves one aside (`<state>/locks/stale/`) and records its group's running stages failed. A manual session that finds a scheduled run's lock stops there.

## Limits and priority

Only tickets a scheduled run started, in `mode pipeline`, count. A scheduled run starts a ready group only if: tickets in progress + the group's size ≤ `limits.inProgress` (a group larger than that only when nothing is in progress); tickets waiting < `limits.waiting`; and the group's estimated cost plus what the tickets in work still need fits what is left of the day's allowance (`limits.dailyPercent` of the week per day of the week window, from `/usage`). Estimates are per size, measured on finished tickets, else `limits.estimates`; with none yet, one ticket at a time. Priority is the card's label (`tracker.priority`): high first, then medium (no label), then low, the oldest card first within a level. A group held back by the limits holds back every lower level; within a level, a younger group that fits may start. Finishing comes before starting, and a higher priority first within each kind of finishing.

## Cleanup after the merge

The close step of a ticket whose PRs are all merged moves the work files in `files` into the Trash (`cleanup.mode`), except a path git tracks, a path outside the host repo and the state root, and a path `cleanup.keep` names (default `**/sme-interview.md`, `**/app-notes.md`). A path the ledger didn't record is never touched. While a PR is open or was closed unmerged, nothing is removed. The close record keeps what went and the space freed.

## The report

`<state>/reports/<date>.md`, written by the runner (or `ticket-state report`) with no model call and sent nowhere: what waits for the owner, PRs with places, PRs with the check label, videos waiting for transcripts, ready for merge, cards left in the host jobs' watched lists, what finished and started and why the rest didn't, mismatches and tickets in the owner's hands, the work files removed, failures and guard stops, the day's cost, and once a week the proposed changes to the roles.
