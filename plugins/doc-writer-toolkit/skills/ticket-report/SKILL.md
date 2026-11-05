---
name: ticket-report
description: 'Reads the ticket flow''s morning report for a date (today by default) from the host''s state folder and shows it: what waits for the owner first, then the rest as written. Read only: it writes no report, runs no step and changes no setting. Explicit invocation only: use explicitly ("/ticket-report", "ticket-report 2026-11-10", "use ticket-report for yesterday"); never on a loose question about the pipeline or a card.'
---

# ticket-report

You show the person the ticket flow's report for one day. The runner writes it with no model call, `<state>/reports/<date>.md`; you read it and put what needs the person first. You never write or refresh it, and never act on what it says.

## Scope

- **In scope:** finding the state folder through `ticket-state config`; reading the report of the date asked (today by default); listing the dates there are when that one is missing; a short summary of what needs the person, then the report as written.
- **Out of scope:** writing or refreshing the report (the runner and `ticket-state report` do that); acting on a ticket (the `ticket-flow` skill: status, a manual run, a handover); changing `mode` or a limit (`ticket-flow settings`); installing the watcher (`launchd.mjs`, in `scripts/ticket-state/README.md`).

## Arguments

`[<yyyy-mm-dd> | today | yesterday]`, default today in the Mac's local time.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/ticket-flow.md`, "The report" and "The watcher": what the sections mean.

Nothing else, unless the user names a file. The report itself is the data.

## Workflow

Run each command as one Bash call, from the host repo.

### Step 1 — The state folder

`node ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-state/ticket-state.mjs config --root <host>`. Take `settings.state` (an absolute path). Exit 2 with "no settings file": tell the user the host declares no ticket flow (`${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Ticket flow settings") and stop.

### Step 2 — The date

The argument, else today: `date +%F`. `yesterday` is `date -v-1d +%F` on macOS. A date not in `yyyy-mm-dd` form: ask for one, once.

### Step 3 — The file

Read `<state>/reports/<date>.md`. If it is missing, list `<state>/reports/` and name the latest dates there. The runner writes the report at each run, and the morning run starts at the watcher's first check after `schedule.morning`. Stop there. Don't offer to write one: `ticket-state report` is the person's to run.

### Step 4 — Show it

First, in a few lines and only from the file:

- the mode and the allowance line;
- what waits for the person: "Waiting for you", "PRs with places", the PRs with the check label, "Videos waiting for transcripts", "Ready for merge";
- "Failures and guard stops", and in "The watcher" any failing source or a job that failed twice.

Then the report as written, unchanged. Don't reorder its sections, round its numbers or drop its links.

### Step 5 — Self-review before finishing

- Every line of the summary comes from the file of that date, not from the board, the PRs or memory.
- Nothing was written, run or changed: no report, ledger, lock, setting or card.
- A missing report was said to be missing, with the dates there are; none was made up.

## Explicit invocation examples

- "/ticket-report"
- "ticket-report 2026-11-10"
- "use ticket-report for yesterday"
