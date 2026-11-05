# ticket-state

The ticket ledger of a docs pipeline, its daily run and its watcher. `ticket-state.mjs` keeps one ledger per ticket and derives, from the tracker, the forge, git and the files, each ticket's state, its next step and the gate that is open; it records a stage only when the world supports it. `runner.mjs` runs the day: finish first, triage the intake in the morning, start ready groups within the limits, one `claude -p` session per step that needs a model. `watcher.mjs` is started by launchd every few minutes: it reads what changed on the boards and the PRs, and has the runner finish the tickets that changed; once a day it starts the morning run, and it starts the host's jobs. `launchd.mjs` installs and uninstalls its LaunchAgent. Node, no dependencies. No AI in any of them: they decide, and the role sessions do the work.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/ticket-state.mjs <command> [<key>] [options]
node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/runner.mjs [--dry-run] [--morning] [--manual --ticket <key>] [options]
node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/watcher.mjs [--dry-run] [--quiet] [options]
node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/launchd.mjs print|install|uninstall|status [--noop] [options]
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
| `hostJobs` | `[]` | The host's own jobs, started by the watcher (see "Host jobs"). Each has a `name`, a trigger (`watch: { board, list }` with `quietHours`, or `every` minutes), a `run` (`script` inside the host repo, or `skill`) and `timeoutMinutes` (120). The report lists the cards left in each watched list. |
| `mode` | `observe` | `off` runs nothing; `observe` plans and writes only the report; `on` runs. |
| `limits.inProgress` / `limits.waiting` | `3` / `5` | The WIP ceilings for scheduled starts. |
| `limits.parallel` | `3` | Groups advanced at once (1 once the session bar reaches `limits.sessionPercent`, default `80`). |
| `limits.dailyPercent`, `limits.maxWeekPercent` | `10`, none | The day's allowance: `dailyPercent` × the day of the week window, capped by `maxWeekPercent`. |
| `limits.estimates` | `{}` | Percent of the week per size (`edit`, `newPage`, `newSection`) until finished tickets give measured ones. |
| `limits.lockLeaseMinutes`, `limits.triageBatch`, `limits.stepsPerTicket` | `120`, `10`, `12` | A lock's lease; cards per morning triage session; steps one group may take in one run. |
| `schedule.morning`, `schedule.watchMinutes` | `07:00`, `5` | The morning run starts at the watcher's first check after this local time; the watcher runs every `watchMinutes` (its LaunchAgent takes the value when installed). |
| `schedule.tokenFile` | none | A file, readable by its owner only (`chmod 600`), holding the long-lived sign-in token from `claude setup-token` on its first line. The watcher gives it to every `claude` it starts as `CLAUDE_CODE_OAUTH_TOKEN`, and to nothing else. None: the CLI's own sign-in. |
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
| `set <key> <value>` | Sets one key of the owner's local file: `mode`, `limits.*`, `schedule.*`, `roles.<role>.*`, `modelLadder`, `video.*`, `cleanup.*`. The value is read as JSON when it parses (`1`, `null`, `["a"]`), else as text (`on`, `06:30`). The merged settings are checked before the file is written (to a temp file, then renamed); a bad value or a key of the shared file writes nothing (exit 2). `--unset` drops the key, so the default applies. Prints `before`, `after` and `changed`. This is what a request in plain words ("one at a time", "pause the pipeline") turns into. A change also re-arms the failed steps (see "A failed step"): its time goes to `<state>/rearmed.json`. |

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
| `--unset` | `set`: drop the key. |
| `--origin <url>` | The tracker's API origin (tests). |

`runner.mjs`:

| | |
|---|---|
| `--dry-run` | Prints the plan: each step with its tracker and forge calls or its `claude` command line, the triage, the starts, the cleanup each close would do, and the report. Writes nothing (no ledger, lock, report or run log) and sends no change; the output lists every request sent (`requests`, reads only) and every write the modules caught (`caught`). |
| `--morning` | Also triages the intake cards that are due, in one session (`limits.triageBatch` cards, highest priority first). |
| `--manual` | A manual run: it ignores the limits and the allowance guard, starts only the ready tickets named with `--ticket`, and its tickets stay out of the counts for their whole life. With `--morning` it triages only the named intake cards. |
| `--watcher` | The watcher's run: it finishes only the tickets named with `--ticket`, guarded and counted like a scheduled run; no triage and no start of a ready group. Its sessions are recorded with `trigger: watcher`. |
| `--ticket <key>` | With `--manual` or `--watcher`: only these tickets (repeatable). |
| `--usage-file <file\|->` | The `/usage` text (default: the runner runs `claude -p /usage` before and after each session). |
| `--claude <bin>` | The `claude` command. |
| `--root`, `--settings`, `--origin` | As above. |

`watcher.mjs`:

| | |
|---|---|
| `--dry-run` | Reads the sources and plans: the runner plans as in its own dry run, and a due job is shown with its command line. Writes no cursor, no job state, no run log, no notification. |
| `--quiet` | Prints nothing for a quiet check, one line otherwise (what the LaunchAgent uses, for its log). |
| `--noop` | Does nothing and exits 0, reading no settings: for an install check of the LaunchAgent. |
| `--claude <bin>` | The `claude` command. |
| `--root`, `--settings`, `--origin` | As above. |

`launchd.mjs`:

| Command | |
|---|---|
| `print` | The plist it would install and where; installs nothing. `missing` names `claude`, `git` or `gh` not found on the PATH. |
| `install` | Writes `~/Library/LaunchAgents/<label>.plist` and loads it (`launchctl bootstrap gui/<uid>`); an existing one is replaced. Stops if `claude`, `git` or `gh` is missing. If loading fails, the plist is removed. |
| `uninstall` | Unloads it (`launchctl bootout`) and removes the plist. `left` is `false` when neither the job nor the file remains. |
| `status` | `fileExists` and `loaded`. |

| Option | |
|---|---|
| `--noop` | A test agent under its own label (`<label>.noop`) that runs `watcher.mjs --noop`. |
| `--root`, `--settings` | As above. |

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

The role files are `${CLAUDE_PLUGIN_ROOT}/context/ticket-roles/<role>.md` with `unattended.md` appended to each. The brief names the ticket, the stage, and the exact `record` command, each command with the settings file the runner read. A session passes when every ticket of the step recorded the stage done after it began; else it is retried once with the next model up (`modelLadder`), and a failure stops the group. Each session's cost (the CLI's estimate, tokens, turns, and the week bar before and after) goes into the ledger's `runs`.

**A failed step.** A failed stage stays the ticket's next step, and the session's own comments, labels, moves and pushes show up as events at the next check. So a failed step runs again only:

- after a person acts on the ticket later than the failure: a move of the card, a comment on the card that isn't in `posted`, a comment or review on a PR, or a commit on a branch that isn't in `pipelineCommits`;
- after the owner changes a setting with `set` (that re-arms every failed step);
- or once at the next morning run (a manual run tries it too).

Right after a failed session the runner reads the ticket once more and keeps that mark in the session's `runs` entry (`after`: the card's list and comments, each PR's head, hand commits and unhandled comments), with `failures`, the failed sessions in a row. What the session wrote without recording it is in the mark, so it never counts as a person's action. Two failed sessions of a step with no person's action between them (the retry up the ladder counts) hold the ticket for the owner: `status` gives it no next step and a gate (`held`); the report lists it under "Waiting for you" and once under "Failures"; one urgent notification. A first failure only waits: `next.waits` says for what, and the watcher doesn't hand the ticket on.

**The guard.** A scheduled start or model step runs only while the week's use is below the day's allowance (`/usage` read before and after each session). No reading, no scheduled start. A manual run is not guarded.

**The limits.** Only tickets a scheduled run started, in `mode pipeline`, count: `inProgress` (planning, writing) and `waiting` (questions, plan gate, video gate, places, the owner's block, rework). A group starts only if `inProgress` + its size ≤ the ceiling (a group larger than the ceiling only when nothing is in progress), `waiting` is below its limit, and its estimate plus what the tickets in work still need fits what is left today. With no estimate for a size yet, one ticket at a time. A group held back by these holds back every lower priority; within a level, a younger group that fits may start.

**The report**, `<state>/reports/<date>.md`, written with no model call: the mode, WIP and allowance; what waits for the owner; PRs with places; PRs labelled with the check label; videos waiting for transcripts (the parts to upload today); ready for merge (and PRs that went on to the final review alone); the cards left in each watched list; what finished and started, and why each other group didn't; mismatches and tickets in the owner's hands; cards that are not tickets; the work files removed after the merge and the space freed; failures and guard stops; the day's cost. Once a week it adds proposed changes to the roles (a role whose steps often needed the retry: the next model; many clean steps at high effort: medium), kept in `<state>/roles-proposal.json`; nothing changes on its own.

## The watcher

One check, every `schedule.watchMinutes`, with no model call of its own (design §5):

1. **The sources:** the board in the settings, each `tracker.watchBoards` board and each host job's board (the actions since a time), and for each target repo the PRs that changed and the PR events (a review request or a label may not move a PR's update time, so both are read).
2. **The cursor**, one per source in `<state>/watch/feed.json`: the window starts 10 minutes before `lastCheck`, and an id already in `seen` is dropped, so the overlap costs nothing. `lastCheck` moves to the start of the check once every event of the window was handed on, or its ticket was kept in `pending` for the next check. A source that fails keeps its `lastCheck`, and the others move on; after 24 hours of failing, the gap is written to the run log (the report shows it) and the source starts again from now. A source with no cursor starts from now. The file is written to a temp file and renamed. After a sleep, launchd runs the missed interval once, and that check reads everything since `lastCheck`.
3. **The watched lists:** a host job's board that had events has its list matched (on another board, its lists are read). A list that can't be matched (renamed, gone) fails that board's source for this check, as a failed read would: its cursor stays, none of its events is used, and the reason is in `lastError`.
4. **The tickets:** each event maps to a ticket through the ledgers (a card by id or short link, the ticket's original card, a PR by number or head branch). Events that map to no open ledger (intake cards, other cards) are left to the morning run. After a `set`, the tickets whose last session failed are looked at too. A check that finds no event and no ticket waiting ends here: no status, no runner, no `/usage`, no `claude`.
5. **The decision is `status`'s:** the watcher asks `ticket-state status` (the same module, in process) about the tickets that changed, and hands those with a next step, not locked, not in the owner's hands and not waiting after a failure, to the runner (`--watcher`) in one run, so each runs once. A ticket a run holds now is kept in `pending` and looked at again on the next check. The watcher never decides a step.
6. **The morning run:** at the first check after `schedule.morning` each day (the Mac may have slept through it), the runner's morning run instead: finishing, triage and starts. It covers every ticket, so the events of that check need nothing more.
7. **Host jobs** (below), then the notifications.

**An error in one part** of a check (a watched list, `status`, the watcher's run, the morning run, a job) is caught there: it is in the output's `errors` with its reason, in the run log and an urgent notification once a day per part, and the rest of the check goes on. Tickets a failed `status` or run didn't take stay in `pending`. A morning run that fails counts as that day's: it isn't started again at every check.

One check at a time: a lock in `<state>/watch/active/`, freed when its process is gone. `mode off`: nothing is read and the cursors stay. `mode observe`: the runner plans and writes the report only, and a due job is logged as planned, not run.

### Host jobs

The host declares in `hostJobs` "when list X gets new cards and stays quiet for N hours, run job Y", or "run job Y every N minutes". The toolkit knows nothing about what a job does.

- **A watched list:** a card that arrives in the list (created there, or moved in) arms the job; every change in the list (a card in, a card out, an action on a card in it) moves `lastChange` to that change's own time, so a change seen only after a sleep still restarts the wait. The job runs once `quietHours` have passed since the last change, once per armed batch. In a check where its board's source failed (or its list couldn't be matched), the job neither runs nor changes: it hasn't seen the list, and its entry says why.
- **`every`:** the job runs when `every` minutes have passed since its last run.
- **`run.script`:** a file inside the host repo, started from the host root (`node` for `.mjs`/`.js`). Not guarded: it makes no model call.
- **`run.skill`:** one `claude -p "/<skill> [args]"` session, with the job's `model`, `effort`, `maxTurns` and `allowedTools` (an unattended run stops at an `ask` rule, so the job's allow list must cover what the skill does), and the roles' push denials (`--disallowedTools`: no force push, no push without hooks, no branch deletion), whatever the allow list says. It is a model call, so the guard holds it like a scheduled step: at the allowance it waits an hour, and the owner is told.
- **Its environment:** no API key (below), plus `DOC_TOOLKIT_JOB` (its name), `DOC_TOOLKIT_JOB_LIST`, `DOC_TOOLKIT_JOB_FIRST_CHANGE` and `DOC_TOOLKIT_JOB_LAST_CHANGE` (ISO times: the first card of the batch, the last change). A skill job's `claude` gets the sign-in token; a script never does. Its output goes to `<state>/watch/jobs/<name>-<time>.log`, its outcome to the run log.
- **A failure** is tried again at the next check; a second failure in a row disarms the job, and is urgent. A watch job is disarmed until a new card arms it; an `every` job until the next morning run (`heldUntil`, the next `schedule.morning`). The report's watcher section shows when it failed twice and until when it is held.

### Notifications

macOS only, with `osascript`, the text passed as an argument (never inside the script). Once a day, after the morning run: its counts (steps done and failed, groups started, tickets in progress and waiting, the week's use against the allowance). Urgent (with a sound), once a day per reason: a limit reached (a guard stop, of a step or a skill job), a step held after two failed sessions or a host job that failed twice, or a part of a check that failed. Nothing else, and nothing goes to the tracker or the forge. `/ticket-report` reads the report itself.

### The plan pays

Every `claude` the runner and the watcher start gets an environment without `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`: with `-p`, either would be used before the plan's sign-in. The watcher also removes them from its own environment and says so in its output (by name, never by value). With `schedule.tokenFile`, it reads the long-lived sign-in token and passes it as `CLAUDE_CODE_OAUTH_TOKEN` in the environment of the `claude` processes only (the sessions, the `/usage` reads, the skill jobs); a file others can read is refused. The token never goes into the watcher's own environment, so host scripts, `git` and `gh` never inherit it, and it is never printed, logged or written into the plist.

### Installing the LaunchAgent

1. Run `claude setup-token`, save the token in a file outside every repo (`chmod 600`), and set `schedule.tokenFile` to it: `ticket-state.mjs set schedule.tokenFile <file>`.
2. `launchd.mjs print --root <host>` to see the plist; `launchd.mjs install --root <host>`. The label is `dev.doc-toolkit.ticket-flow.<host folder name>`, the log `<state>/watch/launchd.log`.
3. `launchd.mjs uninstall --root <host>` removes it; `left: false` confirms that nothing is left. `mode off` in the local file stops every run at once, with no uninstall.

The plist holds absolute paths (node, the watcher in the plugin's folder as installed, the host) and a PATH with `claude`, `git` and `gh`: install again after the plugin or one of them moves.

## `status` output

`tickets[]`: `key`, `group`, `ledger` (`present` or `absent`), `priority`, `createdAt`, `mode`, `startedBy`, `stage` (the last recorded), `card`, `state`, `next` (the first of `steps`, or null; with `waits` and `prior` after a failed session), `steps`, `gate` (`who`, `why`), `mismatch`, `notes`, `prs` (each with `id`, `stage`, `state`, `labels`, `head`, `next`, and `approvalStale`, the UA pages changed after the approval), `counts` (`inProgress`, `waiting` or null), `counted`, `locked` (with `derivedState`), `hand`, and after a failed session `failed` (`stage`, `pr`, `at`, `sessions`, and `acted` or `held`) and `held`. Then `intake`, `groups`, `wip` (`inProgress`, `waiting`, `limits`, `manual`), `allowance` (`day`, `cap`, `used`, `remaining`, `inWork`, `inWorkUnknown`), `estimates`, `startable`, `notStarted` (with `reasons`), `notTickets`, `locks`, and `requests` (what was sent to the tracker and the forge, by method; `writes` is empty).

## Exit codes

`0` ok · `1` a record or a lock refused (nothing written; `refused` in the JSON), or a call to the tracker or the forge failed · `2` bad usage or configuration (an unknown command too, as in the `tracker` and `forge` scripts). On `1` and `2` stdout holds `{"ok": false, "error": …}` and the message goes to stderr.

## Files

| | |
|---|---|
| `ticket-state.mjs`, `runner.mjs`, `watcher.mjs`, `launchd.mjs` | The four CLIs. |
| `lib/rule.mjs` | The next-step rule: one ticket's state, steps, gate and mismatches. |
| `lib/status.mjs`, `lib/world.mjs` | The snapshot: ledgers, the tracker, the forge, git (read only). |
| `lib/record.mjs`, `lib/handover.mjs` | The only writers of a ledger. |
| `lib/limits.mjs`, `lib/allowance.mjs`, `lib/intake.mjs` | The limits and estimates, the day's allowance, the intake. |
| `lib/ids.mjs`, `lib/cleanup.mjs` | The id-only predicate; the cleanup after the merge. |
| `lib/runner.mjs`, `lib/report.mjs`, `lib/locks.mjs` | The daily run, the report, the locks. |
| `lib/watch.mjs`, `lib/feed.mjs`, `lib/jobs.mjs`, `lib/notify.mjs` | The watcher's check, its sources and cursor, the host jobs, the notifications. |
| `lib/launchd.mjs`, `lib/env.mjs`, `lib/setlocal.mjs` | The LaunchAgent; the environment of every `claude` (no API key, the sign-in token); `set`. |
| `lib/ledger.mjs`, `lib/stages.mjs`, `lib/settings.mjs`, `lib/errors.mjs` | The ledger file, the stage vocabulary, the settings, the errors. |
| `test/` | The tests, the in-memory adapters (`test/fakes.mjs`, invented data only). |

## Limits

- The stages' own work (triage rules, writing, the review chain, the video transcriber) belongs to the host's skills and the role sessions; the runner only starts them and checks their records. With no transcriber adapter, an automatic video try fails at once and the gate goes to the person.
- The watcher and its LaunchAgent are macOS-first: on another system run `watcher.mjs --quiet` from any scheduler; nothing else changes, and no notification is sent.
- The watcher reads events only for tickets with a ledger; whatever it misses, the morning run reconciles from the full state.
- `status` reads git in the target repos at `targets[].path`; a head that isn't fetched there is noted, and hand edits and stale stages aren't checked for it.
