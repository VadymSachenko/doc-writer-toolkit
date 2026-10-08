import { abs, listUaPages, localePagePath, readIfExists, readState } from './pages.mjs';
import { selectPages } from './settings.mjs';
import { cachedBlob } from './plan.mjs';
import { parsePage, splitCode } from './parse.mjs';
import { parseCategory, readCategoryTarget } from './categories.mjs';
import { termMatcher } from './terms.mjs';
import { blocksAtLines } from './redo.mjs';

// `terms --usage`: where one locale's pages still use a term's old translation, so a correction reaches them. Matches
// inflected forms like term lookup does (T4), in prose, frontmatter values and mermaid labels, never in code. Per page,
// the blocks those lines belong to and the `--redo` value that re-translates exactly them.
export async function termUsage(s, locale, olds, selectors = []) {
  const matchers = olds.map((t) => ({ old: t, re: termMatcher(t) }));
  const find = (line) => matchers.map((m) => line.match(m.re)?.[0]).filter(Boolean);
  const { inScope, categoriesInScope } = await listUaPages(s);
  const units = selectPages(s, [...inScope, ...categoriesInScope], selectors);
  const pages = [];
  for (const unit of units) {
    const state = await readState(s, unit.id);
    const upToDate = state.locales[locale]?.sourceBlob === unit.blob;
    if (unit.kind === 'category') {
      const target = await readCategoryTarget(s, locale, parseCategory(await cachedBlob(s.root, unit.blob)));
      const entries = target.entries.filter((e) => typeof e.message === 'string' && find(e.message).length).map((e) => ({ entryKey: e.entryKey, field: e.field, message: e.message, match: find(e.message) }));
      if (entries.length) pages.push({ page: unit.id, kind: 'category', file: target.file, upToDate, entries, redo: 'all' });
      continue;
    }
    const file = localePagePath(s, locale, unit);
    const text = await readIfExists(abs(s, file));
    if (text === null) continue;
    const sc = splitCode(text);
    const searchable = [...sc.prose];
    for (const f of sc.fences) if (/^mermaid\b/i.test(f.info)) f.lines.forEach((l, i) => (searchable[f.startLine + 1 + i] = l));
    const hits = [];
    searchable.forEach((line, i) => {
      const match = find(line);
      if (match.length) hits.push({ line: i + 1, match, text: sc.lines[i].trim().slice(0, 160) });
    });
    if (!hits.length) continue;
    const { changes, skipped, unmapped } = blocksAtLines(parsePage(await cachedBlob(s.root, unit.blob)), parsePage(text), hits.map((h) => h.line));
    pages.push({
      page: unit.id,
      kind: 'page',
      file,
      upToDate,
      hits,
      blocks: changes.map((c) => ({ lines: c.target.lines, kind: c.kind, ...(c.key ? { key: c.key } : { headingPath: c.headingPath }) })),
      ...(unmapped.length ? { unmapped } : {}),
      ...(skipped.length ? { skipped } : {}),
      redo: changes.map((c) => c.target.lines[0]).join(','),
      ...(upToDate ? {} : { note: `Not current in '${locale}': translate its pending changes first (the redo needs a current page).` }),
    });
  }
  const sum = (f) => pages.reduce((n, p) => n + f(p), 0);
  return {
    locale,
    olds,
    pages,
    summary: { pages: pages.length, blocks: sum((p) => p.blocks?.length ?? 0), categories: pages.filter((p) => p.kind === 'category').length, hits: sum((p) => p.hits?.length ?? p.entries.length) },
    apply: 'Per page: `blocks <page> --redo <redo>`, translate the changes with the corrected term, `apply <page> --redo <redo> --translations … --out …`, then `check` and `record` with --candidate. A category: `blocks <id> --redo all`, as a full category.',
  };
}
