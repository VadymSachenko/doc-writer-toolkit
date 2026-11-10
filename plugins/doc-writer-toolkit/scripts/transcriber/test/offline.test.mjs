// The tests that need no browser: the page checks on snapshots (one per failure), the driver's contract on a stand-in
// site and launcher (one try, the fixed reasons, the profile lock, nothing of a session printed), and the CLI's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, SIGNED_IN, CHECKS, TIMESTAMP } from '../lib/turboscribe.mjs';
import { Busy, REASONS, createDriver, plainError, reasonOf, takeProfileLock } from '../lib/driver.mjs';
import { TRANSCRIBERS, createTranscriber } from '../lib/index.mjs';
import { main } from '../transcriber.mjs';
import { rawSettings } from '../../ticket-state/test/fakes.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-'));
const signedIn = { [SIGNED_IN[0]]: true };
const snap = (over = {}) => ({ host: 'turboscribe.ai', path: '/dashboard', title: 'Dashboard', text: 'Transcribe Files', present: signedIn, ...over });

test('the page checks: a captcha, a sign-in wall, the day\'s limit, an unexpected page, and the page the step wants', () => {
  assert.equal(classify(snap({ title: 'Just a moment...', present: {} })).kind, 'captcha', "Cloudflare's bot check");
  assert.equal(classify(snap({ present: { [CHECKS.captcha.selectors[1]]: true } })).kind, 'captcha', 'a Turnstile widget');
  assert.equal(classify(snap({ text: 'Please verify you are human' })).kind, 'captcha');
  assert.equal(classify(snap({ path: '/login', present: {} })).kind, 'signIn', 'the sign-in page');
  assert.equal(classify(snap({ host: 'accounts.google.com', path: '/v3/signin/identifier', present: {} })).kind, 'signIn', "Google's sign-in");
  assert.equal(classify(snap({ text: 'Continue with Google', present: {} })).kind, 'signIn', 'a page that asks to sign in again');
  assert.equal(classify(snap({ text: 'Signed in. Continue with Google Drive import' })).kind, 'ok', 'the words on a signed-in page are no wall');
  assert.equal(classify(snap({ text: "You've reached your daily limit. Upgrade to Unlimited to transcribe more." })).kind, 'limit');
  assert.equal(classify(snap({ present: {} }), { expect: SIGNED_IN }).kind, 'unexpected', 'not the signed-in dashboard');
  assert.equal(classify(snap(), { expect: SIGNED_IN }).kind, 'ok');
  // A captcha wins over the rest: a bot check on the sign-in page is a captcha.
  assert.equal(classify(snap({ path: '/login', title: 'Just a moment...' })).kind, 'captcha');
});

test('the export check: only a plain-text export with timestamps is taken', () => {
  assert.ok(TIMESTAMP.test('(0:00 - 0:05)\nHello\n\n(0:05 - 0:09)\nThere'));
  assert.ok(!TIMESTAMP.test('Hello there, no timestamps'));
});

test('a reason is a fixed text, never an address with its query', () => {
  assert.equal(reasonOf({ kind: 'signIn' }), REASONS.signIn);
  assert.equal(reasonOf({ kind: 'limit' }), REASONS.limit);
  assert.equal(reasonOf({ kind: 'unexpected', what: 'the upload button on the dashboard' }), 'an unexpected page (no the upload button on the dashboard)');
  const e = new Error('page.goto: net::ERR_ABORTED at https://accounts.google.com/o/oauth2/auth?client_id=1&state=SECRET#frag\nCall log:\n  - navigating');
  assert.equal(plainError(e), 'page.goto: net::ERR_ABORTED at https://accounts.google.com/o/oauth2/auth');
});

// A stand-in for Playwright's launcher and a site module whose steps return what each test says.
function standIn({ launchError = null } = {}) {
  const calls = [];
  const page = { closed: false };
  const context = { pages: () => [page], newPage: async () => page, close: async () => calls.push('close') };
  return {
    calls,
    chromium: {
      launchPersistentContext: async (dir, opts) => {
        calls.push(['launch', dir, opts]);
        if (launchError) throw launchError;
        return context;
      },
    },
  };
}
const siteWith = ({ upload = null, exp = { outcome: 'waiting' }, text = '(0:00 - 0:04)\nHi\n' } = {}) => {
  const calls = [];
  return {
    calls,
    site: {
      SITE: { name: 'stand-in', origin: 'http://127.0.0.1:1' },
      TIMESTAMP,
      uploadFile: async (_page, { name, file }) => {
        calls.push(['upload', name, file.length]);
        return upload;
      },
      exportText: async (_page, { name, saveAs }) => {
        calls.push(['export', name]);
        if (exp.outcome === 'done') await saveAs({ saveAs: async (to) => fs.writeFileSync(to, text) });
        return exp;
      },
    },
  };
};
const settingsWith = (dir, over = {}) => ({ root: dir, video: { transcriber: 'turboscribe', browserProfile: path.join(dir, 'profile'), headless: true, channel: null, ...over } });

test('the driver: one upload is one try, and a wall gives one failure with its fixed reason', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'p.m4a'), 'sound');
  const b = standIn();
  for (const [r, want] of [
    [null, { outcome: 'uploaded', ref: { name: '501-p.m4a' } }],
    [{ kind: 'signIn', what: 'x' }, { outcome: 'failed', reason: REASONS.signIn }],
    [{ kind: 'captcha', what: 'x' }, { outcome: 'failed', reason: REASONS.captcha }],
    [{ kind: 'limit', what: 'x' }, { outcome: 'failed', reason: REASONS.limit }],
    [{ kind: 'unexpected', what: 'the file field of the upload dialog' }, { outcome: 'failed', reason: 'an unexpected page (no the file field of the upload dialog)' }],
  ]) {
    const s = siteWith({ upload: r });
    const session = await createDriver({ site: s.site, settings: settingsWith(dir), chromium: b.chromium }).open();
    assert.deepEqual(await session.upload({ file: path.join(dir, 'p.m4a'), name: '501-p.m4a' }), want);
    assert.deepEqual(s.calls, [['upload', '501-p.m4a', 5]], 'one call to the site: no retry');
    await session.close();
  }
  const [, profile, opts] = b.calls[0];
  assert.equal(profile, path.join(dir, 'profile'), 'the persistent profile of the settings');
  assert.deepEqual(opts, { headless: true, acceptDownloads: true });
  assert.ok(!fs.existsSync(`${profile}.lock`), 'the profile lock is freed on close');
});

test('the driver: a look for a transcript waits, saves an export with timestamps, refuses one without', async () => {
  const dir = tmp();
  const dest = path.join(dir, 'p-transcript-turboscribe.txt');
  const b = standIn();
  const open = (opts) => createDriver({ site: siteWith(opts).site, settings: settingsWith(dir), chromium: b.chromium }).open();
  let s = await open({ exp: { outcome: 'waiting' } });
  assert.deepEqual(await s.fetch({ ref: { name: '501-p.m4a' }, dest }), { outcome: 'waiting' });
  await s.close();
  assert.ok(!fs.existsSync(dest));
  s = await open({ exp: { outcome: 'done' }, text: 'no timestamps here' });
  assert.deepEqual(await s.fetch({ ref: { name: '501-p.m4a' }, dest }), { outcome: 'failed', reason: 'an unexpected page (no timestamps in the plain-text export)' });
  await s.close();
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.download`), 'nothing left under the transcript\'s name');
  s = await open({ exp: { kind: 'signIn', what: 'x' } });
  assert.deepEqual(await s.fetch({ ref: { name: '501-p.m4a' }, dest }), { outcome: 'failed', reason: REASONS.signIn });
  await s.close();
  s = await open({ exp: { outcome: 'done' } });
  assert.deepEqual(await s.fetch({ ref: { name: '501-p.m4a' }, dest }), { outcome: 'done' });
  await s.close();
  assert.equal(fs.readFileSync(dest, 'utf8'), '(0:00 - 0:04)\nHi\n');
});

test('the driver: a profile in use is busy, not a failure; a browser that does not start is an error with no address query', async () => {
  const dir = tmp();
  const settings = settingsWith(dir);
  fs.mkdirSync(settings.video.browserProfile, { recursive: true });
  const held = takeProfileLock(settings.video.browserProfile);
  assert.ok(held.taken);
  await assert.rejects(createDriver({ site: siteWith().site, settings, chromium: standIn().chromium }).open(), (e) => e instanceof Busy && e.busy);
  held.free();
  // A holder that is gone frees it.
  fs.mkdirSync(`${settings.video.browserProfile}.lock`);
  fs.writeFileSync(path.join(`${settings.video.browserProfile}.lock`, 'owner.json'), JSON.stringify({ pid: 999999 }));
  assert.ok(takeProfileLock(settings.video.browserProfile, { isAlive: () => false }).taken);
  fs.rmSync(`${settings.video.browserProfile}.lock`, { recursive: true });
  await assert.rejects(createDriver({ site: siteWith().site, settings, chromium: standIn({ launchError: new Error('Failed to create a ProcessSingleton for your profile directory') }).chromium }).open(), (e) => e.busy === true);
  await assert.rejects(createDriver({ site: siteWith().site, settings, chromium: standIn({ launchError: new Error('Executable doesn\'t exist at https://x.test/a?token=abc') }).chromium }).open(), (e) => !e.busy && /^the browser did not start: Executable doesn't exist at https:\/\/x\.test\/a$/.test(e.message));
  assert.ok(!fs.existsSync(`${settings.video.browserProfile}.lock`), 'the lock is freed when the browser does not start');
  // The profile folder is the owner's only.
  assert.equal(fs.statSync(settings.video.browserProfile).mode & 0o077, 0);
});

test('the transcribers: turboscribe, and no other name', () => {
  assert.deepEqual(TRANSCRIBERS, ['turboscribe']);
  assert.throws(() => createTranscriber('other', { settings: settingsWith(tmp()) }), /no transcriber named other/);
});

test('the CLI: refused in a role session, and without the two settings', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'ticket-flow.json'), JSON.stringify(rawSettings()));
  const out = { text: '', write(t) { this.text += t; } };
  await assert.rejects(main(['check', '--root', dir], { stdout: out, env: {} }), (e) => e.exitCode === 2 && /video\.transcriber and video\.browserProfile/.test(e.message));
  await assert.rejects(main(['check', '--root', dir], { stdout: out, env: { DOC_TOOLKIT_ROLE_SESSION: 'writer' } }), (e) => e.exitCode === 2 && /role session/.test(e.message));
  await assert.rejects(main(['upload', '--root', dir], { stdout: out, env: {} }), (e) => e.exitCode === 2);
  assert.equal(await main(['--help'], { stdout: out, env: {} }), 0);
  assert.match(out.text, /sign-in/);
});
