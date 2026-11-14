import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Cuts the sound of a ticket's video into parts of at most a given length, for transcription: `ffprobe` reads the
// duration, `ffmpeg` writes each part. Both are found on the PATH and run through execFile with fixed arguments, never a
// shell; every file they get is an absolute, checked path: the video inside the ticket's work folder, the parts written
// only into that folder. They read local files only, and only the plain containers in FORMATS: a playlist or a list of
// files would make them read whatever it names. The parts are audio (AAC in .m4a): a re-encoded cut starts and ends
// exactly where it says, so a part is never longer than the limit and its start is the true offset of its transcript.

export class CliError extends Error {
  constructor(message, { code = 2, data = {} } = {}) {
    super(message);
    this.exitCode = code;
    this.data = data;
  }
}

export const PART_EXT = '.m4a';
// A remainder shorter than this gets no part of its own: nothing is said in it, and a part costs a transcription.
export const MIN_LAST_PART = 1;
// The containers a video may come in, by ffprobe's `format_name`, and the demuxer the cut is held to for each. No
// playlist (hls), list of files (concat), image sequence (image2) or anything else that opens other files.
export const FORMATS = { 'mov,mp4,m4a,3gp,3g2,mj2': 'mov', 'matroska,webm': 'matroska', mp3: 'mp3', wav: 'wav', ogg: 'ogg', flac: 'flac', aac: 'aac' };
const PLAIN = 'mp4, mov, m4a, mkv, webm, mp3, wav, ogg, flac or aac';
// The input options of both programs: the file protocol only, and those demuxers only, so that not even the probe
// opens what a playlist names.
export const INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', [...new Set(Object.values(FORMATS))].join(',')];

/** Runs a program with arguments, no shell. Resolves to { stdout, stderr }. */
export function runProgram(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** The parts of a sound `duration` seconds long, each at most `partSeconds`: [{ start, length }], in seconds. */
export function planParts(duration, partSeconds) {
  if (!(Number.isFinite(duration) && duration > 0)) throw new CliError(`the video's duration is not a positive number (${duration})`, { code: 1 });
  if (!(Number.isFinite(partSeconds) && partSeconds > 0)) throw new CliError(`the part length is not a positive number (${partSeconds})`);
  const parts = [];
  for (let start = 0; start < duration; start += partSeconds) {
    const length = Math.min(partSeconds, duration - start);
    if (parts.length && length < MIN_LAST_PART) break;
    parts.push({ start, length: round3(length) });
  }
  return parts;
}

const within = (parent, child) => child.startsWith(parent + path.sep);
const real = (p, what) => {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    throw new CliError(`${what} ${p} does not exist`);
  }
};

/**
 * The host root: the folder the script runs in (`cwd`, where a role session starts), never the file system's root. A
 * `--root` (`given`) is only a check: it must name that same folder.
 */
export function hostRoot(cwd, given) {
  const root = real(cwd, 'the working folder');
  if (path.parse(root).root === root) throw new CliError(`the host root can't be the file system's root (${root}): run it from the host repo`);
  if (given !== undefined) {
    let g = null;
    try {
      g = fs.realpathSync(path.resolve(root, given));
    } catch {
      // not that folder either
    }
    if (g !== root) throw new CliError(`--root ${given} is not the folder this runs in (${root}): run it from the host repo, the folder the session starts in`);
  }
  return root;
}

/**
 * The checked, real paths: the host root, the ticket's work folder inside it (not the root itself), the video file
 * inside the work folder, and the parts folder `<video file name>-parts/` next to the video (a folder or nothing; never a link), with
 * each of its `parts` (file names) a plain file or nothing, so that ffmpeg never writes through a link. The parts
 * folder takes the video's whole file name, so two videos never share one.
 */
export function checkPaths({ root, work, video, parts = [] }) {
  if (!work) throw new CliError('--work <folder> is required: the ticket\'s work folder');
  if (!video) throw new CliError('--video <file> is required: the video, inside the work folder');
  const rootReal = real(path.resolve(root), 'the host root');
  if (path.parse(rootReal).root === rootReal) throw new CliError(`the host root can't be the file system's root (${rootReal})`);
  const workReal = real(path.resolve(root, work), 'the work folder');
  if (!within(rootReal, workReal)) throw new CliError(`the work folder ${work} is not inside the host root ${rootReal}`);
  if (!fs.statSync(workReal).isDirectory()) throw new CliError(`the work folder ${work} is not a folder`);
  const videoReal = real(path.resolve(root, video), 'the video');
  if (!within(workReal, videoReal)) throw new CliError(`the video ${video} is not inside the work folder ${path.relative(rootReal, workReal)}`);
  if (!fs.statSync(videoReal).isFile()) throw new CliError(`the video ${video} is not a file`);
  const name = path.basename(videoReal);
  // Next to the video, so two videos of one name in two folders of the work folder never share one.
  const outDir = path.join(path.dirname(videoReal), `${name}-parts`);
  let st = null;
  try {
    st = fs.lstatSync(outDir);
  } catch {
    // made by the cut
  }
  if (st && !st.isDirectory()) throw new CliError(`${path.relative(rootReal, outDir)} exists and is not a folder (a link is refused too)`);
  for (const file of parts) {
    let f = null;
    try {
      f = fs.lstatSync(path.join(outDir, file));
    } catch {
      continue;
    }
    if (!f.isFile()) throw new CliError(`${path.relative(rootReal, path.join(outDir, file))} exists and is not a plain file (a link is refused too)`);
  }
  return { rootReal, workReal, videoReal, name, outDir };
}

/**
 * `{part}-transcript.txt` → the transcript's file name for a part. The pattern must hold `{part}` and give a plain file
 * name that doesn't start with `-`; it is checked on its own, so a video's name is never blamed on it.
 */
export function transcriptNameOf(pattern, partStem) {
  if (!pattern.includes('{part}')) throw new CliError(`--transcript-name must contain {part}: ${pattern}`);
  const sample = pattern.replaceAll('{part}', 'x');
  if (sample.includes('/') || sample.includes('\\') || sample.startsWith('-')) throw new CliError(`--transcript-name must give a plain file name: ${pattern}`);
  return pattern.replaceAll('{part}', partStem);
}

/** The duration (seconds), whether the video has sound, and its container (`format_name`), from ffprobe. */
export async function probe(run, videoReal, shown = videoReal) {
  let out;
  try {
    out = await run('ffprobe', ['-v', 'error', ...INPUT_GUARD, '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', videoReal]);
  } catch (e) {
    if (/not on whitelist/i.test(String(e.stderr ?? ''))) throw notPlain(shown, String(e.stderr).trim().split('\n')[0]);
    throw toolError('ffprobe', e);
  }
  let j;
  try {
    j = JSON.parse(out.stdout);
  } catch {
    throw new CliError('ffprobe gave no JSON', { code: 1 });
  }
  return { duration: Number(j.format?.duration), hasSound: (j.streams ?? []).some((s) => s.codec_type === 'audio'), format: j.format?.format_name ?? null };
}

const notPlain = (shown, why) => new CliError(`the video ${shown} is not a plain video or sound file (${PLAIN}): ${why}; a playlist or a list of other files is refused`, { code: 1 });

function toolError(name, e) {
  if (e.code === 'ENOENT') return new CliError(`${name} is not on the PATH: install it (macOS: brew install ffmpeg)`, { code: 1 });
  return new CliError(`${name} failed: ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`, { code: 1 });
}

/** The ffmpeg arguments of one part: its sound from `start` for `length` seconds, re-encoded to AAC, read with `demuxer`. */
export const cutArgs = (videoReal, { start, length }, outFile, demuxer) => ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...INPUT_GUARD, '-f', demuxer, '-ss', String(start), '-t', String(length), '-i', videoReal, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k', outFile];

/**
 * The whole run: checks the paths, reads the duration, plans the parts and (unless `dryRun`) cuts them. Gives back the
 * `videos[]` entry the `videoGate` record takes, with every path from the host root.
 */
export async function videoParts({ root, work, video, partSeconds, transcriptName = '{part}-transcript.txt', dryRun = false, run = runProgram }) {
  const p = checkPaths({ root, work, video });
  transcriptNameOf(transcriptName, 'x');
  const rel = (abs) => path.relative(p.rootReal, abs).split(path.sep).join('/');
  const { duration, hasSound, format } = await probe(run, p.videoReal, rel(p.videoReal));
  const demuxer = FORMATS[format];
  if (!demuxer) throw notPlain(rel(p.videoReal), `its format is ${format ?? 'unknown'}`);
  if (!hasSound) throw new CliError(`the video ${rel(p.videoReal)} has no sound: there is nothing to transcribe`, { code: 1 });
  const plan = planParts(duration, partSeconds);
  const width = Math.max(2, String(plan.length).length);
  const parts = plan.map((x, i) => {
    const partStem = `${p.name}-part-${String(i + 1).padStart(width, '0')}`;
    const abs = path.join(p.outDir, `${partStem}${PART_EXT}`);
    return { ...x, abs, file: rel(abs), transcriptFile: transcriptNameOf(transcriptName, partStem) };
  });
  const partFiles = new Set(parts.map((x) => path.basename(x.abs)));
  for (const x of parts) {
    if (partFiles.has(x.transcriptFile)) throw new CliError(`--transcript-name ${transcriptName} names a part's own file (${x.transcriptFile}) as a transcript: give the transcripts a name of their own`);
  }
  if (!dryRun) {
    checkPaths({ root, work, video, parts: [...partFiles] });
    fs.mkdirSync(p.outDir, { recursive: true });
    for (const part of parts) {
      try {
        await run('ffmpeg', cutArgs(p.videoReal, part, part.abs, demuxer));
      } catch (e) {
        throw toolError('ffmpeg', e);
      }
      if (!fs.existsSync(part.abs)) throw new CliError(`ffmpeg wrote no ${part.file}`, { code: 1 });
    }
  }
  return {
    dryRun,
    partSeconds,
    video: { file: rel(p.videoReal), duration: round3(duration), parts: parts.map(({ abs, file, start, length, transcriptFile }) => ({ file, start, length, transcript: rel(path.join(path.dirname(abs), transcriptFile)) })) },
  };
}
