# ticket-state

The ticket ledger of a docs pipeline and its daily run. `ticket-state.mjs` keeps one ledger per ticket and derives, from the tracker, the forge, git and the files, each ticket's state, its next step and the gate that is open; it records a stage only when the world supports it. `runner.mjs` runs the day: finish first, triage the intake in the morning, start ready groups within the limits, one `claude -p` session per step that needs a model. Node, no dependencies. No AI in either script: they decide, and the role sessions do the work.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/ticket-state.mjs <command> [<key>] [options]
node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/runner.mjs [--dry-run] [--morning] [--manual --ticket <key>] [options]
```

Run them from the host repo (or pass `--root`). Needs Node 18.3+, the `tracker` and `forge` scripts next to this one (their modules are used as libraries, so every tracker and forge rule holds here too), git, and for a live run the `claude` CLI. Tests: `npm test` in this folder (offline: in-memory tracker and forge adapters under the real modules, throwaway git repos, and a stand-in for `claude`).

The contract (the statuses and states, the rule, the ledger's fields, when a record is accepted, the locks, the limits, the report) is `${CLAUDE_PLUGIN_ROOT}/context/ticket-flow.md`. This file is how to run the scripts.

## Settings

The same settings files as the `tracker` and `forge` scripts, found the same way: `--settings <file>`, else the `Ticket flow settings:` field of the host's `CLAUDE.md` (registered in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Ticket flow settings"), else `.claude/ticket-flow.json`. The owner's `<name>.local.json` next to it is merged over it at any depth (a local key wins; a list is replaced). `config` prints the merged result.

The shared file (committed in the host) holds `state`, `tracker`, `forge`, `targets`, `hostRules` and `hostJobs`; the local file holds `mode`, `limits`, `schedule`, `roles`, `modelLadder`, `video` and `cleanup`. Beyond what the `tracker` and `forge` scripts read:

| Key | Default | |
|---|---|---|
| `state` | `<Toolkit state root>/ticket-flow/` | The git-ignored folder for the ledgers (`tickets/`), locks, reports, run logs and roles. |
| `tracker.docLabels` | `[]` | Labels that confirm docs are needed. |
| `tracker.quietHours` | `2` | An intake card is triaged only when its last activity is this many hours old. |
| `tracker.triageMarker` | none | The header of the triage comment: a card with it counts as a ticket even with no ledger. |
| `tracker.priority` | `{ "high": "high", "low": "low" }` | The priority labels (no label: medium; both: high). Read by the `tracker` module. |
| `targets[].appLabel`, `.path`, `.uaRoot`, `.base` | none, none, required, `main` | The label that names the target, its repo's path from the host root (git reads it there), the UA content root in that repo, the base branch. |
| `hostRules` | `{}` | The host's rule files the role sessions read (triage, templates, page locator, git). |
| `hostJobs` | `[]` | The host's own jobs; a `watch: { board, list }` lists the cards left in that list in the report. |
| `mode` | `observe` | `off` runs nothing; `observe` plans and writes only the report; `on` runs. |
| `limits.inProgress` / `limits.waiting` | `3` / `5` | The WIP ceilings for scheduled starts. |
| `limits.parallel` | `3` | Groups advanced at once (1 once the session bar reaches `limits.sessionPercent`, default `80`). |
| `limits.dailyPercent`, `limits.maxWeekPercent` | `10`, none | The day's allowance: `dailyPercent` × the day of the week window, capped by `maxWeekPercent`. |
| `limits.estimates` | `{}` | Percent of the week per size (`edit`, `newPage`, `newSection`) until finished tickets give measured ones. |
| `limits.lockLeaseMinutes`, `limits.triageBatch`, `limits.stepsPerTicket` | `120`, `10`, `12` | A lock's lease; cards per morning triage session; steps one group may take in one run. |
| `schedule.morning`, `schedule.watchMinutes` | `07:00`, `5` | For the watcher that starts the runner. |
| `roles.<role>` | see below | `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `allowedTools`, `disallowedTools` for `triage`, `writer`, `reviewer`, `translator`. |
| `modelLadder` | haiku, sonnet, opus (`claude-*-5-5`) | The one retry of a failed step takes the next model up. |
| `video` | `partMinutes 30`, `partsPerDay 3`, `transcriptHours 2`, `browserProfile` none | The video gate. No `browserProfile`: no automatic try, straight to the person. |
| `cleanup.mode` | `trash` | `trash` moves a merged ticket's work files into the Trash; `delete` removes them. |
| `cleanup.keep` | `["**/sme-interview.md", "**/app-notes.md"]` | Globs (from the host root) the cleanup never removes. |
| `cleanup.trashDir` | `~/.Trash` | Where `trash` moves them. |

Role defaults: triage `claude-sonnet-5-5` medium, writer `claude-opus-5-5` high, reviewer and translator `claude-sonnet-5-5` high.

## Commands

| Command | |
|---|---|
| `status` | Every ticket's state, next step, gate, mismatches and notes; the intake; the groups; `wip`; the allowance; `startable` and `notStarted` with each reason. Reads only: it writes nothing and sends no change. |
| `record <key>` | One stage result (`--stage`, `--status running\|done\|failed`), written only when the tracker, the forge and the files support it; else nothing is written and the reason is in `refused`. `--run <json>` alone adds a session's cost. |
| `handover <key>` | Hands a ticket to the pipeline (`mode hand` → `pipeline`); a ticket with no ledger is rebuilt first from its card, its `PR:` links and each PR's state. `--to hand` takes it back. |
| `lock <key>` / `lock --group <g>` | Takes the group's lock (`--kind schedule\|manual`, optional `--stage`). Refused while a run holds it (`locked`) or while a stale lock is in place (`stale`). |
| `unlock <key>` / `unlock --group <g>` | Releases it. `--stale` moves a stale lock into `<state>/locks/stale/` and records its group's `running` stages failed. |
| `config` | The merged settings as the skills read them; credentials by variable name only. |
| `intake` | The intake cards: `due` (quiet for `quietHours`, highest priority first, then the oldest) and `waiting` (with `quietAt`). |
| `report` | Writes the report `<state>/reports/<date>.md` (`--print`: to stdout instead). |

The runner takes no command.

## Options

`ticket-state.mjs`:

| | |
|---|---|
| `--root <dir>` | The host repo (default: the working directory). |
| `--settings <file>` | The settings file. |
| `--ticket <key>` | `status`: only these tickets in `tickets` (repeatable); the counts still cover all. |
| `--usage-file <file\|->` | `status`, `report`: the text of `claude -p /usage` (or its parsed JSON), for the day's allowance. |
| `--read-usage` | `status`, `report`: run `claude -p /usage` for it. |
| `--stage <s>`, `--status <s>` | `record`: the stage and its status. `lock`: the stage the lock is taken for. |
| `--pr <repo>#<n>` | `record`: the PR of a PR stage (or `<repo>:<branch>` before it has a number). |
| `--to <status\|stage>` | `record move` / `follow`: the status (the card) or, with `--pr`, the PR stage. `handover`: `pipeline` or `hand`. |
| `--head <sha>` | `record`: the branch head a chain stage, `readyForMerge` or `resync` saw (after its own push). |
| `--result <json>`, `--result-file <file\|->` | `record`: the stage's result. |
| `--run <json>` | `record`: a session's cost (`role`, `model`, `effort`, `start`, `turns`, `costUsd`, `tokens`, `weekPercent`, `outcome`, `share`, `retryOf`). |
| `--note <text>` | `record`: required with `--status failed`. |
| `--card <ref>` | `record triage` / `start` with no ledger yet: the card the ledger is made from. |
| `--started-by <schedule\|manual>` | `record start`: who started it (default: the lock's kind, else `manual`). |
| `--group <g>`, `--kind <k>`, `--stale` | `lock`, `unlock`. |
| `--date <yyyy-mm-dd>`, `--print` | `report`. |
| `--origin <url>` | The tracker's API origin (tests). |

`runner.mjs`:

| | |
|---|---|
| `--dry-run` | Prints the plan: each step with its tracker and forge calls or its `claude` command line, the triage, the starts, the cleanup each close would do, and the report. Writes nothing (no ledger, lock, report or run log) and sends no change; the output lists every request sent (`requests`, reads only) and every write the modules caught (`caught`). |
| `--morning` | Also triages the intake cards that are due, in one session (`limits.triageBatch` cards, highest priority first). |
| `--manual` | A manual run: it ignores the limits and the allowance guard, starts only the ready tickets named with `--ticket`, and its tickets stay out of the counts for their whole life. |
| `--ticket <key>` | With `--manual`: only these tickets (repeatable). |
| `--usage-file <file\|->` | The `/usage` text (default: the runner runs `claude -p /usage` before and after each session). |
| `--claude <bin>` | The `claude` command. |
| `--root`, `--settings`, `--origin` | As above. |

## `record`: what each stage checks

A record is refused (exit 1, `refused` in the JSON, nothing written) when:

| Stage | Done needs |
|---|---|
| `triage` | `--result {"verdict"}`; the card in `movedTo` if given. A `needs-info` with `reason: noAppLabel` is refused (`textSettles`) when the card's text names a target. Only `triage` and `start` with `--card` create a ledger (`noLedger`). |
| `start` | The card in progress. |
| `questions`, `planGate`, `videoBlock` | The card in Blocked. `planGate` keeps the plan file's hash (`file` when it is missing). |
| `answers`, `planApproval`, `videoImport` | The card in progress. `planApproval`: the plan file unchanged since the gate (`planChanged`). `videoImport`: every part's transcript file exists. |
| `write` | At least one PR entry. |
| `pr` | Each PR on the forge with the branch the write named (`noPr`). |
| `move --pr` | The card in the status its least advanced PR puts it in (`card`); the PR carries its stage label (`label`). A move to final review keeps the head the review approved. |
| `move`, `follow` | The card in `--to`. |
| chain stages, `readyForMerge`, `resync` | The PR open (`notOpen`) and `--head` its head on the forge (`stale`). `readyForMerge`: every chain stage done (`chain`). |
| `close` | Every PR merged (`notMerged`) and the card done. |

Bad usage is exit 2: an unknown stage, a PR stage without `--pr`, a failed record without `--note`, a result of the wrong shape, a work file outside the host repo and the state root.

Every record may carry `"files": [{ "path", "kind" }]` in its result: work files outside git that the stage created or downloaded, `kind` one of `video`, `videoPart`, `audio`, `transcript`, `frames`, `attachment`, `runDir`, `clone`, `other`. The `videoGate`, `videoTry` and `videoImport` records add the videos, parts and transcripts they name. A record also renews its group's lock lease.

## The id-only change

The approval of a PR (its SME review, or its places settled) and every chain stage keep the head they saw. A UA page changed after that head makes the stage stale, and the approval is reported as one that saw another text, unless the change is id-only:

A UA change is id-only when its only differences from the approved version are (1) `{/* #id */}` comments added to headings that had none, and (2) link fragments rewritten from such a heading's old fragment to its new id. Anything else makes it a real change: a changed or removed id, a changed heading text, or any other edit.

`isIdOnlyChange` in `lib/ids.mjs` is that predicate. A heading's old fragment is the slug Docusaurus made of its text. A link to another page counts when its path resolves to a page of the same change whose heading got that id; one that doesn't resolve is a real change.

## Cleanup after the merge

When every PR of a ticket is merged, the close step moves the work files the ledger recorded into the Trash (`cleanup.mode: delete` removes them), and the close record keeps the list and the space freed for the report. It never removes:

- a path git tracks, in its own repo;
- a path the ledger didn't record;
- a path outside the host repo and the state root (a link that leads outside counts as outside);
- a path `cleanup.keep` names;
- anything, while a PR of the ticket is open or was closed unmerged: then nothing is removed, and the report says so.

A recorded folder goes whole, or file by file when it holds a tracked or kept file. A name taken in the Trash gets a number (`call 2.mp4`); across volumes the move is a copy, then a removal. The dry run lists what each close would remove and removes nothing.

## The daily run

1. `mode off`: nothing. Stale locks are moved aside and their running stages recorded failed.
2. **Finishing**, every group with a next step, in this order: close the merged, ready for merge and the re-sync, the chain and moves to final review, review comments and moves, answers in and gates passed, writing. Within a kind, higher priority first, then the older card. Up to `limits.parallel` groups at once.
3. **Morning** (`--morning`): one triage session for the due intake cards.
4. **Starts**: while `startable` has a group and the guard allows, the highest priority first, the oldest within a level.

Each group is locked (kind `schedule`, or `manual` for a manual run) while it advances, step by step as far as it goes, up to `limits.stepsPerTicket`. A step with no role (`move`, `follow`, `close`, `readyForMerge`, `planApproval`, `videoTry`, `videoBlock`) runs in the script. A step with a role is one session:

```
claude -p <brief> --agents <state>/roles/agents.json --agent ticket-<role> --model <m> --effort <e> --max-turns <n>
  [--max-budget-usd <usd>] --permission-prompts none --output-format json --allowedTools … --disallowedTools … --add-dir <each target repo>
```

The role files are `${CLAUDE_PLUGIN_ROOT}/context/ticket-roles/<role>.md` with `unattended.md` appended to each. The brief names the ticket, the stage, and the exact `record` command. A session passes when every ticket of the step recorded the stage done after it began; else it is retried once with the next model up (`modelLadder`), and a second failure stops the group. Each session's cost (the CLI's estimate, tokens, turns, and the week bar before and after) goes into the ledger's `runs`.

**The guard.** A scheduled start or model step runs only while the week's use is below the day's allowance (`/usage` read before and after each session). No reading, no scheduled start. A manual run is not guarded.

**The limits.** Only tickets a scheduled run started, in `mode pipeline`, count: `inProgress` (planning, writing) and `waiting` (questions, plan gate, video gate, places, the owner's block, rework). A group starts only if `inProgress` + its size ≤ the ceiling (a group larger than the ceiling only when nothing is in progress), `waiting` is below its limit, and its estimate plus what the tickets in work still need fits what is left today. With no estimate for a size yet, one ticket at a time. A group held back by these holds back every lower priority; within a level, a younger group that fits may start.

**The report**, `<state>/reports/<date>.md`, written with no model call: the mode, WIP and allowance; what waits for the owner; PRs with places; PRs labelled with the check label; videos waiting for transcripts (the parts to upload today); ready for merge (and PRs that went on to the final review alone); the cards left in each watched list; what finished and started, and why each other group didn't; mismatches and tickets in the owner's hands; cards that are not tickets; the work files removed after the merge and the space freed; failures and guard stops; the day's cost. Once a week it adds proposed changes to the roles (a role whose steps often needed the retry: the next model; many clean steps at high effort: medium), kept in `<state>/roles-proposal.json`; nothing changes on its own.

## `status` output

`tickets[]`: `key`, `group`, `ledger` (`present` or `absent`), `priority`, `createdAt`, `mode`, `startedBy`, `stage` (the last recorded), `card`, `state`, `next` (the first of `steps`, or null), `steps`, `gate` (`who`, `why`), `mismatch`, `notes`, `prs` (each with `id`, `stage`, `state`, `labels`, `head`, `next`, and `approvalStale`, the UA pages changed after the approval), `counts` (`inProgress`, `waiting` or null), `counted`, `locked` (with `derivedState`), `hand`. Then `intake`, `groups`, `wip` (`inProgress`, `waiting`, `limits`, `manual`), `allowance` (`day`, `cap`, `used`, `remaining`, `inWork`, `inWorkUnknown`), `estimates`, `startable`, `notStarted` (with `reasons`), `notTickets`, `locks`, and `requests` (what was sent to the tracker and the forge, by method; `writes` is empty).

## Exit codes

`0` ok · `1` a record or a lock refused (nothing written; `refused` in the JSON), or a call to the tracker or the forge failed · `2` bad usage or configuration (an unknown command too, as in the `tracker` and `forge` scripts). On `1` and `2` stdout holds `{"ok": false, "error": …}` and the message goes to stderr.

## Files

| | |
|---|---|
| `ticket-state.mjs`, `runner.mjs` | The two CLIs. |
| `lib/rule.mjs` | The next-step rule: one ticket's state, steps, gate and mismatches. |
| `lib/status.mjs`, `lib/world.mjs` | The snapshot: ledgers, the tracker, the forge, git (read only). |
| `lib/record.mjs`, `lib/handover.mjs` | The only writers of a ledger. |
| `lib/limits.mjs`, `lib/allowance.mjs`, `lib/intake.mjs` | The limits and estimates, the day's allowance, the intake. |
| `lib/ids.mjs`, `lib/cleanup.mjs` | The id-only predicate; the cleanup after the merge. |
| `lib/runner.mjs`, `lib/report.mjs`, `lib/locks.mjs` | The daily run, the report, the locks. |
| `lib/ledger.mjs`, `lib/stages.mjs`, `lib/settings.mjs`, `lib/errors.mjs` | The ledger file, the stage vocabulary, the settings, the errors. |
| `test/` | The tests, the in-memory adapters (`test/fakes.mjs`, invented data only). |

## Limits

- The stages' own work (triage rules, writing, the review chain, the video transcriber) belongs to the host's skills and the role sessions; the runner only starts them and checks their records. With no transcriber adapter, an automatic video try fails at once and the gate goes to the person.
- The watcher that starts the runner on a schedule is not here; `schedule` is for it.
- `status` reads git in the target repos at `targets[].path`; a head that isn't fetched there is noted, and hand edits and stale stages aren't checked for it.
