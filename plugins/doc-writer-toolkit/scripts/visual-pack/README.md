# visual-pack

Builds one visual review sheet for a docs repo: every docs page a git range changed, in every locale, on one HTML page. Rows are pages, columns are locales, each cell is a screenshot. The automatic findings are on top: broken images, tables wider than the page, text left untranslated. Node, no dependency of its own. No AI is involved: the model reads the short summary on stdout and looks at a screenshot only to fix a flagged problem.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/visual-pack/visual-pack.mjs --range origin/main...HEAD [options]
```

Run it from the docs repo (or pass `--root`) with the branch checked out: the working tree is the end of the range, and it is what gets built. Needs Node 18.3+, `git`, and the docs repo's own Playwright and Chromium (`@playwright/test` or `playwright` in its `node_modules`, `npx playwright install chromium`). A host without Playwright gets a clear error (exit 2) before anything is built. Tests: `npm test` in this folder (see "Tests").

## What it does

1. **Changed pages.** `git diff --name-only --diff-filter=ACMR` for the range. A Markdown file under a UA content root or under a locale's content root (the EN i18n root with `en` replaced by the locale) is a page; the same page changed in several locales is one row. Files with a path segment that starts with `_`, and files that are not Markdown, are not pages. A page deleted in the range has no row. A changed image has no row either: change the page that shows it.
2. **The build.** `node_modules/.bin/docusaurus build --out-dir <out>/build --locale <every column>` in the docs repo, one run for all columns so the default locale lands at the base URL and the others under `<locale>/`. The build writes the host's `.docusaurus/` and caches, as any build of the site does. `--build-dir` takes an existing build instead and skips this.
3. **The server.** A static server on `127.0.0.1` and a free port, for the build folder, with the paths Docusaurus builds (`<path>/index.html`, `<path>.html`, the `404.html` page).
4. **The captures.** Chromium opens each changed page in each locale at 1280×800, loads the lazy images, reads the page's DOM and saves a full-page PNG (cut at `--max-height`). Each wait of a view, its load and its screenshot, may take up to `--timeout`; no wait keeps Playwright's own 30 s. **Every request that isn't to the local server is blocked and counted**: a route handler aborts it, and Chromium is started with a host resolver that resolves nothing but `127.0.0.1`, so a request that got past the handler would fail too.

   **One retry, with more time.** When every view has had its turn, each view that failed to capture (an error or a timeout, not a 4xx or 5xx answer) is captured once more. Each of its waits may take `--retry-timeout` (default 4 × `--timeout`, so 120 s; see below for a large `--timeout`), and two views are captured at a time (one with `--jobs 1`), half the first pass's default load. The result says so. A view that answered 4xx or 5xx is not tried again, and a view that fails again is reported as it would be without the retry.

   **The retry's time is capped** by `--retry-budget` (default 30 min). The retry starts a view only while that view's worst case still ends within the budget: 2 × `--retry-timeout` + 13 s (the load, the screenshot, and the 5 s network-idle and 8 s image waits). A view it cannot start stays as first reported, its cell says `retrySkipped`, and `summary.notRetried` counts it. `--retry-budget 0` turns the retry off: nothing is tried again and nothing about a retry is printed.

   **A large `--timeout` keeps the retry useful.** Unless `--retry-timeout` is given, its default is held so that one view's worst case is at most a sixth of the budget, and it is never below `--timeout`. At the defaults that changes nothing: 120 s gives a 253 s worst case, under 300 s. With `--timeout 60000` it is 143.5 s instead of 240 s. With `--timeout 180000`, the value the measured pack's session used, it stays at 180 s: each view's worst case is then 373 s, and two at a time the retry still has room for eight views even if every one runs to its worst case, and for many more when they don't. A `--retry-timeout` given whose one view could not fit the budget is refused (exit 2), rather than a retry that tries nothing.

   **A browser that died ends the run** (exit 3, no sheet), checked after the first pass and after the retry: its views would all fail and read as that many pages missing. A context that fails while the browser lives is that view's error.

   **The worst case of a whole pack** is the first pass, ⌈views ÷ `--jobs`⌉ × (2 × `--timeout` + 13 s), plus the budget, plus the build when the pack runs it. For 80 views at the defaults that is 20 × 73 s ≈ 24 min, plus 30 min, plus the build (17–34 min on the largest site measured): about 1.5 h, well under the 4 h a ticket-flow session may run. The wait for the page's fonts runs inside the page and takes no Playwright timeout: a page whose fonts never load is the one case outside this bound.

   **Why these numbers.** In the measured pack, two views at a time captured 63 of 80 even with the screenshot held to 30 s, and each of the 17 left failed on that 30 s. 120 s a wait gives such a view four times the room. 30 min covers 44 failed views, two at a time, at up to about a minute each.

   **Run the pack once.** Run it again, once, only after exit 3 (a crash, or Chromium closed), or after exit 2 once its cause (a flag) is fixed; exit 1, the build failed, is recorded as failed with the build error, not run again. A view still `page-missing` after the retry is a finding, not a reason to run the pack again.
5. **The findings,** from the DOM and the same page in the default locale (the reference, always a column):

| Finding | Level | Rule |
|---|---|---|
| `page-missing` | fix | The page answered 4xx or 5xx in a locale, or could not be captured, on the retry too. |
| `broken-image` | fix | An image in the article that did not load: the site answered 4xx or 5xx, the request was blocked because it is not local, or the image could not be decoded. An SVG with no size of its own that the site served is fine. |
| `table-overflow` | fix | A table whose content is wider than the room its container gives it, or that ends past the right edge of the window. |
| `untranslated` | fix | See below. |
| `page-overflow` | look | The page scrolls sideways and no table is the cause. |
| `kept-label` | look | A bold label identical to the source's (the app's string wins over a translation, T1), or a Ukrainian bold label in a Latin-script page. Check it against the app. |

   **Untranslated text** is decided per block (paragraph, list item, heading, table cell, outside code blocks), with no model:

   - **`identical`**: the block is word for word the default locale's block, and it is prose: three words and a dozen letters outside its bold and code spans, mostly in the source's script. This works for every locale. It is the only signal that works for Kazakh, which shares the letter `і` with Ukrainian, and for the Latin-script locales, where "Cyrillic present" says nothing about whether the text is translated.
   - **`cyrillic-in-latin`**: a mostly Cyrillic block in a Latin-script locale (English, Spanish, Turkish, Uzbek, Azerbaijani and the other Latin locales the script knows).
   - **`ukrainian-letters`**: `ї`, `є` or `ґ` in a Cyrillic locale that is not Ukrainian (Russian, Kazakh, Kyrgyz, Tajik). Never `і`.
   - **No file**: the locale has no file for the page, so the site shows the default locale's text.
   - A locale whose script the script doesn't know gets only `identical`. One finding per page and locale lists up to five blocks.

6. **The sheet.** `<out>/sheet.html`, with the screenshots in `<out>/shots/<locale>/` next to it (relative links: keep them together). `<out>/report.json` holds the same data as the `--json` output. `<out>/.gitignore` (`*`) is written once, so a `git add -A` in the host never picks up the host's own pages as screenshots.

## Settings

Declared in the `Documentation toolkit configuration` block of `<root>/CLAUDE.md` (the fields are in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Visual review pack"); a flag overrides its field. The roots and the state root are read by the same reader as `ui-labels`, `locale-sync` and `screenshot-locales`, so a host with more than one root pair is covered (a page is shown as `<pair>:<path>`).

| Flag | Field | |
|---|---|---|
| `--range <git range>` | | Required. The commits whose pages to show. |
| `--ua-root`, `--en-root`, `--url-prefix`, `--pair` | `UA content root:`, `EN i18n root:`, `UA URL prefix:` (and the named pairs) | Where the pages are, and the route they get. |
| `--state-root <dir>` | `Toolkit state root:` | Default `.doc-toolkit`. The output is `<state root>/visual-pack/`. |
| `--base-url <path>` | `Site base URL:` | The site's `baseUrl`. Without a flag or field it is read from `docusaurus.config` when that is a string literal, else `/`. |
| `--locales <list>` | | The columns. Default: every locale in `docusaurus.config`. The default locale is always a column. Without a `docusaurus.config`, the first locale listed is the default one. |
| `--docusaurus-config <file>` | | Default: `docusaurus.config.{ts,js,mjs,cjs}` in the root. |

Other flags: `--root <dir>` (default: the working folder), `--build-dir <dir>`, `--out <dir>`, `--viewport <WxH>` (default `1280x800`), `--max-height <px>` (default `8000`), `--jobs <n>` (pages captured at once, default `4`), `--timeout <ms>` (how long each wait of a page view may take, its load and its screenshot, default `30000`), `--retry-timeout <ms>` (the same on the retry, default 4 × `--timeout` held to a sixth of the budget, never less than `--timeout`), `--retry-budget <ms>` (the longest the retry may take in all, default `1800000`; `0` turns the retry off; an empty value is refused), `--dry-run` (list the pages and their URLs; no build, no browser), `--json`, `-h`.

**Where Playwright is.** `--playwright-from <dir>`, or the environment variable `VISUAL_PACK_PLAYWRIGHT_FROM`, names a folder whose `node_modules` holds Playwright. The default is the docs repo itself. The script loads Playwright from there (`playwright`, then `playwright-core`, then `@playwright/test`), so it needs no dependency of its own. With `DOC_TOOLKIT_ROLE_SESSION` set (a ticket flow role session; the runner sets it), the flag is refused, since it runs JavaScript from that folder.

## Output

A short summary on stdout, which is all a model needs to read: the counts, one line per finding (a finding that repeats in several locales of a page is one line with the locales listed), the network count, the times and the sheet's path. `--json` prints the report instead, and `report.json` always has it.

When a view failed to capture, a `Retry:` line follows the counts, and the time line gives the retry's share; a pack where every view was captured on its first try prints neither. When the budget ran out, the line ends with the views not tried again:

```
visual-pack: 8 pages × 10 locales (uk, en, …); 78 captured, 2 not.
Retry: 9 page views that failed to capture were captured once more, with more time: 7 captured, 2 not.
…
Time: build skipped (existing build), capture 412.6 s (the retry 95.3 s of it).
```

```
visual-pack: 3 pages × 3 locales (uk, en, ru); 9 captured, 0 not.
Findings: 8 to fix, 1 to look at.
  broken-image 3 · table-overflow 3 · untranslated 2 · kept-label 1
  ! Broken image: primary:guide/01-payments.md [uk, en, ru] 2 of 3 images do not show (/img/missing.png: the site answered 404)
  ! Text left untranslated: primary:guide/limits.md [ru] no file in this locale: the site shows the uk text
  ? Bold label kept as the source has it: primary:guide/limits.md [en] 1 block with a bold label the same as the source; …
Network: 27 local requests, 9 blocked (not local).
Time: build skipped (existing build), capture 2.6 s.
Sheet: .doc-toolkit/visual-pack/sheet.html
```

The report: `ok`, `range`, `defaultLocale`, `columns`, `baseUrl`, `pages[]` (`key`, `changedIn`, `urls`, and per locale `status`, `shot`, `error`, `retried`, `firstError`, `retrySkipped`, `title`, `images`, `tables`), `findings[]` (`type`, `level`, `page`, `locale`, `detail`, `items`), `summary` (`pages`, `locales`, `captured`, `notCaptured`, `retried`, `capturedOnRetry`, `notRetried`, `findings` with `problems`, `look` and `byType`), `network` (`requests`, `local`, `blocked`, `blockedHosts`, `servedByLocalServer`), `timings` (`buildSeconds`, `captureSeconds`, `retrySeconds`, `totalSeconds`), `sheet`.

- **The retry's fields.** `retried` is `true` for a view captured a second time, and `firstError` is then the first try's error; `error`, `status` and `shot` are the second try's. `summary.retried` counts those views, `summary.capturedOnRetry` how many of them the retry captured, and `summary.notRetried` the views that failed but were not tried again because the budget ran out (each stays as first reported, with `retrySkipped` in its cell). `timings.retrySeconds` is the second pass, inside `captureSeconds`, and `null` when no view needed it. The network counts include the retry's requests. The sheet notes a cell captured on the second try, not captured twice, or not tried again.

Exit codes: `0` sheet written, nothing to fix · `10` sheet written, with findings to fix (things to look at alone give `0`) · `1` the build failed · `2` a missing declaration or flag, no Playwright or Chromium, or a bad range · `3` unexpected error, or Chromium closed during the captures. No changed page in the range is one line and exit `0`.

**What the screenshots leave out.** Because only the local server is answered, anything a page loads from elsewhere is missing: web fonts from a font service, icons an icon component fetches from a public API, embedded videos. `network.blockedHosts` lists them. They are not findings, and an image from another host is reported as broken (the request was blocked), since the page would not show it offline either. The sheet is for layout and content, not for pixel fidelity.

## No model call

The script spawns two kinds of process: `git` and the host's own `docusaurus`, and it opens Chromium through Playwright. Nothing in it starts or calls a model. Its network is the local server: every other request is aborted and counted (`network.blocked`, `network.blockedHosts`). The tests prove both (see below).

## Tests

`npm test` runs `test/offline.test.mjs`, then `test/browser.test.mjs` when it can launch Chromium. `npm run test:offline` runs the first alone.

- **Offline** (no browser): the page and route mapping (number prefixes, `index`, `slug`, `id`, root pairs, the base URL), changed files from a throwaway git repo, the findings rules, the untranslated-text rule per locale (Russian, Kazakh, Kyrgyz, Tajik, English, Turkish, Uzbek, Azerbaijani, Spanish), the sheet writer and its escaping, the local server, the settings, and the command line up to the browser. A `claude` stand-in on `PATH` records any call.
- **Browser** (a fixture site in the layout `docusaurus build` writes, with a broken image and a wide table): the sheet flags both (AC-1); no `claude` call, and a request to another host, or to another port on `127.0.0.1` that records every hit, is blocked and counted (AC-2).
- **The timeout and the retry.** A second fixture page holds its screenshot back for as long as the test says, and nothing else of its capture:
  - a 34 s hold with `--timeout 60000` is captured, where Playwright's own 30 s used to fail it (about 35 s of the run);
  - an 8 s hold with `--timeout 3000` fails, then is captured on the retry with `--retry-timeout 30000`;
  - a hold longer than both timeouts fails twice and is `page-missing` with the retry's screenshot timeout, the first try's kept as `firstError`;
  - a page that answers 404 is not tried again.

  Offline, a stand-in browser shows:
  - views that fail once are captured on the retry, after all the first tries, two at a time (one with `--jobs 1`), each wait with `--retry-timeout`;
  - the budget: views whose worst case no longer fits are not tried again and stay as first reported;
  - a budget of `0` is no retry at all: nothing tried, nothing logged or printed, `retrySeconds` null;
  - a browser that died ends the run with exit 3, after the first pass or during the retry; a context that fails while the browser lives is that view's error;
  - the settings: the retry timeout's default, held to a sixth of the budget and never below `--timeout`; a `--retry-timeout` that cannot fit the budget, and an empty `--retry-budget`, refused;
  - the timeout reaches the screenshot and every other wait;
  - a pack with no view retried prints the same summary as before.
- **No Playwright, no pass.** Without Playwright and Chromium the browser test is not run, and `npm test` prints why and exits `2` after the offline tests passed. `tools/regression.mjs` shows that as `not run`, which fails the run unless `--allow-not-run` is passed. `VISUAL_PACK_PLAYWRIGHT_FROM` names where Playwright is. CI installs it in its own job.
