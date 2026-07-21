---
name: extract-sme-screenshots
description: Extracts deduplicated screenshots (and, if needed, an auto-transcribed transcript) from a meeting recording placed in a doc page's .sources/ folder. Use when the user has dropped a video (and optionally a transcript) into .sources/ and wants screenshots ready for convert-sme-input or a doc-writing skill. Not for producing the final structured source note itself — that's convert-sme-input's job.
---

# extract-sme-screenshots

## Overview

Turns a raw meeting video sitting in a `.sources/` folder into a folder of selected screenshots, ready for `convert-sme-input` or a doc-writing skill to reference. This skill only produces screenshots (and a transcript when one didn't already exist) — it does not write the structured source note itself.

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

- Move `<scratch-output-dir>/images/` to `.sources/{video-basename}-screenshots/`.
- If there was no input transcript (Whisper ran), also move `<scratch-output-dir>/transcript.txt` to `.sources/{video-basename}-transcript.txt` — this is now the only record of what was said; don't let it get discarded with the rest of the scratch output.
- Delete the scratch output directory and everything else in it (`context.md`, `ocr/`, `contact-sheet.jpg`, `frame-decisions.csv`, `transcript.json`, any partial `key/`/`transcript-key/`) — none of it is needed once the screenshots (and transcript, if freshly generated) are extracted.

### Step 5 — Report

State how many screenshots were kept, where they landed, and whether a transcript was auto-generated (and if so, that it hasn't been human-reviewed — Whisper output can mis-hear names, numbers, and technical terms, so flag it as needing a pass before being treated as ground truth).

## Out of scope

- Writing the structured source note — hand off to `convert-sme-input` for that.
- Deciding which of the extracted screenshots the final doc actually needs — that happens naturally when someone writes the doc and references the ones they want; use `cleanup-unused-screenshots` afterward to sweep up the rest.
