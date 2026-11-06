import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPaths, cutArgs, INPUT_GUARD, planParts, transcriptNameOf, videoParts } from '../lib/parts.mjs';
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

// A fake runner: ffprobe says `duration`, whether there is sound and the container; ffmpeg writes its output file
// (unless `writes` is false).
const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
function fakeRun({ duration = 3725.4, sound = true, format = MP4, writes = true, fail = null } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (fail?.[file]) {
      const e = new Error(fail[file] === 'ENOENT' ? `spawn ${file} ENOENT` : 'exit 1');
      if (fail[file] === 'ENOENT') e.code = 'ENOENT';
      else e.stderr = fail[file];
      throw e;
    }
    if (file === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, ...(sound ? [{ codec_type: 'audio' }] : [])], format: { format_name: format, duration: String(duration) } }), stderr: '' };
    if (writes) fs.writeFileSync(args.at(-1), 'part');
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

test('the cut: sound from the start for the length, re-encoded, local files and plain containers only, file arguments absolute, no shell', async () => {
  const h = host();
  const f = fakeRun();
  const out = await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, run: f.run });
  const abs = path.join(h.root, h.video);
  const dir = path.join(h.root, h.work, 'call.mp4-parts');
  const guard = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,mp3,wav,ogg,flac,aac'];
  assert.deepEqual(INPUT_GUARD, guard);
  assert.deepEqual(f.calls[0], ['ffprobe', '-v', 'error', ...guard, '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', abs]);
  assert.deepEqual(f.calls.slice(1), [0, 1800, 3600].map((start, i) => ['ffmpeg', ...cutArgs(abs, { start, length: [1800, 1800, 125.4][i] }, path.join(dir, `call.mp4-part-0${i + 1}.m4a`), 'mov')]));
  assert.deepEqual(f.calls[2], ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...guard, '-f', 'mov', '-ss', '1800', '-t', '1800', '-i', abs, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k', path.join(dir, 'call.mp4-part-02.m4a')]);
  const d = `${h.work}/call.mp4-parts`;
  assert.deepEqual(out.video, {
    file: h.video,
    duration: 3725.4,
    parts: [
      { file: `${d}/call.mp4-part-01.m4a`, start: 0, length: 1800, transcript: `${d}/call.mp4-part-01-transcript.txt` },
      { file: `${d}/call.mp4-part-02.m4a`, start: 1800, length: 1800, transcript: `${d}/call.mp4-part-02-transcript.txt` },
      { file: `${d}/call.mp4-part-03.m4a`, start: 3600, length: 125.4, transcript: `${d}/call.mp4-part-03-transcript.txt` },
    ],
  });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['call.mp4-part-01.m4a', 'call.mp4-part-02.m4a', 'call.mp4-part-03.m4a']);
  // Each plain container is cut with its own demuxer.
  for (const [format, demuxer] of [['matroska,webm', 'matroska'], ['mp3', 'mp3'], ['wav', 'wav']]) {
    const g = fakeRun({ duration: 10, format });
    await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, dryRun: false, run: g.run });
    assert.deepEqual(g.calls[1].slice(g.calls[1].indexOf('-f'), g.calls[1].indexOf('-f') + 2), ['-f', demuxer], format);
  }
});

test('a dry run reads the duration and cuts nothing; the transcript name follows the host pattern', async () => {
  const h = host();
  const f = fakeRun({ duration: 900 });
  const out = await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, transcriptName: '{part}-transcript-service.txt', dryRun: true, run: f.run });
  assert.deepEqual(f.calls.map((c) => c[0]), ['ffprobe']);
  assert.equal(fs.existsSync(path.join(h.root, h.work, 'call.mp4-parts')), false);
  assert.equal(out.video.parts[0].transcript, `${h.work}/call.mp4-parts/call.mp4-part-01-transcript-service.txt`);
  assert.throws(() => transcriptNameOf('transcript.txt', 'p'), /must contain \{part\}/);
  for (const bad of ['../{part}.txt', 'a/{part}.txt', '{part}\\x.txt', '-{part}.txt', '--{part}']) assert.throws(() => transcriptNameOf(bad, 'p'), (e) => e.exitCode === 2 && /plain file name/.test(e.message), bad);
  // A video whose name starts with a dash is not the pattern's fault: its parts and transcripts go by its name.
  assert.equal(transcriptNameOf('{part}-transcript.txt', '-x.mp4-part-01'), '-x.mp4-part-01-transcript.txt');
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
  fs.mkdirSync(path.join(h.root, h.work, 'folder.mp4'));
  refused({ work: h.work, video: `${h.work}/folder.mp4` }, /video .*folder\.mp4 is not a file/);
  assert.throws(() => checkPaths({ root: '/', work: path.join(h.root, h.work), video: path.join(h.root, h.video) }), (e) => e.exitCode === 2 && /file system's root/.test(e.message));
  refused({ work: h.work }, /--video <file> is required/);
  fs.symlinkSync(path.join(outside, 'v.mp4'), path.join(h.root, h.work, 'linked.mp4'));
  refused({ work: h.work, video: `${h.work}/linked.mp4` }, /not inside the work folder/);
  fs.symlinkSync(outside, path.join(h.root, h.work, 'call.mp4-parts'));
  refused({ work: h.work, video: h.video }, /call\.mp4-parts exists and is not a folder/);
  fs.unlinkSync(path.join(h.root, h.work, 'call.mp4-parts'));
  fs.mkdirSync(path.join(h.root, h.work, 'call.mp4-parts'));
  fs.symlinkSync(path.join(outside, 'v.mp4'), path.join(h.root, h.work, 'call.mp4-parts', 'call.mp4-part-01.m4a'));
  refused({ work: h.work, video: h.video, parts: ['call.mp4-part-01.m4a'] }, /call\.mp4-part-01\.m4a exists and is not a plain file/);
});

test('no sound, no ffmpeg, a failed cut: exit 1 with the reason', async () => {
  const h = host();
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: fakeRun({ sound: false }).run }), (e) => e.exitCode === 1 && /has no sound/.test(e.message));
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: fakeRun({ fail: { ffprobe: 'ENOENT' } }).run }), (e) => e.exitCode === 1 && /ffprobe is not on the PATH/.test(e.message));
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: fakeRun({ fail: { ffmpeg: 'Invalid data found when processing input' } }).run }), (e) => e.exitCode === 1 && /ffmpeg failed: Invalid data/.test(e.message));
});

test('a playlist, a list of files or any other container is refused before a cut: ffprobe is held to plain ones', async () => {
  const h = host();
  // The probe itself refuses (the format whitelist): a playlist names no file that is opened.
  const whitelist = fakeRun({ fail: { ffprobe: "[hls @ 0x1] Format not on whitelist 'mov,matroska,mp3,wav,ogg,flac,aac'\n/x/p.m3u8: Invalid argument" } });
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: whitelist.run }), (e) => e.exitCode === 1 && /is not a plain video or sound file .*Format not on whitelist.*a playlist or a list of other files is refused/.test(e.message));
  // A container the probe let through but the list doesn't hold (or no format at all): refused too, nothing cut.
  for (const format of ['hls', 'concat', 'image2', 'mpegts', null]) {
    const f = fakeRun({ format });
    await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 60, run: f.run }), (e) => e.exitCode === 1 && /not a plain video or sound file/.test(e.message), String(format));
    assert.deepEqual(f.calls.map((c) => c[0]), ['ffprobe'], String(format));
  }
  assert.deepEqual(fs.readdirSync(path.join(h.root, h.work)), ['call.mp4']);
});

test('the transcript name: a bad pattern runs nothing; a name equal to a part\'s own file is refused before any cut', async () => {
  const h = host();
  for (const bad of ['transcript.txt', '-{part}.txt', '../{part}.txt']) {
    const f = fakeRun();
    await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, transcriptName: bad, run: f.run }), (e) => e.exitCode === 2, bad);
    assert.deepEqual(f.calls, [], `${bad}: not even ffprobe`);
  }
  for (const dryRun of [true, false]) {
    const f = fakeRun();
    await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, transcriptName: '{part}.m4a', dryRun, run: f.run }), (e) => e.exitCode === 2 && /names a part's own file \(call\.mp4-part-01\.m4a\) as a transcript/.test(e.message));
    assert.deepEqual(f.calls.map((c) => c[0]), ['ffprobe']);
  }
  assert.deepEqual(fs.readdirSync(path.join(h.root, h.work)), ['call.mp4']);
});

test('two videos with one stem keep their own parts folders: the second cut leaves the first one\'s parts alone', async () => {
  const h = host();
  fs.writeFileSync(path.join(h.root, h.work, 'call.mov'), 'x');
  const mp4 = await videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, run: fakeRun({ duration: 100 }).run });
  fs.writeFileSync(path.join(h.root, mp4.video.parts[0].file), 'the mp4 part');
  const mov = await videoParts({ root: h.root, work: h.work, video: `${h.work}/call.mov`, partSeconds: 1800, run: fakeRun({ duration: 100 }).run });
  assert.deepEqual([mp4.video.parts[0].file, mov.video.parts[0].file], [`${h.work}/call.mp4-parts/call.mp4-part-01.m4a`, `${h.work}/call.mov-parts/call.mov-part-01.m4a`]);
  assert.equal(fs.readFileSync(path.join(h.root, mp4.video.parts[0].file), 'utf8'), 'the mp4 part');
});

test('at the cut, a part file that became a link is refused before ffmpeg runs; a part ffmpeg did not write fails the run', async () => {
  const h = host();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
  fs.mkdirSync(path.join(h.root, h.work, 'call.mp4-parts'));
  fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(h.root, h.work, 'call.mp4-parts', 'call.mp4-part-02.m4a'));
  const f = fakeRun();
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, run: f.run }), (e) => e.exitCode === 2 && /call\.mp4-part-02\.m4a exists and is not a plain file/.test(e.message));
  assert.deepEqual(f.calls.map((c) => c[0]), ['ffprobe'], 'no ffmpeg');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  fs.unlinkSync(path.join(h.root, h.work, 'call.mp4-parts', 'call.mp4-part-02.m4a'));
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1800, run: fakeRun({ writes: false }).run }), (e) => e.exitCode === 1 && /ffmpeg wrote no .*call\.mp4-part-01\.m4a/.test(e.message));
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
  fs.writeFileSync(path.join(bin, 'ffprobe'), `#!${node}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['ffprobe', ...process.argv.slice(2)]) + '\\n');\nprocess.stdout.write(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '150' } }));\n`);
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!${node}\nconst a = process.argv.slice(2);\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['ffmpeg', ...a]) + '\\n');\nrequire('fs').writeFileSync(a[a.length - 1], 'part');\n`);
  for (const f of ['ffprobe', 'ffmpeg']) fs.chmodSync(path.join(bin, f), 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

// Runs in `cwd`, the host root, as a role session does.
const cli = (args, bin, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
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
  const r = cli(['--root', h.root, '--work', h.work, '--video', h.video, '--transcript-name', '{part}-transcript-service.txt'], s.bin, h.root);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.partSeconds, 60);
  assert.deepEqual(r.json.video.parts.map((p) => [p.start, p.length]), [[0, 60], [60, 60], [120, 30]]);
  assert.equal(r.json.video.parts[2].transcript, `${h.work}/call.mp4-parts/call.mp4-part-03-transcript-service.txt`);
  const calls = s.calls();
  assert.deepEqual(calls.map((c) => c[0]), ['ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg']);
  const ss = calls[3].indexOf('-ss');
  assert.deepEqual(calls[3].slice(ss, ss + 4), ['-ss', '120', '-t', '30']);
});

test('the CLI: the host root is the folder it runs in; a --root elsewhere, or the file system root, runs nothing (exit 2)', () => {
  const h = host({ partMinutes: 1 });
  const s = standIns();
  const args = ['--work', h.work, '--video', h.video, '--dry-run'];
  // No --root, or --root naming the same folder in another spelling: the host.
  for (const root of [[], ['--root', '.'], ['--root', `${h.root}/`], ['--root', h.root]]) {
    const r = cli([...root, ...args], s.bin, h.root);
    assert.equal(r.code, 0, `${root.join(' ')}: ${r.err}`);
    assert.equal(r.json.video.file, h.video);
  }
  // A --root above the host (the work folder and the video are still inside it), another folder, a missing one: refused.
  const above = path.dirname(h.root);
  const rel = (p) => path.relative(above, path.join(h.root, p));
  for (const [root, work, video] of [[above, rel(h.work), rel(h.video)], ['/', path.join(h.root, h.work), path.join(h.root, h.video)], [tmp(), path.join(h.root, h.work), path.join(h.root, h.video)], [path.join(h.root, 'missing'), h.work, h.video]]) {
    const r = cli(['--root', root, '--work', work, '--video', video], s.bin, h.root);
    assert.equal(r.code, 2, `--root ${root}: ${r.err}`);
    assert.match(r.json.error, /is not the folder this runs in/);
  }
  // Run from the file system root, it refuses whatever the paths.
  const r = cli(['--work', path.join(h.root, h.work), '--video', path.join(h.root, h.video), '--settings', path.join(h.root, '.claude', 'ticket-flow.json')], s.bin, '/');
  assert.equal(r.code, 2, r.err);
  assert.match(r.json.error, /file system's root .*run it from the host repo/);
  assert.deepEqual(s.calls().map((c) => c[0]), ['ffprobe', 'ffprobe', 'ffprobe', 'ffprobe'], 'only the four dry runs');
  assert.deepEqual(fs.readdirSync(path.join(h.root, h.work)), ['call.mp4']);
});

test('the CLI: a path outside the work folder or the root writes nothing and runs nothing (exit 2)', () => {
  const h = host();
  const s = standIns();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'v.mp4'), 'x');
  for (const args of [['--work', outside, '--video', path.join(outside, 'v.mp4')], ['--work', h.work, '--video', path.join(outside, 'v.mp4')], ['--work', h.work], ['--work', h.work, '--video', h.video, 'extra']]) {
    const r = cli(['--root', h.root, ...args], s.bin, h.root);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.equal(r.json.ok, false);
  }
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(fs.readdirSync(path.join(h.root, h.work)), ['call.mp4']);
  assert.equal(cli(['--root', h.root, '--work', h.work, '--video', h.video, '--ffmpeg', '/bin/sh'], s.bin, h.root).code, 2, 'no flag names a program');
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
  assert.deepEqual(added, ['docs/.sources/tickets/501/call.mp4-parts', ...out.video.parts.map((p) => p.file)].sort());
});

test('a real video with no sound is refused', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const h = host();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-t', '2', '-c:v', 'mpeg4', path.join(h.root, h.video)]);
  await assert.rejects(videoParts({ root: h.root, work: h.work, video: h.video, partSeconds: 1 }), /has no sound/);
});

test('a real playlist or file list in the work folder naming a file outside it is refused, and nothing is cut or written', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const h = host();
  const outside = tmp();
  const secret = path.join(outside, 'secret.ts');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=8000', '-t', '7', '-c:a', 'aac', '-f', 'mpegts', secret]);
  const work = path.join(h.root, h.work);
  const up = path.relative(work, secret);
  assert.ok(up.startsWith('..'), up);
  const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n#EXTINF:7.0,\n${up}\n#EXT-X-ENDLIST\n`;
  fs.writeFileSync(path.join(work, 'local.m3u8'), playlist);
  fs.writeFileSync(path.join(work, 'renamed.mp4'), playlist);
  fs.writeFileSync(path.join(work, 'list.txt'), `ffconcat version 1.0\nfile '${secret}'\n`);
  // Without the guard, ffprobe reads the playlist as 7 s of sound: the case this test stands for.
  assert.match(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', path.join(work, 'local.m3u8')], { encoding: 'utf8' }), /hls/);
  const before = fs.readdirSync(h.root, { recursive: true }).sort();
  for (const name of ['local.m3u8', 'renamed.mp4', 'list.txt']) {
    await assert.rejects(videoParts({ root: h.root, work: h.work, video: `${h.work}/${name}`, partSeconds: 2 }), (e) => e.exitCode === 1 && /not a plain video or sound file|ffprobe failed/.test(e.message), name);
  }
  assert.deepEqual(fs.readdirSync(h.root, { recursive: true }).sort(), before, 'nothing written');
  assert.deepEqual(fs.readdirSync(outside), ['secret.ts']);
});

test('real sound files in the other plain containers are cut with their own demuxer', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const h = host();
  const cut = [];
  for (const [name, codec] of [['talk.webm', ['-c:a', 'libopus']], ['talk.mkv', ['-c:a', 'aac']], ['talk.mp3', []], ['talk.wav', []], ['talk.m4a', ['-c:a', 'aac']]]) {
    const file = path.join(h.root, h.work, name);
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '3', ...codec, file], { stdio: 'ignore' });
    } catch {
      continue; // an encoder this ffmpeg lacks
    }
    const out = await videoParts({ root: h.root, work: h.work, video: `${h.work}/${name}`, partSeconds: 2 });
    assert.deepEqual(out.video.parts.map((p) => p.start), [0, 2], name);
    for (const p of out.video.parts) assert.ok(Math.abs(lengthOf(path.join(h.root, p.file)) - p.length) < 0.2, `${p.file} lasts about ${p.length} s`);
    cut.push(name);
  }
  // The encoders every ffmpeg has: matroska, wav and m4a are always among them.
  assert.ok(['talk.mkv', 'talk.wav', 'talk.m4a'].every((n) => cut.includes(n)), cut.join(' '));
});
