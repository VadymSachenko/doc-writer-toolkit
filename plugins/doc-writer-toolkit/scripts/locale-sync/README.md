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
| `blocks <page>…` | The UA blocks to translate (blob A → B), each with its heading path and the matching translated block. For a category: the `current.json` entries to write. |
| `link-assets <page>…` | Relative per-file symlinks from each locale's `.assets/` to the EN screenshots. Pages only. |
| `check <page>…` | Every Requirement 8 check on a translated page, or the category checks. Exit `1` if any fails. |
| `record <page>…` | Runs the checks, and only if they all pass advances the unit's state. |
| `report [<page>…]` | The Requirement 13 tables. Pages only. Positional pages are the "changed pages" for the URL list. `--md` prints Markdown, `--build` also builds each locale. |

A `<page>` is a page id (`disputes/manage-disputes`), a path, or a folder, relative to the repo root or the UA content root. A sidebar category is selected by its id (`api-reference/_category_`), its path, or its folder. A selector that matches nothing is an input error (exit `2`).

Output is JSON on stdout and logs on stderr. A failure prints `{"error": …}`.

**Exit codes:** `0` ok · `1` something failed (a check, a record, a build, a missing asset) · `2` configuration or input problem (ask the user).

The worker flow for one page in one locale:

```
blocks → (write the translation to a candidate file) → link-assets → check --candidate → record --candidate
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

State is one file per UA page, `<state root>/pages/<page id>.json` (the layout `ui-labels` documents). Only `locales.<locale>` is written here; `spans` belongs to the binding pass and is kept as it is.

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

- `mode: "none"` (current), `"skipped"` (manual bootstrap), `"full"` (the whole UA text is in `ua.text`, with `bold`, the bold spans) or `"incremental"`.
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

**How blocks are found.** Both pages are parsed into a tree of sections and blocks (`lib/parse.mjs`), the trees are diffed, and the changed units are expanded as `context/changed-blocks.md` says: a changed sentence → its paragraph, a list item → the item with its sub-items, a table cell → the row (header → the whole table), a heading → its whole section with its subsections, an admonition or MDX component → its whole body, frontmatter → the value. More than half of a section's blocks changed → its whole body (heading and subsections excluded). This is the unit set that expanding `git diff A B` hunks produces, found on parsed blocks instead of line numbers.

**How blocks are mapped.** The translation was made from A, so the A tree is aligned with the translation's tree position by position (heading anchors must agree). If a container's children don't line up one to one, nothing below it is mapped: those changes go to `unmapped[]` with the UA text quoted and a reason. The translator never guesses a place. `check` rejects pages that do not mirror UA, so a recorded page always maps.

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
| `frontmatter` | Keys differ (`last_update` excepted), a non-prose value changed, or `title` / `description` still equal the UA text. |
| `headings` | Count, levels or `{/* #anchor */}` comments differ. |
| `structure` | A section's sequence of blocks differs from UA (a paragraph split or merged). Sentences inside a block may move freely. This keeps later runs mappable. |
| `counts` | List items, numbered steps, table rows or admonition types per section differ. |
| `code` | A fenced code block differs. Mermaid flowcharts compare with their labels blanked; other diagram types by first line and length. |
| `inline-code` | A code-like inline span (no Cyrillic) is missing or changed. Inline code that holds Cyrillic is UI text and is translated. |
| `links` | Link targets or URLs differ (as a multiset, so sentences may be reordered). |
| `images` | Image paths differ. |
| `tags` | MDX/HTML tag names, attribute names or non-prose attribute values differ. `title`, `alt`, `label`, `description`, `caption`, `placeholder`, `aria-label`, `summary` values are prose. |
| `markers` | The number of `ToDo` / `NEEDS CONFIRMATION` markers, or of other `{/* … */}` comments, differs. |
| `labels` | A span bound to `label:<key>` in the page state is not present in bold, verbatim, as the label store's string for the locale (overlay first). One exception: when the UA span drops the trailing `:` `.` `…` `!` `?` of the UA store string (`Статус:` shown as `**Статус**`), the locale's string may drop its own trailing punctuation too. A key the store lacks for that locale needs the span in `unverified`. |
| `assets` | A relative image/asset reference does not resolve (a dangling symlink breaks the Docusaurus build). |
| `ukrainian-letters` | `є ї ґ` remain anywhere outside code (and `і` for `ru`, `ky`, `tg`), mermaid labels included. The word «Українська» is exempt: language pickers show it as it is. |

Warning: a translation written mostly in Latin letters that still contains Cyrillic (an untranslated mermaid label, for example). It is not a failure because pages about the language picker legitimately list Cyrillic names.

## Recording (`record`)

1. Runs `check`. On any failure it returns `recorded: false` with the failures and changes nothing.
2. With `--candidate <file>`, writes the candidate to the translation path (atomically, creating folders).
3. Sets `last_update.date` in the translation only, in the format the UA page uses (`9/8/2026` or ISO). The UA page is never modified.
4. Writes `locales.<locale>` in the state file: `sourceBlob` (the committed UA blob), `labelSnapshot` (`meta.commit` of the label store), `translatedAt`, `unverified`, `assetFallbacks` (links that currently point at the UA tree).

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

`--build` runs `npm run build -- --locale <locale>` for each locale that has a changed page (sequentially, 30 minute timeout each) and reports unresolved images and broken links per page, or the last log lines.

## Limits

- Block parsing is line-based and tuned to Docusaurus MDX as these docs write it: top-level blocks start in column 0, list continuations are indented. Unusual constructs fall back to a paragraph; mapping then fails visibly (`unmapped`), it never mis-maps.
- A mermaid diagram's labels are compared only for `flowchart` and `graph`.
- `report` and `link-assets` cover pages only. Navbar and footer strings (`code.json`) are out of scope by design.
- Only `.md` / `.mdx` pages are tracked. Symlinks need a filesystem that supports them (macOS, Linux).
