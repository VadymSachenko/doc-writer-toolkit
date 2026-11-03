import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deriveLocaleRoot } from '../../ui-labels/lib/config.mjs';
import { CliError, exists } from '../../ui-labels/lib/util.mjs';

const run = promisify(execFile);
const PAGE_FILE = /\.mdx?$/i;

// The files a git range adds, copies, modifies or renames to (deleted files have no page to show).
export async function changedFiles(root, range) {
  let out;
  try {
    ({ stdout: out } = await run('git', ['-C', root, 'diff', '--name-only', '-z', '--diff-filter=ACMR', '-M', range, '--'], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    throw new CliError(`git could not read the range '${range}' in ${root}: ${(e.stderr || e.message).trim().split('\n')[0]}`, { code: 2 });
  }
  return out.split('\0').filter(Boolean);
}

const stripSlashes = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const inside = (file, dir) => file.startsWith(`${dir}/`);

// The roots a pair's pages live in: the UA content root for the default locale, the locale roots for the others.
export function localeRoots(pair, locales, defaultLocale) {
  const roots = {};
  for (const locale of locales) roots[locale] = stripSlashes(locale === defaultLocale ? pair.ua : deriveLocaleRoot(pair.en, locale));
  return roots;
}

// Which page a changed file is: { pair, locale, rel } where rel is the path under the locale's root. null when the file
// is no page (not Markdown, outside every root, or a partial: a path segment that starts with `_`).
export function classifyFile(file, pairs, locales, defaultLocale) {
  if (!PAGE_FILE.test(file)) return null;
  for (const pair of pairs) {
    const roots = localeRoots(pair, locales, defaultLocale);
    for (const [locale, root] of Object.entries(roots)) {
      if (!inside(file, root)) continue;
      const rel = file.slice(root.length + 1);
      if (rel.split('/').some((s) => s.startsWith('_'))) return null;
      return { pair, locale, rel };
    }
  }
  return null;
}

// `id` and `slug` from the front matter. Only these two are read, and only as plain values.
export function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(id|slug)\s*:\s*(.*?)\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// Docusaurus' default number prefix parser: `01-intro` -> `intro`. A prefix needs a separator and a name after it.
const stripNumberPrefix = (s) => s.replace(/^\d+\s*[-_.]+\s*(?=[^-_.\s])/, '');

// The route Docusaurus gives a docs page: `rel` is the path under the docs root, `urlPrefix` the route base path.
export function docRoute(urlPrefix, rel, fm = {}) {
  const segments = rel.replace(PAGE_FILE, '').split('/');
  const fileName = segments.pop();
  const dirs = segments.map(stripNumberPrefix);
  const name = stripNumberPrefix(fileName);
  const isIndex = ['index', 'readme'].includes(name.toLowerCase()) || name.toLowerCase() === (dirs.at(-1) ?? '').toLowerCase();
  const docId = fm.id || name;
  let slugPath;
  if (fm.slug) slugPath = fm.slug.startsWith('/') ? fm.slug : [...dirs, fm.slug].join('/');
  else slugPath = isIndex ? dirs.join('/') : [...dirs, docId].join('/');
  const clean = slugPath.split('/').filter(Boolean).join('/');
  const prefix = `/${stripSlashes(urlPrefix ?? '/').replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return `${prefix}/${clean}`.replace(/\/+$/, '') || '/';
}

// The URL of a route in a locale of the built site: the default locale at the base URL, the others under `<locale>/`.
export function pageUrl(baseUrl, defaultLocale, locale, route) {
  const lead = locale === defaultLocale ? baseUrl : `${baseUrl}${locale}/`;
  return `${lead}${route.replace(/^\//, '')}`;
}

// The sheet's rows. One page per (pair, path under the root), however many locales' files changed. The page's route in
// a locale comes from that locale's own file (its front matter may differ), else from the default locale's file.
export async function buildPages(root, files, { pairs, columns, knownLocales, defaultLocale, baseUrl }) {
  const byKey = new Map();
  for (const file of files) {
    const hit = classifyFile(file, pairs, knownLocales, defaultLocale);
    if (!hit) continue;
    const key = `${hit.pair.id}:${hit.rel}`;
    const page = byKey.get(key) ?? { key, pair: hit.pair, rel: hit.rel, changedIn: [] };
    page.changedIn.push(hit.locale);
    byKey.set(key, page);
  }
  const pages = [];
  for (const page of [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const roots = localeRoots(page.pair, knownLocales, defaultLocale);
    const fileOf = {};
    const fmOf = {};
    for (const locale of knownLocales) {
      const repoPath = `${roots[locale]}/${page.rel}`;
      if (await exists(path.join(root, repoPath))) {
        fileOf[locale] = repoPath;
        fmOf[locale] = frontMatter(await fs.readFile(path.join(root, repoPath), 'utf8'));
      } else {
        fileOf[locale] = null;
      }
    }
    const fallback = fileOf[defaultLocale] ? defaultLocale : knownLocales.find((l) => fileOf[l]);
    const urls = {};
    const routes = {};
    for (const locale of columns) {
      const from = fileOf[locale] ? locale : fallback;
      routes[locale] = docRoute(page.pair.urlPrefix, page.rel, from ? fmOf[from] : {});
      urls[locale] = pageUrl(baseUrl, defaultLocale, locale, routes[locale]);
    }
    pages.push({ key: page.key, pair: page.pair.id, rel: page.rel, changedIn: [...new Set(page.changedIn)], files: Object.fromEntries(columns.map((l) => [l, fileOf[l]])), routes, urls });
  }
  return pages;
}
