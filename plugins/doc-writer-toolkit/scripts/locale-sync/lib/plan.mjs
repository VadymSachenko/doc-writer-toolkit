import { blobText } from './git.mjs';
import { diffBodies, diffFrontmatter } from './diff.mjs';
import { parsePage, splitCode, wordCount } from './parse.mjs';

// What does one UA page need in one locale? Pure function of the recorded state and what is on disk.
//   current  recorded source blob equals the committed UA blob and the translation file exists
//   new      never translated: bootstrap (also --overwrite over a hand-made file)
//   stale    translated before: from `base` (incremental) or in full when there is no usable base
//   skipped  a locale file exists but no state does: a manual bootstrap, left alone unless --overwrite
//
// `handMade` is whether an existing target was written by hand. It is the same as `targetExists` for a page. A category's
// entries exist as soon as write-translations has run, so only a message that already differs from UA counts as hand-made.
export function classify({ entry, blob, targetExists, handMade = targetExists, baseExists, overwrite }) {
  const recorded = entry?.sourceBlob;
  if (!recorded) {
    if (handMade && !overwrite) return { state: 'skipped', reason: 'manual-bootstrap', base: null };
    return { state: 'new', reason: handMade ? 'overwrite' : 'bootstrap', base: null };
  }
  if (!targetExists) return { state: 'stale', reason: 'target-missing', base: null };
  if (recorded === blob) return { state: 'current', reason: null, base: null };
  if (!baseExists) return { state: 'stale', reason: 'base-missing', base: null };
  return { state: 'stale', reason: 'source-changed', base: recorded };
}

export const modeOf = (cell) => (cell.state === 'new' || (cell.state === 'stale' && !cell.base) ? 'full' : cell.state === 'stale' ? 'incremental' : null);

const textCache = new Map();
export async function cachedBlob(root, hash) {
  if (!textCache.has(hash)) textCache.set(hash, blobText(root, hash));
  return textCache.get(hash);
}

export const fullWords = (text) => wordCount(splitCode(text).prose.join('\n'));

// Words that have to be translated for a stale cell: the whole page, or the changed blocks only.
export async function estimateWords(s, page, cell) {
  const b = await cachedBlob(s.root, page.blob);
  if (!cell.base) return { words: fullWords(b), changedBlocks: null };
  const a = await cachedBlob(s.root, cell.base);
  const pageA = parsePage(a);
  const pageB = parsePage(b);
  const groups = diffBodies(pageA, pageB);
  const fm = diffFrontmatter(pageA.fm, pageB.fm);
  let words = 0;
  for (const g of groups) {
    if (!g.bNodes.length) continue;
    words += fullWords(pageB.lines.slice(g.bNodes[0].start, g.bNodes.at(-1).end + 1).join('\n'));
  }
  for (const c of fm) if (c.b) words += fullWords(c.b.raw);
  return { words, changedBlocks: groups.length + fm.length };
}
