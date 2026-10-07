import path from 'node:path';
import { exists, readJson } from '../../ui-labels/lib/util.mjs';
import { existingBlobs, headCommit, uncommitted } from './git.mjs';
import { abs, listUaPages, localePagePath, readState, statePath, walkFiles } from './pages.mjs';
import { resolveTargets, selectorMatches, selectPages, localeRoot } from './settings.mjs';
import { cachedBlob, classify, estimateWords, fullWords, modeOf } from './plan.mjs';
import { parseCategory, readCategoryTarget } from './categories.mjs';

const CONFIRM_OVER = 10;
const posix = path.posix;
const roundWords = (n) => (n < 1000 ? n : Math.round(n / 100) * 100);
const hidden = (seg) => seg.startsWith('.') || seg.startsWith('_');
// A page or category file that is in scope for translation (not under .sources, not a `_partial.md`).
function isUnitFile(file) {
  const category = /(^|\/)_category_\.json$/.test(file);
  if (!category && !/\.(md|mdx)$/.test(file)) return false;
  const segs = file.split('/');
  return !segs.slice(0, -1).some(hidden) && (category || !hidden(segs.at(-1)));
}
const unitId = (s, file) => posix.relative(s.ua, file).replace(/\.(md|mdx|json)$/, '');

// Stale pages per locale. Scripts only: one `git ls-tree`, the per-unit state files, and file existence.
// A unit is a page, or a sidebar category (`_category_.json`), whose translation lives in the locale's current.json.
export async function runStatus(s, { selectors = [], overwrite = false, threshold = CONFIRM_OVER } = {}) {
  const { targets, warnings: targetWarnings } = await resolveTargets(s);
  const head = await headCommit(s.root);
  const { all, inScope, categories, categoriesInScope, unsupported } = await listUaPages(s);
  const units = selectPages(s, [...inScope, ...categoriesInScope], selectors);
  const warnings = [...targetWarnings];
  for (const f of unsupported) warnings.push(`${f} is a YAML category file: only _category_.json files are tracked, so its label is not translated by this process.`);

  // Only committed content is translated (Requirement 4, criterion 7).
  const unitPaths = new Set(units.map((p) => p.path));
  const known = new Set([...all, ...categories].map((p) => p.path));
  for (const f of await uncommitted(s.root, s.ua)) {
    if (!isUnitFile(f.path)) continue;
    const inRun = unitPaths.has(f.path) || (!known.has(f.path) && (!selectors.length || selectors.some((sel) => selectorMatches(s, { path: f.path, id: unitId(s, f.path) }, sel))));
    if (inRun) warnings.push(`Uncommitted UA change in ${f.path} (${f.status}). Only the committed version is translated: commit the SME-approved text first.`);
  }

  // Which recorded base blobs still exist in the repository?
  const states = new Map();
  for (const p of units) states.set(p.id, await readState(s, p.id));
  const recorded = [...states.values()].flatMap((st) => Object.values(st.locales).map((e) => e?.sourceBlob));
  const present = await existingBlobs(s.root, recorded);

  const rows = [];
  const tally = () => ({ new: 0, stale: 0, current: 0, skipped: 0 });
  const cells = tally();
  const categoryCells = tally();
  const staleLocales = new Set();
  const stalePageLocales = new Set();
  const stalePages = new Set();
  const staleCategories = new Set();
  let words = 0;
  let anyState = false;
  for (const unit of units) {
    const st = states.get(unit.id);
    const category = unit.kind === 'category';
    const parsed = category ? parseCategory(await cachedBlob(s.root, unit.blob)) : null;
    if (category && (parsed.error || !parsed.fields.length)) {
      if (parsed.error) warnings.push(`${unit.path} is not valid JSON (${parsed.error}): its label is not translated by this process.`);
      continue;
    }
    const row = { kind: unit.kind, page: unit.id, path: unit.path, blob: unit.blob, locales: {} };
    for (const locale of targets) {
      const entry = st.locales[locale];
      if (entry?.sourceBlob) anyState = true;
      let file;
      let cell;
      let target = null;
      if (category) {
        target = await readCategoryTarget(s, locale, parsed);
        file = target.file;
        cell = classify({ entry, blob: unit.blob, targetExists: target.exists, handMade: target.handMade, baseExists: true, overwrite });
      } else {
        file = localePagePath(s, locale, unit);
        const targetExists = await exists(abs(s, file));
        cell = classify({ entry, blob: unit.blob, targetExists, baseExists: present.has(entry?.sourceBlob), overwrite });
      }
      // A category is always translated whole: there is no incremental mode.
      const mode = category && cell.state !== 'current' && cell.state !== 'skipped' ? 'full' : modeOf(cell);
      const out = { state: cell.state, reason: cell.reason, base: category ? null : cell.base, mode, file, targetExists: category ? target.exists : await exists(abs(s, file)) };
      if (cell.state === 'new' || cell.state === 'stale') {
        const est = category ? { words: parsed.fields.reduce((n, f) => n + fullWords(f.ua), 0), changedBlocks: null } : await estimateWords(s, unit, cell);
        out.words = est.words;
        out.changedBlocks = est.changedBlocks;
        words += est.words;
        staleLocales.add(locale);
        if (!category) stalePageLocales.add(locale);
        (category ? staleCategories : stalePages).add(unit.id);
        if (cell.reason === 'base-missing') warnings.push(`${unit.id} [${locale}]: the recorded source blob ${entry.sourceBlob.slice(0, 7)} is not in this repository, so the whole page will be re-translated.`);
        if (category && target.error) warnings.push(`${file} is not valid JSON (${target.error}).`);
      }
      (category ? categoryCells : cells)[cell.state]++;
      row.locales[locale] = out;
    }
    rows.push(row);
  }

  const { orphaned, moved } = await findOrphans(s, all, categories, targets);
  const needing = cells.new + cells.stale;
  const categoryNeeding = categoryCells.new + categoryCells.stale;
  const message =
    `${stalePages.size} pages × ${stalePageLocales.size} languages = ${needing} page translations` +
    (categoryNeeding ? `, plus ${categoryNeeding} sidebar category translations` : '') +
    `, about ${roundWords(words).toLocaleString('en-US')} words`;
  return {
    root: s.root,
    head,
    uaRoot: s.ua,
    locales: targets,
    summary: {
      pages: units.filter((u) => u.kind === 'page').length,
      stalePages: stalePages.size,
      languages: staleLocales.size,
      pageTranslations: needing,
      words,
      ...cells,
      categories: { total: rows.filter((r) => r.kind === 'category').length, stale: staleCategories.size, translations: categoryNeeding, ...categoryCells },
      bootstrap: !anyState && needing + categoryNeeding > 0,
      threshold,
      needsConfirmation: stalePages.size > threshold,
      message,
    },
    pages: rows,
    orphaned,
    moved,
    warnings,
  };
}

// Units deleted or moved in UA. Reported only: nothing is deleted or moved (moving is Phase 2).
async function findOrphans(s, allPages, categories, targets) {
  const ids = new Set([...allPages, ...categories].map((p) => p.id));
  const byBlob = new Map(allPages.map((p) => [p.blob, p])); // a moved page is recognised by its blob; small category files are not unique enough
  const found = new Map(); // id -> { page, locales:Set, files:[], state }

  const note = (id) => {
    if (!found.has(id)) found.set(id, { page: id, locales: new Set(), files: [], state: null });
    return found.get(id);
  };

  const pagesDir = path.join(s.stateRoot, 'pages');
  for (const file of await walkFiles(pagesDir, (n) => n.endsWith('.json'))) {
    const id = path.relative(pagesDir, file).replace(/\.json$/, '').split(path.sep).join('/');
    if (ids.has(id)) continue;
    const st = await readJson(file);
    const o = note(id);
    o.state = path.relative(s.root, file).split(path.sep).join('/');
    for (const l of Object.keys(st?.locales ?? {})) if (targets.includes(l)) o.locales.add(l);
    o.blobs = Object.values(st?.locales ?? {}).map((e) => e?.sourceBlob).filter(Boolean);
  }
  for (const locale of targets) {
    const root = abs(s, localeRoot(s, locale));
    for (const file of await walkFiles(root, (n) => /\.(md|mdx)$/.test(n))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel.split('/').some((seg) => seg.startsWith('.') || seg.startsWith('_'))) continue;
      const id = rel.replace(/\.(md|mdx)$/, '');
      if (ids.has(id)) continue;
      const o = note(id);
      o.locales.add(locale);
      o.files.push(posix.join(localeRoot(s, locale), rel));
    }
  }

  const orphaned = [];
  const moved = [];
  for (const o of found.values()) {
    const target = /(^|\/)_category_$/.test(o.page) ? null : (o.blobs ?? []).map((b) => byBlob.get(b)).find(Boolean);
    const out = { page: o.page, locales: [...o.locales].sort(), files: o.files, state: o.state };
    if (target && !(await exists(statePath(s, target.id)))) moved.push({ from: o.page, to: target.id, locales: out.locales, note: 'locale files and state were not moved (Phase 2); the new path will be translated from scratch' });
    else orphaned.push(out);
  }
  return { orphaned, moved };
}
