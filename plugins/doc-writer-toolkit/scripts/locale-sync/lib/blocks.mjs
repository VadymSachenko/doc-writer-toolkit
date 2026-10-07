import { CliError } from '../../ui-labels/lib/util.mjs';
import { existingBlobs } from './git.mjs';
import { abs, listUaPages, localePagePath, readIfExists, readState } from './pages.mjs';
import { resolveTargets, selectPages } from './settings.mjs';
import { cachedBlob, classify, modeOf } from './plan.mjs';
import { composeChanges, diffBodies, diffFrontmatter, introducedBold } from './diff.mjs';
import { boldSpans, parsePage, splitCode } from './parse.mjs';
import { parseCategory, readCategoryTarget } from './categories.mjs';

// For each page and locale: exactly the UA blocks the translator has to write, with the matching translated text.
export async function runBlocks(s, { selectors = [], overwrite = false, withOld = false } = {}) {
  if (!selectors.length) throw new CliError('Usage: locale-sync blocks <page|folder>… [--locales tr,kk]', { code: 2 });
  const { targets, warnings } = await resolveTargets(s);
  const { inScope, categoriesInScope } = await listUaPages(s);
  const units = selectPages(s, [...inScope, ...categoriesInScope], selectors);
  const results = [];
  for (const unit of units) {
    const state = await readState(s, unit.id);
    for (const locale of targets) {
      results.push(unit.kind === 'category' ? await categoryBlocksFor(s, unit, locale, state, { overwrite }) : await blocksFor(s, unit, locale, state, { overwrite, withOld }));
    }
  }
  return { results, warnings };
}

// A sidebar category is translated whole: the entries to write into the locale's current.json, with what is there now.
async function categoryBlocksFor(s, unit, locale, state, { overwrite }) {
  const text = await cachedBlob(s.root, unit.blob);
  const parsed = parseCategory(text);
  const target = await readCategoryTarget(s, locale, parsed);
  const cell = classify({ entry: state.locales[locale], blob: unit.blob, targetExists: target.exists, handMade: target.handMade, baseExists: true, overwrite });
  const head = { kind: 'category', page: unit.id, path: unit.path, blob: unit.blob, locale, target: { path: target.file, exists: target.exists }, state: cell.state, reason: cell.reason };
  if (parsed.error) return { ...head, mode: 'error', error: `The UA category file is not valid JSON: ${parsed.error}` };
  if (cell.state === 'current') return { ...head, mode: 'none', changes: [] };
  if (cell.state === 'skipped') return { ...head, mode: 'skipped', note: 'An entry in the locale file already differs from the UA text (translated by hand) and no state was recorded. Pass --overwrite to translate it.' };
  return {
    ...head,
    mode: 'full',
    fullReason: cell.reason,
    source: { kind: 'full', to: unit.blob },
    overwrites: target.handMade,
    ua: { lines: [1, text.split('\n').length], text },
    entries: target.entries.map((e) => ({ entryKey: e.entryKey, field: e.field, ua: e.ua, current: e.message, ...(e.field === 'label' && state.spans[e.ua] ? { binding: state.spans[e.ua] } : {}) })),
    missing: target.missing,
    ...(target.exists ? {} : { problem: `${target.file} has no entry for: ${target.missing.join(', ') || 'this category'}. Run \`write-translations --locale ${locale}\` first.` }),
    apply: 'Write { "<entryKey>": "<translated message>" } for every entry to a JSON file and pass it as --candidate to check and record.',
  };
}

async function blocksFor(s, page, locale, state, { overwrite, withOld }) {
  const file = localePagePath(s, locale, page);
  const targetText = await readIfExists(abs(s, file));
  const entry = state.locales[locale];
  const baseExists = entry?.sourceBlob ? (await existingBlobs(s.root, [entry.sourceBlob])).has(entry.sourceBlob) : false;
  const cell = classify({ entry, blob: page.blob, targetExists: targetText !== null, baseExists, overwrite });
  const head = { kind: 'page', page: page.id, path: page.path, blob: page.blob, locale, target: { path: file, exists: targetText !== null }, state: cell.state, reason: cell.reason };

  if (cell.state === 'current') return { ...head, mode: 'none', changes: [], unmapped: [] };
  if (cell.state === 'skipped') {
    return { ...head, mode: 'skipped', note: 'A translation file exists but no state was recorded for it (a manual bootstrap). Pass --overwrite to translate it from scratch.' };
  }

  const b = await cachedBlob(s.root, page.blob);
  const pageB = parsePage(b);
  if (modeOf(cell) === 'full') {
    return {
      ...head,
      mode: 'full',
      fullReason: cell.reason,
      source: { kind: 'full', to: page.blob },
      overwrites: targetText !== null,
      ua: { lines: [1, pageB.lines.length], text: b },
      bold: boldSpans(splitCode(b).prose),
    };
  }

  const a = await cachedBlob(s.root, cell.base);
  const pageA = parsePage(a);
  const pageT = parsePage(targetText);
  const groups = diffBodies(pageA, pageB);
  const fmChanges = diffFrontmatter(pageA.fm, pageB.fm);
  const { changes, unmapped } = composeChanges({ pageA, pageB, pageT, groups, fmChanges, withOld });
  return {
    ...head,
    mode: 'incremental',
    source: { kind: 'blob-diff', from: cell.base, to: page.blob },
    noop: !changes.length && !unmapped.length,
    changes,
    unmapped,
    introducedBold: introducedBold(changes, pageA),
    summary: {
      replace: changes.filter((c) => c.op === 'replace').length,
      add: changes.filter((c) => c.op === 'add').length,
      remove: changes.filter((c) => c.op === 'remove').length,
      unmapped: unmapped.length,
      words: changes.reduce((n, c) => n + (c.words ?? 0), 0),
    },
  };
}
