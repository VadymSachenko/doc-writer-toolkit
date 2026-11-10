// The test that needs Playwright and Chromium: the real driver and page module against a local server of synthetic
// pages, one per path of the automatic try (no page of the service is copied: its terms forbid reusing its HTML). `npm
// test` starts this file only when it can launch Chromium (see run.mjs); without it the run is `not run` (exit 2).
//
//   the upload taken, the transcript still in work, then its plain-text export saved with timestamps;
//   one failure each: a captcha (a bot check), a sign-in wall, the day's limit, an unexpected page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createTranscriber } from '../lib/index.mjs';
import { loadPlaywright } from '../lib/playwright.mjs';
import { REASONS } from '../lib/driver.mjs';

const from = path.resolve(process.env.TRANSCRIBER_PLAYWRIGHT_FROM ?? process.env.VISUAL_PACK_PLAYWRIGHT_FROM);
const chromium = loadPlaywright(from);

// The server's state: what the dashboard is (`mode`), the files uploaded, and whether their transcripts are done.
const state = { mode: 'ok', files: [], done: false, timestamps: true };
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const SIGNED = '<nav><a href="/logout">Log out</a></nav>';
function dashboard() {
  const list = state.files.map((n, i) => `<li><a href="/transcript/${i}">${n}</a></li>`).join('');
  return page(
    'Dashboard',
    `${SIGNED}<button id="openUpload">Transcribe Files</button>
<dialog id="d"><input type="file" id="f"><button id="go">Transcribe</button></dialog><ul>${list}</ul>
<script>
openUpload.onclick = () => d.showModal();
go.onclick = async () => {
  const file = f.files[0];
  const r = await fetch('/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: await file.arrayBuffer() });
  if ((await r.text()) === 'limit') { d.close(); document.body.insertAdjacentHTML('beforeend', '<p>You have reached your daily limit.</p>'); return; }
  location.reload();
};
</script>`,
  );
}
function transcript(i) {
  if (!state.done) return page(state.files[i], `${SIGNED}<h1>${state.files[i]}</h1><p>Transcribing… 40%</p>`);
  return page(
    state.files[i],
    `${SIGNED}<h1>${state.files[i]}</h1><button id="exp">Download</button><div id="menu" hidden><button id="txt">TXT</button></div>
<dialog id="opts"><label><input type="checkbox" id="ts"> Include timestamps</label><button id="dl">Download</button></dialog>
<script>
exp.onclick = () => { menu.hidden = false; };
txt.onclick = () => opts.showModal();
dl.onclick = () => { location.href = '/export/${i}?ts=' + (ts.checked ? 1 : 0); };
</script>`,
  );
}

let server;
let origin;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = (text) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(text);
    };
    if (u.pathname === '/dashboard') {
      if (state.mode === 'captcha') return html(page('Just a moment...', '<div class="cf-turnstile"></div><p>Checking your browser</p>'));
      if (state.mode === 'signIn') {
        res.writeHead(302, { location: '/login?next=%2Fdashboard&token=SECRET' });
        return res.end();
      }
      if (state.mode === 'unexpected') return html(page('Dashboard', `${SIGNED}<p>A new layout</p>`));
      return html(dashboard());
    }
    if (u.pathname === '/login') return html(page('Log in', '<button>Continue with Google</button>'));
    if (u.pathname === '/upload' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        if (state.mode === 'limit') return res.end('limit');
        state.files.push(u.searchParams.get('name'));
        res.end('ok');
      });
      return;
    }
    const t = /^\/transcript\/(\d+)$/.exec(u.pathname);
    if (t) return html(transcript(Number(t[1])));
    const e = /^\/export\/(\d+)$/.exec(u.pathname);
    if (e) {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${state.files[Number(e[1])]}.txt"` });
      return res.end(u.searchParams.get('ts') === '1' && state.timestamps ? '(0:00 - 0:04)\nHello.\n\n(0:04 - 0:09)\nThe second line.\n' : 'Hello.\nThe second line.\n');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-browser-'));
function open(dir) {
  const settings = { root: from, video: { transcriber: 'turboscribe', browserProfile: path.join(dir, 'profile'), headless: true, channel: null } };
  return createTranscriber('turboscribe', { settings, chromium, origin }).open();
}

test('the upload, a look while the transcript is in work, then its plain-text export with timestamps', async () => {
  Object.assign(state, { mode: 'ok', files: [], done: false, timestamps: true });
  const dir = tmp();
  const part = path.join(dir, 'call.mp4-part-01.m4a');
  fs.writeFileSync(part, 'sound');
  const dest = path.join(dir, 'call.mp4-part-01-transcript-turboscribe.txt');
  let s = await open(dir);
  try {
    assert.deepEqual(await s.upload({ file: part, name: '501-call.mp4-part-01.m4a' }), { outcome: 'uploaded', ref: { name: '501-call.mp4-part-01.m4a' } });
    assert.deepEqual(state.files, ['501-call.mp4-part-01.m4a']);
  } finally {
    await s.close();
  }
  // A later run: still in work, then done.
  s = await open(dir);
  try {
    assert.deepEqual(await s.fetch({ ref: { name: '501-call.mp4-part-01.m4a' }, dest }), { outcome: 'waiting' });
    state.done = true;
    assert.deepEqual(await s.fetch({ ref: { name: '501-call.mp4-part-01.m4a' }, dest }), { outcome: 'done' });
  } finally {
    await s.close();
  }
  assert.match(fs.readFileSync(dest, 'utf8'), /^\(0:00 - 0:04\)\nHello\./);
});

test('an export the site gives without timestamps is refused, and nothing is saved', async () => {
  Object.assign(state, { mode: 'ok', files: ['501-x.m4a'], done: true, timestamps: false });
  const dir = tmp();
  const dest = path.join(dir, 'x-transcript.txt');
  const s = await open(dir);
  try {
    assert.deepEqual(await s.fetch({ ref: { name: '501-x.m4a' }, dest }), { outcome: 'failed', reason: 'an unexpected page (no timestamps in the plain-text export)' });
  } finally {
    await s.close();
  }
  assert.ok(!fs.existsSync(dest));
});

for (const [mode, reason] of [
  ['captcha', REASONS.captcha],
  ['signIn', REASONS.signIn],
  ['limit', REASONS.limit],
  ['unexpected', 'an unexpected page (no the upload button on the dashboard)'],
]) {
  test(`one failure, no retry: ${mode}`, async () => {
    Object.assign(state, { mode, files: [], done: false, timestamps: true });
    const dir = tmp();
    const part = path.join(dir, 'p.m4a');
    fs.writeFileSync(part, 'sound');
    const s = await open(dir);
    try {
      const r = await s.upload({ file: part, name: '501-p.m4a' });
      assert.deepEqual(r, { outcome: 'failed', reason });
      assert.ok(!JSON.stringify(r).includes('SECRET'), 'no query of a sign-in redirect in the reason');
    } finally {
      await s.close();
    }
    assert.deepEqual(state.files, [], 'nothing uploaded');
  });
}
