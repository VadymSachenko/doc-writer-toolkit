import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPaths, cutArgs, planParts, transcriptNameOf, videoParts } from '../lib/parts.mjs';
import { card, rawSettings } from '../../ticket-state/test/fakes.mjs';
import { ledger, read, world } from '../../ticket-state/test/helpers.mjs';
import { runRecord } from '../../ticket-state/lib/record.mjs';

// Offline. ffprobe and ffmpeg are a recording fake (in-process) or stand-in scripts on the PATH (the CLI); the cut of
// a real tiny video runs only where ffmpeg is installed, and is skipped otherwise.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'video-parts.mjs');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-parts-')));

// A host root with a ticket's work folder and a (fake) video in it.
function host({ partMinutes = 30, video = 'call.mp4' } = {}) {
  const root = tmp();
  const work = path.join(root, 'docs', '.sources', 'tickets', '501');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, video), 'not really a video');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.json'), JSON.stringify(rawSettings({ video: { partMinutes } })));
  return { root, work: 'docs/.sources/tickets/501', video: `docs/.sources/tickets/501/${video}` };
}

// A fake runner: ffprobe says `duration` and whether there is sound; ffmpeg writes its output file.
function fakeRun({ duration = 3725.4, sound = true, fail = null } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (fail?.[file]) {
      const e = new Error(fail[file] === 'ENOENT' ? `spawn ${file} ENOENT` : 'exit 1');
      if (fail[file] === 'ENOENT') e.code = 'ENOENT';
      else e.stderr = fail[file];
      throw e;
    }
    if (file === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, ...(sound ? [{ codec_type: 'audio' }] : [])], format: { duration: String(duration) } }), stderr: '' };
    fs.writeFileSync(args.at(-1), 'part');
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('the plan: parts of the limit from 0, the last shorter; a remainder under a second gets no part', () => {
  assert.deepEqual(planParts(3725.4, 1800), [{ start: 0, length: 1800 }, { start: 1800, length: 1800 }, { start: 3600, length: 125.4 }]);
  assert.deepEqual(planParts(3600, 1800), [{ start: 0, length: 1800 }, { start: 1800, length: 1800 }]);
  assert.deepEqual(planParts(3600.6, 1800).length, 2);
  assert.deepEqual(planParts(0.4, 1800), [{ start: 0, length: 0.4 }], 'a video shorter than a second is still one part');
  assert.deepEqual(planParts(600, 1800), [{ start: 0, length: 600 }]);
  assert.throws(() => planParts(NaN, 1800), /duration is not a positive number/);
  assert.throws(() => planParts(100, 0), /part length/);
});

test('the cut: sound from the start for the length, re-encoded, every path absolute, no shell', async () => {
  const h = host();
  const f = fakeRun();
  const out = await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, run: f.run });
  const abs = path.join(h.root, h.video);
  const dir = path.join(h.root, h.work, 'call-parts');
  assert.deepEqual(f.calls[0], ['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', abs]);
  assert.deepEqual(f.calls.slice(1), [0, 1800, 3600].map((start, i) => ['ffmpeg', ...cutArgs(abs, { start, length: [1800, 1800, 125.4][i] }, path.join(dir, `call-part-0${i + 1}.m4a`))]));
  assert.deepEqual(f.calls[2], ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', '1800', '-t', '1800', '-i', abs, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k', path.join(dir, 'call-part-02.m4a')]);
  assert.deepEqual(out.video, {
    file: h.video,
    duration: 3725.4,
    parts: [
      { file: `${h.work}/call-parts/call-part-01.m4a`, start: 0, length: 1800, transcript: `${h.work}/call-parts/call-part-01-transcript.txt` },
      { file: `${h.work}/call-parts/call-part-02.m4a`, start: 1800, length: 1800, transcript: `${h.work}/call-parts/call-part-02-transcript.txt` },
      { file: `${h.work}/call-parts/call-part-03.m4a`, start: 3600, length: 125.4, transcript: `${h.work}/call-parts/call-part-03-transcript.txt` },
    ],
  });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['call-part-01.m4a', 'call-part-02.m4a', 'call-part-03.m4a']);
});

test('a dry run reads the duration and cuts nothing; the transcript name follows the host pattern', async () => {
  const h = host();
  const f = fakeRun({ duration: 900 });
  const out = await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, transcriptName: '{part}-transcript-service.txt', dryRun: true, run: f.run });
  assert.deepEqual(f.calls.map((c) => c[0]), ['ffprobe']);
  assert.equal(fs.existsSync(path.join(h.root, h.work, 'call-parts')), false);
  assert.equal(out.video.parts[0].transcript, `${h.work}/call-parts/call-part-01-transcript-service.txt`);
  assert.throws(() => transcriptNameOf('transcript.txt', 'p'), /must contain \{part\}/);
  assert.throws(() => transcriptNameOf('../{part}.txt', 'p'), /plain file name/);
});

test('paths: the work folder inside the root (not the root), the video inside the work folder, no link out', () => {
  const h = host();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'v.mp4'), 'x');
  fs.mkdirSync(path.join(h.root, 'docs', 'other'), { recursive: true });
  fs.writeFileSync(path.join(h.root, 'docs', 'other', 'v.mp4'), 'x');
  const refused = (args, re) => assert.throws(() => checkPaths({ root: h.root, ...args }), (e) => e.exitCode === 2 && re.test(e.message));
  refused({ work: outside, video: path.join(outside, 'v.mp4') }, /not inside the host root/);
  refused({ work: '.', video: h.video }, /not inside the host root/);
  refused({ work: h.work, video: 'docs/other/v.mp4' }, /not inside the work folder/);
  refused({ work: h.work, video: `${h.work}/../../../other/v.mp4` }, /not inside the work folder/);
  refused({ work: h.work, video: `${h.work}/missing.mp4` }, /does not exist/);
  refused({ work: h.video, video: h.video }, /not a folder/);
  refused({ work: h.work }, /--video <file> is required/);
  fs.symlinkSync(path.join(outside, 'v.mp4'), path.join(h.root, h.work, 'linked.mp4'));
  refused({ work: h.work, video: `${h.work}/linked.mp4` }, /not inside the work folder/);
  fs.symlinkSync(outside, path.join(h.root, h.work, 'call-parts'));
  refused({ work: h.work, video: h.video }, /call-parts exists and is not a folder/);
  fs.unlinkSync(path.join(h.root, h.work, 'call-parts'));
  fs.mkdirSync(path.join(h.root, h.work, 'call-parts'));
  fs.symlinkSync(path.join(outside, 'v.mp4'), path.join(h.root, h.work, 'call-parts', 'call-part-01.m4a'));
  refused({ work: h.work, video: h.video, parts: ['call-part-01.m4a'] }, /call-part-01\.m4a exists and is not a plain file/);
});

test('no sound, no ffmpeg, a failed cut: exit 1 with the reason', async () => {
  const h = host();
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: fakeRun({ sound: false }).run }), (e) => e.exitCode === 1 && /has no sound/.test(e.message));
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: fakeRun({ fail: { ffprobe: 'ENOENT' } }).run }), (e) => e.exitCode === 1 && /ffprobe is not on the PATH/.test(e.message));
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: fakeRun({ fail: { ffmpeg: 'Invalid data found when processing input' } }).run }), (e) => e.exitCode === 1 && /ffmpeg failed: Invalid data/.test(e.message));
});

test('the videoGate record takes the output as it is', async () => {
  const c = card({ number: 501, status: 'inProgress' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  const work = 'docs/.sources/tickets/501';
  fs.mkdirSync(path.join(w.root, work), { recursive: true });
  fs.writeFileSync(path.join(w.root, work, 'call.mp4'), 'x');
  const { video } = await videoParts({ root: w.root, work, video: `${work}/call.mp4`, partSeconds: 1800, run: fakeRun().run });
  await runRecord({ settings: w.settings, clients: w.clients(), key: '501', stage: 'videoGate', status: 'done', result: JSON.stringify({ videos: [video], gateComment: 'Blocked: the video' }) });
  const l = read(w, '501');
  assert.deepEqual(l.video.videos[0].parts.map((p) => [p.file, p.start, p.transcript]), video.parts.map((p) => [p.file, p.start, p.transcript]));
  assert.deepEqual(l.files.map((f) => f.kind), ['video', 'videoPart', 'videoPart', 'videoPart']);
  const t = await w.one('501');
  assert.equal(t.state, 'videoGate');
  assert.match(t.gate.why, /transcripts of 3 video part\(s\)/);
});

// ------------------------------------------------------------------ the CLI, with stand-in programs on the PATH

function standIns() {
  const bin = tmp();
  const log = path.join(bin, 'calls.jsonl');
  const node = process.execPath;
  fs.writeFileSync(path.join(bin, 'ffprobe'), `#!${node}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['ffprobe', ...process.argv.slice(2)]) + '\\n');\nprocess.stdout.write(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '150' } }));\n`);
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!${node}\nconst a = process.argv.slice(2);\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['ffmpeg', ...a]) + '\\n');\nrequire('fs').writeFileSync(a[a.length - 1], 'part');\n`);
  for (const f of ['ffprobe', 'ffmpeg']) fs.chmodSync(path.join(bin, f), 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

const cli = (args, bin) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  })() };
};

test('the CLI: the part length from video.partMinutes, the record entry on stdout', () => {
  const h = host({ partMinutes: 1 });
  const s = standIns();
  const r = cli(['--root', h.root, '--work', h.work, '--video', h.video, '--transcript-name', '{part}-transcript-service.txt'], s.bin);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.partSeconds, 60);
  assert.deepEqual(r.json.video.parts.map((p) => [p.start, p.length]), [[0, 60], [60, 60], [120, 30]]);
  assert.equal(r.json.video.parts[2].transcript, `${h.work}/call-parts/call-part-03-transcript-service.txt`);
  const calls = s.calls();
  assert.deepEqual(calls.map((c) => c[0]), ['ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg']);
  assert.deepEqual(calls[3].slice(6, 10), ['-ss', '120', '-t', '30']);
});

test('the CLI: a path outside the work folder or the root writes nothing and runs nothing (exit 2)', () => {
  const h = host();
  const s = standIns();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'v.mp4'), 'x');
  for (const args of [['--work', outside, '--video', path.join(outside, 'v.mp4')], ['--work', h.work, '--video', path.join(outside, 'v.mp4')], ['--work', h.work], ['--work', h.work, '--video', h.video, 'extra']]) {
    const r = cli(['--root', h.root, ...args], s.bin);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.equal(r.json.ok, false);
  }
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(fs.readdirSync(path.join(h.root, h.work)), ['call.mp4']);
  assert.equal(cli(['--root', h.root, '--work', h.work, '--video', h.video, '--ffmpeg', '/bin/sh'], s.bin).code, 2, 'no flag names a program');
});

// ------------------------------------------------------------------ a real tiny video, where ffmpeg is installed

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const lengthOf = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim());

test('a real 5-second video with sound: parts of 2, 2 and 1 seconds, written only into the work folder', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const h = host();
  const video = path.join(h.root, h.video);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '5', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', video]);
  const before = fs.readdirSync(h.root, { recursive: true }).sort();
  const out = await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 2 });
  assert.deepEqual(out.video.parts.map((p) => [p.start, p.length]), [[0, 2], [2, 2], [4, 1]]);
  for (const p of out.video.parts) assert.ok(Math.abs(lengthOf(path.join(h.root, p.file)) - p.length) < 0.15, `${p.file} lasts about ${p.length} s`);
  const added = fs.readdirSync(h.root, { recursive: true }).sort().filter((f) => !before.includes(f));
  assert.deepEqual(added, ['docs/.sources/tickets/501/call-parts', ...out.video.parts.map((p) => p.file)].sort());
});

test('a real video with no sound is refused', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const h = host();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-t', '2', '-c:v', 'mpeg4', path.join(h.root, h.video)]);
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1 }), /has no sound/);
});
