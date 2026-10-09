---
name: ui-labels
description: Shared procedure for the UI label check that runs at the start of a docs task. It checks whether the app's UI strings changed, re-imports them, patches renamed labels across all languages on the current branch, and shows how writers look up exact UA labels. Referenced by doc-page-updater, the three *-writer skills and locale-translator. Never copied.
---

# UI label check

A docs repo that declares a `UI label source:` keeps a snapshot of the app's UI strings, the **label store** (`<state root>/ui-labels/`). Before a docs task works with UI labels, the snapshot must match the app, and every label the app renamed must already be patched in the docs. This file is the procedure. The script is `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-labels/ui-labels.mjs`, and its `README.md` documents every flag and output field. Everything here is scripted; no model is involved.

A skill points here with one line at the start of its workflow:

> Run the UI label check in `${CLAUDE_PLUGIN_ROOT}/context/ui-labels.md` before anything else.

## When it runs

- At the start of `doc-page-updater`, `user-guide-writer`, `concept-doc-writer` and `api-doc-writer`, when the user shares a ticket or a change to document.
- At the start of every `locale-translator` run.

Review, fix, alignment and UA → EN translation skills don't run it.

## Required or best-effort

| Situation | `locale-translator` | Writer and updater skills |
|---|---|---|
| No `UI label source:` declared | Ask once and offer to persist the answer (`${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`). | Skip this procedure without comment: the project keeps no label store. |
| `check` or `import` fails (exit `1`: network, `gh` auth, a locale file that doesn't parse or covers under 80% of the EN keys) | Stop. A translation never runs on an unchecked snapshot. | Report the error in one line and continue with the existing snapshot. |
| `sync` leaves the diff pending (`pendingRemains`) | Stop until it is resolved (step 4). | Report it and continue. |
| `sync` patched pages or categories (`suggestedCommit` lists paths outside the label store) | Stop: the user commits the sync first (step 6). | Continue. |

## Procedure

Run every command from the docs repo root. Pass `--ticket <n>` when the user shared a ticket whose number doesn't start the current branch name. Otherwise the script reads the ticket from the branch (`1163-…` → `1163`) and adds that ticket's frontend branches as an overlay.

1. **Check.** Run `ui-labels.mjs check`.
   - Exit `0`: the snapshot is current and nothing is pending. Continue the task. The rest of this file doesn't apply.
   - Exit `10`: something changed or a diff is pending (`reasons`, `pendingSync`). Go to step 2.
   - Exit `2`: a declaration is missing, or a docs locale matches no locale file or several. Ask once for the fields in `missing`, or for the mapping of the locales in `unresolved` (show their `candidates`). Offer to persist the answer in the `CLAUDE.md` configuration block, then run `check` again. Never pick a candidate yourself.
   - Exit `1`: see the table above.
2. **Drain an earlier diff.** If `pendingSync` is `false`, go to step 3. If it is `true`, run step 4 first, because `import` refuses to run (exit `3`) while a diff is unsynced, so a diff is never lost. Then run `check` again: exit `0` → step 5, exit `10` → step 3.
3. **Import.** Run `ui-labels.mjs import`. It writes the new snapshot, the ticket overlay and the diff for `sync`. On exit `1` the previous snapshot is untouched: see the table above.
4. **Sync.** Run `ui-labels.mjs sync`, without `--commit`: commits in the docs repo are the user's. For every page and sidebar category bound to a changed or rekeyed key, it patches the bold label in UA, EN and every locale on the current branch, and advances the state, so the patch doesn't trigger a re-translation once it is committed. The changes stay in the working tree. `suggestedCommit` gives the commit for the user to make: the message (`Sync UI labels to <repo>@<sha7>`) and the changed paths. After an import with no diff to sync (`status: nothing-to-sync`, a first import for example), it lists the new snapshot alone.
   - A page with uncommitted changes isn't patched (`skipped`), and the diff stays pending (`pendingRemains`). Ask the user to commit or stash those files, then run `sync` again. Never commit or stash them yourself.
5. **Show the report** before the task continues:
   - **Patched:** the `uk` and `en` entries (page, old → new, line), which the PR reviewer checks, plus the number of locale entries. Read each patched `uk` line. If the label's grammar in the sentence depends on it (case, agreement), name that block for a fix, because `sync` patched it verbatim.
   - **For a writer to decide** (nothing was changed): `checkBinding` (a page bound to a sibling key still shows the old string), `markupParts` (a menu path or other markup span contains a renamed string), `broken` (a bound key was removed from the app), and `unpatched`. Give the page and key for each.
   - **For information:** `undocumented` (new UI text that no page documents yet), `renamedEntries` and `skipped`.
   - **The commit to make:** `suggestedCommit`, its message and paths, as one block the user can run (`git add -- <paths>` and `git commit -m "<message>"`). Don't run it yourself.
6. **Continue the task**, unless the table above says stop. The sync commit belongs on the current branch, separate from the rest of the work, and goes through the PR with it.
   - **Why `locale-translator` stops after patching pages:** the translation reads committed UA only, while `sync` already advanced the locale state to the patched UA text. Until the user commits the sync, every patched page looks stale against a version that isn't in the repository and would be re-translated in full from the old text. After the commit, run the task again; the check then passes.
   - A changed snapshot alone (only label-store paths in `suggestedCommit`) doesn't block anything: the scripts read the label store from the working tree. List its commit in the task's report.

## Looking up labels while writing

A writer takes a UI label from the store, not from a screenshot:

- `ui-labels.mjs lookup "<UA text>"` shows whether the string is a label, with its key and its string in each locale (`--locales tr,kk` to choose).
- `ui-labels.mjs lookup --search "<text>"` searches keys and UA and EN strings, to find the exact wording of a control.

A match is written verbatim in bold. No match means the text is not in the app's dictionaries: it may be server text, a hardcoded string, or a paraphrase. Writers don't edit the page state's `spans`. Binding a span to a key is the job of `locale-translator`'s binding pass.

## What this procedure never does

- Edit the app's locale files, or anything outside the docs repo.
- Translate, classify or bind a span. That is `locale-translator`'s job.
- Delete a page, a key or a state file.
- Push.
