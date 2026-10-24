---
name: identify-ui-icon
description: 'Finds the picture for an icon-only UI control on a doc page, in the form the project renders icons: the matching Iconify id (from the evidence, or from the public Iconify API with a local visual check when names are ambiguous), the icon''s SVG saved to the page''s .assets/, or a crop of the control from a screenshot. Never guesses an id: falls back to a crop or a NEEDS CONFIRMATION marker. Never names the control and never edits a page. The writer skills call it by name when a step hits an icon-only control. Explicit invocation only: use explicitly ("identify-ui-icon", "use identify-ui-icon on the toolbar screenshot of ..."); never on a loose question about an icon.'
---

# identify-ui-icon

You find the picture for one icon-only control, or a few on one page, so that a writer can show it as Ж8 of `formatting-conventions.md` prescribes. You return an Iconify id, a file in the page's `.assets/`, or a marker. You never decide what the control is called, and you never edit a page.

## Scope

- **In scope:** the icon-only controls of one page; reusing an Iconify id or a crop the evidence already gives; looking up an Iconify id through the public Iconify API; a local visual check when several names fit; saving the icon's SVG into the page's `.assets/` (render `iconify-svg`); cropping the control from a screenshot into `.assets/` (render `screenshot-crop`, or the fallback).
- **Out of scope:** the control's name. It comes from the evidence only: the tooltip or `aria-label` that `app-explorer` records in `app-notes.md`, the author's notes or the SME. When there is none, the writer uses Ж8 branch 3. Also out of scope: placing the icon in a page and phrasing the step (`user-guide-writer`, `concept-doc-writer`, `api-doc-writer`, `doc-page-updater`, all under Ж8); capturing new screenshots (`app-explorer`, `resolve-markers`); choosing the render form (the host's `Icon rendering:` field); moving unused files (`cleanup-unused-screenshots`, which sweeps frames only, not `.assets/`).

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md`, section Ж8 only: the render table, the file names and the `iconify-svg` check.
2. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`: the page's root pair and the `Icon rendering:` field.
3. The page folder's `.sources/app-notes.md`, if it exists.
4. The screenshot or crop the caller names.

Nothing else: no style corpora, no templates.

## Inputs

- **The control:** a crop of it, or a screenshot plus where the control sits ("the three-dots button at the end of each payment row"). Add what the control does if the evidence says.
- **The page folder:** for its `.assets/` and `.sources/`.
- **`prefixes:`** (optional): the icon sets to search, such as `mdi,tabler`.

If neither a crop nor a screenshot with the control's place is given, ask once for it and stop.

## Workflow

1. **Resolve the render.** Read `Icon rendering:` as `project-paths.md` describes. If it is absent, use `screenshot-crop`, say so, and offer once to persist the declaration. What each value needs:
   - `iconify-component`: an Iconify id;
   - `iconify-svg`: an Iconify id and its SVG file;
   - `screenshot-crop`: a crop file (no id);
   - `describe`: nothing. Report "no image needed" and stop.
2. **Reuse the evidence.** In `app-notes.md`, the control's line under "Icon-only controls" may give an Iconify id taken from the DOM. For `screenshot-crop`, a `*-icon.png` in `.assets/` that shows this control is the crop. If the evidence gives what the render needs, make no network call: go to step 11 for `iconify-component` and `screenshot-crop`, or to step 7 for `iconify-svg`, which still fetches the SVG.
3. **`screenshot-crop`: crop, don't search.** Go to step 9. The render needs no id.
4. **Name the glyph.** Write one to three English search keywords and a synonym or two, biased by what the control does when the evidence says: a trash can on a row is `delete`, `trash`; a floppy disk is `save`, `content-save`; three vertical dots are `dots-vertical`, `more`. The keywords serve the search only. They never become the control's name on the page.
5. **Search.**
   - Pick the icon sets once per run. Use the sets the site already uses, most used first: `grep -rhoE 'icon="[a-z0-9-]+:' <UA content root> | sort | uniq -c | sort -rn`. With none found, use `mdi,lucide,tabler,material-symbols`. A caller's `prefixes:` wins.
   - Run `curl -sS --fail --max-time 10 --retry 3 'https://api.iconify.design/search?query=<keyword>&prefixes=<sets>&limit=32'` and keep only what you need: `jq -c '{icons, licenses: ((.collections // {}) | map_values(.license.spdx // .license.title))}'` (or the same in `python3 -c`). `limit` can't go below 32.
   - If the list is thin, try up to two synonyms.
6. **Choose.**
   - One name matches the glyph and the action without doubt (`mdi:delete-outline` for an outlined trash can): take it, with no visual check.
   - Several names fit and differ in shape (vertical or horizontal dots, filter or sliders, share or export, outline or filled): check visually. Fetch each candidate's SVG (`https://api.iconify.design/<prefix>:<name>.svg`), rasterize it locally to a small PNG (`rsvg-convert -w 64`, `resvg -w 64`, or `magick -background white`), Read the PNGs and compare them with the control. Don't use the API's `.png` endpoint: it returns an empty body.
   - Probe for a rasterizer once (`command -v rsvg-convert resvg magick convert`). With none, say so, skip the visual check, and treat an ambiguous match as no match (step 8).
7. **Confirm the id and read the license.**
   - Fetch the id's SVG. A non-empty `<svg` body proves the id exists. An id from the evidence is confirmed the same way when the render saves its SVG.
   - Read the set's license: the `licenses` kept in step 5, or `curl … 'https://api.iconify.design/collections?prefixes=<prefix>'`, field `<prefix>.license`.
   - Permissive: `MIT`, `Apache-2.0`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `Unlicense`. Any other license, or none, is flagged.
   - `iconify-svg`: save the SVG as `./.assets/<name>-icon.svg` only from a permissive set. For a flagged set, save nothing: report the set and its license, and offer an icon from a permissive set or a crop. Save it only after the user confirms that set.
   - `iconify-component`: nothing is saved. Report the license with the id.
8. **Fall back. Never guess an id.** When there is no confident match, the glyph is a brand or app-specific mark, the set is flagged and not confirmed, or the API is unavailable:
   - if a screenshot shows the control, crop it (step 9). The page then shows this one icon in the `screenshot-crop` form, whatever `Icon rendering:` says;
   - with no screenshot, return `{/* NEEDS CONFIRMATION: Iconify id for the <glyph> button */}` for the writer to place.
9. **Crop.** Cut the control's bounding box from the screenshot with a margin of about 2 px, at the screenshot's own scale. Save it as PNG to `./.assets/<name>-icon.png` with `magick <screenshot> -crop <W>x<H>+<X>+<Y> +repage <file>` or Pillow. Read the crop once: it shows the whole control and nothing else, with no text, no data and no neighbouring control. Probe for a crop tool once. With none, return `{/* ToDo: add the icon crop for the <glyph> button, from <screenshot> */}` instead.
   - `<name>` is kebab-case: the action when the evidence names it (`delete-icon.png`), else the glyph (`dots-vertical-icon.png`). Never overwrite a file: if the name is taken by another icon, add `-2`.
10. **When the API fails.** `curl --retry 3` already backs off (1 s, 2 s, 4 s) on a timeout, a `429` or a `5xx`, and honours `Retry-After`. If a request still fails, make no further API call in this run and write no retry loop of your own. Every control not yet resolved goes to step 8, and the report says the API was unavailable.
11. **Self-review**, below, then report.

## Self-review before saving

- Every id returned came from the evidence or resolved to a non-empty SVG in this run.
- Every ambiguous match was checked visually, or went to the fallback.
- No id was guessed. Every unresolved control has a crop, a marker or a ToDo.
- No SVG from a flagged set was saved without the user's confirmation.
- Every file written sits in the page's `.assets/`, is named `*-icon.png` or `*-icon.svg`, and overwrote nothing.
- No page was edited, and no control got a name the evidence doesn't give.
- No API call was made after the API failed.

Fix anything that fails before you report.

## Output contract

One block per control. The `Markup` line is the icon part of Ж8's table only: the writer adds the verb, the noun and the name.

```
Icon rendering: screenshot-crop (default, not declared)

Control: three-dots button at the end of each payment row (payments-page.png)
  Result: crop | Iconify id | marker
  Iconify id: mdi:dots-vertical | none
  Set: mdi, license Apache-2.0, permissive | flagged: <license> | not checked
  Confidence: evidence | unambiguous | checked visually | none
  File: ./.assets/dots-vertical-icon.png | none
  Markup: <img src={require('./.assets/dots-vertical-icon.png').default} height="20" alt="" />
  Name: <tooltip or aria-label> (app-notes.md) | none in the evidence: Ж8 branch 3
  Marker: none | {/* NEEDS CONFIRMATION: … */} | {/* ToDo: … */}
```

After the blocks: the files written, the network calls made (or "none: evidence"), and whether the API failed.

## Token discipline

- Filter by `prefixes` and keep only `icons` and the licenses from a search.
- Fetch several icons of one set in one call: `https://api.iconify.design/<prefix>.json?icons=a,b,c`.
- Skip the visual check when the name is unambiguous.
- Read each rasterized PNG and each crop once.

## Explicit invocation examples

- "identify-ui-icon: the three-dots button at the end of each row in `portal/payments/.assets/payments-page.png`"
- "use identify-ui-icon on `portal/settings/.assets/toolbar.png`, the trash button, prefixes: mdi"
- "/identify-icon portal/payments/.assets/payments-page.png the trash button in each row"
- `user-guide-writer`, `concept-doc-writer` and `api-doc-writer` call it by name when a step hits an icon-only control whose id or crop the evidence doesn't give.

A loose question ("what icon is this?") doesn't start this skill: ask whether to run it.
