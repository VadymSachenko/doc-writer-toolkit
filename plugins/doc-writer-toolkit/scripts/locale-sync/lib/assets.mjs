import fs from 'node:fs/promises';
import path from 'node:path';
import { assetRefs, cleanRef, splitCode } from './parse.mjs';
import { abs } from './pages.mjs';
import { cachedBlob } from './plan.mjs';
import { localeRoot } from './settings.mjs';

const posix = path.posix;

// `.assets` files a UA page references, as paths relative to the UA content root.
export function assetsOf(page, uaText) {
  const out = [];
  for (const ref of assetRefs(splitCode(uaText).prose)) {
    const rel = posix.normalize(posix.join(posix.dirname(page.rel), cleanRef(ref)));
    if (rel.startsWith('..')) out.push({ ref, asset: null, problem: 'outside the UA content root' });
    else if (rel.split('/').includes('.assets')) out.push({ ref, asset: rel });
  }
  return out;
}

const statFile = async (p) => {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
};
const lstat = (p) => fs.lstat(p).catch(() => null);

async function placeLink(linkAbs, target, { replace, dryRun }) {
  if (dryRun) return;
  const rel = path.relative(path.dirname(linkAbs), target);
  await fs.mkdir(path.dirname(linkAbs), { recursive: true });
  if (!replace) {
    await fs.symlink(rel, linkAbs);
    return;
  }
  const tmp = `${linkAbs}.tmp-${process.pid}`;
  await fs.symlink(rel, tmp);
  await fs.rename(tmp, linkAbs);
}

// Per-file relative symlinks: <locale root>/<dir>/.assets/<file> -> <EN root>/<dir>/.assets/<file>.
// A real file at that path is a deliberate locale override and is never touched. With no EN asset the link falls
// back to the UA asset and is reported, so the next run can repoint it.
export async function linkAssets(s, page, locale, allPages, { dryRun = false } = {}) {
  const uaText = await cachedBlob(s.root, page.blob);
  const items = assetsOf(page, uaText);
  const links = [];
  const fallbacks = [];

  for (const it of items) {
    if (!it.asset) {
      links.push({ ref: it.ref, status: 'skipped', problem: it.problem });
      continue;
    }
    const uaAbs = abs(s, posix.join(s.ua, it.asset));
    const enAbs = abs(s, posix.join(s.en, it.asset));
    const linkAbs = abs(s, posix.join(localeRoot(s, locale), it.asset));
    const entry = { asset: it.asset, link: posix.join(localeRoot(s, locale), it.asset) };
    const existing = await lstat(linkAbs);

    if (existing && !existing.isSymbolicLink()) {
      links.push({ ...entry, status: 'override', note: 'a real file: kept as the locale override' });
      continue;
    }
    const target = (await statFile(enAbs)) ? enAbs : (await statFile(uaAbs)) ? uaAbs : null;
    if (!target) {
      links.push({ ...entry, status: 'missing', problem: 'neither the EN nor the UA asset exists' });
      continue;
    }
    const fallback = target === uaAbs;
    if (fallback) fallbacks.push(it.asset);
    entry.target = path.relative(path.dirname(linkAbs), target);
    entry.fallback = fallback;

    if (!existing) {
      await placeLink(linkAbs, target, { replace: false, dryRun });
      links.push({ ...entry, status: dryRun ? 'would-create' : 'created' });
      continue;
    }
    const current = path.resolve(path.dirname(linkAbs), await fs.readlink(linkAbs));
    if (current === target) links.push({ ...entry, status: 'unchanged' });
    else if (current === enAbs || current === uaAbs) {
      await placeLink(linkAbs, target, { replace: true, dryRun });
      links.push({ ...entry, status: dryRun ? 'would-repoint' : 'repointed' });
    } else {
      const resolves = await statFile(current);
      links.push({ ...entry, status: resolves ? 'foreign' : 'foreign-dangling', note: 'a symlink that points somewhere else: left alone' });
    }
  }

  // Symlinks next to the page that no UA page in the folder references any more. Reported, never deleted.
  const referenced = new Set();
  for (const p of allPages.filter((q) => posix.dirname(q.rel) === posix.dirname(page.rel))) {
    const text = p.id === page.id ? uaText : await cachedBlob(s.root, p.blob);
    for (const a of assetsOf(p, text)) if (a.asset) referenced.add(a.asset);
  }
  const orphans = [];
  const assetsDir = abs(s, posix.join(localeRoot(s, locale), posix.dirname(page.rel), '.assets'));
  let names = [];
  try {
    names = await fs.readdir(assetsDir, { withFileTypes: true });
  } catch {
    /* no .assets folder yet */
  }
  for (const d of names) {
    const asset = posix.join(posix.dirname(page.rel), '.assets', d.name);
    if (d.isSymbolicLink() && !referenced.has(asset)) orphans.push({ asset, link: posix.join(localeRoot(s, locale), asset) });
  }

  return { page: page.id, locale, links, assetFallbacks: fallbacks, orphans };
}

// Asset references of a translated page that currently point at the UA fallback (for the recorded `assetFallbacks`).
export async function currentFallbacks(s, page, locale, uaText) {
  const out = [];
  for (const it of assetsOf(page, uaText)) {
    if (!it.asset) continue;
    const linkAbs = abs(s, posix.join(localeRoot(s, locale), it.asset));
    const st = await lstat(linkAbs);
    if (!st?.isSymbolicLink()) continue;
    const current = path.resolve(path.dirname(linkAbs), await fs.readlink(linkAbs));
    if (current === abs(s, posix.join(s.ua, it.asset))) out.push(it.asset);
  }
  return out;
}
