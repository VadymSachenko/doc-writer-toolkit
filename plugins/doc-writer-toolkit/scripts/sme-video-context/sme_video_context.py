#!/usr/bin/env python3
"""Create an LLM-readable transcript and screenshot package from a meeting video."""

from __future__ import annotations

import argparse
import csv
import json
import multiprocessing
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import TYPE_CHECKING, Optional

# imagehash/PIL are imported lazily, inside the functions that actually use them at
# runtime (prepare_for_ocr, write_contact_sheet, select_frames and its worker,
# extract_missing_frame, extract_at_timestamps). `from __future__ import annotations`
# above makes every `Image.Image`-style type hint in this file a lazy string, so those
# signatures stay valid without a module-level import too. This keeps --merge-from (no
# image library needed at all) and --plan-from-transcript (no ffmpeg, no OCR, no image
# library) usable with a bare `python3` — no venv required for either — which matters
# because convert-sme-input calls them directly without the full
# ffmpeg+tesseract+Pillow+imagehash setup extract-sme-screenshots' bulk pass needs.
# --extract-at now needs Pillow (imported lazily inside it) and the system `tesseract`
# binary too, since D-5 made it OCR each newly extracted frame instead of leaving
# ocr_text empty — see the README's "ocr_text decision" note.
if TYPE_CHECKING:
    import imagehash
    from PIL import Image


@dataclass
class Candidate:
    source: Path
    seconds: float
    visual_distance: Optional[int]
    ocr: str = ""
    ocr_similarity: Optional[float] = None
    keep: bool = False


class Progress:
    """Atomically rewrites a K2-schema progress.json at most once a second, plus a
    single-line \\r progress bar on stderr. stdout is left alone — that's where the
    final summary lines the calling skill reads still live."""

    # Number of recent (time, done) samples `eta_s` is computed from (D-11). `_write`
    # only ever appends at most once a second, so this is roughly a 20-second moving
    # window — long enough to smooth out a single slow frame, short enough to react
    # within a few writes when throughput actually changes (e.g. swap pressure
    # kicking in), instead of an eta averaged over the whole stage since its start.
    _WINDOW_SAMPLES = 20

    def __init__(self, path: Path):
        self.path = path
        self.stage = ""
        self.done = 0
        self.total = 0
        self._stage_start = 0.0
        self._last_write = 0.0
        self._window: deque[tuple[float, int]] = deque(maxlen=self._WINDOW_SAMPLES)

    def start_stage(self, stage: str, total: int) -> None:
        self.stage = stage
        self.done = 0
        self.total = total
        self._stage_start = time.monotonic()
        self._last_write = 0.0
        self._window.clear()
        self._window.append((self._stage_start, 0))
        self._write(force=True)

    def update(self, done: int) -> None:
        if done == self.done:
            return
        self.done = done
        self._write()

    def finish_stage(self) -> None:
        self.done = self.total
        self._write(force=True)
        print(file=sys.stderr)

    def _eta(self, now: float, elapsed: float) -> float:
        window_time, window_done = self._window[0]
        window_elapsed = now - window_time
        window_done = self.done - window_done
        if window_elapsed > 0 and window_done > 0:
            rate = window_done / window_elapsed
        elif self.done > 0:
            # Not enough of a window yet (start of stage, or throughput just stalled
            # completely) — fall back to the whole-stage average rather than divide
            # by zero or report a stale rate.
            rate = self.done / elapsed
        else:
            return 0.0
        return max(0.0, (self.total - self.done) / rate)

    def _write(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_write < 1.0:
            return
        self._last_write = now
        elapsed = now - self._stage_start
        pct = round(100 * self.done / self.total, 1) if self.total else 0.0
        eta = self._eta(now, elapsed)
        self._window.append((now, self.done))
        payload = {
            "stage": self.stage,
            "done": self.done,
            "total": self.total,
            "pct": pct,
            "elapsed_s": round(elapsed),
            "eta_s": round(eta),
        }
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp, self.path)

        width = 24
        filled = round(width * self.done / self.total) if self.total else width
        bar = "#" * filled + "-" * (width - filled)
        print(
            f"\r[{self.stage}] [{bar}] {self.done}/{self.total} ({pct:5.1f}%) "
            f"elapsed {timestamp(elapsed)} eta {timestamp(eta)}",
            end="", file=sys.stderr, flush=True,
        )


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def timestamp(seconds: float) -> str:
    seconds = max(0, round(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def normalized_text(text: str) -> str:
    return " ".join(re.findall(r"[\w./:@-]+", text.lower(), flags=re.UNICODE))


def collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def probe_duration(video: Path) -> Optional[float]:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(video),
            ],
            check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        return float(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return None


def prepare_for_ocr(image: Image.Image, content_width: float) -> Image.Image:
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    # Remove the meeting participant rail, crop browser/OS chrome, then enlarge UI text.
    right = round(image.width * content_width)
    cropped = image.crop((round(image.width * 0.04), round(image.height * 0.07), right, round(image.height * 0.94)))
    grayscale = ImageOps.grayscale(cropped)
    grayscale = ImageOps.autocontrast(grayscale, cutoff=1)
    grayscale = ImageEnhance.Contrast(grayscale).enhance(1.35)
    grayscale = grayscale.resize((grayscale.width * 2, grayscale.height * 2), Image.Resampling.LANCZOS)
    return grayscale.filter(ImageFilter.SHARPEN)


def read_ocr(image: Image.Image, scratch: Path, language: str) -> str:
    prepared = prepare_for_ocr(image, 0.88)
    prepared.save(scratch)
    # tesseract starts its own OpenMP thread pool per invocation regardless of how many
    # worker processes are already running it in parallel (D-10) — capping it to 1
    # thread here is what makes `--jobs N` actually mean N-way parallelism instead of
    # N processes each fanning out further and oversubscribing the machine.
    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    result = subprocess.run(
        ["tesseract", str(scratch), "stdout", "-l", language, "--psm", "11"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    return re.sub(r"\n{3,}", "\n\n", result.stdout).strip()


def extract_frames(video: Path, raw: Path, interval: float, progress: Progress) -> list[Path]:
    raw.mkdir(parents=True, exist_ok=True)
    pattern = raw / "frame-%06d.jpg"
    duration = probe_duration(video)
    total = max(1, round(duration / interval)) if duration else 1
    progress.start_stage("extract", total)
    # `-progress pipe:1` gives machine-readable `key=value` lines (including a
    # running `frame=N`) on stdout, separate from the human log on stderr (still
    # inherited, unpiped, so we can't deadlock reading just the one pipe here).
    process = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "warning", "-i", str(video),
            "-vf", f"fps=1/{interval}", "-q:v", "3", "-progress", "pipe:1", "-nostats",
            str(pattern),
        ],
        stdout=subprocess.PIPE, text=True,
    )
    assert process.stdout is not None
    for line in process.stdout:
        match = re.match(r"frame=\s*(\d+)", line.strip())
        if match:
            progress.update(min(total, int(match.group(1))))
    return_code = process.wait()
    if return_code != 0:
        raise subprocess.CalledProcessError(return_code, "ffmpeg")
    progress.finish_stage()
    return sorted(raw.glob("frame-*.jpg"))


def write_contact_sheet(output: Path) -> None:
    from PIL import Image

    screenshots = sorted((output / "images").glob("*.jpg"))
    if not screenshots:
        return
    columns = 4
    thumb_width = 420
    with Image.open(screenshots[0]) as first:
        thumb_height = round(first.height * thumb_width / first.width)
    rows = (len(screenshots) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * thumb_width, rows * thumb_height), "white")
    for index, screenshot in enumerate(screenshots):
        with Image.open(screenshot) as image:
            thumb = image.convert("RGB").resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        sheet.paste(thumb, ((index % columns) * thumb_width, (index // columns) * thumb_height))
    sheet.save(output / "contact-sheet.jpg", quality=88)


def _phash_worker(payload: tuple[int, str]) -> tuple[int, str]:
    """Picklable worker: perceptual hash of one frame. Cheap (no tesseract), and
    needed for every frame, so phase (a) below runs it over the whole set."""
    index, frame_path = payload
    import imagehash
    from PIL import Image

    with Image.open(frame_path) as image:
        shared = image.crop((0, 0, round(image.width * 0.88), image.height))
        return index, str(imagehash.phash(shared))


def _ocr_worker(payload: tuple[int, str, str]) -> tuple[int, str]:
    """Picklable worker: OCR text of one frame. A pure function of (frame, language) —
    it reads no shared state — which is what makes it safe to compute out of order, or
    speculatively ahead of the sequential walk in phase (b)."""
    index, frame_path, ocr_language = payload
    from PIL import Image

    frame = Path(frame_path)
    scratch = frame.with_name(frame.stem + ".ocr-scratch.png")
    with Image.open(frame) as image:
        text = read_ocr(image, scratch, ocr_language)
    scratch.unlink(missing_ok=True)
    return index, text


def select_frames(
    frames: list[Path], output: Path, interval: float, hash_threshold: int, ocr_language: str,
    jobs: int, progress: Progress,
) -> list[Candidate]:
    import imagehash

    images = output / "images"
    ocr_dir = output / "ocr"
    images.mkdir(parents=True, exist_ok=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)
    gate = max(4, hash_threshold // 2)

    # Phase (a): perceptual hash for every frame. Independent per frame, no tesseract,
    # so it parallelizes cleanly and finishes fast even on a long recording.
    hashes: list[Optional[imagehash.ImageHash]] = [None] * len(frames)
    progress.start_stage("hash", len(frames))
    hash_payloads = [(index, str(frame)) for index, frame in enumerate(frames)]
    if jobs <= 1:
        for done, payload in enumerate(hash_payloads, start=1):
            index, hash_hex = _phash_worker(payload)
            hashes[index] = imagehash.hex_to_hash(hash_hex)
            progress.update(done)
    else:
        with multiprocessing.Pool(jobs) as pool:
            for done, (index, hash_hex) in enumerate(
                pool.imap_unordered(_phash_worker, hash_payloads, chunksize=8), start=1
            ):
                hashes[index] = imagehash.hex_to_hash(hash_hex)
                progress.update(done)
    progress.finish_stage()

    # Phase (b): the sequential decision walk. It can't be parallelized — each decision
    # depends on the hash and text of the last *kept* frame, not the previous frame —
    # and, critically, it OCRs only frames whose distance from the last kept frame
    # clears `gate`. That gate is a large saving (well under half the frames on a
    # typical screencast), so OCRing everything up front to make the work embarrassingly
    # parallel would cost more than the parallelism wins back.
    #
    # Instead the walk pulls OCR from a cache that worker processes fill *ahead* of it:
    # whenever it needs a frame's text it first tops up the pool with the next frames
    # that currently look like they'll need OCR too. Because _ocr_worker is a pure
    # function of the frame, a speculatively computed result is always valid if it's
    # later needed, and simply unused if it isn't — so the selection is identical for
    # any --jobs, and each frame is OCR'd at most once no matter how the walk unfolds.
    ocr_cache: dict[int, str] = {}
    pending: dict[int, multiprocessing.pool.AsyncResult] = {}
    pool = multiprocessing.Pool(jobs) if jobs > 1 else None
    lookahead = max(64, jobs * 8)

    def needs_ocr(index: int, reference: Optional[imagehash.ImageHash]) -> bool:
        return reference is None or (hashes[index] - reference) >= gate

    def top_up(start: int, reference: Optional[imagehash.ImageHash]) -> None:
        if pool is None:
            return
        # Drop speculation the walk has already moved past. Those frames turned out not
        # to need OCR after all (the last kept frame changed under them), and since the
        # walk only ever moves forward they can never be asked for again — without this,
        # they'd sit in `pending` forever, hold the window full, and starve the pool.
        for stale in [index for index in pending if index < start]:
            pending.pop(stale)
        for index in range(start, min(len(frames), start + lookahead)):
            if len(pending) >= jobs * 2:
                return
            if index in ocr_cache or index in pending:
                continue
            if needs_ocr(index, reference):
                pending[index] = pool.apply_async(
                    _ocr_worker, ((index, str(frames[index]), ocr_language),)
                )

    def ocr_text(index: int, reference: Optional[imagehash.ImageHash]) -> str:
        if index not in ocr_cache:
            top_up(index, reference)
            if index in pending:
                _, text = pending.pop(index).get()
            else:
                _, text = _ocr_worker((index, str(frames[index]), ocr_language))
            ocr_cache[index] = text
        return ocr_cache[index]

    candidates: list[Candidate] = []
    last_kept_hash = None
    last_kept_text = ""
    retained_states: list[tuple[imagehash.ImageHash, str]] = []

    progress.start_stage("ocr", len(frames))
    for index, frame in enumerate(frames):
        seconds = index * interval
        current_hash = hashes[index]
        distance = None if last_kept_hash is None else current_hash - last_kept_hash

        # OCR borderline changes as well as obvious visual changes. This catches
        # field edits that occupy too little of the screen to move pHash strongly.
        should_ocr = distance is None or distance >= gate
        text = ocr_text(index, last_kept_hash) if should_ocr else ""

        clean_text = normalized_text(text)
        similarity = None
        if last_kept_text and clean_text:
            similarity = SequenceMatcher(None, last_kept_text, clean_text).ratio()

        meaningful_text_change = bool(
            len(clean_text) >= 40 and similarity is not None and similarity < 0.72
        )
        keep = distance is None or distance >= hash_threshold or meaningful_text_change

        # Do not re-emit a screen state merely because the presenter returned to it
        # after visiting another window. Require both visual and OCR similarity so
        # small but meaningful field changes are still retained.
        for prior_hash, prior_text in retained_states:
            global_distance = current_hash - prior_hash
            global_text_similarity = (
                SequenceMatcher(None, prior_text, clean_text).ratio()
                if prior_text and clean_text else 0.0
            )
            if global_distance <= 5 and global_text_similarity >= 0.82:
                keep = False
                break
        candidate = Candidate(frame, seconds, distance, text, similarity, keep)
        candidates.append(candidate)

        if keep:
            name = f"screen-{timestamp(seconds).replace(':', '-')}.jpg"
            shutil.copy2(frame, images / name)
            (ocr_dir / name.replace(".jpg", ".txt")).write_text(text + "\n", encoding="utf-8")
            # Repoint source at the persisted copy: `frame` lives in the raw-frames temp
            # directory, which main() deletes before write_key_package/
            # write_transcript_driven_package run — reading `frame` after that point is
            # the FileNotFoundError this used to hit.
            candidate.source = images / name
            last_kept_hash = current_hash
            last_kept_text = clean_text
            retained_states.append((current_hash, clean_text))
        progress.update(index + 1)

    if pool is not None:
        # Speculative results the walk never asked for are simply dropped here.
        pool.terminate()
        pool.join()
    progress.finish_stage()
    print(
        f"OCR ran on {len(ocr_cache)} of {len(frames)} candidate frames",
        file=sys.stderr,
    )

    with (output / "frame-decisions.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(["frame", "seconds", "visual_distance", "ocr_similarity", "decision"])
        for item in candidates:
            writer.writerow([
                item.source.name,
                item.seconds,
                "" if item.visual_distance is None else item.visual_distance,
                "" if item.ocr_similarity is None else f"{item.ocr_similarity:.3f}",
                "keep" if item.keep else "drop",
            ])
    return [item for item in candidates if item.keep]


def transcribe(
    video: Path, output: Path, model_name: str, language: Optional[str], progress: Progress
) -> list[dict]:
    from faster_whisper import WhisperModel

    duration = probe_duration(video)
    total = max(1, round(duration)) if duration else 1
    progress.start_stage("transcribe", total)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(video), language=language, vad_filter=True, beam_size=5,
    )
    transcript = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            transcript.append({"start": segment.start, "end": segment.end, "text": text})
        progress.update(min(total, round(segment.end)))
    progress.finish_stage()
    (output / "transcript.json").write_text(
        json.dumps({"language": info.language, "segments": transcript}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [f"[{timestamp(item['start'])}–{timestamp(item['end'])}] {item['text']}" for item in transcript]
    (output / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return transcript


_TURBOSCRIBE_PATTERN = re.compile(
    r"\((\d+):(\d{2})\s*-\s*(\d+):(\d{2})\)\s*\n(.*?)"
    r"(?=\n\s*\(\d+:\d{2}\s*-|\n\s*\(Transcribed by TurboScribe|\Z)",
    flags=re.DOTALL,
)


def parse_turboscribe(files_with_offsets: list[str]) -> tuple[list[dict], list[dict]]:
    """Shared TurboScribe segment parser behind both --transcript import and
    --plan-from-transcript, so the two never drift apart. Returns (segments, sources);
    does no file I/O beyond reading the given files."""
    transcript = []
    sources = []
    for specification in files_with_offsets:
        file_name, separator, raw_offset = specification.rpartition("@")
        if not separator or not raw_offset.isdigit():
            file_name, raw_offset = specification, "0"
        source = Path(file_name)
        offset = float(raw_offset)
        sources.append({"file": str(source), "offset": offset})
        contents = source.read_text(encoding="utf-8-sig")
        for match in _TURBOSCRIBE_PATTERN.finditer(contents):
            start = int(match.group(1)) * 60 + int(match.group(2)) + offset
            end = int(match.group(3)) * 60 + int(match.group(4)) + offset
            text = re.sub(r"\s+", " ", match.group(5)).strip()
            if text:
                transcript.append({"start": start, "end": end, "text": text})
    transcript.sort(key=lambda segment: (segment["start"], segment["end"]))
    return transcript, sources


def import_turboscribe(files_with_offsets: list[str], output: Path) -> list[dict]:
    transcript, sources = parse_turboscribe(files_with_offsets)
    (output / "transcript.json").write_text(
        json.dumps({"language": "uk", "sources": sources, "segments": transcript}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [f"[{timestamp(item['start'])}–{timestamp(item['end'])}] {item['text']}" for item in transcript]
    (output / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return transcript


def plan_from_transcript(files_with_offsets: list[str]) -> list[dict]:
    """--plan-from-transcript: score every parsed segment with transcript_relevance()
    and return a time-sorted plan. No video decode, no OCR, no tesseract, no
    Pillow/imagehash — safe to run on bare python3."""
    transcript, _sources = parse_turboscribe(files_with_offsets)
    plan = []
    for segment in transcript:
        score, reasons = transcript_relevance(segment["text"])
        seconds = round((segment["start"] + segment["end"]) / 2, 1)
        plan.append({"seconds": seconds, "score": score, "reasons": reasons, "text": segment["text"]})
    plan.sort(key=lambda item: item["seconds"])
    return plan


def write_context(
    output: Path, source: Path, kept: list[Candidate], transcript: list[dict], source_offset: float
) -> None:
    lines = [
        "# SME meeting context package", "",
        f"- Source: `{source}`",
        f"- Source clip offset: {timestamp(source_offset)}",
        f"- Selected screenshots: {len(kept)}", "",
        "> OCR is machine-extracted supporting context. Verify exact UI values against the screenshot.", "",
    ]
    for item in kept:
        relative = timestamp(item.seconds)
        absolute = timestamp(source_offset + item.seconds)
        image_name = f"screen-{relative.replace(':', '-')}.jpg"
        nearby = [
            segment for segment in transcript
            if segment["end"] >= item.seconds - 20 and segment["start"] <= item.seconds + 20
        ]
        lines.extend([
            f"## {absolute} source time ({relative} in clip)", "",
            f"![Screen at {absolute}](images/{image_name})", "",
            "### Visible text (OCR)", "", "```text", item.ocr or "[No reliable text detected]", "```", "",
            "### Transcript context", "",
        ])
        if nearby:
            lines.extend(
                f"- [{timestamp(segment['start'])}] {segment['text']}" for segment in nearby
            )
        else:
            lines.append("- [No speech detected in the surrounding 40-second window]")
        lines.append("")
    (output / "context.md").write_text("\n".join(lines), encoding="utf-8")


def load_existing_selection(output: Path) -> list[Candidate]:
    kept = []
    for image in sorted((output / "images").glob("screen-*.jpg")):
        match = re.fullmatch(r"screen-(\d{2})-(\d{2})-(\d{2})\.jpg", image.name)
        if not match:
            continue
        hours, minutes, seconds = map(int, match.groups())
        position = hours * 3600 + minutes * 60 + seconds
        ocr_file = output / "ocr" / image.with_suffix(".txt").name
        text = ocr_file.read_text(encoding="utf-8") if ocr_file.exists() else ""
        kept.append(Candidate(image, position, None, text, None, True))
    if not kept:
        raise RuntimeError(f"no existing screenshots found in {output / 'images'}")
    return kept


def write_key_package(
    output: Path, source: Path, kept: list[Candidate], transcript: list[dict], source_offset: float,
    bucket_seconds: int,
) -> list[Candidate]:
    buckets: dict[int, list[Candidate]] = {}
    for item in kept:
        buckets.setdefault(int(item.seconds // bucket_seconds), []).append(item)
    key_frames = []
    for items in buckets.values():
        # Prefer the stable screen with the most readable supporting text.
        key_frames.append(max(items, key=lambda item: len(normalized_text(item.ocr))))

    key_output = output / "key"
    (key_output / "images").mkdir(parents=True, exist_ok=True)
    (key_output / "ocr").mkdir(parents=True, exist_ok=True)
    for item in key_frames:
        name = f"screen-{timestamp(item.seconds).replace(':', '-')}.jpg"
        shutil.copy2(item.source, key_output / "images" / name)
        (key_output / "ocr" / name.replace(".jpg", ".txt")).write_text(item.ocr, encoding="utf-8")
    write_context(key_output, source, key_frames, transcript, source_offset)
    write_contact_sheet(key_output)
    return key_frames


def transcript_relevance(text: str) -> tuple[int, list[str]]:
    lowered = text.lower()
    categories = {
        "visual-reference": [
            "дивись", "дивіться", "бачиш", "ось", "отут", "на екрані", "показ",
            "смотри", "видишь", "покаж", "екран",
        ],
        "ui-action": [
            "натис", "клік", "відкри", "переход", "ввод", "вибира", "перенос",
            "кнопк", "поле", "сторінк", "вкладк", "таблиц", "форм",
        ],
        "requirement-decision": [
            "треба", "потріб", "повинен", "обов'яз", "домов", "робимо", "зміню",
            "додати", "реаліза", "має бути", "необхід",
        ],
        "technical-detail": [
            "api", "код", "request", "response", "reference", "лінк", "link", "діплін",
            "json", "баз", "endpoint", "параметр", "реквізит", "картк", "банк",
        ],
        "problem": ["помил", "error", "не працю", "проблем", "злама", "баг"],
    }
    matched = [name for name, terms in categories.items() if any(term in lowered for term in terms)]
    weights = {
        "visual-reference": 3,
        "ui-action": 2,
        "requirement-decision": 2,
        "technical-detail": 1,
        "problem": 2,
    }
    return sum(weights[name] for name in matched), matched


def nearest_frame(frames: list[Candidate], seconds: float, tolerance: float) -> Optional[Candidate]:
    if not frames:
        return None
    nearest = min(frames, key=lambda item: abs(item.seconds - seconds))
    return nearest if abs(nearest.seconds - seconds) <= tolerance else None


def extract_frame_at(video: Path, target: Path, seconds: float) -> bool:
    """Pull a single frame. Returns False instead of raising when ffmpeg can't produce
    one — most often because `seconds` lands past the end of the recording, which is
    what a transcript carrying the wrong --source-offset (or a transcript paired with a
    shorter clip) looks like. A missable frame shouldn't abort a whole pipeline run.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(seconds),
                "-i", str(video), "-frames:v", "1", "-update", "1", "-q:v", "2", str(target),
            ],
            check=True, stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        target.unlink(missing_ok=True)
        print(f"warning: no frame available at {timestamp(seconds)}", file=sys.stderr)
        return False
    return target.exists()


def extract_missing_frame(
    video: Path, output: Path, seconds: float, ocr_language: str
) -> Optional[Candidate]:
    from PIL import Image

    name = f"screen-{timestamp(seconds).replace(':', '-')}.jpg"
    target = output / "transcript-extracted" / name
    if not extract_frame_at(video, target, seconds):
        return None
    scratch = output / ".ocr-transcript-frame.png"
    with Image.open(target) as image:
        text = read_ocr(image, scratch, ocr_language)
    scratch.unlink(missing_ok=True)
    return Candidate(target, seconds, None, text, None, True)


def parse_existing_screenshots(folder: Path) -> list[tuple[float, Path]]:
    """Read seconds back out of screen-HH-MM-SS.jpg filenames in a flat folder."""
    found = []
    for image in sorted(folder.glob("screen-*.jpg")):
        match = re.fullmatch(r"screen-(\d{2})-(\d{2})-(\d{2})\.jpg", image.name)
        if not match:
            continue
        hours, minutes, seconds = map(int, match.groups())
        found.append((float(hours * 3600 + minutes * 60 + seconds), image))
    return found


def load_frames_index(folder: Path) -> list[dict]:
    index_path = folder / "frames-index.json"
    if not index_path.exists():
        return []
    try:
        return json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def write_frames_index(folder: Path, entries: list[dict]) -> None:
    ordered = sorted(entries, key=lambda item: item["seconds"])
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "frames-index.json").write_text(
        json.dumps(ordered, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def append_frames_index(folder: Path, new_entries: list[dict]) -> None:
    """Used by --merge-from and --extract-at: add to whatever frames-index.json
    already exists in `folder` rather than overwriting it, so repeated calls keep
    accumulating coverage instead of losing earlier entries."""
    existing = load_frames_index(folder)
    covered = {entry["screenshot"] for entry in existing}
    for entry in new_entries:
        if entry["screenshot"] not in covered:
            existing.append(entry)
            covered.add(entry["screenshot"])
    write_frames_index(folder, existing)


def frames_index_entry(
    item: Candidate, transcript: list[dict], source: str, window: float = 20.0
) -> dict:
    nearby = [
        segment for segment in transcript
        if segment["end"] >= item.seconds - window and segment["start"] <= item.seconds + window
    ]
    transcript_text = collapse_whitespace(" ".join(segment["text"] for segment in nearby))
    # Score the single most relevant thing said near this frame, not the whole window
    # concatenated together: concatenating sweeps up every keyword category spoken in
    # 40 seconds, so nearly every frame would come out at the top of the scale and the
    # number would stop telling a reader which frames are actually worth opening. This
    # also keeps `score`/`reasons` meaning what they meant in the old coverage.json,
    # which scored one transcript segment at a time.
    score, reasons = 0, []
    for segment in nearby:
        segment_score, segment_reasons = transcript_relevance(segment["text"])
        if segment_score > score:
            score, reasons = segment_score, segment_reasons
    return {
        "screenshot": item.source.name,
        "seconds": item.seconds,
        "timestamp": timestamp(item.seconds),
        "ocr_text": collapse_whitespace(item.ocr)[:300],
        "transcript_text": transcript_text[:400],
        "score": score,
        "reasons": reasons,
        "source": source,
    }


def extract_at_timestamps(
    video: Path, screenshots_dir: Path, timestamps: list[float], tolerance: float,
    transcript: list[dict], ocr_language: str,
) -> list[dict]:
    """Guarantee a screenshot near each requested second in a flat screenshots folder.

    Used for a targeted second pass after convert-sme-input names specific moments —
    does not touch anything already in screenshots_dir except add to it. Each newly
    extracted frame is OCR'd and scored against `transcript` the same way the bulk
    pipeline does (frames_index_entry/transcript_relevance), so frames-index.json
    entries from this mode carry real ocr_text/transcript_text/score/reasons instead
    of coming out empty (D-5) — this mode only ever pulls a handful of frames, so the
    OCR pass stays cheap. `transcript` is `[]` when the caller has none to pass, in
    which case score/reasons/transcript_text are correctly 0/[]/"" for every frame.
    """
    from PIL import Image

    existing = parse_existing_screenshots(screenshots_dir)
    report = []
    new_entries = []
    scratch = screenshots_dir / ".ocr-extract-at-scratch.png"
    for seconds in timestamps:
        nearest = min(existing, key=lambda item: abs(item[0] - seconds), default=None)
        if nearest is not None and abs(nearest[0] - seconds) <= tolerance:
            report.append({"requested": seconds, "status": "already-covered", "screenshot": nearest[1].name})
            continue
        name = f"screen-{timestamp(seconds).replace(':', '-')}.jpg"
        target = screenshots_dir / name
        if not extract_frame_at(video, target, seconds):
            report.append({"requested": seconds, "status": "unavailable", "screenshot": "-"})
            continue
        existing.append((seconds, target))
        report.append({"requested": seconds, "status": "extracted", "screenshot": name})
        with Image.open(target) as image:
            text = read_ocr(image, scratch, ocr_language)
        candidate = Candidate(target, seconds, None, text, None, True)
        new_entries.append(frames_index_entry(candidate, transcript, "targeted"))
    scratch.unlink(missing_ok=True)
    if new_entries:
        append_frames_index(screenshots_dir, new_entries)
    return report


def merge_screenshots(source_dir: Path, destination_dir: Path, tolerance: float) -> list[dict]:
    """Copy screen-*.jpg candidates from source_dir into destination_dir, skipping any
    candidate whose timestamp already has a match within tolerance in destination_dir.

    Used both to fold a fresh scratch run's images/ and transcript-key/images/ into a
    project's persisted frames folder, and to re-run the bulk pass without duplicating
    frames a targeted extract-at pass already placed there. Carries each copied
    screenshot's frames-index.json entry along from source_dir when one exists there.
    """
    destination_dir.mkdir(parents=True, exist_ok=True)
    existing = parse_existing_screenshots(destination_dir)
    source_index = {entry["screenshot"]: entry for entry in load_frames_index(source_dir)}
    report = []
    new_entries = []
    for seconds, source in sorted(parse_existing_screenshots(source_dir)):
        nearest = min(existing, key=lambda item: abs(item[0] - seconds), default=None)
        if nearest is not None and abs(nearest[0] - seconds) <= tolerance:
            report.append({"seconds": seconds, "status": "skipped-duplicate", "screenshot": nearest[1].name})
            continue
        target = destination_dir / source.name
        shutil.copy2(source, target)
        existing.append((seconds, target))
        report.append({"seconds": seconds, "status": "copied", "screenshot": source.name})
        entry = source_index.get(source.name) or {
            "screenshot": source.name,
            "seconds": seconds,
            "timestamp": timestamp(seconds),
            "ocr_text": "",
            "transcript_text": "",
            "score": 0,
            "reasons": [],
            "source": "visual-dedup",
        }
        new_entries.append(entry)
    if new_entries:
        append_frames_index(destination_dir, new_entries)
    return report


def write_transcript_driven_package(
    output: Path, video: Path, all_frames: list[Candidate], visual_key_frames: list[Candidate],
    transcript: list[dict], source_offset: float, ocr_language: str,
) -> list[Candidate]:
    relevant = []
    for segment in transcript:
        score, reasons = transcript_relevance(segment["text"])
        if score >= 4:
            relevant.append({**segment, "score": score, "reasons": reasons})

    # Collapse overlapping speech into 30-second conversation windows and use the
    # highest-scoring statement as the screenshot target for that window.
    windows: dict[int, dict] = {}
    for segment in relevant:
        bucket = int(segment["start"] // 30)
        if bucket not in windows or segment["score"] > windows[bucket]["score"]:
            windows[bucket] = segment

    must_have: list[Candidate] = []
    for segment in windows.values():
        target_time = (segment["start"] + segment["end"]) / 2
        selected = nearest_frame(visual_key_frames, target_time, 12)
        if selected is None:
            selected = nearest_frame(all_frames, target_time, 20)
        if selected is None:
            selected = extract_missing_frame(video, output, target_time, ocr_language)
        if selected is not None:
            must_have.append(selected)

    combined = {round(item.seconds): item for item in visual_key_frames}
    combined.update({round(item.seconds): item for item in must_have})
    final_frames = [combined[key] for key in sorted(combined)]
    package = output / "transcript-key"
    (package / "images").mkdir(parents=True, exist_ok=True)
    (package / "ocr").mkdir(parents=True, exist_ok=True)
    for item in final_frames:
        name = f"screen-{timestamp(item.seconds).replace(':', '-')}.jpg"
        shutil.copy2(item.source, package / "images" / name)
        (package / "ocr" / name.replace(".jpg", ".txt")).write_text(item.ocr, encoding="utf-8")
    write_context(package, video, final_frames, transcript, source_offset)
    write_contact_sheet(package)
    return final_frames


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path, nargs="?", default=None)
    parser.add_argument("output", type=Path, nargs="?", default=None)
    parser.add_argument("--interval", type=float, default=3.0)
    parser.add_argument("--hash-threshold", type=int, default=8)
    parser.add_argument("--ocr-language", default="eng+ukr+rus")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--speech-language", default=None)
    parser.add_argument("--source-offset", type=float, default=0.0)
    parser.add_argument(
        "--resume-visual", action="store_true",
        help="reuse images/OCR in a partial output package and run transcription/finalization only",
    )
    parser.add_argument(
        "--transcript", action="append", default=[], metavar="PATH[@OFFSET_SECONDS]",
        help="import TurboScribe text instead of running Whisper; may be repeated",
    )
    parser.add_argument("--key-interval", type=int, default=30)
    parser.add_argument(
        "--extract-at", default=None, metavar="SECONDS[,SECONDS...]",
        help=(
            "skip the full pipeline; treat `output` as a flat folder of existing "
            "screen-HH-MM-SS.jpg files and guarantee one near each listed second, "
            "extracting a new frame only where none already falls within --tolerance"
        ),
    )
    parser.add_argument("--tolerance", type=float, default=15.0)
    parser.add_argument(
        "--merge-from", type=Path, default=None, metavar="SOURCE_DIR",
        help=(
            "skip the full pipeline; copy screen-HH-MM-SS.jpg candidates from SOURCE_DIR "
            "into `output`, skipping any whose timestamp is already covered there within "
            "--tolerance (`output` is created if missing)"
        ),
    )
    parser.add_argument(
        "--jobs", type=int, default=max(1, (os.cpu_count() or 1) - 1), metavar="N",
        help=(
            "worker processes for the phash+OCR pass in the bulk pipeline "
            "(default: cpu_count - 1); --jobs 1 runs single-process"
        ),
    )
    parser.add_argument(
        "--progress-file", type=Path, default=None, metavar="PATH",
        help=(
            "where to atomically rewrite progress.json (schema: stage, done, total, "
            "pct, elapsed_s, eta_s), at most once a second; default: <output>/progress.json"
        ),
    )
    parser.add_argument(
        "--plan-from-transcript", action="store_true",
        help=(
            "read --transcript file(s), score every segment with transcript_relevance(), "
            "and print a time-sorted JSON plan ([{seconds, score, reasons, text}, ...]) "
            "to stdout; no video decoding, no OCR, no tesseract, runs in seconds"
        ),
    )
    args = parser.parse_args()

    if args.plan_from_transcript:
        if not args.transcript:
            parser.error("--plan-from-transcript requires at least one --transcript")
        print(json.dumps(plan_from_transcript(args.transcript), ensure_ascii=False, indent=2))
        return

    if args.merge_from is not None:
        if args.output is None:
            parser.error("output is required with --merge-from")
        report = merge_screenshots(args.merge_from, args.output, args.tolerance)
        for item in report:
            print(f"{timestamp(item['seconds'])}: {item['status']} ({item['screenshot']})")
        copied = sum(1 for item in report if item["status"] == "copied")
        print(f"Copied {copied} screenshot(s); {len(report) - copied} already covered (skipped)")
        return

    if args.extract_at is not None:
        if args.video is None or args.output is None:
            parser.error("video and output are required with --extract-at")
        timestamps = [float(part) for part in args.extract_at.split(",") if part.strip()]
        args.output.mkdir(parents=True, exist_ok=True)
        transcript = parse_turboscribe(args.transcript)[0] if args.transcript else []
        report = extract_at_timestamps(
            args.video, args.output, timestamps, args.tolerance, transcript, args.ocr_language
        )
        for item in report:
            print(f"{timestamp(item['requested'])}: {item['status']} ({item['screenshot']})")
        extracted = sum(1 for item in report if item["status"] == "extracted")
        print(f"Extracted {extracted} new screenshot(s); {len(report) - extracted} already covered")
        return

    if args.video is None or args.output is None:
        parser.error("video and output are required")

    if not args.resume_visual and args.output.exists() and any(args.output.iterdir()):
        parser.error(f"output directory must be empty or new: {args.output}")
    args.output.mkdir(parents=True, exist_ok=True)

    progress = Progress(args.progress_file or (args.output / "progress.json"))

    if args.resume_visual:
        kept = load_existing_selection(args.output)
        frames = []
    else:
        with tempfile.TemporaryDirectory(prefix="raw-frames-", dir=args.output) as raw_dir:
            frames = extract_frames(args.video, Path(raw_dir), args.interval, progress)
            kept = select_frames(
                frames, args.output, args.interval, args.hash_threshold, args.ocr_language,
                args.jobs, progress,
            )
    transcript = (
        import_turboscribe(args.transcript, args.output)
        if args.transcript
        else transcribe(args.video, args.output, args.whisper_model, args.speech_language, progress)
    )

    progress.start_stage("merge", 5)
    write_context(args.output, args.video, kept, transcript, args.source_offset)
    progress.update(1)
    write_contact_sheet(args.output)
    progress.update(2)
    key_frames = write_key_package(
        args.output, args.video, kept, transcript, args.source_offset, args.key_interval
    )
    progress.update(3)
    transcript_key_frames = write_transcript_driven_package(
        args.output, args.video, kept, key_frames, transcript, args.source_offset,
        args.ocr_language,
    )
    progress.update(4)
    write_frames_index(
        args.output / "images",
        [frames_index_entry(item, transcript, "visual-dedup") for item in kept],
    )
    write_frames_index(
        args.output / "transcript-key" / "images",
        [frames_index_entry(item, transcript, "transcript-key") for item in transcript_key_frames],
    )
    progress.update(5)
    progress.finish_stage()

    if frames:
        print(f"Processed {len(frames)} candidates; retained {len(kept)} screenshots")
    else:
        print(f"Reused {len(kept)} existing screenshots")
    print(f"Selected {len(key_frames)} key screenshots")
    print(f"Selected {len(transcript_key_frames)} combined visual/transcript screenshots")
    print(f"Context package: {args.output / 'context.md'}")


if __name__ == "__main__":
    main()
