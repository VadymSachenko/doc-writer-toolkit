# transcriber

The ticket flow's automatic transcription at the video gate (`videoTry`, `scripts/ticket-state/README.md`, "The video gate"): it uploads a ticket's video parts to a transcription service and, in a later run, saves each part's plain-text transcript next to the part. Node, no dependencies of its own: Playwright and Chromium come from the host repo's `node_modules` (the hub has them for its screenshots). No AI.

The runner calls it as a module (`lib/index.mjs`); the CLI is the owner's, for the one-time sign-in and a check:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/transcriber/transcriber.mjs sign-in [--root <dir>] [--settings <file>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/transcriber/transcriber.mjs check [--root <dir>] [--settings <file>]
```

`sign-in` opens the browser profile in a visible window at the service's sign-in page: sign in by hand (with Google), check that the dashboard shows, close the window. `check` opens the dashboard as the try would and prints `{ "ok", "kind" }`, `kind` one of `ok`, `signIn`, `captcha`, `limit`, `unexpected`; it uploads nothing. Both read the ticket flow settings as `ticket-state` does and refuse in a role session (`DOC_TOOLKIT_ROLE_SESSION`, exit 2).

## Settings

The owner's local ticket flow settings (`ticket-state set video.<key> <value>`):

| Key | Default | |
|---|---|---|
| `video.transcriber` | none | The adapter: `turboscribe`. With none, no automatic try. |
| `video.browserProfile` | none | The persistent profile's folder: absolute (or `~/…`), outside the host repo, the state folder and every clone. With none, no automatic try. The script makes it mode 700. |
| `video.headless` | `false` | A browser with no window. Off by default: a sign-in and a bot check pass more often in a visible browser, and whether the service works headless is for the pilot to show. |
| `video.channel` | none | An installed browser instead of Playwright's Chromium: `chrome` (Google may refuse a sign-in in Playwright's own Chromium). |
| `video.partsPerDay` | `3` | Uploads a day, for the account: across every ticket, the oldest gate first. The service's free plan takes 3 files a day of up to 30 minutes each. |
| `video.fetchMinutes` | `15` | How often an uploaded part's transcript is looked for. |
| `video.transcriptHours` | `2` | No transcript this long after the upload is a failure. |

## What it does

- **One browser a step, one profile at a time.** `open()` launches Chromium on the profile (`launchPersistentContext`) after taking `<profile>.lock` (the holder's pid; a holder that is gone frees it). A profile in use (that lock, or Chromium's own) throws `Busy`: the runner records nothing and a later check tries.
- **An upload** (`upload({ file, name })`): the dashboard, the upload dialog, the file under `name` (the runner gives `<key>-<part file name>`, so two tickets' parts never share a name), the transcribe button, then a wait for the file in the list. One call, one try.
- **A look** (`fetch({ ref, dest })`): the dashboard, the file by its name, its page. Still in work: `waiting`. Done: the plain-text export with timestamps, saved first as `<dest>.download` and renamed to `dest` only when it has the `(m:ss - m:ss)` timestamps the import reads.
- **Every failure is one answer with a fixed reason**: a sign-in wall, a captcha or bot check, the day's limit, an unexpected page (naming what wasn't there), or a browser that didn't start. Nothing here tries again; the runner falls back to the person on the first failure.
- **No secret leaves the profile.** Nothing reads its cookies or storage. A page is seen as its host, path, title and visible text, never the query of its address (a sign-in redirect carries its parameters there), and an error's addresses lose their query too. The ticket flow denies every role session `Read` and `Edit` on the profile.

## The site module

`lib/turboscribe.mjs` holds everything about the service's pages: the addresses, the selectors, the page checks (`classify`) and the steps of an upload and an export. A change on the site is a change in that file only. Its selectors were written without the live pages (they sit behind a sign-in and a bot check): the pilot confirms them, and a check that misses reads as an unexpected page, never as a pass. Another service is a module like it and one line in `lib/index.mjs`.

## Tests

`npm test` in this folder: the offline tests (the page checks on snapshots, one per failure; the driver on a stand-in site and launcher), then the browser test on a local server of synthetic pages (an upload, a look in work, the export, and one failure each), which needs Playwright with Chromium from `TRANSCRIBER_PLAYWRIGHT_FROM`, else `VISUAL_PACK_PLAYWRIGHT_FROM`. Without it the run exits 2 after the offline tests, which the regression set shows as `not run`. No page of the service is copied into the tests: its terms forbid reusing its HTML.

## Files

| | |
|---|---|
| `transcriber.mjs` | The CLI: `sign-in`, `check`. |
| `lib/index.mjs` | The adapters `video.transcriber` may name. |
| `lib/driver.mjs` | The session: the profile lock, the browser, one upload, one look, the fixed reasons. |
| `lib/turboscribe.mjs` | The service's pages: selectors, page checks, the upload and export steps. |
| `lib/playwright.mjs` | Playwright from the host's `node_modules`. |
| `test/` | `offline.test.mjs`, `browser.test.mjs`, `run.mjs`. |
