"""Shared setup for the sme-video-context tests: loads the script as a module, no ffmpeg, no tesseract."""

import contextlib
import io
import sys
from pathlib import Path

# Keep __pycache__ out of the plugin folder.
sys.dont_write_bytecode = True

SCRIPT_DIR = Path(__file__).resolve().parent.parent
SCRIPT = SCRIPT_DIR / "sme_video_context.py"
sys.path.insert(0, str(SCRIPT_DIR))

import sme_video_context as svc  # noqa: E402

TURBOSCRIBE_SAMPLE = """\
(0:05 - 0:10)
Дивись, там кнопка
для оплати.

(0:10 - 0:25)
Нічого особливого тут не відбувається.

(Transcribed by TurboScribe. Go Unlimited to remove this message.)
"""


def write_fake_jpg(path: Path, payload: bytes = b"fake-jpeg") -> Path:
    """A file with the right name. The folder logic only reads names, never pixels."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


@contextlib.contextmanager
def captured():
    """Capture stdout and stderr of the code under test."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


class FakeClock:
    """Stands in for time.monotonic, so the progress tests never sleep."""

    def __init__(self, now: float = 0.0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds
