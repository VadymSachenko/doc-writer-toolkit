---
name: cleanup-unused-screenshots
description: Moves screenshots from a .sources/{video-name}-screenshots/ folder into a _unused/ subfolder if a target doc never ends up referencing them. Use after a doc has been written from extract-sme-screenshots output, to sweep up whichever candidate screenshots didn't get used. Never deletes anything - moves only.
---

# cleanup-unused-screenshots

## Overview

After `extract-sme-screenshots` produces a pool of candidate screenshots and someone writes the actual doc (referencing only some of them, likely copied into `.assets/` per this project's normal publishing convention), this skill sweeps up whichever screenshots never got used — without deleting anything.

## Inputs

- A target doc file (e.g. `partner-cabinet/archive/archive.md`).
- Optionally, which `.sources/*-screenshots/` folder to check. If omitted, look for a single such folder next to the doc's `.sources/`; if there's more than one, ask which one before proceeding.

## Workflow

1. Read the target doc's full text.
2. Collect every image filename referenced anywhere in it — match by **basename only**, not full path. The doc likely references a copy of a screenshot from `.assets/`, not the original in `.sources/`, so matching on the full relative path would falsely mark everything as unused.
3. List every file directly inside the screenshots folder. Any file whose basename doesn't appear anywhere in the doc's text is unused.
4. Create `_unused/` inside the screenshots folder if it doesn't exist, and move (not delete) each unused file into it.
5. Report exactly what moved and what stayed, e.g.:

   ```
   Kept (referenced in archive.md): screen-00-19-42.jpg, screen-00-26-12.jpg
   Moved to _unused/: 307 files
   ```

## Non-negotiables

- **Never delete.** Always move into `_unused/` — the user reviews and deletes that folder themselves when ready. This mirrors this project's own repos, where `Bash(rm:*)` is denied by policy in `.claude/settings.json`; this skill should behave the same way even in a project that doesn't have that rule.
- If the screenshots folder already has a `_unused/` subfolder from a previous run, add to it rather than overwriting — don't clobber a prior cleanup pass.
- If the target doc references an image filename that *isn't* in the screenshots folder at all, don't treat that as an error — it just means that image came from somewhere else (a different `.sources/` folder, a manually added screenshot). Only act on files that are actually present in the folder being cleaned up.
