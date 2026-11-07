# tracker

The tracker of a docs pipeline, in statuses and transitions: list the cards in a status, read a card, find a card, follow the board's actions, download an attachment, comment, move a card, add and remove labels, add a person the settings name to a card, set a description, create a card in the intake status. Node, no dependencies. No AI is involved: a pipeline step, or a watcher that runs no model, calls it instead of composing REST calls by hand.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/tracker/tracker.mjs <command> [<card>] [options]
```

Run it from the host repo (or pass `--root`). Needs Node 18.3+. Tests: `npm test` in this folder (offline: a stand-in Trello server on `127.0.0.1` that serves invented responses in Trello's shape, and an in-memory adapter).

The toolkit speaks in **statuses** (`intake`, `ready`, `inProgress`, `done`, …). The host's settings map each status to the tracker's own places: lists on a Trello board, workflow statuses in Jira. The **Trello adapter** is the only code that knows Trello. A Jira adapter is a new folder under `adapters/` with the methods in `lib/adapter-contract.mjs` and one line in `adapters/index.mjs`; no caller changes.

## Settings

The host's ticket flow settings file holds the `tracker` object. Its place is the first of: `--settings <file>`, the `Ticket flow settings:` field of the `Documentation toolkit configuration` block of `<root>/CLAUDE.md` (registered in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Ticket flow settings"), `.claude/ticket-flow.json`. A file named `<name>.local.json` next to it (`.claude/ticket-flow.local.json`) is merged over it: objects key by key, anything else replaced. The `tracker` object is read here, and each target's `cardMembers` (the `targets` list).

```json
{
  "tracker": {
    "kind": "trello",
    "credentials": { "envFile": ".env", "key": "TRACKER_API_KEY", "token": "TRACKER_API_TOKEN" },
    "board": "<board id>",
    "watchBoards": ["<board id>"],
    "statuses": {
      "intake": ["Incoming"], "drafts": ["Parked"], "ready": ["To do"], "inProgress": ["In progress"],
      "blocked": ["Blocked"], "done": ["Done", "Closed*"]
    },
    "neverRead": ["drafts"],
    "transitions": [["intake", "ready"], ["ready", "inProgress"], ["inProgress", "blocked"], ["blocked", "inProgress"], ["inProgress", "done"]],
    "labels": { "needsAnswer": "needs answer" },
    "priority": { "high": "high", "low": "low" },
    "owner": "owner-one"
  },
  "targets": [{ "id": "guide", "cardMembers": ["expert-one"] }]
}
```

| Key | | |
|---|---|---|
| `kind` | required | The adapter: `trello`. |
| `board` | required | The board the statuses are on. |
| `watchBoards` | no | Other boards the module may read (`find-cards`, `actions-since`). It never moves or writes on them. |
| `statuses` | required | `{ status: [list names] }`. The status names are the host's, except `intake`, which `create-card` needs. A name may end or contain `*` (`Closed*`). |
| `neverRead` | no | Statuses the module never reads: `list-cards` refuses them, `read-card` and `download-attachment` refuse a card in one, `actions-since` leaves out the actions on such a card. |
| `transitions` | no | The `[from, to]` pairs `move` may run. Both must be in `statuses`. A pair that is not listed is refused. |
| `labels` | no | `{ short key: label name }`: `add-label` and `remove-label` accept the key in place of the name. |
| `priority` | no | The labels that mark a card's priority: `{ "high": <label name>, "low": <label name> }`, default `high` and `low`. A card with neither is `medium`; one with both is `high`. Names are compared without case and spacing. A tracker with a priority field of its own (Jira) gives it through the adapter, and that wins. |
| `owner` | no | The owner's username on the tracker. `add-member --member owner` adds this person. |
| `targets[].cardMembers` | no | Per target, the usernames on the tracker added to a card when a person calls the expert review (the ticket flow). |
| `credentials` | required | The names of the two environment variables that hold the API key and token, and the file that may hold them (default `.env`, relative to the root). The environment wins over the file. The values are never printed, logged or written; a missing one is reported by its variable name. |

**Lists are resolved on every run.** The board's open lists are read once per run and each status name is matched to them: ignoring case, spacing and U+200C; `*` matches any run of characters; an exact name claims a list before a pattern does, and a list belongs to the first status that claims it. A name that matches no list **stops the run** (exit 2, `unresolved`: the status and the name). Lists no status owns are outside the flow: `statuses` shows them as `unmapped`, `move` will not move a card out of one, and a card in one has `status: null`.

**People are resolved the same way.** When the settings name anyone (`owner`, `cardMembers`), the board's members are read once per run with the lists, and each name is matched to a member's username, without case or a leading `@`. A name that matches no member **stops the run** (exit 2, `unresolvedMembers`: the name and where the settings name it). With no one named, the members are never read.

**Moving into a status** goes to the first name of the status that has no `*`: `done: ["Done", "Closed*"]` means the Done list, never a `Closed…` list. A card standing in a `Closed…` list has the status `done`. A status whose names are all patterns has no list to move into, and `move` refuses it.

## Commands

All print JSON on stdout: `{ "ok": true, "command": …, … }`. `<card>` is a card's id, its short link or its URL; anything else is refused before a request is made.

| Command | Does | Output |
|---|---|---|
| `statuses` | Resolves the settings' statuses to the board's lists, and the people the settings name to the board's members. | `board`, `statuses[]` (`status`, `names`, `lists`, `target`, `neverRead`), `unmapped[]` (lists no status owns), `transitions`, and with people named `members[]` (`name`, `where`, `id`, `username`). |
| `list-cards --status <s>` | The open cards of the status, from every list of it. **Refuses a `neverRead` status** (`refused: "neverRead"`) without asking for its cards. | `status`, `lists[]`, `count`, `cards[]` (a card is below). |
| `list-cards --board <id> --list <name>` | The open cards of a list on a **watched** board, by the list's name (`*` allowed). The board in the settings is refused (`notAllowed`): it is read by status, so its `neverRead` lists stay unread. | `board`, `lists[]`, `count`, `cards[]` (`status` is `null`). |
| `read-card <card>` | One card with what hangs on it. Refuses a card in a `neverRead` status. | A card, plus `comments[]`, `attachments[]`, `checklists[]`, `moves[]`, `links[]`. |
| `find-cards --number <n>` | Cards whose name starts with `#<n>` (the first number of the name is the card's own; copies carry two), **archived too**, on `--board <id>` (repeatable) or the board. `--all-boards` searches the board and the watched ones. | `query`, `count`, `cards[]`: a card without `desc` (a card in a `neverRead` status is found by its name, its text is not returned). |
| `find-cards --link <url>` | The card behind a card URL or short link, wherever it is and archived too. A link to nothing finds nothing (`count: 0`). | as above |
| `actions-since --since <time>` | The board's actions since an ISO time, **oldest first**, paged by `before`. `--types a,b` is Trello's action filter. `--board <id>` names the board or a watched one. The module keeps no cursor: the caller passes the time. | `board`, `since`, `count`, `skippedNeverRead`, `actions[]`. |
| `download-attachment <card> --attachment <id\|name> --out <file>` | Saves an uploaded file. A name that fits two attachments is refused (`ambiguous`: give the id); a link is not downloaded; an existing file is not replaced without `--overwrite`; the folder must exist. In a role session (the runner sets `DOC_TOOLKIT_ROLE_SESSION` and `DOC_TOOLKIT_DOWNLOAD_DIRS`), `--out` goes only in the ticket's work folder or the flow's `tmp/`, compared as real paths, and never through a link. | `card`, `attachment` (`id`, `name`, `mimeType`, `bytes`), `path`, `bytes`, `warning` if the size differs from the card's. |
| `comment <card> --text <t>` | Adds a comment. An empty text (or U+200C and spaces only) is refused (`empty`). `--unless-header <h> [--since <time>]` skips it when the card already has a comment, since the time, that starts with the header. | `card`, `commented`, `id`, `time`; when skipped, `reason` and `existing`. |
| `move <card> --to <status>` | Moves the card to the top of the status's first named list, **only if (from, to) is in `transitions`**. The card's own status is read from its list. | `card`, `moved`, `from`, `to`, `list`. A card already in that list: `moved: false`. |
| `add-label <card> --label <name>`, `remove-label <card> --label <name>` | By label name on the card's board, or a key of `labels`. A label the card has (or hasn't) is a no-op. An unknown name is refused; two labels with the same name are `ambiguous`, unless one matches exactly. | `card`, `label`, `changed`, `reason`. |
| `add-member <card> --member <name>` | Adds a person the settings name to the card: `owner` stands for `owner`, any other name must be the owner or one of the targets' `cardMembers` (else `notAllowed`). A person already on the card is a no-op. An archived card is refused. There is no command that removes anyone. | `card`, `member` (the username), `changed`, `reason`. |
| `set-description <card> --text <t>` | Replaces the description. **An empty text is refused** (`empty`). The same text is a no-op. | `card`, `changed`. |
| `create-card --status intake --name <n> [--desc <t>] [--label <name>]...` | Creates a card at the bottom of the `intake` status's first named list. **Any other status is refused** (`intake`). | `id`, `shortLink`, `url`, `status`, `list`, `labels`. |

**A card** (`list-cards`, `read-card`, `find-cards`): `id`, `shortLink`, `url`, `name`, `number` (the first `#NNNN` of the name or `null`), `numbers` (all of them), `desc` (not in `find-cards`), `labels[]` (`id`, `name`, `color`), `priority` (`high`, `medium` or `low`, see `priority` in Settings), `lastActivity` (the card's last activity time, ISO), `createdAt` (when the card was made, ISO; Trello's id carries it), `closed` (archived), `memberIds` (the ids of the people on the card; empty in `find-cards --number`), `boardId`, `status` (the card's status, or `null` outside the flow or on another board), `list` (`id`, `name`; `name` is `null` on a board the settings don't map).

**`read-card` also gives:** `comments[]` (`id`, `author` (`id`, `username`), `time`, `text`, `edited`), oldest first and all of them, paged; `attachments[]` (`id`, `name`, `url`, `mimeType`, `bytes`, `isUpload`, `date`); `checklists[]` (`id`, `name`, `items[]` with `id`, `name`, `state`); `moves[]` (`time`, `from`, `to`, each with `id`, `name`, `status`), the card's moves between lists, oldest first; `links[]` (`shortLink`, `url`, `in`: where it was found, `description`, `comment`, `checklist` or `attachment`), the links to other cards, its own excluded. Following a link is the caller's job.

**An action** (`actions-since`): `id`, `type`, `time`, `card` (`id`, `shortLink`, `name`), `by` (`id`, `username`), `text` (the comment, label or attachment name), `changed` (the fields an update changed, such as `desc`), `closed` (`true` when the action archived the card, `false` when it restored it; absent otherwise), `list` (the card's list at the time), `status`, `listBefore` and `listAfter` (a move), `statusBefore` and `statusAfter`. The statuses are filled for the board in the settings only.

## Options

| Flag | |
|---|---|
| `--root <dir>` | The host repo (default: the working folder). The settings and the credentials file are read from it. |
| `--settings <file>` | The settings file (see Settings). |
| `--dry-run` | Reads still run; every change is printed in `calls[]` (`method`, `path`, `form`, secrets removed) and not sent. It gets a fake id (`dry-run-N`). The output has `"dryRun": true`. |
| `--status <s>`, `--to <s>` | A status of the settings. |
| `--number <n>`, `--link <url>`, `--board <id>`, `--all-boards` | `find-cards` and `actions-since`. A board must be the board or a watched board in the settings. |
| `--list <name>` | `list-cards` on a watched board (with one `--board`). |
| `--since <time>`, `--types <a,b>` | `actions-since` (and the window of `comment --unless-header`). |
| `--attachment <id\|name>`, `--out <file>`, `--overwrite` | `download-attachment`. |
| `--text <t>`, `--text-file <file\|->` | The text of a comment or description; `-` is standard input. Stored exactly, U+200C kept, nothing trimmed. Give one of the two. |
| `--desc <t>`, `--desc-file <file\|->`, `--name <n>`, `--label <name>` (repeatable) | `create-card`. |
| `--unless-header <h>` | `comment`: skip when a comment already starts with this header. |
| `--member <name>` | `add-member`: a username the settings name, or `owner`. |
| `--origin <url>` | The tracker's API origin; `https` unless it is this computer. It sends the key and token there, so it works only with `DOC_TOOLKIT_TRACKER_TEST` set, which the tests do and a role session never inherits. |
| `-h`, `--help` | Usage. |

## Exit codes

`0` ok · `1` a call to the tracker failed (a network error, or an HTTP status that is not handled; the JSON has `error`, `call` and `status`) · `2` bad usage (an unknown command too, as in the `forge` script), a missing or invalid setting, a missing credential, an unresolved list name, or a refusal. On `1` and `2` stdout holds `{"ok": false, "error": …}` and the message goes to stderr.

A refusal has `refused` in the JSON: `neverRead` (a read of a status the settings never read), `transition` (a move the settings do not list), `intake` (a card created outside intake), `empty` (an empty comment, description or name), `outsideFlow` (a card in a list no status owns, or on another board), `archived`, `notAllowed` (a board the settings don't name, a file that exists, a person the settings don't name), `ambiguous`, `unknown` (a status, label, attachment or card reference that is not one).

## Rules the module holds

- **Back-off.** HTTP 429 is retried after 2, 4 and 8 s, three times, as the hub does; the fourth answer is reported (exit 1). No other failure is retried. Trello's limit is 100 requests per 10 s per token.
- **Order of writes on one card** is the caller's: comment, then labels, then move. If the comment fails, nothing else happens for that card.
- **Idempotent writes.** A move to the list the card is in, a label already there (or already gone), a person already on the card, the same description, and a comment with a header already posted (`--unless-header`) change nothing and say so.
- **U+200C** (the zero-width non-joiner the hub uses as an empty-line filler) is kept in everything sent and stripped only to compare or to find a text empty.
- **Never archive, delete or rename, never remove anyone.** There is no operation for it: the adapter interface has none, and a test lists every write the module can make.
- **One write function.** Every change goes through `write` in `adapters/trello/client.mjs`, which `--dry-run` stops. The credentials go in an `Authorization` header (and, on POST and PUT, in the form body, as the hub's copy script does), never in a URL, and every message is cleaned of them before it leaves. An attachment download sends them only to Trello's own hosts.
- **The watcher keeps the cursor**, not this module: `actions-since` takes the time and gives the actions; a window that overlaps the last check is the caller's to drop duplicates from (by `id`).

## The adapter interface

`lib/tracker.mjs` owns every decision (statuses, the guards, the idempotency checks) and calls an adapter for the tracker's own API. `lib/adapter-contract.mjs` lists the calls and the shapes they return; `assertAdapter` checks an adapter has them all. The tests run the module over an in-memory adapter to show that nothing above the interface knows Trello. For Jira: statuses are workflow statuses, `move` runs the transition into the status, `actions-since` is a JQL `updated >=` search with the changelog.

## Files

| | |
|---|---|
| `tracker.mjs` | The CLI. |
| `lib/tracker.mjs` | The module: statuses, guards, operations. |
| `lib/adapter-contract.mjs` | What an adapter must provide. |
| `lib/settings.mjs` | Reading and checking the settings, the credentials. |
| `lib/errors.mjs` | `Refusal`, `TrackerError` and the CLI error. |
| `adapters/index.mjs` | The adapters by `kind`. |
| `adapters/trello/index.mjs`, `adapters/trello/client.mjs` | The Trello adapter, and its one network module. |
| `test/` | The tests, a stand-in Trello server and its invented responses (`test/fixtures/`), the in-memory adapter. |

## Limits

- `find-cards --number` reads every card of the board, archived included, a page of 1000 at a time; on a large board it is several requests.
- Trello returns up to 1000 actions per page; `actions-since` pages until a short page, with a ceiling of 200 pages.
- A card's own status is read from its list; a card on a watched board has none.
- Reading needs the board's lists, so each run makes one request for them before the operation's own.
