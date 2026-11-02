#!/usr/bin/env python3
"""Run the sme-video-context tests. Offline: no ffmpeg, no tesseract, no network, no faster-whisper.

    python3 plugins/doc-writer-toolkit/scripts/sme-video-context/tests/run.py [-q]

The frame tests need the two image packages in tests/requirements.txt. If one is missing this exits
with code 2 and says how to install it, so a missing package is never taken for a pass.
"""

import importlib
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
NEEDED = {"PIL": "Pillow", "imagehash": "ImageHash"}


def main(argv) -> int:
    missing = []
    for module, package in NEEDED.items():
        try:
            importlib.import_module(module)
        except ImportError:
            missing.append(package)
    if missing:
        print(
            "Use the skill's venv (see README.md, Prerequisites) or install the test packages:\n"
            "  VENV=~/.cache/doc-writer-toolkit/sme-video-venv; [ -d \"$VENV\" ] || python3 -m venv \"$VENV\"\n"
            f"  \"$VENV/bin/pip\" install -r {HERE / 'requirements.txt'}\n"
            f"then run: \"$VENV/bin/python\" {Path(__file__).resolve()}\n"
            f"sme-video-context tests not run: missing Python package(s): {', '.join(missing)}.",
            file=sys.stderr,
        )
        return 2
    suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_*.py")
    if suite.countTestCases() == 0:
        print("sme-video-context tests: no tests found", file=sys.stderr)
        return 1
    verbosity = 1 if "-q" in argv else 2
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
