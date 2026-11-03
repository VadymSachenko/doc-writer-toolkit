"""Tests for the logic of sme_video_context.py that needs no image library, no ffmpeg and no tesseract.

Everything here runs on the standard library alone. The frames and the OCR of the bulk pass are in
test_frames.py. Fixtures are short texts and files that carry only the right name.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path
from unittest import mock

from support import SCRIPT, SCRIPT_DIR, TURBOSCRIBE_SAMPLE, FakeClock, captured, svc, write_fake_jpg


class TempDirTestCase(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.tmp = Path(holder.name)

    def transcript_file(self, name="part.txt", text=TURBOSCRIBE_SAMPLE) -> Path:
        path = self.tmp / name
        path.write_text(text, encoding="utf-8")
        return path


class TimestampTests(unittest.TestCase):
    def test_timestamp_rounds_to_whole_seconds(self):
        self.assertEqual(svc.timestamp(0), "00:00:00")
        self.assertEqual(svc.timestamp(36.2), "00:00:36")
        self.assertEqual(svc.timestamp(3661), "01:01:01")
        self.assertEqual(svc.timestamp(-5), "00:00:00")

    def test_timestamp_precise_adds_tenths_only_off_a_whole_second(self):
        self.assertEqual(svc.timestamp_precise(36.0), "00:00:36")
        self.assertEqual(svc.timestamp_precise(58.5), "00:00:58.5")
        self.assertEqual(svc.timestamp_precise(58.6), "00:00:58.6")
        self.assertEqual(svc.timestamp_precise(3661.2), "01:01:01.2")

    def test_timestamp_precise_carries_a_rounded_up_tenth_into_the_next_second(self):
        self.assertEqual(svc.timestamp_precise(59.97), "00:01:00")

    def test_screenshot_name_keeps_whole_seconds_clean_and_marks_tenths(self):
        self.assertEqual(svc.screenshot_name(36), "screen-00-00-36.jpg")
        self.assertEqual(svc.screenshot_name(58.5), "screen-00-00-58_5.jpg")
        self.assertEqual(svc.screenshot_name(3661.2), "screen-01-01-01_2.jpg")

    def test_two_frames_in_one_second_get_different_names(self):
        self.assertNotEqual(svc.screenshot_name(58.0), svc.screenshot_name(58.5))

    def test_seconds_from_screenshot_name_reads_both_forms_back(self):
        for seconds in (0, 36, 58.5, 3661.2):
            with self.subTest(seconds=seconds):
                self.assertAlmostEqual(
                    svc.seconds_from_screenshot_name(svc.screenshot_name(seconds)), seconds
                )

    def test_seconds_from_screenshot_name_rejects_other_names(self):
        for name in ("screen-1-2-3.jpg", "screen-00-00-36.png", "frame-000001.jpg", "screen-00-00-36_55.jpg"):
            with self.subTest(name=name):
                self.assertIsNone(svc.seconds_from_screenshot_name(name))


class TextHelperTests(unittest.TestCase):
    def test_normalized_text_lowercases_and_drops_punctuation(self):
        self.assertEqual(svc.normalized_text("Create  Payment, NOW!"), "create payment now")

    def test_normalized_text_keeps_path_and_address_characters(self):
        self.assertEqual(svc.normalized_text("GET /api/v1/pay a@b.com"), "get /api/v1/pay a@b.com")

    def test_collapse_whitespace(self):
        self.assertEqual(svc.collapse_whitespace("  one \n two\t three "), "one two three")


class TurboscribeParsingTests(TempDirTestCase):
    def test_parses_segments_and_ignores_the_trailer(self):
        segments, sources = svc.parse_turboscribe([str(self.transcript_file())])
        self.assertEqual(
            segments,
            [
                {"start": 5, "end": 10, "text": "Дивись, там кнопка для оплати."},
                {"start": 10, "end": 25, "text": "Нічого особливого тут не відбувається."},
            ],
        )
        self.assertEqual(sources, [{"file": str(self.tmp / "part.txt"), "offset": 0.0}])

    def test_offset_after_at_sign_shifts_every_segment(self):
        path = self.transcript_file()
        segments, sources = svc.parse_turboscribe([f"{path}@1500"])
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(1505, 1510), (1510, 1525)])
        self.assertEqual(sources[0]["offset"], 1500.0)

    def test_at_sign_that_is_not_an_offset_stays_part_of_the_file_name(self):
        path = self.transcript_file("notes@home.txt")
        segments, sources = svc.parse_turboscribe([str(path)])
        self.assertEqual(len(segments), 2)
        self.assertEqual(sources[0], {"file": str(path), "offset": 0.0})

    def test_several_files_merge_in_time_order(self):
        first = self.transcript_file("a.txt", "(0:30 - 0:40)\nlate\n")
        second = self.transcript_file("b.txt", "(0:05 - 0:10)\nearly\n")
        segments, _ = svc.parse_turboscribe([str(first), str(second)])
        self.assertEqual([s["text"] for s in segments], ["early", "late"])

    def test_minutes_over_an_hour_and_a_byte_order_mark(self):
        path = self.transcript_file("long.txt", "﻿(61:02 - 61:30)\ntext\n")
        segments, _ = svc.parse_turboscribe([str(path)])
        self.assertEqual(segments, [{"start": 3662, "end": 3690, "text": "text"}])

    def test_empty_segments_are_dropped(self):
        path = self.transcript_file("empty.txt", "(0:00 - 0:05)\nsaid\n\n(0:05 - 0:09)\n   \n")
        segments, _ = svc.parse_turboscribe([str(path)])
        self.assertEqual([s["text"] for s in segments], ["said"])

    def test_import_writes_transcript_json_and_txt(self):
        out = self.tmp / "out"
        out.mkdir()
        segments = svc.import_turboscribe([str(self.transcript_file())], out)
        self.assertEqual(len(segments), 2)
        data = json.loads((out / "transcript.json").read_text(encoding="utf-8"))
        self.assertEqual(data["language"], "uk")
        self.assertEqual(data["segments"], segments)
        lines = (out / "transcript.txt").read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "[00:00:05–00:00:10] Дивись, там кнопка для оплати.")
        self.assertEqual(len(lines), 2)


class TranscriptRelevanceTests(unittest.TestCase):
    def test_no_keywords_scores_zero(self):
        self.assertEqual(svc.transcript_relevance("Нічого особливого"), (0, []))

    def test_each_category_has_its_weight(self):
        cases = [
            ("Дивись сюди", 3, ["visual-reference"]),
            ("Натисни кнопку", 2, ["ui-action"]),
            ("Треба зробити", 2, ["requirement-decision"]),
            ("Це json", 1, ["technical-detail"]),
            ("Тут помилка", 2, ["problem"]),
        ]
        for text, score, reasons in cases:
            with self.subTest(text=text):
                self.assertEqual(svc.transcript_relevance(text), (score, reasons))

    def test_categories_add_up_but_a_category_counts_once(self):
        self.assertEqual(
            svc.transcript_relevance("Дивись, натисни кнопку, поле і вкладка"),
            (5, ["visual-reference", "ui-action"]),
        )

    def test_all_five_categories_score_ten(self):
        text = "Дивись, натисни кнопку, треба додати api, тут помилка"
        score, reasons = svc.transcript_relevance(text)
        self.assertEqual(score, 10)
        self.assertEqual(
            reasons,
            ["visual-reference", "ui-action", "requirement-decision", "technical-detail", "problem"],
        )

    def test_match_ignores_case_and_works_in_english_and_russian(self):
        self.assertEqual(svc.transcript_relevance("CHECK THE API RESPONSE")[1], ["technical-detail"])
        self.assertEqual(svc.transcript_relevance("Смотри сюда")[1], ["visual-reference"])


class PlanFromTranscriptTests(TempDirTestCase):
    def test_plan_has_midpoint_score_reasons_and_text_sorted_by_time(self):
        late = self.transcript_file("late.txt", "(1:00 - 1:10)\nТут помилка\n")
        early = self.transcript_file("early.txt", "(0:10 - 0:21)\nДивись, там кнопка\n")
        plan = svc.plan_from_transcript([str(late), str(early)])
        self.assertEqual(
            plan,
            [
                {"seconds": 15.5, "score": 5, "reasons": ["visual-reference", "ui-action"], "text": "Дивись, там кнопка"},
                {"seconds": 65.0, "score": 2, "reasons": ["problem"], "text": "Тут помилка"},
            ],
        )

    def test_plan_applies_the_offset(self):
        path = self.transcript_file()
        plan = svc.plan_from_transcript([f"{path}@100"])
        self.assertEqual([item["seconds"] for item in plan], [107.5, 117.5])


class FramesIndexEntryTests(unittest.TestCase):
    def candidate(self, seconds=60.0, ocr="  Pay   now\n button "):
        return svc.Candidate(Path("images") / svc.screenshot_name(seconds), seconds, None, ocr, None, True)

    def test_entry_fields(self):
        transcript = [{"start": 45, "end": 50, "text": "Дивись,   там кнопка"}]
        entry = svc.frames_index_entry(self.candidate(58.5), transcript, "targeted")
        self.assertEqual(
            entry,
            {
                "screenshot": "screen-00-00-58_5.jpg",
                "seconds": 58.5,
                "timestamp": "00:00:58.5",
                "ocr_text": "Pay now button",
                "transcript_text": "Дивись, там кнопка",
                "score": 5,
                "reasons": ["visual-reference", "ui-action"],
                "source": "targeted",
            },
        )

    def test_only_segments_within_twenty_seconds_count(self):
        transcript = [
            {"start": 30, "end": 35, "text": "Дивись"},  # ends 25 s before the frame
            {"start": 45, "end": 50, "text": "Натисни кнопку"},  # ends 10 s before
            {"start": 80, "end": 85, "text": "Тут помилка"},  # starts exactly 20 s after
            {"start": 81, "end": 85, "text": "Дивись"},  # starts 21 s after
        ]
        entry = svc.frames_index_entry(self.candidate(60.0), transcript, "transcript-key")
        self.assertEqual(entry["transcript_text"], "Натисни кнопку Тут помилка")

    def test_score_is_the_best_single_segment_not_the_sum(self):
        transcript = [
            {"start": 45, "end": 50, "text": "Дивись"},
            {"start": 70, "end": 75, "text": "Треба додати"},
        ]
        entry = svc.frames_index_entry(self.candidate(60.0), transcript, "visual-dedup")
        self.assertEqual((entry["score"], entry["reasons"]), (3, ["visual-reference"]))

    def test_a_tie_keeps_the_earlier_segment(self):
        transcript = [
            {"start": 45, "end": 50, "text": "Натисни кнопку"},
            {"start": 51, "end": 55, "text": "Треба зробити"},
        ]
        entry = svc.frames_index_entry(self.candidate(60.0), transcript, "visual-dedup")
        self.assertEqual((entry["score"], entry["reasons"]), (2, ["ui-action"]))

    def test_without_a_transcript_score_is_zero_and_text_is_empty(self):
        entry = svc.frames_index_entry(self.candidate(), [], "targeted")
        self.assertEqual((entry["transcript_text"], entry["score"], entry["reasons"]), ("", 0, []))
        self.assertEqual(entry["ocr_text"], "Pay now button")

    def test_ocr_text_is_cut_to_300_and_transcript_text_to_400(self):
        transcript = [{"start": 55, "end": 60, "text": "слово " * 200}]
        entry = svc.frames_index_entry(self.candidate(60.0, ocr="x" * 500), transcript, "visual-dedup")
        self.assertEqual(len(entry["ocr_text"]), 300)
        self.assertEqual(len(entry["transcript_text"]), 400)


class FramesIndexFileTests(TempDirTestCase):
    def entry(self, name, seconds, **extra):
        return {"screenshot": name, "seconds": seconds, "source": "visual-dedup", **extra}

    def read(self, folder):
        return json.loads((folder / "frames-index.json").read_text(encoding="utf-8"))

    def test_missing_index_loads_as_empty(self):
        self.assertEqual(svc.load_frames_index(self.tmp), [])

    def test_write_sorts_by_seconds_and_creates_the_folder(self):
        folder = self.tmp / "new" / "images"
        svc.write_frames_index(folder, [self.entry("b.jpg", 30), self.entry("a.jpg", 10)])
        self.assertEqual([e["screenshot"] for e in self.read(folder)], ["a.jpg", "b.jpg"])

    def test_write_keeps_non_ascii_text_readable(self):
        svc.write_frames_index(self.tmp, [self.entry("a.jpg", 1, transcript_text="Привіт")])
        self.assertIn("Привіт", (self.tmp / "frames-index.json").read_text(encoding="utf-8"))

    def test_append_adds_to_the_existing_entries(self):
        svc.write_frames_index(self.tmp, [self.entry("a.jpg", 10), self.entry("c.jpg", 50)])
        svc.append_frames_index(self.tmp, [self.entry("b.jpg", 30)])
        self.assertEqual([e["screenshot"] for e in self.read(self.tmp)], ["a.jpg", "b.jpg", "c.jpg"])

    def test_append_never_overwrites_an_entry_already_there(self):
        svc.write_frames_index(self.tmp, [self.entry("a.jpg", 10, score=9, ocr_text="kept")])
        svc.append_frames_index(self.tmp, [self.entry("a.jpg", 10, score=0, ocr_text="replacement")])
        (stored,) = self.read(self.tmp)
        self.assertEqual((stored["score"], stored["ocr_text"]), (9, "kept"))

    def test_append_skips_a_repeated_name_inside_one_call(self):
        svc.append_frames_index(
            self.tmp, [self.entry("a.jpg", 10, score=1), self.entry("a.jpg", 10, score=2)]
        )
        (stored,) = self.read(self.tmp)
        self.assertEqual(stored["score"], 1)

    def test_append_creates_the_index_when_there_is_none(self):
        folder = self.tmp / "fresh"
        svc.append_frames_index(folder, [self.entry("a.jpg", 10)])
        self.assertEqual(len(self.read(folder)), 1)

    def test_repeated_appends_only_add_coverage(self):
        for batch in (["a.jpg"], ["a.jpg", "b.jpg"], ["b.jpg", "c.jpg"]):
            svc.append_frames_index(
                self.tmp, [self.entry(name, i * 10) for i, name in enumerate(batch)]
            )
        self.assertEqual({e["screenshot"] for e in self.read(self.tmp)}, {"a.jpg", "b.jpg", "c.jpg"})


class MergeScreenshotsTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.source = self.tmp / "source"
        self.dest = self.tmp / "dest"

    def index(self, folder):
        return json.loads((folder / "frames-index.json").read_text(encoding="utf-8"))

    def test_copies_new_frames_and_skips_those_within_tolerance(self):
        write_fake_jpg(self.dest / "screen-00-00-10.jpg")
        for name in ("screen-00-00-12.jpg", "screen-00-00-15.jpg", "screen-00-00-16.jpg", "screen-00-00-30.jpg"):
            write_fake_jpg(self.source / name)
        report = svc.merge_screenshots(self.source, self.dest, 5)
        self.assertEqual(
            [(r["seconds"], r["status"], r["screenshot"]) for r in report],
            [
                (12, "skipped-duplicate", "screen-00-00-10.jpg"),
                (15, "skipped-duplicate", "screen-00-00-10.jpg"),  # exactly the tolerance away
                (16, "copied", "screen-00-00-16.jpg"),
                (30, "copied", "screen-00-00-30.jpg"),
            ],
        )
        self.assertTrue((self.dest / "screen-00-00-16.jpg").exists())
        self.assertFalse((self.dest / "screen-00-00-12.jpg").exists())

    def test_a_frame_copied_earlier_in_the_same_run_covers_the_next_one(self):
        write_fake_jpg(self.source / "screen-00-01-00.jpg")
        write_fake_jpg(self.source / "screen-00-01-03.jpg")
        report = svc.merge_screenshots(self.source, self.dest, 5)
        self.assertEqual([r["status"] for r in report], ["copied", "skipped-duplicate"])
        self.assertEqual(report[1]["screenshot"], "screen-00-01-00.jpg")

    def test_the_destination_is_created_and_the_copy_is_byte_for_byte(self):
        write_fake_jpg(self.source / "screen-00-00-30.jpg", b"pixels")
        svc.merge_screenshots(self.source, self.dest / "deep" / "folder", 5)
        self.assertEqual((self.dest / "deep" / "folder" / "screen-00-00-30.jpg").read_bytes(), b"pixels")

    def test_other_files_in_the_source_are_ignored(self):
        write_fake_jpg(self.source / "screen-00-00-30.jpg")
        write_fake_jpg(self.source / "notes.jpg")
        write_fake_jpg(self.source / "screen-00-00-45.png")
        report = svc.merge_screenshots(self.source, self.dest, 5)
        self.assertEqual([r["screenshot"] for r in report], ["screen-00-00-30.jpg"])

    def test_carries_the_source_index_entry_and_falls_back_to_a_bare_one(self):
        write_fake_jpg(self.source / "screen-00-00-30.jpg")
        write_fake_jpg(self.source / "screen-00-00-45_5.jpg")
        carried = {
            "screenshot": "screen-00-00-30.jpg", "seconds": 30.0, "timestamp": "00:00:30",
            "ocr_text": "from the source", "transcript_text": "said", "score": 4,
            "reasons": ["ui-action"], "source": "transcript-key",
        }
        svc.write_frames_index(self.source, [carried])
        svc.merge_screenshots(self.source, self.dest, 5)
        by_name = {e["screenshot"]: e for e in self.index(self.dest)}
        self.assertEqual(by_name["screen-00-00-30.jpg"], carried)
        self.assertEqual(
            by_name["screen-00-00-45_5.jpg"],
            {
                "screenshot": "screen-00-00-45_5.jpg", "seconds": 45.5, "timestamp": "00:00:45.5",
                "ocr_text": "", "transcript_text": "", "score": 0, "reasons": [], "source": "visual-dedup",
            },
        )

    def test_appends_to_the_destination_index_and_never_loses_its_entries(self):
        write_fake_jpg(self.dest / "screen-00-00-10.jpg")
        existing = {"screenshot": "screen-00-00-10.jpg", "seconds": 10.0, "score": 7, "source": "targeted"}
        svc.write_frames_index(self.dest, [existing])
        write_fake_jpg(self.source / "screen-00-00-30.jpg")
        svc.merge_screenshots(self.source, self.dest, 5)
        entries = self.index(self.dest)
        self.assertEqual([e["screenshot"] for e in entries], ["screen-00-00-10.jpg", "screen-00-00-30.jpg"])
        self.assertEqual(entries[0], existing)

    def test_a_second_run_changes_nothing(self):
        write_fake_jpg(self.source / "screen-00-00-30.jpg")
        svc.merge_screenshots(self.source, self.dest, 5)
        before = (self.dest / "frames-index.json").read_text(encoding="utf-8")
        report = svc.merge_screenshots(self.source, self.dest, 5)
        self.assertEqual([r["status"] for r in report], ["skipped-duplicate"])
        self.assertEqual((self.dest / "frames-index.json").read_text(encoding="utf-8"), before)

    def test_nothing_new_writes_no_index(self):
        self.source.mkdir()
        svc.merge_screenshots(self.source, self.dest, 5)
        self.assertFalse((self.dest / "frames-index.json").exists())

    def test_whole_second_and_tenth_names_compare_by_their_seconds(self):
        write_fake_jpg(self.dest / "screen-00-00-58.jpg")
        write_fake_jpg(self.source / "screen-00-00-58_5.jpg")
        self.assertEqual(svc.merge_screenshots(self.source, self.dest, 0.4)[0]["status"], "copied")
        write_fake_jpg(self.tmp / "d2" / "screen-00-00-58.jpg")
        self.assertEqual(svc.merge_screenshots(self.source, self.tmp / "d2", 0.5)[0]["status"], "skipped-duplicate")


class ParseExistingScreenshotsTests(TempDirTestCase):
    def test_reads_seconds_from_names_in_time_order_and_skips_others(self):
        for name in ("screen-00-01-00.jpg", "screen-00-00-58_5.jpg", "screen-bad.jpg", "readme.txt"):
            write_fake_jpg(self.tmp / name)
        found = svc.parse_existing_screenshots(self.tmp)
        self.assertEqual([(s, p.name) for s, p in found], [(58.5, "screen-00-00-58_5.jpg"), (60.0, "screen-00-01-00.jpg")])


class LoadExistingSelectionTests(TempDirTestCase):
    def test_loads_frames_with_their_ocr_text(self):
        write_fake_jpg(self.tmp / "images" / "screen-00-00-06.jpg")
        write_fake_jpg(self.tmp / "images" / "screen-00-00-12_5.jpg")
        (self.tmp / "ocr").mkdir()
        (self.tmp / "ocr" / "screen-00-00-06.txt").write_text("hello\n", encoding="utf-8")
        kept = svc.load_existing_selection(self.tmp)
        self.assertEqual([(c.seconds, c.ocr, c.keep) for c in kept], [(6.0, "hello\n", True), (12.5, "", True)])

    def test_no_screenshots_is_an_error(self):
        (self.tmp / "images").mkdir()
        with self.assertRaisesRegex(RuntimeError, "no existing screenshots"):
            svc.load_existing_selection(self.tmp)


class NearestFrameTests(unittest.TestCase):
    def frames(self, *seconds):
        return [svc.Candidate(Path(f"{s}.jpg"), s, None, "", None, True) for s in seconds]

    def test_picks_the_closest_within_tolerance(self):
        self.assertEqual(svc.nearest_frame(self.frames(10, 30), 24, 12).seconds, 30)

    def test_tolerance_is_inclusive(self):
        self.assertEqual(svc.nearest_frame(self.frames(10), 22, 12).seconds, 10)
        self.assertIsNone(svc.nearest_frame(self.frames(10), 22.1, 12))

    def test_no_frames_gives_none(self):
        self.assertIsNone(svc.nearest_frame([], 5, 12))


class WriteContextTests(TempDirTestCase):
    def test_context_has_the_ocr_and_the_nearby_speech_per_frame(self):
        near = svc.Candidate(self.tmp / "a.jpg", 100.0, None, "Pay button", None, True)
        alone = svc.Candidate(self.tmp / "b.jpg", 500.0, None, "", None, True)
        transcript = [
            {"start": 85, "end": 90, "text": "inside the window"},
            {"start": 140, "end": 150, "text": "outside the window"},
        ]
        svc.write_context(self.tmp, Path("meeting.mp4"), [near, alone], transcript, 1500)
        text = (self.tmp / "context.md").read_text(encoding="utf-8")
        self.assertIn("- Source clip offset: 00:25:00", text)
        self.assertIn("- Selected screenshots: 2", text)
        self.assertIn("## 00:26:40 source time (00:01:40 in clip)", text)
        self.assertIn("![Screen at 00:26:40](images/screen-00-01-40.jpg)", text)
        self.assertIn("Pay button", text)
        self.assertIn("- [00:01:25] inside the window", text)
        self.assertNotIn("outside the window", text)
        self.assertIn("[No reliable text detected]", text)
        self.assertIn("[No speech detected in the surrounding 40-second window]", text)


class WriteKeyPackageTests(TempDirTestCase):
    def test_keeps_the_frame_with_most_readable_text_per_window(self):
        def frame(seconds, ocr):
            path = write_fake_jpg(self.tmp / "images" / svc.screenshot_name(seconds))
            return svc.Candidate(path, seconds, None, ocr, None, True)

        kept = [frame(0, "a"), frame(10, "much longer readable text"), frame(40, "b"), frame(50, "cc")]
        with mock.patch.object(svc, "write_contact_sheet"):
            key = svc.write_key_package(self.tmp, Path("m.mp4"), kept, [], 0, 30)
        self.assertEqual([c.seconds for c in key], [10, 50])
        names = sorted(p.name for p in (self.tmp / "key" / "images").iterdir())
        self.assertEqual(names, ["screen-00-00-10.jpg", "screen-00-00-50.jpg"])
        self.assertEqual((self.tmp / "key" / "ocr" / "screen-00-00-10.txt").read_text(encoding="utf-8"), "much longer readable text")
        self.assertTrue((self.tmp / "key" / "context.md").exists())


class WriteTranscriptDrivenPackageTests(TempDirTestCase):
    def frame(self, seconds, ocr=""):
        path = write_fake_jpg(self.tmp / "pool" / svc.screenshot_name(seconds))
        return svc.Candidate(path, seconds, None, ocr, None, True)

    def test_picks_a_frame_for_each_important_window(self):
        key_10, key_100 = self.frame(10, "ten"), self.frame(100, "hundred")
        plain_52 = self.frame(52, "fifty-two")
        extracted = self.frame(206, "extracted")
        transcript = [
            {"start": 8, "end": 12, "text": "Дивись, там кнопка"},  # 5 points: frame near 10 is a key frame
            {"start": 14, "end": 16, "text": "Дивись"},  # 3 points: below the cut of 4, ignored
            {"start": 50, "end": 54, "text": "Дивись, там кнопка"},  # no key frame near, a plain frame is
            {"start": 200, "end": 204, "text": "Дивись, там кнопка"},  # same 30-second window as the next one
            {"start": 205, "end": 207, "text": "Дивись, там кнопка, треба додати"},  # 7 points: wins its window
        ]
        with mock.patch.object(svc, "write_contact_sheet"), \
                mock.patch.object(svc, "extract_missing_frame", return_value=extracted) as extract:
            final = svc.write_transcript_driven_package(
                self.tmp, Path("m.mp4"), [key_10, plain_52, key_100], [key_10, key_100], transcript, 0, "eng",
            )
        extract.assert_called_once_with(Path("m.mp4"), self.tmp, 206.0, "eng")
        self.assertEqual([c.seconds for c in final], [10, 52, 100, 206])
        package = self.tmp / "transcript-key"
        self.assertEqual(
            sorted(p.name for p in (package / "images").iterdir()),
            ["screen-00-00-10.jpg", "screen-00-00-52.jpg", "screen-00-01-40.jpg", "screen-00-03-26.jpg"],
        )
        self.assertEqual((package / "ocr" / "screen-00-00-52.txt").read_text(encoding="utf-8"), "fifty-two")
        self.assertTrue((package / "context.md").exists())

    def test_a_frame_that_cannot_be_extracted_is_left_out(self):
        key_10 = self.frame(10)
        transcript = [{"start": 300, "end": 304, "text": "Дивись, там кнопка"}]
        with mock.patch.object(svc, "write_contact_sheet"), \
                mock.patch.object(svc, "extract_missing_frame", return_value=None):
            final = svc.write_transcript_driven_package(self.tmp, Path("m.mp4"), [key_10], [key_10], transcript, 0, "eng")
        self.assertEqual([c.seconds for c in final], [10])


class ExtractFrameAtTests(TempDirTestCase):
    def test_a_failed_ffmpeg_gives_false_removes_the_partial_file_and_warns(self):
        target = self.tmp / "frames" / "screen-09-00-00.jpg"

        def fail(command, **kwargs):
            target.write_bytes(b"partial")
            raise subprocess.CalledProcessError(1, command)

        with mock.patch.object(svc.subprocess, "run", side_effect=fail), captured() as (_, err):
            self.assertFalse(svc.extract_frame_at(Path("m.mp4"), target, 32400))
        self.assertFalse(target.exists())
        self.assertIn("warning: no frame available at 09:00:00", err.getvalue())

    def test_a_good_run_asks_ffmpeg_for_one_frame_at_the_second(self):
        target = self.tmp / "frames" / "screen-00-00-58_5.jpg"

        def succeed(command, **kwargs):
            target.write_bytes(b"jpeg")

        with mock.patch.object(svc.subprocess, "run", side_effect=succeed) as run:
            self.assertTrue(svc.extract_frame_at(Path("m.mp4"), target, 58.5))
        command = run.call_args.args[0]
        self.assertEqual(command[0], "ffmpeg")
        self.assertEqual(command[command.index("-ss") + 1], "58.5")
        self.assertEqual(command[command.index("-frames:v") + 1], "1")
        self.assertEqual(command[-1], str(target))


class ProgressTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.clock = FakeClock(100.0)
        patcher = mock.patch.object(svc.time, "monotonic", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.path = self.tmp / "progress.json"
        self.progress = svc.Progress(self.path)

    def start(self, stage="extract", total=100):
        with captured():
            self.progress.start_stage(stage, total)

    def update(self, done):
        with captured():
            self.progress.update(done)

    def read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_start_stage_writes_the_first_state(self):
        self.start("extract", 100)
        self.assertEqual(
            self.read(),
            {"stage": "extract", "done": 0, "total": 100, "pct": 0.0, "elapsed_s": 0, "eta_s": 0},
        )

    def test_fields_after_an_update(self):
        self.start("hash", 100)
        self.clock.advance(20)
        self.update(40)
        self.assertEqual(
            self.read(),
            {"stage": "hash", "done": 40, "total": 100, "pct": 40.0, "elapsed_s": 20, "eta_s": 30},
        )

    def test_pct_is_rounded_to_one_decimal(self):
        self.start("extract", 823)
        self.clock.advance(287)
        self.update(412)
        self.assertEqual(self.read()["pct"], 50.1)

    def test_an_unknown_total_gives_zero_pct_and_no_error(self):
        self.start("extract", 0)
        self.clock.advance(5)
        self.update(3)
        self.assertEqual(self.read()["pct"], 0.0)

    def test_writes_at_most_once_a_second(self):
        self.start()
        self.clock.advance(0.5)
        self.update(10)
        self.assertEqual(self.read()["done"], 0)
        self.clock.advance(0.5)
        self.update(20)
        self.assertEqual(self.read()["done"], 20)

    def test_an_update_with_the_same_count_writes_nothing(self):
        self.start()
        self.clock.advance(5)
        self.update(10)
        stamp = self.read()
        self.clock.advance(5)
        self.update(10)
        self.assertEqual(self.read(), stamp)

    def test_the_file_is_replaced_atomically_with_no_tmp_left(self):
        self.start()
        self.clock.advance(2)
        self.update(10)
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["progress.json"])

    def test_finish_stage_forces_a_complete_write_inside_the_second(self):
        self.start("ocr", 50)
        self.clock.advance(0.1)
        with captured():
            self.progress.finish_stage()
        state = self.read()
        self.assertEqual((state["done"], state["pct"], state["eta_s"]), (50, 100.0, 0))

    def test_stage_output_goes_to_stderr_and_stdout_stays_clean(self):
        with captured() as (out, err):
            self.progress.start_stage("extract", 100)
            self.clock.advance(20)
            self.progress.update(40)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("[extract]", err.getvalue())
        self.assertIn("40/100", err.getvalue())

    def test_a_new_stage_starts_from_zero(self):
        self.start("extract", 100)
        self.clock.advance(30)
        self.update(100)
        self.start("hash", 50)
        self.assertEqual(
            self.read(),
            {"stage": "hash", "done": 0, "total": 50, "pct": 0.0, "elapsed_s": 0, "eta_s": 0},
        )

    def test_eta_follows_the_recent_rate_not_the_stage_average(self):
        # 10 items a second for 20 seconds, then 1 a second. The last 20 seconds
        # of samples (40 s to 60 s) ran at 1 a second, so 760 items left take 760 s.
        # The average over the whole stage (4 a second) would say 190 s.
        self.start("extract", 1000)
        for second in range(1, 61):
            self.clock.advance(1)
            self.update(10 * second if second <= 20 else 200 + (second - 20))
        state = self.read()
        self.assertEqual((state["done"], state["elapsed_s"]), (240, 60))
        self.assertEqual(state["eta_s"], 760)

    def test_eta_is_the_stage_average_until_a_window_exists(self):
        self.progress.done = 5
        self.progress.total = 15
        self.progress._window = deque([(10.0, 5)], maxlen=20)
        self.assertEqual(self.progress._eta(now=10.0, elapsed=5.0), 10.0)

    def test_eta_is_zero_before_any_progress(self):
        self.progress.done = 0
        self.progress.total = 10
        self.progress._window = deque([(10.0, 0)], maxlen=20)
        self.assertEqual(self.progress._eta(now=12.0, elapsed=2.0), 0.0)

    def test_eta_is_never_negative(self):
        self.start("extract", 100)
        self.clock.advance(10)
        self.update(120)
        self.assertEqual(self.read()["eta_s"], 0)


class ExtractAtOptionTests(TempDirTestCase):
    """--extract-at is parsed inside main(), so these run main() with the extraction stubbed out."""

    def run_main(self, *args, report=None):
        report = report if report is not None else []
        with mock.patch.object(sys, "argv", ["sme_video_context.py", *args]), \
                mock.patch.object(svc, "extract_at_timestamps", return_value=report) as extract, \
                captured() as (out, err):
            svc.main()
        return extract, out.getvalue()

    def test_timestamps_are_floats_split_on_commas_and_blanks_are_ignored(self):
        extract, _ = self.run_main("m.mp4", str(self.tmp / "frames"), "--extract-at", "36, 58.5,,140, ")
        video, folder, timestamps, tolerance, transcript, language = extract.call_args.args
        self.assertEqual(timestamps, [36.0, 58.5, 140.0])
        self.assertEqual((video, folder), (Path("m.mp4"), self.tmp / "frames"))
        self.assertEqual((tolerance, transcript, language), (15.0, [], "eng+ukr+rus"))

    def test_tolerance_and_ocr_language_are_passed_through(self):
        extract, _ = self.run_main(
            "m.mp4", str(self.tmp / "f"), "--extract-at", "5", "--tolerance", "4", "--ocr-language", "eng",
        )
        self.assertEqual(extract.call_args.args[3], 4.0)
        self.assertEqual(extract.call_args.args[5], "eng")

    def test_the_output_folder_is_created(self):
        self.run_main("m.mp4", str(self.tmp / "made" / "here"), "--extract-at", "5")
        self.assertTrue((self.tmp / "made" / "here").is_dir())

    def test_transcript_given_with_the_flag_reaches_the_extraction(self):
        path = self.transcript_file()
        extract, _ = self.run_main("m.mp4", str(self.tmp / "f"), "--extract-at", "5", "--transcript", f"{path}@100")
        transcript = extract.call_args.args[4]
        self.assertEqual([s["start"] for s in transcript], [105, 110])

    def test_summary_lines(self):
        report = [
            {"requested": 36.0, "status": "extracted", "screenshot": "screen-00-00-36.jpg"},
            {"requested": 58.5, "status": "already-covered", "screenshot": "screen-00-00-60.jpg"},
            {"requested": 900.0, "status": "unavailable", "screenshot": "-"},
        ]
        _, out = self.run_main("m.mp4", str(self.tmp / "f"), "--extract-at", "36,58.5,900", report=report)
        self.assertEqual(
            out.splitlines(),
            [
                "00:00:36: extracted (screen-00-00-36.jpg)",
                "00:00:58.5: already-covered (screen-00-00-60.jpg)",
                "00:15:00: unavailable (-)",
                "Extracted 1 new screenshot(s); 2 already covered",
            ],
        )

    def test_video_and_output_are_required(self):
        with mock.patch.object(sys, "argv", ["sme_video_context.py", "--extract-at", "5"]), \
                captured() as (_, err), self.assertRaises(SystemExit) as raised:
            svc.main()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("video and output are required with --extract-at", err.getvalue())

    def transcript_file(self):
        path = self.tmp / "part.txt"
        path.write_text(TURBOSCRIBE_SAMPLE, encoding="utf-8")
        return path


class CommandLineTests(TempDirTestCase):
    """The modes that run on a bare python3, started as the skill starts them."""

    def run_script(self, *args):
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args], cwd=self.tmp, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        )

    def test_plan_from_transcript_prints_a_json_array_on_stdout(self):
        part = self.tmp / "part.txt"
        part.write_text(TURBOSCRIBE_SAMPLE, encoding="utf-8")
        result = self.run_script("--plan-from-transcript", "--transcript", f"{part}@1500")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual([item["seconds"] for item in plan], [1507.5, 1517.5])
        self.assertEqual(plan[0]["score"], 5)
        self.assertEqual(set(plan[0]), {"seconds", "score", "reasons", "text"})

    def test_plan_from_transcript_needs_a_transcript(self):
        result = self.run_script("--plan-from-transcript")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--plan-from-transcript requires at least one --transcript", result.stderr)

    def test_merge_from_copies_and_reports(self):
        source, dest = self.tmp / "scratch" / "images", self.tmp / "frames"
        write_fake_jpg(dest / "screen-00-00-10.jpg")
        write_fake_jpg(source / "screen-00-00-12.jpg")
        write_fake_jpg(source / "screen-00-00-58_5.jpg")
        result = self.run_script("meeting.mp4", str(dest), "--merge-from", str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "00:00:12: skipped-duplicate (screen-00-00-10.jpg)",
                "00:00:58.5: copied (screen-00-00-58_5.jpg)",
                "Copied 1 screenshot(s); 1 already covered (skipped)",
            ],
        )
        entries = json.loads((dest / "frames-index.json").read_text(encoding="utf-8"))
        self.assertIn("screen-00-00-58_5.jpg", [e["screenshot"] for e in entries])

    def test_merge_from_needs_an_output_folder(self):
        result = self.run_script("--merge-from", str(self.tmp))
        self.assertEqual(result.returncode, 2)
        self.assertIn("output is required with --merge-from", result.stderr)

    def test_a_non_empty_output_folder_is_refused_before_any_work(self):
        out = self.tmp / "out"
        write_fake_jpg(out / "old.jpg")
        result = self.run_script("meeting.mp4", str(out))
        self.assertEqual(result.returncode, 2)
        self.assertIn("output directory must be empty or new", result.stderr)

    def test_video_and_output_are_required_for_a_run(self):
        result = self.run_script("meeting.mp4")
        self.assertEqual(result.returncode, 2)
        self.assertIn("video and output are required", result.stderr)


class RequirementPinsTests(unittest.TestCase):
    """CI installs tests/requirements.txt, so its pins must stay the ones the skill's venv gets."""

    @staticmethod
    def pins(path):
        pins = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                name, _, version = re.split(r"(==)", line)
                pins[name.lower()] = version
        return pins

    def test_test_requirements_are_pinned_as_in_the_skill_requirements(self):
        skill = self.pins(SCRIPT_DIR / "sme-video-requirements.txt")
        tests = self.pins(SCRIPT_DIR / "tests" / "requirements.txt")
        self.assertEqual(set(tests), {"pillow", "imagehash"})
        for name, version in tests.items():
            self.assertEqual(skill.get(name), version, name)

    def test_the_tests_never_need_faster_whisper(self):
        tests = self.pins(SCRIPT_DIR / "tests" / "requirements.txt")
        self.assertNotIn("faster-whisper", tests)


if __name__ == "__main__":
    unittest.main()
