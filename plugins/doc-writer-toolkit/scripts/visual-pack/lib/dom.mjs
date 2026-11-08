// Runs inside the page (Playwright's page.evaluate), so it must not use anything from this module's scope.
// It only reads the DOM and returns plain data; the rules that turn the data into findings are in findings.mjs.

// Lazy images load only when scrolled to. This loads them all, then waits for each to finish or fail.
export async function loadImages(limitMs) {
  const images = [...document.images];
  for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
  await Promise.all(
    images.map((img) =>
      img.complete
        ? null
        : new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, limitMs);
          }),
    ),
  );
  if (document.fonts?.ready) await document.fonts.ready;
}

export function measureDom() {
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  const all = (selector, from = root) => [...from.querySelectorAll(selector)];
  const squash = (s) => (s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

  const images = all('img').map((img) => ({
    src: img.currentSrc || img.getAttribute('src') || '',
    alt: img.getAttribute('alt') || '',
    ok: img.complete && img.naturalWidth > 0,
    naturalWidth: img.naturalWidth,
  }));

  const tables = all('table').map((table) => {
    const parent = table.parentElement;
    const style = getComputedStyle(parent);
    const available = parent.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
    const rect = table.getBoundingClientRect();
    const header = table.querySelector('th, td');
    return {
      width: Math.round(Math.max(table.scrollWidth, rect.width)),
      available: Math.round(available),
      right: Math.round(rect.right),
      viewport: window.innerWidth,
      rows: table.rows.length,
      header: squash(header && header.textContent).slice(0, 60),
    };
  });

  const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, summary';
  const SKIP = 'pre, script, style, svg, button, nav, footer, .hash-link, .sr-only';
  const blocks = [];
  for (const el of all(BLOCKS)) {
    if (el.closest(SKIP)) continue;
    const clone = el.cloneNode(true);
    for (const n of clone.querySelectorAll(`${BLOCKS}, ${SKIP}`)) n.remove();
    const text = squash(clone.textContent);
    if (!text) continue;
    const strong = squash([...clone.querySelectorAll('strong, b')].map((n) => n.textContent).join(' '));
    for (const n of clone.querySelectorAll('strong, b, code, kbd')) n.remove();
    blocks.push({ tag: el.tagName.toLowerCase(), text, plain: squash(clone.textContent), strong });
  }

  const h1 = document.querySelector('h1');
  return {
    title: squash(document.title),
    heading: squash(h1 && h1.textContent),
    images,
    tables,
    blocks,
    pageWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    pageHeight: document.documentElement.scrollHeight,
  };
}
