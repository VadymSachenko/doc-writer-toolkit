"""Tests for the parts of sme_video_context.py that read pixels: the de-duplication walk of the bulk
pass, the targeted `--extract-at` pass and the contact sheet.

They need Pillow and ImageHash (tests/requirements.txt) and nothing else. OCR is replaced by a lookup
table, so there is no tesseract, and ffmpeg is never called. Frames are generated here as small
JPEGs of random grey blocks, so each seed gives a picture whose perceptual hash is far from the others.
"""

import csv
import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import imagehash
from PIL import Image, ImageDraw

from support import captured, svc, write_fake_jpg

WIDTH, HEIGHT = 160, 100
BLOCK = 10
JOBS = 1  # one process: the patched OCR lives in this process, and --jobs does not change the result

TEXT_A = "Payments overview dashboard with the list of recent transactions and totals"
TEXT_B = "Settings page notifications email sms alerts toggles per user preferences"
TEXT_C = "Another completely different screen for exporting reports in csv format"


def blocks_image(seed, repainted=0):
    """A picture of random grey blocks. `repainted` redraws that many blocks, a small on-screen edit."""
    rng = random.Random(seed)
    image = Image.new("L", (WIDTH, HEIGHT), 255)
    draw = ImageDraw.Draw(image)
    cells = [(x, y) for x in range(0, WIDTH, BLOCK) for y in range(0, HEIGHT, BLOCK)]
    for x, y in cells:
        draw.rectangle((x, y, x + BLOCK - 1, y + BLOCK - 1), fill=int(rng.random() * 255))
    if repainted:
        other = random.Random(99)
        other.shuffle(cells)
        for x, y in cells[:repainted]:
            draw.rectangle((x, y, x + BLOCK - 1, y + BLOCK - 1), fill=int(other.random() * 255))
    return image


def save_jpg(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(path, "JPEG", quality=95)
    return path


def phash(path):
    with Image.open(path) as image:
        return imagehash.phash(image.crop((0, 0, round(image.width * 0.88), image.height)))


class FrameTestCase(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.tmp = Path(holder.name)
        self.raw = self.tmp / "raw"
        self.out = self.tmp / "out"
        self.out.mkdir()
        self.ocr_calls = []


class FixtureTests(FrameTestCase):
    """The walk tests below rest on these distances, so a change in the image library shows up here first."""

    def test_pictures_are_far_apart_and_a_small_edit_is_in_the_borderline_range(self):
        a = save_jpg(blocks_image(1), self.raw / "a.jpg")
        b = save_jpg(blocks_image(2), self.raw / "b.jpg")
        edited = save_jpg(blocks_image(1, repainted=2), self.raw / "edited.jpg")
        same = save_jpg(blocks_image(1), self.raw / "same.jpg")
        self.assertEqual(phash(a) - phash(same), 0)
        self.assertGreaterEqual(phash(a) - phash(b), 20)
        # Past the OCR gate (4) and under the default keep threshold (8).
        self.assertTrue(4 <= phash(a) - phash(edited) < 8, phash(a) - phash(edited))


class SelectFramesTests(FrameTestCase):
    def frames(self, *specs):
        """Each spec is (seed, repainted, ocr text). Returns the frame paths in order."""
        self.texts = {}
        paths = []
        for index, (seed, repainted, text) in enumerate(specs, start=1):
            path = save_jpg(blocks_image(seed, repainted), self.raw / f"frame-{index:06d}.jpg")
            self.texts[path.stem] = text
            paths.append(path)
        return paths

    def fake_read_ocr(self, image, scratch, language):
        frame = scratch.name.replace(".ocr-scratch.png", "")
        self.ocr_calls.append((frame, language))
        return self.texts[frame]

    def select(self, frames, hash_threshold=8, interval=3.0, language="eng"):
        progress = svc.Progress(self.tmp / "progress.json")
        with mock.patch.object(svc, "read_ocr", self.fake_read_ocr), captured() as (_, err):
            kept = svc.select_frames(frames, self.out, interval, hash_threshold, language, JOBS, progress)
        self.stderr = err.getvalue()
        return kept

    def decisions(self):
        with (self.out / "frame-decisions.csv").open(newline="", encoding="utf-8") as file:
            return list(csv.DictReader(file))

    def test_identical_frames_are_dropped_and_a_return_to_a_seen_screen_is_not_kept_again(self):
        frames = self.frames(
            (1, 0, TEXT_A),  # 0 s    first frame: kept
            (1, 0, TEXT_A),  # 3 s    same picture: dropped
            (2, 0, TEXT_B),  # 6 s    new screen: kept
            (1, 0, TEXT_A),  # 9 s    back to the first screen: far from the last kept frame, but already seen
            (3, 0, TEXT_C),  # 12 s   new screen: kept
        )
        kept = self.select(frames)
        self.assertEqual([c.seconds for c in kept], [0.0, 6.0, 12.0])
        self.assertEqual([r["decision"] for r in self.decisions()], ["keep", "drop", "keep", "drop", "keep"])

    def test_kept_frames_are_copied_with_names_from_their_time_and_ocr_text_beside_them(self):
        kept = self.select(self.frames((1, 0, TEXT_A), (2, 0, TEXT_B)), interval=3.0)
        names = sorted(p.name for p in (self.out / "images").iterdir())
        self.assertEqual(names, ["screen-00-00-00.jpg", "screen-00-00-03.jpg"])
        self.assertEqual((self.out / "ocr" / "screen-00-00-03.txt").read_text(encoding="utf-8"), TEXT_B + "\n")
        # The candidate points at the saved copy, because the raw frames folder is deleted afterwards.
        self.assertEqual([c.source.parent for c in kept], [self.out / "images"] * 2)

    def test_the_interval_sets_each_frames_time(self):
        kept = self.select(self.frames((1, 0, TEXT_A), (2, 0, TEXT_B), (3, 0, TEXT_C)), interval=5.5)
        self.assertEqual([c.seconds for c in kept], [0.0, 5.5, 11.0])
        self.assertEqual(
            sorted(p.name for p in (self.out / "images").iterdir()),
            ["screen-00-00-00.jpg", "screen-00-00-05_5.jpg", "screen-00-00-11.jpg"],
        )

    def test_ocr_runs_only_on_frames_that_changed_enough(self):
        frames = self.frames((1, 0, TEXT_A), (1, 0, TEXT_A), (2, 0, TEXT_B), (1, 0, TEXT_A), (3, 0, TEXT_C))
        self.select(frames)
        self.assertEqual(
            [name for name, _ in self.ocr_calls],
            ["frame-000001", "frame-000003", "frame-000004", "frame-000005"],
        )
        self.assertIn("OCR ran on 4 of 5 candidate frames", self.stderr)

    def test_the_ocr_language_is_passed_on(self):
        self.select(self.frames((1, 0, TEXT_A)), language="eng+ukr")
        self.assertEqual({language for _, language in self.ocr_calls}, {"eng+ukr"})

    def test_frame_decisions_csv_records_distance_similarity_and_decision(self):
        self.select(self.frames((1, 0, TEXT_A), (1, 0, TEXT_A), (2, 0, TEXT_B)))
        first, second, third = self.decisions()
        self.assertEqual((first["frame"], first["visual_distance"], first["ocr_similarity"]), ("screen-00-00-00.jpg", "", ""))
        self.assertEqual((second["frame"], second["visual_distance"], second["ocr_similarity"], second["decision"]),
                         ("frame-000002.jpg", "0", "", "drop"))
        self.assertEqual(third["frame"], "screen-00-00-06.jpg")
        self.assertGreaterEqual(int(third["visual_distance"]), 20)
        self.assertRegex(third["ocr_similarity"], r"^0\.\d{3}$")

    def test_a_small_edit_is_kept_when_the_screen_text_changed_a_lot(self):
        # The picture moved by 4 bits, under the keep threshold of 8, but the text on screen is different.
        kept = self.select(self.frames((1, 0, TEXT_A), (1, 2, TEXT_B)))
        self.assertEqual([c.seconds for c in kept], [0.0, 3.0])

    def test_a_small_edit_is_dropped_when_the_text_is_the_same(self):
        kept = self.select(self.frames((1, 0, TEXT_A), (1, 2, TEXT_A)))
        self.assertEqual([c.seconds for c in kept], [0.0])
        self.assertEqual(len(self.ocr_calls), 2)  # it was close enough to be read, and was the same

    def test_a_small_edit_with_a_short_text_is_not_a_text_change(self):
        kept = self.select(self.frames((1, 0, "Pay"), (1, 2, "Save")))
        self.assertEqual([c.seconds for c in kept], [0.0])

    def test_a_lower_hash_threshold_keeps_the_small_edit_by_picture_alone(self):
        frames = self.frames((1, 0, "Pay"), (1, 2, "Save"))
        self.assertEqual([c.seconds for c in self.select(frames, hash_threshold=8)], [0.0])
        self.assertEqual([c.seconds for c in self.select(frames, hash_threshold=4)], [0.0, 3.0])

    def test_a_small_edit_of_a_screen_already_kept_is_dropped_even_below_the_threshold(self):
        # Same text and 4 bits apart: the picture would pass a threshold of 4, but the screen was seen.
        kept = self.select(self.frames((1, 0, TEXT_A), (1, 2, TEXT_A)), hash_threshold=4)
        self.assertEqual([c.seconds for c in kept], [0.0])

    def test_a_frame_with_no_readable_text_is_still_kept_when_the_picture_changes(self):
        kept = self.select(self.frames((1, 0, ""), (2, 0, "")))
        self.assertEqual([c.seconds for c in kept], [0.0, 3.0])

    def test_progress_ends_complete_in_the_ocr_stage(self):
        self.select(self.frames((1, 0, TEXT_A), (2, 0, TEXT_B)))
        state = json.loads((self.tmp / "progress.json").read_text(encoding="utf-8"))
        self.assertEqual((state["stage"], state["done"], state["total"], state["pct"]), ("ocr", 2, 2, 100.0))


class ExtractAtTimestampsTests(FrameTestCase):
    def setUp(self):
        super().setUp()
        self.frames_dir = self.tmp / "frames"
        write_fake_jpg(self.frames_dir / "screen-00-00-10.jpg")
        self.existing = {
            "screenshot": "screen-00-00-10.jpg", "seconds": 10.0, "timestamp": "00:00:10",
            "ocr_text": "already there", "transcript_text": "", "score": 9, "reasons": ["problem"],
            "source": "visual-dedup",
        }
        svc.write_frames_index(self.frames_dir, [self.existing])
        self.extract_calls = []

    def fake_extract(self, video, target, seconds):
        self.extract_calls.append(seconds)
        if seconds > 400:
            return False
        save_jpg(blocks_image(int(seconds)), target)
        return True

    def run_pass(self, timestamps, transcript=(), tolerance=5.0):
        with mock.patch.object(svc, "extract_frame_at", self.fake_extract), \
                mock.patch.object(svc, "read_ocr", lambda image, scratch, language: "Create payment"), \
                captured():
            return svc.extract_at_timestamps(
                Path("m.mp4"), self.frames_dir, list(timestamps), tolerance, list(transcript), "eng",
            )

    def index(self):
        return json.loads((self.frames_dir / "frames-index.json").read_text(encoding="utf-8"))

    def test_report_says_covered_extracted_or_unavailable(self):
        report = self.run_pass([12, 60, 61, 500])
        self.assertEqual(
            report,
            [
                {"requested": 12, "status": "already-covered", "screenshot": "screen-00-00-10.jpg"},
                {"requested": 60, "status": "extracted", "screenshot": "screen-00-01-00.jpg"},
                {"requested": 61, "status": "already-covered", "screenshot": "screen-00-01-00.jpg"},  # the frame pulled a moment ago
                {"requested": 500, "status": "unavailable", "screenshot": "-"},
            ],
        )
        self.assertEqual(self.extract_calls, [60, 500])  # ffmpeg only where nothing was near

    def test_the_tolerance_edge_is_inclusive(self):
        self.assertEqual(self.run_pass([15], tolerance=5.0)[0]["status"], "already-covered")
        self.assertEqual(self.run_pass([15.1], tolerance=5.0)[0]["status"], "extracted")

    def test_new_entries_are_appended_and_the_old_one_stays_as_it_was(self):
        self.run_pass([60.5])
        entries = self.index()
        self.assertEqual([e["screenshot"] for e in entries], ["screen-00-00-10.jpg", "screen-00-01-00_5.jpg"])
        self.assertEqual(entries[0], self.existing)
        self.assertEqual(entries[1]["source"], "targeted")
        self.assertEqual(entries[1]["timestamp"], "00:01:00.5")
        self.assertEqual(entries[1]["ocr_text"], "Create payment")

    def test_entries_carry_the_transcript_when_it_is_passed(self):
        transcript = [{"start": 55, "end": 62, "text": "Дивись, там кнопка"}]
        self.run_pass([60], transcript)
        entry = self.index()[-1]
        self.assertEqual(
            (entry["transcript_text"], entry["score"], entry["reasons"]),
            ("Дивись, там кнопка", 5, ["visual-reference", "ui-action"]),
        )

    def test_without_a_transcript_the_entry_has_score_zero_but_keeps_its_ocr_text(self):
        self.run_pass([60])
        entry = self.index()[-1]
        self.assertEqual((entry["transcript_text"], entry["score"], entry["reasons"]), ("", 0, []))
        self.assertEqual(entry["ocr_text"], "Create payment")

    def test_nothing_extracted_leaves_the_index_untouched(self):
        before = (self.frames_dir / "frames-index.json").read_text(encoding="utf-8")
        self.run_pass([11, 500])
        self.assertEqual((self.frames_dir / "frames-index.json").read_text(encoding="utf-8"), before)

    def test_only_the_frames_and_the_index_are_left_in_the_folder(self):
        self.run_pass([60])
        self.assertEqual(
            sorted(p.name for p in self.frames_dir.iterdir()),
            ["frames-index.json", "screen-00-00-10.jpg", "screen-00-01-00.jpg"],
        )


class ContactSheetTests(FrameTestCase):
    def test_sheet_is_four_columns_of_420_wide_thumbnails(self):
        for second in range(0, 15, 3):  # five frames: two rows
            save_jpg(blocks_image(second + 1), self.out / "images" / svc.screenshot_name(second))
        svc.write_contact_sheet(self.out)
        with Image.open(self.out / "contact-sheet.jpg") as sheet:
            self.assertEqual(sheet.size, (4 * 420, 2 * round(HEIGHT * 420 / WIDTH)))

    def test_no_images_means_no_sheet(self):
        (self.out / "images").mkdir()
        svc.write_contact_sheet(self.out)
        self.assertFalse((self.out / "contact-sheet.jpg").exists())


class OcrPreparationTests(FrameTestCase):
    def test_prepare_for_ocr_crops_the_chrome_and_doubles_the_size(self):
        image = blocks_image(1)
        prepared = svc.prepare_for_ocr(image, 0.88)
        crop_w = round(WIDTH * 0.88) - round(WIDTH * 0.04)
        crop_h = round(HEIGHT * 0.94) - round(HEIGHT * 0.07)
        self.assertEqual(prepared.size, (crop_w * 2, crop_h * 2))


if __name__ == "__main__":
    unittest.main()
