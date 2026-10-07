# ui-labels

Imports an app's UI dictionaries into a **label store** inside a docs repo, and patches documentation pages when the app renames a label. Node, no dependencies. GitHub access goes through the authenticated `gh` CLI. No AI is involved.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-labels/ui-labels.mjs <command> [options]
```

Run it from the docs repo root (or pass `--root`). Needs Node 18.3+ and `gh` (for the `github-json` adapter). Tests: `npm test` in this folder (offline, uses the `command` adapter and a throwaway git repo).

## Commands

| Command | What it does |
|---|---|
| `check` | Asks GitHub for the latest commit that touched the locale directory on the base branch (and on the ticket's feature branches) and compares it with `meta.json`. Exit `0` = nothing to do, `10` = run `import` / `sync`. About 1.5 s, all of it network. |
| `import` | Reads the locale files, writes the snapshot, the ticket overlay and library strings, and leaves a diff for `sync`. |
| `diff <from> <to>` | Compares two `ui-labels` snapshot directories. |
| `lookup <span>…` | Looks up UA strings. `--search <text>` searches keys and UA/EN strings instead (to find the exact UA label without a screenshot). |
| `sync` | Patches the docs pages for the diff left by the last `import`. |
| `hardcoded` | Phase 2. Prints `not-implemented`, exit `3`. |

Output is JSON on stdout and logs on stderr (`lookup` prints a table unless `--json`). A failure prints `{"error": …}` and may add fields that tell the caller what to ask the user (`missing`, `unresolved`).

**Exit codes:** `0` ok · `1` failure · `2` configuration or input problem (ask the user) · `3` an earlier import's diff is not synced yet · `10` `check` found something to do.

## Configuration

Every option can be a flag. Missing flags are read from the `Documentation toolkit configuration` block of `<root>/CLAUDE.md`:

| Flag | CLAUDE.md field | Meaning |
|---|---|---|
| `--source` | `UI label source:` | `github <owner/repo>@<branch> <dir>/*.json` or `command <shell command containing {locale}>` |
| `--locale-files` | `Locale files:` | `uk=ua, es=ar`: docs locale = file name without `.json`. Only needed where file names don't match by language. |
| `--locales` | (from `docusaurus.config.ts`) | Target locales. Default: `i18n.locales` minus `defaultLocale` and `en`. `uk` (the default locale) and `en` are always imported too. |
| `--docusaurus-config` | | Path to the Docusaurus config if it isn't `docusaurus.config.{ts,js,mjs,cjs}` in the root |
| `--state-root` | `Toolkit state root:` | Default `.doc-toolkit` |
| `--ua-root`, `--en-root` | `UA content root:`, `EN i18n root:` | Needed by `sync`. Locale roots are derived by replacing the `en` path segment of the EN root. |
| `--ticket` | | Ticket number(s), comma-separated. Default: the leading numbers of the current git branch (`1139-x-doc` → `1139`, `90-94-x` → `90`, `94`). |

Locale file matching:
- A file matches a docs locale by language code: `es-AR.json` → `es`, `tr-TR.json` → `tr`.
- A file named after another language (`ar.json`) never matches `es`. If a locale has no match, or several files match, the script exits `2` with the candidates in `unresolved` and never guesses.
- Only `*.json` files matching the glob are considered, so `index.ts` is ignored.

## Storage (`<state root>/ui-labels/`)

```
meta.json        source, commit, importedAt, locales, localeMap (docs locale → file), keyCounts,
                 missing { locale: [keys] }, libs, overlay { tickets, branches { branch: commit } }
<locale>.json    flat { "key": "string" }, sorted, this app only (uk, en and every target locale)
overlay.json     { tickets, branches: { branch: { commit, mergeBase, keys: { key: { locale: string } } } } }
.pending-diff.json   diff of the last import, consumed by `sync` (git-ignored by an auto-created .gitignore)
```

- **Keys** are flattened to dotted paths (`transactions.filters.title`). Placeholders (`{{count}}`, `{name}`, `%s`) stay verbatim.
- **`meta.commit`** is the latest commit touching the locale directory. For the `command` adapter it is `content:<sha256 of all outputs>`.
- **`missing`** lists keys that `uk` or `en` have and the locale lacks (never filled with a guess).
- **Library strings** go under `lib.<library>.*` in the same locale files. The script reads the frontend's `package.json`; for `antd` it installs `antd@<version>` once into `~/.cache/doc-writer-toolkit/ui-libs/` (override with `DOC_TOOLKIT_CACHE`) and reads its locale files. The library locale is chosen from the app file's region (`es-AR` → `es_AR`), else the only candidate, else `<lang>_<LANG>` (`es_ES`), else `en_US`. Locales the library lacks are listed in `meta.libs.<name>.missingLocales`. A failure is a warning, never an error. `--no-libs` skips this. The libraries are not counted in the 80% coverage check.
- **Safety:** an import stops with exit `1` and writes nothing if a locale file doesn't parse or has under 80% of the EN keys.
- **Overlay:** for each branch matching `(^|/)<ticket>-`, the overlay holds the keys the branch itself added or changed since it forked from the base (merge base via the compare API), minus anything the base already has. It is not a plain branch-vs-base comparison, so a branch that is behind `test` can't shadow newer base labels. Lookup prefers the overlay. When the feature merges, the next import finds nothing left to overlay. The `command` adapter has no overlay.
- **Pending diff:** `import` refuses to run (exit `3`) while a diff is unsynced, because a second import would lose the first diff. Run `sync`, or pass `--discard-pending`.

### Page state files (read and written by `sync`; also by the page-sync tooling)

One file per UA page: `<state root>/pages/<path of the UA page relative to the UA content root, without .md/.mdx>.json`, for example `archive/archive.md` → `.doc-toolkit/pages/archive/archive.json`.

```json
{
  "spans": { "Фільтри": "label:transactions.filters.title", "Увага": "emphasis" },
  "locales": { "tr": { "sourceBlob": "…", "labelSnapshot": "<meta.commit>", "translatedAt": "2026-10-07", "unverified": [], "assetFallbacks": [] } }
}
```

`sync` only touches `spans` (rebinding and renaming keys) and, per locale, `sourceBlob` and `labelSnapshot`. It keeps every other field.

A sidebar category has a state file too, named `<dir>/_category_` (`archive/_category_` → `.doc-toolkit/pages/archive/_category_.json`). Its `spans` bind the category's UA label to an app key, exactly like a bold label on a page.

## Diff

`added` / `removed` / `changed` / `rekeyed`, with per-locale old and new strings:

```json
{ "changed":  [{ "key": "button.save", "locales": { "uk": { "old": "Зберегти", "new": "Підтвердити" }, "tr": { "old": "Kaydet", "new": "Onayla" } } }],
  "rekeyed":  [{ "from": "a.name", "to": "a.title", "locales": { "tr": { "old": "Ad", "new": "Başlık" } } }],
  "added":    [{ "key": "button.new", "values": { "uk": "Додати" } }],
  "removed":  [{ "key": "old.key",    "values": { "uk": "Видалене" } }] }
```

A key is present when any locale has it. `rekeyed` pairs one removed and one added key with the identical UA string in the same namespace, one to one only. The diff compares base snapshots only, so an overlay change never counts as `removed`.

## Lookup

```
$ ui-labels lookup "Середній курс" "Нема такого" --locales ru,tr,kk
span           class  key                 ru            tr            kk
Середній курс  label  statistic.avg.rate  Средний курс  Ortalama kur  Орташа бағам
Нема такого    ?      no match
```

- Matching is exact, then normalized (case, whitespace, trailing `:` `.` `…`), then placeholder patterns.
- Application keys beat `lib.*` keys.
- Several keys with identical strings in the requested locales are `label` (`status: identical-targets`; `key` is just the first of the candidates, the others are in `alsoKeys`). **`key` must not be used as the binding in that case.** Choosing among the candidates by the page's namespace is the binding pass's job (Requirement 3, criterion 2). Binding to whichever key sorts first would make a later rename of a sibling key skip the page, or patch it wrongly.
- Several keys with different strings are `?` with `status: ambiguous` and the candidates. The binding pass chooses.
- `--json` gives the full structure, including `overlay` (the branch a value came from) and `missingIn`.

`lookup` only matches spans against the dictionary. It does not decide label vs term vs emphasis. That needs the page context and belongs to the binding pass.

## Sync

`sync` reads `.pending-diff.json` (or `--diff <file>`) and, for every page state file that binds a changed or rekeyed key:

1. Replaces `**old**` with `**new**` outside fenced code blocks, in the language each string belongs to: the UA page, the EN page and every locale page that exists.
2. Renames the span in the state file and rebinds rekeyed keys.
3. Advances each locale's `sourceBlob` to the patched UA blob **only if** it equalled the UA blob before the patch, so a translation that was already stale stays stale. Sets `labelSnapshot` when every patch for that locale succeeded.

It never patches a page when any of its files has uncommitted changes (reported in `skipped`; the diff stays pending). Run it again after committing. It is idempotent: a string already at its new value is reported as `alreadyCurrent`.

### Sidebar categories

A state file named `…/_category_` is patched like a page, in these files:

- **UA:** `<UA root>/<dir>/_category_.json`, its `label`.
- **Every other locale (EN included):** the category's label entry in `<locale root>.json` (`current.json`), `sidebar.<sidebarId>.category.<key>`, `message`. `<key>` is the category's `key`, or its label when it has none. Entries for the category's other fields (generated-index title and description) are not bound to an app string and keep their messages.

Details:

- A category **without a `key`** is keyed by its UA label, so when the label changes `sync` also renames its entries (label, and generated-index title and description) in every locale's `current.json`. It does this only once the UA label has the new value; if the UA file could not be patched, the keys stay and the messages are still patched. They are listed in `renamedEntries` (`page`, `locale`, `file`, `from`, `to`).
- An entry that was **never translated** (its message is still the UA text, as `write-translations` writes it) follows the new UA text, not the locale's own string. It stays untranslated, so the translation run still handles it. It is reported in `patched` with `untranslated: true`, and `old`/`new` are the UA texts.
- The state's `spans` entry follows the UA label only after the UA file really has the new value. Each locale's `sourceBlob` advances to the patched UA file's blob under the same rule as for pages.
- A `current.json` is shared by every category of that locale. Edits `sync` made earlier in the same run do not count as uncommitted changes.
- JSON is rewritten only when its present layout is exactly what `JSON.stringify` writes (indent detected, trailing newline kept). Otherwise the file is left alone and listed in `unpatched` with the reason, for a writer to patch by hand.
- A locale without a `current.json` yet is skipped silently, like a page that does not exist. A `current.json` without the category's entry is listed in `unpatched` ("run write-translations").
- YAML category files (`_category_.yml`) are not patched.

`--commit` stages the patched pages, state files and `ui-labels/`, and makes one commit: `Sync UI labels to <repo>@<sha7>`. Only those paths are committed. `--dry-run` writes nothing.

The report lists:

- `patched`: page, locale, key, old and new string, line and the patched line text. **Show the `uk` and `en` entries to the PR reviewer.** A label inside a sentence whose grammar depends on it is patched verbatim, so the reviewer fixes agreement or case by hand.
- `alreadyCurrent`
- `notFound`: the page doesn't contain the old string in that locale, so it was not patched
- `checkBinding` (Requirement 3, criterion 2a): a page is bound to a **sibling** of a changed key (an unchanged key that still has the changed key's old UA string) and still shows the old string in some locale. Each entry gives page, locale, `boundKey`, `changedKey`, old and new string and the lines. Nothing is patched, because only a writer knows whether the page meant the changed key. It is information only and doesn't keep the diff pending.
- `unpatched`: an old or new string is missing for that locale, or the same old string was renamed differently by several keys, or a category file cannot be patched without reformatting it, so a writer must decide
- `broken`: a bound key was removed, nothing patched
- `rekeyed`
- `renamedEntries`: `current.json` entry keys renamed for a category without a `key`
- `undocumented`: new keys, information only
- `skipped`
- `pendingRemains`
- `commit`

## Limits

- Replacement is by exact bold string. A page that also uses the same string in bold as emphasis is patched at every occurrence, because spans are classified per page, not per occurrence.
- Only `**bold**` labels are patched. Labels in inline code, quotes or `__bold__` are not.
- Of a category, only the label is bound and patched, not its generated-index title or description.
- Source files must be JSON (flat or nested). Other formats go through the `command` adapter.
