import { CliError, padTable } from './util.mjs';
import { isLib, loadStore, mergedLabels } from './store.mjs';

const PLACEHOLDER = /\{\{[^}]*\}\}|\$\{[^}]*\}|\{[^}]*\}|%[sd]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Case, whitespace and trailing ':' / '.' / '…' don't change which label a span is.
export const normalize = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/[:.…]+$/, '').trim().toLocaleLowerCase('uk');

function buildIndex(uk) {
  const exact = new Map();
  const loose = new Map();
  const patterns = [];
  const push = (map, id, key) => map.set(id, [...(map.get(id) ?? []), key]);
  for (const [key, text] of Object.entries(uk)) {
    push(exact, text, key);
    const norm = normalize(text);
    push(loose, norm, key);
    const parts = norm.split(new RegExp(PLACEHOLDER.source, 'g'));
    if (parts.length > 1 && parts.join('').replace(/\s/g, '').length >= 3) {
      patterns.push({ key, re: new RegExp('^' + parts.map(escapeRe).join('(.+?)') + '$', 'u') });
    }
  }
  return { exact, loose, patterns };
}

function findKeys(index, span) {
  const exact = index.exact.get(span);
  if (exact) return { keys: exact, match: 'exact' };
  const norm = normalize(span);
  const loose = index.loose.get(norm);
  if (loose) return { keys: loose, match: 'normalized' };
  const pattern = index.patterns.filter((p) => p.re.test(norm)).map((p) => p.key);
  if (pattern.length) return { keys: pattern, match: 'pattern' };
  return { keys: [], match: null };
}

export async function runLookup(settings, { spans, search, locales, limit = 20 }) {
  const store = await loadStore(settings.labelsDir);
  if (!store) throw new CliError('No label snapshot found. Run `import` first.', { code: 2 });
  const { labels, origin } = mergedLabels(store);
  const show = (locales ?? store.meta.locales.filter((l) => l !== 'uk' && l !== 'en')).filter((l) => {
    if (!store.meta.locales.includes(l)) throw new CliError(`Locale '${l}' is not in the snapshot (has: ${store.meta.locales.join(', ')})`, { code: 2 });
    return true;
  });
  const valuesFor = (key) => Object.fromEntries(show.map((l) => [l, labels[l]?.[key] ?? null]));

  if (search) {
    const needle = search.toLocaleLowerCase('uk');
    const hits = Object.keys(labels.uk ?? {})
      .concat(Object.keys(labels.en ?? {}).filter((k) => !(k in (labels.uk ?? {}))))
      .filter((k) => k.toLowerCase().includes(needle) || (labels.uk?.[k] ?? '').toLocaleLowerCase('uk').includes(needle) || (labels.en?.[k] ?? '').toLowerCase().includes(needle))
      .sort((a, b) => Number(isLib(a)) - Number(isLib(b)) || (a < b ? -1 : 1));
    return {
      locales: show,
      snapshot: store.meta.commit,
      search,
      total: hits.length,
      results: hits.slice(0, limit).map((key) => ({ key, uk: labels.uk?.[key] ?? null, en: labels.en?.[key] ?? null, values: valuesFor(key), ...(origin[key] ? { overlay: origin[key] } : {}) })),
    };
  }

  const index = buildIndex(labels.uk ?? {});
  const results = spans.map((span) => {
    const { keys, match } = findKeys(index, span);
    if (!keys.length) return { span, class: '?', status: 'no-match' };
    const app = keys.filter((k) => !isLib(k));
    const candidates = (app.length ? app : keys).slice().sort();
    const rows = candidates.map((key) => ({ key, values: valuesFor(key) }));
    const identical = rows.every((r) => JSON.stringify(r.values) === JSON.stringify(rows[0].values));
    if (candidates.length > 1 && !identical) {
      return { span, class: '?', status: 'ambiguous', match, candidates: rows };
    }
    return {
      span,
      class: 'label',
      status: candidates.length > 1 ? 'identical-targets' : 'unique',
      match,
      key: candidates[0],
      alsoKeys: candidates.slice(1),
      values: rows[0].values,
      ...(origin[candidates[0]] ? { overlay: origin[candidates[0]] } : {}),
      missingIn: show.filter((l) => rows[0].values[l] === null),
    };
  });
  return { locales: show, snapshot: store.meta.commit, results };
}

export function renderLookupTable(out) {
  const head = out.search ? ['key', 'uk', 'en', ...out.locales] : ['span', 'class', 'key', ...out.locales];
  const rows = [head];
  if (out.search) {
    for (const r of out.results) rows.push([r.key, r.uk ?? '—', r.en ?? '—', ...out.locales.map((l) => r.values[l] ?? '—')]);
    if (out.total > out.results.length) rows.push([`… ${out.total - out.results.length} more (use --limit)`]);
    return padTable(rows.map((r) => [...r, ...Array(head.length - r.length).fill('')]));
  }
  const width = head.length;
  for (const r of out.results) {
    if (r.status === 'no-match') rows.push([r.span, '?', 'no match', ...Array(width - 3).fill('')]);
    else if (r.status === 'ambiguous') rows.push([r.span, '?', `${r.candidates.length} keys: ${r.candidates.map((c) => c.key).join(' | ')}`, ...Array(width - 3).fill('')]);
    else rows.push([r.span, r.class, r.alsoKeys.length ? `${r.key} (+${r.alsoKeys.length} identical: ${r.alsoKeys.join(' | ')})` : r.key, ...out.locales.map((l) => r.values[l] ?? '—')]);
  }
  return padTable(rows);
}
