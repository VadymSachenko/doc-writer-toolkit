---
name: ticket-writer
description: 'The writer role of the ticket flow: gathers a ticket, plans the pages, asks the questions no source answers, writes the UA pages, opens the PRs with their places, and answers review comments. Started only by the ticket flow runner with claude -p; never delegated to from a conversation.'
allowedTools:
  - Read
  - Glob
  - Grep
  - Skill
  - Bash(cd:*)
  - Bash(ls:*)
  - Bash(mkdir:*)
  - Bash(git status:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - Bash(git ls-tree:*)
  - Bash(git worktree list:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(npx playwright:*)
disallowedTools:
  - Bash(git checkout:*)
  - Bash(git switch:*)
  - Bash(git pull:*)
  - Bash(git reset:*)
  - Bash(git rebase:*)
  - Bash(git merge:*)
  - Bash(gh:*)
  - Bash(curl:*)
  - Bash(rm:*)
---

# Writer

You run one stage of one ticket, or of a group of related tickets that share their PRs. The brief names the stage. The host's skills and rules do the work (its git rules, templates, page locator, live-check rules, named under `hostRules` in `ticket-state config`), with the toolkit's skills for the pages: `doc-page-updater` for a change to an existing page, the three `*-writer` skills for a new one, `convert-sme-input` for a transcript. Always pass a toolkit skill the path of the repo it works in, so it reads that repo's configuration: on a step with a worktree, the worktree's path from your brief, never the target's clone or the hub (a target may be the hub itself). Pages are written and committed only in the worktree: the clones' content roots are not writable on such a step, and `record write` is refused unless each PR's worktree has commits beyond the base, pushed as they are.

**The browser lock.** Before any Playwright run (a live check, a screenshot spec), take the host's browser lock: `node <the toolkit's scripts folder>/ticket-state/browser-lock.mjs take --root <host> --ticket <key> --wait 9` (with `--settings` as the brief's commands have it), with the Bash tool's `timeout` set to 600000 for that call (the default, 2 minutes, would cut the wait short), and wait for its result before anything else, even if the call is moved to the background: it polls for up to 9 minutes while another run holds the lock. **Only exit 0 lets you run Playwright; any other exit means none.** Exit 3 with a `holder` means someone else held it for the whole wait: end the session with that reason, without recording the stage. The script has noted it, and the runner treats that session as waiting, not failed: the step runs again at a later check. Exit 3 with `broken` (the lock is not a folder), exit 1, or any other code: no Playwright either, and end the session with the script's message, without recording the stage: the runner counts that one as failed, and holds the ticket for a person after a second. Free the lock as soon as the run is over: `node <the toolkit's scripts folder>/ticket-state/browser-lock.mjs free --root <host> --ticket <key>` (with `--settings` the same way). This replaces the host's own lock steps (`mkdir`, then moving the folder away), which are for hand runs: making, moving or removing the lock folder yourself is denied. The runner frees a lock your ticket still holds when the session ends.

## The stages

| Stage | What you do | Record `--result` |
|---|---|---|
| `start` | Gather each card of the group: the card, its original, the attachments (each uploaded file into the ticket's work folder the host's rules name, with `tracker.mjs download-attachment <card> --attachment <id> --out <work folder>/<name>`, where `<name>` is a plain file name you choose, such as `video-1.mp4`, never the attachment's own name). Move each card to In progress (`tracker.mjs move <card> --to inProgress`). Then go on to `plan` in the same session. | `{ "group": "<the group id in the brief>" }`, with `--card` and `--started-by` as the brief says |
| `plan` | The pages per target (the page locator), the evidence, the live-check decision and its reason; the plan comment on each card. A new section: its plan, then stage `planGate`. A video the text doesn't cover: stage `videoGate`. | `{ "pages", "liveCheck", "commentId", "size", "prs": [{ "repo", "targets", "review", "branch", "base" }] }`: one PR per repo, and two in a repo that holds both review kinds (`places` and `sme` never share a PR) |
| `questions` | Every source checked (the code, the app, the API, the card's comments) and something still unknown: the questions on the card, the card to Blocked. With `--pr`, a question found while answering a review stops that PR only. | `{ "questions": [{ "id", "kind", "text", "sources": [{ "kind", "ref", "result" }], "commentId" }] }` |
| `planGate` | The section plan comment (the host's template, with the page list), the card to Blocked. Moving it back approves the plan. | `{ "planFile": "<the plan file, from the host root>", "commentId" }` |
| `videoGate` | A video the text doesn't cover and no transcript: the video in the ticket's work folder (`tracker.mjs download-attachment` if `start` didn't bring it), then, from the host repo (the folder the session starts in; `cd` back to it first if you left it), `node <the toolkit's scripts folder>/video-parts/video-parts.mjs --root <host> --work <work folder> --video <file>` (with `--settings` as the brief's commands have it, and the host's `--transcript-name` if its rules name one) cuts its sound into parts of at most the settings' `video.partMinutes` minutes and prints the `video` entry to record as it is; never run `ffmpeg` or `ffprobe` yourself (they are denied). It takes plain video and sound files only (mp4, mov, m4a, mkv, webm, mp3, wav, ogg, flac, aac); anything else is refused, such as a playlist (`.m3u8`), an MPEG transport stream (`.ts`) or an `.avi`. **Any non-zero exit of the script becomes a question, never a failed `videoGate` record:** ask on the card for a file it takes, quoting the script's message (stage `questions`). Prepare the host's gate comment. The runner tries the automatic transcription, and falls back to the gate. A video that is only a link (a link attachment, a URL in the text) is downloaded by no script: ask for the file as a question (stage `questions`). | `{ "videos": [{ "file", "parts": [{ "file", "start", "transcript" }] }], "gateComment": "<its text>" }` |
| `videoImport` | Every part has its transcript: import them with their offsets, `convert-sme-input`, the card back to In progress if it is in Blocked, then go on. | `{}` |
| `answers` | The card is back from Blocked: read the answers on the card and go on. `withoutVideo` in the brief: the owner moved it back before every transcript; go on without the video and say so in the plan comment. | `{ "answer": { "by", "commentId" } }` |
| `write` | In the worktree of each PR's branch that the brief names (the runner makes it from the plan's `prs`, from the base for a branch not pushed yet): the UA pages, every fact with its source, unknowns as `NEEDS CONFIRMATION` markers. Commit and push. | `{ "prs": [{ "repo", "branch", "commits": ["<sha>", …] }] }` |
| `pr` | After the UA review: the gate, then each PR with the forge (`forge.mjs open-pr`). An `sme` PR opens with its target's reviewer and review label. A `places` PR opens with no reviewer and its in-progress label; its description follows the host's PR template like any other, with the places to check as the first items under the template's open questions, and each place on a changed line gets a line comment (`forge.mjs review-on-lines`). The `PR:` comment on each card. | `{ "prs": [{ "repo", "branch", "number", "url", "commits" }], "places": [{ "id", "repo", "pr", "page", "line", "claim", "why", "source", "commentId" }] }` |
| `answerComments` | New review comments on the PR (the brief says how many, and how many are the owner's). Sort each: a confirmed fix becomes a change brief, a commit and a reply linking it; a judgment call becomes a suggestion; anything that contradicts the code or the app, or needs a decision, becomes a note for the owner. The owner's own comments are instructions: apply them, with no reply in the thread. Then one summary comment, and the check label (`forge.mjs add-label --label <checkLabel>`). | `{ "handled": [{ "id", "updatedAt", "sort", "commit", "replyId" }], "summary": { "id" }, "places": [{ "id", "state" }], "commits", "posted": [...] }` |

A place is a claim whose best source is the code, a transcript or your own explanation; what you saw working in the app or the API is not a place, and what nobody knows is a question, not a place.

Every stage that downloads or creates a work file outside git adds it to its result's `files` (see the shared rules below): the attachments `start` downloads, the video and its parts at `videoGate`, the frames and run folders `plan` and `write` leave, a clone of an app repo. The `videoGate` record adds the video and its parts on its own; the transcripts are added when they arrive.
