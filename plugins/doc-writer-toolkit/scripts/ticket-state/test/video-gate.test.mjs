import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOW, card, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { ROLE_DENIED, briefFor, extractCalls, extractPreflight, runDaily, scriptedCalls, sessionEnv, smePython, writeDeniedFor, SME_SCRIPT } from '../lib/runner.mjs';
import { refusalOf, HOOK_VARIABLE } from '../lib/role-hook.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { quietGit, settingsFor } from './fakes.mjs';
import { emptyFeed, sourcesOf, writeFeed } from '../lib/feed.mjs';
import { runCheck } from '../lib/watch.mjs';
import { localDate } from '../lib/report.mjs';
import { writeLedger } from '../lib/ledger.mjs';

// The video gate's runner side (TASK-055): the automatic try through a transcriber adapter (uploads, then looks for
// the transcripts in a later run), the fallback on each failure with no retry, and the runner's frame sweep with every
// part's transcript before the import's session. The adapter here is a stand-in; scripts/transcriber/ tests the real one.

const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const noSession = async () => assert.fail('no claude session for a scripted video step');
const quick = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const AUTO = { transcriber: 'turboscribe', browserProfile: '/somewhere/profile', partsPerDay: 3, fetchMinutes: 15, transcriptHours: 2 };
const at = (min) => new Date(NOW - min * 60000).toISOString();
const run = (w, io, options = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: noSession, sleep: quick, ...io }, options: { morning: false, trigger: 'watcher', ...options } });

// A ticket at the video gate: its parts (with their tries) in `t/`, and the files on disk.
function gated({ number = 501, tries = [[], []], video = AUTO, status = 'inProgress', extra = {}, stages = {} } = {}) {
  const c = card({ number, status });
  const w = world({ cards: [c], extra: { video, limits: { stepsPerTicket: 1, startHours: '0-24' }, ...extra } });
  fs.mkdirSync(path.join(w.root, 't'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 't/call.mp4'), 'video');
  const parts = tries.map((t, i) => {
    const file = `t/call.mp4-parts/call.mp4-part-0${i + 1}.m4a`;
    fs.mkdirSync(path.join(w.root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(w.root, file), 'sound');
    return { file, start: i * 1800, length: 1800, transcript: `t/call.mp4-parts/call.mp4-part-0${i + 1}-transcript-turboscribe.txt`, tries: t, askedAt: null };
  });
  ledger(w, c, { stages: { start: 'done', plan: 'done', videoGate: 'done', ...stages }, video: { videos: [{ file: 't/call.mp4', duration: 1800 * tries.length, parts }], gateComment: 'Blocked: the video', at: at(300) } });
  return { w, c, key: String(number), parts };
}

// A stand-in transcriber: each call answers from the lists given, and records what it was asked.
function standIn({ uploads = [], fetches = [], open = null } = {}) {
  const calls = [];
  return {
    calls,
    transcriber: {
      async open() {
        calls.push('open');
        if (open) throw open;
        return {
          async upload({ file, name }) {
            calls.push(['upload', path.basename(file), name]);
            return uploads.shift() ?? { outcome: 'uploaded', ref: { name } };
          },
          async fetch({ ref, dest }) {
            calls.push(['fetch', ref?.name, path.basename(dest)]);
            const r = fetches.shift() ?? { outcome: 'waiting' };
            if (r.outcome === 'done') fs.writeFileSync(dest, '(0:00 - 0:03)\nHello.\n');
            return r;
          },
          async close() {
            calls.push('close');
          },
        };
      },
    },
  };
}

test('the try: up to the day\'s parts uploaded under the ticket\'s name, one browser, recorded with the name the service lists', async () => {
  const g = gated({ tries: [[], [], [], []] });
  const s = standIn();
  const out = await run(g.w, { transcriber: s.transcriber }, { named: [g.key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.role, r.outcome]), [['videoTry', null, 'done']]);
  assert.deepEqual(s.calls, ['open', ['upload', 'call.mp4-part-01.m4a', '501-call.mp4-part-01.m4a'], ['upload', 'call.mp4-part-02.m4a', '501-call.mp4-part-02.m4a'], ['upload', 'call.mp4-part-03.m4a', '501-call.mp4-part-03.m4a'], 'close']);
  const parts = read(g.w, g.key).video.videos[0].parts;
  assert.deepEqual(parts.map((p) => p.tries.map((t) => [t.outcome, t.ref?.name])), [[['uploaded', '501-call.mp4-part-01.m4a']], [['uploaded', '501-call.mp4-part-02.m4a']], [['uploaded', '501-call.mp4-part-03.m4a']], []]);
  // The same check again: nothing is due (uploaded now, today's three used), so no step and no browser.
  const t = await g.w.one(g.key);
  assert.equal(t.next, null);
  assert.ok(t.notes.some((n) => /1 part\(s\) wait for tomorrow/.test(n)));
  assert.equal(t.gate.who, 'transcriber');
});

test('a later run looks for the transcripts: still waiting is a look, a done one saved under the part\'s name ends the gate', async () => {
  const g = gated({ tries: [[{ at: at(30), outcome: 'uploaded', ref: { name: '501-call.mp4-part-01.m4a' } }], [{ at: at(30), outcome: 'uploaded', ref: { name: '501-call.mp4-part-02.m4a' } }]] });
  const s = standIn({ fetches: [{ outcome: 'done' }, { outcome: 'waiting' }] });
  await run(g.w, { transcriber: s.transcriber }, { named: [g.key] });
  assert.deepEqual(s.calls, ['open', ['fetch', '501-call.mp4-part-01.m4a', 'call.mp4-part-01-transcript-turboscribe.txt'], ['fetch', '501-call.mp4-part-02.m4a', 'call.mp4-part-02-transcript-turboscribe.txt'], 'close']);
  const l = read(g.w, g.key);
  const [p1, p2] = l.video.videos[0].parts;
  assert.deepEqual([p1.checks.map((c) => c.outcome), p2.checks.map((c) => c.outcome), p1.tries.length, p2.tries.length], [['done'], ['waiting'], 1, 1], 'a look is no try');
  assert.ok(l.files.some((f) => f.path === p1.transcript && f.kind === 'transcript'), 'the transcript is a work file');
  assert.equal(fs.readFileSync(path.join(g.w.root, p1.transcript), 'utf8'), '(0:00 - 0:03)\nHello.\n');
  // The second part's look is due again only after fetchMinutes.
  assert.equal((await g.w.one(g.key)).next, null);
  // Once the second is there too: the frame sweep, not the import's session.
  fs.writeFileSync(path.join(g.w.root, p2.transcript), '(0:00 - 0:02)\nThere.\n');
  assert.equal((await g.w.one(g.key)).next.stage, 'videoExtract');
});

test('AC-3: each failure is one fallback with no retry: a wall on upload, a wall on a look, no transcript in time, no adapter, a browser that does not start', async () => {
  const cases = [
    ['an upload that meets a sign-in wall', { tries: [[], []] }, { uploads: [{ outcome: 'failed', reason: "a sign-in wall: the browser profile needs the owner's sign-in (transcriber.mjs sign-in)" }] }, [['upload', 'call.mp4-part-01.m4a', '501-call.mp4-part-01.m4a']], /sign-in wall/],
    ['the day\'s limit', { tries: [[], []] }, { uploads: [{ outcome: 'failed', reason: "the day's limit of the transcription service" }] }, [['upload', 'call.mp4-part-01.m4a', '501-call.mp4-part-01.m4a']], /day's limit/],
    ['a captcha on a look', { tries: [[{ at: at(30), outcome: 'uploaded', ref: { name: 'a' } }], []] }, { fetches: [{ outcome: 'failed', reason: 'a captcha or a bot check' }] }, [['fetch', 'a', 'call.mp4-part-01-transcript-turboscribe.txt']], /captcha/],
    ['no transcript within transcriptHours', { tries: [[{ at: at(130), outcome: 'uploaded', ref: { name: 'a' } }], []] }, { fetches: [{ outcome: 'waiting' }] }, [['fetch', 'a', 'call.mp4-part-01-transcript-turboscribe.txt']], /no transcript within 2 h of the upload/],
    ['an unexpected page', { tries: [[], []] }, { uploads: [{ outcome: 'failed', reason: 'an unexpected page (no the upload button on the dashboard)' }] }, [['upload', 'call.mp4-part-01.m4a', '501-call.mp4-part-01.m4a']], /unexpected page/],
    ['a browser that does not start', { tries: [[], []] }, { open: new Error('the browser did not start: no Chromium') }, [], /the browser did not start/],
  ];
  for (const [what, opts, answers, asked, reason] of cases) {
    const g = gated(opts);
    const s = standIn(answers);
    await run(g.w, { transcriber: s.transcriber }, { named: [g.key] });
    assert.deepEqual(s.calls.filter((c) => Array.isArray(c)), asked, `${what}: one call, and the next part is not tried`);
    const l = read(g.w, g.key);
    const failedTries = l.video.videos[0].parts.flatMap((p) => p.tries).filter((t) => t.outcome === 'failed');
    assert.equal(failedTries.length, 1, `${what}: one failure`);
    assert.match(failedTries[0].reason, reason);
    // The fallback: the card to Blocked with the gate comment, the reason in the report.
    const t = await g.w.one(g.key);
    assert.equal(t.next.stage, 'videoBlock', what);
    const out = await run(g.w, { transcriber: { open: () => assert.fail('no try after a failure') } }, { named: [g.key] });
    assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['videoBlock', 'done']], what);
    assert.equal((await g.w.one(g.key)).next, null, `${what}: in Blocked, waiting for the person`);
    const report = fs.readFileSync(path.join(g.w.settings.state, 'reports', fs.readdirSync(path.join(g.w.settings.state, 'reports'))[0]), 'utf8');
    assert.match(report, /## Videos waiting for transcripts\n\n- .*the automatic try failed: /, what);
  }
  // No adapter installed (a stand-in runner with none, and no `video.transcriber` to build one from).
  const g = gated({ video: { ...AUTO, transcriber: null } });
  assert.equal((await g.w.one(g.key)).next.stage, 'videoBlock', 'no adapter set: straight to the gate, no try');
});

test('a browser profile in use is no failure: nothing is tried, a later check tries, and a lock held past transcriptHours falls back', async () => {
  const g = gated({ extra: { limits: { stepsPerTicket: 5, startHours: '0-24' } } });
  const busy = Object.assign(new Error('the browser profile is in use by another run (pid 7)'), { busy: true });
  const s = standIn({ open: busy });
  const out = await run(g.w, { transcriber: s.transcriber }, { named: [g.key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['videoTry', 'busy']], 'not taken again in the same run');
  assert.deepEqual(s.calls, ['open']);
  assert.match(out.ran[0].note, /the transcriber waits: the browser profile is in use/);
  const l = read(g.w, g.key);
  assert.deepEqual(l.video.videos[0].parts.map((p) => p.tries.length), [0, 0]);
  assert.equal(l.video.busySince, new Date(NOW).toISOString(), 'the first busy try is kept');
  assert.equal((await g.w.one(g.key)).next.stage, 'videoTry');
  // Busy since longer than transcriptHours (2 h): the gate falls back to the person, with the reason.
  l.video.busySince = at(3 * 60);
  writeLedger(g.w.settings.state, l);
  const t = await g.w.one(g.key);
  assert.equal(t.next.stage, 'videoBlock');
  assert.match(t.next.reason, /browser profile stayed in use by another run for more than 2 h/);
  // A real try clears it.
  l.video.busySince = at(30);
  writeLedger(g.w.settings.state, l);
  await run(g.w, { transcriber: standIn().transcriber }, { named: [g.key] });
  assert.equal(read(g.w, g.key).video.busySince, undefined);
});

test('a look with no name for its upload, or a part the ledger lost, never guesses', async () => {
  const g = gated({ tries: [[{ at: at(30), outcome: 'uploaded' }], []] });
  const s = standIn();
  const out = await run(g.w, { transcriber: s.transcriber }, { named: [g.key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['videoTry', 'done']]);
  assert.deepEqual(s.calls.filter((x) => Array.isArray(x)), [], 'neither a look nor an upload after the refusal');
  const p = read(g.w, g.key).video.videos[0].parts[0];
  assert.deepEqual([p.tries.at(-1).outcome, p.tries.at(-1).fetch, p.tries.at(-1).reason], ['failed', true, 'the upload has no name it is listed by']);
  assert.equal((await g.w.one(g.key)).next.stage, 'videoBlock');
  // A step naming a part the ledger doesn't have: skipped with a note, the rest goes on.
  const h = gated({ number: 503, tries: [[]] });
  const s2 = standIn();
  const { runScripted } = await import('../lib/runner.mjs');
  const res = await runScripted({ stage: 'videoTry', keys: ['503'], parts: ['t/gone.m4a', h.parts[0].file] }, { settings: h.w.settings, clients: h.w.clients(), io: { transcriber: s2.transcriber, now: () => NOW } });
  assert.match(res.join('\n'), /t\/gone\.m4a: no such video part in the ledger, not uploaded/);
  assert.deepEqual(s2.calls.filter((x) => Array.isArray(x)).map((x) => x[1]), ['call.mp4-part-01.m4a']);
});

test('the automatic try opens no browser outside the start hours; the watcher wants an untried part once they begin', async () => {
  const hour = new Date(NOW).getHours();
  const outside = hour < 23 ? `${hour + 1}-24` : '0-23';
  const g = gated({ extra: { limits: { stepsPerTicket: 1, startHours: outside } } });
  const t = await g.w.one(g.key);
  assert.equal(t.next, null);
  assert.ok(t.notes.some((n) => /waits for the start hours/.test(n)));
  const out = await run(g.w, { transcriber: { open: () => assert.fail('no browser outside the start hours') } }, { named: [g.key] });
  assert.deepEqual(out.ran, []);
});

test('the day is the account\'s: an older gate\'s parts go first, and the uploads stop at what is left', async () => {
  const cards = [card({ number: 601, status: 'inProgress' }), card({ number: 602, status: 'inProgress' })];
  const w = world({ cards, extra: { video: AUTO, limits: { stepsPerTicket: 1, startHours: '0-24' } } });
  fs.mkdirSync(path.join(w.root, 't'), { recursive: true });
  const gate = (c, name, gateAt) => {
    const parts = [0, 1].map((i) => ({ file: `t/${name}.mp4-part-0${i + 1}.m4a`, start: i * 1800, transcript: `t/${name}-${i}.txt`, tries: [] }));
    for (const p of parts) fs.writeFileSync(path.join(w.root, p.file), 'sound');
    ledger(w, c, { stages: { start: 'done', plan: 'done', videoGate: 'done' }, video: { videos: [{ file: `t/${name}.mp4`, parts }], gateComment: 'g', at: gateAt } });
  };
  gate(cards[0], 'a', at(300));
  gate(cards[1], 'b', at(10));
  const s = standIn();
  await run(w, { transcriber: s.transcriber }, { named: ['602'] });
  assert.deepEqual(s.calls.filter((x) => Array.isArray(x)).map((x) => x[2]), ['602-b.mp4-part-01.m4a'], 'three a day, two of them the older gate\'s');
});

test("the day is counted once the browser holds the profile: another run's uploads just before count", async () => {
  const cards = [card({ number: 611, status: 'inProgress' }), card({ number: 612, status: 'inProgress' })];
  const w = world({ cards, extra: { video: AUTO, limits: { stepsPerTicket: 3, startHours: '0-24' } } });
  fs.mkdirSync(path.join(w.root, 't'), { recursive: true });
  const partsOf = (name, n) => Array.from({ length: n }, (_, i) => ({ file: `t/${name}-part-0${i + 1}.m4a`, start: i * 1800, transcript: `t/${name}-${i}.txt`, tries: [] }));
  for (const p of [...partsOf('a', 3), ...partsOf('b', 2)]) fs.writeFileSync(path.join(w.root, p.file), 'sound');
  // The younger gate's run (612) read the status while the older one (611) had uploaded nothing yet.
  ledger(w, cards[0], { stages: { start: 'done', plan: 'done', videoGate: 'done', videoTry: 'done' }, video: { videos: [{ file: 't/a.mp4', parts: partsOf('a', 3) }], gateComment: 'g', at: at(300) } });
  ledger(w, cards[1], { stages: { start: 'done', plan: 'done', videoGate: 'done' }, video: { videos: [{ file: 't/b.mp4', parts: partsOf('b', 2) }], gateComment: 'g', at: at(10) } });
  const s = standIn();
  const open = s.transcriber.open;
  // While 612 waits for the profile, 611's run uploads its three and records them.
  s.transcriber.open = async () => {
    const l = read(w, '611');
    for (const p of l.video.videos[0].parts) p.tries.push({ at: at(1), outcome: 'uploaded', ref: { name: `611-${path.basename(p.file)}` } });
    writeLedger(w.settings.state, l);
    return open();
  };
  const out = await run(w, { transcriber: s.transcriber }, { named: ['612'] });
  assert.deepEqual(s.calls.filter((x) => Array.isArray(x)), [], 'the day is used: nothing uploaded');
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['videoTry', 'busy']]);
  assert.match(out.ran[0].note, /today's uploads are used/);
});

test('the frame sweep: every part\'s transcript at its whole-second start, never without one (Whisper), then the merges', () => {
  const g = gated({ tries: [[], [], []] });
  const l = read(g.w, g.key);
  // A part with no transcript file: refused, so the script never falls back to Whisper.
  assert.throws(() => extractCalls(l, g.w.settings), /a part has no transcript file: the sweep needs every one, or Whisper would run/);
  for (const p of l.video.videos[0].parts) fs.writeFileSync(path.join(g.w.root, p.transcript), '(0:00 - 0:01)\nx\n');
  l.video.videos[0].parts[2].start = 3600.0000001;
  const [c] = extractCalls(l, g.w.settings, { python: '/venv/bin/python' });
  const abs = (rel) => path.join(g.w.root, rel);
  assert.deepEqual(c.commands[0], ['/venv/bin/python', SME_SCRIPT, abs('t/call.mp4'), abs('t/call.mp4-sme'), '--transcript', `${abs(l.video.videos[0].parts[0].transcript)}@0`, '--transcript', `${abs(l.video.videos[0].parts[1].transcript)}@1800`, '--transcript', `${abs(l.video.videos[0].parts[2].transcript)}@3600`, '--progress-file', abs('t/call.mp4-sme/progress.json')]);
  assert.deepEqual(c.commands.slice(1).map((x) => x.slice(3)), [[abs('t/frames/call.mp4-frames'), '--merge-from', abs('t/call.mp4-sme/images')], [abs('t/frames/call.mp4-frames'), '--merge-from', abs('t/call.mp4-sme/transcript-key/images')]]);
  assert.deepEqual(c.result, { file: 't/call.mp4', package: 't/call.mp4-sme', transcript: 't/call.mp4-sme/transcript.txt', context: 't/call.mp4-sme/context.md', frames: 't/frames/call.mp4-frames' });
  // A package from an earlier sweep stays: the next one is a new folder.
  fs.mkdirSync(abs('t/call.mp4-sme'));
  assert.equal(extractCalls(l, g.w.settings).at(0).result.package, 't/call.mp4-sme-2');
  assert.equal(smePython('/home/x'), '/home/x/.cache/doc-writer-toolkit/sme-video-venv/bin/python');
  assert.match(scriptedCalls({ stage: 'videoExtract' }, l, g.w.settings)[0], /sme_video_context\.py/);
});

test('the frame sweep runs in the runner, records the package and the frames, and the import\'s brief names them', async () => {
  const g = gated({ tries: [[], []] });
  for (const p of g.parts) fs.writeFileSync(path.join(g.w.root, p.transcript), '(0:00 - 0:01)\nx\n');
  const ran = [];
  // A stand-in for the Python: the full pass writes its package, a merge writes the frames.
  const runExtract = async ({ command, cwd }) => {
    ran.push([path.relative(cwd, command[3]), command[4], ...(command.includes('--merge-from') ? ['merge'] : [])]);
    const out = command[3];
    fs.mkdirSync(out, { recursive: true });
    if (!command.includes('--merge-from')) {
      fs.writeFileSync(path.join(out, 'transcript.txt'), '[00:00:00–00:00:01] x\n[00:30:00–00:30:01] x\n');
      fs.writeFileSync(path.join(out, 'context.md'), '# ctx\n');
    }
    return { code: 0, timedOut: false, tail: [] };
  };
  const out = await run(g.w, { runExtract, smePython: '/venv/bin/python' }, { named: [g.key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.role, r.outcome]), [['videoExtract', null, 'done']]);
  assert.deepEqual(ran, [['t/call.mp4-sme', '--transcript'], ['t/frames/call.mp4-frames', '--merge-from', 'merge'], ['t/frames/call.mp4-frames', '--merge-from', 'merge']]);
  const l = read(g.w, g.key);
  assert.deepEqual(l.video.videos[0].extract.frames, 't/frames/call.mp4-frames');
  assert.deepEqual(l.files.filter((f) => ['runDir', 'frames'].includes(f.kind)).map((f) => [f.path, f.kind]), [['t/call.mp4-sme', 'runDir'], ['t/frames/call.mp4-frames', 'frames']]);
  assert.equal(l.runs.at(-1).script, true);
  const t = await g.w.one(g.key);
  assert.equal(t.next.stage, 'videoImport');
  const brief = briefFor({ ...t.next, keys: [g.key] }, g.w.settings);
  assert.match(brief, /The runner swept the video's frames with every part's transcript at its offset \(no Whisper\)/);
  assert.match(brief, /- t\/call\.mp4: transcript t\/call\.mp4-sme\/transcript\.txt; frames t\/frames\/call\.mp4-frames; context t\/call\.mp4-sme\/context\.md; parts at 0 s, 1800 s\./);
});

test('a frame sweep that fails is recorded with its run, waits for a person, and is not swept again at the next check', async () => {
  const g = gated({ tries: [[]] });
  fs.writeFileSync(path.join(g.w.root, g.parts[0].transcript), '(0:00 - 0:01)\nx\n');
  let n = 0;
  const runExtract = async () => {
    n++;
    return { code: 1, timedOut: false, tail: ['tesseract: command not found'] };
  };
  const out = await run(g.w, { runExtract, smePython: '/venv/bin/python' }, { named: [g.key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['videoExtract', 'failed']]);
  const l = read(g.w, g.key);
  assert.match(l.stages.videoExtract.note, /^the frame sweep of t\/call\.mp4 failed \(exit 1\): tesseract: command not found/);
  assert.deepEqual([l.runs.at(-1).outcome, l.runs.at(-1).failures], ['failed', 1]);
  assert.match((await g.w.one(g.key)).next.waits, /a person acting on the ticket/);
  await run(g.w, { runExtract, smePython: '/venv/bin/python' }, { named: [g.key] });
  assert.equal(n, 1);
  // No venv: failed before anything runs.
  const h = gated({ number: 502, tries: [[]] });
  fs.writeFileSync(path.join(h.w.root, h.parts[0].transcript), '(0:00 - 0:01)\nx\n');
});

test('the sweep\'s preflight: no venv, tesseract or ffmpeg skips it, whatever the settings, and the import goes on without frames', async () => {
  for (const video of [AUTO, { ...AUTO, transcriber: null, browserProfile: null }]) {
    const h = gated({ number: 502, tries: [[], []], video });
    for (const p of h.parts) fs.writeFileSync(path.join(h.w.root, p.transcript), '(0:00 - 0:01)\nx\n');
    const o = await run(h.w, { smePython: path.join(h.w.root, 'no-venv', 'python'), extractPreflight: (py) => extractPreflight(py, { has: (n) => n !== 'tesseract' }), runExtract: () => assert.fail('no sweep') }, { named: ['502'] });
    assert.deepEqual(o.ran.map((r) => [r.stage, r.outcome]), [['videoExtract', 'done']]);
    assert.match(o.ran[0].note, /the frame sweep was skipped: no Python at .*no-venv\/python \(the venv of extract-sme-screenshots\); no tesseract on the PATH/);
    const l = read(h.w, '502');
    assert.match(l.video.extractSkipped.reason, /no tesseract on the PATH/);
    assert.deepEqual(l.runs ?? [], [], 'no failed run: nothing waits for a person');
    const t = await h.w.one('502');
    assert.equal(t.next.stage, 'videoImport');
    assert.deepEqual(t.next.videos, [{ file: 't/call.mp4', parts: h.parts.map((p) => ({ transcript: p.transcript, start: p.start })) }]);
    const brief = briefFor({ ...t.next, keys: ['502'] }, h.w.settings);
    assert.match(brief, /The runner did not sweep the video's frames \(no Python at/);
    assert.match(brief, /a fact that needs a screenshot is cited without one, or left as a NEEDS CONFIRMATION marker/);
    assert.match(brief, /- t\/call\.mp4: t\/call\.mp4-parts\/call\.mp4-part-01-transcript-turboscribe\.txt at 0 s; .* at 1800 s\./);
  }
  // The preflight itself: a venv and both programs, or each one missing named.
  assert.equal(extractPreflight('/venv/python', { exists: () => true, has: () => true }), null);
  assert.equal(extractPreflight('/venv/python', { exists: () => false, has: () => false }), 'no Python at /venv/python (the venv of extract-sme-screenshots); no tesseract on the PATH; no ffmpeg on the PATH');
});

test('the watcher looks at a ticket whose uploaded part is due a look, with nothing on the board, and at no other', async () => {
  for (const [ago, wanted] of [[20, true], [5, false]]) {
    const g = gated({ tries: [[{ at: at(ago), outcome: 'uploaded', ref: { name: 'a' } }]] });
    const f = emptyFeed();
    for (const s of sourcesOf(g.w.settings)) f.sources[s.name] = { lastCheck: new Date(NOW - 5 * 60000).toISOString(), seen: {} };
    f.morning = { lastDate: localDate(NOW) };
    writeFeed(g.w.settings.state, f);
    const runs = [];
    const out = await runCheck({
      settings: g.w.settings,
      clients: g.w.clients(),
      io: { now: () => NOW, git: quietGit, runDaily: async (a) => (runs.push(a.options.named), { mode: g.w.settings.mode, named: a.options.named ?? [], ran: [], starts: [], guard: [] }), readUsage: () => assert.fail('no /usage'), notify: () => ({ sent: true }) },
      options: {},
    });
    assert.equal(out.events, 0, 'nothing on the board');
    assert.deepEqual(runs, wanted ? [[g.key]] : [], `uploaded ${ago} min ago`);
  }
});

test('the settings: both keys turn the try on; the profile is absolute and outside every repo; a part is whole seconds', () => {
  const root = tmp();
  assert.equal(settingsFor(root).video.transcriber, null, 'off by default');
  assert.equal(settingsFor(root, { video: { browserProfile: '~/.config/tb-profile' } }).video.browserProfile, path.join(os.homedir(), '.config/tb-profile'));
  for (const [video, msg] of [
    [{ transcriber: 'other' }, /video\.transcriber must be one of turboscribe/],
    [{ browserProfile: 'profile' }, /must be an absolute folder/],
    [{ browserProfile: path.join(root, 'profile') }, /outside the host repo/],
    [{ browserProfile: path.join(root, 'repos/guide-docs/x') }, /outside the host repo/],
    [{ partMinutes: 1.001 }, /whole number of seconds/],
    [{ headless: 'yes' }, /video\.headless/],
    [{ channel: 'firefox' }, /video\.channel/],
    [{ fetchMinutes: 0 }, /video\.fetchMinutes/],
  ]) assert.throws(() => settingsFor(root, { video }), msg, JSON.stringify(video));
  // No session reads or writes the profile.
  const s = settingsFor(root, { video: { browserProfile: '/somewhere/profile' } });
  const denied = writeDeniedFor(s);
  for (const r of ['Read(//somewhere/profile/**)', 'Edit(//somewhere/profile/**)', 'Edit(//somewhere/profile.lock/**)']) assert.ok(denied.includes(r), r);
  assert.ok(!writeDeniedFor(settingsFor(root)).some((r) => r.includes('somewhere')), 'no profile, no rule');
  for (const r of ['Bash(mkdir /somewhere/profile.lock:*)', 'Bash(mkdir -p /somewhere/profile.lock:*)']) assert.ok(denied.includes(r), r);
  assert.ok(ROLE_DENIED.includes('Bash(tesseract:*)'), 'no OCR in a role session');
  // The role hook refuses a command that names the profile or its lock: a Playwright run on it, a copy, a cd.
  const cfg = JSON.parse(sessionEnv({ role: 'writer', keys: ['1'] }, s, { roots: [], roleRules: ['Bash(npx playwright:*)'], trees: [] })[HOOK_VARIABLE]);
  assert.deepEqual(cfg.secrets, ['/somewhere/profile', '/somewhere/profile.lock']);
  for (const c of ['npx playwright open --user-data-dir=/somewhere/profile https://x.test', 'cp -R /somewhere/profile /tmp/x', "cat '/somewhere/profile/Default/Cookies'", 'cd /somewhere && ls profile/Default', 'mkdir /somewhere/profile.lock']) {
    assert.match(refusalOf(c, cfg, { cwd: '/' }) ?? '', /the transcriber's browser profile/, c);
  }
  assert.doesNotMatch(refusalOf('ls /somewhere/profiles-other', cfg, { cwd: '/' }) ?? '', /browser profile/, 'another folder is not it');
  assert.deepEqual(JSON.parse(sessionEnv({ role: 'writer', keys: ['1'] }, settingsFor(root), { roots: [], roleRules: [], trees: [] })[HOOK_VARIABLE]).secrets, []);
});
