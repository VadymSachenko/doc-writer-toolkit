import { checkBlocks } from './untranslated.mjs';

// What a finding is. `problem` is something to fix; `look` is something to check by eye and may be right as it is.
export const TYPES = {
  'page-missing': { level: 'problem', title: 'Page not found or not captured' },
  'broken-image': { level: 'problem', title: 'Broken image' },
  'table-overflow': { level: 'problem', title: 'Table wider than the page' },
  untranslated: { level: 'problem', title: 'Text left untranslated' },
  'page-overflow': { level: 'look', title: 'Page scrolls sideways' },
  'kept-label': { level: 'look', title: 'Bold label kept as the source has it' },
};
export const TYPE_ORDER = Object.keys(TYPES);

const MAX_ITEMS = 5;
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shown = (src, origin) => (origin && src.startsWith(origin) ? src.slice(origin.length) : src);
const withoutHash = (url) => String(url).split('#')[0];

// Why an image does not show, or null when it does. `responses` maps a URL to the HTTP status the page got for it and
// `blocked` lists the URLs that were not local and so were not requested.
export function imageProblem(img, responses = {}, blocked = []) {
  const src = withoutHash(img.src);
  if (!src) return 'it has no source';
  if (blocked.includes(src)) return 'it is not served by the site itself (the request was blocked)';
  const status = responses[src];
  if (status >= 400) return `the site answered ${status}`;
  if (img.ok) return null;
  // An SVG with no size of its own reports a width of 0 although it shows.
  if (/\.svg$/i.test(src.split('?')[0]) && status >= 200 && status < 300) return null;
  return 'it did not load or could not be decoded';
}

// A table is too wide when its content is wider than the room it has, or it ends past the right edge of the window.
export const tableTooWide = (t) => t.width > t.available + 1 || t.right > t.viewport + 1;

// The findings of one captured page in one locale. `capture` is what the capture step recorded:
// { status, error, dom: { images, tables, blocks, pageWidth, viewport }, responses, blocked }.
// `source` is the default locale's capture of the same page, `noFile` says the locale has no file of its own for it.
export function analyze({ page, locale, capture, source, sourceLocale, noFile = false }) {
  const found = [];
  const add = (type, detail, items = []) => found.push({ type, level: TYPES[type].level, page: page.key, locale, detail, items });

  if (!capture || capture.error) {
    add('page-missing', capture?.error ? `could not be captured: ${capture.error}` : 'was not captured');
    return found;
  }
  if (capture.status >= 400) {
    add('page-missing', `${page.urls[locale]} answered ${capture.status}`);
    return found;
  }
  const dom = capture.dom;

  const broken = [];
  for (const img of dom.images) {
    const why = imageProblem(img, capture.responses, capture.blocked);
    if (why) broken.push(`${clip(shown(img.src, capture.origin) || '(empty)', 120)}: ${why}`);
  }
  if (broken.length) add('broken-image', `${broken.length} of ${dom.images.length} image${dom.images.length === 1 ? '' : 's'} do not show`, broken.slice(0, MAX_ITEMS));

  const wide = dom.tables.filter(tableTooWide);
  if (wide.length) {
    add(
      'table-overflow',
      `${wide.length} of ${dom.tables.length} table${dom.tables.length === 1 ? '' : 's'} wider than the page`,
      wide.slice(0, MAX_ITEMS).map((t) => `${t.header ? `"${t.header}…" ` : ''}${t.width}px in ${t.available}px (${t.rows} rows)`),
    );
  }
  if (!wide.length && dom.pageWidth > dom.viewport + 1) add('page-overflow', `the page is ${dom.pageWidth}px wide in a ${dom.viewport}px window`);

  if (locale !== sourceLocale) {
    if (noFile) {
      add('untranslated', `no file in this locale: the site shows the ${sourceLocale} text`);
    } else if (source?.dom) {
      const { problems, labels } = checkBlocks({ sourceBlocks: source.dom.blocks, targetBlocks: dom.blocks, locale, sourceLocale });
      if (problems.length) {
        const reasons = { identical: 'same as the source', 'cyrillic-in-latin': 'Cyrillic in a Latin-script locale', 'ukrainian-letters': 'Ukrainian letters' };
        add(
          'untranslated',
          `${problems.length} block${problems.length === 1 ? '' : 's'} not translated`,
          problems.slice(0, MAX_ITEMS).map((p) => `${reasons[p.reason]}: ${clip(p.text)}`),
        );
      }
      if (labels.length) {
        add(
          'kept-label',
          `${labels.length} block${labels.length === 1 ? '' : 's'} with a bold label the same as the source; the app's string may be what the page shows`,
          labels.slice(0, MAX_ITEMS).map((p) => clip(p.text)),
        );
      }
    }
  }
  return found;
}

export function summarizeFindings(findings) {
  const byType = Object.fromEntries(TYPE_ORDER.map((t) => [t, 0]));
  for (const f of findings) byType[f.type] += 1;
  return {
    total: findings.length,
    problems: findings.filter((f) => f.level === 'problem').length,
    look: findings.filter((f) => f.level === 'look').length,
    byType,
  };
}

// Problems before things to look at, then by type, page and the order of the sheet's columns.
export const sortFindings = (findings, columns = []) => {
  const col = (l) => (columns.includes(l) ? columns.indexOf(l) : columns.length);
  return [...findings].sort(
    (a, b) => (a.level === b.level ? 0 : a.level === 'problem' ? -1 : 1) || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.page.localeCompare(b.page) || col(a.locale) - col(b.locale) || a.locale.localeCompare(b.locale),
  );
};
