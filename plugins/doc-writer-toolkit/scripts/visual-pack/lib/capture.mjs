import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../ui-labels/lib/util.mjs';
import { loadImages, measureDom } from './dom.mjs';

const withoutHash = (url) => String(url).split('#')[0];

// A view's fixed waits: the network going idle after the load, and the images (dom.mjs, loadImages).
const NETWORK_IDLE_MS = 5000;
const IMAGES_MS = 8000;
// The longest a view waits when each of its waits may take `timeoutMs`: the load, the screenshot and the fixed waits.
export const worstViewMs = (timeoutMs) => 2 * timeoutMs + NETWORK_IDLE_MS + IMAGES_MS;
// Views captured at once on the retry, at most. In the measured pack, two at a time captured 63 of 80 views even with
// the screenshot held to 30 s; the retry gives each wait more time than that (--retry-timeout).
export const RETRY_JOBS = 2;

const fileSlug = (key) => key.replace(/\.mdx?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'page';

// What the run asked the network for. Only the local server is answered; every other request is aborted and counted.
export function newNetworkStats() {
  return { requests: 0, local: 0, blocked: 0, blockedHosts: new Set() };
}

export function networkView(net, server) {
  return { requests: net.requests, local: net.local, blocked: net.blocked, blockedHosts: [...net.blockedHosts].sort(), servedByLocalServer: server.stats.requests };
}

async function captureOne({ browser, server, net, settings, target, shotPath }) {
  const result = { page: target.page.key, locale: target.locale, url: target.url, origin: server.origin, status: null, error: null, shot: null, cropped: false, dom: null, responses: {}, blocked: [], retried: false, firstError: null };
  let context;
  try {
    // Inside the try: a browser that died makes this view's error, not the end of the run.
    context = await browser.newContext({ viewport: settings.viewport, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' });
    // Every wait of the view gets the run's timeout, the screenshot's too. A Playwright action given none keeps
    // Playwright's own 30 s whatever --timeout says: a whole pack run again at 180 s still lost 17 views that way.
    context.setDefaultTimeout(settings.timeoutMs);
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      net.requests += 1;
      const url = route.request().url();
      let origin = null;
      try {
        origin = new URL(url).origin;
      } catch {
        // an unparsable URL is not local
      }
      try {
        if (origin === server.origin) {
          net.local += 1;
          await route.continue();
        } else {
          net.blocked += 1;
          try {
            net.blockedHosts.add(new URL(url).host);
          } catch {
            net.blockedHosts.add('(unparsable)');
          }
          result.blocked.push(withoutHash(url));
          await route.abort('blockedbyclient');
        }
      } catch {
        // the page was closed while the request was in flight
      }
    });
    page.on('response', (response) => {
      result.responses[withoutHash(response.url())] = response.status();
    });
    const response = await page.goto(server.origin + encodeURI(target.url), { waitUntil: 'load', timeout: settings.timeoutMs });
    result.status = response ? response.status() : null;
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});
    await page.evaluate(loadImages, IMAGES_MS);
    result.dom = await page.evaluate(measureDom);
    const height = Math.min(Math.max(result.dom.pageHeight, settings.viewport.height), settings.maxHeight);
    result.cropped = result.dom.pageHeight > settings.maxHeight;
    await fs.mkdir(path.dirname(shotPath.abs), { recursive: true });
    await page.screenshot({ path: shotPath.abs, fullPage: true, clip: { x: 0, y: 0, width: settings.viewport.width, height }, timeout: settings.timeoutMs });
    result.shot = shotPath.rel;
  } catch (e) {
    result.error = String(e.message ?? e).split('\n')[0];
  } finally {
    await context?.close().catch(() => {});
  }
  return result;
}

// A view to capture again: it failed with an error (a timeout, a crash), not with an answer. A page that answered 4xx
// or 5xx is a finding as it stands, even when its screenshot failed too.
export const failedToCapture = (result) => Boolean(result.error) && !(result.status >= 400);

// Captures every (page, locale) with `settings.jobs` at a time. Then each view that failed to capture is captured once
// more, with more time for each wait (`settings.retryTimeoutMs`), RETRY_JOBS at a time, after all the others. The retry
// starts a view only while its worst case still ends within `settings.retryBudgetMs` of the retry's start; a view it
// cannot start stays as first reported (`retrySkipped`). A retried result says so (`retried`, and the first try's
// `firstError`). `clock` is for the tests.
// -> { captures: one result per target, in the order of the targets; retrySeconds: the second pass, null when none }.
export async function captureAll({ browser, server, net, settings, pages, columns, shotsDir, outDir, clock = Date.now }) {
  const targets = [];
  pages.forEach((page, i) => {
    for (const locale of columns) targets.push({ page, locale, url: page.urls[locale], file: `p${String(i + 1).padStart(2, '0')}-${fileSlug(page.key)}.png` });
  });
  const shoot = (t, s = settings) => {
    const abs = path.join(shotsDir, t.locale, t.file);
    return captureOne({ browser, server, net, settings: s, target: t, shotPath: { abs, rel: path.relative(outDir, abs).split(path.sep).join('/') } });
  };
  const results = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      results[i] = await shoot(targets[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.jobs, targets.length) }, worker));

  const queue = results.flatMap((r, i) => (failedToCapture(r) ? [i] : []));
  if (!queue.length) return { captures: results, retrySeconds: null };
  const retry = { ...settings, timeoutMs: settings.retryTimeoutMs ?? settings.timeoutMs };
  const started = clock();
  const deadline = started + (settings.retryBudgetMs ?? Infinity);
  const jobs = Math.min(RETRY_JOBS, settings.jobs, queue.length);
  log(`visual-pack: capturing again ${queue.length} page view${queue.length === 1 ? '' : 's'} that failed, ${jobs} at a time, up to ${retry.timeoutMs / 1000} s a wait …`);
  const retryWorker = async () => {
    while (queue.length && clock() + worstViewMs(retry.timeoutMs) <= deadline) {
      const i = queue.shift();
      results[i] = { ...(await shoot(targets[i], retry)), retried: true, firstError: results[i].error };
    }
  };
  await Promise.all(Array.from({ length: jobs }, retryWorker));
  for (const i of queue) results[i] = { ...results[i], retrySkipped: true };
  return { captures: results, retrySeconds: Math.round((clock() - started) / 100) / 10 };
}
