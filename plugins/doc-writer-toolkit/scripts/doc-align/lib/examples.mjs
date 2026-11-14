// The existing pairs of a product kit's example values file (context/doc-rules/example-values-format.md): a UA value and
// the EN value that a page written before the file keeps with it («Петренко Олег» and "John Smith"), and the pages it
// holds for. On those pages, Check 6 counts a pair as the same value: in a code block's code part, a string literal whose
// whole value is the pair's UA value may be, on the EN side, that value or the pair's EN value. Everything else in the
// line still compares byte for byte. On any other page a pair changes nothing.

import { fenceLang, fenceParts } from './fences.mjs';

const PAIRS_HEADING = /^##\s+(existing pairs|наявні пари)\s*$/i;
const SYSTEM_HEADING = /^##\s+(system values|системні значення)\s*$/i;
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

// The rows of the first table under a heading, as { cells, line }. `found` is false without the heading; a section
// with no table, or an empty one, is found with no rows.
function table(lines, heading) {
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start < 0) return { found: false, rows: [] };
  let i = start + 1;
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) {
    if (/^#{1,2}\s/.test(lines[i])) return { found: true, rows: [] }; // the next section began before any table
    i++;
  }
  if (i + 1 >= lines.length || !/^\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1].trim())) return { found: true, rows: [] };
  const rows = [];
  for (let j = i + 2; j < lines.length && lines[j].trimStart().startsWith('|'); j++) rows.push({ cells: cells(lines[j]), line: j + 1 });
  return { found: true, rows };
}

// A page in the Pages column: its path relative to the content root, without the extension (`api/create-payment`),
// optionally with the content root in front to tell two root pairs apart (`docs/api/create-payment`). No leading
// slash, no `.`/`..` segment, no extension, no spaces or wildcards.
const PAGE = /^[^\s/\\*?`]+(\/[^\s/\\*?`]+)*$/u;
const pageProblem = (p) => {
  if (!PAGE.test(p)) return `page '${p}' is not a path relative to the content root`;
  if (p.split('/').some((s) => s === '.' || s === '..')) return `page '${p}' has a '.' or '..' segment`;
  if (/\.mdx?$/i.test(p)) return `page '${p}' has an extension; write the path without it`;
  return null;
};

// Returns { found, rows: [{ ua, en, type, pages, line }], invalid: [{ line, reason }] }. `found` is false when the file
// has no pairs section. A row that is not a valid pair is in `invalid` and never applies.
export function parseExamplePairs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const system = new Map();
  for (const r of table(lines, SYSTEM_HEADING).rows) {
    const v = value(r.cells[0] ?? '');
    if (v && !system.has(v)) system.set(v, r.line);
  }
  const t = table(lines, PAIRS_HEADING);
  const invalid = [];
  let rows = [];
  for (const { cells: c, line } of t.rows) {
    const [ua, en] = [value(c[0] ?? ''), value(c[1] ?? '')];
    const type = value(c[2] ?? '').toLowerCase() || 'example';
    const pages = (c[3] ?? '').split(',').map((p) => value(p.trim())).filter(Boolean);
    if (!ua && !en) continue;
    let reason = null;
    if (!ua || !en) reason = 'a pair needs both a UA value and an EN value';
    else if (ua === en) reason = 'the UA value and the EN value are the same: no pair is needed';
    else if (!TYPES.has(type)) reason = `type '${type}' is neither 'example' nor 'system'`;
    else if (!pages.length) reason = 'a pair needs the pages it holds for (Pages column)';
    else if (type === 'example' && system.has(ua)) reason = `'${ua}' is a system value (line ${system.get(ua)}): a system value is never translated, so it is no example pair`;
    else reason = pages.map(pageProblem).find(Boolean) ?? null;
    if (reason) invalid.push({ line, reason });
    else rows.push({ ua, en, type, pages, line });
  }
  // One UA value, one row: two EN values for it are invalid both, a row listed twice is invalid the second time.
  const byUa = new Map();
  for (const r of rows) byUa.set(r.ua, [...(byUa.get(r.ua) ?? []), r]);
  const bad = new Set();
  for (const [ua, list] of byUa) {
    if (list.length < 2) continue;
    if (new Set(list.map((r) => r.en)).size > 1) {
      for (const r of list) {
        bad.add(r);
        invalid.push({ line: r.line, reason: `UA value '${ua}' has more than one EN value (lines ${list.map((x) => x.line).join(', ')})` });
      }
    } else {
      for (const r of list.slice(1)) {
        bad.add(r);
        invalid.push({ line: r.line, reason: `UA value '${ua}' is listed twice (line ${list[0].line}); give all its pages in one row` });
      }
    }
  }
  rows = rows.filter((r) => !bad.has(r));
  invalid.sort((a, b) => a.line - b.line);
  return { found: t.found, rows, invalid };
}

// Whether a pair holds for a page: one of the page's paths, without its extension, is one of the pair's pages or ends
// with `/` and one of them.
export function holdsFor(row, paths) {
  const norm = paths.filter(Boolean).map((p) => p.replace(/\\/g, '/').replace(/\.mdx?$/i, ''));
  return row.pages.some((page) => norm.some((p) => p === page || p.endsWith(`/${page}`)));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function pairMatcher(rows) {
  return { byUa: new Map(rows.map((r) => [r.ua, r])) };
}

// The string delimiters of a block's language. JSON and every language not listed: double quotes only, so a `'` or a
// backtick inside a JSON string is text. A shell's single-quoted string is read again as JSON (`curl -d '{…}'`).
const SHELL = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession']);
const BACKTICK = new Set(['js', 'javascript', 'mjs', 'cjs', 'jsx', 'ts', 'typescript', 'tsx', 'go', 'golang']);
const SINGLE = new Set(['python', 'py', 'ruby', 'rb', 'php', 'perl', 'pl', 'yaml', 'yml', 'toml', 'sql', 'lua', 'powershell', 'ps1', 'pwsh']);
const DOUBLE = { quotes: '"' };
function quoting(lang) {
  if (SHELL.has(lang)) return { quotes: `"'`, raw: `'`, rescan: `'` };
  if (BACKTICK.has(lang)) return { quotes: "\"'`" };
  if (SINGLE.has(lang)) return { quotes: `"'` };
  return DOUBLE;
}

// The string literals of one line: { start, end, q, value }, `end` past the closing quote. An unclosed string ends the
// scan. A literal whose quote is in `rescan` is read again, with double quotes, for the literals inside it.
function literals(line, how, offset = 0) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const q = line[i];
    if (!how.quotes.includes(q)) {
      i++;
      continue;
    }
    let k = i + 1;
    while (k < line.length && line[k] !== q) k += line[k] === '\\' && !how.raw?.includes(q) ? 2 : 1;
    if (k >= line.length) break;
    const v = line.slice(i + 1, k);
    out.push({ start: offset + i, end: offset + k + 1, q, value: v });
    if (how.rescan?.includes(q)) out.push(...literals(v, DOUBLE, offset + i + 1));
    i = k + 1;
  }
  return out;
}

// Whether EN line `en` is UA line `ua` with some of its pair literals replaced by their EN values. Returns
// { used, kept }, or null when the lines differ otherwise. `used`: the rows whose EN value the EN line holds. `kept`: the
// `example` rows whose UA value the EN line still holds, where the translator writes the EN value. A pair counts only as
// a whole string literal of the block's language, in the same quotes on both sides: not inside a longer string, and
// never the other way round (an EN value on the UA side is not a pair).
export function pairedLine(ua, en, matcher, lang = '') {
  const slots = [];
  let last = 0;
  for (const l of literals(ua, quoting(lang)).sort((a, b) => a.start - b.start)) {
    if (l.start < last || !matcher.byUa.has(l.value)) continue;
    slots.push(l);
    last = l.end;
  }
  if (!slots.length) return ua === en ? { used: [], kept: [] } : null;
  let src = '';
  last = 0;
  for (const l of slots) {
    const row = matcher.byUa.get(l.value);
    src += `${escape(ua.slice(last, l.start))}${escape(l.q)}(${escape(row.ua)}|${escape(row.en)})${escape(l.q)}`;
    last = l.end;
  }
  const hit = en.match(new RegExp(`^${src}${escape(ua.slice(last))}$`));
  if (!hit) return null;
  const used = [];
  const kept = [];
  slots.forEach((l, n) => {
    const row = matcher.byUa.get(l.value);
    if (hit[n + 1] !== row.ua) used.push(row);
    else if (row.type === 'example') kept.push(row);
  });
  return { used, kept };
}

// codeDiff (fences.mjs) with the pairs: the first line (0-based) where the code parts of a UA fence and its EN fence
// differ by more than the listed pairs, or -1. `used` collects the rows that made a line the same, for the report;
// `kept` collects { row, line } for each `example` pair whose UA value the EN fence kept (line 0-based in the fence).
export function pairedCodeDiff(ua, en, matcher, used = [], kept = []) {
  const [x, y] = [fenceParts(ua.info, ua.lines).code, fenceParts(en.info, en.lines).code];
  const lang = fenceLang(ua.info);
  const mine = [];
  let k = 0;
  while (k < x.length && k < y.length) {
    const u = pairedLine(x[k], y[k], matcher, lang);
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
