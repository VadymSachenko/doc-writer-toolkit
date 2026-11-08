import fs from 'node:fs/promises';
import path from 'node:path';
import { loadImages, measureDom } from './dom.mjs';

const withoutHash = (url) => String(url).split('#')[0];
const fileSlug = (key) => key.replace(/\.mdx?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'page';

// What the run asked the network for. Only the local server is answered; every other request is aborted and counted.
export function newNetworkStats() {
  return { requests: 0, local: 0, blocked: 0, blockedHosts: new Set() };
}

export function networkView(net, server) {
  return { requests: net.requests, local: net.local, blocked: net.blocked, blockedHosts: [...net.blockedHosts].sort(), servedByLocalServer: server.stats.requests };
}

async function captureOne({ browser, server, net, settings, target, shotPath }) {
  const context = await browser.newContext({ viewport: settings.viewport, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const result = { page: target.page.key, locale: target.locale, url: target.url, origin: server.origin, status: null, error: null, shot: null, cropped: false, dom: null, responses: {}, blocked: [] };
  try {
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
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(loadImages, 8000);
    result.dom = await page.evaluate(measureDom);
    const height = Math.min(Math.max(result.dom.pageHeight, settings.viewport.height), settings.maxHeight);
    result.cropped = result.dom.pageHeight > settings.maxHeight;
    await fs.mkdir(path.dirname(shotPath.abs), { recursive: true });
    await page.screenshot({ path: shotPath.abs, fullPage: true, clip: { x: 0, y: 0, width: settings.viewport.width, height } });
    result.shot = shotPath.rel;
  } catch (e) {
    result.error = String(e.message ?? e).split('\n')[0];
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

// Captures every (page, locale) with `settings.jobs` at a time. -> one result per target, in the order of the targets.
export async function captureAll({ browser, server, net, settings, pages, columns, shotsDir, outDir }) {
  const targets = [];
  pages.forEach((page, i) => {
    for (const locale of columns) targets.push({ page, locale, url: page.urls[locale], file: `p${String(i + 1).padStart(2, '0')}-${fileSlug(page.key)}.png` });
  });
  const results = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      const t = targets[i];
      const abs = path.join(shotsDir, t.locale, t.file);
      results[i] = await captureOne({ browser, server, net, settings, target: t, shotPath: { abs, rel: path.relative(outDir, abs).split(path.sep).join('/') } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.jobs, targets.length) }, worker));
  return results;
}
