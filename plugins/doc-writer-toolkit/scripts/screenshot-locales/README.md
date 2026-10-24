# screenshot-locales

Resolves the locales a docs repo needs screenshots in, tells the capturing skill where each locale's capture goes, and moves a set of captures into the docs only when every locale is there. Node, no dependencies. No AI is involved, and no browser: the skill captures with Playwright, this script does the paths, the staging and the ledger. The rules it serves are in `context/doc-rules/project-rules/screenshot-locales.md`. It reuses the `ui-labels` config reader (`../ui-labels/lib/`), so the two scripts must stay in the same plugin.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/screenshot-locales/screenshot-locales.mjs <command> [<manifest>] [options]
```

Run it from the docs repo root (or pass `--root`). Needs Node 18.3+. Tests: `npm test` in this folder (offline, throwaway folders).

## Commands

| Command | What it does |
|---|---|
| `config` | The declared screenshot locales, the locale switch, the env prefixes and each locale's folder in every root pair. `multilocale: false` when the host declares no `Screenshot locales:`. `--locales <list>` checks an explicitly locale-scoped request. |
| `resolve <manifest>` | Fills each shot's `requiredLocales`, `captureLocales`, `stagedPathPerLocale` and `outputPathPerLocale`, and sets the locales to capture to `pending`. Deletes leftover staged files of those shots. `--shot <ids>` picks the shots to (re)capture; without it, only shots never resolved are set up, and every other shot keeps its staged captures, its failures and their reasons. `--locales <list>` (with `--shot`) is a one-off locale-scoped request. `--dry-run` writes nothing. |
| `fail <manifest>` | Records that one locale of the current round could not be captured: `--shot <id> --locale <locale> --reason <text>`. It writes that locale's `status` (`failed`) and `failureReason`. |
| `promote <manifest>` | Moves each complete staged set into the docs, every locale of the round or none. `--shot <ids>`, `--dry-run`. |
| `status <manifest>` | Each shot's state, from the manifest and the disk. |

Output is JSON on stdout and logs on stderr. A failure prints `{"error": …}`.

**Exit codes:** `0` ok · `1` a set was not promoted (`promote`), or a shot is not complete (`status`) · `2` configuration or input problem, or an unsafe path (ask the user) · `3` unexpected error (stop and report it).

The flow of a capture:

```
config → (write the shots into the manifest) → resolve → (capture each locale to its staged path; fail for a locale that can't be captured) → promote → status
```

## Configuration

From the `Documentation toolkit configuration` block of `<root>/CLAUDE.md` (same reader as `ui-labels`):

| Field | Meaning |
|---|---|
| `Screenshot locales:` | Comma-separated locales, as `docusaurus.config` names them: `uk, en`. Absent: the host is single-locale and the script has nothing to do. |
| `Locale switch:` | `<mode> [<name>] <locale>=<token>, …`. Modes: `url-prefix` (`url-prefix uk=/, en=/en/`), `query` with the parameter name (`query lang uk=uk, en=en`), `cookie` with the cookie name (`cookie locale uk=uk, en=en`), `ui` with the option labels of the app's language picker (`ui uk=Українська, en=English`). Required with two or more locales, one token per locale. |
| `Locale switch path:` | For `ui` only: how to reach the language picker, as plain text. |
| `Locale env prefix:` | Optional `<locale>=<prefix>` pairs: `en=EN_`. For that locale, each `.env` variable is read with the prefix in front (`EN_OPERATOR_BASE_URL`). The prefixed base URL must be a test environment, like the unprefixed one: never production. Absent: every locale uses the same variables. |
| `UA content root:`, `EN i18n root:` and every further root pair | The roots the locale folders derive from (`context/project-paths.md`). `--ua-root`, `--en-root` override the primary pair's. |
| `Toolkit state root:` | Default `.doc-toolkit/`. `--state-root` overrides it. |

**A locale's folder is derived, never declared.** For each root pair: the default locale of `docusaurus.config` lives in the pair's UA content root, `en` in its EN i18n root, any other locale in the EN i18n root with its `en` segment replaced (`i18n/de/docusaurus-plugin-content-docs/current/`). A screenshot locale that `docusaurus.config` does not list is a problem (exit `2`), so no locale folder is ever guessed.

`config` collects every problem before it exits, so the skill can ask one question that covers them all. Warnings (a switch token or an env prefix for a locale that isn't a screenshot locale) don't fail it.

## The manifest

One JSON file per section: `<section folder>/.sources/screenshot-manifest.json`. The skill writes the scenarios and shots; `resolve`, `fail` and `promote` write the fields in the second table and never touch the others.

```json
{
  "section": "portal/transactions",
  "screenshotLocales": ["uk", "en"],
  "scenarios": [
    {
      "scenarioId": "one-successful-payment",
      "seededValues": { "amount": "1 500,00", "status": "succeeded" },
      "shots": [
        {
          "shotId": "filters-pane",
          "page": "portal/transactions/transactions.md",
          "file": "filters-pane.png",
          "route": "/transactions",
          "uiState": "filters-open",
          "selectors": { "trigger": "[data-test=filters-toggle]", "overlay": "[data-test=filters-pane]", "annotate": "[data-test=filters-toggle]", "sensitive": ["[data-test=amount]"] },
          "viewport": { "width": 1440, "height": 900 },
          "crop": "container",
          "annotation": { "target": "annotate" },
          "requiredLocales": ["uk", "en"],
          "outputPathPerLocale": {
            "uk": "portal/transactions/.assets/filters-pane.png",
            "en": "i18n/en/docusaurus-plugin-content-docs-portal/current/transactions/.assets/filters-pane.png"
          },
          "stagedPathPerLocale": {
            "uk": ".doc-toolkit/screenshot-staging/portal/transactions/filters-pane/uk.png",
            "en": ".doc-toolkit/screenshot-staging/portal/transactions/filters-pane/en.png"
          },
          "status": { "uk": "committed", "en": "committed" },
          "failureReason": { "uk": null, "en": null },
          "promotedAt": "2026-10-24"
        }
      ]
    }
  ]
}
```

| Written by the skill | Meaning |
|---|---|
| `scenarioId`, `seededValues` | The seeded business scenario, shared by every shot and locale under it. |
| `shotId` | Unique in the manifest, the same in every locale. |
| `page` | The UA page the image belongs to, from the repo root. It must sit in a declared UA content root. |
| `file` | The image's file name, with no folder. The same in every locale, so each page embeds `./.assets/<file>`. |
| `route`, `uiState`, `selectors`, `viewport`, `crop`, `annotation` | What makes the locales equivalent. The script keeps them as written. |

| Written by the script | Meaning |
|---|---|
| `screenshotLocales` | The declared locales at the last `resolve`. |
| `requiredLocales` | Every screenshot locale at the shot's last `resolve`. |
| `captureLocales` | The locales of the current round: `requiredLocales`, or the `--locales` of a locale-scoped request. Removed when the round is promoted, so a scope never outlives its request. |
| `outputPathPerLocale` | `<locale folder of the page's pair>/<page folder>/.assets/<file>`. |
| `stagedPathPerLocale` | `<state root>/screenshot-staging/<page folder>/<file stem>/<locale>.<ext>`. The skill saves each capture there. |
| `status` | Per locale: `pending` (to capture in this round), `committed` (the live image is from a promoted round) or `failed`. |
| `failureReason` | Per locale: why it failed, or `null`. |
| `promotedAt` | The date of the last promotion. |

`resolve` checks every shot before it writes: a page under no UA content root, a file name with a folder, a stored `locales` field (a scope is passed as `--locales`, never stored), two shots with one `shotId`, or two shots that write the same image is a problem (exit `2`, nothing written). For the shots it resets it also refuses:

- an output folder whose real path differs from its literal path (a symlinked `.assets/` or page folder, say a locale's `.assets/` that links to another locale's): one locale's capture would land in another locale's folder;
- two outputs that are one real file;
- a `<staged path>.previous` file: the earlier image of an interrupted promotion (see below). It is never deleted; put it back or remove it, then resolve again;
- a `--locales` request for a shot that isn't committed in its other locales: that would leave a partial set. Capture the full set instead.

`resolve` also writes `<state root>/screenshot-staging/.gitignore` (`*`), so staged files are never committed.

## Promotion (`promote`)

`promote` takes the shots `--shot` names, or every resolved shot not committed in all its locales. Before anything moves, `promote` runs the same path checks as `resolve` (symlinked folders, one real file, a `.previous` file) and exits `2` with nothing moved if any fails.

1. **Complete set:** every locale of the round has a staged file that is not empty, and no locale is `failed`. Each live image is moved aside, the staged one moved in, and the aside copies deleted when every locale is in. A live image that is a symlink (a locale's link to the EN image, made by `locale-sync link-assets`) is replaced by the real file; the image it points to is never written. The folders of the output paths are created here, and only here: they are derived from the declared roots. `createdFolders` lists them. If a move fails halfway, each locale is put back and the shot is `failed`. The reason says `every locale was put back as it was`, or lists each image that could not be put back and where its earlier version is (`notRestored` in the result).
2. **Incomplete set:** nothing is moved. Each live image stays as it was, the staged files of the shot are deleted, and every locale of the round becomes `failed`: the missing ones with their recorded reason (or `no capture at <path>`), the others with `not promoted: <locales> failed; the previous image stays`. Exit `1`.

## Status (`status`)

Per shot, `state`:

| State | Meaning |
|---|---|
| `complete` | Committed in every required locale, and each live image is a real file. |
| `pending` | Resolved, not promoted yet. |
| `failed` | A locale failed; the previous images are still live. |
| `mixed` | Some required locales have a live image and some don't. A reader would see one locale's screenshot without the others'. |
| `interrupted` | A `.previous` file is in staging: a promotion stopped between moving the old image aside and putting the new one in. |
| `unsafe` | An output folder leads through a symlink, or two outputs are one file (`problems` says which). |
| `unresolved` | `resolve` has not run on the shot. |

Per locale: `status`, `live` (`file`, `symlink` or `missing`), `staged` (a capture is waiting), `previous` (an interrupted promotion's earlier image) and `reason`. `missingLocales` lists the declared screenshot locales a shot doesn't cover yet (a locale added after its last capture). Exit `1` unless every shot is `complete`.

## Limits

- The script never captures, switches locales or opens a browser. The skill does, through `screenshot-capture.md`.
- Only image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`).
- Symlinks need a filesystem that supports them (macOS, Linux), like `locale-sync link-assets`.
