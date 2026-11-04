---
name: ticket-flow
description: 'The manual entry point of the ticket flow: shows each docs ticket''s state, next step and open gate from the ticket-state script, prints the runner''s plan, and, after the user confirms, runs the next steps of the named tickets as a manual run (outside the WIP limits) or hands a ticket to the pipeline or back. The runner decides every step; this skill never records a stage, edits a ledger, moves a card or writes a page itself. Explicit invocation only: use explicitly ("ticket-flow status", "use ticket-flow to run ticket 1234"); never on a loose question about a card or a PR.'
---

# ticket-flow

You are the person's way into the ticket flow from a conversation. The scheduled runner advances the tickets on its own; you show where they stand, and run the next steps of the tickets the person names, through the same runner. A script decides each step and records it; you never decide a step, and never do a stage's work in this conversation.

## Scope

- **In scope:** `ticket-state status` read back in plain words; the runner's dry run, shown as a plan; a manual run of the named tickets after the user confirms it; `handover` of a ticket to the pipeline or back to the owner; the stale-lock release the runner offers.
- **Out of scope:** the stages' own work (triage, planning, writing, the review chain), which the role sessions do inside the run; the morning report's reading, which the report skill owns; the watcher that starts scheduled runs; changing the settings (`mode`, the limits, the roles), which the person does in the local settings file. The section chain is `document-section`; a single page update is `doc-page-updater`.

## Arguments

`status` (the default) · `plan` (the dry run) · `run <key> [<key> …]` (a manual run of those tickets) · `handover <key> [--to hand]`.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/ticket-flow.md`: the states, the rule, the limits, the cleanup.
2. `${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/README.md`: the commands, the options, the output fields, the exit codes.
3. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Ticket flow settings": where the host's settings file is.

Nothing else, unless the user names a file. The host's rule files are for the role sessions, not for you.

## Workflow

Run each command as one Bash call, from the host repo, with `--root` set to it. The scripts print JSON; read it, never edit what they write.

### Step 1 — The settings

`node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/ticket-state.mjs config --root <host>`. Exit 2 with "no settings file": tell the user where the settings go (`project-paths.md`, "Ticket flow settings") and stop. Note `mode`: with `off` nothing runs, with `observe` a scheduled run only plans.

### Step 2 — Where the tickets stand

`ticket-state.mjs status --root <host> --read-usage` (or `--ticket <key>` for the named ones; the counts still cover all). Tell the user, per ticket, its state, its next step (or that none runs, and why: a gate and who it waits for, a lock, mode hand), and the mismatches. Then the counts: in progress and waiting against their limits, how many manual tickets, the allowance left today, and each ready group that wouldn't start with its reasons. For `status`, stop here.

### Step 3 — The plan

`node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/runner.mjs --dry-run --root <host>`, with `--manual --ticket <key>` for each named ticket on `run`. Show each planned step: the ticket, the stage, the role and model (or "no model" and its tracker and forge calls), and for a close step the work files it would move to the Trash. Confirm that `caught` is empty and `requests.writes` is empty: a dry run that sent a change is a bug to report, not to go past. For `plan`, stop here.

### Step 4 — The manual run

Only for `run`, and only after the user says yes to the plan of Step 3. `runner.mjs --manual --ticket <key> … --root <host>`. It may take long: each step with a model is a separate headless session. A manual run ignores the WIP limits, and its tickets stay out of the counts for their whole life; say so before the user confirms. If a scheduled run holds the group, the manual run stops there: report it, and don't retry.

### Step 5 — Handover

For `handover`: `ticket-state.mjs handover <key> --root <host>` (add `--to hand` to take a ticket back). A ticket with no ledger is rebuilt from its card and PRs; show what was rebuilt (its PRs and their stages) and ask the user to check it before the next run.

### Step 6 — Self-review before finishing

- Every number you reported comes from the scripts' JSON of this run, not from memory or the board.
- No ledger, lock, report or card was written by you: the only writers were `runner.mjs` (Step 4) and `handover` (Step 5), and only after the user asked for them.
- A refused record or a failed step is reported with the script's own reason; nothing was retried by hand.
- Exit codes read right: `1` is a refusal or a failed call, `2` is bad usage or settings.

### Step 7 — Report

The states and counts (Step 2), the plan (Step 3), and for a run what ran: each step's outcome, the model, and the ticket's state after it. Point to `<state>/reports/<date>.md` for the day's full report.

## Explicit invocation examples

- "ticket-flow status"
- "use ticket-flow to show the plan"
- "ticket-flow run 1234"
- "use ticket-flow to hand ticket 1234 to the pipeline"
