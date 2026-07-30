---
name: extract-sme-screenshots
description: Extracts deduplicated screenshots (and, if needed, an auto-transcribed transcript) from a meeting recording placed in a doc page's .sources/ folder. Use when the user has dropped a video (and optionally a transcript) into .sources/ and wants screenshots ready for convert-sme-input or a doc-writing skill. Not for producing the final structured source note itself — that's convert-sme-input's job.
---

# extract-sme-screenshots

## Overview

Turns a raw meeting video sitting in a `.sources/` folder into a folder of selected screenshots, ready for `convert-sme-input` or a doc-writing skill to reference. This skill only produces screenshots (and a transcript when one didn't already exist) — it does not write the structured source note itself.

**Two ways this skill is used:**
1. **Standalone bulk pass** (Steps 1–5 below) — the normal case: a video just landed in `.sources/`, extract everything.
2. **Targeted, invoked from inside `convert-sme-input`** — when that skill needs a screenshot for one specific moment and none exists nearby yet. This doesn't run the full pipeline; see "Targeted extraction" below. `convert-sme-input` follows this section directly rather than re-describing the procedure itself.

## Inputs

A `.sources/` folder (e.g. `partner-cabinet/archive/.sources/`) containing:

- Exactly one video file.
- Zero or more `.txt` transcript files (e.g. TurboScribe exports).

## Workflow

### Step 1 — Identify the transcript situation

- **No `.txt` files present:** the underlying script will auto-transcribe via Whisper. No offset math needed.
- **Exactly one `.txt` file:** pass it through as-is (implicit offset 0).
- **More than one `.txt` file:** read each file's timestamp ranges (format: `(M:SS - M:SS)` headers). Check whether a later part's timestamps restart near `0:00` while an earlier part ends near where the later one would need to pick up — that's the signal it needs an offset to continue the same recording. **Confirm the part ordering and offset with the user before running anything** if it isn't unambiguous from the timestamps alone. Do not guess silently — this exact mistake is easy to make quietly and hard to notice after the fact.

### Step 2 — Ensure the environment

The script (`${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py`) needs `ffmpeg` and `tesseract` (system-installed — check with `which ffmpeg tesseract` first, don't assume) and a Python venv with `Pillow` + `imagehash` always, plus `faster-whisper` only when there's no transcript to import (it's a heavy dependency with a real model download — don't install it if a transcript already covers the whole recording).

Use a **persistent** venv, not a fresh one per run — recreating it (and re-downloading the Whisper model) on every invocation wastes real time and bandwidth for no benefit:

```bash
VENV=~/.cache/doc-writer-toolkit/sme-video-venv
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet Pillow==11.3.0 ImageHash==4.3.2
# only if transcribing from scratch:
"$VENV/bin/pip" install --quiet faster-whisper==1.2.1
```

### Step 3 — Run the script

Run into a scratch output directory (not directly into `.sources/`):

```bash
"$VENV/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py" \
  "<path-to-video>" \
  "<scratch-output-dir>" \
  --transcript "<part1.txt>" --transcript "<part2.txt>@<offset-seconds>"
# (omit all --transcript flags entirely to auto-transcribe via Whisper)
```

**Known script bug — expect and tolerate it:** `write_key_package`/`write_transcript_driven_package` (the `key/` and `transcript-key/` derivative packages) crash with a `FileNotFoundError` on some runs, because they read from the raw-frames temp directory *after* the `with tempfile.TemporaryDirectory(...)` block holding it has already been cleaned up. This is a real bug in the script, not something wrong with your inputs. Since this skill only keeps `images/` (and optionally `transcript.txt`) anyway, treat this specific crash as harmless: check that `<scratch-output-dir>/images/` and `<scratch-output-dir>/context.md` exist and are non-empty even if the script's exit code is non-zero, and proceed. Don't try to fix the bug — it isn't this skill's job.

### Step 4 — Keep only what's needed

The destination is `.sources/frames/{video-basename}-frames/` (create it, including the `frames/` parent, if it doesn't exist yet). If it already has screenshots in it — e.g. `convert-sme-input` already pulled some via targeted extraction before this bulk pass ever ran — that's fine; the merge below is duplicate-aware and won't re-add anything already covered.

- Merge `<scratch-output-dir>/images/` into the destination:
  ```bash
  "$VENV/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py" \
    "<path-to-video>" ".sources/frames/{video-basename}-frames" --merge-from "<scratch-output-dir>/images"
  ```
- Merge `<scratch-output-dir>/transcript-key/images/` into the same destination the same way. The script's built-in transcript-relevance heuristic (Ukrainian/Russian keyword scoring — see the script's `transcript_relevance`) already guarantees a screenshot exists near every transcript moment it scores as significant, extracting a fresh frame via ffmpeg when the visual dedup pass alone would have skipped it. Don't skip this merge — it's exactly the "don't skip a critical moment" guarantee, already computed for free, and `--merge-from` will naturally skip anything the first merge already placed near the same moment.
- Move `<scratch-output-dir>/transcript-key/coverage.json` to `.sources/frames/{video-basename}-frames/coverage.json` — it records which transcript segment (with its score and matched keyword categories) justified each guaranteed screenshot. Keep it as traceability.
- If there was no input transcript (Whisper ran), also move `<scratch-output-dir>/transcript.txt` to `.sources/{video-basename}-transcript.txt` (sibling of `frames/`, not inside it) — this is now the only record of what was said; don't let it get discarded with the rest of the scratch output.
- Delete the scratch output directory and everything else in it (`context.md`, `ocr/`, `contact-sheet.jpg`, `frame-decisions.csv`, `transcript.json`, `key/`, the rest of `transcript-key/`) — none of it is needed once the items above are pulled out.

### Step 5 — Report

State how many screenshots were kept (and how many were skipped as already-covered duplicates, if the destination wasn't empty), where they landed, and whether a transcript was auto-generated (and if so, that it hasn't been human-reviewed — Whisper output can mis-hear names, numbers, and technical terms, so flag it as needing a pass before being treated as ground truth).

## Targeted extraction (used standalone or from convert-sme-input)

Guarantees a screenshot near one or more specific moments in an **already-existing** `.sources/frames/{video-basename}-frames/` folder, without re-running the full pipeline:

```bash
"$VENV/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py" \
  "<path-to-video>" ".sources/frames/{video-basename}-frames" \
  --extract-at "<seconds-1>,<seconds-2>,..."
```

- Pass every needed timestamp in **one call**, comma-separated — don't call this once per timestamp. Each requested second is checked against what's already in the folder; a new frame is extracted via ffmpeg only for the ones not already covered.
- `--tolerance` (default 15s) controls how close an existing screenshot must be to count as already covering a requested second.
- This mode needs only `ffmpeg` on `PATH` — no Python packages, no persistent venv setup (Step 2 above doesn't apply here). That's what makes it cheap enough for `convert-sme-input` to call directly mid-workflow instead of only as a manual follow-up.
- Report how many new screenshots were extracted versus already covered.

This is also what a manual "second pass" after `convert-sme-input` finishes looks like: pull every `(M:SS)`/`(M:SS–M:SS)` citation out of the finished `sme-interview.md` (for a range, use the midpoint) and run this once with all of them.

## Out of scope

- Writing the structured source note — hand off to `convert-sme-input` for that.
- Deciding which of the extracted screenshots the final doc actually needs — that happens naturally when someone writes the doc and references the ones they want; use `cleanup-unused-screenshots` afterward to sweep up the rest.
