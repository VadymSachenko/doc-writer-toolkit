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
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import TYPE_CHECKING, Optional

# imagehash/PIL are imported lazily, inside the functions that actually use them at
# runtime (prepare_for_ocr, write_contact_sheet, select_frames and its worker,
# extract_missing_frame). `from __future__ import annotations` above makes every
# `Image.Image`-style type hint in this file a lazy string, so those signatures stay
# valid without a module-level import too. This keeps --merge-from (no image library
# needed at all), --extract-at (ffmpeg only, no OCR), and --plan-from-transcript (no
# ffmpeg, no OCR, no image library) usable with a bare `python3` — no venv required
# for any of them — which matters because convert-sme-input calls them directly
# without the full ffmpeg+tesseract+Pillow+imagehash setup extract-sme-screenshots'
# bulk pass needs.
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

    def __init__(self, path: Path):
        self.path = path
        self.stage = ""
        self.done = 0
        self.total = 0
        self._stage_start = 0.0
        self._last_write = 0.0

    def start_stage(self, stage: str, total: int) -> None:
        self.stage = stage
        self.done = 0
        self.total = total
        self._stage_start = time.monotonic()
        self._last_write = 0.0
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

    def _write(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_write < 1.0:
            return
        self._last_write = now
        elapsed = now - self._stage_start
        pct = round(100 * self.done / self.total, 1) if self.total else 0.0
        eta = elapsed / self.done * (self.total - self.done) if self.done else 0.0
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
    result = subprocess.run(
        ["tesseract", str(scratch), "stdout", "-l", language, "--psm", "11"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
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


def _extract_frame_features(payload: tuple[int, str, str]) -> tuple[int, str, str]:
    """Picklable worker: phash + OCR text for one frame, independent of every other
    frame. Used both from a plain loop (--jobs 1) and from a multiprocessing.Pool
    (--jobs>1) — same function either way, so phase B below sees identical input
    regardless of --jobs."""
    index, frame_path, ocr_language = payload
    import imagehash
    from PIL import Image

    frame = Path(frame_path)
    with Image.open(frame) as image:
        shared = image.crop((0, 0, round(image.width * 0.88), image.height))
        current_hash = imagehash.phash(shared)
        scratch = frame.with_name(frame.stem + ".ocr-scratch.png")
        text = read_ocr(image, scratch, ocr_language)
    scratch.unlink(missing_ok=True)
    return index, str(current_hash), text


def select_frames(
    frames: list[Path], output: Path, interval: float, hash_threshold: int, ocr_language: str,
    jobs: int, progress: Progress,
) -> list[Candidate]:
    import imagehash

    images = output / "images"
    ocr_dir = output / "ocr"
    images.mkdir(parents=True, exist_ok=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)

    # Phase (a): phash + OCR text for every frame, computed independently — safe to
    # parallelize. Phase (b) below re-applies the same should-OCR gate the original
    # single-pass loop used (based on distance to the *last kept* frame, which is
    # sequential and can't be parallelized), consuming this phase's output instead of
    # computing on demand. Because phase (a) always computes the real OCR text for
    # every frame and phase (b) decides afterwards whether to use it or discard it in
    # favor of "", results are identical no matter how many workers computed phase (a).
    payloads = [(index, str(frame), ocr_language) for index, frame in enumerate(frames)]
    features: list[Optional[tuple[imagehash.ImageHash, str]]] = [None] * len(frames)
    progress.start_stage("ocr", len(frames))
    if jobs <= 1:
        for payload in payloads:
            index, hash_hex, text = _extract_frame_features(payload)
            features[index] = (imagehash.hex_to_hash(hash_hex), text)
            progress.update(index + 1)
    else:
        with multiprocessing.Pool(jobs) as pool:
            done = 0
            for index, hash_hex, text in pool.imap_unordered(_extract_frame_features, payloads):
                features[index] = (imagehash.hex_to_hash(hash_hex), text)
                done += 1
                progress.update(done)
    progress.finish_stage()

    # Phase (b): sequential decision walk — cannot be parallelized, each decision
    # depends on the hash/text of the last *kept* frame, not just the previous frame.
    gate = max(4, hash_threshold // 2)
    candidates: list[Candidate] = []
    last_kept_hash = None
    last_kept_text = ""
    retained_states: list[tuple[imagehash.ImageHash, str]] = []

    for index, frame in enumerate(frames):
        seconds = index * interval
        current_hash, raw_text = features[index]
        distance = None if last_kept_hash is None else current_hash - last_kept_hash

        # OCR borderline changes as well as obvious visual changes. This catches
        # field edits that occupy too little of the screen to move pHash strongly.
        should_ocr = distance is None or distance >= gate
        text = raw_text if should_ocr else ""

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


def extract_frame_at(video: Path, target: Path, seconds: float) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-ss", str(seconds),
        "-i", str(video), "-frames:v", "1", "-update", "1", "-q:v", "2", str(target),
    ])


def extract_missing_frame(
    video: Path, output: Path, seconds: float, ocr_language: str
) -> Candidate:
    from PIL import Image

    name = f"screen-{timestamp(seconds).replace(':', '-')}.jpg"
    target = output / "transcript-extracted" / name
    extract_frame_at(video, target, seconds)
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


def nearby_transcript_text(transcript: list[dict], seconds: float, window: float = 20.0) -> str:
    segments = [
        segment for segment in transcript
        if segment["end"] >= seconds - window and segment["start"] <= seconds + window
    ]
    return collapse_whitespace(" ".join(segment["text"] for segment in segments))


def frames_index_entry(item: Candidate, transcript: list[dict], source: str) -> dict:
    transcript_text = nearby_transcript_text(transcript, item.seconds)
    score, reasons = transcript_relevance(transcript_text) if transcript_text else (0, [])
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
    video: Path, screenshots_dir: Path, timestamps: list[float], tolerance: float
) -> list[dict]:
    """Guarantee a screenshot near each requested second in a flat screenshots folder.

    Used for a targeted second pass after convert-sme-input names specific moments —
    does not touch anything already in screenshots_dir except add to it.
    """
    existing = parse_existing_screenshots(screenshots_dir)
    report = []
    new_entries = []
    for seconds in timestamps:
        nearest = min(existing, key=lambda item: abs(item[0] - seconds), default=None)
        if nearest is not None and abs(nearest[0] - seconds) <= tolerance:
            report.append({"requested": seconds, "status": "already-covered", "screenshot": nearest[1].name})
            continue
        name = f"screen-{timestamp(seconds).replace(':', '-')}.jpg"
        target = screenshots_dir / name
        extract_frame_at(video, target, seconds)
        existing.append((seconds, target))
        report.append({"requested": seconds, "status": "extracted", "screenshot": name})
        # No OCR/transcript context here on purpose — this mode stays ffmpeg-only so
        # it's cheap enough for convert-sme-input to call mid-workflow.
        new_entries.append({
            "screenshot": name,
            "seconds": seconds,
            "timestamp": timestamp(seconds),
            "ocr_text": "",
            "transcript_text": "",
            "score": 0,
            "reasons": [],
            "source": "targeted",
        })
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
        report = extract_at_timestamps(args.video, args.output, timestamps, args.tolerance)
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
