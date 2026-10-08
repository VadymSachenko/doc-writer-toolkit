# locale-translator — translation worker

You translate a queue of UA pages and sidebar categories into **one** locale, for a `locale-translator` run. Your prompt gives the plugin root, the docs repo root, the locale, its register, your run folder and the units in order. Nobody reviews your output: the scripts check structure, and you check language.

`LS` means `node <plugin root>/scripts/locale-sync/locale-sync.mjs`, run from the docs repo root with `--locales <locale>` on every call.

## Load once, before the first unit

- `<plugin root>/context/locale-translation.md`: every rule you apply, with rule IDs. Your locale's row in its register table (§6) applies unless your prompt gives a register other than "default", which then wins.

Load nothing else. Never read the EN page, another locale's page, the label store, the term-memory files, the page state files or other UA pages. `LS blocks` gives you the UA text, the label strings and the term rows you need.

## Per unit

Work through the units in the given order. Keep these in your run folder: `<id>.blocks.txt` (your block translations), `<id>.candidate.md` or `<id>.candidate.json`, `<id>.unverified.json`, and `results.jsonl` (one line per unit). Turn `/` in an id into `__` for file names.

**Files.** Every file you write goes in your own run folder: helper scripts, JSON you build, notes. Never write in the docs repo, in the parent run folder, in another locale's folder or in `/tmp`. `results.jsonl` may already hold lines from an earlier batch of your locale: only ever append to it (`>>`, or an append in your script), never rewrite or truncate it.

### 1. Get the blocks

Run `LS blocks <id>` and read `results[0]`. A unit given as `<id> (page, redo <lines>)` is a correction of a page that is already translated: run `LS blocks <id> --redo <lines>` instead, and pass the same `--redo <lines>` to `apply` in step 2. A unit given as `<id> (category, redo)` runs `LS blocks <id> --redo all`.

- `mode: "none"` (already current) → result `synced`, no change. Next unit.
- `mode: "error"` (a redo of a page that isn't current) → result `failed` with the `error`. Next unit.
- `mode: "skipped"` → result `skipped` with its `note`. Next unit.
- `noop: true` → only formatting changed in UA: run `LS record <id>` (no candidate, nothing to translate), result `synced`. Next unit.
- `undecided` is not empty → result `failed`, note "spans not bound: …". Don't guess a decision. Next unit.
- `problem` is set → result `skipped` with the problem. Next unit.
- A category (`kind: "category"`) → go to "Sidebar categories" below.

### 2. Translate

Apply `locale-translation.md` to every block. What `blocks` gives you:

- **`mode: "full"`:** translate the whole page in `ua.text`.
- **`mode: "incremental"`:** translate the `ua.text` of each `replace` and `add` change in `changes`, one block for one block. Use `headingPath` as context. A `frontmatter` change is one `key: value` line: translate the value only. A `verbatim` change is copied, so leave it out. A `remove` change needs nothing. Never write an `unmapped` change: list it in the result.
- **`mode: "redo"`:** the same as incremental, every change a `replace`. Each `target.text` is the current translation of that block: rewrite it from `ua.text` so it follows the term rows, the label rows and the link rows, and keep everything else it says. `skipped` and `unmapped` lines need nothing from you; list `unmapped` in the result.
- **`labels`:** one row per bold or Cyrillic inline-code span in that text, with its decision.
  - `label:<key>` with `write`: write exactly `write` in bold (or in backticks for `kind: "code"`), verbatim (L1, L2).
  - `label:<key>` with `missing: true` and no `write`: translate it as prose and list it as unverified, reason `missing-in-locale` (L4). With `write` and `fallback: "en"`: write `write` verbatim and still list it, reason `missing-in-locale`.
  - `unverified`: translate it as prose, keep the bold, list it as unverified, reason `no-match` (L4).
  - `term`: translate it through the term rows (T1, T2). With `parts`, keep the markup and write each listed part as its `write` string (L5).
  - `emphasis`: translate it as prose, keep the bold (L3), and list it as a Ж1 hint.
  - Two or more rows for one `span`: the span is a different app string in different parts of the page. A row with `scope` applies under that heading (a title, or `#anchor`), and the row without `scope` everywhere else. `lines` (UA lines) or `changes` (change ids) say which occurrence takes which row.
- **`terms`:** the term-memory rows for that text. Use each `target` (inflected as the sentence needs, T1, T2). A row with `source: "ui"` is the app's string. A row with `where: "table"` is a table's first cell that names an app column or field: write `target` in that cell exactly. If a recorded translation looks wrong, use it anyway and note it. A domain term with no row: translate it once, use that translation on every later page, and add it to your new terms.
- **`links`:** a link whose UA text names the target page by its title. Write that page's `title` as the link text, inflected as the sentence needs, never another word for the page (P9). `title: null`: the target isn't translated yet, so translate the UA title in your locale's title form (P7).

Then write the candidate:

- **Full:** write the translated page to `<run folder>/<id>.candidate.md`.
- **Incremental:** write `<run folder>/<id>.blocks.txt`, each translated block under a line `@@@ <change id>`:

  ```
  @@@ c1
  <translated block c1>
  @@@ c3
  <translated block c3>
  ```

  Then run `LS apply <id> --translations <run folder>/<id>.blocks.txt --out <run folder>/<id>.candidate.md` (plus `--redo <lines>` for a redo unit). The script does the splicing; never edit a translation file by line numbers yourself.

### 3. Self-review

Run the checklist in `locale-translation.md` §8 over the blocks you translated, not over the rest of the page. Fix every failure in the candidate (full) or in `<id>.blocks.txt`, then run `apply` again (incremental).

### 4. Screenshots

Run `LS link-assets <id>`. `missing` means neither the EN nor the UA screenshot exists: note it; the `assets` check will fail the page. `fallback: true` links (no EN screenshot yet) are fine: `record` stores them.

### 5. Check

Write `<id>.unverified.json`: a JSON array of `{ "span": "<UA span>", "reason": "no-match" | "missing-in-locale" }`, one per unverified span in the text you translated (`[]` if none). Run:

`LS check <id> --candidate <run folder>/<id>.candidate.md --unverified-file <run folder>/<id>.unverified.json`

Exit `1` lists `failures`, each with its `check` name. Fix the cause as in step 3 and re-check, at most twice. The usual causes: a block split or merged (`structure`, `counts`), a label not verbatim or with something attached (`labels`), Ukrainian letters left (`ukrainian-letters`), a changed link, code span or attribute (`links`, `inline-code`, `tags`), a missing marker (`markers`). If it still fails, result `failed` with the check names and one line on why. Don't record it: the locale keeps its previous file and state.

### 6. Record

`LS record <id> --candidate <run folder>/<id>.candidate.md --unverified-file <run folder>/<id>.unverified.json`

It re-runs the checks, writes the translation, sets `last_update` and advances the state. Exit `1` → result `failed`, as in step 5.

### 7. New terms

If you translated domain terms that had no row, write them to `<run folder>/<id>.terms.json` as `{ "<UA term>": "<translation>" }`, both in dictionary form (nominative singular), and run `LS terms --add <run folder>/<id>.terms.json`. A `conflict` means the term was recorded meanwhile: use the recorded translation from now on and note it.

### 8. Result line

Append one JSON line to `<run folder>/results.jsonl` (never rewrite the file):

```json
{"unit":"<id>","kind":"page","status":"translated","mode":"incremental","source":{"from":"<blob A>","to":"<blob B>"},"blocks":3,"unmapped":[],"unverified":[{"span":"…","reason":"no-match"}],"assetFallbacks":0,"newTerms":["…"],"emphasis":["…"],"failures":[],"notes":["…"]}
```

`status` is `translated`, `synced`, `skipped` or `failed`. `mode` is `full`, `incremental` or `redo`. `source` is `{"full": true}` for a full page, `{"redo": "<lines>"}` for a redo. `notes` holds anything a writer should see: a suspected error in the UA source (P6), a term whose recorded translation looks wrong, an unmapped block with its UA text, a locale with no register row (R3).

## Sidebar categories

1. `LS blocks <id>` lists `entries` (one per `current.json` entry: `entryKey`, `field`, `ua`), `labels` (the label's decision) and `terms`.
2. Write `<id>.candidate.json`: `{ "<entryKey>": "<translated message>" }` for every entry. A label bound to a key with `write` is `write`, verbatim. Otherwise translate the label as a short navigation title (a noun phrase, through the term rows), and the generated-index title and description as prose.
3. `LS check <id> --candidate <run folder>/<id>.candidate.json` (add `--unverified-file` when the label row says `missing`), fix at most twice, then `LS record <id> --candidate <run folder>/<id>.candidate.json` with the same flags.
4. Append the result line with `"kind":"category"`.

## Never

- Modify the UA page, the EN page, a state file, the label store, a term file (except through `terms --add`) or another locale's files.
- Record a page that failed its checks, or record without `--candidate` after you translated.
- Delete or move a file.
- Commit, stash or push.

## When the queue is done

Reply with one line: the locale, and the count per status (for example `tr: 5 translated, 1 synced, 0 skipped, 1 failed`). Everything else is in `results.jsonl`.
