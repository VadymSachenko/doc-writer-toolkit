import { CliError } from '../../ui-labels/lib/util.mjs';
import { existingBlobs } from './git.mjs';
import { abs, listUaPages, localePagePath, readIfExists, readState } from './pages.mjs';
import { resolveTargets, selectPages } from './settings.mjs';
import { cachedBlob, classify, modeOf } from './plan.mjs';
import { composeChanges, diffBodies, diffFrontmatter, introducedBold } from './diff.mjs';
import { boldSpans, parsePage, splitCode } from './parse.mjs';
import { parseCategory, readCategoryTarget } from './categories.mjs';
import { loadStore, mergedLabels } from '../../ui-labels/lib/store.mjs';
import { readTerms } from './terms.mjs';
import { labelRows, termRows, uiIndex } from './spans.mjs';
import { acceptedLabels } from './labels.mjs';
import { sectionMap } from './scope.mjs';
import { blocksAtLines, parseLines } from './redo.mjs';
import { linkRows } from './links.mjs';

// For each page and locale: exactly the UA blocks the translator has to write, with the matching translated text.
// `redo` re-translates blocks of a current page: target line numbers ("12,14-16"), or "all" for the whole page.
export async function runBlocks(s, { selectors = [], overwrite = false, withOld = false, redo = null } = {}) {
  if (!selectors.length) throw new CliError('Usage: locale-sync blocks <page|folder>… [--locales tr,kk]', { code: 2 });
  const { targets, warnings } = await resolveTargets(s);
  const { inScope, categoriesInScope } = await listUaPages(s);
  const units = selectPages(s, [...inScope, ...categoriesInScope], selectors);
  const redoLines = redo && redo !== 'all' ? parseLines(redo) : null;
  const ctx = await rowContext(s, targets);
  if (!ctx.labels) warnings.push('No label store: bound labels have no string to write. Run the UI label check first.');
  const results = [];
  for (const unit of units) {
    const state = await readState(s, unit.id);
    for (const locale of targets) {
      results.push(unit.kind === 'category' ? await categoryBlocksFor(s, unit, locale, state, { overwrite, ctx, redo }) : await blocksFor(s, unit, locale, state, { overwrite, withOld, ctx, redo, redoLines }));
    }
  }
  return { results, warnings };
}

// The label store (overlay first) and each locale's term memory, loaded once for every page.
async function rowContext(s, targets) {
  const store = await loadStore(s.labelsDir);
  const labels = store ? mergedLabels(store).labels : null;
  const terms = new Map();
  for (const locale of targets) terms.set(locale, await readTerms(s, locale));
  return { labels, uiIndex: labels ? uiIndex(labels) : null, fallbackEn: (s.claude['ui label fallback'] ?? '').trim().toLowerCase() === 'en', terms };
}

// A category's label row: the recorded decision and, when bound, the app's string for the locale.
function categoryLabelRows(parsed, state, locale, ctx) {
  const label = parsed.fields.find((f) => f.field === 'label')?.ua;
  if (!label) return { labels: [], undecided: [] };
  const decision = state.spans[label];
  if (!decision) return { labels: [], undecided: [{ span: label, kind: 'category' }] };
  const row = { span: label, kind: 'category', decision };
  if (decision.startsWith('label:')) {
    row.key = decision.slice(6);
    const value = ctx.labels?.[locale]?.[row.key];
    if (typeof value === 'string') row.write = acceptedLabels(label, ctx.labels.uk?.[row.key], value).at(-1);
    else row.missing = true;
  }
  return { labels: [row], undecided: [] };
}

// A sidebar category is translated whole: the entries to write into the locale's current.json, with what is there now.
async function categoryBlocksFor(s, unit, locale, state, { overwrite, ctx, redo }) {
  const text = await cachedBlob(s.root, unit.blob);
  const parsed = parseCategory(text);
  const target = await readCategoryTarget(s, locale, parsed);
  const cell = classify({ entry: state.locales[locale], blob: unit.blob, targetExists: target.exists, handMade: target.handMade, baseExists: true, overwrite });
  const head = { kind: 'category', page: unit.id, path: unit.path, blob: unit.blob, locale, target: { path: target.file, exists: target.exists }, state: cell.state, reason: cell.reason };
  if (parsed.error) return { ...head, mode: 'error', error: `The UA category file is not valid JSON: ${parsed.error}` };
  // A category is short: --redo, whatever its value, translates it again in full.
  if (cell.state === 'current' && !redo) return { ...head, mode: 'none', changes: [] };
  if (cell.state === 'skipped') return { ...head, mode: 'skipped', note: 'An entry in the locale file already differs from the UA text (translated by hand) and no state was recorded. Pass --overwrite to translate it.' };
  return {
    ...head,
    mode: 'full',
    fullReason: cell.state === 'current' ? 'redo' : cell.reason,
    source: { kind: 'full', to: unit.blob },
    overwrites: target.handMade,
    ua: { lines: [1, text.split('\n').length], text },
    entries: target.entries.map((e) => ({ entryKey: e.entryKey, field: e.field, ua: e.ua, current: e.message, ...(e.field === 'label' && state.spans[e.ua] ? { binding: state.spans[e.ua] } : {}) })),
    missing: target.missing,
    ...categoryLabelRows(parsed, state, locale, ctx),
    ...termRows(parsed.fields.map((f) => f.ua).join('\n'), state, locale, ctx),
    ...(target.exists ? {} : { problem: `${target.file} has no entry for: ${target.missing.join(', ') || 'this category'}. Run \`write-translations --locale ${locale}\` first.` }),
    apply: 'Write { "<entryKey>": "<translated message>" } for every entry to a JSON file and pass it as --candidate to check and record.',
  };
}

// Segments for the label and term rows (`spans.mjs`): the whole UA page, or the UA text of each change, each line with
// its heading path in the UA page, so scoped span decisions apply.
function fullSegments(text) {
  const map = sectionMap(text);
  return [{ text, firstLine: 1, pathAt: (i) => map.paths[map.at[i]] }];
}
function changeSegments(text, changes) {
  const map = sectionMap(text);
  return changes.filter((c) => c.ua?.text).map((c) => ({ text: c.ua.text, firstLine: c.ua.lines[0], change: c.id, pathAt: (i) => map.paths[map.at[c.ua.lines[0] - 1 + i]] ?? [] }));
}

// The blocks of a current page at the given translation lines, with their UA text from the current UA page.
async function redoBlocksFor(s, page, head, targetText, state, locale, ctx, lines) {
  const b = await cachedBlob(s.root, page.blob);
  const { changes, skipped, unmapped } = blocksAtLines(parsePage(b), parsePage(targetText), lines);
  const segments = changeSegments(b, changes);
  return {
    ...head,
    mode: 'redo',
    source: { kind: 'redo', blob: page.blob, lines },
    changes,
    unmapped,
    skipped,
    ...labelRows(segments, state, locale, ctx),
    ...termRows(segments, state, locale, ctx),
    ...(await linkRows(s, page, segments.map((x) => x.text).join('\n'), locale)),
    summary: { replace: changes.length, unmapped: unmapped.length, words: changes.reduce((n, c) => n + (c.words ?? 0), 0) },
  };
}

async function blocksFor(s, page, locale, state, { overwrite, withOld, ctx, redo, redoLines }) {
  const file = localePagePath(s, locale, page);
  const targetText = await readIfExists(abs(s, file));
  const entry = state.locales[locale];
  const baseExists = entry?.sourceBlob ? (await existingBlobs(s.root, [entry.sourceBlob])).has(entry.sourceBlob) : false;
  const cell = classify({ entry, blob: page.blob, targetExists: targetText !== null, baseExists, overwrite });
  const head = { kind: 'page', page: page.id, path: page.path, blob: page.blob, locale, target: { path: file, exists: targetText !== null }, state: cell.state, reason: cell.reason };

  if (redo && cell.state !== 'current') {
    return { ...head, mode: 'error', error: `--redo needs a page that is current in '${locale}' (it is ${cell.state}${cell.reason ? `, ${cell.reason}` : ''}): translate its pending changes first, then redo.` };
  }
  if (cell.state === 'current' && redoLines) return redoBlocksFor(s, page, head, targetText, state, locale, ctx, redoLines);
  if (cell.state === 'current' && !redo) return { ...head, mode: 'none', changes: [], unmapped: [] };
  if (cell.state === 'skipped') {
    return { ...head, mode: 'skipped', note: 'A translation file exists but no state was recorded for it (a manual bootstrap). Pass --overwrite to translate it from scratch.' };
  }

  const b = await cachedBlob(s.root, page.blob);
  const pageB = parsePage(b);
  if (redo === 'all' || modeOf(cell) === 'full') {
    return {
      ...head,
      mode: 'full',
      fullReason: redo === 'all' ? 'redo' : cell.reason,
      source: { kind: 'full', to: page.blob },
      overwrites: targetText !== null,
      ua: { lines: [1, pageB.lines.length], text: b },
      bold: boldSpans(splitCode(b).prose),
      ...labelRows(fullSegments(b), state, locale, ctx),
      ...termRows(b, state, locale, ctx),
      ...(await linkRows(s, page, b, locale)),
    };
  }

  const a = await cachedBlob(s.root, cell.base);
  const pageA = parsePage(a);
  const pageT = parsePage(targetText);
  const groups = diffBodies(pageA, pageB);
  const fmChanges = diffFrontmatter(pageA.fm, pageB.fm);
  const { changes, unmapped } = composeChanges({ pageA, pageB, pageT, groups, fmChanges, withOld });
  const segments = changeSegments(b, changes);
  return {
    ...head,
    mode: 'incremental',
    source: { kind: 'blob-diff', from: cell.base, to: page.blob },
    noop: !changes.length && !unmapped.length,
    changes,
    unmapped,
    introducedBold: introducedBold(changes, pageA),
    ...labelRows(segments, state, locale, ctx),
    ...termRows(segments, state, locale, ctx),
    ...(await linkRows(s, page, segments.map((x) => x.text).join('\n'), locale)),
    summary: {
      replace: changes.filter((c) => c.op === 'replace').length,
      add: changes.filter((c) => c.op === 'add').length,
      remove: changes.filter((c) => c.op === 'remove').length,
      unmapped: unmapped.length,
      words: changes.reduce((n, c) => n + (c.words ?? 0), 0),
    },
  };
}
