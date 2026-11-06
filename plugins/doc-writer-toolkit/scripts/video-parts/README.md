# video-parts

Cuts the sound of a ticket's video into parts of at most the ticket flow's `video.partMinutes` minutes, for the video gate (the writer role's `videoGate` stage), and prints the `videos[]` entry that stage records. Node, no dependencies; `ffprobe` and `ffmpeg` on the PATH (macOS: `brew install ffmpeg`). No AI.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/video-parts/video-parts.mjs --work <folder> --video <file> [--transcript-name <name>] [--dry-run] [--root <dir>] [--settings <file>]
```

Run it from the host repo (or pass `--root`). It reads `video.partMinutes` from the ticket flow settings, found as `ticket-state` finds them (`--settings`, else the `Ticket flow settings:` field of the host's `CLAUDE.md`, else `.claude/ticket-flow.json`; the local file merged over it). Tests: `npm test` in this folder.

## What it does

1. Checks the paths, on their real paths (links resolved): the work folder (`--work`, the ticket's folder the host's rules name, such as `docs/.sources/tickets/<key>/`) is inside the host root and is not the root; the video (`--video`) is a file inside the work folder; the parts folder `<work>/<video name>-parts/` is a folder or doesn't exist yet, never a link, and no part file in it is a link. Anything else stops it before anything runs (exit 2).
2. Reads the duration and the streams with `ffprobe`. A video with no sound stops it (exit 1): there is nothing to transcribe.
3. Plans the parts: from 0, each `video.partMinutes` × 60 seconds, the last one shorter. A remainder under a second gets no part of its own.
4. Cuts each part with `ffmpeg`: the first sound stream from its start for its length, re-encoded to AAC (96 kb/s), into `<work>/<video name>-parts/<video name>-part-01.m4a`, `-02`, and so on. A part that is already there is replaced. `--dry-run` cuts nothing.

Both programs run through `execFile` with fixed arguments, never through a shell, and get only absolute paths. No flag names a program or adds an argument to them.

**Why sound, not video.** A cut that keeps the video unencoded can only start at a key frame, so a part would start up to a few seconds early and could run past the limit. The re-encoded sound starts and ends where it says: a part is never longer than `video.partMinutes`, and its `start` is the exact offset of its transcript in the video. The transcription needs only the sound, and the frames come from the whole video, which stays where it is.

## Output

```json
{
  "ok": true,
  "dryRun": false,
  "partSeconds": 1800,
  "video": {
    "file": "docs/.sources/tickets/501/call.mp4",
    "duration": 3725.4,
    "parts": [
      { "file": "docs/.sources/tickets/501/call-parts/call-part-01.m4a", "start": 0, "length": 1800, "transcript": "docs/.sources/tickets/501/call-parts/call-part-01-transcript.txt" },
      { "file": "docs/.sources/tickets/501/call-parts/call-part-02.m4a", "start": 1800, "length": 1800, "transcript": "docs/.sources/tickets/501/call-parts/call-part-02-transcript.txt" },
      { "file": "docs/.sources/tickets/501/call-parts/call-part-03.m4a", "start": 3600, "length": 125.4, "transcript": "docs/.sources/tickets/501/call-parts/call-part-03-transcript.txt" }
    ]
  }
}
```

`video` goes into the `videoGate` record as it is: `--result '{"videos": [<video>], "gateComment": "…"}'`. Every path is from the host root. `start` and `length` are seconds. `transcript` is where the transcript of that part is expected (the run takes it as arrived once the file exists): next to the part, named by `--transcript-name` with `{part}` for the part's name (default `{part}-transcript.txt`; a host whose transcripts come from a service with its own suffix names it, such as `{part}-transcript-<service>.txt`). The record adds the video and its parts to the ticket's work files itself, so the close step removes them after the merge.

On an error: `{"ok": false, "error": …}` on stdout, the message on stderr.

## Exit codes

`0` done · `1` `ffprobe` or `ffmpeg` missing or failed, or a video with no sound · `2` bad usage, a missing option, or a path outside the work folder or the host root (nothing run, nothing written).

## Where the video comes from

The writer downloads it into the work folder with the tracker script, at `start` or at the gate: `tracker.mjs download-attachment <card> --attachment <id|name> --out <work>/<file>`. That saves an uploaded attachment only. A video that is only a link (a link attachment, or a URL in the card's text) is not downloaded by any script, and this one doesn't download either.

## Files

| | |
|---|---|
| `video-parts.mjs` | The CLI. |
| `lib/parts.mjs` | The path checks, the plan, the `ffprobe` and `ffmpeg` calls. |
| `test/` | The tests: a recording fake and stand-in programs on the PATH; a real 5-second video where `ffmpeg` is installed (skipped otherwise). |
