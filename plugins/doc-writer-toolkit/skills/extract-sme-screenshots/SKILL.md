---
name: extract-sme-screenshots
description: Extracts deduplicated screenshots (and, if needed, an auto-transcribed transcript) from a meeting recording placed in a doc page's .sources/ folder. Use when the user has dropped a video (and optionally a transcript) into .sources/ and wants screenshots ready for convert-sme-input or a doc-writing skill. Not for producing the final structured source note itself — that's convert-sme-input's job.
---

# extract-sme-screenshots

## Overview

Turns a raw meeting video sitting in a `.sources/` folder into a folder of selected screenshots, ready for `convert-sme-input` or a doc-writing skill to reference. This skill only produces screenshots (and a transcript when one didn't already exist) — it does not write the structured source note itself.

**Two named modes, equally valid — neither is "the normal case" or a fallback for the other:**

- **Mode A — transcript-driven.** Transcript → `--plan-from-transcript` picks candidate seconds by scoring what the SME talked about → `--extract-at` pulls exactly those frames. No full-video decode. Tens of frames, well under a minute of processing — roughly **3 seconds per minute of recording**, measured at about 2 minutes on a 41-minute 19-second recording (planning is negligible: 0.18 s for the whole transcript; the rest is frame extraction plus OCR of just those frames). Covers what the SME **said**.
- **Mode B — bulk sweep.** Full pipeline: ffmpeg frame extraction + OCR + pHash dedup. Roughly **30 seconds of processing per 1 minute of recording**, on 8 cores (the script's own default is already `cpu_count-1`; pass `--jobs` explicitly only to throttle it if the machine is needed for something else) — measured at 27.4 s/min total, 24.3 s/min of that in the OCR/text-recognition stage, which works out to about 19 minutes for a 41-minute recording. Typically a hundred-plus frames. Also covers what the SME **showed but never said out loud**.

Both figures were measured on a near-idle 8-core machine and scale linearly with recording length, so multiply by the length of the video rather than quoting them as absolutes. Mode B's per-minute cost depends on core count; Mode A's barely does, since it only touches the frames it picked.
- **Combined path** (usually the cheapest overall): run Mode A first, write the doc, then use "Targeted extraction" below to pull frames for just the specific timestamps that turned out to be missing. This costs less than Mode B and closes most gaps a transcript-only pass leaves.

**This skill is also invoked from inside `convert-sme-input`** for one-off targeted pulls mid-workflow — see "Targeted extraction" below, which `convert-sme-input` follows directly rather than this skill re-describing the procedure there.

## Inputs

A `.sources/` folder (e.g. `partner-cabinet/archive/.sources/`) containing:

- Exactly one video file.
- Zero or more `.txt` transcript files (e.g. TurboScribe exports).

## Workflow

### Step 1 — Identify the transcript situation

- **No `.txt` files present:** the underlying script will auto-transcribe via Whisper. No offset math needed.
- **Exactly one `.txt` file:** pass it through as-is (implicit offset 0).
- **More than one `.txt` file:** read each file's timestamp ranges (format: `(M:SS - M:SS)` headers). Check whether a later part's timestamps restart near `0:00` while an earlier part ends near where the later one would need to pick up — that's the signal it needs an offset to continue the same recording. **Confirm the part ordering and offset with the user before running anything** if it isn't unambiguous from the timestamps alone. Do not guess silently — this exact mistake is easy to make quietly and hard to notice after the fact.

### Step 2 — Choose the mode

If `.sources/frames/{video-basename}-frames/` is empty or doesn't exist yet **and** a transcript is available (existing `.txt` file, or one already generated), **stop and ask the user which mode to run** — Mode A or Mode B, from the Overview above — showing both estimates (time, rough frame count) side by side. Do not recommend one over the other and do not pick silently; this is the user's call, not a default the model applies.

Read your own phrasing back before asking: if it could plausibly be read as steering toward bulk ("frames are missing, so..."), rewrite it. State the two options as equally available, not as a normal case plus an exception.

If no transcript exists at all (and none will be auto-generated, e.g. the user declines Whisper), Mode A is impossible — say so explicitly and proceed with Mode B.

Once a mode is chosen (or Mode B is the only option), continue:
- **Mode A:** skip Step 3 (venv) entirely — see "Targeted extraction" below for how `--plan-from-transcript` + `--extract-at` runs; ffmpeg on `PATH` is all that's needed.
- **Mode B:** continue to Step 3.

### Step 3 — Ensure the environment

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

### Step 4 — Run the script

Run into a scratch output directory (not directly into `.sources/`), in the **background** — a full bulk pass on a long recording can take up to an hour, and nothing about this pipeline needs the conversation blocked while it runs:

```bash
"$VENV/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py" \
  "<path-to-video>" \
  "<scratch-output-dir>" \
  --transcript "<part1.txt>" --transcript "<part2.txt>@<offset-seconds>" \
  --progress-file "<scratch-output-dir>/progress.json"
# (omit all --transcript flags entirely to auto-transcribe via Whisper)
# add --jobs N only to deliberately throttle below the script's cpu_count-1 default
```

**Progress, without burning tokens on it:** the script rewrites `progress.json` atomically (schema: `stage`, `done`, `total`, `pct`, `elapsed_s`, `eta_s`) at most once a second. When the user asks for status, read that one file **once** and report the numbers back — that's the entire cost. Do not poll it in a loop, do not sleep-and-recheck repeatedly, and do not read the script's stdout in bulk to "watch" it; the file is the whole point of K2, exactly so progress doesn't cost anything beyond a single cheap read per question.

### Step 5 — Keep everything that lets a screenshot be found without opening it

The destination is `.sources/frames/{video-basename}-frames/` (create it, including the `frames/` parent, if it doesn't exist yet). If it already has screenshots in it — e.g. `convert-sme-input` already pulled some via targeted extraction before this bulk pass ever ran — that's fine; the merge below is duplicate-aware and won't re-add anything already covered.

- Merge `<scratch-output-dir>/images/` into the destination:
  ```bash
  "$VENV/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py" \
    "<path-to-video>" ".sources/frames/{video-basename}-frames" --merge-from "<scratch-output-dir>/images"
  ```
- Merge `<scratch-output-dir>/transcript-key/images/` into the same destination the same way. The script's built-in transcript-relevance heuristic (Ukrainian/Russian keyword scoring — see the script's `transcript_relevance`) already guarantees a screenshot exists near every transcript moment it scores as significant, extracting a fresh frame via ffmpeg when the visual dedup pass alone would have skipped it. Don't skip this merge — it's exactly the "don't skip a critical moment" guarantee, already computed for free, and `--merge-from` will naturally skip anything the first merge already placed near the same moment.
- `frames-index.json` lands at `.sources/frames/{video-basename}-frames/frames-index.json`, alongside the screenshots — the script writes and maintains it; both `--merge-from` and `--extract-at` append entries to it rather than overwriting, so running either one again later only adds to it. **This is the index a doc-writing skill reads to pick a screenshot by its OCR text or the SME's transcript wording, without opening all of them** — selecting which ones actually get copied into `.assets/` for the published doc is the writer skills' job, not this skill's.
- If there was no input transcript (Whisper ran), also move `<scratch-output-dir>/transcript.txt` to `.sources/{video-basename}-transcript.txt` (sibling of `frames/`, not inside it) — this is now the only record of what was said; don't let it get discarded with the rest of the scratch output.
- Delete only what's genuinely disposable scratch: `contact-sheet.jpg`, `frame-decisions.csv`, `transcript.json`, `key/`, and the rest of `transcript-key/` once its `images/` are merged. **Do not delete `context.md` or `ocr/`** — the whole point of `frames-index.json` is to carry that description forward; treating it as safe-to-delete scratch output defeats it.

### Step 6 — Report

State how many screenshots were kept (and how many were skipped as already-covered duplicates, if the destination wasn't empty), where they landed, and whether a transcript was auto-generated (and if so, that it hasn't been human-reviewed — Whisper output can mis-hear names, numbers, and technical terms, so flag it as needing a pass before being treated as ground truth).

**Warn every time: these frames are raw and unchecked.** Nothing in this skill crops, redacts, or inspects a frame's contents — a meeting recording routinely captures faces, names, internal hostnames/IPs, environment labels, and other sensitive material in the background. This output is evidence to read and select from, not embeddable material. State explicitly that none of these frames may be inserted into a document until they've gone through the screening/cropping step in the writer skill that consumes them (concept-doc-writer, user-guide-writer, or api-doc-writer — the mandatory step between selecting a frame and renaming it).

## Targeted extraction (used standalone or from convert-sme-input)

Guarantees a screenshot near one or more specific moments in an **already-existing** `.sources/frames/{video-basename}-frames/` folder, without re-running the full pipeline:

```bash
"$VENV/bin/python" "${CLAUDE_PLUGIN_ROOT}/scripts/sme-video-context/sme_video_context.py" \
  "<path-to-video>" ".sources/frames/{video-basename}-frames" \
  --extract-at "<seconds-1>,<seconds-2>,..."
```

- Pass every needed timestamp in **one call**, comma-separated — don't call this once per timestamp. Each requested second is checked against what's already in the folder; a new frame is extracted via ffmpeg only for the ones not already covered.
- `--tolerance` (default 15s) controls how close an existing screenshot must be to count as already covering a requested second.
- This mode needs only `ffmpeg` on `PATH` — no Python packages, no persistent venv setup (Step 3 above doesn't apply here). That's what makes it cheap enough for `convert-sme-input` to call directly mid-workflow instead of only as a manual follow-up.
- This is also how Mode A's `--plan-from-transcript` output gets turned into screenshots: feed the seconds it picks straight into `--extract-at` as above.
- Each new frame gets appended to `frames-index.json` (K8) alongside the existing entries — this call never overwrites the index, only adds to it.
- Report how many new screenshots were extracted versus already covered.

This is also what a manual "second pass" after `convert-sme-input` finishes looks like: pull every `(M:SS)`/`(M:SS–M:SS)` citation out of the finished `sme-interview.md` (for a range, use the midpoint) and run this once with all of them.

## Out of scope

- Writing the structured source note — hand off to `convert-sme-input` for that.
- Deciding which of the extracted screenshots the final doc actually needs — that happens naturally when someone writes the doc and references the ones they want; use `cleanup-unused-screenshots` afterward to sweep up the rest.
