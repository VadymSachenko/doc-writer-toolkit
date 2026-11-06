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
4. **The captures.** Chromium opens each changed page in each locale at 1280×800, loads the lazy images, reads the page's DOM and saves a full-page PNG (cut at `--max-height`). **Every request that isn't to the local server is blocked and counted**: a route handler aborts it, and Chromium is started with a host resolver that resolves nothing but `127.0.0.1`, so a request that got past the handler would fail too.
5. **The findings,** from the DOM and the same page in the default locale (the reference, always a column):

| Finding | Level | Rule |
|---|---|---|
| `page-missing` | fix | The page answered 4xx or 5xx in a locale, or could not be captured. |
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

Other flags: `--root <dir>` (default: the working folder), `--build-dir <dir>`, `--out <dir>`, `--viewport <WxH>` (default `1280x800`), `--max-height <px>` (default `8000`), `--jobs <n>` (pages captured at once, default `4`), `--timeout <ms>` (per page, default `30000`), `--dry-run` (list the pages and their URLs; no build, no browser), `--json`, `-h`.

**Where Playwright is.** `--playwright-from <dir>`, or the environment variable `VISUAL_PACK_PLAYWRIGHT_FROM`, names a folder whose `node_modules` holds Playwright. The default is the docs repo itself. The script loads Playwright from there (`playwright`, then `playwright-core`, then `@playwright/test`), so it needs no dependency of its own. With `DOC_TOOLKIT_ROLE_SESSION` set (a ticket flow role session; the runner sets it), the flag is refused, since it runs JavaScript from that folder.

## Output

A short summary on stdout, which is all a model needs to read: the counts, one line per finding (a finding that repeats in several locales of a page is one line with the locales listed), the network count, the times and the sheet's path. `--json` prints the report instead, and `report.json` always has it.

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

The report: `ok`, `range`, `defaultLocale`, `columns`, `baseUrl`, `pages[]` (`key`, `changedIn`, `urls`, and per locale `status`, `shot`, `error`, `title`, `images`, `tables`), `findings[]` (`type`, `level`, `page`, `locale`, `detail`, `items`), `summary` (`pages`, `locales`, `captured`, `notCaptured`, `findings` with `problems`, `look` and `byType`), `network` (`requests`, `local`, `blocked`, `blockedHosts`, `servedByLocalServer`), `timings`, `sheet`.

Exit codes: `0` sheet written, nothing to fix · `10` sheet written, with findings to fix (things to look at alone give `0`) · `1` the build failed · `2` a missing declaration or flag, no Playwright or Chromium, or a bad range · `3` unexpected error. No changed page in the range is one line and exit `0`.

**What the screenshots leave out.** Because only the local server is answered, anything a page loads from elsewhere is missing: web fonts from a font service, icons an icon component fetches from a public API, embedded videos. `network.blockedHosts` lists them. They are not findings, and an image from another host is reported as broken (the request was blocked), since the page would not show it offline either. The sheet is for layout and content, not for pixel fidelity.

## No model call

The script spawns two kinds of process: `git` and the host's own `docusaurus`, and it opens Chromium through Playwright. Nothing in it starts or calls a model. Its network is the local server: every other request is aborted and counted (`network.blocked`, `network.blockedHosts`). The tests prove both (see below).

## Tests

`npm test` runs `test/offline.test.mjs`, then `test/browser.test.mjs` when it can launch Chromium. `npm run test:offline` runs the first alone.

- **Offline** (no browser): the page and route mapping (number prefixes, `index`, `slug`, `id`, root pairs, the base URL), changed files from a throwaway git repo, the findings rules, the untranslated-text rule per locale (Russian, Kazakh, Kyrgyz, Tajik, English, Turkish, Uzbek, Azerbaijani, Spanish), the sheet writer and its escaping, the local server, the settings, and the command line up to the browser. A `claude` stand-in on `PATH` records any call.
- **Browser** (a fixture site in the layout `docusaurus build` writes, with a broken image and a wide table): the sheet flags both (AC-1); no `claude` call, and a request to another host, or to another port on `127.0.0.1` that records every hit, is blocked and counted (AC-2).
- **No Playwright, no pass.** Without Playwright and Chromium the browser test is not run, and `npm test` prints why and exits `2` after the offline tests passed. `tools/regression.mjs` shows that as `not run`, which fails the run unless `--allow-not-run` is passed. `VISUAL_PACK_PLAYWRIGHT_FROM` names where Playwright is. CI installs it in its own job.
