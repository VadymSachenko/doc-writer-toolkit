// Everything the adapter knows about TurboScribe's pages: the addresses, the selectors, the page checks and the steps of
// an upload and of an export. A change on the site is a change in this file only; lib/driver.mjs knows none of it.
//
// Not verified against the live site when written (its pages sit behind a sign-in and a bot check): the pilot on one
// real video confirms each selector, and a check that misses reads as `unexpected`, never as a pass. No page of the site
// is copied into the tests (its terms forbid reusing its HTML): they run on synthetic pages written for these checks.

export const SITE = { name: 'turboscribe', origin: 'https://turboscribe.ai', dashboard: '/dashboard', login: '/login' };

// Matched case-insensitively against what the page shows. The first kind that matches wins, in this order.
export const CHECKS = {
  // A bot check in front of the site (Cloudflare's "Just a moment…", Turnstile) or a captcha on it.
  captcha: {
    title: [/just a moment/i, /attention required/i],
    text: [/verify you are human/i, /are you a robot/i, /complete the security check/i],
    selectors: ['iframe[src*="challenges.cloudflare.com"]', '.cf-turnstile', '#challenge-form', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]'],
  },
  // The sign-in page, Google's, or a page that asks to sign in again.
  signIn: {
    host: [/(^|\.)accounts\.google\.com$/],
    path: [/^\/login\b/, /^\/signup\b/],
    text: [/sign in with google/i, /continue with google/i, /log in to turboscribe/i],
  },
  // The free plan's day: three files a day.
  limit: {
    text: [/daily limit/i, /reached your (?:free |daily )?limit/i, /limit reached/i, /transcribe more files tomorrow/i, /upgrade to (?:turboscribe )?unlimited to transcribe more/i],
  },
};

// What a signed-in page has and a signed-out one doesn't.
export const SIGNED_IN = ['a[href*="/logout"]', 'a[href*="/account"]', '[data-testid="user-menu"]'];

export const SELECTORS = {
  // The dashboard's button that opens the upload dialog. Some layouts show the file input at once: then it isn't needed.
  openUpload: { role: 'button', name: /transcribe files?/i },
  fileInput: 'input[type="file"]',
  // The dialog's button that starts the transcription.
  submit: { role: 'button', name: /^\s*transcribe\s*$/i },
  // The upload done: the file in the list, or the page of its transcript.
  uploaded: (name) => ({ text: name }),
  // A file in the dashboard's list, by its name: a link to its transcript.
  fileLink: (name) => ({ role: 'link', name }),
  // On a transcript's page: still in work.
  inWork: [/queued/i, /transcribing/i, /processing/i, /in progress/i, /\b\d{1,3}\s?%/],
  // On a transcript's page: the export, its plain-text choice, the timestamps option and the final download button.
  exportButton: { role: 'button', name: /download|export/i },
  txtChoice: { text: /^\s*(txt|plain text|\.txt)\s*$/i },
  timestamps: { role: 'checkbox', name: /timestamps/i },
  // The download button of the options dialog, not the page's own.
  downloadButton: 'dialog button:has-text("Download"), [role="dialog"] button:has-text("Download")',
};

// A TurboScribe plain-text export with timestamps: `(0:00 - 0:05)` before each segment. The import reads only that form
// (scripts/sme-video-context/sme_video_context.py, `parse_turboscribe`), so an export without them is refused.
export const TIMESTAMP = /\(\d+:\d{2}\s*-\s*\d+:\d{2}\)/;

const any = (patterns = [], value = '') => patterns.some((p) => p.test(value));

// What a page is, from a snapshot of it: { host, path, title, text, present: { <selector>: true } }. `expect`: the
// selectors that make it the page the step wants (any of them). Returns { kind } with kind one of `captcha`, `signIn`,
// `limit`, `ok` and `unexpected`.
export function classify(snap, { expect = [] } = {}) {
  const present = (sels = []) => sels.some((s) => snap.present?.[s]);
  if (any(CHECKS.captcha.title, snap.title) || any(CHECKS.captcha.text, snap.text) || present(CHECKS.captcha.selectors)) return { kind: 'captcha' };
  const signedIn = present(SIGNED_IN);
  if (any(CHECKS.signIn.host, snap.host) || any(CHECKS.signIn.path, snap.path) || (!signedIn && any(CHECKS.signIn.text, snap.text))) return { kind: 'signIn' };
  if (any(CHECKS.limit.text, snap.text)) return { kind: 'limit' };
  if (!expect.length || present(expect)) return { kind: 'ok' };
  return { kind: 'unexpected' };
}

// The snapshot `classify` reads: the host and path only (never the query, which can carry a sign-in's parameters),
// the title, the visible text (cut), and which of the selectors are on the page.
export async function snapshotOf(page, extra = []) {
  let host = '';
  let path = '';
  try {
    const u = new URL(page.url());
    host = u.hostname;
    path = u.pathname;
  } catch {
    // about:blank, say
  }
  const title = await page.title().catch(() => '');
  const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 20000);
  const present = {};
  for (const s of [...CHECKS.captcha.selectors, ...SIGNED_IN, ...extra]) present[s] = (await page.locator(s).count().catch(() => 0)) > 0;
  return { host, path, title, text, present };
}

const locate = (page, sel) => (typeof sel === 'string' ? page.locator(sel) : sel.role ? page.getByRole(sel.role, { name: sel.name }) : page.getByText(sel.text));

// One step's page check: the kind, or `ok`. `what`: what the step looks for, for the reason of an unexpected page.
async function check(page, expect, what) {
  const kind = classify(await snapshotOf(page, expect), { expect }).kind;
  return kind === 'ok' ? null : { kind, what };
}

// Opens the dashboard and checks that it is the signed-in one.
export async function openDashboard(page, { origin = SITE.origin, timeoutMs = 60000 } = {}) {
  await page.goto(origin + SITE.dashboard, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  return check(page, SIGNED_IN, 'the signed-in dashboard');
}

// Polls until `ready()` holds, a page check finds a wall (the day's limit can show only after the upload starts), or
// the time is up (an unexpected page: `what` didn't show).
async function until(page, ready, { timeoutMs, everyMs = 1000, what }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await ready().catch(() => false)) return null;
    const wall = await check(page, [], what).catch(() => null);
    if (wall) return wall;
    if (Date.now() > end) return { kind: 'unexpected', what };
    await page.waitForTimeout(everyMs);
  }
}

// Uploads one part under `name`. Resolves null when the site took it, or { kind, what } for the page it stopped on.
export async function uploadFile(page, { file, name, origin = SITE.origin, timeoutMs = 600000 }) {
  const wall = await openDashboard(page, { origin });
  if (wall) return wall;
  const open = locate(page, SELECTORS.openUpload);
  if ((await open.count()) > 0) await open.first().click();
  else if ((await page.locator(SELECTORS.fileInput).count()) === 0) return { kind: 'unexpected', what: 'the upload button on the dashboard' };
  const input = page.locator(SELECTORS.fileInput).first();
  await input.waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
  if ((await page.locator(SELECTORS.fileInput).count()) === 0) return { kind: 'unexpected', what: 'the file field of the upload dialog' };
  await input.setInputFiles({ name, mimeType: 'audio/mp4', buffer: file });
  const submit = locate(page, SELECTORS.submit);
  if ((await submit.count()) === 0) return { kind: 'unexpected', what: 'the transcribe button of the upload dialog' };
  await submit.first().click();
  return until(page, () => locate(page, SELECTORS.uploaded(name)).first().isVisible(), { timeoutMs, what: 'the uploaded file in the list' });
}

// Looks for the transcript of the file uploaded as `name` and, when it is done, saves its plain-text export with
// timestamps as `saveAs(download)` does. Resolves { outcome: 'done' } or { outcome: 'waiting' }, or { kind, what }.
export async function exportText(page, { name, origin = SITE.origin, saveAs, timeoutMs = 120000 }) {
  const wall = await openDashboard(page, { origin });
  if (wall) return wall;
  const link = locate(page, SELECTORS.fileLink(name));
  if ((await link.count()) === 0) return { kind: 'unexpected', what: 'the uploaded file in the list' };
  await link.first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const there = await check(page, [], 'the transcript page');
  if (there) return there;
  const exportButton = locate(page, SELECTORS.exportButton);
  if ((await exportButton.count()) === 0) {
    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    return any(SELECTORS.inWork, text) ? { outcome: 'waiting' } : { kind: 'unexpected', what: 'the download button of the transcript' };
  }
  await exportButton.first().click();
  const txt = locate(page, SELECTORS.txtChoice);
  if ((await txt.count()) === 0) return { kind: 'unexpected', what: 'the plain-text choice of the download' };
  // The choice itself may start the download, or a dialog with the options and a button may come first.
  const downloading = page.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
  await txt.first().click();
  const stamps = locate(page, SELECTORS.timestamps);
  if ((await stamps.count()) > 0 && !(await stamps.first().isChecked())) await stamps.first().check();
  const button = locate(page, SELECTORS.downloadButton);
  if ((await button.count()) > 0) await button.first().click();
  const download = await downloading;
  if (!download) return { kind: 'unexpected', what: 'the download of the plain-text export' };
  await saveAs(download);
  return { outcome: 'done' };
}
