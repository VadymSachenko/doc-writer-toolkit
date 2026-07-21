# SME video context processor

Creates a local, AI-readable package containing a timestamped transcript, selected screenshots, OCR, and transcript-to-image alignment.

## Prerequisites (macOS)

```bash
brew install ffmpeg tesseract tesseract-lang
python3 -m venv .venv-sme-video
.venv-sme-video/bin/pip install -r sme-video-requirements.txt
```

## Run

Use a new output directory for every run:

```bash
.venv-sme-video/bin/python sme_video_context.py \
  /path/to/meeting.mp4 \
  /path/to/output-package
```

Defaults are tuned for mixed English/Ukrainian/Russian technical calls: one candidate every three seconds, pHash threshold 8, Tesseract `eng+ukr+rus`, and multilingual `faster-whisper` `small` on CPU.

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
```

On Intel Macs, `--whisper-model tiny` is substantially faster for long calls, with lower transcription accuracy. The screenshots and OCR are unaffected.

The output contains:

- `context.md`: primary input for an LLM
- `images/`: selected original screenshots
- `ocr/`: visible text extracted from each screenshot
- `transcript.txt` and `transcript.json`: timestamped speech
- `frame-decisions.csv`: auditable selection decisions
- `contact-sheet.jpg`: quick human review
- `key/`: visually selected set, capped by `--key-interval`
- `transcript-key/`: visual key set augmented from important conversation timestamps
- `transcript-key/coverage.json`: why each transcript-driven screenshot was required and where it came from

OCR and transcription are evidence aids, not ground truth. Verify critical names, values, and decisions against the recording.
