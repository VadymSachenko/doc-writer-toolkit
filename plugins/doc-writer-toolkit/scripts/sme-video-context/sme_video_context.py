#!/usr/bin/env python3
"""Create an LLM-readable transcript and screenshot package from a meeting video."""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

import imagehash
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


@dataclass
class Candidate:
    source: Path
    seconds: float
    visual_distance: Optional[int]
    ocr: str = ""
    ocr_similarity: Optional[float] = None
    keep: bool = False


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def timestamp(seconds: float) -> str:
    seconds = max(0, round(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def normalized_text(text: str) -> str:
    return " ".join(re.findall(r"[\w./:@-]+", text.lower(), flags=re.UNICODE))


def prepare_for_ocr(image: Image.Image, content_width: float) -> Image.Image:
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


def extract_frames(video: Path, raw: Path, interval: float) -> list[Path]:
    raw.mkdir(parents=True, exist_ok=True)
    pattern = raw / "frame-%06d.jpg"
    run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "warning", "-i", str(video),
            "-vf", f"fps=1/{interval}", "-q:v", "3", str(pattern),
        ]
    )
    return sorted(raw.glob("frame-*.jpg"))


def write_contact_sheet(output: Path) -> None:
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


def select_frames(
    frames: list[Path], output: Path, interval: float, hash_threshold: int, ocr_language: str
) -> list[Candidate]:
    images = output / "images"
    ocr_dir = output / "ocr"
    images.mkdir(parents=True, exist_ok=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)
    scratch = output / ".ocr-input.png"
    candidates: list[Candidate] = []
    last_kept_hash = None
    last_kept_text = ""
    retained_states: list[tuple[imagehash.ImageHash, str]] = []

    for index, frame in enumerate(frames):
        seconds = index * interval
        with Image.open(frame) as image:
            shared = image.crop((0, 0, round(image.width * 0.88), image.height))
            current_hash = imagehash.phash(shared)
            distance = None if last_kept_hash is None else current_hash - last_kept_hash

            # OCR borderline changes as well as obvious visual changes. This catches
            # field edits that occupy too little of the screen to move pHash strongly.
            should_ocr = distance is None or distance >= max(4, hash_threshold // 2)
            text = read_ocr(image, scratch, ocr_language) if should_ocr else ""

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
            last_kept_hash = current_hash
            last_kept_text = clean_text
            retained_states.append((current_hash, clean_text))

    scratch.unlink(missing_ok=True)
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


def transcribe(video: Path, output: Path, model_name: str, language: Optional[str]) -> list[dict]:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(video), language=language, vad_filter=True, beam_size=5,
    )
    transcript = [
        {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
        for segment in segments if segment.text.strip()
    ]
    (output / "transcript.json").write_text(
        json.dumps({"language": info.language, "segments": transcript}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [f"[{timestamp(item['start'])}–{timestamp(item['end'])}] {item['text']}" for item in transcript]
    (output / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return transcript


def import_turboscribe(files_with_offsets: list[str], output: Path) -> list[dict]:
    transcript = []
    pattern = re.compile(
        r"\((\d+):(\d{2})\s*-\s*(\d+):(\d{2})\)\s*\n(.*?)"
        r"(?=\n\s*\(\d+:\d{2}\s*-|\n\s*\(Transcribed by TurboScribe|\Z)",
        flags=re.DOTALL,
    )
    sources = []
    for specification in files_with_offsets:
        file_name, separator, raw_offset = specification.rpartition("@")
        if not separator or not raw_offset.isdigit():
            file_name, raw_offset = specification, "0"
        source = Path(file_name)
        offset = float(raw_offset)
        sources.append({"file": str(source), "offset": offset})
        contents = source.read_text(encoding="utf-8-sig")
        for match in pattern.finditer(contents):
            start = int(match.group(1)) * 60 + int(match.group(2)) + offset
            end = int(match.group(3)) * 60 + int(match.group(4)) + offset
            text = re.sub(r"\s+", " ", match.group(5)).strip()
            if text:
                transcript.append({"start": start, "end": end, "text": text})
    transcript.sort(key=lambda segment: (segment["start"], segment["end"]))
    (output / "transcript.json").write_text(
        json.dumps({"language": "uk", "sources": sources, "segments": transcript}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [f"[{timestamp(item['start'])}–{timestamp(item['end'])}] {item['text']}" for item in transcript]
    (output / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return transcript


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


def extract_missing_frame(
    video: Path, output: Path, seconds: float, ocr_language: str
) -> Candidate:
    name = f"screen-{timestamp(seconds).replace(':', '-')}.jpg"
    target = output / "transcript-extracted" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-ss", str(seconds),
        "-i", str(video), "-frames:v", "1", "-update", "1", "-q:v", "2", str(target),
    ])
    scratch = output / ".ocr-transcript-frame.png"
    with Image.open(target) as image:
        text = read_ocr(image, scratch, ocr_language)
    scratch.unlink(missing_ok=True)
    return Candidate(target, seconds, None, text, None, True)


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
    report = []
    for segment in windows.values():
        target_time = (segment["start"] + segment["end"]) / 2
        covered = nearest_frame(visual_key_frames, target_time, 12)
        selected = covered
        source = "visual-key"
        if selected is None:
            selected = nearest_frame(all_frames, target_time, 20)
            source = "full-evidence"
        if selected is None:
            selected = extract_missing_frame(video, output, target_time, ocr_language)
            source = "new-extraction"
        must_have.append(selected)
        report.append({
            "conversation_start": segment["start"],
            "conversation_end": segment["end"],
            "score": segment["score"],
            "reasons": segment["reasons"],
            "text": segment["text"],
            "screenshot_time": selected.seconds,
            "screenshot_source": source,
        })

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
    (package / "coverage.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return final_frames


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("output", type=Path)
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
    args = parser.parse_args()

    if not args.resume_visual and args.output.exists() and any(args.output.iterdir()):
        parser.error(f"output directory must be empty or new: {args.output}")
    args.output.mkdir(parents=True, exist_ok=True)
    if args.resume_visual:
        kept = load_existing_selection(args.output)
        frames = []
    else:
        with tempfile.TemporaryDirectory(prefix="raw-frames-", dir=args.output) as raw_dir:
            frames = extract_frames(args.video, Path(raw_dir), args.interval)
            kept = select_frames(frames, args.output, args.interval, args.hash_threshold, args.ocr_language)
    transcript = (
        import_turboscribe(args.transcript, args.output)
        if args.transcript
        else transcribe(args.video, args.output, args.whisper_model, args.speech_language)
    )
    write_context(args.output, args.video, kept, transcript, args.source_offset)
    write_contact_sheet(args.output)
    key_frames = write_key_package(
        args.output, args.video, kept, transcript, args.source_offset, args.key_interval
    )
    transcript_key_frames = write_transcript_driven_package(
        args.output, args.video, kept, key_frames, transcript, args.source_offset,
        args.ocr_language,
    )
    if frames:
        print(f"Processed {len(frames)} candidates; retained {len(kept)} screenshots")
    else:
        print(f"Reused {len(kept)} existing screenshots")
    print(f"Selected {len(key_frames)} key screenshots")
    print(f"Selected {len(transcript_key_frames)} combined visual/transcript screenshots")
    print(f"Context package: {args.output / 'context.md'}")


if __name__ == "__main__":
    main()
