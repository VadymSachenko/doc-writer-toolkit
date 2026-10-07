import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../../ui-labels/lib/util.mjs';
import { lsTree } from './git.mjs';
import { localeRoot, scopeSelectors, selectorMatches } from './settings.mjs';

const posix = path.posix;

// Docusaurus ignores `_`-prefixed files and folders, and `.sources` / `.assets` hold inputs and images, not pages.
const isHidden = (rel) => rel.split('/').some((seg) => seg.startsWith('.') || seg.startsWith('_'));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every UA page committed at HEAD under the UA content root: { kind: 'page', id, path, rel, ext, blob }.
// Sidebar category files (`_category_.json`) are listed separately as { kind: 'category', … }: they are translated into the
// locale's current.json, not into a file of their own. YAML category files are returned in `unsupported`.
export async function listUaPages(s) {
  const files = await lsTree(s.root, s.ua);
  const all = [];
  const categories = [];
  const unsupported = [];
  for (const [file, blob] of files) {
    const rel = posix.relative(s.ua, file);
    if (rel.startsWith('..') || isHidden(posix.dirname(rel) === '.' ? '' : posix.dirname(rel))) continue;
    const cat = rel.match(/(^|\/)_category_\.(json|ya?ml)$/);
    if (cat) {
      if (cat[2] === 'json') categories.push({ kind: 'category', id: rel.slice(0, -'.json'.length), path: file, rel, ext: '.json', blob });
      else unsupported.push(file);
      continue;
    }
    const m = file.match(/\.(md|mdx)$/);
    if (!m || isHidden(rel)) continue;
    all.push({ kind: 'page', id: rel.slice(0, -m[0].length), path: file, rel, ext: m[0], blob });
  }
  all.sort(byId);
  categories.sort(byId);
  const selectors = scopeSelectors(s);
  const pick = (list) => (selectors ? list.filter((p) => selectors.some((sel) => selectorMatches(s, p, sel))) : list);
  return { all, inScope: pick(all), categories, categoriesInScope: pick(categories), unsupported };
}

export const localePagePath = (s, locale, page) => posix.join(localeRoot(s, locale), page.rel);
export const enPagePath = (s, page) => posix.join(s.en, page.rel);
export const abs = (s, repoRel) => path.resolve(s.root, repoRel);
export const statePath = (s, id) => path.join(s.stateRoot, 'pages', `${id}.json`);

export async function readState(s, id) {
  const state = (await readJson(statePath(s, id))) ?? {};
  return { ...state, spans: state.spans ?? {}, locales: state.locales ?? {} };
}

export async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function walkFiles(dir, accept) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full, accept)));
    else if (accept(e.name)) out.push(full);
  }
  return out;
}
