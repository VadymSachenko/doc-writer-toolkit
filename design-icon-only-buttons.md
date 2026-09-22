# Design: Icon-only UI buttons in generated docs

**Status:** proposed — for review, no files changed yet.
**Date:** 2026-08-14

## Problem

Some UI buttons have only an icon — no text, no tooltip. An instruction can't refer to a
non-existent label, so the writer must show the actual icon inline and name the control.

## Key finding — this mostly already exists

The capability is already implemented, but partially and duplicated:

- `skills/user-guide-writer/SKILL.md` (lines 146–149) has a 3-branch "icon-only buttons"
  decision tree emitting `<Icon icon="ic:sharp-edit" height="24" style={{ color: '#9564ff' }} />`.
- The same tree is duplicated in `context/doc-templates/user-guide-template.md` (31–34) and
  `ua-user-guide-template.md` (27–32); `doc-translator` already preserves `<Icon>`.
- **Missing** from `concept-doc-writer` and `api-doc-writer`, and **absent** from the rank-0
  single-source-of-truth `context/doc-rules/project-rules/formatting-conventions.md`.

**The genuine gap** is branch 3: today branch 2 requires the writer to *already know* the
Iconify id. There is no procedure to go from *"floppy-disk button, no label"* → `mdi:content-save`.
That detection + lookup is the actual new capability.

## Decisions locked

1. **Render format:** keep `<Icon>` (`@iconify/react`) as UCPay's behavior, but make it a
   *declared* choice via a new config field. Unknown hosts default to a safe `screenshot-crop`.
2. **Ж8 is theme-aware:** drop the hardcoded `#9564ff` and `height="24"`; icons inherit
   `currentColor` (dark-mode correct) at a single default size (`height="20"`).
3. Deliver design first (this doc); build after review.

---

## Solution — hybrid, split along its two real halves

### Part A — centralize the render rule as rank-0 `Ж8` (not a skill)

The "what to emit + how to phrase it" part is a *formatting convention*. It belongs in
`formatting-conventions.md`, which all three writers already load and treat as outranking their
own body. This closes the concept/api gap and removes the duplication in one move.

**Add `Ж8 — Іконки та кнопки без підпису` to `formatting-conventions.md`:**

- **Core (`## Ядро`)** — language-neutral decision tree + the `Icon rendering:` config values +
  the empty-`alt` rule.
- **`## Українською`** — sentence pattern: container first, then descriptor + name,
  e.g. `На панелі інструментів клацніть піктограму <icon> «Більше».`
  Verb `клацніть`/`торкніться` for піктограма, `натисніть` for кнопка. Don't chain descriptors
  ("піктограма кнопки"). Don't drop `піктограма` when shape matters.
- **`## English`** — `gdsg`: `Click the <icon> **More** icon.` / `mssg-en`:
  `Select the <icon> **More** button.` (add the noun so an action-like label isn't bare).
- Add Ж8 to the Core checklist.

**Ж8 decision tree (replaces the old 3-branch tree everywhere):**

1. Button has a visible text label → **bold label only**, no icon.
2. Icon-only, **accessible name known** (tooltip/aria-label from `app-notes.md`/SME) →
   bold accessible name + noun, icon rendered inline per the resolved `Icon rendering:` value.
3. Icon-only, **accessible name unknown** → descriptive text +
   `{/* NEEDS CONFIRMATION: accessible name for <glyph> button */}`; still render the icon/crop
   as a locator. **Never invent a name from the glyph shape.**

**Style-guide basis (GDSG + MSSG converge):** name the control by its accessible name in bold +
noun; the icon is a *visual locator* with empty `alt=""` (don't duplicate adjacent text). The step
must read correctly with the image stripped. Verb follows the host's declared `Style guide:` token
(`click` for gdsg, `select` for mssg) — don't mix.

**Critical subtlety:** Iconify gives you the *picture*, not the *name*. The accessible name must
come from `app-explorer`/SME. When absent, branch 3 is mandatory.

### Part B — new on-demand utility skill `identify-ui-icon` (the actual new part)

The screenshot→Iconify-id lookup is *active tooling* (network + rasterize), not a rule. It must
**not** go in `formatting-conventions.md` (loaded on every draft/review even with zero icons) and
**not** be inlined into three writers (duplication). A skill loads **only when invoked** — icon-only
buttons are the exception on a page — so the writers call it by name only when they hit an
unlabeled button, mirroring the SME-pipeline hand-off pattern.

**Lookup procedure (verified against the live Iconify API — free, keyless):**

1. **Reuse existing evidence.** If `.sources/app-notes.md` already records the id or tooltip/
   aria-label, use it — skip the network.
2. **Name the glyph** in 1–3 keywords + synonyms, biased by the button's semantic action
   (trash on a row = delete; floppy = save; three vertical dots = more/menu).
3. **Resolve the target set once** per project (grep pages/config for `icon=`/`@iconify`);
   default bias `mdi,lucide,tabler,material-symbols`.
4. **Search, stripped:** `curl -s 'https://api.iconify.design/search?query=<kw>&prefixes=<sets>&limit=32'`
   piped through python/jq to emit **only** the `icons[]` array (drop the `collections` blob —
   `limit` has an enforced floor of 32). Try up to 2 synonyms if thin.
5. **Pick unambiguous name match** with no visual round-trip (~300–500 tokens).
6. **Verify visually only when ambiguous** (dots-vertical vs -horizontal, filter vs sliders,
   share vs export): fetch `https://api.iconify.design/{prefix}:{name}.svg`, rasterize **locally**
   (resvg/rsvg-convert/ImageMagick — the public `.png` endpoint returns 0 bytes), Read the small
   PNG, compare to the crop (~1000–1500 tokens).
7. **Confirm the id resolves** (SVG fetch returns a body) before writing it.
8. **Fallback — never guess an id:** proprietary/brand/no-confident-match → crop the button from
   the screenshot into `./.assets/` (screenshot-crop for this one icon); can't confirm at all →
   `{/* NEEDS CONFIRMATION: iconify id for <glyph> button */}`.

**Token discipline:** `prefixes` filter; strip to `icons[]`; batch multi-icon data via
`{prefix}.json?icons=a,b,c`; skip step 6 for unambiguous names.

**Degradation:** step 6 needs a local rasterizer; if none is installed, the skill probes once, says
so, and leans harder on NEEDS CONFIRMATION.

---

## Config field (new)

Register `Icon rendering:` in the host's `## Documentation toolkit configuration` block, resolved
via `context/project-paths.md`'s ask-once/offer-to-persist procedure — same mechanism as
`Style guide:` / `UA content root:`.

| Value | Writer emits (theme-aware) | Host must have |
|---|---|---|
| `iconify-component` | `<Icon icon="mdi:content-save" height="20" /> **Зберегти**` | `@iconify/react` installed + `Icon` registered globally in swizzled `MDXComponents`; MDX authoring. **← UCPay declares this.** |
| `iconify-svg` | `<img src={require('./.assets/icon-save.svg').default} width="18" alt="" /> **Зберегти**` | Docusaurus returning a **URL** for `require('*.svg').default` (see Open Q1). |
| `screenshot-crop` *(default when undeclared)* | `<img src={require('./.assets/icon-more.png').default} width="18" alt="" /> **More** button` | Nothing beyond the existing screenshot pipeline. |
| `describe` | No inline image; descriptive text only. | Nothing. |

Note: the toolkit uses the `require('./.assets/...').default` pattern for compact images because
Docusaurus doesn't reliably resolve a raw document-relative `src` on `<img>` in the built site.

---

## Exact edits when we build

| File | Change |
|---|---|
| `context/doc-rules/project-rules/formatting-conventions.md` | Add Ж8 (Core + UA + EN) + checklist line; note `Icon rendering:` resolved via `project-paths.md`. |
| `skills/user-guide-writer/SKILL.md` (146–149) | Delete inline tree → one line: follow **Ж8**; to resolve an unknown id invoke **identify-ui-icon**. |
| `skills/concept-doc-writer/SKILL.md` | Extend Ж-range refs to include Ж8 + add the `identify-ui-icon` hand-off line. *(closes gap)* |
| `skills/api-doc-writer/SKILL.md` | Same one-line Ж8 + `identify-ui-icon` ref (EN-only → Core + English). *(closes gap)* |
| `context/doc-templates/user-guide-template.md` (31–34) | Replace duplicated tree with pointer to Ж8. |
| `context/doc-templates/ua-user-guide-template.md` (27–32) | Replace duplicated tree with pointer to Ж8. |
| `skills/doc-translator/SKILL.md` | Add `iconify-svg`/`screenshot-crop` `<img …require…>` markup to the preserve list; target Ж8 sentence form in isolated-step expansion. |
| `skills/identify-ui-icon/SKILL.md` | **New skill** (auto-discovered, no manifest edit). Skeleton below. |
| `context/project-paths.md` + host `CLAUDE.md` config doc | Register `Icon rendering:` field (values, default `screenshot-crop`, ask-once/persist). |
| `commands/identify-icon.md` | *Optional* thin command binding `$ARGUMENTS` to a screenshot path. |

Pipeline fit: `app-explorer` records "icon-only, no label" + tooltip/aria-label (+ id if confident)
into `.sources/app-notes.md`; `extract-sme-screenshots` supplies frames to crop;
`cleanup-unused-screenshots` already sweeps unreferenced `.assets/` files (icon crops/SVGs covered).

## New skill skeleton — `skills/identify-ui-icon/SKILL.md`

```md
---
name: identify-ui-icon
description: >
  Identifies the Iconify icon id for an icon-only UI button from a screenshot/crop,
  so a writer can render it per Ж8. Explicit-invocation only; invoked by the *-writer
  skills when they hit an unlabeled button. Falls back to a screenshot crop or a
  NEEDS CONFIRMATION marker — never guesses an id. Does not write doc pages.
---

# identify-ui-icon

## Scope
<!-- In: glyph -> Iconify id via public search API; visual verify; fallback selection.
     Out: placing the icon in a page (Ж8 in the writers); choosing the accessible NAME
     (app-explorer/SME); rendering method (host Icon rendering: field).
     Cross-ref app-explorer and cleanup-unused-screenshots by name. -->

## Sources to load
<!-- Ж8 of formatting-conventions.md; .sources/app-notes.md if present. Nothing else. -->

## Inputs
<!-- A button crop/screenshot path + surrounding UI context; optional icon-set preference. -->

## Workflow
<!-- 1. Reuse app-notes id/label if present (skip network).
     2. Name glyph in keywords + synonyms, biased by semantic action.
     3. Resolve target set once (grep project) or default mdi,lucide,tabler,material-symbols.
     4. curl search?query&prefixes&limit=32, strip to icons[] only.
     5. Pick unambiguous name match without visual round-trip.
     6. Ambiguous -> fetch SVG, rasterize LOCALLY, Read PNG, compare.
     7. Confirm id resolves; for iconify-svg save SVG into ./.assets/.
     8. Fallback: crop to ./.assets/ (screenshot-crop) OR NEEDS CONFIRMATION. Never guess. -->

## Output contract
<!-- Return: {iconify id | screenshot-crop path | NEEDS CONFIRMATION marker}, chosen set,
     confidence (unambiguous vs verified). No prose edits to any page. -->

## Token discipline
<!-- prefixes filter; strip to icons[]; batch {prefix}.json?icons=; skip verify when unambiguous. -->

## Self-review checklist
<!-- id resolves to a real SVG; set license acceptable; ambiguous glyphs visually verified;
     no guessed id committed; fallback marker used when unconfirmed. -->

## Explicit invocation examples
<!-- "use identify-ui-icon on this toolbar crop"; invoked by user-guide-writer/
     concept-doc-writer/api-doc-writer when a step hits an icon-only button with no known id. -->
```

---

## Open questions still to resolve (don't block the design)

1. **`iconify-svg` viability** — does UCPay's Docusaurus return a **URL** or an **SVGR component**
   for `require('./x.svg').default`? If SVGR, `<img src={…}>` breaks and `iconify-svg` must emit
   `require('./x.svg?url').default`. Doesn't affect UCPay (it uses `iconify-component`); verify
   before enabling `iconify-svg` for any host. Until then default stays `screenshot-crop`.
2. **Accessible-name sourcing** — Ж8 branch 2 needs the tooltip/aria-label, which Iconify can't
   provide. Confirm `app-explorer` will capture it into `app-notes.md`; otherwise branch 3 +
   NEEDS CONFIRMATION becomes the common path.
3. **Iconify API rate limits / license gate** — search+SVG endpoints verified live; rate limits
   not confirmed (add backoff). If saving SVGs into a host repo (`iconify-svg`), read the set's
   license from the `collections` block and flag non-permissive sets.
4. **Standalone command?** Ship `commands/identify-icon.md` for direct human use, or keep the skill
   writer-invoked only? Low cost either way.
