import path from 'node:path';
import { abs, listUaPages, localePagePath, readIfExists } from './pages.mjs';
import { cachedBlob } from './plan.mjs';
import { parseFrontmatter, splitCode } from './parse.mjs';

const posix = path.posix;

// The route Docusaurus gives a doc: number prefixes stripped, `folder/folder.md` and `index.md` collapse to the folder,
// a frontmatter `slug` overrides. Returned without locale prefix and baseUrl.
export function docRoute(s, page, uaText) {
  const strip = (seg) => seg.replace(/^\d+\s*[-_.]\s*(?=\S)/, '');
  const segs = page.id.split('/').map(strip);
  const dir = segs.slice(0, -1);
  const fm = parseFrontmatter(uaText.split('\n'));
  const slug = fm?.entries.find((e) => e.key === 'slug')?.scalar;
  let parts;
  if (slug) parts = slug.startsWith('/') ? slug.split('/').filter(Boolean) : [...dir, ...slug.split('/').filter(Boolean)];
  else {
    const last = segs.at(-1);
    parts = last === 'index' || last === 'README' || last.toLowerCase() === 'readme' || last === dir.at(-1) ? dir : segs;
  }
  const prefix = s.urlPrefix.split('/').filter(Boolean);
  const all = [...prefix, ...parts];
  return '/' + all.join('/') + (all.length ? '/' : '');
}

// A page's title: the frontmatter `title`, else its first `#` heading.
export function pageTitle(text) {
  if (text == null) return null;
  const lines = text.split('\n');
  const fm = parseFrontmatter(lines);
  const title = fm?.entries.find((e) => e.key === 'title')?.scalar?.trim();
  if (title) return title;
  const h1 = lines.slice(fm ? fm.end + 1 : 0).find((l) => /^#\s+\S/.test(l));
  return h1 ? h1.replace(/^#\s+/, '').replace(/\s*\{\/\*[\s\S]*?\*\/\}\s*$/, '').trim() : null;
}

// Text links ([text](url), not images) in prose lines, in document order.
const LINK = /(?<!!)\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
export function textLinks(proseLines) {
  const out = [];
  proseLines.forEach((line, i) => {
    for (const m of line.matchAll(LINK)) out.push({ text: m[1], url: m[2], line: i + 1 });
  });
  return out;
}

// Every UA page by route and by path, with its UA title. Built once per run.
const indexes = new WeakMap();
function linkIndex(s) {
  if (!indexes.has(s)) {
    indexes.set(
      s,
      (async () => {
        const byRoute = new Map();
        const byPath = new Map();
        for (const page of (await listUaPages(s)).all) {
          const text = await cachedBlob(s.root, page.blob);
          const entry = { page, uaTitle: pageTitle(text) };
          byRoute.set(docRoute(s, page, text), entry);
          byPath.set(page.path, entry);
        }
        return { byRoute, byPath };
      })(),
    );
  }
  return indexes.get(s);
}

// The UA page a link points to: a route (`/archive/`) or a relative path to a page file (`../archive/archive.md`).
function resolveLink(index, fromPage, url) {
  let clean = url.replace(/[?#].*$/, '');
  try {
    clean = decodeURI(clean);
  } catch {
    /* keep as written */
  }
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  if (clean.startsWith('/')) return index.byRoute.get(clean.endsWith('/') ? clean : clean + '/') ?? null;
  if (/\.mdx?$/.test(clean)) return index.byPath.get(posix.normalize(posix.join(posix.dirname(fromPage.path), clean))) ?? null;
  return null;
}

// Does a link text name a title, in any grammatical form? Same words, each one starting with the title's word minus
// its last `cut(length)` letters (UA inflects by changing the last two letters; the target locales mostly add suffixes,
// so one letter is enough there, and a different word for the page still shows).
const words = (t) =>
  t
    .normalize('NFC')
    .replace(/\*\*|__|[*_`]/g, '')
    .replace(/[«»"“”„.,:;!?()]/g, ' ')
    .toLocaleLowerCase()
    .replace(/\u0307/g, '') // tr/az: a capital İ lowercases to i + a combining dot
    .replace(/ı/g, 'i') // and a capital I to i, where a sentence writes ı
    .split(/\s+/)
    .filter(Boolean);
export const uaCut = (n) => (n <= 3 ? 0 : n === 4 ? 1 : 2);
export const targetCut = (n) => (n <= 3 ? 0 : 1);
export function namesTitle(text, title, cut) {
  const a = words(text);
  const b = words(title);
  if (!a.length || a.length !== b.length) return false;
  return a.every((w, i) => {
    const letters = [...b[i]];
    return w.startsWith(letters.slice(0, letters.length - cut(letters.length)).join(''));
  });
}

// The UA links of `text` whose text names the target page's title, with that page's title in `locale` (null while the
// target has no translation). `nth` counts the links to the same URL before it, so a translated link pairs with it.
export async function titleLinks(s, page, text, locale) {
  const index = await linkIndex(s);
  const out = [];
  const nth = new Map();
  for (const l of textLinks(splitCode(text).prose)) {
    const n = nth.get(l.url) ?? 0;
    nth.set(l.url, n + 1);
    const target = resolveLink(index, page, l.url);
    if (!target?.uaTitle || !namesTitle(l.text, target.uaTitle, uaCut)) continue;
    const title = pageTitle(await readIfExists(abs(s, localePagePath(s, locale, target.page))));
    out.push({ text: l.text, url: l.url, nth: n, line: l.line, page: target.page.id, uaTitle: target.uaTitle, title });
  }
  return out;
}

// For `blocks`: the link rows of the text a worker translates, one per link text and URL.
export async function linkRows(s, page, text, locale) {
  const seen = new Set();
  const rows = [];
  for (const l of await titleLinks(s, page, text, locale)) {
    const id = `${l.url}\0${l.text}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ text: l.text, url: l.url, page: l.page, title: l.title });
  }
  return rows.length ? { links: rows } : {};
}

// For `check`: the translated links that name their target differently from its title (a warning, not a failure).
export function offTitleLinks(expected, proseLines) {
  const byUrl = new Map();
  for (const l of textLinks(proseLines)) byUrl.set(l.url, [...(byUrl.get(l.url) ?? []), l]);
  const off = [];
  for (const e of expected) {
    const t = byUrl.get(e.url)?.[e.nth];
    if (t && e.title && !namesTitle(t.text, e.title, targetCut)) off.push({ line: t.line, text: t.text, url: e.url, title: e.title });
  }
  return off;
}
