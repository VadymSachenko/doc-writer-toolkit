---
name: cleanup-unused-screenshots
description: Moves screenshots from a .sources/frames/{video-name}-frames/ folder into a _unused/ subfolder if a target doc never ends up referencing them. Use after a doc has been written from extract-sme-screenshots output, to sweep up whichever candidate screenshots didn't get used. Never deletes anything - moves only.
---

# cleanup-unused-screenshots

## Overview

After `extract-sme-screenshots` produces a pool of candidate screenshots and someone writes the actual doc (referencing only some of them, likely copied into `.assets/` per this project's normal publishing convention), this skill sweeps up whichever screenshots never got used — without deleting anything.

## Inputs

- A target doc file (e.g. `partner-cabinet/archive/archive.md`).
- Optionally, which `.sources/frames/*-frames/` folder to check. If omitted, look for a single such folder under the doc's `.sources/frames/`; if there's more than one, ask which one before proceeding.

## Workflow

1. Read the target doc's full text.
2. Collect every image filename referenced anywhere in it — match by **basename only**, not full path. The doc likely references a copy of a screenshot from `.assets/`, not the original in `.sources/`, so matching on the full relative path would falsely mark everything as unused. A copy existing in `.assets/` does not by itself make a screenshot "used" — only an actual reference from the doc's text does; `.assets/` holds copies, `frames/` holds the full archive, and this skill only ever acts on `frames/`. Call this set the **doc references**.
3. Load the origin→published link from `frames-index.json` (the K8 index alongside the screenshots: OCR/transcript text, score, and reasons per screenshot — traceability and lookup metadata, not a screenshot itself). For each entry, note its `screenshot` (the original `screen-*.jpg` basename) and its optional `published_as` list — the cropped, renamed filenames a writer skill embedded from that frame (see `screenshot-selection.md`, "Record which frame this embed came from"). **This link is the whole point of this step:** published embeds are *cropped and renamed* (`screen-00-19-42.jpg` → `transactions-page.png`), so a **used** frame's original basename almost never appears in the doc verbatim. Matching basenames alone — the old behavior — therefore swept the originals of *used* screenshots into `_unused/`. If no `frames-index.json` exists, there is no link to load: every frame can only be matched by its own basename, and step 5's warning applies to every renamed embed in the doc.
4. List every `screen-*.jpg` file directly inside the screenshots folder — not `frames-index.json` itself, and not the `_unused/` subfolder. Classify each one as **used** or **unused**:
   - **Used** if its own basename appears in the doc references, **OR** any name in that frame's `published_as` list (from step 3) appears in the doc references.
   - **Unused** otherwise.
5. Detect untraceable renamed embeds, and warn rather than sweep blindly. A doc reference is *untraceable* when it is neither a `screen-*.jpg` name nor listed in any frame's `published_as` — a renamed embed whose origin frame was never recorded. **The warning only matters when this run is actually moving at least one frame:** if every frame is kept as used, nothing is at risk, so skip the warning entirely. When frames *are* being moved and an untraceable renamed embed exists, one of the moved frames might silently be that embed's origin — so emit a warning that names each untraceable embed and tells the user to review `_unused/` manually before deleting it. Most untraceable embeds are benign (screenshots captured straight into `.assets/` by `app-explorer`/`resolve-markers`, hand-added images, or curated case-1 assets that never had an origin frame), which is exactly why this is a conservative warning, not an error, and why the move still proceeds: nothing is deleted; everything stays recoverable in `_unused/`. Never a silent sweep — when frames are moved and any embed is untraceable, the warning **must** appear. Omit it when no frames are moved, or when every renamed embed traces back through `published_as`.
6. Create `_unused/` inside the screenshots folder if it doesn't exist, and move (not delete) each unused file into it.
7. If `frames-index.json` exists, update each moved file's entry in place (e.g. its `screenshot` path reflecting the new `_unused/` location) rather than leaving a stale or orphaned entry — leave `published_as` and every other field on the entry intact. The index should keep describing where every screenshot actually is, not just the ones still in the top-level folder.
8. Report exactly what moved, what stayed, and any warning, e.g.:

   ```
   Kept (referenced in archive.md): screen-00-19-42.jpg → transactions-page.png, screen-00-26-12.jpg → filters-pane.png
   Moved to _unused/: 307 files
   Warning: 2 doc image references are renamed embeds with no recorded origin frame
     (legacy-screenshot.png, hand-added.png) — a file just moved to _unused/ may be
     one of their originals. Review _unused/ before deleting it.
   ```

   Show the `→ published_as` mapping on the Kept line only where a link exists. Omit the `Warning:` block entirely when every renamed embed traced back through `published_as`.

## Non-negotiables

- **Never delete.** Always move into `_unused/` — the user reviews and deletes that folder themselves when ready. This mirrors this project's own repos, where `Bash(rm:*)` is denied by policy in `.claude/settings.json`; this skill should behave the same way even in a project that doesn't have that rule.
- If the screenshots folder already has a `_unused/` subfolder from a previous run, add to it rather than overwriting — don't clobber a prior cleanup pass.
- If the target doc references an image filename that *isn't* in the screenshots folder at all, don't treat that as an error — it just means that image came from somewhere else (a different `.sources/` folder, a manually added screenshot). Only act on files that are actually present in the folder being cleaned up.
- **Never sweep an untraceable rename silently.** When a renamed embed can't be traced back to a frame through `published_as` (Workflow step 5), the move still happens — it's recoverable — but the report must carry the warning naming that embed. A silent sweep that hides the original of a *used* screenshot is the exact failure this skill guards against.
- Never delete or drop entries from `frames-index.json` — update the moved ones' locations and keep the rest as-is, preserving each entry's `published_as` and all other fields.
