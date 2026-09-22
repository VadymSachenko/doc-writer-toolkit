# Design: multilocale screenshot workflow (Phase A)

**Status: Phase A — analysis and design only. This document is for approval.**
No runtime rules, skills, templates, or screenshot code are edited until the user approves.
Implementation (Phase B) begins only after explicit approval.

---

## 1. Problem and current state

Today a screenshot is captured **once, in whatever locale the running app happens to render**, and
written to a single `.assets/` folder co-located with the page being worked on. The relevant pieces:

- `screenshot-capture.md` — *how* to capture (config resolution, scope ladder, annotation, blur). It
  knows nothing about locale.
- `screenshot-selection.md` — *which* frames to embed and the `./.assets/{file}` embed markup.
- `app-explorer` (Step 3) captures into `.assets/`; `resolve-markers` does targeted recapture;
  writer skills request recapture. All three call `screenshot-capture.md`.
- `doc-translator` **preserves `./.assets/…` links verbatim** and never localizes an asset path.

The gap: a UA page and its EN translation are separate files under separate roots
(`UA content root` vs `EN i18n root`), each with its **own** co-located `./.assets/`. Nothing
currently captures a screenshot **per locale** or routes captures into per-locale asset folders. An
English reader sees Ukrainian UI chrome, or a broken image, because only the UA-locale shot was ever
produced. There is no manifest, no parity guarantee, and no partial-failure protection.

The goal of this design: **one shared, locale-aware capture contract** that every present and future
Playwright consumer delegates to, so a single logical "capture this screenshot" request produces an
equivalent, correctly-routed image in every declared screenshot locale.

---

## 2. Recommended design

A single new shared rule file (working name `screenshot-locales.md`) that sits *above*
`screenshot-capture.md` and owns everything locale-aware. `screenshot-capture.md` stays the
locale-agnostic mechanic (one shot, one locale, one clip); `screenshot-locales.md` orchestrates it
once per locale and routes the outputs. Consumers call the locale-aware contract, never the raw
capture mechanic directly.

### 2.1 Host-project declarations (spec §1)

New fields in the host `CLAUDE.md` "Documentation toolkit configuration" block, resolved through
`project-paths.md` (same ask-once/offer-to-persist fallback as every other field):

- **`Screenshot locales:`** — the ordered list of locales screenshots are produced for, e.g.
  `uk, en`. **Deliberately separate from `Content language:`** — a project may author only in `uk`
  (translating prose to `en`) yet still need `en`-locale screenshots so the EN page shows English
  chrome. The two settings answer different questions: *what language is prose written in* vs *what
  UI languages must screenshots exist in*.
- **Per-locale asset root mapping** — for each screenshot locale, where its `.assets/` tree lives.
  Derived by default from the already-declared `UA content root` / `EN i18n root` (the locale's page
  root + co-located `.assets/`), with an explicit override map for projects whose layout differs.
- **`Locale switch:`** — how the app switches UI language: one of `url-prefix` (e.g. `/uk/…` vs
  `/en/…`), `cookie`, `setting` (a per-user profile toggle reached by a declared navigation path),
  or `query` (`?lang=en`). Includes the concrete token per locale.
- **Locale-specific routes and auth** (optional) — only when a locale is served from a different
  base URL or needs a different test account. Absent ⇒ all locales share the one declared test env
  and account.

### 2.2 Locale parity (spec §2)

Two screenshots are **equivalent across locales** when they share: the same scenario; the same
seeded business data; the same route and UI state; the same viewport; the same annotation target
(same element, same rectangular border-only frame per `screenshot-capture.md`); a corresponding crop
and a corresponding per-locale output path. Only the **UI text differs** (localized).

**Byte-identical images are not required and not expected** — localized strings change wrapping and
element geometry, so crop boxes computed from a bounding box will legitimately differ in size per
locale. Parity is defined by *inputs and target*, not by pixels.

### 2.3 Default scope (spec §3)

- Creating, replacing, or editing a screenshot **updates all declared screenshot locales** by
  default — one request fans out across `Screenshot locales:`.
- An **explicitly locale-scoped** request (e.g. "recapture the filters dialog for `en` only")
  updates only that locale.
- When locale scope or the per-locale path mapping **cannot be resolved safely** (ambiguous mapping,
  missing switch token, an unexpected extra locale on disk), **ask one focused question** rather than
  guessing — consistent with the toolkit's existing ask-once discipline.

### 2.4 Consistency scope (spec §4)

- **Page-level consistency by default** — every shot on a page shares one scenario and one seeded
  data set across locales.
- **Section-level consistency** when connected pages reuse the same entity, account, transaction,
  amounts, names, or narrative — the same seeded scenario carries across the section so a reader
  moving page to page sees a coherent story in each locale.
- **Approval before extending a scenario across a section** is requested when: seeding the shared
  scenario is destructive or hard to reset; it would overwrite an existing complete locale set on
  other pages; or the section spans more than a declared threshold of pages. Extending narrative
  across a section is a bigger commitment than one page, so it is gated.

### 2.5 Scenario manifest / ledger (spec §5)

A per-section ledger (working name `.sources/screenshot-manifest.json`) — the single source of truth
for what must exist and what actually does, and the unit of recovery. Minimum fields per shot:

- `scenarioId` — the seeded business scenario the shot belongs to.
- `shotId` — stable ID for this screenshot (shared across locales).
- `requiredLocales` — subset of `Screenshot locales:` this shot needs.
- `route` + `uiState` — where and in what state (empty / loaded / success / error / overlay-open).
- `selectors` — trigger/annotation/overlay/sensitive selectors.
- `seededValues` — the business data seeded for the scenario (realistic, per `value-realism.md`).
- `viewport`, `crop`, `annotation` — capture settings (annotation target + the rectangular
  border-only frame).
- `outputPathPerLocale` — resolved destination for each required locale.
- `status` + `failureReason` — per locale: `pending | captured | failed | staged | committed`, plus
  a reason on failure.

### 2.6 Folder creation (spec §6)

- Create **only** destination folders derived from the declared locale mappings.
- **Never guess** a locale directory. If a mapping is missing for a required locale, that is a §3
  "cannot resolve safely" case → ask one focused question; do not invent `i18n/xx/…`.

### 2.7 Partial failure and recovery (spec §7)

- **Never silently leave a partially updated locale set.** A shot is not "done" until every
  `requiredLocale` reached `committed`.
- **Preserve the previous complete set** until the replacement set is complete. Recommended staging:
  capture the new set into a sibling staging path (e.g. `.assets/.staging/{shotId}/{locale}.png`),
  and **atomically promote** all locales into place only when every locale succeeded. If any locale
  fails, the staging set is discarded and the previous committed images remain untouched.
- **Report** unsupported locales and any UI state that cannot be reproduced consistently (e.g. an
  error state that needs backend conditions the test env can't force) — recorded as `failed` with a
  reason in the manifest, surfaced to the user, never hidden.

### 2.8 Integration points (spec §8)

All Playwright consumers — **`app-explorer`** (section exploration), **`resolve-markers`** (targeted
recapture for a `{/* ToDo: add a screenshot */}` marker), and **writer-requested recapture** — must
delegate to the one shared locale-aware capture contract. None of them re-implements locale fan-out,
switching, routing, or staging. `screenshot-capture.md` remains the single-locale mechanic the shared
contract calls N times; `screenshot-selection.md` is unchanged except that embed paths continue to be
locale-local (`./.assets/…` relative to each locale's page).

### 2.9 Backward compatibility (spec §9)

A host project with **no `Screenshot locales:` declaration** behaves exactly as today: a single
locale, single `.assets/`, no fan-out, no manifest requirement, no staging. The locale-aware contract
detects the absent declaration and degrades to a one-locale pass-through — existing single-locale
projects (the current UCPay install) keep working with zero config changes. The manifest is created
only when multilocale is declared.

### 2.10 Validation approach (spec §10)

Validate the *design and any Phase-B logic* against a **synthetic two-locale host fixture**
(`uk` + `en`, both prefix-switched, one shared seeded scenario) exercised on paper / in unit-level
reasoning. **Do not** create product screenshots in this repository and **do not** claim Playwright
end-to-end validation — this repo has no live app and no browser in CI.

---

## 3. Proposed configuration block

```md
## Documentation toolkit configuration

# … existing fields (style guide, content roots, URL prefix, frame, scope, padding, …) …

- **Screenshot locales:** `uk, en`          # separate from Content language
- **Locale switch:** `url-prefix`           # url-prefix | cookie | setting | query
  - **uk:** `/`                             # switch token per locale
  - **en:** `/en/`
- **Screenshot asset roots:**               # optional; derived from content roots if omitted
  - **uk:** `docs/`                          # page root; .assets co-located per page
  - **en:** `i18n/en/docusaurus-plugin-content-docs/current/`
# Optional, only when a locale differs:
# - **Locale routes/auth:**
#   - **en:** base_url=<en-test-url> account=<env-var-name>
```

`Screenshot locales:` absent ⇒ single-locale legacy behavior (§2.9).

---

## 4. Capture decision table

| Situation | Locale scope | Action |
|---|---|---|
| New screenshot requested, `Screenshot locales:` declared | all declared | Capture every required locale into staging; promote atomically; write manifest |
| New screenshot, no locale config | single (legacy) | Capture once into `.assets/`; no manifest |
| Explicit "locale `en` only" request | that locale | Capture/replace `en`; leave other locales' committed images intact |
| Replace/edit existing shot | all required locales | Re-capture full required set into staging; promote only if all succeed |
| One locale fails mid-fan-out | — | Discard staging; keep previous committed set; mark `failed` + reason; report |
| Required locale has no path mapping | — | Do **not** guess a folder; ask one focused question (§3, §6) |
| UI state not reproducible in a locale | that locale | Mark `failed` with reason; report; do not fabricate |
| Section reuses same entity/account/narrative | section | Use section-level shared scenario; request approval before extending if gated (§4) |
| Host declares locale not in mapping | — | Treat as unresolved; ask; never invent `i18n/<x>/` |

---

## 5. Example scenario manifest

```json
{
  "section": "transactions/filter-transactions",
  "screenshotLocales": ["uk", "en"],
  "scenarios": [
    {
      "scenarioId": "one-successful-payin",
      "seededValues": {
        "amount": "1 500,00 UAH",
        "clientName": "Олена Ткаченко",
        "status": "success"
      },
      "shots": [
        {
          "shotId": "filters-pane",
          "requiredLocales": ["uk", "en"],
          "route": "/transactions",
          "uiState": "filters-open",
          "selectors": {
            "trigger": "[data-test=filters-toggle]",
            "overlay": "[data-test=filters-pane]",
            "annotate": "[data-test=filters-toggle]",
            "sensitive": ["[data-test=client-name]", "[data-test=amount]"]
          },
          "viewport": { "width": 1440, "height": 900 },
          "crop": "container",
          "annotation": { "target": "trigger", "frame": "3px, #CC0000" },
          "outputPathPerLocale": {
            "uk": "docs/transactions/filter-transactions/.assets/filters-pane.png",
            "en": "i18n/en/docusaurus-plugin-content-docs/current/transactions/filter-transactions/.assets/filters-pane.png"
          },
          "status": { "uk": "committed", "en": "committed" },
          "failureReason": { "uk": null, "en": null }
        }
      ]
    }
  ]
}
```

Note: the `en` shot switches the app to `/en/` before capture; its crop box is recomputed from the
`en` bounding box (localized text changes geometry) — parity is by inputs/target, not pixels (§2.2).
The rectangular border-only frame is unchanged across locales (Task 8 invariant).

---

## 6. Failure and staging policy

1. **Stage, don't overwrite.** New captures land in `.assets/.staging/{shotId}/{locale}.png`. The
   live `.assets/{file}.png` for each locale is untouched until promotion.
2. **All-or-nothing promotion.** Promote the staged set into the live per-locale paths only when
   **every** `requiredLocale` succeeded. Promotion is a move per locale; if any locale is missing,
   promotion does not start.
3. **On failure**, discard staging; the previous complete set remains live; record `failed` + reason
   in the manifest; report the locale(s) and why.
4. **Never a mixed set** — a page is never left with a fresh `uk` image beside a stale/absent `en`
   one.
5. **Report** unsupported locales and non-reproducible states explicitly (never silent).
6. Alternative staging strategy if `.staging/` is undesirable: capture to a temp dir outside the
   docs tree and promote from there — same all-or-nothing semantics. (Open decision — see §9.)

---

## 7. Alternatives considered

| Alternative | Why not recommended |
|---|---|
| **Capture once, auto-translate/overlay text** | Overlaying translated text onto one base image is fragile (geometry, fonts, RTL) and misrepresents the real localized UI. Rejected. |
| **Copy the UA image into the EN `.assets/` unchanged** | Fast, but the EN reader sees Ukrainian chrome — the exact defect this design fixes. Acceptable only as an explicit per-project fallback, not the default. |
| **Bake locale logic into `screenshot-capture.md` directly** | Overloads the single-locale mechanic with orchestration, switching, routing, staging — harder to test and to keep the Task 8 invariant clean. A thin locale-aware layer above it keeps each file single-purpose. Rejected in favor of the layered design. |
| **Per-consumer locale handling** (each of app-explorer / resolve-markers / writers does its own fan-out) | Guarantees drift and three subtly different behaviors. Violates spec §8 (one shared contract). Rejected. |
| **Manifest as Markdown, not JSON** | Human-readable but not a reliable machine ledger for status/recovery; the toolkit already uses JSON ledgers (`section-readiness.json`). JSON chosen. |

---

## 8. Phased implementation plan (Phase B — only after approval)

1. **Config + resolution** — add `Screenshot locales:`, `Locale switch:`, asset-root mapping to
   `project-paths.md` resolution (with legacy fallback). No behavior change when undeclared.
2. **Shared locale-aware contract** — author `screenshot-locales.md`: fan-out, locale switching,
   per-locale routing, staging/promotion, manifest read/write. It calls `screenshot-capture.md`
   once per locale.
3. **Manifest** — define and wire `.sources/screenshot-manifest.json` (schema in §5), including
   status lifecycle and failure reasons.
4. **Consumer delegation** — point `app-explorer`, `resolve-markers`, and writer-recapture at the
   shared contract; remove any implicit single-locale assumptions.
5. **Selection/embed** — confirm `screenshot-selection.md` embed paths stay locale-local; add the
   per-locale `.assets` note.
6. **Synthetic-fixture validation** — a two-locale (`uk`,`en`) fixture exercising fan-out, an
   explicit-locale request, and a simulated partial failure. No real product screenshots; no E2E
   Playwright claim.
7. **Docs** — update the host-config docs and the toolkit map.

---

## 9. Unresolved decisions (need a call before Phase B)

1. **Staging location** — `.assets/.staging/` inside the docs tree (visible, git-ignorable) vs a
   temp dir outside the tree. Trade-off: discoverability vs keeping the docs tree clean.
2. **Manifest scope** — one manifest per section (recommended, matches `.sources/` locality) vs one
   repo-wide manifest. Section-scoped preferred; confirm.
3. **`Locale switch:` surface** — is `url-prefix` sufficient for the real UCPay app, or is the switch
   a per-user profile setting (`setting` mode) requiring a navigation path? Needs a fact about the
   live app.
4. **EN-locale test account** — does the test env expose English UI under the same account, or is a
   separate account/env needed? Determines whether `Locale routes/auth` is required.
5. **Section-consistency approval threshold** — the page-count (or destructiveness) trigger for
   requiring approval before extending a scenario across a section (§2.4).
6. **Retro-fill of existing pages** — for the current single-locale UCPay content, do we
   backfill `en`-locale screenshots on a schedule, or only when a page is next edited?

---

**End of Phase A. Awaiting approval before any implementation (Phase B).**
