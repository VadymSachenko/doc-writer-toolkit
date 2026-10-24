# SME video context processor

Creates a local, AI-readable package containing a timestamped transcript, selected screenshots, OCR, and transcript-to-image alignment.

Two independent ways to get screenshots out of a recording:

- **Bulk sweep** (the original pipeline): decode the whole video, OCR every candidate frame, pHash-dedup them. Thorough, minutes-to-an-hour depending on length and `--jobs`.
- **Transcript-driven planning**: score an existing transcript for moments worth a screenshot (`--plan-from-transcript`), then pull only those frames (`--extract-at`). Seconds, no full-video decode — see "Transcript-driven mode" below. `--extract-at` does OCR the handful of frames it pulls (cheap — see the `ocr_text` note there), so it needs `tesseract` and Pillow; it just skips the expensive bulk decode+dedup pass.

## Prerequisites (macOS)

```bash
brew install ffmpeg tesseract tesseract-lang
python3 -m venv .venv-sme-video
.venv-sme-video/bin/pip install -r sme-video-requirements.txt
```

`--plan-from-transcript` and `--merge-from` don't need this venv at all — they run on a bare `python3` (see each section below). `--extract-at` needs the system `tesseract` binary and the venv's Pillow (no `imagehash`, no `faster-whisper`) — see "Transcript-driven mode".

## Run (bulk sweep)

Use a new output directory for every run:

```bash
.venv-sme-video/bin/python sme_video_context.py \
  /path/to/meeting.mp4 \
  /path/to/output-package \
  --progress-file /path/to/output-package/progress.json
```

Defaults are tuned for mixed English/Ukrainian/Russian technical calls: one candidate every three seconds, pHash threshold 8, Tesseract `eng+ukr+rus`, multilingual `faster-whisper` `small` on CPU, and `--jobs` set to `cpu_count - 1`.

Useful options:

```text
--interval 5                 Fewer candidates for mostly static calls
--hash-threshold 10          More aggressive visual deduplication
--speech-language uk         Force a speech language if auto-detection is wrong
--ocr-language eng+ukr       Restrict OCR languages
--whisper-model medium       Improve transcription at higher CPU/RAM cost
--source-offset 1500         Preserve original timestamps for a clip at 25:00
--resume-visual              Reuse completed screenshots/OCR after an interrupted transcript
--transcript part1.txt       Import TurboScribe text instead of running Whisper
--transcript part2.txt@1500  Offset a second transcript part by 25 minutes
--key-interval 30            At most one key screenshot per 30-second window
--jobs 4                     Throttle OCR parallelism below the cpu_count-1 default
--progress-file PATH         Where to write progress.json (default: <output>/progress.json)
```

`--jobs 1` and `--jobs N` always produce a bit-for-bit identical set of selected screenshots (same files, same OCR text, same `frame-decisions.csv`) for the same input — only the wall-clock time and CPU count differ. Perceptual hashing runs across all workers first; the keep/drop walk that follows is inherently sequential (each decision depends on the last *kept* frame, not the previous one) and OCRs only the frames whose visual distance clears the internal gate — typically under half of them — pulling that text from workers running ahead of it. A frame's OCR text doesn't depend on any other frame, so computing it early is always safe and never changes the result.

On Intel Macs, `--whisper-model tiny` is substantially faster for long calls, with lower transcription accuracy. The screenshots and OCR are unaffected.

The output contains:

- `context.md`: primary input for an LLM
- `images/`: selected original screenshots
- `images/frames-index.json`: one entry per screenshot in `images/` (schema below) — covers every kept frame, not only transcript-justified ones
- `ocr/`: visible text extracted from each screenshot
- `transcript.txt` and `transcript.json`: timestamped speech
- `frame-decisions.csv`: auditable selection decisions
- `contact-sheet.jpg`: quick human review
- `key/`: visually selected set, capped by `--key-interval` (scratch only — disposable)
- `transcript-key/`: visual key set augmented from important conversation timestamps
- `transcript-key/images/frames-index.json`: same schema, for the `transcript-key/images/` set
- `progress.json`: current pipeline progress (schema below), rewritten atomically at most once a second

OCR and transcription are evidence aids, not ground truth. Verify critical names, values, and decisions against the recording.

## Progress: `progress.json`

Rewritten atomically (write to `.tmp`, then `os.replace()`) at most once a second while any long stage is running, so it's always valid JSON to read mid-run:

```json
{"stage": "extract", "done": 412, "total": 823, "pct": 50.1, "elapsed_s": 287, "eta_s": 285}
```

- `stage`: one of `extract` (ffmpeg frame extraction), `hash` (perceptual hashing of every candidate frame), `ocr` (the selection walk, which OCRs frames on demand), `transcribe` (Whisper — not written when `--transcript` is used instead), `merge` (writing `context.md`, the contact sheet, `key/`, `transcript-key/`, and both `frames-index.json` files).
- `done` / `total`: units appropriate to the current stage (frames for `extract`/`hash`/`ocr`, seconds of audio transcribed for `transcribe`, sub-steps for `merge`).
- `pct`, `elapsed_s`: derived arithmetically from `done`/`total` and the current stage's start time — relative to the *current stage*, not the whole run.
- `eta_s`: projected from throughput over a trailing ~20-second window of recent samples, not the whole-stage average (D-11) — so it reacts within a few seconds when throughput actually changes (e.g. swap pressure kicking in mid-run) instead of staying anchored to a faster start.

A single read is the entire cost of checking status — don't poll in a loop; a fresh read a second or more after the last one is guaranteed to reflect current progress.

## Transcript-driven mode

Skip the bulk sweep entirely when a transcript already exists (imported TurboScribe text or a prior Whisper run) and only specific screenshots are needed:

```bash
# 1. Plan: score every transcript segment, print candidates to stdout — seconds, no
#    video, no ffmpeg, no tesseract, no Pillow/imagehash. Runs on bare python3.
python3 sme_video_context.py --plan-from-transcript \
  --transcript part1.txt --transcript part2.txt@1500 > plan.json

# 2. Pick the seconds worth a screenshot from plan.json (e.g. score >= 4), then pull
#    exactly those frames — ffmpeg + tesseract + the venv's Pillow, no imagehash/
#    faster-whisper. Pass the same --transcript flag(s) again here (D-5): without them
#    every frames-index.json entry this call writes comes out with transcript_text: "",
#    score: 0, reasons: [] even though the frame itself was chosen *because* of what was
#    said nearby — the plan (step 1) already proved the relevance, this step just needs
#    the same source to carry it into the index entry.
python3 sme_video_context.py \
  /path/to/meeting.mp4 /path/to/output-package \
  --transcript part1.txt --transcript part2.txt@1500 \
  --extract-at "36,58.5,140,612"
```

`plan.json` is a time-sorted JSON array, one entry per transcript segment:

```json
[
  {"seconds": 45.5, "score": 4, "reasons": ["visual-reference", "technical-detail"], "text": "..."}
]
```

`score`/`reasons` come from the same `transcript_relevance()` heuristic the bulk pipeline uses internally to guarantee transcript-important moments aren't skipped. Filtering by score (and picking which seconds are worth a screenshot) is the caller's decision — this mode only scores and reports, it doesn't filter or extract on its own.

## `frames-index.json` (K8)

Lives alongside a folder of `screen-HH-MM-SS.jpg` screenshots — `images/`, `transcript-key/images/`, or a merged destination folder like `.sources/frames/{video}-frames/`. One entry per screenshot in that folder:

```json
[
  {
    "screenshot": "screen-00-00-36.jpg",
    "seconds": 36.0,
    "timestamp": "00:00:36",
    "ocr_text": "text recognized on screen, first ~300 characters",
    "transcript_text": "what the SME said around this moment, ~400 characters",
    "score": 4,
    "reasons": ["visual-reference", "technical-detail"],
    "source": "visual-dedup|transcript-key|targeted"
  }
]
```

- `visual-dedup`: kept by the bulk pHash+OCR pass (`images/`).
- `transcript-key`: from `write_transcript_driven_package` (`transcript-key/images/`).
- `targeted`: from `--extract-at`. Each newly extracted frame is OCR'd on the spot and scored against whatever `--transcript` file(s) were passed to that same `--extract-at` call — `ocr_text`, `transcript_text`, `score`, and `reasons` are filled exactly like the bulk pipeline's entries (D-5 fix; this mode used to leave all four empty regardless of input). Pass `--transcript` to get them filled; omitting it is still valid and correctly yields `transcript_text: ""`, `score: 0`, `reasons: []` (no `ocr_text: ""` — OCR still runs).
- Frames without a nearby transcript match get `score: 0`, `reasons: []` regardless of source.

**Why `--extract-at` OCRs its frames (D-5 decision):** the alternative was leaving `ocr_text` blank there, documented as a known gap. This mode only ever pulls a few dozen frames at most (it exists specifically to avoid the bulk pass), so the OCR cost is tens of seconds, not the tens of minutes a full sweep costs — running it keeps `frames-index.json` actually useful for picking a screenshot without opening it, instead of a list a reader has to treat as half-blind for every frame this mode touches. The cost of this choice: `--extract-at` now needs `tesseract` and Pillow, where it used to run on bare `python3` with only `ffmpeg`. See "Prerequisites" above.

The bulk pipeline writes this file fresh for `images/` and `transcript-key/images/` on every run. `--merge-from` and `--extract-at` **append** to whatever `frames-index.json` already exists at the destination (deduplicated by `screenshot` filename, re-sorted by `seconds`) rather than overwriting it — `--merge-from` carries over each copied screenshot's existing entry from the source folder's own index when one exists there, falling back to a bare `source: "visual-dedup"` entry otherwise. Running either mode again later only adds coverage, never loses it. There is no separate `coverage.json` — this file replaces it.
