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
| `targets[].links` | `["node_modules"]` | The clone's untracked files the runner links into each ticket worktree (names at the repo's top). Add `.env` when the app checks read it. See "The ticket worktree". |
| `hostRules` | `{}` | The host's rule files the role sessions read (triage, templates, page locator, git). |
| `hostJobs` | `[]` | The host's own jobs, started by the watcher (see "Host jobs"). Each has a `name`, a trigger (`watch: { board, list }` with `quietHours`, or `every` minutes), a `run` (`script` inside the host repo, or `skill`) and `timeoutMinutes` (120). The report lists the cards left in each watched list. |
| `mode` | `observe` | `off` runs nothing; `observe` plans and writes only the report; `on` runs. |
| `limits.inProgress` / `limits.waiting` | `3` / `5` | The WIP ceilings for scheduled starts. |
| `limits.open` | none | The most open tickets a scheduled run started at once: from planning to the final review, ready for merge included. A paused ticket (its card moved back to the ready status), one outside the flow (a PR closed unmerged, the card archived, gone or moved out) and a merged or closed one are not open. A gentler first week: say `2`, then `ticket-state set limits.open --unset`. None: no such limit. |
| `limits.startOrder` | `priority` | Which ready group a scheduled run starts first: `priority` (high first, then the oldest) or `easiest` (the smallest triage size first, a size not known yet counting as the hardest; then fewer repos; then fewer pages; then priority and age). In `easiest` order a group held back by the limits holds back every group after it, equally easy ones too. |
| `limits.parallel` | `3` | Groups advanced at once (1 once the session bar reaches `limits.sessionPercent`, default `80`). |
| `limits.dailyPercent`, `limits.maxWeekPercent` | `10`, none | The day's allowance: `dailyPercent` × the day of the week window, capped by `maxWeekPercent`. |
| `limits.estimates` | `{}` | Percent of the week per size (`edit`, `newPage`, `newSection`) until finished tickets give measured ones. |
| `limits.lockLeaseMinutes`, `limits.triageBatch`, `limits.stepsPerTicket` | `120`, `10`, `12` | A lock's lease; cards per morning triage session; steps one group may take in one run. |
| `limits.sessionsPerStageDay` | `3` | Model sessions one ticket may have for one stage (and PR) in a day; beyond it the ticket is held for the owner until the next day (see "A failed step"). |
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
| `import` | Brings in a host's Markdown ledgers from before the JSON ones (`<from>/<key>.md`, one `name: value` line per fact, default `--from` the state folder): each becomes `<state>/tickets/<key>.json` holding every line (see "The import"). A file with no card URL or no stage line is not a ledger: listed, left as it is. Closed tickets' Markdown is removed after the check; open ones stay. `--dry-run` lists it all and writes nothing. |
| `set <key> <value>` | Sets one key of the owner's local file: `mode`, `limits.*`, `schedule.*`, `roles.<role>.*`, `modelLadder`, `video.*`, `cleanup.*`. The value is read as JSON when it parses (`1`, `null`, `["a"]`), else as text (`on`, `06:30`). The merged settings are checked before the file is written (to a temp file, then renamed); a bad value or a key of the shared file writes nothing (exit 2). `--unset` drops the key, so the default applies. Prints `before`, `after` and `changed`. This is what a request in plain words ("one at a time", "pause the pipeline") turns into. No setting re-arms a held step. `set retry <key>` (or `set retry all`) does, and only that: it gives a held or waiting step of that ticket (or of every ticket) one more try, and lifts the day's session cap; its time goes to `<state>/rearmed.json`, the settings files stay as they are. A key with no ledger is refused (exit 2). `set retry job <name>` re-arms a host job the watcher disarmed: it runs at its next due check (a name that isn't in `hostJobs` is refused, exit 2). |

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
| `--started-by <schedule\|manual>` | `record start`: who started it (default: the lock's kind, else `manual`). The runner records it before the session and the brief passes the same: `schedule` for a ready group a scheduled run starts; `manual` for a manual run's start and for a card a person moved into work; for a start recorded before that goes on, the ledger's own. |
| `--group <g>`, `--kind <k>`, `--stale` | `lock`, `unlock`. |
| `--date <yyyy-mm-dd>`, `--print` | `report`. |
| `--unset` | `set`: drop the key. |
| `--from <dir>` | `import`: the folder of the Markdown ledgers (default: the state folder). |
| `--size <word>=<size>` | `import`: what a size word of the Markdown ledgers means (`edit`, `newPage` or `newSection`); repeatable. A word with none is listed in `misses`. |
| `--dry-run` | `import`: lists what it would import and remove; writes and moves nothing. |

`--from`, `--size` and `--dry-run` are `import`'s only: any other command refuses them (exit 2), so `set mode off --dry-run` writes nothing.
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
| `uninstall` | Unloads it (`launchctl bootout`) and removes the plist, and any other agent of ours started for the same root (`others`). `left` is `false` when neither a job nor a file remains. Reads no settings. |
| `status` | `fileExists` and `loaded`. Reads no settings. |

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
| chain stages, `readyForMerge`, `resync` | The PR open (`notOpen`) and `--head` its head on the forge (`stale`). `readyForMerge`: every chain stage done (`chain`). `align` and `readyForMerge`: no UA image the branch changed without its EN counterpart (`imagePairs`, naming each), when the target repo's screenshot locales include `en` (`screenshot-locales pairs`, run in the PR's worktree at that head, against `origin/<base>`); with no worktree on this machine the record is refused (`imagePairs`), and the runner makes the worktree before the next try. `resync` keeps its head; the PR is ready again only through `readyForMerge` (below). |
| `close` | Every PR merged (`notMerged`) and the card done. |

Bad usage is exit 2: an unknown stage, a PR stage without `--pr`, a failed record without `--note`, a result of the wrong shape, a work file outside the host repo and the state root.

`running` and `failed` need nothing from the world. Before a start's session the runner records `start` `running`, with `--started-by` and the group (`result.group`, for any status of `start`), so the group's lock covers the ticket at once. For a ready card with no ledger, that record (with `--card`) makes the ledger, with the card's list as `left` and the triage `status` read for it (`result.triage`).

Every record may carry `"files": [{ "path", "kind" }]` in its result: work files outside git that the stage created or downloaded, `kind` one of `video`, `videoPart`, `audio`, `transcript`, `frames`, `attachment`, `runDir`, `clone`, `other`. The `videoGate`, `videoTry` and `videoImport` records add the videos, parts and transcripts they name. A record also renews its group's lock lease.

## The id-only change

The approval of a PR (its SME review, or its places settled) and every chain stage keep the head they saw. A UA page changed after that head makes the stage stale, and the approval is reported as one that saw another text, unless the change is id-only:

A UA change is id-only when its only differences from the approved version are (1) `{/* #id */}` comments added to headings that had none, and (2) link fragments rewritten from such a heading's old fragment to its new id. Anything else makes it a real change: a changed or removed id, a changed heading text, or any other edit.

`isIdOnlyChange` in `lib/ids.mjs` is that predicate. A heading's old fragment is the slug Docusaurus made of its text. A link to another page counts when its path resolves to a page of the same change whose heading got that id; one that doesn't resolve is a real change.

## Cleanup after the merge

When every PR of a ticket is merged, the close step first removes the ticket's worktrees (one per PR branch, see "The ticket worktree") with `git worktree remove`, never `--force`, then prunes the clone's list (the linked `node_modules` and `.env` are ignored files, so git removes the links; the clone's own stay). What goes with the worktree: its tracked files at a pushed head, and the ignored files that aren't work files (the links, `build/`, `.docusaurus/`, a pack's output, a staging folder). What keeps it: a commit that `git rev-list HEAD --not --remotes` lists (unless it is a head the pipeline pushed), a change to a tracked file, an untracked file git doesn't ignore (a page a session wrote and never added), or an ignored work file: anything under a `.sources/` folder, or a file `cleanup.keep` matches (its globs read from the worktree's top). A removed worktree's files are gone, not in the Trash, which is why the work files keep it. So is one git refuses to remove (a locked one: `git worktree unlock` first). A recorded work file inside a worktree is reported with it: kept with it, or removed with it. The close record (`cleanup.worktrees`, `kept` and `todo`) and the report name it, with what to do: push it, or copy what you need, then remove it (see "A stuck worktree"). Then it moves the work files the ledger recorded into the Trash (`cleanup.mode: delete` removes them), and the close record keeps the list, the worktrees and the space freed for the report. A recorded folder that is a worktree, or holds one, goes with git the same way; one that is a repository of its own (a `.git` folder) is kept whole and reported. A `.git` link or folder is never moved on its own. It never removes:

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
4. **Starts**: while `startable` has a group and the guard allows, in `limits.startOrder` (the highest priority first, the oldest within a level; or the easiest first). Before each start's session the runner records the start (`running`, with its origin and its group). A group whose start didn't get its card into work holds no slot in the run's later calculations, so the run goes on to the next group.
5. **Morning** (`--morning`): the Markdown ledgers from before the JSON ones whose ticket closed since the import are removed, each after the import's check (see "The import"). No model; a dry run or `observe` lists them (`legacyMarkdown`). The report lists what went under "Work files removed after the merge", and under "Failures" a closed ticket's Markdown that failed the check (each morning until it is imported again) and a file whose ticket couldn't be looked up (the tracker or the forge failing, a ledger that doesn't read). Such a file stays; the others go on.

Each group is locked (kind `schedule`, or `manual` for a manual run) while it advances, step by step as far as it goes, up to `limits.stepsPerTicket`. A step with no role (`move`, `follow`, `close`, `readyForMerge`, `planApproval`, `videoTry`, `videoBlock`) runs in the script. A step with a role is one session:

```
claude -p <brief> --agents <state>/roles/agents.json --agent ticket-<role> --model <m> --effort <e> --max-turns <n>
  [--max-budget-usd <usd>] --permission-prompts none --output-format json --allowedTools … --disallowedTools … --add-dir <each worktree of the step, or each target repo for a step with none>
```

The role files are `${CLAUDE_PLUGIN_ROOT}/context/ticket-roles/<role>.md` with `unattended.md` appended to each. The brief names the ticket, the stage, and the exact `record` command, each command with the settings file the runner read. A session passes when every ticket of the step recorded the stage done after it began; else it is retried once with the next model up (`modelLadder`), and a failure stops the group. Each session's cost (the CLI's estimate, tokens, turns, and the week bar before and after) goes into the ledger's `runs`.

**The ticket worktree.** Before a session of a stage that works on a PR branch (`write`, `uaReview`, `pr`, `answerComments`, the chain, `resync`), the runner makes the worktree of each of the step's PR branches, or brings it up to date (`lib/worktree.mjs`):

- at `<the clone's parent>/.worktrees/<repo>/<branch>`, beside the target's clone (`targets[].path`), outside every repo, and passed to the session with `--add-dir` (the clones aren't, on such a step);
- detached at `origin/<branch>` after a fetch (at `origin/<base>` for a branch not pushed yet), so a branch the owner has checked out in the clone never blocks it; an existing one is fast-forwarded to the branch, never over a session's uncommitted changes to tracked files or its unpushed commits; untracked files a session left don't stop it;
- when the branch was rewritten (the owner's rebase and force push), a clean worktree whose head was an earlier value of `origin/<branch>` (by the clone's reflog of it) is moved to the new head; one with uncommitted changes to tracked files, or with commits the branch never had, is kept as it is: no session starts, and the stage is recorded failed with a note that names the worktree and points here, as a failed step (it waits for a person's action or the next morning run, and the second such failure holds the ticket; see "A stuck worktree");
- with each of `targets[].links` (default `node_modules`) linked from the clone, and listed as `/<name>` in the common git dir's `info/exclude`: a `node_modules/` line in `.gitignore` doesn't match a link, so git would show it.

The brief names each worktree and its push command, `git -C <worktree> push origin HEAD:refs/heads/<branch>`, the only push a role may run. A session never makes, moves or removes a worktree, links a file, or runs `npm ci`/`npm install` (each role denies them), so the build runs with nothing to set up. When a worktree can't be made (a clone not on this machine, a folder in its place that isn't a worktree, git's error) or is stuck (above), no session starts: the stage is recorded failed with the reason, as a failed step with no session (a `runs` entry with no `start`, so it counts toward no cap or cost), and the report shows it.

**What a role session may run.** A session loads every settings layer: the owner's (`~/.claude/settings.json`), the hub's project and local files (`.claude/settings.json`, `.claude/settings.local.json`), and the runner's flags; a deny in any layer wins over an allow in any other. The owner's and a hub's layers allow far more than a role needs. Today's, for example: `git push:*`, `git fetch:*`, `git branch:*` and `git branch *`, `git stash:*`, `git mv *`, `git cherry-pick *`, `git checkout *`, `python3 -c ' *`, `gh pr *`, `find:*`, unscoped Write and Edit, and the tracker's MCP tools. So the runner keeps the role's own rules narrow and denies, in every role, whatever no stage runs:

- **Git, `-C` on the worktree for every change.** The role files hold the reads and `add`/`commit` once, `Bash(git <command>:*)`; the runner adds the `git -C <worktree>` spelling for the literal path of each worktree of the step (`Bash(git -C <worktree> <command>:*)`, a prefix rule, so `git -C <worktree> tag -d x status` matches nothing, and no other folder is allowed). The only push is the brief's exact `git -C <worktree> push origin HEAD:refs/heads/<branch>`, and the only fetches are `git -C <worktree> fetch origin` and `… fetch origin <branch>` for the worktree's branch and base. In the plain spelling (`ROLE_DENIED`), every push, fetch, `branch`, `stash`, `cherry-pick`, `mv`, `rm`, `clean`, `tag`, `remote`, `config`, `update-ref`, `reflog`, `gc`, a worktree change, `checkout`, `switch`, `pull`, `reset`, `rebase`, `merge`, `restore` and `revert` is denied: a plain command runs in whatever checkout the session's folder holds (the hub's own HEAD, say), and a hub's `git push:*` would push it to any branch or delete one by `:<ref>`. The push and branch denials also name each worktree's literal path (`deniedFor`): never `git -C *`, whose `*` would span a commit message. A plain read, `add` or `commit` still runs after a `cd` to a worktree as a separate call (`cd <worktree> && git …` in one call is denied, and so is a quoted path). A step with no worktree (triage, the plan) changes no repo: plain `add` and `commit` are denied there too.
- **Folders.** A step with worktrees gets them as `--add-dir`, and not the target clones: a `cd` outside the session's folder and its add-dirs is denied, so a session never reaches an owner's checkout. A step with none reads the target clones instead.
- **Scripts by name, no code of its own.** `node` runs only the toolkit's scripts a stage needs, by their literal path (`Bash(node <root>/scripts/<script>:*)`), from the runner's own toolkit and from each install of the plugin the hub's sessions load (Claude Code's `installed_plugins.json`), since a skill names its scripts by `${CLAUDE_PLUGIN_ROOT}`. Denied: `node -e`, `-p`, `--eval`, `--print`, `--require`, `--import`, a bare `node` (standard input), `NODE_OPTIONS=…`, `python3`, `python`, `perl`, `ruby`, `sh`, `bash`, `zsh`, `osascript`, `eval`, `xargs`, `env`, `find … -exec`/`-execdir`/`-ok`/`-delete`, a hub's `CORPUS=… *` env prefix, and `node_modules/.bin/playwright`. Every `gh` and `curl` call (the role files), and the tracker's and the browser's MCP tools (`mcp__claude_ai_Trello`, `mcp__trello`, `mcp__playwright`): a role changes the tracker and the forge only through the toolkit's scripts.
- **Files.** An `Edit(...)` deny covers Write too. Denied in any folder: the settings layers (`~/.claude/**`, `~/.claude.json`, any `.claude/**`), `.git/` (hooks and config would run code at the next allowed `git commit` or `status`), the toolkit roots the session runs scripts from, the flow's own state (`tickets/`, `locks/`, `roles/`, `watch/`, `jobs/`, `runs/`, `reports/`, `rearmed.json`, `roles-proposal.json`; a session's own files go in `<state>/tmp/`), `package.json` and the lockfiles, `docusaurus.config.*`, `sidebars.*` and `playwright.config.*`.

What stays open, by design: the writer's `npx playwright test` and the translator's `npm run build` and `npx docusaurus` run code from files in the worktree a session may write (a test script, an MDX page). A host override as broad as `Bash(git:*)`, `Bash(git *)` or `Bash(git -C *)` in any layer would reopen the `-C <other folder>` forms; no layer has one today. In the default rules no role allows `git branch` at all; the plain prefix deny also covers abbreviations (`--del`) and combined flags (`-rD`), and so does the `-C <worktree>` one. The CLI's matching was checked with headless probes (haiku, scratch repos, the layers' allow lists fed in as a `--settings` layer): `:*` is a prefix match, a `*` elsewhere matches any text, a rule that ends in `:*` after a `*` never matches, a deny wins over an allow, each part of a compound command is checked, an `Edit(...)` deny blocks Write, `Edit(//**/x/**)` reaches any folder, and an env prefix (`NODE_OPTIONS=…`) is not matched by the command's own allow. Host jobs, which have no worktree, carry `JOB_DENIED`: the push and branch denials in the plain and `git -C *` spellings, and no fetch at all (a fetch refspec can't be told from a plain fetch by a rule that works).

**After ready for merge.** A commit the pipeline didn't make (the owner's final edit) on a PR that is ready for merge runs, in order: `resync` (its blocks into EN and the further locales; nothing to re-sync is a done stage too); then `visualPack` again when an image changed between the head the pack saw and the new head (any image file outside a `.sources/` folder); then `readyForMerge` for the new head, which runs the UA → EN image check as `align` does (the runner makes the worktree first). The re-sync no longer marks the PR ready by itself.

**A stuck worktree.** A worktree the runner can't bring up to date (uncommitted changes to tracked files, or commits the branch never had, often after the branch was rewritten) stops its stage before any session, and one with work no remote has stays after the close. To clear it: save what you need (push it with the brief's command, or copy the files), then `git -C <clone> worktree remove --force <worktree>`. The runner makes a fresh one at the next step.

**A failed step.** A failed stage stays the ticket's next step, and the session's own comments, labels, moves and pushes show up as events at the next check. So a failed step runs again only:

- after a person acts on the ticket later than the failure: a comment on the card that isn't in `posted`, a comment or review on a PR, a commit on a branch that isn't in `pipelineCommits`, or a move of the card (there and back counts: the card's own moves show it);
- after `ticket-state set retry <key>` or `set retry all`;
- or once at the next morning run (a manual run tries it too).

**A failed start** counts the same. A start whose card is still in the ready status didn't happen: the ticket stays `ready` and counts for no limit; its group waits (the reason says so), holds no slot and holds back no other group, and the next morning run (or a manual run, or a person's action) gives it its one more try. A start whose card is in work (the session moved it, then failed) is `planning` and counts; the start goes on in the finishing order, as it was started: the runner recorded its origin before the session. With no start recorded, a card a person moved into work is a hand start: `manual`, outside every limit. **A stuck worktree** (or one that can't be made) counts the same too: no session runs, and its `runs` entry (`session: null`, no `start`) is read as a failed session's, once, and counts toward no session cap or cost. A start has no worktree, so the two never fall on one step.

Right after a failed session the runner reads the ticket once more and keeps that mark in the session's `runs` entry (`after`: the card's list, its last move and its comments, each PR's head, hand commits and unhandled comments), with `failures`, the failed sessions in a row. What the session wrote without recording it is in the mark, so it never counts as a person's action. Two failed sessions of a step with no person's action between them (the retry up the ladder counts) hold the ticket for the owner: `status` gives it no next step (so a manual run does nothing with it either) and a gate (`held`); the report lists it under "Waiting for you" and once under "Failures"; one urgent notification. A first failure only waits: `next.waits` says for what, and the watcher doesn't hand the ticket on.

**The daily session cap.** Whatever the cause of a loop (a session that records its stage but leaves a fresh event behind each time, say), a ticket has at most `limits.sessionsPerStageDay` model sessions of one stage (and PR) a day. At the cap, `status` holds it for the owner until the next day (`capped`, an owner gate), the watcher sends one urgent notification and writes one line to the run log, the report's failures. `set retry <key>` lifts it.

**The guard.** A scheduled start or model step runs only while the week's use is below the day's allowance (`/usage` read before and after each session). No reading, no scheduled start. A manual run is not guarded.

**The limits.** Only tickets a scheduled run started, in `mode pipeline`, count: `inProgress` (planning, writing) and `waiting` (questions, plan gate, video gate, places, the owner's block, rework). A group starts only if `inProgress` + its size ≤ the ceiling (a group larger than the ceiling only when nothing is in progress), `waiting` is below its limit, and its estimate plus what the tickets in work still need fits what is left today. With no estimate for a size yet, one ticket at a time. With `limits.open` set, a group starts only if the open tickets + its size ≤ it (a larger group only when none is open). Open: a scheduled run started it, and it is from planning to the final review, ready for merge included; not paused, not outside the flow, not merged or closed; a locked ticket counts as what it is doing. The reason a group didn't start names the tickets that hold the slots (`wip.openKeys`, and the groups the same calculation starts). In `priority` order a group held back by these holds back every lower priority; within a level, a younger group that fits may start. In `easiest` order a group held back by them holds back every group after it, equally easy ones too. A group held back only by its lock, a relation to a ticket in work or its failed start holds back no other group.

## The import

`ticket-state import` turns a host's Markdown ledgers from before the JSON ones into JSON ledgers, once, at the switch. The Markdown has one `name: value` line per fact, appended as the ticket went on; a name may repeat (`stage`), and a per-repo name has three forms (`branch[R]: x`, `branch.R: x`, `branch: R=x`).

- Every line goes into the JSON as it is, with its number: `legacy.mapped` for a line that also filled a field (`to` names it), `legacy.fields` for the rest. The JSON holds the whole Markdown, so the Markdown can go.
- Fields it fills: the card and the original card (by URL), the group, the triage (`verdict`, `targets` by each target's `appLabel`, `size` through `--size`, `relations`, `pages`, `triaged_at`), and a PR entry per PR link with its branch. The old `stage` lines go into the log; the stages are the ones `handover` rebuilds.
- Then the tracker and the forge say where each ticket is. **Closed** (no PR open, and the card done, out of scope, archived or gone): `mode hand` with its close recorded. **Ready** (the card in the ready status, no PR, the last stage `triaged`): `mode pipeline`, a ready ticket a scheduled run may start, as a triaged ready card with no ledger already is. **Any other**: `mode hand`, the owner's until `handover`.
- The removal: a closed ticket's Markdown goes (to `cleanup.trashDir`, or deleted with `cleanup.mode: delete`) only after a check that the JSON rebuilds it byte for byte: every line once, in order, and the final newline. A Markdown that fails the check stays, with the reason. The morning run repeats the removal for tickets that closed since; it is the script's own step, never a session's command. A ticket that closed since the import, still `mode hand` and with nothing recorded into it, gets its close recorded first, as the import does for one closed already; a ticket handed over is left to the pipeline's own close.
- Run again, it imports a Markdown that changed since, if nothing was recorded into its JSON since; it never overwrites a ledger that didn't come from an import, or one recorded into since, and then keeps its Markdown.
- A Markdown with no card URL or no stage line is not a ledger (a README, a doc page in a mistyped `--from`): it is in `skipped`, no JSON is written for it, and the removal never moves it.
- `imported[]` gives each ticket's `state` (`closed`, `ready`, `open`), `mode`, `stage`, `lastStage`, PRs, triage, how many lines filled a field and how many were kept as they are, and `misses`: what it couldn't map (a size word with no `--size`, a target label no target has, a branch with no PR link, an unknown stage word). Then `skipped`, `removed` and `kept`, each with its reason, and `failed`: the files whose ticket the removal couldn't look up, with the error.

**The report**, `<state>/reports/<date>.md`, written with no model call: the mode, WIP (with `limits.open`, the open tickets by name) and allowance; what waits for the owner; PRs with places; PRs labelled with the check label; videos waiting for transcripts (the parts to upload today); ready for merge (and PRs that went on to the final review alone); the cards left in each watched list; what finished and started, and why each other group didn't; mismatches and tickets in the owner's hands (a closed one left out); cards that are not tickets; the work files removed after the merge and the space freed; failures and guard stops; the day's cost. Once a week it adds proposed changes to the roles (a role whose steps often needed the retry: the next model; many clean steps at high effort: medium), kept in `<state>/roles-proposal.json`; nothing changes on its own.

## The watcher

One check, every `schedule.watchMinutes`, with no model call of its own (design §5):

1. **The sources:** the board in the settings, each `tracker.watchBoards` board and each host job's board (the actions since a time), and for each target repo the PRs that changed and the PR events (a review request or a label may not move a PR's update time, so both are read).
2. **The cursor**, one per source in `<state>/watch/feed.json`: the window starts 10 minutes before `lastCheck`, and an id already in `seen` is dropped, so the overlap costs nothing. `lastCheck` moves to the start of the check once every event of the window was handed on, or its ticket was kept in `pending` for the next check. A source that fails keeps its `lastCheck`, and the others move on; once 24 hours have passed since its last good read, the gap is written to the run log (the report shows it) and the source starts again from now, still `failingSince` its first failure. A source with no cursor starts from now. The file is written to a temp file and renamed. After a sleep, launchd runs the missed interval once, and that check reads everything since `lastCheck`; if it fails more than 24 hours after `lastCheck`, it is the gap above, and the events of the sleep are never read.
3. **The watched lists:** a host job's board that had events has its list matched (on another board, its lists are read). A list that can't be matched (renamed, gone) fails that board's source for this check, as a failed read would: its cursor stays, none of its events is used, and the reason is in `lastError`.
4. **The tickets:** each event maps to a ticket through the ledgers (a card by id or short link, the ticket's original card, a PR by number or head branch). Events that map to no open ledger (intake cards, other cards) are left to the morning run. After a `set retry`, the tickets with a session in their ledger are looked at too (`status` decides which were re-armed). While a ledger file doesn't read, nothing is handed on: `status` reads every ledger, so it fails too. The tickets of the check's events (and the bad file's) wait in `pending`, the cursors move, and the check reports the bad file (the part is `the ledger <key>`). A morning run due meanwhile fails before its first step (its own `status`) and is tried again at each check, each time reading `/usage`: no triage and no starts until the file reads. Once it reads, the next check hands the waiting tickets on. A check that finds no event and no ticket waiting ends here: no status, no runner, no `/usage`, no `claude`.
5. **The decision is `status`'s:** the watcher asks `ticket-state status` (the same module, in process) about the tickets that changed, and hands those with a next step, not locked, not in the owner's hands and not waiting after a failure, to the runner (`--watcher`) in one run, so each runs once. A ticket a run holds now is kept in `pending` and looked at again on the next check. The watcher never decides a step.
6. **The morning run:** at the first check after `schedule.morning` each day (the Mac may have slept through it), the runner's morning run instead: finishing, triage and starts. It covers every ticket, so the events of that check need nothing more. It waits for a check whose own board (the settings' `tracker.board`) was read: a Mac just awake, with its network still coming up, runs it at the next check (the output's `notes` says why). A board that stays unreadable is told after an hour (below). A morning run that throws before its first step is started again at the next check; one that throws part way counts as that day's, so its triage, starts and retries aren't repeated at every check.
7. **Host jobs** (below), then the notifications.

**An error in one part** of a check (a watched list, `status`, the watcher's run, the morning run, a job, a source that keeps failing) is caught there: it is in the output's `errors` with its reason, in the run log and an urgent notification once a day per part, and the rest of the check goes on. Tickets a failed `status` or run didn't take stay in `pending`.

**A source that keeps failing** (a token revoked or expired, credentials the LaunchAgent can't see, a long outage) is a failed part once its read has failed for an hour of the watcher's awake time (`ALERT_MS` in `lib/feed.mjs`): one part per client, `the tracker` for the boards and `the forge` for the PRs, so a token that is gone is told once, not once per board or repo. The text names the client's error (`HTTP 401 …`) and what to check: the tracker's token and key (`tracker.credentials`) or the forge's sign-in, and the network. It is raised from the first check after `schedule.morning` each day, so a board dead overnight is told in the morning, not at midnight; meanwhile the morning run keeps waiting for the board. Its 24-hour gap is one more part (`the tracker's events`, `the forge's events`), notified at the gap. The hour counts from the later of the source's `failingSince` and `awakeSince`, the first check after a pause in the checks longer than both an hour and three intervals (`pauseMs`: the Mac asleep, the agent off; `checkedAt` in the feed is when the last check ended, so a long run inside a check is not a pause). So a network still coming up after a wake stays quiet, even when the source was already failing as the Mac went to sleep, and a gap that is mostly a sleep is only logged. An hour is twelve checks at the default 5 minutes: long enough for a wake, a VPN or a short outage; short enough that a token gone overnight is told the same morning.

One check at a time: a lock in `<state>/watch/active/`, freed when its process is gone. `mode off`: nothing is read and the cursors stay. `mode observe`: the runner plans and writes the report only, and a due job is logged as planned, not run.

### Host jobs

The host declares in `hostJobs` "when list X gets new cards and stays quiet for N hours, run job Y", or "run job Y every N minutes". The toolkit knows nothing about what a job does.

- **A watched list:** a card that arrives in the list (created there, or moved in) arms the job; every change in the list (a card in, a card out, an action on a card in it) moves `lastChange` to that change's own time, so a change seen only after a sleep still restarts the wait. The job runs once `quietHours` have passed since the last change, once per armed batch. In a check where its board's source failed (or its list couldn't be matched), the job neither runs nor changes: it hasn't seen the list, and its entry says why.
- **`every`:** the job runs when `every` minutes have passed since its last run.
- **`run.script`:** a file inside the host repo, started from the host root (`node` for `.mjs`/`.js`). Not guarded: it makes no model call.
- **`run.skill`:** one `claude -p "/<skill> [args]"` session, with the job's `model`, `effort`, `maxTurns` and `allowedTools` (an unattended run stops at an `ask` rule, so the job's allow list must cover what the skill does), and the roles' push denials in both spellings (`--disallowedTools`: no force push, no push without hooks, no branch deletion), whatever the allow list says. It is a model call, so the guard holds it like a scheduled step: at the allowance it waits an hour, and the owner is told.
- **Its environment:** no API key (below), plus `DOC_TOOLKIT_JOB` (its name), `DOC_TOOLKIT_JOB_LIST`, `DOC_TOOLKIT_JOB_FIRST_CHANGE` and `DOC_TOOLKIT_JOB_LAST_CHANGE` (ISO times: the first card of the batch, the last change). A skill job's `claude` gets the sign-in token; a script never does. Its output goes to `<state>/watch/jobs/<name>-<time>.log`, its outcome to the run log.
- **A failure** is tried again at the next check, quietly: a watch job stays armed and an `every` job keeps its last run, so a network drop of a few minutes costs a few failed tries and nothing more. A job that has failed at each try for an hour of the watcher's awake time (`ALERT_MS`, counted as for a source, so a sleep is not failing time) is disarmed, with one urgent notification: a watch job until a new card arms it, an `every` job until the next morning run (`heldUntil`, the next `schedule.morning`). The report's watcher section shows a job failing since when (`failingSince`, its tries), when it was disarmed (`lastFailure`), until when it is held, and when it was re-armed.
- **Re-armed sooner** (`lib/rearm.mjs`): a job disarmed while reads were failing too (the boards, the PRs: `disarmed.downWith`) re-arms at the first check where all of them read again, and runs in that check if it is due; so after an outage the job runs as soon as the network is back, not the next morning. A job disarmed while every read worked failed on its own, and stays disarmed. `ticket-state set retry job <name>` re-arms one by hand.
- **At night:** a job disarmed before `schedule.morning` sounds nothing then. Its alert is kept in its state (`alert`) and goes out at the first check after `schedule.morning`, as a source's alert does, if the job is still disarmed then; a job that re-armed before the morning drops it unsent.

### Notifications

macOS only, with `osascript`, the text passed as an argument (never inside the script). Once a day, after the morning run: its counts (steps done and failed, groups started, tickets in progress and waiting, the week's use against the allowance). Urgent (with a sound), once a day per reason: a limit reached (a guard stop, of a step or a skill job), a step held after two failed sessions or at its daily session cap, a host job that failed at each try for an hour (held until `schedule.morning` when it happens before it), or a part of a check that failed (a board or the PRs unreadable for an hour, and their 24-hour gap, among them). Nothing else, and nothing goes to the tracker or the forge. `/ticket-report` reads the report itself.

### The plan pays

Every `claude` the runner and the watcher start gets an environment without `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`: with `-p`, either would be used before the plan's sign-in. The watcher also removes them from its own environment and says so in its output (by name, never by value). With `schedule.tokenFile`, it reads the long-lived sign-in token and passes it as `CLAUDE_CODE_OAUTH_TOKEN` in the environment of the `claude` processes only (the sessions, the `/usage` reads, the skill jobs); a file others can read is refused. The token never goes into the watcher's own environment, so host scripts, `git` and `gh` never inherit it, and it is never printed, logged or written into the plist.

### Installing the LaunchAgent

1. The sign-in, optional. Without `schedule.tokenFile`, every `claude` the watcher starts (the sessions, the `/usage` reads, the skill jobs) uses the CLI's own sign-in, as in a terminal: the plist gives the watcher only `PATH` and `HOME`, and the runner adds no token. To use a long-lived token instead, run `claude setup-token`, save the token in a file outside every repo (`chmod 600`), and set `schedule.tokenFile` to it: `ticket-state.mjs set schedule.tokenFile <file>`.
2. `launchd.mjs print --root <host>` to see the plist; `launchd.mjs install --root <host>`. The label is `dev.doc-toolkit.ticket-flow.<host folder name>-<hash>`: the folder's name in ASCII (`host` when nothing is left) and the first 8 hex digits of the SHA-256 of the host's absolute path, so two hosts with the same folder name get two agents. The log is `<state>/watch/launchd.log`. An agent of the same host under another label (found by its plist's `--root`) is replaced.
3. `launchd.mjs uninstall --root <host>` removes it; `left: false` confirms that nothing is left. It needs the path only, not the settings: a host that moved is uninstalled with its old path. It also removes any agent of ours whose plist starts the watcher for that path (`others`). `mode off` in the local file stops every run at once, with no uninstall.

The plist holds absolute paths (node, the watcher in the plugin's folder as installed, the host) and a PATH with `claude`, `git` and `gh`: install again after the plugin or one of them moves.

## `status` output

`tickets[]`: `key`, `group`, `ledger` (`present` or `absent`), `priority`, `createdAt`, `mode`, `startedBy`, `stage` (the last recorded), `card`, `state`, `next` (the first of `steps`, or null; with `waits` and `prior` after a failed session), `steps`, `gate` (`who`, `why`), `mismatch`, `notes`, `prs` (each with `id`, `stage`, `state`, `labels`, `head`, `next`, and `approvalStale`, the UA pages changed after the approval), `counts` (`inProgress`, `waiting` or null), `counted`, `locked` (with `derivedState`), `hand`, and after a failed session `failed` (`stage`, `pr`, `at`, `sessions`, and `acted` or `held`) and `held` (a ready ticket's failed start too); at the daily session cap `capped` (`stage`, `pr`, `sessions`) and `held`. A start step in `next` names its origin (`startedBy`), with `byHand` for a card a person moved into work or `again` for a recorded start that goes on. Then `intake`, `groups` (with `failedStart` when a member's start failed: `held`, `waits`, `sessions`, `at`), `wip` (`inProgress`, `waiting`, `open`, `openKeys`, `limits`, `manual`), `allowance` (`day`, `cap`, `used`, `remaining`, `inWork`, `inWorkUnknown`), `estimates`, `startable` (with `prior`, the failed start sessions so far, when there are some; in `easiest` order with `sizeRank`, `repoCount` and `pageCount`), `notStarted` (with `reasons`), `notTickets`, `locks`, and `requests` (what was sent to the tracker and the forge, by method; `writes` is empty).

## Exit codes

`0` ok · `1` a record or a lock refused (nothing written; `refused` in the JSON), or a call to the tracker or the forge failed · `2` bad usage or configuration (an unknown command too, as in the `tracker` and `forge` scripts). On `1` and `2` stdout holds `{"ok": false, "error": …}` and the message goes to stderr.

## Files

| | |
|---|---|
| `ticket-state.mjs`, `runner.mjs`, `watcher.mjs`, `launchd.mjs` | The four CLIs. |
| `lib/rule.mjs` | The next-step rule: one ticket's state, steps, gate and mismatches. |
| `lib/status.mjs`, `lib/world.mjs` | The snapshot: ledgers, the tracker, the forge, git (read only). |
| `lib/record.mjs`, `lib/handover.mjs`, `lib/import.mjs` | The only writers of a ledger (`import`: the Markdown ledgers, and their removal). |
| `lib/limits.mjs`, `lib/allowance.mjs`, `lib/intake.mjs` | The limits and estimates, the day's allowance, the intake. |
| `lib/ids.mjs`, `lib/cleanup.mjs` | The id-only predicate; the cleanup after the merge. |
| `lib/worktree.mjs`, `lib/pairs.mjs` | The ticket worktrees (made, linked, removed); the UA → EN image check of `record align`. |
| `lib/runner.mjs`, `lib/report.mjs`, `lib/locks.mjs` | The daily run, the report, the locks. |
| `lib/watch.mjs`, `lib/feed.mjs`, `lib/jobs.mjs`, `lib/rearm.mjs`, `lib/notify.mjs` | The watcher's check, its sources and cursor, the host jobs and their re-arm, the notifications. |
| `lib/launchd.mjs`, `lib/env.mjs`, `lib/setlocal.mjs` | The LaunchAgent; the environment of every `claude` (no API key, the sign-in token); `set`. |
| `lib/ledger.mjs`, `lib/stages.mjs`, `lib/settings.mjs`, `lib/errors.mjs` | The ledger file, the stage vocabulary, the settings, the errors. |
| `test/` | The tests, the in-memory adapters (`test/fakes.mjs`, invented data only). |

## Limits

- The stages' own work (triage rules, writing, the review chain, the video transcriber) belongs to the host's skills and the role sessions; the runner only starts them and checks their records. With no transcriber adapter, an automatic video try fails at once and the gate goes to the person.
- The watcher and its LaunchAgent are macOS-first: on another system run `watcher.mjs --quiet` from any scheduler; nothing else changes, and no notification is sent.
- The watcher reads events only for tickets with a ledger; whatever it misses, the morning run reconciles from the full state.
- `status` reads git in the target repos at `targets[].path`; a head that isn't fetched there is noted, and hand edits and stale stages aren't checked for it.
- The daily session cap (`limits.sessionsPerStageDay`) counts every session of the stage, the ones that succeeded too, and it holds a manual run as well: by design, as a safety net for a loop of any cause. `set retry <key>` lifts it.
- The retry up the model ladder runs right after the failed session, with no look at the cap in between, so a pair that starts below the cap can end one session over it.
- A move of the card there and back counts as a person's action by the card's own moves, and those include the pipeline's own scripted moves (another PR's recorded move, say). That costs at most one extra try, and the daily cap bounds it.
- A dead token goes untold when no awake stretch reaches an hour (the hour counts awake time only: a laptop opened for 45 minutes between sleeps of over an hour), or when the Mac is awake only before `schedule.morning` (the tracker and the forge are told from then on). A host job that keeps failing in such short stretches is never disarmed either: it is tried at each check.
- A network drop that starts in the middle of a check, after its reads (in `status`, a run or a watched list's lists), fails that part at once, and its urgent notification goes out at once (the first time that day).
- A gap day gives two urgent notifications, the daily one and the gap's, and the gap's isn't held until `schedule.morning`: on a Mac that stays awake, a token that dies at 02:00 sounds at 02:00 the next night.
- `import` and the morning removal's close write ledgers without taking the group's lock: a `handover` that lands between their read and their write is lost (run it again). Neither runs a session, and the morning one writes only a ticket still in the owner's hands with nothing recorded into it since the import.
- A `runner.mjs` run started by hand without `--manual` is a scheduled run: it is guarded, and the groups it starts count for the limits.
- After a sleep of more than 24 hours, if the first check fails, that check is the gap: the source starts again from it, and the events of the sleep are never read. A card that arrived in a watched list meanwhile doesn't arm its job. The tickets are still reconciled by the morning run, and the report lists the cards left in each watched list. To be fixed before a host relies on a watch job.
- The `git -C` allow rules name the worktree's path literally, so a session that writes the path another way (a trailing slash, a `..` in it, a link to it) is denied, and so is a quoted path; the brief writes it in full and unquoted. A plain read, `add` or `commit` after a `cd` works only as two calls: `cd <worktree> && git …` is denied. A `*` in a deny rule can span words, so the `-C` denials name the worktree rather than `*`; the other mutating commands have no `-C` allow rule, and their plain spelling is denied.
- A worktree folder that exists but isn't the clone's worktree (a leftover) stops the stage until it is moved away; the runner never removes it.
- The image check of `record align` runs only where the PR's worktree is on this machine; elsewhere the record says it was not checked.
- A skill job that keeps failing is tried at each check until its hour is up: about 12 model sessions at the default 5 minutes, against 2 when two failures in a row disarmed it. The guard reads `/usage` before each try and stops it at the day's allowance.
