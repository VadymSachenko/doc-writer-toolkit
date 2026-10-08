# locale-sync

Finds which Ukrainian (UA) pages are stale in each target locale, hands the translator exactly the blocks to write, links the screenshots, and checks the result. Node, no dependencies. No AI is involved: the model only translates. It reuses the `ui-labels` config reader, label store and page-state layout (`../ui-labels/lib/`), so the two scripts must stay in the same plugin.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/locale-sync/locale-sync.mjs <command> [<page|folder>…] [options]
```

Run it from the docs repo root (or pass `--root`). Needs Node 18.3+ and `git`. Tests: `npm test` in this folder (offline, throwaway git repos).

## Commands

| Command | What it does |
|---|---|
| `status [<page>…]` | Stale pages and sidebar categories per locale, from one `git ls-tree` call and the per-unit state files. Adds the size estimate and the 10-page confirmation flag. |
| `blocks <page>…` | The UA blocks to translate (blob A → B), each with its heading path and the matching translated block, plus the label strings, term-memory rows and link titles for those blocks. For a category: the `current.json` entries to write. `--redo <lines\|all>` picks blocks of a current page instead (a term correction). |
| `apply <page>` | Writes a candidate file from the translations of the blocks that `blocks` returned. One page, one locale. Takes the same `--redo`. |
| `bind [<page>…]` | The binding pass: records the span decisions the script can make and lists the rest (`ask`) for the model. `bind --decisions <file>` records the model's answers. |
| `terms <UA term>…` | Per locale, the recorded translation and the UI string of each term, and which terms still need a translation. `terms --add <file> --locales <locale>` appends entries (`--replace` corrects them), `terms --drop <UA term>…` removes them, `terms --usage <old translation>…` finds the blocks that still use a translation. |
| `link-assets <page>…` | Relative per-file symlinks from each locale's `.assets/` to the EN screenshots. Pages only. |
| `check <page>…` | Every Requirement 8 check on a translated page, or the category checks. Exit `1` if any fails. |
| `record <page>…` | Runs the checks, and only if they all pass advances the unit's state. |
| `report [<page>…]` | The Requirement 13 tables. Pages only. Positional pages are the "changed pages" for the URL list. `--md` prints Markdown, `--build` also builds each locale. |

A `<page>` is a page id (`disputes/manage-disputes`), a path, or a folder, relative to the repo root or the UA content root. A sidebar category is selected by its id (`api-reference/_category_`), its path, or its folder. A selector that matches nothing is an input error (exit `2`).

Output is JSON on stdout and logs on stderr. A failure prints `{"error": …}`.

**Exit codes:** `0` ok · `1` something failed (a check, a record, a build, a missing asset) · `2` configuration or input problem (ask the user).

The flow of a run: `status` → `bind` (once for all locales) → `terms` / `terms --add` (the terminology pass) → per page and locale:

```
blocks → (translate the blocks) → apply → link-assets → check --candidate → record --candidate
```

`record --candidate` re-runs the checks itself, so the state cannot advance on a page that fails them, and a failing candidate never reaches the translation path (Requirement 8, criterion 2). Without `--candidate`, `check` and `record` read the translation where it is on disk; then a failing page stays on disk and the caller restores it (`git checkout -- <file>`, or removes it if it is new).

## Configuration

Flags override the `Documentation toolkit configuration` block of `<root>/CLAUDE.md` (same reader as `ui-labels`):

| Flag | CLAUDE.md field | Meaning |
|---|---|---|
| `--ua-root`, `--en-root` | `UA content root:`, `EN i18n root:` | Required. A locale's root is the EN root with its `en` path segment replaced. |
| `--locales` | (from `docusaurus.config.ts`) | Narrows the run. Target locales are `i18n.locales` minus the default locale and `en`. A locale that is not configured is an error. Without a usable config, `--locales` is accepted with a warning. |
| `--scope` | `Translation scope:` | Comma-separated folders or pages, relative to the repo root or the UA root. Default: the whole UA root. |
| `--url-prefix` | `UA URL prefix:` | Route prefix for the report URLs (default `/`). |
| `--state-root` | `Toolkit state root:` | Default `.doc-toolkit`. |
| `--docusaurus-config` | | Path, if it is not `docusaurus.config.{ts,js,mjs,cjs}` in the root. |

**In scope** is every `.md`/`.mdx` file committed at `HEAD` under the UA root, inside the scope, with no path segment starting with `.` or `_` (so `.sources/` and `_partial.md` are skipped).

## Stale detection (`status`)

State is one file per UA page, `<state root>/pages/<page id>.json` (the layout `ui-labels` documents). `status`, `blocks`, `check` and `record` write only `locales.<locale>`; `spans` belongs to the binding pass (`bind`) and is kept as it is.

For every page and locale, one cell:

| `state` | `reason` | When | `mode` |
|---|---|---|---|
| `current` | | The recorded `sourceBlob` equals the committed UA blob and the translation file exists. | |
| `new` | `bootstrap` | No state, no file. | `full` |
| `new` | `overwrite` | No state, a file exists, `--overwrite` given. | `full` |
| `skipped` | `manual-bootstrap` | No state, a file exists. Left alone without `--overwrite`. | |
| `stale` | `source-changed` | Recorded blob ≠ committed blob. `base` is the recorded blob. | `incremental` |
| `stale` | `target-missing` | State exists but the translation file is gone. | `full` |
| `stale` | `base-missing` | The recorded blob is not in the repository (shallow clone, pruned). Reported as a warning. | `full` |

Only **committed** content counts. Uncommitted changes to a UA page are reported in `warnings`.

The `summary` carries what the skill needs for the confirmation: `stalePages`, `languages`, `pageTranslations`, `words`, `bootstrap`, `needsConfirmation` (`stalePages > threshold`, default 10, `--threshold`) and a ready `message` ("24 pages × 8 languages = 192 page translations, about 113,600 words"). Each stale cell has a `words` estimate: the whole page for `full`, the changed blocks only for `incremental`.

`orphaned` lists state files and locale files whose UA page no longer exists. `moved` lists the same, when a current UA page with no state has the recorded blob. Nothing is deleted or moved (moving is Phase 2).

## Changed blocks (`blocks`)

Per page and locale, one result:

- `mode: "none"` (current), `"skipped"` (manual bootstrap), `"full"` (the whole UA text is in `ua.text`, with `bold`, the bold spans), `"incremental"` or `"redo"` (below, `--redo`).
- `incremental`: `source: { kind: "blob-diff", from: A, to: B }`, then `changes[]`, `unmapped[]`, `introducedBold[]` (bold spans the old page never used: terms to keep consistent) and `summary`. `noop: true` means the blob changed but no block did (formatting, `last_update`): `record` it without translating.

A change:

| Field | Meaning |
|---|---|
| `id`, `op` | `c1`…, and `replace` / `add` / `remove`. |
| `kind` | `paragraph`, `item`, `table-row`, `table`, `code`, `admonition`, `component`, `import`, `comment`, `section`, `section-body`, `blocks`, `frontmatter`. |
| `headingPath`, `anchorPath` | Titles and `{/* #anchors */}` down to the block. |
| `ua` | `{ lines, text }`: the **new** UA text (page B). Absent for `remove`. |
| `uaOld` | The previous UA text. Only with `--with-old`. |
| `target` | `{ lines, text }`: the translation as it is now. Use `text` as the exact string to replace. |
| `insertAfter`, `insertBefore` | For `add`: the translated block to insert after (and the first line of the one that follows). A section is inserted after the whole previous section. |
| `insertAfterChange` | Several additions share an anchor: insert them in the listed order, each after the previous change. |
| `bold` | Bold spans in `ua.text`: input for the binding pass. |
| `verbatim` | Copy `ua.text` unchanged (an `import`, a non-mermaid code block, a non-prose frontmatter key). |
| `note` | `section-body` only: more than half of the section changed. |

Lines are 1-based. Everything not listed stays untouched.

Every `full` and `incremental` result (and every category) also carries what the translator needs for the spans and terms in the text it writes (the whole page, or the changed blocks), for that locale only:

| Field | Meaning |
|---|---|
| `labels[]` | One row per bold span and Cyrillic inline-code span: `span`, `kind` (`bold`, `code`, `category`), `decision` from the page state. For `label:<key>`: `key` and `write`, the exact string to put between the `**` (the store string, overlay first, with its trailing `:` `.` `…` `!` `?` dropped when the UA span drops the UA string's). `missing: true` when the store has no string for the locale; with `UI label fallback: en` declared, `write` is then the EN string and `fallback: "en"`. A `term` or `unverified` span with markup inside (below) has `parts[]`: `{ ua, write }` for each part that is a UI string. |
| `labels[]` with `scope` | A span with decisions scoped to headings (see the binding pass) gets one row per decision. `scope` is the heading (title or `#anchor`) a row applies under, with its subsections; the row without `scope` applies everywhere else. `lines` (UA lines, `full`) or `changes` (change ids, `incremental` and `redo`) say where each row applies. |
| `undecided[]` | Spans with no decision: the binding pass has not run on them. |
| `terms[]` | Term-memory entries whose UA term occurs in the text, matched by prefix to cover inflection (a word of 4 letters without its last letter, longer words without their last two): `{ ua, target, source }`. When the term equals a UI string with one string in the locale, that string wins (`source: "ui"`, the memory's value in `recorded` if it differs). `term` and `unverified` spans that equal a UI string are added even without an entry. So is the plain first cell of a table body row (no markup, code or link) that equals a UI string: attribute tables name the app's columns and fields without bold, so no span covers them (`where: "table"`). |
| `termConflicts[]` | A matched term recorded twice with different translations. The first line is used. |
| `links[]` | Links whose UA text names the target page by its title, in any grammatical form (same words, each one matched without its last two letters): `{ text, url, page, title }`. `title` is the target page's title in this locale, which the link text uses, inflected as the sentence needs; `null` while the target has no translation. Routes resolve as Docusaurus does (see `report`), and relative `.md` links by path. |

**How blocks are found.** Both pages are parsed into a tree of sections and blocks (`lib/parse.mjs`), the trees are diffed, and the changed units are expanded as `context/changed-blocks.md` says: a changed sentence → its paragraph, a list item → the item with its sub-items, a table cell → the row (header → the whole table), a heading → its whole section with its subsections, an admonition or MDX component → its whole body, frontmatter → the value. More than half of a section's blocks changed → its whole body (heading and subsections excluded). This is the unit set that expanding `git diff A B` hunks produces, found on parsed blocks instead of line numbers.

**How blocks are mapped.** The translation was made from A, so the A tree is aligned with the translation's tree position by position (heading anchors must agree). If a container's children don't line up one to one, nothing below it is mapped: those changes go to `unmapped[]` with the UA text quoted and a reason. The translator never guesses a place. `check` rejects pages that do not mirror UA, so a recorded page always maps.

**Redo (`--redo`).** `blocks <page> --locales <locale> --redo 12,14-16` returns `mode: "redo"` for a page that is `current` in that locale: one `replace` change per block of the translation that one of those lines falls in (a heading line picks the heading alone, a table header the whole table, a frontmatter line its prose value), paired with its UA block in the current UA page the way `check` pairs blocks, plus the label, term and link rows for those blocks. Lines that pick nothing are listed in `skipped` (blank, code, a non-prose frontmatter key), blocks without a UA counterpart in `unmapped`. `--redo all` returns the whole page as `mode: "full"` (`fullReason: "redo"`); a category is always redone whole. A page that is not current returns `mode: "error"`: translate its pending changes first. `terms --usage` prints the `--redo` value for each page.

## Writing the candidate (`apply`)

`apply <page> --locales <locale> --translations <file.json> --out <candidate>` takes the translator's text and does the splicing, so no model edits a file by line numbers:

- **`incremental`:** `{ "c1": "<translated block>", … }`, one entry per `replace` and `add` change id from `blocks` (a `verbatim` change may be left out: its UA text is copied). A replaced block takes the place of its `target` lines. An added block goes after its anchor (`insertAfter`, the previous addition for `insertAfterChange`, or the start of the file), preceded by as many blank lines as UA has before it. A removed block goes with the blank lines before it. Every other line of the translation is copied unchanged.
- **`full`:** `{ "full": "<translated page>" }`.
- **`redo`:** as `incremental`, with the same `--redo` value given to `blocks`: every change is a `replace`.

The file is JSON, or text with `@@@ <id>` lines (`@@@ c1`, `@@@ full`) each followed by that block's translation, which needs no escaping. The ids follow the current files, so run `blocks` and `apply` without changing anything in between. A missing or unknown id, or the wrong form for the mode, is an input error (exit `2`). `unmapped` changes are not applied; they are returned again for the report. The candidate is then checked and recorded as usual.

## Binding pass (`bind`)

Classifies every bold span (and every inline-code span holding Cyrillic) in the UA text that some target locale will translate (the whole page for a `full` cell, the changed blocks for an `incremental` one), **once for all locales**, and records one decision per span per page in the page state's `spans`. Spans are keyed by their exact text.

**Scoped decisions.** One label text can be two app strings on one page (`**Отримання**` names a tab in one section and a switch in another, and some locales show different words for them). A key `<span>@<heading>` holds a decision for that span under one heading and its subsections: `"Отримання@Доступність як фільтр черги": "label:inbound"`, or with the heading's anchor, `"Отримання@#availability-as-a-queue-filter"`. It overrides the page-level `"Отримання"` decision there; the innermost matching heading wins. `blocks`, `check` and `ui-labels sync` follow it: the label rows say which decision applies where, `check` verifies a scoped span section by section, and `sync` patches a renamed string only in the sections where its key applies. Without page arguments it covers every in-scope unit; `--locales` and `--overwrite` narrow or widen it as for `blocks`. Needs the label store.

| Decision | Meaning |
|---|---|
| `label:<key>` | A UI label: written as the store string, verbatim, in every locale. |
| `unverified` | UI context, but in no dictionary (paraphrase, server text, hardcoded string). Translated as prose and listed as unverified. |
| `term` | A domain term, translated through term memory. Also a UI text with markup inside. |
| `emphasis` | Bold for emphasis only (a style-fixer hint). |

What the script decides on its own (`resolved`, with a `why`):

1. A span already decided on the page keeps its decision. An `unverified` span is looked up again and becomes a label when the store now has it (`now in the dictionary`).
2. A span whose every occurrence is a definition item (`- **Термін:** …`, `- **Термін** — …`, `<li>**Термін**: …`) and that is in no dictionary is a `term`. A definition item that is a dictionary string names a UI element (the list describes controls or status values), so it counts as UI context and goes through rule 4.
3. A span with markup inside (a link, `&nbsp;`, quotes, an `A > B` menu path) is a `term` when each part is a UI string with one string per locale: `blocks` then returns the parts to write. A link or a `&nbsp;` inside the bold can never pass the `labels` check as one label.
4. A dictionary match (exact or normalized, not a placeholder pattern) next to a UI word (натисніть, оберіть, кнопка, поле, вкладка, меню, вікно, іконка, віджет, статус…, within 120 characters before the span) is a label. Several keys with **identical** strings in every locale are chosen by namespace: 2 points when the key's namespace matches the page path, 1 per key already bound on the page in that namespace (at most 2); the winner needs 2 points and no tie.
5. A sidebar category label in the dictionary is a label; one that is not is a `term`.

Everything else goes to `ask`, with the reason (`why`), up to three context lines (each with its innermost `section`), the lookup (key and EN string, or the candidates), and a `suggest` where the script has one: keys with **different** strings (never a `suggest`: there the key decides the translation, and a namespace that only mentions the page's area, such as a dialog's key, misleads), a dictionary match without UI context, no dictionary match, markup whose parts are not all UI strings (with `parts[]` and their lookups). When other pages already decided the same span text, the ask carries `seenOn` (`{ "<decision>": <pages> }`), and the most common decision that fits the lookup becomes the `suggest` if the script has none, so a span the docs repeat (`**Результат:**`) is decided the same way on every page. An ask among keys with different strings whose span occurs under several headings lists them in `sections` (`heading`, `anchor`, `count`): the place to scope a decision. A span counts as decided where a scoped or page-level decision covers it; only the occurrences without one (or with `unverified`) are asked about, and the script writes its own decision to the page-level key, or to the keys that held `unverified` (`keys` in `resolved`).

`bind --decisions <file>` records the model's answers, a JSON object `{ "<page id>": { "<span>": "label:<key>" | "unverified" | "term" | "emphasis" } }`, where a span may be a scoped key. A page id that doesn't exist, a span that isn't on the committed UA page, a scoped key whose span doesn't occur under that heading, a key that isn't in the store or an unknown decision is rejected (exit `1`) and the valid ones are still recorded. `--dry-run` writes nothing.

## Term memory (`terms`)

The file format is in `context/locale-translation.md` §5: `<state root>/terms/<locale>.tsv`, one `<UA term><TAB><translation>` per line, both in dictionary form, sorted by the UA term in byte order.

- **`terms <UA term>…`** (dictionary form) returns, per term, `ui` (the key and each locale's string when the term equals a UI string, or `uiCandidates` when several keys disagree) and `recorded` per locale, plus `missing` per locale: the terms with no entry yet. A missing term with a `ui` string for the locale is recorded with that string, with no translation needed; `blocks` still prefers the UI string if the app later renames it. Matching is case-insensitive on the whole term.
- **`terms --add <file> --locales <locale>`** appends entries from a TSV file in the same format or a JSON file (`{ "<UA term>": "<translation>" }` or `[{ ua, target }]`). A term already recorded with the same translation is `existing`; with a different one it is a `conflict` and is not written (a recorded term is never re-translated). The file is rewritten sorted. The first add also writes `<state root>/terms/*.tsv merge=union` into the repo's `.gitattributes` (not when the state root is outside the repo: `gitattributes: "outside-repo"`).
- **`--replace`** with `--add`: a term recorded with a different translation is corrected instead (`replaced`: `ua`, `old`, `new`). Pages keep the old translation until their blocks are redone.
- **`terms --drop <UA term>… --locales <locale>`** removes those terms' lines (`dropped`, `notFound`). Pages are not touched.
- **`terms --usage <old translation>… --locales <locale>`** lists where that locale still uses a translation: per page, the matching lines (`hits`, matched by prefix like term lookup, in prose, frontmatter values and mermaid labels, never in code), the `blocks` they fall in, and `redo`, the `--redo` value that re-translates exactly those blocks. A category whose `current.json` messages match has `redo: "all"`. `upToDate: false` marks a page that must be translated first. `--scope` narrows the pages.
- A UA term on two lines (two branches merged by `merge=union`) is reported as a conflict wherever it is read; the first line wins until a writer deletes one.

**Correcting a term.** `terms --add <file> --replace` (or edit the row), then `terms --usage <old translation>` and, per listed page: `blocks <page> --redo <redo>` → translate the changes with the corrected term → `apply <page> --redo <redo> …` → `check --candidate` → `record --candidate`. Only those blocks change; the state stays current.

## Screenshots (`link-assets`)

For every `.assets/` file the UA page references (markdown images and `<img src={require('./.assets/x.png')}>`), `<locale root>/<dir>/.assets/<file>` becomes a **relative** symlink to `<EN root>/<dir>/.assets/<file>`.

| `status` | Meaning |
|---|---|
| `created`, `unchanged` | |
| `override` | A real file is there: a locale override, never touched. |
| `repointed` | The link pointed at the UA fallback and the EN asset now exists (or the other way round). |
| `foreign`, `foreign-dangling` | A symlink that points somewhere else: left alone. |
| `missing` | Neither the EN nor the UA asset exists. Exit `1`. |

With no EN asset, the link points to the UA asset (`fallback: true`, listed in `assetFallbacks`; `record` stores them). `orphans` lists symlinks next to the page that no UA page in the folder references. They are reported, never deleted. `--dry-run` writes nothing.

## Checks (`check`)

Failures have a `check` name; warnings never block.

| Check | Fails when |
|---|---|
| `frontmatter` | Keys differ (`last_update` excepted), a non-prose value changed, or `title` / `description` still equal the UA text (a `title` may equal it when the locale's term memory or label store has that string, as for a loanword). |
| `headings` | Count, levels or `{/* #anchor */}` comments differ. |
| `structure` | A section's sequence of blocks differs from UA (a paragraph split or merged). Sentences inside a block may move freely. This keeps later runs mappable. |
| `counts` | List items, numbered steps, table rows or admonition types per section differ. |
| `code` | A fenced code block differs. Mermaid flowcharts compare with their labels blanked; other diagram types by first line and length. |
| `inline-code` | A code-like inline span (no Cyrillic) is missing or changed. Inline code that holds Cyrillic is UI text and is translated. |
| `links` | Link targets or URLs differ (as a multiset, so sentences may be reordered). |
| `images` | Image paths differ. |
| `tags` | MDX/HTML tag names, attribute names or non-prose attribute values differ. `title`, `alt`, `label`, `description`, `caption`, `placeholder`, `aria-label`, `summary` values are prose. |
| `markers` | The number of `ToDo` / `NEEDS CONFIRMATION` markers, or of other `{/* … */}` comments, differs. |
| `labels` | A span bound to `label:<key>` in the page state is not present in bold, verbatim, as the label store's string for the locale (overlay first). A span with scoped decisions is checked per section: each translated section must show the string of the key that applies there (sections pair by position). Each failure carries `redo`: the first translation line of every block that holds the span (in that section, for a scoped span), ready for `blocks --redo`. One exception: when the UA span drops the trailing `:` `.` `…` `!` `?` of the UA store string (`Статус:` shown as `**Статус**`), the locale's string may drop its own trailing punctuation too. A key the store lacks for that locale needs the span in `unverified`. |
| `assets` | A relative image/asset reference does not resolve (a dangling symlink breaks the Docusaurus build). |
| `ukrainian-letters` | `є ї ґ` remain anywhere outside code (and `і` for `ru`, `ky`, `tg`), mermaid labels included. The word «Українська» is exempt: language pickers show it as it is. |

Warnings:

- A translation written mostly in Latin letters that still contains Cyrillic (an untranslated mermaid label, for example). It is not a failure because pages about the language picker legitimately list Cyrillic names.
- A link whose UA text names the target page's title, and whose translated text doesn't name the target's translated title (same words, each one matched without its last letter, so an added case or possessive suffix still passes). Every mismatch is listed. Result field `linkTitles[]` (also in the `check` output): `line`, `text`, `url`, `title`.

## Recording (`record`)

1. Runs `check`. On any failure it returns `recorded: false` with the failures and changes nothing.
2. With `--candidate <file>`, writes the candidate to the translation path (atomically, creating folders).
3. Sets `last_update.date` in the translation only, in the format the UA page uses (`9/8/2026` or ISO). The UA page is never modified.
4. Writes `locales.<locale>` in the state file: `sourceBlob` (the committed UA blob), `labelSnapshot` (`meta.commit` of the label store), `translatedAt`, `unverified`, `assetFallbacks` (links that currently point at the UA tree). The state file is re-read and written under a lock file (`<state file>.lock`), so the workers of several locales can record the same page in parallel. `bind` and `terms --add` use the same lock.

`--unverified-file <json>` is a JSON array of UA spans (or `{ "span", "reason" }`) for this run: spans with UI context but no dictionary match, and bound keys missing in the locale. They are merged with the earlier ones. An entry is dropped when its span left the UA page, or when its label now verifies. `--date YYYY-MM-DD` overrides today (tests).

## Sidebar categories (`_category_.json`)

A `_category_.json` in the UA content root is a unit of its own (`kind: "category"`, id `<dir>/_category_`), tracked like a page by `status`, `blocks`, `check` and `record`, with the same state file layout (`<state root>/pages/<dir>/_category_.json`) and the same `current` / `new` / `stale` / `skipped` cells.

Docusaurus reads `_category_.json` from the UA root only; a copy in the `i18n` tree is ignored. A locale's text lives in that locale's `current.json` (written by `write-translations`), so that is the target: `<locale root>.json`, for example `i18n/tr/docusaurus-plugin-content-docs/current.json`. Per category there are up to three entries, found by their key suffix so the sidebar id need not be known:

| UA field | `current.json` entry |
|---|---|
| `label` | `sidebar.<sidebarId>.category.<key>` |
| `link.title` (generated-index) | `sidebar.<sidebarId>.category.<key>.link.generated-index.title` |
| `link.description` (generated-index) | `sidebar.<sidebarId>.category.<key>.link.generated-index.description` |

`<key>` is the category's `key`, or its `label` when it has none.

- **`status`** adds `kind: "category"` rows to `pages[]` and a `summary.categories` block. Categories never count toward the 10-page confirmation; the message adds "plus N sidebar category translations". A category is always translated whole (`mode: "full"`, `base: null`). The entries are normally there already (`write-translations` creates them with the UA text), so a category is a manual bootstrap (`skipped`) only when a message already differs from the UA text. Entries missing from `current.json` (no `write-translations` yet, or a renamed key) make the cell `target-missing`.
- **`blocks`** returns `entries[]` (`entryKey`, `field`, `ua`, `current`, and `binding` when the page state binds the label to an app string) and a `problem` if the entries do not exist yet.
- **`check` / `record`** take `--candidate <file>`: a JSON object `{ "<entryKey>": "<translated message>" }`. `record` writes those messages into `current.json` and leaves every other entry, description and the file's layout alone. Without a candidate they check what is in `current.json`. Checks: `target-missing`, `category` (message empty, still the UA text, or a key that is not an entry of this category), `ukrainian-letters` (as for pages), `labels` (a label bound in the state `spans` must equal the app's string for the locale exactly, with the same trailing-punctuation exception as for pages, or be recorded as unverified).
- **YAML** (`_category_.yml`) is not tracked: `status` warns. A category without a `label` has nothing to translate and is skipped.
- **`ui-labels sync` keeps categories in step.** When a category label bound to an app string is renamed, `sync` patches the UA `_category_.json` and the entry in each locale's `current.json` (renaming the entry keys of a category without `key`), and advances the category's state, so the cell stays `current` and the checks still pass. See the `ui-labels` README.

## Report (`report`)

Over every in-scope page and target locale: `exists`, `imagesResolve`, `checksPassed`, the failing check names, `unverified` / `assetFallbacks` counts, `upToDate`, and the local URL of the page (`http://localhost:3000/<locale><route>`, with `--origin` and the config's `baseUrl`; the route follows Docusaurus: `folder/folder.md` and `index.md` collapse to the folder, number prefixes are dropped, `slug:` wins). Exit `1` unless every page exists, resolves its images, passes its checks and every build passed.

`--md` adds a list of the link texts that name a page differently from its title (the `check` warning), per page and locale.

`--build` runs `npm run build -- --locale <locale>` for each locale that has a changed page (sequentially, 30 minute timeout each) and reports unresolved images and broken links per page, or the last log lines.

## Limits

- Block parsing is line-based and tuned to Docusaurus MDX as these docs write it: top-level blocks start in column 0, list continuations are indented. Unusual constructs fall back to a paragraph; mapping then fails visibly (`unmapped`), it never mis-maps.
- A mermaid diagram's labels are compared only for `flowchart` and `graph`.
- `report` and `link-assets` cover pages only. Navbar and footer strings (`code.json`) are out of scope by design.
- Only `.md` / `.mdx` pages are tracked. Symlinks need a filesystem that supports them (macOS, Linux).
