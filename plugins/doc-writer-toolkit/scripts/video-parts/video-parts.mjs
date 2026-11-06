#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError, hostRoot, videoParts } from './lib/parts.mjs';
import { loadSettings } from '../ticket-state/lib/settings.mjs';

const USAGE = `video-parts --work <folder> --video <file> [options]

Cuts the sound of a ticket's video into parts of at most the ticket flow settings' video.partMinutes minutes, for the
video gate: <video file name>-parts/<video file name>-part-01.m4a, -02, … (AAC), next to the video. ffprobe and ffmpeg,
found on the PATH, run with fixed arguments, never through a shell, on local files only. The host root is the folder
it runs in; the work folder must be inside it, the video inside the work folder and a plain video or sound file (mp4,
mov, m4a, mkv, webm, mp3, wav, ogg, flac, aac; no playlist). Nothing is written outside the work folder.
Prints the videos[] entry of the videoGate record: the video and each part's file, start and length (seconds) and
transcript, every path from the host root.

Options
  --root <dir>              the host repo: only the folder it runs in, which is the default (a check)
  --settings <file>         the ticket flow settings file (default: as ticket-state finds it)
  --work <folder>           the ticket's work folder, from the host root (the host's rules name it)
  --video <file>            the video, from the host root, inside the work folder
  --transcript-name <name>  each part's transcript file name, with {part} for the part's name
                            (default: {part}-transcript.txt), next to the part
  --dry-run                 reads the duration and prints the parts; cuts nothing
  -h, --help                this text

Exit codes: 0 done · 1 ffprobe or ffmpeg missing or failed, a video with no sound, or not a plain video or sound file ·
2 bad usage, a --root other than the folder it runs in, or a path outside the work folder or the host root (nothing
run, nothing written).
`;

const OPTIONS = {
  root: { type: 'string' },
  settings: { type: 'string' },
  work: { type: 'string' },
  video: { type: 'string' },
  'transcript-name': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// `io.run` replaces the program runner in tests, `io.cwd` the folder it runs in.
export async function main(argv, io = {}) {
  const { stdout = process.stdout } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (positionals.length) throw new CliError(`unexpected argument '${positionals[0]}'.\n\n${USAGE}`);
  // The host root is the folder it runs in, where a role session starts: a --root elsewhere is refused, so the parts
  // land in the host's work folder and the record's paths name them.
  const root = hostRoot(io.cwd ?? process.cwd(), values.root);
  const settings = await loadSettings({ root, settings: values.settings });
  const result = await videoParts({
    root,
    work: values.work,
    video: values.video,
    partSeconds: settings.video.partMinutes * 60,
    transcriptName: values['transcript-name'] ?? '{part}-transcript.txt',
    dryRun: Boolean(values['dry-run']),
    ...(io.run ? { run: io.run } : {}),
  });
  stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      const code = e?.exitCode ?? (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 2 : 1);
      console.error(`video-parts: ${e.message}`);
      process.stdout.write(JSON.stringify({ ok: false, error: String(e.message).split('\n\n')[0] }, null, 2) + '\n');
      process.exitCode = code;
    },
  );
}
