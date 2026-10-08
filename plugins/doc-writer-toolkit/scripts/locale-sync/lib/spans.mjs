import { isLib } from '../../ui-labels/lib/store.mjs';
import { normalize, uiParts } from '../../ui-labels/lib/lookup.mjs';
export { uiParts };
import { BOLD, INLINE_CODE, fenceStep } from './parse.mjs';
import { CYRILLIC } from './letters.mjs';
import { acceptedLabels } from './labels.mjs';
import { matchTerms } from './terms.mjs';

// The spans the binding pass classifies (`context/locale-translation.md`, §4): bold spans, and inline code that holds
// Cyrillic (UI text in code style). One entry per occurrence, outside fenced code, with its line for context.
export function spanOccurrences(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const next = fenceStep(fence, line);
    const code = fence !== null || next !== null;
    fence = next;
    if (code) return;
    for (const m of line.matchAll(INLINE_CODE)) {
      if (CYRILLIC.test(m[2])) out.push({ span: m[2], kind: 'code', line: i + 1, at: m.index, end: m.index + m[0].length, text: line });
    }
    const prose = line.replace(INLINE_CODE, (m) => ' '.repeat(m.length));
    for (const m of prose.matchAll(BOLD)) {
      const at = m.index;
      const end = at + m[0].length;
      out.push({ span: m[1], kind: 'bold', line: i + 1, at, end, text: line, defList: isDefinition(prose, at, end, m[1]) });
    }
  });
  return out;
}

// `- **Термін:** …`, `- **Термін** — …` or `<li>**Термін**: …`: the bold span opens a list item and is followed by its definition.
function isDefinition(prose, at, end, span) {
  if (!/(?:^\s*[-*+]\s+|<li>\s*)$/.test(prose.slice(0, at))) return false;
  return /:$/.test(span) || /^\s*(?::|—|–|-\s)/.test(prose.slice(end));
}

// UA words that put a span in a UI context (ladder rule 3), as stems. A list of labels after one of them
// («Виберіть вкладку: **A**, **B** або **C**») is still in that context, hence the wide window before the span.
const UI_CONTEXT = /(?<!\p{L})(?:натисн|клацн|оберіть|обрати|виберіть|вибрати|вкажіть|введіть|заповніть|наведіть|кнопк|пол(?:е|я|і|ем|ях)(?!\p{L})|вкладк|меню|вікн|панел|перемикач|прапорц|стовпц|стовпець|колонк|колонц|крок|кроц|натиск|сторінц|сторінк|іконк|віджет|списк|розділ|етап|статус|значенн)/iu;

export function inUiContext(occ) {
  return UI_CONTEXT.test(occ.text.slice(Math.max(0, occ.at - 120), occ.at) + ' ' + occ.text.slice(occ.end, occ.end + 40));
}

export function groupBySpan(occurrences) {
  const map = new Map();
  for (const o of occurrences) map.set(o.span, [...(map.get(o.span) ?? []), o]);
  return map;
}

// UA string (normalized) -> app keys, for "this term equals a UI string" (T1). Library strings don't count.
export function uiIndex(labels) {
  const index = new Map();
  for (const [key, text] of Object.entries(labels?.uk ?? {})) {
    if (isLib(key)) continue;
    const n = normalize(text);
    index.set(n, [...(index.get(n) ?? []), key]);
  }
  return index;
}

// The locale's UI string for a UA term, when every key with that UA string shows the same string in the locale. The
// app's decorative trailing punctuation (`Заявка:` on a form) goes when the term has none.
const TRAILING = /\s*[:.…!?]+$/u;
export function uiStringFor(index, labels, ua, locale) {
  const keys = index.get(normalize(ua));
  if (!keys) return null;
  const bare = !TRAILING.test(ua);
  const values = new Set(keys.map((k) => labels[locale]?.[k]).filter((v) => typeof v === 'string').map((v) => (bare ? v.replace(TRAILING, '') || v : v)));
  return values.size === 1 ? { key: keys[0], value: [...values][0] } : null;
}

// What a translation worker needs for the spans in `text` (the blocks it writes), in one locale: the recorded decision
// and, for a bound label, the exact string to write. `undecided` spans mean the binding pass hasn't run on them.
export function labelRows(text, state, locale, ctx) {
  const rows = [];
  const undecided = [];
  for (const [span, occ] of groupBySpan(spanOccurrences(text))) {
    const decision = state.spans[span] ?? null;
    const kind = occ[0].kind;
    if (!decision) {
      undecided.push({ span, kind, line: occ[0].line });
      continue;
    }
    const row = { span, kind, decision };
    const { markup, parts } = uiParts(span);
    if (markup && !decision.startsWith('label:') && ctx.uiIndex) {
      const found = parts.map((ua) => ({ ua, write: uiStringFor(ctx.uiIndex, ctx.labels, ua, locale)?.value })).filter((p) => p.write);
      if (found.length) row.parts = found;
    }
    if (decision.startsWith('label:')) {
      const key = decision.slice(6);
      const value = ctx.labels?.[locale]?.[key];
      row.key = key;
      if (typeof value === 'string') {
        // L1: when the UA span drops the decorative trailing punctuation of the UA string, so does the translation.
        row.write = acceptedLabels(span, ctx.labels.uk?.[key], value).at(-1);
      } else {
        row.missing = true;
        if (ctx.fallbackEn && typeof ctx.labels?.en?.[key] === 'string') {
          row.write = ctx.labels.en[key];
          row.fallback = 'en';
        }
      }
    }
    rows.push(row);
  }
  return { labels: rows, undecided };
}

// The first cell of every table body row whose text is plain (no markup, code or link). Header rows are skipped.
const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
function firstCells(text) {
  const lines = text.split('\n');
  const cells = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|') || SEPARATOR.test(line) || SEPARATOR.test(lines[i + 1]?.trim() ?? '')) continue;
    const cell = line.slice(1).split('|')[0].trim();
    if (cell && !/[*`[\]<>{}_]/.test(cell)) cells.push(cell);
  }
  return cells;
}

// Term-memory rows for the terms in `text` (T4), with the UI string winning over the recorded one (T1). Bold spans
// classified `term` or `unverified` that equal a UI string are added even when they have no entry yet.
export function termRows(text, state, locale, ctx) {
  const memory = ctx.terms.get(locale) ?? { entries: [], conflicts: [] };
  const rows = [];
  const seen = new Set();
  for (const e of matchTerms(memory.entries, text)) {
    const ui = ctx.uiIndex ? uiStringFor(ctx.uiIndex, ctx.labels, e.ua, locale) : null;
    rows.push(ui && ui.value !== e.target ? { ua: e.ua, target: ui.value, source: 'ui', recorded: e.target } : { ua: e.ua, target: e.target, source: ui ? 'ui' : 'memory' });
    seen.add(normalize(e.ua));
  }
  if (ctx.uiIndex) {
    for (const [span] of groupBySpan(spanOccurrences(text))) {
      if (!['term', 'unverified'].includes(state.spans[span]) || seen.has(normalize(span))) continue;
      const ui = uiStringFor(ctx.uiIndex, ctx.labels, span, locale);
      if (ui) rows.push({ ua: span, target: ui.value, source: 'ui' });
      seen.add(normalize(span));
    }
    // Plain first cells of table body rows: attribute tables name the app's columns and fields without bold, so no
    // span covers them. One that equals a UI string takes the app's string (T1).
    for (const cell of firstCells(text)) {
      if (seen.has(normalize(cell))) continue;
      const ui = uiStringFor(ctx.uiIndex, ctx.labels, cell, locale);
      if (ui) rows.push({ ua: cell, target: ui.value, source: 'ui', where: 'table' });
      seen.add(normalize(cell));
    }
  }
  const conflicts = memory.conflicts.filter((c) => rows.some((r) => normalize(r.ua) === normalize(c.ua)));
  return { terms: rows, ...(conflicts.length ? { termConflicts: conflicts } : {}) };
}
