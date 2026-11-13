// The existing pairs of a product kit's example values file (context/doc-rules/example-values-format.md): a UA value and
// the EN value a page written before the file keeps with it («Іванов Іван» and "John Doe"). Check 6 counts a listed
// pair as the same value: in a code block's code part, a quoted literal that is a pair's UA value may be, on the EN
// side, that value or the pair's EN value. Everything else in the line still compares byte for byte.

import { fenceParts } from './fences.mjs';

// The pairs table: the first table under `## Existing pairs` or `## Наявні пари`. Columns: UA value, EN value, Type
// (`example` or `system`), Pages. Only the first three are read.
const PAIRS_HEADING = /^##\s+(existing pairs|наявні пари)\s*$/i;
const TYPES = new Set(['example', 'system']);

function cells(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

// A value cell as the value itself: one pair of surrounding backticks removed (`` `x` ``, or ``` `` x `` ``` for a
// value that holds a backtick). The value is everything inside, spaces included, exactly as the code writes it.
function value(cell) {
  const m = cell.match(/^(`+)(.*)\1$/s);
  if (!m) return cell;
  return m[1].length > 1 && /^ .* $/s.test(m[2]) ? m[2].slice(1, -1) : m[2];
}

// Returns { found, rows: [{ ua, en, type, line }], invalid: [{ line, reason }] }. `found` is false when the file has no
// pairs section. A section with no table, or an empty one, is found with no rows.
export function parseExamplePairs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => PAIRS_HEADING.test(l.trim()));
  if (start < 0) return { found: false, rows: [], invalid: [] };
  const rows = [];
  const invalid = [];
  let i = start + 1;
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) {
    if (/^#{1,2}\s/.test(lines[i])) return { found: true, rows, invalid }; // the next section began before any table
    i++;
  }
  if (i + 1 >= lines.length || !/^\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1].trim())) return { found: true, rows, invalid };
  for (let j = i + 2; j < lines.length && lines[j].trimStart().startsWith('|'); j++) {
    const c = cells(lines[j]);
    const [ua, en] = [value(c[0] ?? ''), value(c[1] ?? '')];
    const type = value(c[2] ?? '').toLowerCase() || 'example';
    const line = j + 1;
    if (!ua && !en) continue;
    if (!ua || !en) invalid.push({ line, reason: 'a pair needs both a UA value and an EN value' });
    else if (ua === en) invalid.push({ line, reason: 'the UA value and the EN value are the same: no pair is needed' });
    else if (!TYPES.has(type)) invalid.push({ line, reason: `type '${type}' is neither 'example' nor 'system'` });
    else rows.push({ ua, en, type, line });
  }
  return { found: true, rows, invalid };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Builds the matcher once per set of pairs: the UA values, longest first, so a value that holds another wins.
export function pairMatcher(rows) {
  const byUa = new Map();
  for (const r of rows) {
    if (!byUa.has(r.ua)) byUa.set(r.ua, []);
    byUa.get(r.ua).push(r);
  }
  const keys = [...byUa.keys()].sort((a, b) => b.length - a.length);
  const literal = keys.length ? new RegExp(`(["'\`])(${keys.map(escape).join('|')})\\1`, 'g') : null;
  return { byUa, literal };
}

// Whether EN line `en` is UA line `ua` with some of its pair literals replaced by their EN values. Returns
// { used, kept }, or null when the lines differ otherwise. `used`: the rows whose EN value the EN line holds. `kept`:
// the `example` rows whose UA value the EN line still holds, where the translator writes the EN value. A UA value counts
// only as a whole literal, in the same quotes on both sides: not inside a longer string, and never the other way round
// (an EN value on the UA side is not a pair).
export function pairedLine(ua, en, matcher) {
  if (!matcher.literal) return ua === en ? { used: [], kept: [] } : null;
  const slots = [];
  let src = '';
  let last = 0;
  for (const m of ua.matchAll(matcher.literal)) {
    const [whole, q, v] = m;
    const options = [v, ...matcher.byUa.get(v).map((r) => r.en)];
    src += `${escape(ua.slice(last, m.index))}${escape(q)}(${options.map(escape).join('|')})${escape(q)}`;
    slots.push(v);
    last = m.index + whole.length;
  }
  if (!slots.length) return ua === en ? { used: [], kept: [] } : null;
  const hit = en.match(new RegExp(`^${src}${escape(ua.slice(last))}$`));
  if (!hit) return null;
  const used = [];
  const kept = [];
  slots.forEach((v, n) => {
    const got = hit[n + 1];
    const rows = matcher.byUa.get(v);
    if (got !== v) used.push(rows.find((r) => r.en === got));
    else if (rows.some((r) => r.type === 'example')) kept.push(rows.find((r) => r.type === 'example'));
  });
  return { used, kept };
}

// codeDiff (fences.mjs) with the pairs: the first line (0-based) where the code parts of a UA fence and its EN fence
// differ by more than the listed pairs, or -1. `used` collects the rows that made a line the same, for the report;
// `kept` collects { row, line } for each `example` pair whose UA value the EN fence kept (line 0-based in the fence).
export function pairedCodeDiff(ua, en, matcher, used = [], kept = []) {
  const [x, y] = [fenceParts(ua.info, ua.lines).code, fenceParts(en.info, en.lines).code];
  const mine = [];
  let k = 0;
  while (k < x.length && k < y.length) {
    const u = pairedLine(x[k], y[k], matcher);
    if (!u) break;
    mine.push(...u.used);
    for (const row of u.kept) kept.push({ row, line: k });
    k++;
  }
  if (k === x.length && k === y.length) {
    used.push(...mine);
    return -1;
  }
  return k;
}
