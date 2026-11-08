// The test that needs Playwright and Chromium: a real run of the command on a fixture site. `npm test` starts this file
// only when it can launch Chromium (see run.mjs); without it the run is `not run` (exit 2), never a pass.
//
//   AC-1  a fixture site with a broken image and a wide table: the sheet flags both.
//   AC-2  the script makes no model call: a `claude` stand-in on PATH records no call, and a request to anything but the
//         local server is blocked and counted, while a second local port that records every hit sees none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHost, makeBuild, tmp } from './fixture.mjs';

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
const visualPack = (args) =>
  new Promise((resolve, reject) => {
    execFile('node', [CLI, '--root', host.dir, '--range', host.range, '--json', ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  assert.ok(!fs.existsSync(calls));
  assert.deepEqual(tripHits, []);
});
