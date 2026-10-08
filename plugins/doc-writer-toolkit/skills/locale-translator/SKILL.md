---
name: locale-translator
description: Translates the approved UA pages of a docs repo into every further target locale the site declares (all locales except the default and en), block by block and only where UA changed since the last run. Runs the UI label check first, binds bold spans to the app's own UI strings once for all locales, keeps per-locale term memory, runs one worker per locale in parallel, links screenshots to EN, and records a page only when the scripted checks pass. Ends with a build and a per-page, per-locale report. Not for UA → EN (doc-translator). Use explicitly ("translate-locales", "use locale-translator to translate...").
---

# locale-translator

You are bringing the further locales of a documentation site up to date with its approved Ukrainian pages. No person reviews these translations, so correctness comes from the mechanism: UI labels come from the app's own dictionaries, terms come from term memory, scripts decide what to translate and check every page, and a page is recorded only when its checks pass. Your job is to run that mechanism, make the decisions only a model can make, and report.

`LS` below means `node ${CLAUDE_PLUGIN_ROOT}/scripts/locale-sync/locale-sync.mjs` and `UL` means `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-labels/ui-labels.mjs`. Run both from the docs repo root. Their READMEs (`${CLAUDE_PLUGIN_ROOT}/scripts/locale-sync/README.md`, `.../ui-labels/README.md`) document every field; read a section only when an output needs it.

## Scope

- **In scope:** every in-scope UA page and sidebar category (`_category_.json`) that is new or changed for at least one target locale; writing the locale pages, the category entries in each locale's `current.json`, the screenshot symlinks, the page state and the term memory; the build and the report. Also corrections of recorded translations, block by block: a wrong term, a label that needs another key in one section, a link text or a task title (see "Corrections after a run").
- **Out of scope:**
  - UA → EN: `doc-translator`. The EN page is never read, used as a reference or modified here.
  - Writing or fixing UA content. The UA page is never modified, and a suspected error in it is reported, not fixed.
  - Docusaurus setup: registering locales, the locale dropdown, `code.json`, navbar and footer strings, site components. That is a one-time setup per repo.
  - Moving or deleting anything. Orphaned and moved pages, unreferenced symlinks and stale term entries are reported only.
  - Style review of the translations. No style corpus exists for these locales; quality comes from `locale-translation.md` and the worker's self-review.
  - Approval. The user runs this after the SME approved the UA version; the skill doesn't check approval.

## Sources to load

At the start of the run, only these:

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve `UA content root:`, `EN i18n root:`, `UA URL prefix:` and the fields in its "Label store and locale translation" section (`App:`, `Locale register:`, `Translation scope:`, `Toolkit state root:`, `UI label fallback:`). Target locales come from `docusaurus.config.*`, never from `CLAUDE.md`.
2. `${CLAUDE_PLUGIN_ROOT}/context/ui-labels.md` — the label check, run in the column for `locale-translator`.

Each translation worker loads `${CLAUDE_PLUGIN_ROOT}/skills/locale-translator/worker.md` and `${CLAUDE_PLUGIN_ROOT}/context/locale-translation.md` itself. Don't load those, the label store files, the term-memory files, EN pages or whole UA pages into your own context: the scripts hand out exactly the rows and blocks each step needs.

## Arguments

All optional. Without arguments the run covers every in-scope page that is stale in any target locale.

- `<page|folder>…` — narrow the run to these pages or folders (ids or paths, relative to the repo or the UA content root).
- `--locales tr,kk` — narrow the run to these target locales.
- `--dry-run` — status only: the label check's `check` step (nothing imported or synced) and Step 2's table. Nothing is written.
- `--overwrite` — also translate pages that have a locale file but no recorded state (a manual bootstrap). Their files are replaced.
- `--ticket <n>` — the ticket whose frontend branches overlay the label store, when the branch name doesn't start with it.
- `--worker-model <model>` — the model for the translation workers (default: the session's model).
- `--no-build` — skip the build in Step 6. Only for quick iterations; say in the report that no build ran.

Pass `<page|folder>…`, `--locales` and `--overwrite` to every `LS` call that takes them.

## Workflow

### Step 0 — Declarations and the run folder

1. Resolve the declarations through `project-paths.md`. If `App:` or `UI label source:` is missing, ask once and offer to persist the answer. Whenever a script exits `2`, it names what is missing (`missing`, `unresolved`): no target locales configured yet → stop and say so; anything else → ask once and offer to persist the answer, then run the step again.
2. Unless `--dry-run`, create the run folder `<state root>/.run/<YYYYMMDD-HHMM>/`. If `<state root>/.run/.gitignore` doesn't exist, write it with the single line `*`, so nothing in `.run/` is ever committed. Every working file of the run (bind output, decisions, terms, candidates, unverified lists, worker results, the report) goes in the run folder.

### Step 1 — UI label check (required)

Follow `ui-labels.md` in its `locale-translator` column, passing `--ticket` if given. A translation never runs on an unchecked snapshot: when `check` or `import` fails, or `sync` leaves the diff pending, stop and report. `sync` runs without `--commit`. When it patched pages or categories, show its report and its `suggestedCommit`, ask the user to make that commit, and stop: run the skill again afterwards (`ui-labels.md`, step 6). When only the snapshot changed, continue. Keep the sync report (patched, check binding, markup parts, broken, undocumented, suggested commit) for Step 6.

With `--dry-run`, run `UL check` only and report whether an import and sync are due.

### Step 2 — What to translate

1. Run `LS status` and save the output to the run folder (with `--dry-run`, don't save it).
2. Read `summary`, `warnings`, `orphaned` and `moved`:
   - **Nothing new or stale** (`summary.pageTranslations` and `summary.categories.translations` are 0): report "all locales are up to date", with any warnings, orphans and skipped pages, and stop.
   - **Uncommitted UA changes** (a warning): only the committed version is translated. Say so once; don't commit for the user.
   - **`base-missing`** warnings: those cells are re-translated in full. Mention them.
   - **`skipped` cells** (`manual-bootstrap`): left alone; list them and mention `--overwrite`.
3. Show the user a short table: per locale, how many pages and categories are `new` / `stale`, and `summary.message`.
4. **Confirmation.** If `summary.needsConfirmation` is true (more than the threshold of UA pages, normally on the first run), show `summary.message` and wait for the user's go-ahead before anything else. Otherwise continue without asking.
5. With `--dry-run`, stop here.

The units of the run are every page and category row with at least one `new` or `stale` cell. Each locale's queue is its own `new` / `stale` cells, in the order `status` lists them.

### Step 3 — Binding pass (once for all locales)

1. Run `LS bind` (with the run's pages / locales / `--overwrite`) and save the output. The script records every decision it can make itself (`resolved`) and lists the rest in `ask`.
2. Decide every `ask` span. Each item gives the span, its reason (`why`), up to three context lines, the dictionary lookup and, often, the script's `suggest`. `seenOn` counts the decisions other pages already have for the same span: keep to them unless this page's context differs. A span asked on several pages in this run gets the same decision on each, unless the contexts differ. Use the context, not the span alone:
   - **`label:<key>`** — the span is text the app shows (a button, field, column, tab, menu item, window title, message, status value) and one of the lookup's keys fits it. Among keys with the same strings, pick the one whose namespace matches the screen the context describes; `suggest` is the namespace guess, so take it unless the context contradicts it. Among keys with **different** strings (no `suggest`), the key decides what every locale shows, so don't guess from the namespace: a key named after a dialog or a flow (`*.modal.*`) is not a tab or a page control, and a `lib.*` key is the UI library's own control (a date picker's OK). When the `UI label source:` is a GitHub repo, find where the app renders each candidate key (`gh search code '<key>' --repo <owner/repo>`, or a grep of its source) and take the key of the screen the context describes. When that doesn't settle it, decide `unverified`. Only keys from the lookup are allowed.
   - **`unverified`** — the span is meant as UI text, but no key fits or there is no match: UA paraphrases the screen, or quotes server text or a hardcoded string. Never bind a key that "almost" matches.
   - **`term`** — a domain concept (an entity, a role, a status named as a concept), a definition item, a fixed lead-in the docs repeat on many pages (`**Результат:**`), or UI text with markup whose parts are UI strings.
   - **`emphasis`** — bold that only stresses words, or that points to a heading or stage of the docs themselves (`**2. Додайте …**`). These are Ж1 hints in the report.

   **One span, two controls on one page.** An ask among keys with different strings may list `sections`: the headings the span occurs under. When the contexts show the span naming different controls in different sections (a tab in one, a switch in another), decide the page-level span for the meaning most occurrences have, and add `"<span>@<heading>": "label:<other key>"` for each heading where the other control is meant (the heading's title or its `#anchor`, as `sections` gives them). A scoped decision covers that section and its subsections. If one section names both controls, a scoped decision can't separate them: decide for the meaning that section mostly has, and report it for a writer.
3. Write `{ "<page>": { "<span>": "<decision>" } }` to `<run>/decisions.json` and run `LS bind --decisions <run>/decisions.json`. Fix and resubmit anything `rejected`.
4. Run `LS bind` again (with the same narrowing): `summary.ask` must be 0.

### Step 4 — Terminology pass (once per locale)

1. Collect the run's terms, in dictionary form (nominative singular, trailing punctuation dropped):
   - every span decided `term` or `unverified` in Step 3, except markup spans (their parts come from the label store) and spans that aren't noun phrases (a sentence, a quoted message);
   - the generic UI nouns that the units' UA files contain (find them with a grep, don't read the files): кнопка, поле, вкладка, меню, вікно, стовпець, колонка, прапорець, перемикач, список, іконка, віджет, панель, сторінка, розділ. Each locale then uses one word per element type (`locale-translation.md`, L2).
2. Run `LS terms <term>… --locales <targets>`. For each locale, every term in `missing` gets an entry. A term with a `ui` string for the locale takes that string, with no translation needed (T1).
3. Translate each locale's other missing terms (noun phrases in dictionary form, following that locale's rules in `locale-translation.md` §5–§7; read those sections only for this). Write `<run>/terms-<locale>.json` (`{ "<UA term>": "<translation>" }`) and run `LS terms --add <run>/terms-<locale>.json --locales <locale>`. Report `conflicts`; never overwrite a recorded term.

### Step 5 — Translation workers (one per locale, in parallel)

1. Split each locale's queue into batches of at most 8 units and about 6,000 UA words (the `words` of its cells). Most runs are one batch per locale.
2. Start one worker per locale for its first batch, all in the same message so they run in parallel, in the background, using `--worker-model` if given. Give each worker this prompt, with the locale-specific lines last so the shared part stays identical:

   ```
   You are a translation worker of a locale-translator run.
   Read <plugin root>/skills/locale-translator/worker.md and follow it exactly.
   Plugin root: <absolute path of ${CLAUDE_PLUGIN_ROOT}>
   Docs repo root: <absolute path>
   Locale: <locale>
   Register: <the project's Locale register: value for this locale, or "default">
   Run folder: <absolute path of the run folder>/<locale>/
   Units, in this order: <id> (<page|category>, <full|incremental|redo <lines>>), …
   ```

3. When a worker finishes, start that locale's next batch, until every queue is done. A locale whose worker fails or stops keeps its previous files and state; the other locales go on (Requirement 5, criterion 8).
4. If the run is interrupted, run it again: `status` shows what is still stale, because every page passed and recorded is `current`.

Don't translate, check or record pages yourself, and don't read the workers' candidate files. Their results are in `<run>/<locale>/results.jsonl`, one line per unit.

### Step 6 — Build and report

1. Unless `--no-build`, run `LS report <pages> --build --md` in the background (each locale build can take minutes) and save the output. `<pages>` are the ids of every page translated or synced in this run: pages only, since a category has no page of its own, and none when only categories changed. It builds each locale with a changed page and gives, for every in-scope page and locale, ✓/✗ for "page exists", "all images resolve" and "checks passed", plus the local URLs of the changed pages. With `--no-build`, run it without `--build`. When the run was narrowed to pages or folders, also pass them as `--scope <comma-separated>`, so the tables cover the run's pages and not every untranslated page outside it.
2. Read every `results.jsonl` and write the run report to `<run>/report.md`:

   ```
   # Locale translation — <App> — <date>

   Branch: <branch> · Locales: <list> · Label snapshot: <repo>@<sha7> (<new snapshot, uncommitted | unchanged>)
   Pages: <n> translated · <n> synced · <n> skipped · <n> failed (page × locale cells)

   ## Label sync
   <Step 1's report: patched uk/en entries, check binding, markup parts, broken, undocumented; or "nothing to sync">

   ## Pages
   | Page | Locale | Status | Changed (blob A → B) | Blocks | Unverified | Asset fallbacks | New terms | Ж1 hints |
   <one row per page per locale of this run>

   ## For a writer to decide
   - Failed cells: page, locale, the failing checks and the worker's note.
   - Unmapped blocks (with their UA text) and suspected UA source errors the workers reported.
   - Unverified labels: page, span, reason (`no-match` | `missing-in-locale`).
   - Term conflicts, and terms whose recorded translation a worker thought wrong.
   - Orphaned and moved pages; manual-bootstrap pages skipped; asset fallbacks to UA (no EN screenshot yet).
   - Link texts that name a page differently from its title (the `report --md` section of that name).

   ## Visual review
   <the `report --md` output: the ✓/✗ table and the URL list per locale, and the build result per locale>
   ```

   `Changed` is `full` for a page translated whole, otherwise the two short blob hashes (the source of "what changed", as `changed-blocks.md` requires).
3. Run the self-review below, then show the user: the totals line, the build result per locale, everything under "For a writer to decide" (shortened if long), and the path of `report.md`.

Don't commit or push: commits in the docs repo are the user's. List the changed paths by kind (locale pages, symlinks, `current.json` files, state files, term files, `.gitattributes`) and suggest one commit, for example `Translate <n> pages into <locales>`. If Step 1 left a new snapshot uncommitted, suggest its commit (`suggestedCommit`) first, as its own commit.

## Corrections after a run

A run that is already recorded is corrected block by block, never by re-translating whole pages. The workers do the translating, as in Step 5: a unit `<id> (page, redo <lines>)` makes a worker run `LS blocks <id> --redo <lines>`, translate only those blocks, `apply --redo`, check and record. The page stays `current`. Batch the redo units per locale as in Step 5, then run Step 6 for the touched pages. A page that isn't `current` in that locale (`upToDate: false`) goes through a normal run first.

- **A recorded term translation is wrong.** Write the corrected rows to `<run>/terms-fix-<locale>.json` and run `LS terms --add <file> --replace --locales <locale>` (`terms --drop <UA term>… --locales <locale>` for junk or superseded rows). For each `replaced` row, run `LS terms --usage <old translation> --locales <locale>` and save it to the run folder. Each page in it gives one unit, `<id> (page, redo <redo>)`, and each category gives `<id> (category, redo)`. Check the hits first: a match that is a different word with the same stem needs no redo, so leave its line out.
- **A label needs another key in one section.** Record the scoped decisions (`"<span>@<heading>": "label:<key>"`, Step 3) with `LS bind --decisions`. Then run `LS check <pages>` for every locale: each `labels` failure carries `redo`, the translation lines to redo. The locales where both keys show the same string pass and need nothing.
- **A link text names a page differently from its title.** The `check` warning (and `report --md`) gives the line. Redo it with the link row (P9). A mere inflection already passes the check.
- **Task titles are not in the locale's title form (P7).** Redo the `title` line of the frontmatter and the task headings (`--redo <line>`; a heading line redoes the heading alone). Then run `LS check` on the pages that link to them, and redo the link texts it warns about.

Tell each worker in its prompt which correction it applies (for example, "the term «Вхідна транзакція» is now `…`; rewrite only what that changes"), so it keeps the rest of each block's wording.

## Self-review before reporting

- [ ] The label check ran before anything else, and the run didn't continue on a failed check, import or a pending diff.
- [ ] Every `new` / `stale` cell from Step 2 has an outcome in a `results.jsonl` (translated, synced, skipped or failed). None is missing, and none was translated twice. Each locale's `results.jsonl` has one line per unit given to its workers: a file with fewer lines was overwritten by a later batch, so report the lost lines.
- [ ] `git status` shows no change in the UA content root, the EN i18n root, the label store or anywhere outside the locale roots, the locale `current.json` files, `<state root>/pages/`, `<state root>/terms/` and `.gitattributes`.
- [ ] Nothing was deleted or moved.
- [ ] Every failed cell kept its previous file and state.
- [ ] Every failure, unverified label, asset fallback, unmapped block, orphan, skipped page and term conflict is in the report.
- [ ] The build ran for every locale with a changed page, or the report says `--no-build`.
- [ ] Nothing in the run folder is staged for commit.

## Edge cases

- **No target locales** in `docusaurus.config.*` (only the default locale and `en`): stop and say that none are configured yet.
- **A docs locale that matches no locale file, or several** (`UL check` exit `2` with `unresolved`): ask once for the `Locale files:` mapping, show the `candidates`, offer to persist it. Never pick one.
- **A UA page deleted or moved:** listed as `orphaned` / `moved` by `status`. Report it; don't delete or move locale files or state.
- **A page whose translation no longer lines up with UA** (the worker reports `unmapped` changes and the page fails `structure`): it can't be updated block by block. Report it; the user can delete that locale's file, and the next run translates the page whole.
- **A category without entries in a locale's `current.json`** (`write-translations` not run for that locale): the worker skips it. Report "run `write-translations --locale <locale>`".
- **A worker reports `undecided` spans:** a page changed after Step 3 or was missed. Run Step 3 for that page, then that locale's unit again.
- **A locale with no row in the register table and no `Locale register:` entry:** the worker uses the formal "you" and reports it (`locale-translation.md`, R3). Put it in the report.

## Explicit invocation examples

This skill triggers only when the user names it or runs `/translate-locales`:

- `/translate-locales`
- `/translate-locales getting-started --locales tr,kk`
- `/translate-locales --dry-run`
- "Use locale-translator to update the locales for this branch."
- "locale-translator: translate the settings section into kk only."
- "locale-translator: correct the tg term «Вхідна транзакція» and redo the pages that use it."

If the user asks to translate into "all languages" or names a non-EN locale without naming this skill, suggest it and wait for an explicit go-ahead.
