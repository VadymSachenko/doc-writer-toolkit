import path from 'node:path';
import { exists, readJson } from '../../ui-labels/lib/util.mjs';
import { existingBlobs, headCommit, uncommitted } from './git.mjs';
import { abs, listUaPages, localePagePath, makeUnit, readState, statePath, walkFiles } from './pages.mjs';
import { resolveTargets, resolveSelector, selectPages, localeRoot } from './settings.mjs';
import { cachedBlob, classify, estimateWords, fullWords, modeOf } from './plan.mjs';
import { parseCategory, readCategoryTarget } from './categories.mjs';
import { sidebarOverrides, sidebarWarning } from './sidebar.mjs';

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
const unitId = (ps, file) => posix.relative(ps.ua, file).replace(/\.(md|mdx|json)$/, '');
const pairLabel = (ps) => ps.pair.name ?? ps.pair.id;

// Stale pages per locale. Scripts only: one `git ls-tree` per root pair, the per-unit state files, and file existence.
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
  for (const ps of s.pairs) {
    for (const f of await uncommitted(s.root, ps.ua)) {
      if (!isUnitFile(f.path)) continue;
      const reached = () => selectors.some((sel) => resolveSelector(s, [makeUnit(ps, { path: f.path, id: unitId(ps, f.path) })], sel).hits.length);
      const inRun = unitPaths.has(f.path) || (!known.has(f.path) && (!selectors.length || reached()));
      if (inRun) warnings.push(`Uncommitted UA change in ${f.path} (${f.status}). Only the committed version is translated: commit the SME-approved text first.`);
    }
  }

  // Which recorded base blobs still exist in the repository?
  const states = new Map();
  for (const p of units) states.set(p.ref, await readState(p));
  const recorded = [...states.values()].flatMap((st) => Object.values(st.locales).map((e) => e?.sourceBlob));
  const present = await existingBlobs(s.root, recorded);
  // Units of every declared pair, also when --pair narrows the run: for the notes on states of another pair.
  const narrowed = s.pairs.length < s.declaredPairs.length;
  const declared = narrowed ? await listUaPages(s, s.declaredPairs) : { all, categories };
  const everyUnit = [...declared.all, ...declared.categories];
  if (s.multiPair) warnings.push(...(await foreignStates(s, units, states, everyUnit)));

  const rows = [];
  const tally = () => ({ new: 0, stale: 0, current: 0, skipped: 0 });
  const cells = tally();
  const categoryCells = tally();
  const staleLocales = new Set();
  const stalePageLocales = new Set();
  const stalePages = new Set();
  const staleCategories = new Set();
  const byPair = new Map(s.pairs.map((ps) => [ps.pair.id, { pages: 0, stalePages: new Set(), pageTranslations: 0, categoryTranslations: 0, words: 0 }]));
  let words = 0;
  let anyState = false;
  for (const unit of units) {
    const st = states.get(unit.ref);
    const category = unit.kind === 'category';
    const parsed = category ? parseCategory(await cachedBlob(s.root, unit.blob)) : null;
    if (category && (parsed.error || !parsed.fields.length)) {
      if (parsed.error) warnings.push(`${unit.path} is not valid JSON (${parsed.error}): its label is not translated by this process.`);
      continue;
    }
    const pairTally = byPair.get(unit.ps.pair.id);
    if (!category) pairTally.pages++;
    const row = { kind: unit.kind, page: unit.ref, path: unit.path, blob: unit.blob, locales: {} };
    for (const locale of targets) {
      const entry = st.locales[locale];
      if (entry?.sourceBlob) anyState = true;
      let file;
      let cell;
      let target = null;
      if (category) {
        target = await readCategoryTarget(unit.ps, locale, parsed);
        file = target.file;
        cell = classify({ entry, blob: unit.blob, targetExists: target.exists, handMade: target.handMade, baseExists: true, overwrite });
      } else {
        file = localePagePath(locale, unit);
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
        pairTally.words += est.words;
        staleLocales.add(locale);
        if (!category) stalePageLocales.add(locale);
        (category ? staleCategories : stalePages).add(unit.ref);
        if (category) pairTally.categoryTranslations++;
        else {
          pairTally.stalePages.add(unit.ref);
          pairTally.pageTranslations++;
        }
        if (cell.reason === 'base-missing') warnings.push(`${unit.ref} [${locale}]: the recorded source blob ${entry.sourceBlob.slice(0, 7)} is not in this repository, so the whole page will be re-translated.`);
        if (category && target.error) warnings.push(`${file} is not valid JSON (${target.error}).`);
      }
      (category ? categoryCells : cells)[cell.state]++;
      row.locales[locale] = out;
    }
    rows.push(row);
  }

  const orphaned = [];
  const moved = [];
  const sidebarLabels = [];
  for (const ps of s.pairs) {
    const mine = (list) => list.filter((u) => u.ps === ps);
    const found = await findOrphans(s, ps, mine(all), mine(categories), targets, everyUnit);
    orphaned.push(...found.orphaned);
    moved.push(...found.moved);
    sidebarLabels.push(...(await sidebarOverrides(s, ps, targets, mine(categories))));
  }
  for (const o of sidebarLabels) warnings.push(sidebarWarning(o));
  const needing = cells.new + cells.stale;
  const categoryNeeding = categoryCells.new + categoryCells.stale;
  const message =
    `${stalePages.size} pages × ${stalePageLocales.size} languages = ${needing} page translations` +
    (categoryNeeding ? `, plus ${categoryNeeding} sidebar category translations` : '') +
    `, about ${roundWords(words).toLocaleString('en-US')} words`;
  return {
    root: s.root,
    head,
    uaRoot: s.pairs[0].ua,
    ...(s.multiPair ? { pairs: s.pairs.map(describePair) } : {}),
    locales: targets,
    summary: {
      pages: units.filter((u) => u.kind === 'page').length,
      stalePages: stalePages.size,
      languages: staleLocales.size,
      pageTranslations: needing,
      words,
      ...cells,
      categories: { total: rows.filter((r) => r.kind === 'category').length, stale: staleCategories.size, translations: categoryNeeding, ...categoryCells },
      ...(s.multiPair
        ? { byPair: Object.fromEntries([...byPair].map(([id, t]) => [id, { pages: t.pages, stalePages: t.stalePages.size, pageTranslations: t.pageTranslations, categoryTranslations: t.categoryTranslations, words: t.words }])) }
        : {}),
      bootstrap: !anyState && needing + categoryNeeding > 0,
      threshold,
      needsConfirmation: stalePages.size > threshold,
      message,
    },
    pages: rows,
    orphaned,
    moved,
    sidebarLabels,
    warnings,
  };
}

export const describePair = (ps) => ({ id: ps.pair.id, name: ps.pair.name, uaRoot: ps.ua, enRoot: ps.en, urlPrefix: ps.urlPrefix, states: path.relative(ps.root, ps.statesDir).split(path.sep).join('/') });

// A primary state file can only be the primary page's: every other pair keeps its states in its own folder. One written
// against another pair's roots (a run with --ua-root/--en-root pointed at them) still records that pair's blobs. It
// stays with the primary page; the warning says what it holds.
async function foreignStates(s, units, states, everyUnit) {
  const out = [];
  for (const unit of units) {
    if (!unit.ps.pair.primary) continue;
    const others = everyUnit.filter((u) => u.ps !== unit.ps && u.id === unit.id && u.kind === unit.kind);
    if (!others.length) continue;
    const st = states.get(unit.ref);
    for (const other of others) {
      const locales = Object.entries(st.locales).filter(([, e]) => e?.sourceBlob && e.sourceBlob !== unit.blob && e.sourceBlob === other.blob).map(([l]) => l);
      if (!locales.length) continue;
      const file = path.relative(s.root, statePath(unit)).split(path.sep).join('/');
      out.push(
        `${file} records the UA blob of ${other.path} (${pairLabel(other.ps)}) for ${locales.join(', ')}, not that of ${unit.path}: it was written against the other pair's roots. ` +
          `It stays with ${unit.ref}, whose cells are computed from it; ${other.ref} has its own state (${path.relative(s.root, statePath(other)).split(path.sep).join('/')}).`,
      );
    }
  }
  return out;
}

// Units of one pair deleted or moved in UA. Reported only: nothing is deleted or moved (moving is Phase 2).
async function findOrphans(s, ps, allPages, categories, targets, everyUnit) {
  const ids = new Set([...allPages, ...categories].map((p) => p.id));
  const byBlob = new Map(allPages.map((p) => [p.blob, p])); // a moved page is recognised by its blob; small category files are not unique enough
  const found = new Map(); // id -> { page, locales:Set, files:[], state }
  const ref = (id) => (s.multiPair ? `${ps.pair.id}:${id}` : id);

  const note = (id) => {
    if (!found.has(id)) found.set(id, { page: ref(id), locales: new Set(), files: [], state: null });
    return found.get(id);
  };

  for (const file of await walkFiles(ps.statesDir, (n) => n.endsWith('.json'))) {
    const id = path.relative(ps.statesDir, file).replace(/\.json$/, '').split(path.sep).join('/');
    if (ids.has(id)) continue;
    const st = await readJson(file);
    const o = note(id);
    o.state = path.relative(s.root, file).split(path.sep).join('/');
    for (const l of Object.keys(st?.locales ?? {})) if (targets.includes(l)) o.locales.add(l);
    o.blobs = Object.values(st?.locales ?? {}).map((e) => e?.sourceBlob).filter(Boolean);
    // A primary state file named like a unit of another pair: that unit's state is in its own pair's folder.
    if (ps.pair.primary) {
      const twin = everyUnit.find((u) => !u.ps.pair.primary && u.id === id);
      if (twin) o.note = `no ${pairLabel(ps)} unit has this id; ${twin.ref} keeps its state in ${path.relative(s.root, statePath(twin)).split(path.sep).join('/')}, so this file is not read for it`;
    }
  }
  for (const locale of targets) {
    const root = abs(s, localeRoot(ps, locale));
    for (const file of await walkFiles(root, (n) => /\.(md|mdx)$/.test(n))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel.split('/').some((seg) => seg.startsWith('.') || seg.startsWith('_'))) continue;
      const id = rel.replace(/\.(md|mdx)$/, '');
      if (ids.has(id)) continue;
      const o = note(id);
      o.locales.add(locale);
      o.files.push(posix.join(localeRoot(ps, locale), rel));
    }
  }

  const orphaned = [];
  const moved = [];
  for (const [id, o] of found) {
    const target = /(^|\/)_category_$/.test(id) ? null : (o.blobs ?? []).map((b) => byBlob.get(b)).find(Boolean);
    const out = { page: o.page, locales: [...o.locales].sort(), files: o.files, state: o.state, ...(o.note ? { note: o.note } : {}) };
    if (target && !(await exists(statePath(target)))) moved.push({ from: o.page, to: target.ref, locales: out.locales, note: 'locale files and state were not moved (Phase 2); the new path will be translated from scratch' });
    else orphaned.push(out);
  }
  return { orphaned, moved };
}
