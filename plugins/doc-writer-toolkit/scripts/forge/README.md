# forge

The forge of a docs pipeline: open and edit a pull request, read its state, its reviews and review comments, follow the repository's event feed, comment on lines as one review, reply in a review thread, post a suggested change, set labels, and settle a thread or remove a conversation comment the pipeline itself posted. Node, no dependencies. No AI is involved: a pipeline step, or a watcher that runs no model, calls it instead of composing `gh` commands by hand.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/forge/forge.mjs <command> [options]
```

Run it from the host repo (or pass `--root`). Needs Node 18.3+ and the `gh` CLI, logged in as the account the team texts go out under (or with `GH_TOKEN` / `GITHUB_TOKEN` in the environment). Tests: `npm test` in this folder (offline: a stand-in `gh` that replays invented answers recorded in the shape `gh api` prints, and an in-memory adapter).

The module has one job per rule. `lib/forge.mjs` holds every decision; the **GitHub adapter** (`adapters/github/`) is the only code that knows GitHub, and it talks to it only through `gh api` (REST, and GraphQL for the reads that need it and for label changes). `gh pr create`, `gh pr edit` and the other porcelain commands are not used: they run GraphQL queries of their own that fail on some repositories. A GitLab adapter is a new folder under `adapters/` with the methods in `lib/adapter-contract.mjs` and one line in `adapters/index.mjs`; no caller changes.

## Settings

The same ticket flow settings file as the `tracker` script, found the same way: the first of `--settings <file>`, the `Ticket flow settings:` field of the `Documentation toolkit configuration` block of `<root>/CLAUDE.md` (registered in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Ticket flow settings"), `.claude/ticket-flow.json`. A file named `<name>.local.json` next to it is merged over it: objects key by key, anything else replaced. The `forge` object, the `targets` list and `commentHeader` are read here.

```json
{
  "commentHeader": "**[bot]**",
  "forge": { "kind": "github", "owner": "acme-docs", "self": "pat", "assignee": "pat", "checkLabel": "Check me", "readyLabel": "merge advised" },
  "targets": [
    { "id": "guide", "repo": "guide-docs", "review": "sme", "reviewers": ["rev-one"],
      "labels": { "inProgress": "in progress", "review": "in SME review", "finalReview": "In final review", "translation": "in translation" } },
    { "id": "api", "repo": "api-docs", "review": "places", "reviewers": ["rev-two"],
      "labels": { "inProgress": "In progress", "review": "In tech review", "finalReview": "In final review" } }
  ]
}
```

| Key | | |
|---|---|---|
| `forge.kind` | required | The adapter: `github`. |
| `forge.owner` | required | The account or organization that owns the repositories. |
| `forge.self` | no | The login the pipeline writes with. `reply` uses it to see its own earlier reply. |
| `forge.assignee` | no | Assigned to a PR that `open-pr` creates, unless `--assignee` says another. |
| `commentHeader` | no | One line at the top of the file, shared with the `tracker` script: every comment, reply, suggestion and line comment (and a review's own text) is sent with it in front, then an empty line, then the text; a text that already starts with it gets it once. A PR's title and description take none. `--unless-header` and the duplicate checks read a comment without it, so one from before the header counts the same. None: no header. |
| `forge.checkLabel` | no | The label that asks the owner to look at a PR. The module may add it, and may remove it: the ticket flow sets it from the questions left open to the owner, and removes it when a person moves the card past the final review, the owner's check done. |
| `forge.readyLabel` | no | The label on a PR the ticket flow marked ready for merge, its recommendation to merge; a label of its own (not a stage, check or expert label). The module may add it and remove it, and creates it on a repository that lacks it. The owner's own merge label is another, which the settings never name. None: no such label. |
| `forge.translatedLabel` | no | The label on a PR whose translations match its UA (`translated`, say): the ticket flow puts it on after the chain or a re-sync and takes it off at a UA change; a label of its own (not a stage, check, expert or ready label). The module may add it and remove it, and creates it on a repository that lacks it. None: no such label. |
| `forge.expertLabel` | no | The label on a PR whose writer recommends an expert review (the ticket flow's `pr` record adds it). The module may add it and never removes it. None: no such label. |
| `targets[].id`, `targets[].repo` | required | A target's id (unique), and its repository (`name`, or `owner/name` with the forge's owner). |
| `targets[].reviewers` | no | Logins the module may ask for a review. |
| `targets[].labels` | no | `{ inProgress, review, finalReview, translation }`: the target's stage labels. `translation` is optional: the label of a PR in the translation chain. A target without it keeps its `finalReview` label through the chain (the ticket flow sets `finalReview` instead). |
| `targets[].review` | no | `sme` or `places`; read by the callers, not by this module. |

**What the settings let the module touch.** `settings` prints it.

- **Repositories:** only those a target names. Any other is refused (`notAllowed`).
- **Logins** (assignee, reviewers): `self`, `assignee` and the targets' `reviewers`. Any other is refused (`notAllowed`).
- **Labels it adds:** every target's stage labels, `checkLabel`, `expertLabel`, `readyLabel` and `translatedLabel`. Any other label is refused before a request is made (`notNamed`), so a label the settings do not name (the owner's own label that marks a PR ready to merge) cannot be set by any operation. **Labels it removes:** the stage labels, `checkLabel`, `readyLabel` and `translatedLabel`; `expertLabel` is never removed. A label is compared without case and spacing, as GitHub does. A label the repository does not have is reported (`unknown`), and not created, but for `readyLabel` and `translatedLabel`: `add-label` creates it (grey, `ededed`) and adds it, with `created: true`; one made meanwhile (GitHub's 422) is no error.

## Commands

All print JSON on stdout: `{ "ok": true, "command": …, … }`. Every command that changes something has `posted`: the ids it posted, as `{ kind, id }` (`pr`, `review`, `review-comment`, `comment`), for the ledger. Ids are the numeric ids GitHub gives (what `reply --comment` takes); `nodeId` is the GraphQL form. A change that did nothing because the state already was as asked says so (`changed: false`, `replied: false`, `commented: false`, `created: false`, with `reason`) and has `posted: []`.

| Command (operation) | Does | Output |
|---|---|---|
| `settings` | What the settings let the module touch. | `kind`, `owner`, `self`, `assignee`, `repos`, `targets`, `addableLabels`, `removableLabels`, `logins`, `operations`. |
| `open-pr --repo <r> --head <branch> --base <branch> --title <t> [--body <t>] [--assignee <login>] [--reviewer <login>]... [--label <name>]... [--draft]` (`openPr`) | Opens a PR from a branch of the same repository, assigns it, asks the reviewers, adds the labels. **If an open PR of that head already exists, returns it and changes nothing.** A second head in the same repo is a second PR. The title may not be empty. `checkLabel`, `readyLabel` and `translatedLabel` are refused (`notNamed`): the ticket flow's runner sets them on their own with `add-label`. | `created`, `number`, `url`, `draft`, `head`, `base`, `assignees`, `reviewers`, `labels`, `posted` (the PR). When it exists: `created: false`, `number`, `url`, `state`, `head`, `base`, `headCommit`, `updatedAt`, `reason`. |
| `edit-pr --repo <r> --number <n> [--title <t>] [--body <t>]` (`editPr`) | Sets the title and/or the description. An empty one is refused (`empty`); the same text is a no-op. | `changed`, `fields`, `reason`. |
| `pr-state --repo <r> (--number <n> \| --head <branch>) [--with-body]` (`prState`) | One PR. By head: the open PR of that branch in the repository, else the most recent; a fork's branch of the same name is not it. `--with-body` adds its description (`body`), for a session that edits it with `edit-pr`. | `number`, `url`, `title`, `state` (`open`, `closed`, `merged`), `draft`, `head`, `base`, `headCommit`, `mergeCommit`, `mergedAt`, `closedAt`, `createdAt`, `updatedAt`, `author`, `reviewDecision` (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or `null`), `mergeable`, `mergeState` (GitHub's merge state status: `CLEAN`, `BLOCKED`, …), `reviewRequests[]` (`{ login }` or `{ team }`), `labels[]`, `assignees[]`; by number also `baseCommit` (the base branch's tip now) and `checks` (the CI of the head branch's tip: `commit`, which a caller compares with `headCommit`, `state` `success`, `failure`, `pending` (a required check not started yet included) or `null` when no check reported, `failing[]` and `pending[]` by name). |
| `changed-prs-since --repo <r> --since <time>` (`changedPrsSince`) | The PRs updated since a time, every state, newest update first, read page by page until one is older. | `since`, `count`, `numbers[]`, `prs[]` (`number`, `head`, `base`, `state`, `draft`, `updatedAt`, `headCommit`, `mergeCommit`, `reviewDecision`, `reviewRequests`, `labels`, `url`). |
| `pr-activity --repo <r> --number <n> [--since <time>]` (`prActivity`) | The PR's reviews, review threads with their comments, conversation comments and review requests. A review not yet submitted (a draft, `PENDING`) is left out, and so are its line comments, with a thread that holds nothing else: GitHub gives a draft's comments to its author, and the pipeline acts from the owner's login, so they would read as the owner's instructions. Once the review is submitted they are read. With a time, only what was posted or edited since: a thread stays whole when one of its comments is new. | `pr` (`state`, `headCommit`, `reviewDecision`), `reviewRequests`, `counts`, `reviews[]` (`id`, `author`, `authorBot` when a bot wrote it, as on comments, `state`, `body`, `submittedAt`, `commit`), `threads[]` (`id`, `resolved`, `outdated`, `path`, `line`, `truncated`, `comments[]`), `comments[]`. A comment: `id`, `nodeId`, `author`, `body`, `createdAt`, `updatedAt`, `path`, `line`, `inReplyTo`, `reviewId`, `new` (since the time), `edited` (updated more than 5 s after it was created: GitHub stamps a new review's comments a second late). |
| `events-since --repo <r> --since <time> [--types a,b]` (`eventsSince`) | The repository's PR events since a time, newest first: `issues/events` has no `since`, so pages are read until one holds an older event. Default types: `review_requested`, `review_request_removed`, `labeled`, `unlabeled`, `merged`, `closed`, `reopened`. | `types`, `count`, `truncated` (the page ceiling, 100, was reached), `events[]` (`id`, `event`, `createdAt`, `actor`, `number`, and `label`, `reviewer`, `team`, `requester` or `commit` where the event has one). |
| `request-reviewers --repo <r> --number <n> --reviewer <login>...` (`requestReviewers`) | Asks the logins for a review. Those already asked, and the PR's author, are left out. | `requested[]`, `skipped[]` (`login`, `reason`), `changed`. |
| `review-on-lines --repo <r> --number <n> --commit <sha> --comments-file <file\|-> [--body <t>] [--drop-outside \| --outside-in-body] [--skip-diff-check]` (`reviewOnLines`) | One review with event `COMMENT` and a line comment per place; the file is a JSON list of `{ path, line, body }`, `line` on the new side, and may be `[]` when `--body` gives the review a text. See "Line comments" below. | `reviewId`, `commentIds[]`, `comments[]` (`id`, `path`, `line`), `skipped[]` (already on the PR), `outside[]` (outside the diff: left out with `--drop-outside`, in the review's text with `--outside-in-body`), `inBody[]` (`path`, `line`: the ones put in the review's text), `existing` and `reason` (a review with this text is already there), `posted`. |
| `reply --repo <r> --number <n> --comment <id> --body <t>` (`reply`) | A reply in a review thread. `--comment` may be any comment of the thread: the reply goes to its first comment. A comment of another PR is refused. The same text already in the thread from the pipeline's login is not posted again. | `replied`, `id`, `thread` (the first comment's id), `posted`. |
| `suggest --repo <r> --number <n> --comment <id> --replacement <t> [--body <t>]` (`suggest`) | A reply whose text is the optional note and a `suggestion` block with the replacement (the fence is longer than any backticks inside it). Replaces the lines the thread's first comment is on. | as `reply`. |
| `comment --repo <r> --number <n> --body <t> [--unless-header <h> [--since <time>]]` (`comment`) | A comment in the PR's conversation. `--unless-header` skips it when a comment (since the time) already starts with the header, both read without `commentHeader`; a header that is `commentHeader` alone is refused (`empty`). | `commented`, `id`, `existing`, `posted`. |
| `add-label --repo <r> --number <n> --label <name>`, `remove-label …` (`addLabel`, `removeLabel`) | One label, under the label rules above. One the PR has (or lacks) is a no-op. | `label`, `changed`, `created` (the ready or translated label was made on the repository), `reason`. |
| `resolve-thread --repo <r> --number <n> --comment <id> --own <id>...` (`resolveThread`) | Settles the review thread that the pipeline's comment `<id>` opened (a place to check, once confirmed or its block deleted). Refused (`notOwn`) unless `<id>` is among `--own` (the caller's posted ids), the settings have `forge.self` and `commentHeader`, it is the thread's **first** comment, and that comment was written from `forge.self` with the header in front: a person's thread, or one the pipeline only replied in, is never settled. A thread already settled is a no-op. | `comment`, `thread` (its GraphQL id), `resolved`, `reason`, `posted: []`. |
| `delete-comment --repo <r> --number <n> --comment <id> --own <id>...` (`deleteComment`) | Removes one conversation comment of the PR that the pipeline posted and a newer one replaces (an older summary). Refused (`notOwn`) unless `<id>` is among `--own`, the settings have `forge.self` and `commentHeader`, and the comment was written from `forge.self` with the header in front; one on another PR is `unknown`. A line comment or a review is never removed (a submitted review can't be). A comment already gone is the forge's 404 (exit 1, `status: 404`): the caller warns and posts nothing again. | `comment`, `deleted`, `posted: []`. |
| `set-stage-label --target <id> --number <n> --stage inProgress\|review\|finalReview\|translation [--repo <r>]` (`setStageLabel`) | The PR's stage label follows the card. Adds the target's label for the stage and removes the target's other stage labels the PR has, **in one request**. It reads the PR's labels as they are, so it does not matter who moved the card, or who set the old label: a person's move is followed like the pipeline's own. A stage the target names no label for is refused (`notNamed`). Labels outside the target's stage labels (the owner's, `checkLabel`, another target's) are not touched. The repository comes from the target; `--repo` must match it. | `target`, `stage`, `label`, `added[]`, `removed[]`, `changed`. |

## Status marks (`markComment`)

The ticket flow's runner shows on a comment whether the pipeline took it and how that ended, with a reaction of its own (`scripts/ticket-state/README.md`, "Reactions as status"). The module call is `markComment({ repo, number, kind, id, mark })`: `kind` is `comment` (a conversation comment), `review-comment` (a line comment) or `review` (a submitted review), `id` its numeric id, and `mark` one of `MARKS`: `seen` (👀, picked up), `applied` (🚀) or `asked` (😕, asked back or not done). It puts `forge.self`'s reaction for the mark when there is none yet, and takes off `forge.self`'s reactions for the other two marks, in one request; a mark already there is no request. Another login's reaction, and one of `forge.self`'s that stands for no mark (a ❤), stay. Refused (`notOwn`) with no `forge.self` in the settings, and (`unknown`) for a comment on another PR, another kind or another mark. It has no CLI command: a role never sets one. On GitHub every reaction is read and written through GraphQL by the subject's node id (REST has none for a review), and `removeReaction` takes off only the caller's own; the node id of a comment or a line comment comes from its REST record, a review's from the PR's reviews. Returns `added[]`, `removed[]`, `changed`, `posted: []`.

## Line comments (`review-on-lines`)

- **A review can only comment.** The event is fixed to `COMMENT` in the adapter; the interface has no other.
- **A comment on a line outside the PR's diff cannot be posted.** Checked on a real PR (see the task's evidence): GitHub answers `422 Line could not be resolved` and rejects the **whole** review, comments inside the diff included; nothing is posted. The module therefore reads the PR's diff first and refuses (`outsideDiff`, with the list in `outside`) before anything is sent. With `--drop-outside` it posts the comments inside the diff and lists the others in `outside`: they stay in the PR description. A context line next to a change counts as inside; a file with no diff text (an image) is left to GitHub.
- **`--outside-in-body`** keeps those comments instead: their texts go into the review's own text, each as `` `path:line` `` and then its text, after `--body`, and the lines inside the diff are posted as usual (`inBody` lists them). Nothing the caller wrote is lost. Give one of `--drop-outside` and `--outside-in-body`.
- **A review with a text of its own may hold no line comment** (`[]` in the file, or every comment kept in its text): a round whose changes need none. It is posted once: a review of `forge.self` on the PR with the same text (read without `commentHeader`) is not posted again (`existing`).
- **`--commit` must be the PR's head**, else `stale`: the diff read is the head's.
- **`--skip-diff-check`** sends the comments as they are and reports GitHub's answer; for checking GitHub, not for the pipeline.
- **Retries are safe.** A comment already on the PR with the same path, line and text (read without `commentHeader`) is not posted again (`skipped`). Each comment's id is matched to the one GitHub made by path, line and the text sent.

## Suggested changes (`suggest`)

A reply in a review thread with a `suggestion` block is rendered by GitHub as a "Suggested change" (checked on a real PR: the reply's HTML has the same suggestion markup as a top-level comment's, and the pull request page shows it so). Whether the "Commit suggestion" button appears for it was not observed: it did not show for a top-level suggestion on the same page either (the PR was a draft, viewed by its author), so applicability stays unverified.

## Options

| Flag | |
|---|---|
| `--root <dir>` | The host repo (default: the working folder). The settings are read from it. |
| `--settings <file>` | The settings file (see Settings). |
| `--dry-run` | Reads still run; every change is printed in `calls[]` (`method`, `path`, `body`) and not sent. A created PR has number `0`, other ids `dry-run-N`. The output has `"dryRun": true`. |
| `--repo <r>` | A repository a target names: its name, or `owner/name`. |
| `--number <n>`, `--head <branch>`, `--base <branch>`, `--commit <sha>`, `--comment <id>` | A PR number, a branch, the commit a review's lines refer to, a review comment's id. |
| `--title <t>`, `--body <t>`, `--body-file <file\|->`, `--replacement <t>`, `--replacement-file <file\|->` | Texts; a file, or `-` for standard input. Sent exactly: nothing is trimmed, added or appended (no footer, no tool name, no trailer), U+200C kept, but for `commentHeader` in front of a comment, reply, suggestion or line comment. Give one of the two. |
| `--assignee <login>`, `--reviewer <login>` (repeatable), `--label <name>` (repeatable for `open-pr`), `--draft` | `open-pr`, `request-reviewers`, `add-label`, `remove-label`. |
| `--since <time>`, `--types <a,b>` | An ISO time; the event types of `events-since`. |
| `--comments-file <file\|->`, `--drop-outside`, `--outside-in-body`, `--skip-diff-check` | `review-on-lines`. |
| `--own <id>` | An id the caller posted (repeatable, or several split by commas): `resolve-thread` and `delete-comment` act only on one of these. |
| `--unless-header <h>` | `comment`. |
| `--target <id>`, `--stage <stage>` | `set-stage-label`. |
| `-h`, `--help` | Usage. |

## Exit codes

`0` ok · `1` a call to the forge failed (`gh` did not run, a network error, an HTTP status that is not handled; the JSON has `error`, `call` and `status`) · `2` bad usage, a missing or invalid setting, or a refusal. On `1` and `2` stdout holds `{"ok": false, "error": …}` and the message goes to stderr.

A refusal has `refused` in the JSON: `notAllowed` (a repository or login the settings do not name), `notNamed` (a label the settings do not name, or one the module never removes), `empty` (an empty title, description, comment, reply or replacement, or a line comment without a path, line or text), `unknown` (a target, stage, PR, label or comment that is not there, or a comment on another PR), `outsideDiff`, `stale`, `notOwn` (a thread or a comment that is not the pipeline's own: not among `--own`, not from `forge.self`, without the comment header, a thread it did not open).

## Rules the module holds

- **Only what the settings name:** repositories, logins, labels (see Settings). The merge-ready label of the owner is in no target's `labels`, so no operation can set it, and a test tries every operation to show that no request adds a label the settings do not name.
- **No operation to withdraw a review, give a verdict, join a branch into its base, close a PR or delete a branch, and none that touches a person's thread or comment.** The adapter interface has none and a caller cannot add one; `OPERATIONS` in `lib/forge.mjs` lists the seventeen there are. Two act on what the pipeline posted, and only on that: `resolveThread` settles a thread the pipeline's own comment opened, and `deleteComment` removes a conversation comment the pipeline posted, each after the module checked the id is among the caller's own, the author is `forge.self` and the text starts with `commentHeader` (the pipeline posts from the owner's login, so the login alone tells nothing). `markComment` takes off only `forge.self`'s own reactions of the three marks, through GraphQL's `removeReaction`, which can remove no one else's. The checks: a test lists the module's and the adapter's methods; a test greps the source for the API calls that would do any of the rest (`grep -rniE 'unresolveReviewThread|dismiss|approve|mergePullRequest|closePullRequest|deleteRef|git/refs|/merge' lib adapters forge.mjs` finds nothing), and finds `resolveReviewThread` once, in the GitHub adapter, and one `DELETE`, of `issues/comments/<id>`; a test runs every operation and checks every request it sent; the only review event in the source is `COMMENT`; and the CLI has no other such command.
- **Back-off.** HTTP 429, and 403 that names a rate limit, are retried after 2, 4 and 8 s; the fourth answer is reported (exit 1). No other failure is retried. A failure after a PR was made says which PR exists.
- **Idempotent writes.** An open PR of the head, a label already there (or gone), the same title and description, a comment with a header already posted, a reply already in the thread, a line comment already on the PR, a review text already posted, a thread already settled change nothing and say so.
- **One write function.** Every change goes through `write` in `adapters/github/gh.mjs`, which `--dry-run` stops. A GraphQL read refuses a document that changes anything.
- **No credentials handled.** `gh` brings its own login. Request bodies go to `gh` on standard input, never on a command line. The module never reads, prints, logs or writes a token, and cleans every message of `GH_TOKEN` / `GITHUB_TOKEN` values and of anything shaped like a GitHub token.
- **Texts go out as given,** under the account `gh` is logged in as. The module adds nothing to them but the settings' `commentHeader` in front of a comment, reply, suggestion or line comment, so the team sees which comments the pipeline posted from the owner's account. What the team may read (no tool names, no trailers) is the caller's text.
- **The watcher keeps the cursor,** not this module: `events-since`, `changed-prs-since` and `pr-activity` take the time and give what is newer; a window that overlaps the last check is the caller's to drop duplicates from (by `id`).

## Files

| | |
|---|---|
| `forge.mjs` | The CLI. |
| `lib/forge.mjs` | The module: settings-bound rules, the checks, the operations. |
| `lib/adapter-contract.mjs` | What an adapter must provide. |
| `lib/settings.mjs` | Reading and checking the `forge` object and the `targets`. |
| `lib/errors.mjs` | `Refusal`, `ForgeError` and the CLI error. |
| `adapters/index.mjs` | The adapters by `kind`. |
| `adapters/github/index.mjs`, `adapters/github/gh.mjs` | The GitHub adapter, and its one process module (`gh api`). |
| `test/` | The tests, a stand-in `gh` (`fake-gh.mjs`, `gh-stand-in.mjs`) and its invented answers (`test/fixtures/`), the in-memory adapter. |

## Limits

- GraphQL connections are read 50 to 100 at a time without a ceiling short of 100 pages; a review thread with more than 100 comments is marked `truncated`.
- `events-since` reads at most 100 pages of 100 events; `truncated` says the ceiling was reached. GitHub keeps only recent events for a repository.
- `prActivity` reads every review, thread and comment of the PR and filters by time itself: GraphQL has no `since`.
- A label change reads the repository's labels (100 at a time) to find the ids.
- A comment on a line of a deleted file, or on the old side of a change, is not supported: lines are on the new side.
