---
name: locale-translator
description: Translates the approved UA pages of a docs repo into every further target locale the site declares (all locales except the default and en), block by block and only where UA changed since the last run. Runs the UI label check first, binds bold spans to the app's own UI strings once for all locales, keeps per-locale term memory, runs one worker per locale in parallel, links screenshots to EN, and records a page only when the scripted checks pass. Ends with a build and a per-page, per-locale report. Not for UA → EN (doc-translator). Use explicitly ("translate-locales", "use locale-translator to translate...").
---

# locale-translator

You are bringing the further locales of a documentation site up to date with its approved Ukrainian pages. No person reviews these translations, so correctness comes from the mechanism: UI labels come from the app's own dictionaries, terms come from term memory, scripts decide what to translate and check every page, and a page is recorded only when its checks pass. Your job is to run that mechanism, make the decisions only a model can make, and report.

Nobody decides after you either. The user answers for the UA and EN pages only, so no question about a further locale's wording goes to the user: every doubt ends in a decision of the run, in the order `locale-translation.md` T6 gives (the app's string, then term memory, then the run's own choice, recorded in term memory), and the report states it for information. The run asks only for declarations it is missing and for the go-ahead on a large run (Step 2, Step 6).

`LS` below means `node ${CLAUDE_PLUGIN_ROOT}/scripts/locale-sync/locale-sync.mjs` and `UL` means `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui-labels/ui-labels.mjs`. Run both from the docs repo root. Their READMEs (`${CLAUDE_PLUGIN_ROOT}/scripts/locale-sync/README.md`, `.../ui-labels/README.md`) document every field; read a section only when an output needs it.

## Scope

- **In scope:** every in-scope UA page and sidebar category (`_category_.json`) that is new or changed for at least one target locale, in every root pair the project declares (a root pair is one docs plugin instance: a UA content root with its own EN i18n root, URL prefix and locale files); writing the locale pages, the category entries in each locale's `current.json`, the screenshot symlinks, the page state and the term memory; the build and the report. Also corrections of recorded translations, block by block: a wrong term, a label that needs another key in one section, a link text or a task title (see "Corrections after a run").
- **Out of scope:**
  - UA → EN: `doc-translator`. The EN page is never read, used as a reference or modified here.
  - Writing or fixing UA content. The UA page is never modified, and a suspected error in it is reported, not fixed.
  - Docusaurus setup: registering locales, the locale dropdown, `code.json`, navbar and footer strings, site components. That is a one-time setup per repo.
  - Moving or deleting anything. Orphaned and moved pages, unreferenced symlinks and stale term entries are reported only.
  - Style review of the translations. No style corpus exists for these locales; quality comes from `locale-translation.md` and the worker's self-review.
  - Approval. The user runs this after the SME approved the UA version; the skill doesn't check approval.

## Sources to load

At the start of the run, only these:

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — resolve `UA content root:`, `EN i18n root:`, `UA URL prefix:`, any further root pairs (the same fields with a name in front, `<Name> UA content root:` …) and the fields in its "Label store and locale translation" section (`App:`, `Locale register:`, `Translation scope:`, `Toolkit state root:`, `UI label fallback:`). Target locales come from `docusaurus.config.*`, never from `CLAUDE.md`. The scripts read the root pairs themselves; you only need them to describe the run.
2. `${CLAUDE_PLUGIN_ROOT}/context/ui-labels.md` — the label check, run in the column for `locale-translator`.

Each translation worker loads `${CLAUDE_PLUGIN_ROOT}/skills/locale-translator/worker.md` and `${CLAUDE_PLUGIN_ROOT}/context/locale-translation.md` itself. Don't load those, the label store files, the term-memory files, EN pages or whole UA pages into your own context: the scripts hand out exactly the rows and blocks each step needs.

## Arguments

All optional. Without arguments the run covers every in-scope page that is stale in any target locale, in every declared root pair.

- `<page|folder>…` — narrow the run to these pages or folders (ids or paths, relative to the repo or the UA content root). With more than one root pair, an id is `<pair>:<id>` (`primary:getting-started/getting-started`), as `status` prints it; a path from the repo root needs no prefix.
- `--pair <id>[,<id>]` — narrow the run to these root pairs. The unprefixed pair is `primary`; another pair's id is its name in lower case with dashes (`API reference` → `api-reference`), as `status` lists it in `pairs[]`.
- `--locales tr,kk` — narrow the run to these target locales.
- `--dry-run` — status only: the label check's `check` step (nothing imported or synced) and Step 2's table. Nothing is written.
- `--overwrite` — also translate pages that have a locale file but no recorded state (a manual bootstrap). Their files are replaced.
- `--ticket <n>` — the ticket whose frontend branches overlay the label store, when the branch name doesn't start with it.
- `--worker-model <model>` — the model for the translation workers (default: the session's model).
- `--no-build` — skip the build in Step 7. Only for quick iterations; say in the report that no build ran.

Pass `<page|folder>…`, `--pair`, `--locales` and `--overwrite` to every `LS` call that takes them. Never pass `--pair` to the label check (`UL`): it patches renamed labels in every pair, and a sync narrowed to one pair leaves the diff pending.

**Unit ids.** With more than one root pair declared, the scripts print every page and category id as `<pair>:<id>`, so two pages with the same path in two pairs (`primary:transactions/transactions`, `api-reference:transactions/transactions`) are never confused. Use those ids as they are everywhere: in `LS` calls, the decisions file, the worker prompts, `results.jsonl` and the report. A host with one pair has bare ids.

## Workflow

### Step 0 — Declarations and the run folder

1. Resolve the declarations through `project-paths.md`. If `App:` or `UI label source:` is missing, ask once and offer to persist the answer. Whenever a script exits `2`, it names what is missing (`missing`, `unresolved`): no target locales configured yet → stop and say so; a page or folder that two root pairs have (`ambiguous`) → show its `candidates` and ask which one is meant, never pick one; anything else → ask once and offer to persist the answer, then run the step again.
2. Unless `--dry-run`, create the run folder `<state root>/.run/<YYYYMMDD-HHMM>/`. If `<state root>/.run/.gitignore` doesn't exist, write it with the single line `*`, so nothing in `.run/` is ever committed. Every working file of the run (bind output, decisions, terms, candidates, unverified lists, worker results, the report) goes in the run folder.

### Step 1 — UI label check (required)

Follow `ui-labels.md` in its `locale-translator` column, passing `--ticket` if given. A translation never runs on an unchecked snapshot: when `check` or `import` fails, or `sync` leaves the diff pending, stop and report. `sync` runs without `--commit`. When it patched pages or categories, show its report and its `suggestedCommit`, ask the user to make that commit, and stop: run the skill again afterwards (`ui-labels.md`, step 6). When only the snapshot changed, continue. Keep the sync report (patched, check binding, markup parts, broken, undocumented, suggested commit) for Step 7.

In this skill the sync report is sorted by who owns each entry, whether the run stops here or goes on:

- **UA and EN notes, for the user:** the `uk` and `en` entries, and `checkBinding`, `markupParts` and `broken`. Each of these is settled in the UA page, which only the user changes.
- **For information:** the entries that concern a further locale only (`patched`, `notFound`, `unpatched` for that locale). The further locales follow the app's strings and the UA page; nothing about their wording is asked.

Unless `--dry-run`, then record what is already dirty in the repo, so Step 7 can tell the run's strays from the user's own work: `LS stray --save <run>/baseline.json`.

With `--dry-run`, run `UL check` only and report whether an import and sync are due.

### Step 2 — What to translate

1. Run `LS status` and save the output to the run folder (with `--dry-run`, don't save it).
2. Read `summary`, `warnings`, `orphaned` and `moved`:
   - **Nothing new or stale** (`summary.pageTranslations` and `summary.categories.translations` are 0): report "all locales are up to date", with any warnings, orphans and skipped pages, and stop.
   - **Uncommitted UA changes** (a warning): only the committed version is translated. Say so once; don't commit for the user.
   - **`base-missing`** warnings: those cells are re-translated in full. Mention them.
   - **`skipped` cells** (`manual-bootstrap`): left alone; list them and mention `--overwrite`.
3. Show the user a short table: per locale, how many pages and categories are `new` / `stale`, and `summary.message`. With more than one root pair (`pairs[]`), add one line per pair from `summary.byPair`, by the pair's name, so the user sees which section the work is in.
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

   **One span, two controls on one page.** An ask among keys with different strings may list `sections`: the headings the span occurs under. When the contexts show the span naming different controls in different sections (a tab in one, a switch in another), decide the page-level span for the meaning most occurrences have, and add `"<span>@<heading>": "label:<other key>"` for each heading where the other control is meant (the heading's title or its `#anchor`, as `sections` gives them). A scoped decision covers that section and its subsections. If one section names both controls, a scoped decision can't separate them: decide for the meaning that section mostly has, and list that decision in the report for information.
3. Write `{ "<page>": { "<span>": "<decision>" } }` to `<run>/decisions.json` and run `LS bind --decisions <run>/decisions.json`. Fix and resubmit anything `rejected`.
4. Run `LS bind` again (with the same narrowing): `summary.ask` must be 0.

### Step 4 — Terminology pass (once per locale)

1. Collect the run's terms, in dictionary form (nominative singular, trailing punctuation dropped):
   - every span decided `term` or `unverified` in Step 3, except markup spans (their parts come from the label store) and spans that aren't noun phrases (a sentence, a quoted message);
   - the generic UI nouns that the units' UA files contain (find them with a grep, don't read the files): кнопка, поле, вкладка, меню, вікно, стовпець, колонка, прапорець, перемикач, список, іконка, віджет, панель, сторінка, розділ. Each locale then uses one word per element type (`locale-translation.md`, L2).
2. Run `LS terms <term>… --locales <targets>` and save the output. For each locale, every term in `missing` gets an entry. A term with a `ui` string for the locale takes that string, with no translation needed (T1).
3. Translate each locale's other missing terms (noun phrases in dictionary form, following that locale's rules in `locale-translation.md` §5–§7; read those sections only for this). Write `<run>/terms-<locale>.json` (`{ "<UA term>": "<translation>" }`) and run `LS terms --add <run>/terms-<locale>.json --locales <locale>`. A `conflict` there means the term is already recorded: the recorded translation stays (T2). Never overwrite a recorded term in this step, except as below.
4. Settle what the lookup shows, without asking (T6):
   - **The app's string differs from the recorded one** (a term with a `ui` string for the locale and a different `recorded` value, usually because the app renamed it): the app's string wins (T1). Write it to `<run>/terms-fix-<locale>.json` and run `LS terms --add <file> --replace --locales <locale>`, so the memory agrees with the app.
   - **A term recorded on two lines** (`conflicts` of the lookup: `used` and `ignored`, after a merge of two branches): keep `used`, which every page has been reading. Run `LS terms --drop <UA term> --locales <locale>`, then add the `used` translation back with `terms --add`.
   - Keep each old translation that this replaced or dropped (`old`, `ignored`) for Step 6: the pages that still use it are aligned there.

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

   Each `<id>` is the unit's id exactly as `status` printed it (`<pair>:<id>` when the host has several root pairs).

3. When a worker finishes, start that locale's next batch, until every queue is done. A locale whose worker fails or stops keeps its previous files and state; the other locales go on.
4. If the run is interrupted, run it again: `status` shows what is still stale, because every page passed and recorded is `current`.

Don't translate, check or record pages yourself, and don't read the workers' candidate files. Their results are in `<run>/<locale>/results.jsonl`, one line per unit.

### Step 6 — Settle what the workers flagged

Workers keep to the rules and flag what they doubt. Nobody reviews a further locale after the run, so decide every flag here, in the order of `locale-translation.md` T6, and list each decision in the report for information. Read every `results.jsonl` (`termFlags`, `linkTitles`, `notes`); still don't read the candidate files.

1. **Terms.** For each `termFlags` entry, run `LS terms <UA term> --locales <locale>` (add the UA plural when the app may name the concept in the plural, as a menu or a tab does) and decide:
   - The app shows a string for this term in the locale (`ui`; reason `app` says so) → that string (T1).
   - The recorded translation is the app's word for another concept (T5) → your own translation, checked against the UI strings and term rows in the lookup.
   - Otherwise the recorded translation stays (T2). Reading better is no reason to change it, and a worker never writes another word.

   A changed translation goes in with `LS terms --add <file> --replace --locales <locale>`. Then align the pages, for every old word: each translation replaced or dropped here or in Step 4, and each other word a worker saw for a recorded term (`reason: "other-word"`). Run `LS terms --usage <old word> --locales <locale>`, check the hits (a hit that means something else is left out), and give each page one redo unit, `<id> (page, redo <redo>)`, and each category `<id> (category, redo)`, as in "Corrections after a run".
2. **Link texts.** Each `linkTitles` entry is a line outside the blocks a worker translated whose link text names a page differently from its title. It takes the page's title (P9): one redo unit per page with those lines.
3. **Run the redo units** through the workers as in Step 5, batched per locale, each prompt saying which correction it applies. If they cover more pages than the confirmation threshold (`summary.threshold` of `status`, normally 10), show the size and wait for the go-ahead, as in Step 2: a question about the size, never about wording. Without it, the term decisions stay recorded, and the report lists the pages that still use the old word, for information. Flags from these redo units are decided the same way, with no second redo round: what they would still change is listed for information.
4. **Everything else** a worker flagged already has its rule; list it for information: an unverified label (L4, written through term memory), a locale with no register or title-form row (R3, P7), an app string that looks wrong (L1: written verbatim; worth telling the app's team), a binding that reads oddly (the recorded decision stands; it changes only through "Corrections after a run"). A suspected error in the UA source is not decided here: it is a UA note for the user.

### Step 7 — Build and report

1. Unless `--no-build`, run `LS report <pages> --build --md` in the background (each locale build can take minutes) and save the output. `<pages>` are the ids of every page translated, synced or redone in this run: pages only, since a category has no page of its own, and none when only categories changed. It builds each locale with a changed page and gives, for every in-scope page and locale, ✓/✗ for "page exists", "all images resolve" and "checks passed", plus the local URLs of the changed pages. With `--no-build`, run it without `--build`. When the run was narrowed to pages or folders, also pass them as `--scope <comma-separated>`, so the tables cover the run's pages and not every untranslated page outside it.
2. Read every `results.jsonl` and write the run report to `<run>/report.md`:

   ```
   # Locale translation — <App> — <date>

   Branch: <branch> · Locales: <list> · Root pairs: <the pairs of the run, by name; omit with one pair> · Label snapshot: <repo>@<sha7> (<new snapshot, uncommitted | unchanged>)
   Pages: <n> translated · <n> synced · <n> skipped · <n> failed (page × locale cells)

   ## Label sync
   <Step 1's report: patched uk/en entries, check binding, markup parts, broken, undocumented; or "nothing to sync">

   ## Pages
   | Page | Locale | Status | Changed (blob A → B) | Blocks | Unverified | Asset fallbacks | New terms | Ж1 hints |
   <one row per page per locale of this run>

   ## Not recorded
   - Failed cells: page, locale, the failing checks and the worker's note. The locale keeps its previous file and state, and the next run tries again.
   - Unmapped blocks, with their UA text. A page whose translation no longer lines up with UA is translated whole once its locale file is removed (Edge cases); the run deletes nothing.

   ## UA and EN notes
   <for the user, who owns the UA and EN pages: suspected errors in the UA source that workers reported (P6), with page and UA text; the label sync's UA and EN notes (Step 1); or "none">

   ## Decided by the run
   For information: nothing here needs an answer. One line per decision, with its rule:
   - Unverified labels: page, span, reason (`no-match` | `missing-in-locale`), written through term memory (L4).
   - Terms: new terms recorded; recorded terms kept against a worker's doubt (T2), replaced by the app's string (T1) or for another concept (T5); terms recorded twice, settled; the pages aligned by a redo, or still using an old word when the go-ahead for a large redo didn't come.
   - Link texts aligned with the page title (P9), and those in the `report --md` section of that name still left (lines no block of this run touched).
   - Spans decided for the meaning a section mostly has (Step 3); locales with no register or title-form row (R3, P7); app strings that look wrong, written verbatim (L1); the label sync's entries for further locales (Step 1).

   ## Housekeeping
   - Orphaned and moved pages; manual-bootstrap pages skipped (`--overwrite` translates them); asset fallbacks to UA (no EN screenshot yet); stray files. Nothing was deleted or moved.

   ## Visual review
   <the `report --md` output: the ✓/✗ table and the URL list per locale, and the build result per locale>
   ```

   `Changed` is `full` for a page translated whole, otherwise the two short blob hashes (the source of "what changed", as `changed-blocks.md` requires).
3. Run `LS stray --baseline <run>/baseline.json` and save the output. It lists every file changed or created outside the places a run writes to (the locale roots, the locales' `current.json`, the state root, `.gitattributes`): scratch files a worker left in the repo. Delete nothing; list the paths under "Housekeeping" with the worker's locale if the file name shows it, and tell the user to remove them. An `empty` file is certainly a leftover.
4. Run the self-review below, then show the user: the totals line, the build result per locale, "Not recorded", "UA and EN notes" and "Housekeeping" (shortened if long), the number of decisions under "Decided by the run", and the path of `report.md`. Ask nothing about a further locale's wording.

Don't commit or push: commits in the docs repo are the user's. List the changed paths by kind (locale pages, symlinks, `current.json` files, state files, term files, `.gitattributes`) and suggest one commit, for example `Translate <n> pages into <locales>`. If Step 1 left a new snapshot uncommitted, suggest its commit (`suggestedCommit`) first, as its own commit.

## Corrections after a run

A run that is already recorded is corrected block by block, never by re-translating whole pages. The workers do the translating, as in Step 5: a unit `<id> (page, redo <lines>)` makes a worker run `LS blocks <id> --redo <lines>`, translate only those blocks, `apply --redo`, check and record. The page stays `current`. Batch the redo units per locale as in Step 5, then run Step 7 for the touched pages. A page that isn't `current` in that locale (`upToDate: false`) goes through a normal run first.

- **A recorded term translation is wrong.** Write the corrected rows to `<run>/terms-fix-<locale>.json` and run `LS terms --add <file> --replace --locales <locale>` (`terms --drop <UA term>… --locales <locale>` for junk or superseded rows). For each `replaced` row, run `LS terms --usage <old translation> --locales <locale>` and save it to the run folder. Each page in it gives one unit, `<id> (page, redo <redo>)`, and each category gives `<id> (category, redo)`. Check the hits first: a match that is a different word with the same stem needs no redo, so leave its line out.
- **A label needs another key in one section.** Record the scoped decisions (`"<span>@<heading>": "label:<key>"`, Step 3) with `LS bind --decisions`. Then run `LS check <pages>` for every locale: each `labels` failure carries `redo`, the translation lines to redo. The locales where both keys show the same string pass and need nothing.
- **A link text names a page differently from its title.** The `check` warning (and `report --md`) gives the line. Redo it with the link row (P9). A mere inflection already passes the check.
- **Task titles are not in the locale's title form (P7).** Redo the `title` line of the frontmatter and the task headings (`--redo <line>`; a heading line redoes the heading alone). Then run `LS check` on the pages that link to them, and redo the link texts it warns about.

Tell each worker in its prompt which correction it applies (for example, "the term «Вхідна транзакція» is now `…`; rewrite only what that changes"), so it keeps the rest of each block's wording.

## Self-review before reporting

- [ ] The label check ran before anything else, and the run didn't continue on a failed check, import or a pending diff.
- [ ] Every `new` / `stale` cell from Step 2 has an outcome in a `results.jsonl` (translated, synced, skipped or failed). None is missing, and none was translated twice. Each locale's `results.jsonl` has one line per unit given to its workers: a file with fewer lines was overwritten by a later batch, so report the lost lines.
- [ ] `LS stray --baseline` reported nothing, or every path it reported is in the report. (It covers the UA content root, the EN i18n root and anything else outside the locale roots, the locale `current.json` files, the state root and `.gitattributes`.)
- [ ] With more than one root pair, every page id in the worker prompts and the report is qualified (`<pair>:<id>`), and the report covers every pair of the run.
- [ ] Nothing was deleted or moved.
- [ ] Every failed cell kept its previous file and state.
- [ ] Every failure, unverified label, asset fallback, unmapped block, orphan, skipped page and term conflict is in the report.
- [ ] Every `termFlags` and `linkTitles` entry and every term conflict has a decision under "Decided by the run", with its rule. The report and the message to the user ask nothing about a further locale's wording; the only questions of the run are missing declarations and the size go-ahead (Step 2, Step 6).
- [ ] The build ran for every locale with a changed page, or the report says `--no-build`.
- [ ] Nothing in the run folder is staged for commit.

## Edge cases

- **No target locales** in `docusaurus.config.*` (only the default locale and `en`): stop and say that none are configured yet.
- **A docs locale that matches no locale file, or several** (`UL import` exit `2` with `unresolved`): ask once for the `Locale files:` mapping, show the `candidates`, offer to persist it. Never pick one.
- **A UA page deleted or moved:** listed as `orphaned` / `moved` by `status`. Report it; don't delete or move locale files or state.
- **Two root pairs with a page of the same id:** each has its own state, locale files and URL, and `status` lists both, qualified. A warning that a primary state "records the UA blob of" the other pair's page means an earlier run was pointed at the other pair's roots: report it. The state stays with the primary page.
- **A declared root pair that the project doesn't translate into further locales:** its `<Name> Translation scope:` is `none`, so no run covers it. If `status` shows a pair the user didn't expect to translate, say so before Step 3 and wait: the declaration is the project's decision.
- **A page whose translation no longer lines up with UA** (the worker reports `unmapped` changes and the page fails `structure`): it can't be updated block by block. Report it; the user can delete that locale's file, and the next run translates the page whole.
- **`status` warns that a locale's `current.json` keeps Ukrainian category labels** (`sidebarLabels[]`): `write-translations` filled the file with the UA labels of an autogenerated sidebar, and Docusaurus prefers them to the translated titles of the section pages, so the sidebar shows UA in that locale. The categories that have a `_category_.json` aren't meant: those are translated by this skill. For the others, report the file and tell the user to delete it (Docusaurus then takes the labels from the section page titles, as in EN); don't delete it and don't translate the entries here.
- **A category without entries in a locale's `current.json`** (`write-translations` not run for that locale): the worker skips it. Report "run `write-translations --locale <locale>`".
- **A worker reports `undecided` spans:** a page changed after Step 3 or was missed. Run Step 3 for that page, then that locale's unit again.
- **A locale with no row in the register table and no `Locale register:` entry:** the worker uses the formal "you" and reports it (`locale-translation.md`, R3). Put it under "Decided by the run".

## Explicit invocation examples

This skill triggers only when the user names it or runs `/translate-locales`:

- `/translate-locales`
- `/translate-locales getting-started --locales tr,kk`
- `/translate-locales --dry-run`
- `/translate-locales --pair api-reference --dry-run`
- "Use locale-translator to update the locales for this branch."
- "locale-translator: translate the settings section into kk only."
- "locale-translator: correct the tg term «Вхідна транзакція» and redo the pages that use it."

If the user asks to translate into "all languages" or names a non-EN locale without naming this skill, suggest it and wait for an explicit go-ahead.
