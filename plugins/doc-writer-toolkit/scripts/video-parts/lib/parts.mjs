import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Cuts the sound of a ticket's video into parts of at most a given length, for transcription: `ffprobe` reads the
// duration, `ffmpeg` writes each part. Both run through execFile with fixed arguments, never a shell, and every path
// they get is absolute and checked: the video inside the ticket's work folder, the parts written only into that
// folder. The parts are audio (AAC in .m4a): a re-encoded cut starts and ends exactly where it says, so a part is never
// longer than the limit and its start is the true offset of its transcript; the frames come from the whole video.

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
 * The checked, real paths: the host root, the ticket's work folder inside it (not the root itself), the video file
 * inside the work folder, and the parts folder `<work>/<video name>-parts/` (a folder or nothing; never a link), with
 * each of its `parts` (file names) a plain file or nothing, so that ffmpeg never writes through a link.
 */
export function checkPaths({ root, work, video, parts = [] }) {
  if (!work) throw new CliError('--work <folder> is required: the ticket\'s work folder');
  if (!video) throw new CliError('--video <file> is required: the video, inside the work folder');
  const rootReal = real(path.resolve(root), 'the host root');
  const workReal = real(path.resolve(root, work), 'the work folder');
  if (!within(rootReal, workReal)) throw new CliError(`the work folder ${work} is not inside the host root ${rootReal}`);
  if (!fs.statSync(workReal).isDirectory()) throw new CliError(`the work folder ${work} is not a folder`);
  const videoReal = real(path.resolve(root, video), 'the video');
  if (!within(workReal, videoReal)) throw new CliError(`the video ${video} is not inside the work folder ${path.relative(rootReal, workReal)}`);
  if (!fs.statSync(videoReal).isFile()) throw new CliError(`the video ${video} is not a file`);
  const stem = path.basename(videoReal, path.extname(videoReal));
  const outDir = path.join(workReal, `${stem}-parts`);
  let st = null;
  try {
    st = fs.lstatSync(outDir);
  } catch {
    // made by the cut
  }
  if (st && !st.isDirectory()) throw new CliError(`${path.relative(rootReal, outDir)} exists and is not a folder (a link is refused too)`);
  for (const name of parts) {
    let f = null;
    try {
      f = fs.lstatSync(path.join(outDir, name));
    } catch {
      continue;
    }
    if (!f.isFile()) throw new CliError(`${path.relative(rootReal, path.join(outDir, name))} exists and is not a plain file (a link is refused too)`);
  }
  return { rootReal, workReal, videoReal, stem, outDir };
}

/** `{part}-transcript.txt` → the transcript's file name for a part; a plain file name, with `{part}` in it. */
export function transcriptNameOf(pattern, partStem) {
  if (!pattern.includes('{part}')) throw new CliError(`--transcript-name must contain {part}: ${pattern}`);
  const name = pattern.replaceAll('{part}', partStem);
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.startsWith('-')) throw new CliError(`--transcript-name must give a plain file name: ${pattern}`);
  return name;
}

/** The duration (seconds) and whether the video has sound, from ffprobe. */
export async function probe(run, videoReal) {
  let out;
  try {
    out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', videoReal]);
  } catch (e) {
    throw toolError('ffprobe', e);
  }
  let j;
  try {
    j = JSON.parse(out.stdout);
  } catch {
    throw new CliError('ffprobe gave no JSON', { code: 1 });
  }
  return { duration: Number(j.format?.duration), hasSound: (j.streams ?? []).some((s) => s.codec_type === 'audio') };
}

function toolError(name, e) {
  if (e.code === 'ENOENT') return new CliError(`${name} is not on the PATH: install it (macOS: brew install ffmpeg)`, { code: 1 });
  return new CliError(`${name} failed: ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`, { code: 1 });
}

/** The ffmpeg arguments of one part: its sound from `start` for `length` seconds, re-encoded to AAC. */
export const cutArgs = (videoReal, { start, length }, outFile) => ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(length), '-i', videoReal, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k', outFile];

/**
 * The whole run: checks the paths, reads the duration, plans the parts and (unless `dryRun`) cuts them. Gives back the
 * `videos[]` entry the `videoGate` record takes, with every path from the host root.
 */
export async function videoParts({ root, work, video, partSeconds, transcriptName = '{part}-transcript.txt', dryRun = false, run = runProgram }) {
  const p = checkPaths({ root, work, video });
  transcriptNameOf(transcriptName, 'x');
  const rel = (abs) => path.relative(p.rootReal, abs).split(path.sep).join('/');
  const { duration, hasSound } = await probe(run, p.videoReal);
  if (!hasSound) throw new CliError(`the video ${rel(p.videoReal)} has no sound: there is nothing to transcribe`, { code: 1 });
  const plan = planParts(duration, partSeconds);
  const width = Math.max(2, String(plan.length).length);
  const parts = plan.map((x, i) => {
    const partStem = `${p.stem}-part-${String(i + 1).padStart(width, '0')}`;
    const abs = path.join(p.outDir, `${partStem}${PART_EXT}`);
    return { ...x, abs, file: rel(abs), transcript: rel(path.join(p.outDir, transcriptNameOf(transcriptName, partStem))) };
  });
  if (!dryRun) {
    checkPaths({ root, work, video, parts: parts.map((x) => path.basename(x.abs)) });
    fs.mkdirSync(p.outDir, { recursive: true });
    for (const part of parts) {
      try {
        await run('ffmpeg', cutArgs(p.videoReal, part, part.abs));
      } catch (e) {
        throw toolError('ffmpeg', e);
      }
      if (!fs.existsSync(part.abs)) throw new CliError(`ffmpeg wrote no ${part.file}`, { code: 1 });
    }
  }
  return {
    dryRun,
    partSeconds,
    video: { file: rel(p.videoReal), duration: round3(duration), parts: parts.map(({ file, start, length, transcript }) => ({ file, start, length, transcript })) },
  };
}
