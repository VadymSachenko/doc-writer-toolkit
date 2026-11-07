---
name: ticket-flow
description: The contract of the ticket flow — the tracker statuses it reads, the ticket states, the next-step rule, the ledger <state>/tickets/<key>.json and its fields, when a record is accepted, the locks, the limits and priority, the cleanup after the merge, the morning report and the watcher with its host jobs. The scripts/ticket-state scripts hold it in code; the ticket-flow skill and the role sessions read it. Referenced, never copied.
---

# Ticket flow

A docs ticket is a card on the team's board that changes the documentation. The ticket flow takes it from the intake to the merged PRs, mostly unattended: a script decides what runs next, and each step that needs a model is one `claude -p` session in one role. `${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/` holds the decisions (`ticket-state.mjs` and `runner.mjs`, see its `README.md`); the host holds the rules of the work itself (triage, templates, the page locator, git), named in its settings under `hostRules`.

**The world wins.** The tracker, the forge, git and the files are the truth. The ledger keeps only what they can't show (verdicts, the PRs' review kind, the heads a stage saw, the questions, the places, the costs), and the rule reads the world on every call. A person can move a card, edit a branch or answer on the card at any time; the next run follows.

## Statuses

The tracker module speaks in statuses, which the host maps to its lists (`tracker.statuses`): `intake`, `drafts` (never read), `ready`, `inProgress`, `blocked`, `smeReview`, `finalReview`, `translation`, `done`, `outOfScope`. `finalReview` is the owner's queue; `translation` is where the chain runs, and only a person's move starts it. The flow reads every status except `drafts`; it reads `done` and `outOfScope` only for the cards of open ledgers.

## Ticket states

| State | | Counts as |
|---|---|---|
| `new` | In the intake, not triaged. | |
| `ready` / `needsInfo` | Triaged; `needsInfo` while the needs-info label is on. | |
| `planning` | Started: gathering, the plan, the answers back. | in progress |
| `questions` / `planGate` / `videoGate` | Waiting on the owner: answers, the section plan, the video transcripts. | waiting |
| `writing` | The UA pages, the UA review, the PRs. | in progress |
| `smeReview` | An `sme` PR in the expert's review. | |
| `reworkWait` / `ownerBlock` / `paused` | A person moved the card back to In progress, to Blocked, or to the ready status. | waiting (`paused`: nothing) |
| `finalReview` | The owner's read of the UA: right after the `pr` stage for a `places` PR, with or without places, and after a reviewer's move. Starts nothing. | |
| `translation` | A person moved the card to In translation: the chain on the PR. | |
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
| 8–12 | Per PR, each on its own: commits the pipeline didn't make (a hand edit: kept and noted; after ready for merge, `resync`); a `places` PR at `finalReview` with a new review requested → `move` to `smeReview`; new review comments (not the pipeline's own; the owner's are instructions) → `answerComments`; `translation` → the first chain stage not done for the head, then `readyForMerge` | the least advanced PR's |
| 13 | `videoGate` | the automatic try (`partsPerDay` parts a day), the fallback to the person (Blocked, with the gate comment), or the import once every part has its transcript |
| 14 | `ready` and a free slot | `start` (the `startable` groups) |
| 15 | Otherwise | the state's own step: `start`, `plan`, `write`, `uaReview`, `pr` |

**A person's move (row 6).** Ready → In progress: a manual start, unless the runner recorded a start for the ticket before (its own start session moved the card, or a person moved it after that start failed): then that start goes on, as it was started. Blocked → In progress: the answers (the question's PR only, if it was a PR's), the plan approved (or a new gate if the plan file changed), the video import (or on without the video). To Blocked or back to ready: the owner's block or a pause, nothing runs. To review, final review, In translation or done: the PRs at the card's stage follow, with their stage label; done closes the ticket. A move to In translation is the only UA approve: from any status, it keeps the head (`approval`) and takes every open PR of the ticket below ready for merge, so one card approves the whole ticket and no PR left behind pulls the card back while the chain runs; a ready PR stays ready. Back from In translation stops the chain between steps. On a PR with two cards, a move of either into In translation or back out of it takes the other card along.

**After the chain** every PR of the ticket is ready for merge, and the card goes back to the final review status with `tracker.readyComment`, so that status always means the owner's turn. A person moving it to In translation again starts no model step: a ready PR stays ready, and the card comes back. A question on a PR in the chain brings it back to the owner's queue after the answer, not into the chain.

**A failed step** runs again only after a person acts on the ticket later than the failure (a comment, a review, a hand commit, a move of the card), after `ticket-state set retry <key>`, or once at the next morning run. The pipeline's own writes never count. Two failed sessions with no person's action between them hold the ticket for the owner: no next step, one notification, one line in the report. A failed start counts the same: the runner records each start before its session, so a start whose card never left the ready status leaves the ticket `ready` (counted for nothing; its group waits and holds no slot), and one whose card is in work is `planning`, counted, its start going on as it was started. Whatever the cause, a ticket has at most `limits.sessionsPerStageDay` (3) sessions of one stage a day; beyond them it is held the same way until the next day.

**Two PRs** (one repo per review kind, or two repos). Each PR moves on its own; the card stands where the least advanced PR is. An approved `sme` PR goes on to the owner's queue by itself while the slower one waits, and the report lists it. Both wait for the card: one card can't approve half a ticket, so a `places` PR doesn't go ahead of the review. A question on one PR stops only that PR.

**The chain** of a PR at `translation`: `translate`, `enReview`, `locales`, `align`, `labelSync`, `build`, `visualPack`. Each stage keeps the head it saw; a UA page changed after that head makes it and every later stage stale, unless the change is id-only (`scripts/ticket-state/README.md`, "The id-only change"). The approval (a person's move to In translation) keeps its head the same way: a later word change in UA is reported as a mismatch, not undone. `align` is recorded only when no UA image the branch changed lacks its EN counterpart, in a host whose screenshot locales include `en`.

**After ready for merge**, a UA change, whoever made it, runs `resync` over the range from the head marked ready to the new head (both in the brief), then `visualPack` again if it changed an image, then `readyForMerge` for the new head: a hand commit, and an answer to a comment too. An id-only change keeps the PR ready, and so does a commit of the pipeline that left UA alone.

**The ticket worktree.** The runner, not a role, makes the worktree a session works in: one per PR branch, beside the target's clone, detached at the branch's head, with the clone's `node_modules` (and any other name in `targets[].links`, such as `.env`) linked and excluded. The brief names it and the push command. No role makes or removes a worktree, links a file, or installs packages; a role changes a repo only as `git -C <worktree>` for the worktree the brief names (a plain read also runs after a `cd` to it), the only push allowed is the brief's, and every plain add, commit, push, fetch or branch change, every interpreter string or script of the session's own, and every write that would run code later is denied, whatever the owner's or the hub's settings allow. A worktree with unsaved work is kept after the merge and reported.

## The ledger

`<state>/tickets/<key>.json`, in the host's git-ignored state folder (`state` in the settings, default `<Toolkit state root>/ticket-flow/`). Written only by `record`, `handover` and `import`, to a temp file and renamed. `key` is the card's team number, else its short link.

| Field | |
|---|---|
| `schemaVersion` | `1`. |
| `key`, `group` | The ticket, and the group it runs with (its keys joined with `-`). |
| `seq`, `createdAt`, `updatedAt` | `seq` counts records; each record carries its `seq`, so "after" needs no clock. |
| `mode`, `startedBy` | `pipeline` or `hand`; `schedule` or `manual` (a manual start stays out of the counts for its whole life), recorded by the runner with the start, before its session. |
| `priority` | `high`, `medium` or `low`, from the card when it was triaged. The card's current label wins in `status`. |
| `card`, `original` | The card's id, short link, url, name, creation time; the card it copies, if any. |
| `stage`, `stages` | The last ticket-level stage; each stage's record: `status`, `seq`, `at`, `note`, `result`. |
| `left` | The status and list the pipeline last left the card in (row 6 compares it). |
| `triage`, `plan` | The verdict, targets, size, relations, `together` and `separate` (the triage's judgement of a candidate pair), pages; the plan, and the section plan's file and hash. |
| `questions` | Each question, its sources, its card comment, its PR if it stops one, its answer. |
| `prs[]` | Per PR: `repo`, `targets`, `review` (`sme` or `places`), `branch`, `base`, `number`, `url`, `stage`, `resumeTo`, `label`, `pipelineCommits`, `approval` (the head a person's move to In translation saw), `chain` (each stage's record and head), `steps`, `readyForMerge` (heads), `merged`. |
| `video` | The videos, their parts (file, start, transcript, tries), the gate comment. |
| `places` | Each place: `repo`, `pr`, `page`, `line`, `claim`, `why`, `source`, `reason`, `refs`, `state`; `noRef` when a `code` place came with no reference at a commit (it is reported). |
| `reviewComments`, `summaries`, `posted` | Review comments handled (by id and edit time); the summary comments; the ids of every comment the pipeline posted, so it never answers itself. |
| `files` | The work files outside git the stages created or downloaded: `path`, `kind`, `bytes`, `stage`, `at`. |
| `runs` | Each session: role, model, effort, start, turns, the CLI's cost estimate, tokens, the week bar before and after, outcome, `retryOf`, the share of a group session; a failed one also `failures` (failed sessions in a row) and `after` (what the ticket looked like when it ended). |
| `log` | Append-only: `seq`, `at`, `stage`, `pr`, `outcome`, `note`. |
| `legacy` | Set when the ledger was rebuilt at handover, or imported from a Markdown ledger: then it holds every line of that Markdown with its number (`mapped`, the lines that also filled a field; `fields`, the rest), the file's hash, the old last stage and what the import couldn't map (`misses`). |

**The import.** `ticket-state import` turns a host's Markdown ledgers from before the JSON ones into JSON ledgers. A file with no card URL or no stage line is not a ledger: it is listed and left as it is. A closed ticket (no PR open; the card done, out of scope, archived or gone) gets `mode hand` and its close; a ready one (the card in the ready status, no PR, only triaged) gets `mode pipeline`; any other open one gets `mode hand` until `handover`. A closed ticket's Markdown is removed only once the JSON is checked to rebuild it byte for byte; the morning run repeats that for tickets that closed since, recording the close of one still in the owner's hands and untouched since the import. An open ticket's Markdown stays. The details are in `scripts/ticket-state/README.md`, "The import".

## When a record is accepted

`record` writes a stage `done` only when the world supports it: the card in the status the stage leaves it in, each PR on the forge with its branch and stage label, the head the stage names being the branch's head, every chain stage done before `readyForMerge`, every PR merged before `close`. Otherwise nothing is written and the reason is named (`scripts/ticket-state/README.md`, "`record`: what each stage checks"). A session fixes the cause, never the record. `running` and `failed` (with a note) are always accepted.

## Locks

One lock per group, `<state>/locks/<group>/owner.json`, taken with `mkdir` so two takers can't both win: a `kind` (`schedule` or `manual`), the stage, and a lease (`limits.lockLeaseMinutes`) that every record renews. A lock past its lease is stale; only the runner moves one aside (`<state>/locks/stale/`) and records its group's running stages failed. A manual session that finds a scheduled run's lock stops there.

## Limits and priority

Only tickets a scheduled run started, in `mode pipeline`, count. A scheduled run starts a ready group only if: tickets in progress + the group's size ≤ `limits.inProgress` (a group larger than that only when nothing is in progress); tickets waiting < `limits.waiting`; and the group's estimated cost plus what the tickets in work still need fits what is left of the day's allowance (`limits.dailyPercent` of the week per day of the week window, from `/usage`). Estimates are per size, measured on finished tickets, else `limits.estimates`; with none yet, one ticket at a time. With `limits.open` set, the open tickets + the group's size ≤ it (a larger group only when none is open). Open: a scheduled run started it, and it is from planning to the final review, In translation and ready for merge included; a paused ticket, one outside the flow, a merged or a closed one is not open. The reason a group didn't start names the tickets that hold the slots, and so does the report. A ready ticket waits for a related ticket in work or starting now, where related means overlap: triage named the other in one repo (`#1221` and `1221` are one ticket), the card's text names its number, or the two have a page in common (its repo and path, without the block). Only `together`, the triage's judgement, joins tickets into a group, in either direction, within one repo. Priority is the card's label (`tracker.priority`): high first, then medium (no label), then low, the oldest card first within a level. The start order is `limits.startOrder`: `priority` (by priority, then the oldest; a group held back by the limits holds back every lower level, and within a level a younger group that fits may start) or `easiest` (the smallest triage size first, a size not known yet last; then fewer repos; then fewer pages; then priority and age; a group held back by the limits holds back every group after it, equally easy ones too). A group whose start failed waits as a failed step does, and holds no slot and no other group meanwhile; a run doesn't count a group it already tried, so it goes on to the next. Finishing comes before starting, and a higher priority first within each kind of finishing.

## Cleanup after the merge

The close step of a ticket whose PRs are all merged first removes its worktrees with `git worktree remove --force` and prunes the clone's list, then moves the work files in `files` into the Trash (`cleanup.mode`), except a path git tracks, a path outside the host repo and the state root, and a path `cleanup.keep` names (default `**/sme-interview.md`, `**/app-notes.md`). A path the ledger didn't record is never touched. While a PR is open or was closed unmerged, nothing is removed. A recorded folder that holds a worktree goes with git; one that is a repository of its own is kept whole; a `.git` entry is never moved alone. The close record keeps what went and the space freed.

## The watcher

`watcher.mjs` runs every `schedule.watchMinutes`, started by a LaunchAgent (`launchd.mjs install`), with no model call of its own. It reads what changed since its cursor: the boards' actions, the PRs that changed and the PR events. It maps each event to a ticket through the ledgers, and asks `status` what each changed ticket does next. The runner finishes those with a next step, each once, guarded and counted like a scheduled run, and starts no ready group. A check that finds nothing, with no start pass due, ends there: no status, no runner, no `claude`.

- **The cursor:** a window from 10 minutes before the last check, seen ids dropped. The cursor moves only after every event was handed on. A source that fails keeps its place until 24 hours after its last good read, then the gap is reported. A source that has failed for an hour while the Mac was awake (a token gone, say) is a failed part of the check, one per client, told each day from `schedule.morning` on; its 24-hour gap is told too. A failure right after a wake stays quiet.
- **The morning run:** once a day, at the first check after `schedule.morning` whose board reads.
- **The start pass:** between morning runs, inside `limits.startHours` (default `10-22`, local time), when what a start depends on changed since the last pass (a slot freed, a new ready group, an intake card due for triage, a new day), the runner triages the due intake cards and starts ready groups as a scheduled run does: the same limits, allowance and start order, its starts scheduled ones, counted and reported like the morning run's. A pass that started nothing runs again only after another change, and none runs when the counts leave no room (no `/usage` read then). Outside the hours there is no start and no triage: a change waits for the first check inside them or the morning run. Following the open tickets is the same at any hour. Each start gets a notification, not urgent.
- **Host jobs (`hostJobs`):** "when list X gets new cards and stays quiet for N hours, run job Y", or "every N minutes"; Y is a host script or a skill. A change in the list restarts the wait. A skill job is guarded like a scheduled step. A job that failed at each try for an hour is disarmed; if reads were failing with it, it re-arms once they read again, and `ticket-state set retry job <name>` re-arms it by hand. Its alert, before `schedule.morning`, waits for the morning.

`mode` (`off`, `observe`, `on`) and the limits are in the owner's local file. `ticket-state set` edits one key of it, the way a request in plain words is carried out. No `claude` the flow starts gets an API key or an auth token, so the plan pays. A macOS notification gives the morning counts, and names each ticket the start pass started. It is urgent only for a limit reached, a step that failed twice or hit its daily session cap, a host job that failed at each try for an hour while the Mac was awake (a shorter failure is tried again at the next check, quietly), or a part of a check that failed (the rest of the check goes on). The sign-in token goes to the `claude` processes only, never to a host script, `git` or `gh`.

## The report

`<state>/reports/<date>.md`, written by the runner (or `ticket-state report`) with no model call and sent nowhere: what waits for the owner, PRs with places, PRs with the check label, videos waiting for transcripts, ready for merge, cards left in the host jobs' watched lists, what finished and started and why the rest didn't, mismatches and tickets in the owner's hands, the work files removed, the watcher (its last check, failing sources, host jobs waiting), failures and guard stops, the day's cost, and once a week the proposed changes to the roles. `/ticket-report [date]` reads it on demand.
