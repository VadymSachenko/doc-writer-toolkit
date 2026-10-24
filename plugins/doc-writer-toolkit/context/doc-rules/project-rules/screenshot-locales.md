# Screenshot locales — shared rules

Apply these rules whenever a screenshot is created, replaced or edited through Playwright: inside `app-explorer` (Step 3), inside `resolve-markers` (a `{/* ToDo: add a screenshot */}` or `{/* ToDo: recapture screenshot */}` marker), and for every re-capture a writer skill requests (the writers request it through those two skills, never capture themselves).

This file is the one locale-aware capture contract. It decides which locales a shot needs, where each locale's image goes, and when the new images replace the old ones. `screenshot-capture.md` stays the mechanic for one shot in one locale: scope, annotation, blur. This file runs it once per locale. A consumer never switches locales, builds a locale path or moves an image into a locale folder by itself.

The mechanical part is a script: `node ${CLAUDE_PLUGIN_ROOT}/scripts/screenshot-locales/screenshot-locales.mjs` (`SL` below), run from the docs repo root. Its README (`${CLAUDE_PLUGIN_ROOT}/scripts/screenshot-locales/README.md`) is the authority on its fields, output and exit codes; this file doesn't repeat them.

---

## Section 0 — Resolve the screenshot locales (do this first)

Run `SL config` before the first capture of a run.

- **`multilocale: false`** — the host declares no `Screenshot locales:`. Nothing in this file applies: capture once, in the locale the app shows, into the page's own `.assets/`, as `screenshot-capture.md` describes. No manifest, no staging. This is how every host without the declaration works, unchanged.
- **Exit `2`** — the locales can't be resolved safely: a locale `docusaurus.config` doesn't list, a missing switch token, no `Locale switch:` for two or more locales, a request for an undeclared locale. Capture nothing. Ask **one** focused question that covers every listed problem, and offer to write the answer into the host's `CLAUDE.md`. Never guess a locale folder, and never fall back to a single locale silently.
- **Exit `0`, `multilocale: true`** — use the resolved locales, switch and env prefixes for every shot of the run.

### Declarations

In the host's `CLAUDE.md`, "Documentation toolkit configuration" section (`${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`):

```md
- **Screenshot locales:** `uk, en`
- **Locale switch:** `url-prefix uk=/, en=/en/`
- **Locale env prefix:** `en=EN_`
```

- **`Screenshot locales:`** — the UI languages screenshots must exist in. It is separate from `Content language:`: a project that authors in `uk` and translates to `en` declares `Content language: uk` and may still need `en` screenshots, so the English page shows the English UI.
- **`Locale switch:`** — how the app changes its UI language: `url-prefix`, `query`, `cookie` or `ui`, with one token per locale. `ui` also needs `Locale switch path:`, the way to the app's language picker.
- **`Locale env prefix:`** — optional, only when a locale needs another base URL or test account. Credentials stay in `.env`; the prefix only says which variables to read.

The value formats are in the script's README, "Configuration".

### Where each locale's image goes

Derived, never declared: the default locale's page lives in the page's UA content root, `en` in that pair's EN i18n root, any other locale in the EN i18n root with its `en` segment replaced (`project-paths.md`, "Derived, never declared"). The image goes into the `.assets/` folder next to that locale's page, under the same file name in every locale, so each page embeds `./.assets/<file>` (`screenshot-selection.md`).

A further locale that is not a screenshot locale gets no capture: `locale-sync link-assets` links its `.assets/` file to the EN image, as before. A further locale that is a screenshot locale gets a real file, which `link-assets` keeps as an override.

---

## Section 1 — Locale parity

The images of one shot are equivalent across locales when they have:

- the same scenario and the same seeded business data;
- the same route and the same UI state (empty, loaded, success, error, overlay open);
- the same viewport;
- the same annotation target and the same frame (`screenshot-capture.md`, Section 3);
- the same blurred fields (`screenshot-capture.md`, Section 4);
- a corresponding crop, and the corresponding output path;
- the UI text of their own locale.

Byte-identical images are not required. Localized text changes wrapping and size, so compute each locale's crop from that locale's own bounding boxes. Never translate, overlay or edit text in an image, and never copy one locale's image into another locale's folder.

---

## Section 2 — Scope

### Which locales

- **Default: every screenshot locale.** Creating, replacing or editing a screenshot updates it in every declared screenshot locale.
- **An explicitly locale-scoped request** ("re-capture the filters pane in `en` only") updates only the locales it names: list them in the shot's `locales`. The other locales keep their images.
- **When the scope or a locale's folder can't be resolved safely**, ask one focused question and capture nothing until it is answered.

### Which pages share a scenario

- **Page level, by default.** Every shot on a page uses one scenario: one seeded data set, the same in every locale.
- **Section level** when connected pages reuse the same entity, account, transaction, amounts, names or narrative. Then one scenario covers those pages, so a reader moving from page to page sees one story in each locale.
- **Ask before you extend a scenario** to pages the request didn't name, when the extension would replace their committed screenshots, or when seeding the shared scenario can't be undone or reset in the test environment. Name the pages and the shots that would change. Extending a scenario within the pages the request named needs no approval.

---

## Section 3 — The manifest

One ledger per section: `.sources/screenshot-manifest.json` in the folder the consuming skill works on (the section folder for `app-explorer` and `resolve-markers`). It records, per scenario, the seeded values, and per shot the page, the file name, the route and UI state, the selectors, the viewport, the crop and annotation settings, the required locales, the staged and output path of each locale, and each locale's status and failure reason. The schema and an example are in the script's README, "The manifest".

- Write the scenario and shot fields before the first capture. Keep `seededValues` realistic (`value-realism.md`) and free of credentials.
- Never write `requiredLocales`, the paths, `status` or `failureReason` by hand: `SL resolve`, `SL fail` and `SL promote` own them.
- Keep the manifest when the run ends. It is how the next run knows what each locale has, and how a later re-capture repeats the same scenario.

---

## Section 4 — Capture procedure

For each shot to create, replace or edit:

1. **Write the shot** into the manifest under its scenario (Section 3).
2. **Resolve:** `SL resolve <manifest> --shot <shotId>[,…]`. Exit `2`: ask one focused question (Section 0); capture nothing. The output lists each shot's staged path per locale.
3. **Seed the scenario once** for all locales, through the API test collection (`app-explorer` Step 2). Seed data that expires (a queued payment that times out) right before its captures, in every locale.
4. **Capture every required locale**, one after another, in the same session:
   1. Switch the app to the locale with the declared mode and token, reading that locale's `.env` variables (`Locale env prefix:`).
   2. Go to the same route and bring the UI into the same state.
   3. Capture by `screenshot-capture.md` (Sections 0 to 4), with the same viewport, selectors, annotation target and blurred fields. The capture's `path` is the locale's **staged path**, never the live `.assets/` file.
5. **A locale that can't be captured** (the state can't be reproduced, a selector is missing, a page doesn't load, the switch has no effect): `SL fail <manifest> --shot <id> --locale <l> --reason "<what happened>"`. Don't stage a capture of a different state instead.
6. **Promote:** `SL promote <manifest>`. A shot is promoted in every required locale or in none.
7. **Check:** `SL status <manifest>`. Every shot of the run must be `complete`, or appear in the report (Section 6).

Folders: only `SL promote` creates a locale's `.assets/` folder, from the derived roots. Never create a locale folder, or a locale's page folder, by hand.

---

## Section 5 — Partial failure and recovery

- **Never a partial set.** A shot is done only when every required locale is committed. A page is never left with a new image in one locale beside an old or missing one in another.
- **The previous set stays** until the new set is complete. Captures go to the staging folder (`<state root>/screenshot-staging/`, git-ignored), and `SL promote` moves them in only when every locale is there. If one locale fails, nothing is moved, the staged files are discarded, and the previous images stay live in every locale.
- **Leftovers are never promoted.** `SL resolve` deletes a shot's old staged files before a new capture.
- **Report every failure:** each failed locale with its reason, each locale or state that can't be reproduced consistently, and each `mixed` shot that `SL status` finds. Never hide one, and never fill the gap with a copy of another locale's image.

---

## Section 6 — Decision table

| Situation | Locales | Action |
|---|---|---|
| No `Screenshot locales:` | one, the app's | Capture once into the page's `.assets/` (`screenshot-capture.md`). No manifest, no staging |
| New screenshot | every screenshot locale | Write the shot, resolve, capture each locale to staging, promote |
| Replace or edit a screenshot | every required locale | Resolve with `--shot`, capture the full set again, promote. The old set stays until the new one is complete |
| Request names one locale | that locale | Shot `locales: [<locale>]`; the other locales keep their images |
| One locale fails | — | `SL fail` with the reason; promote moves nothing; report it |
| A state can't be reproduced in a locale | that locale | `SL fail` with the reason; never stage a different state |
| A locale `docusaurus.config` doesn't list, or no switch token | — | Capture nothing; ask one focused question |
| A request names an undeclared locale | — | Capture nothing; ask whether to declare it |
| The scenario would reach pages the request didn't name, or can't be reset | section | Ask first, naming the pages and shots |
| A screenshot locale was added after a page's last capture | the missing locale | `SL status` lists it in `missingLocales`. Capture the full set when that screenshot is next created, replaced or edited. No backfill otherwise |

---

## Section 7 — Report

Every consumer's report says, for the shots of the run: how many were promoted, in which locales; which failed, per locale, with the reason; the folders `SL promote` created; and any `mixed` shot or `missingLocales` entry `SL status` listed. A single-locale host's report says nothing about locales.

A re-captured image keeps its file name, so the page embeds don't change, and a `published_as` entry in a `frames-index.json` that names it stays valid (`screenshot-selection.md`, step 4). A capture has no origin frame, so it adds no `published_as` entry.
