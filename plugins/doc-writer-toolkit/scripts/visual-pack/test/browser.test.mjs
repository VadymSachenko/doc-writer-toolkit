// The test that needs Playwright and Chromium: a real run of the command on a fixture site. `npm test` starts this file
// only when it can launch Chromium (see run.mjs); without it the run is `not run` (exit 2), never a pass.
//
//   AC-1  a fixture site with a broken image and a wide table: the sheet flags both.
//   AC-2  the script makes no model call: a `claude` stand-in on PATH records no call, and a request to anything but the
//         local server is blocked and counted, while a second local port that records every hit sees none.
//   TASK-110  a page whose screenshot takes longer than Playwright's 30 s is captured when --timeout allows it (it was
//         `page-missing` before: the timeout never reached the screenshot); a view that fails twice is still
//         `page-missing` with its error, and a page that answers 404 is not tried again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHost, makeBuild, makeSlowHost, makeSlowBuild, tmp } from './fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'visual-pack.mjs');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let host;
let tripwire;
let tripHits;
let bin;
let calls;
let env;

before(async () => {
  tripHits = [];
  tripwire = http.createServer((req, res) => {
    tripHits.push(req.url);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end();
  });
  await new Promise((resolve) => tripwire.listen(0, '127.0.0.1', resolve));
  bin = tmp('visual-pack-bin');
  calls = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
  env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  host = makeHost();
});

after(async () => {
  await new Promise((resolve) => {
    tripwire.close(resolve);
    tripwire.closeAllConnections?.();
  });
});

// Runs the command and returns { code, report }, whatever the exit code.
const visualPack = (args, on = host) =>
  new Promise((resolve, reject) => {
    execFile('node', [CLI, '--root', on.dir, '--range', on.range, '--json', ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        resolve({ code: error ? error.code : 0, report: JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`no JSON on stdout (exit ${error?.code}): ${stderr}`));
      }
    });
  });

let main;
const tripPort = () => tripwire.address().port;
const findingsOf = (report, type) => report.findings.filter((f) => f.type === type);

test('AC-1: the sheet flags the broken image and the wide table of the fixture site', async () => {
  const build = makeBuild({ tripPort: tripPort() });
  const out = path.join(host.dir, 'pack');
  main = await visualPack(['--build-dir', build, '--out', out]);
  const { code, report } = main;
  assert.equal(code, 10, 'findings to fix give exit 10');
  assert.deepEqual(report.columns, ['uk', 'en', 'ru']);
  assert.equal(report.summary.captured, 9);
  assert.equal(report.summary.notCaptured, 0);
  assert.deepEqual([report.summary.retried, report.timings.retrySeconds], [0, null], 'nothing failed, nothing was tried again');

  // the broken image: the file that is not there, in every locale; the good image is not reported
  const broken = findingsOf(report, 'broken-image');
  assert.deepEqual(broken.map((f) => f.locale).sort(), ['en', 'ru', 'uk']);
  for (const f of broken) {
    assert.equal(f.page, 'primary:guide/01-payments.md');
    assert.ok(f.items.some((i) => /\/img\/missing\.png: the site answered 404/.test(i)), f.items.join('\n'));
    assert.ok(!f.items.some((i) => /ok\.png/.test(i)));
  }

  // the wide table: on the limits page in every locale; the narrow table on the intro page is not reported
  const wide = findingsOf(report, 'table-overflow');
  assert.deepEqual(wide.map((f) => `${f.page}:${f.locale}`).sort(), ['primary:guide/limits.md:en', 'primary:guide/limits.md:ru', 'primary:guide/limits.md:uk']);
  assert.match(wide[0].items[0], /px in \d+px/);
  assert.ok(report.findings.every((f) => f.page !== 'primary:guide/intro.md'), 'the clean page has no finding');

  // the sheet: one HTML file, the findings before the grid, a screenshot in each cell
  const sheet = fs.readFileSync(path.join(out, 'sheet.html'), 'utf8');
  const top = sheet.indexOf('Automatic findings');
  const grid = sheet.indexOf('class="grid"');
  assert.ok(top > 0 && grid > top);
  assert.match(sheet.slice(top, grid), /Broken image/);
  assert.match(sheet.slice(top, grid), /Table wider than the page/);
  assert.match(sheet.slice(top, grid), /missing\.png/);
  assert.equal((sheet.match(/<td id="c-/g) ?? []).length, 9);
  for (const page of report.pages) {
    for (const locale of report.columns) {
      const shot = path.join(out, page.captures[locale].shot);
      assert.deepEqual(fs.readFileSync(shot).subarray(0, 4), PNG_SIGNATURE, shot);
    }
  }
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), '*\n');
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
});

test('text left untranslated is found by comparison with the source locale; a kept bold label is only to look at', () => {
  const { report } = main;
  const untranslated = findingsOf(report, 'untranslated');
  assert.deepEqual(untranslated.map((f) => `${f.page}:${f.locale}`).sort(), ['primary:guide/01-payments.md:ru', 'primary:guide/limits.md:ru']);
  const payments = untranslated.find((f) => f.page.endsWith('01-payments.md'));
  assert.match(payments.items[0], /same as the source: Ця сума повертається/);
  assert.equal(payments.items.length, 1, 'only the paragraph left in Ukrainian');
  assert.match(untranslated.find((f) => f.page.endsWith('limits.md')).detail, /no file in this locale/);
  const kept = findingsOf(report, 'kept-label');
  assert.deepEqual(kept.map((f) => `${f.page}:${f.locale}`), ['primary:guide/limits.md:en']);
  assert.equal(kept[0].level, 'look');
  assert.equal(report.summary.findings.problems, 3 + 3 + 2);
  assert.equal(report.summary.findings.look, 1);
});

test('AC-2: no model is called, and only the local server is ever asked', async () => {
  const { report } = main;
  assert.ok(!fs.existsSync(calls), 'the `claude` stand-in on PATH was never started');
  assert.deepEqual(tripHits, [], 'a second local port got no request: blocked requests never left the browser');
  const net = report.network;
  assert.ok(net.blocked >= 9, `3 requests to other hosts on each of 3 payments views, got ${net.blocked}`);
  assert.ok(net.blockedHosts.includes('external.example.invalid'));
  assert.ok(net.blockedHosts.includes(`127.0.0.1:${tripPort()}`), 'another port on localhost is not the local server');
  assert.equal(net.requests, net.local + net.blocked, 'every request was either local or blocked');
  assert.ok(net.local > 0 && net.servedByLocalServer >= net.local);
});

test('--locales narrows the columns, and a locale missing from the build is a finding, not a crash', async () => {
  const build = makeBuild({ tripPort: tripPort() });
  fs.rmSync(path.join(build, 'ru'), { recursive: true });
  const out = path.join(host.dir, 'pack-ru');
  const { code, report } = await visualPack(['--build-dir', build, '--out', out, '--locales', 'ru']);
  assert.equal(code, 10);
  assert.deepEqual(report.columns, ['uk', 'ru']);
  const missing = findingsOf(report, 'page-missing');
  assert.deepEqual(missing.map((f) => f.locale), ['ru', 'ru', 'ru']);
  assert.match(missing[0].detail, /answered 404/);
  assert.equal(report.summary.captured, 6, 'a 404 page is still captured');
  assert.ok(report.pages.every((p) => p.captures.ru.status === 404 && p.captures.ru.retried === false), 'a 404 answer is not tried again');
  assert.equal(report.summary.retried, 0);
  assert.ok(!fs.existsSync(calls));
  assert.deepEqual(tripHits, []);
});

test('TASK-110: a page whose screenshot takes longer than Playwright\'s 30 s is captured with a --timeout above it', async () => {
  // Before the fix this view was `page-missing` with "page.screenshot: Timeout 30000ms exceeded.", --timeout or not.
  const slow = makeSlowHost();
  const build = makeSlowBuild({ stallMs: { en: 34000 } });
  const { code, report } = await visualPack(['--build-dir', build, '--out', path.join(slow.dir, 'pack'), '--locales', 'en', '--timeout', '60000'], slow);
  assert.equal(code, 0);
  const en = report.pages[0].captures.en;
  assert.deepEqual([en.status, en.error, en.retried], [200, null, false]);
  assert.ok(en.shot && fs.readFileSync(path.join(slow.dir, 'pack', en.shot)).subarray(0, 4).equals(PNG_SIGNATURE));
  assert.ok(report.timings.captureSeconds >= 30, `the screenshot waited past 30 s (capture ${report.timings.captureSeconds} s)`);
  assert.deepEqual(report.findings, []);
  assert.deepEqual([report.summary.captured, report.summary.notCaptured, report.summary.retried], [2, 0, 0]);
});

test('TASK-110: a view that fails twice is page-missing with its error, the retry is recorded, and a 404 is not tried again', async () => {
  const slow = makeSlowHost();
  const build = makeSlowBuild({ stallMs: { en: 120000 }, locales: ['uk', 'en'] }); // ru is not in the build: 404
  const { code, report } = await visualPack(['--build-dir', build, '--out', path.join(slow.dir, 'pack'), '--timeout', '5000'], slow);
  assert.equal(code, 10);
  const { uk, en, ru } = report.pages[0].captures;
  assert.match(en.error, /^page\.screenshot: Timeout 5000ms exceeded/, 'the timeout reached the screenshot');
  assert.match(en.firstError, /^page\.screenshot: Timeout 5000ms exceeded/);
  assert.deepEqual([en.retried, en.shot], [true, null]);
  assert.deepEqual([ru.status, ru.retried], [404, false]);
  assert.deepEqual([uk.retried, Boolean(uk.shot)], [false, true]);
  assert.deepEqual(
    report.findings.map((f) => [f.type, f.level, f.locale, f.detail]),
    [
      ['page-missing', 'problem', 'en', `could not be captured: ${en.error}`],
      ['page-missing', 'problem', 'ru', '/ru/guide/slow answered 404'],
    ],
  );
  assert.deepEqual([report.summary.retried, report.summary.capturedOnRetry], [1, 0]);
  assert.ok(report.timings.retrySeconds >= 5, `the retry waited its own 5 s (${report.timings.retrySeconds} s)`);
});
