#!/usr/bin/env python3
"""Deterministically count and pair structural elements across two Markdown/MDX pages.

Used by the `doc-alignment-checker` skill to offload the mechanical counting of
headings, tables, images, links, code fences, admonitions, `<details>` blocks,
frontmatter dates, and `{/* ToDo */}` / `{/* NEEDS CONFIRMATION */}` markers from
the LLM (which miscounts on long pages and burns tokens) to a pure standard-library
script. The script only does the arithmetic — it emits an `alignment-report` JSON
document (schema in `context/artifact-schemas.md`) to stdout with structural
mismatches sorted into `bugs`/`warnings` and matched checks listed in `passed`.

All semantic judgment (translation fidelity, whether a structural difference is
intentional, Type-column language, Cyrillic-in-EN, untranslated prose) stays in the
skill — this script never opines on meaning.

CLI:
    python align_check.py <main-file> <secondary-file>

`main` is the source of truth; `secondary` must conform to it. Both paths are
echoed verbatim into the report's `main`/`secondary` fields. Requires only Python 3
(standard library, no external deps); runs on Windows, macOS, and Linux.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# --- Regexes (compiled once) ------------------------------------------------
# Fenced code blocks open/close on a line that (after leading whitespace) starts
# with three or more backticks or tildes. We track them so structural parsing
# never reads element syntax that only *looks* like Markdown inside a code sample.
FENCE_RE = re.compile(r"^\s*(```+|~~~+)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
# Anchor comment Docusaurus/MDX pages hang off UA headings — stripped before compare.
ANCHOR_RE = re.compile(r"\{/\*.*?\*/\}")
IMG_MD_RE = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)")
IMG_HTML_RE = re.compile(r"""<img[^>]*\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
# Inline link, but not an image (negative lookbehind on the leading `!`).
LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(\s*([^)\s]+)")
ADMONITION_RE = re.compile(r"^\s*:::\s*(note|tip|info|warning|danger|caution)\b")
DETAILS_RE = re.compile(r"<details\b", re.IGNORECASE)
TODO_MARKER_RE = re.compile(r"\{/\*\s*ToDo:\s*(.*?)\*/\}", re.IGNORECASE | re.DOTALL)
NEEDS_MARKER_RE = re.compile(
    r"\{/\*\s*NEEDS CONFIRMATION:\s*(.*?)\*/\}", re.IGNORECASE | re.DOTALL
)
# `date:` line inside YAML frontmatter (handles both top-level and nested
# `last_update.date:` — we just grab the first date value we find).
DATE_RE = re.compile(r"^\s*date:\s*(\S+)", re.IGNORECASE)


@dataclass
class Heading:
    level: int
    text: str
    line: int


@dataclass
class Table:
    columns: int
    rows: int
    line: int


@dataclass
class Marker:
    text: str
    line: int


@dataclass
class Parsed:
    """Everything the counting logic needs from one file."""

    date: Optional[str] = None
    headings: list = field(default_factory=list)  # list[Heading]
    tables: list = field(default_factory=list)  # list[Table]
    images: list = field(default_factory=list)  # list[(src, line)]
    links: list = field(default_factory=list)  # list[(target, line)]
    code_fences: list = field(default_factory=list)  # list[(content, line)]
    admonitions: list = field(default_factory=list)  # list[(type, line)]
    details_count: int = 0
    todo_markers: list = field(default_factory=list)  # list[Marker]
    needs_markers: list = field(default_factory=list)  # list[Marker]


def parse(text: str) -> Parsed:
    """Parse one Markdown/MDX document into structural counts. Deterministic and
    order-preserving; code-fence-aware so element syntax inside samples is ignored."""
    p = Parsed()
    lines = text.split("\n")

    # First pass: mark which lines sit inside a fenced code block, and collect the
    # fence contents (byte-for-byte, for the identical-code check).
    in_code = [False] * len(lines)
    fence_open = None  # (marker, start_line, content_lines)
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if fence_open is None:
            if m:
                fence_open = (m.group(1)[0], i, [])
                in_code[i] = True  # the fence delimiter line itself
            continue
        # Inside a fence: a matching delimiter closes it.
        in_code[i] = True
        if m and m.group(1)[0] == fence_open[0]:
            p.code_fences.append(("\n".join(fence_open[2]), fence_open[1] + 1))
            fence_open = None
        else:
            fence_open[2].append(line)
    if fence_open is not None:  # unterminated fence — keep what we gathered
        p.code_fences.append(("\n".join(fence_open[2]), fence_open[1] + 1))

    # Frontmatter: only if the file opens with a `---` delimiter.
    fm_end = -1
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() in ("---", "..."):
                fm_end = i
                break
        if fm_end != -1:
            for i in range(1, fm_end):
                dm = DATE_RE.match(lines[i])
                if dm and p.date is None:
                    p.date = dm.group(1)

    # Second pass: structural elements on non-code, non-frontmatter lines.
    i = 0
    while i < len(lines):
        lineno = i + 1
        line = lines[i]

        if in_code[i] or (fm_end != -1 and i <= fm_end):
            i += 1
            continue

        # Headings.
        hm = HEADING_RE.match(line)
        if hm:
            text = ANCHOR_RE.sub("", hm.group(2)).strip()
            p.headings.append(Heading(len(hm.group(1)), text, lineno))

        # Tables: a contiguous run of `|`-leading lines with a separator row second.
        if line.lstrip().startswith("|"):
            block = []
            j = i
            while j < len(lines) and not in_code[j] and lines[j].lstrip().startswith("|"):
                block.append(lines[j])
                j += 1
            if len(block) >= 2 and re.search(r"\|?\s*:?-{2,}", block[1]):
                columns = _cell_count(block[0])
                rows = len(block) - 2  # minus header + separator
                p.tables.append(Table(columns, rows, lineno))
            i = j  # skip the whole block
            continue

        # Admonitions (opening line only).
        am = ADMONITION_RE.match(line)
        if am:
            p.admonitions.append((am.group(1).lower(), lineno))

        # <details> blocks.
        p.details_count += len(DETAILS_RE.findall(line))

        # Images (Markdown and raw HTML) and inline links.
        for src in IMG_MD_RE.findall(line) + IMG_HTML_RE.findall(line):
            p.images.append((src, lineno))
        for target in LINK_RE.findall(line):
            p.links.append((target, lineno))

        # Markers.
        for mtext in TODO_MARKER_RE.findall(line):
            p.todo_markers.append(Marker(mtext.strip(), lineno))
        for mtext in NEEDS_MARKER_RE.findall(line):
            p.needs_markers.append(Marker(mtext.strip(), lineno))

        i += 1

    return p


def _cell_count(row: str) -> int:
    """Count columns in a Markdown table row, ignoring the outer border pipes."""
    cells = row.strip().strip("|").split("|")
    return len([c for c in cells])


# --- Comparison -------------------------------------------------------------


class Report:
    """Accumulates findings into the alignment-report shape."""

    def __init__(self, main_path: str, secondary_path: str):
        self.main = main_path
        self.secondary = secondary_path
        self.bugs = []
        self.warnings = []
        self.passed = []

    def bug(self, flag, description, line, file):
        self.bugs.append(
            {"flag": flag, "description": description, "line": line, "file": file}
        )

    def warn(self, flag, description, line, file):
        self.warnings.append(
            {"flag": flag, "description": description, "line": line, "file": file}
        )

    def ok(self, check_name):
        self.passed.append(check_name)

    def to_dict(self):
        return {
            "schema": "alignment-report",
            "version": "1",
            "main": self.main,
            "secondary": self.secondary,
            "bugs": self.bugs,
            "warnings": self.warnings,
            "passed": self.passed,
            "counts": {
                "bugs": len(self.bugs),
                "warnings": len(self.warnings),
                "passed": len(self.passed),
            },
        }


def compare(main: Parsed, secondary: Parsed, rpt: Report) -> None:
    """Run every deterministic check and route findings to bugs/warnings/passed.

    Severity mirrors the skill's table: structural *identity* problems (heading
    count/level, code-fence contents) are bugs; *count* drift the skill may still
    judge intentional (tables, images, links, admonitions, details, markers, dates)
    are warnings.
    """
    _check_dates(main, secondary, rpt)
    _check_headings(main, secondary, rpt)
    _check_tables(main, secondary, rpt)
    _check_code_fences(main, secondary, rpt)
    _check_count("Image count", "IMAGE COUNT MISMATCH", main.images, secondary.images, rpt)
    _check_count("Link count", "LINK COUNT MISMATCH", main.links, secondary.links, rpt)
    _check_admonitions(main, secondary, rpt)
    _check_details(main, secondary, rpt)
    _check_markers(main, secondary, rpt)


def _check_dates(main, secondary, rpt):
    if main.date is None and secondary.date is None:
        rpt.ok("Frontmatter dates match")
        return
    if main.date == secondary.date:
        rpt.ok("Frontmatter dates match")
    else:
        rpt.warn(
            "DATE MISMATCH",
            f"main: {main.date}, secondary: {secondary.date}",
            2,
            rpt.main,
        )


def _check_headings(main, secondary, rpt):
    check = "Section count and heading levels"
    if len(main.headings) != len(secondary.headings):
        rpt.bug(
            "HEADING COUNT MISMATCH",
            f"main has {len(main.headings)} heading(s), secondary has "
            f"{len(secondary.headings)}",
            secondary.headings[-1].line if secondary.headings else 1,
            rpt.secondary,
        )
        return
    mismatched = False
    for idx, (mh, sh) in enumerate(zip(main.headings, secondary.headings), start=1):
        if mh.level != sh.level:
            mismatched = True
            rpt.bug(
                "HEADING LEVEL MISMATCH",
                f"heading #{idx}: main '{mh.text}' is H{mh.level}, "
                f"secondary '{sh.text}' is H{sh.level}",
                sh.line,
                rpt.secondary,
            )
    if not mismatched:
        rpt.ok(check)


def _check_tables(main, secondary, rpt):
    check = "Table structure"
    ok = True
    if len(main.tables) != len(secondary.tables):
        ok = False
        # Point at the surplus side (the file that carries the unmatched table).
        if len(secondary.tables) > len(main.tables):
            line, file = secondary.tables[-1].line, rpt.secondary
        elif main.tables:
            line, file = main.tables[-1].line, rpt.main
        else:
            line, file = 1, rpt.secondary
        rpt.warn(
            "TABLE MISMATCH",
            f"main has {len(main.tables)} table(s), secondary has "
            f"{len(secondary.tables)}",
            line,
            file,
        )
    for idx, (mt, st) in enumerate(zip(main.tables, secondary.tables), start=1):
        if mt.columns != st.columns or mt.rows != st.rows:
            ok = False
            rpt.warn(
                "TABLE MISMATCH",
                f"table #{idx}: main {mt.columns}col x {mt.rows}row, "
                f"secondary {st.columns}col x {st.rows}row",
                st.line,
                rpt.secondary,
            )
    if ok:
        rpt.ok(check)


def _check_code_fences(main, secondary, rpt):
    check = "Code fences identical"
    if len(main.code_fences) != len(secondary.code_fences):
        rpt.bug(
            "CODE BLOCK MISMATCH",
            f"main has {len(main.code_fences)} code fence(s), secondary has "
            f"{len(secondary.code_fences)}",
            (secondary.code_fences[-1][1] if secondary.code_fences else 1),
            rpt.secondary,
        )
        return
    mismatched = False
    for idx, (mf, sf) in enumerate(zip(main.code_fences, secondary.code_fences), start=1):
        if mf[0] != sf[0]:
            mismatched = True
            rpt.bug(
                "CODE BLOCK MISMATCH",
                f"code fence #{idx} differs between main and secondary "
                "(contents must be byte-for-byte identical)",
                sf[1],
                rpt.secondary,
            )
    if not mismatched:
        rpt.ok(check)


def _check_count(check_name, flag, main_items, secondary_items, rpt):
    if len(main_items) == len(secondary_items):
        rpt.ok(check_name)
    else:
        # Point at the trailing element of whichever file has more, best-effort.
        line = 1
        file = rpt.secondary
        if len(secondary_items) > len(main_items) and secondary_items:
            line = secondary_items[-1][1]
        elif main_items:
            line = main_items[-1][1]
            file = rpt.main
        rpt.warn(
            flag,
            f"main has {len(main_items)}, secondary has {len(secondary_items)}",
            line,
            file,
        )


def _check_admonitions(main, secondary, rpt):
    check = "Admonition count and types"
    from collections import Counter

    mc = Counter(t for t, _ in main.admonitions)
    sc = Counter(t for t, _ in secondary.admonitions)
    if mc == sc:
        rpt.ok(check)
    else:
        rpt.warn(
            "ADMONITION MISMATCH",
            f"main {dict(sorted(mc.items()))}, secondary {dict(sorted(sc.items()))}",
            (secondary.admonitions[-1][1] if secondary.admonitions else 1),
            rpt.secondary,
        )


def _check_details(main, secondary, rpt):
    check = "<details> block count"
    if main.details_count == secondary.details_count:
        rpt.ok(check)
    else:
        rpt.warn(
            "DETAILS BLOCK COUNT MISMATCH",
            f"main has {main.details_count}, secondary has {secondary.details_count}",
            1,
            rpt.secondary,
        )


def _check_markers(main, secondary, rpt):
    _pair_markers("ToDo", main.todo_markers, secondary.todo_markers, rpt, "ToDo markers paired")
    _pair_markers(
        "NEEDS CONFIRMATION",
        main.needs_markers,
        secondary.needs_markers,
        rpt,
        "NEEDS CONFIRMATION markers paired",
    )


def _pair_markers(kind, main_markers, secondary_markers, rpt, check_name):
    """Pair markers of one kind by count. A count difference is a positional gap the
    skill must resolve; we can't match by structural position deterministically, so we
    flag the count drift and point at the surplus side."""
    if len(main_markers) == len(secondary_markers):
        rpt.ok(check_name)
        return
    if len(main_markers) > len(secondary_markers):
        surplus = main_markers[len(secondary_markers):]
        for mk in surplus:
            rpt.warn(
                "MARKER MISSING IN SECONDARY",
                f"{kind} marker present in main has no secondary counterpart: "
                f"'{_trunc(mk.text)}'",
                mk.line,
                rpt.main,
            )
    else:
        surplus = secondary_markers[len(main_markers):]
        for mk in surplus:
            rpt.warn(
                "MARKER MISSING IN MAIN",
                f"{kind} marker present in secondary has no main counterpart: "
                f"'{_trunc(mk.text)}'",
                mk.line,
                rpt.secondary,
            )


def _trunc(s, n=80):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


# --- CLI --------------------------------------------------------------------


def read_file(path_str: str) -> str:
    path = Path(path_str)
    if not path.exists():
        sys.stderr.write(f"align_check: file not found: {path_str}\n")
        sys.exit(2)
    if not path.is_file():
        sys.stderr.write(f"align_check: not a file: {path_str}\n")
        sys.exit(2)
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        # Fall back to a lenient decode rather than aborting on a stray byte.
        return path.read_text(encoding="utf-8", errors="replace")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministically compare the structure of two Markdown/MDX "
        "pages and emit an alignment-report JSON to stdout."
    )
    parser.add_argument("main_file", help="Path to the main (source-of-truth) file.")
    parser.add_argument("secondary_file", help="Path to the secondary file.")
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Emit single-line JSON instead of indented.",
    )
    args = parser.parse_args(argv)

    main_text = read_file(args.main_file)
    secondary_text = read_file(args.secondary_file)

    main_parsed = parse(main_text)
    secondary_parsed = parse(secondary_text)

    rpt = Report(args.main_file, args.secondary_file)
    compare(main_parsed, secondary_parsed, rpt)

    indent = None if args.compact else 2
    print(json.dumps(rpt.to_dict(), indent=indent, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
