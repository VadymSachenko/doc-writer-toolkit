// A line-based reader of one Markdown/MDX page. It finds the structural elements the alignment checks count
// (frontmatter date, headings, tables, code fences, images, links, admonitions, <details>, markers) and their
// line numbers. Fenced code and the frontmatter are skipped, and inline code is blanked before the inline scans,
// so syntax that only appears in a code sample is never counted.

const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_SEP = /^\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const DATE = /^\s*date:\s*(\S+)/i;
const IMG_MD = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
const IMG_HTML = /<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
// An inline link, not an image (the lookbehind skips the leading `!`).
const LINK = /(?<!!)\[[^\]]*\]\(\s*([^)\s]+)/g;
const ADMONITION = /^\s*:{3,}\s*([A-Za-z][\w-]*)/;
const DETAILS = /<details\b/gi;
const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const MARKERS = [
  { kind: 'ToDo', re: /\{\/\*\s*ToDo:\s*([\s\S]*?)\*\/\}/gi },
  { kind: 'NEEDS CONFIRMATION', re: /\{\/\*\s*NEEDS CONFIRMATION:\s*([\s\S]*?)\*\/\}/gi },
];

const blank = (s) => s.replace(/[^\n]/g, ' ');

// Returns the new fence state after `line`: null (outside) or { ch, len } (inside). A fence closes on the same
// character, at least as long as the opening one, with nothing after it.
function fenceStep(state, line) {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!state) return m && !(m[1][0] === '`' && m[2].includes('`')) ? { ch: m[1][0], len: m[1].length } : null;
  if (m && m[1][0] === state.ch && m[1].length >= state.len && m[2].trim() === '') return null;
  return state;
}

// Cells of a table row, ignoring one outer pipe on each side and escaped pipes (`\|`).
export function cellCount(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).length;
}

export function parse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const page = { date: null, dateLine: null, headings: [], tables: [], fences: [], images: [], links: [], admonitions: [], details: [], markers: [] };

  // Frontmatter: only when the file opens with `---`. The first `date:` inside it wins (top level or nested
  // under `last_update`), with surrounding quotes removed.
  let fmEnd = -1;
  if (lines[0]?.trim() === '---') {
    fmEnd = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
    for (let i = 1; i < fmEnd; i++) {
      const m = lines[i].match(DATE);
      if (m) {
        page.date = m[1].replace(/^(["'])(.*)\1$/, '$2');
        page.dateLine = i + 1;
        break;
      }
    }
  }

  // Which lines are code, and the contents of each fence (compared byte for byte).
  const skip = lines.map((_, i) => i <= fmEnd);
  let state = null;
  let cur = null;
  lines.forEach((line, i) => {
    if (skip[i]) return;
    const next = fenceStep(state, line);
    if (!state && next) {
      cur = { line: i + 1, lines: [] };
      skip[i] = true;
    } else if (state && !next) {
      page.fences.push(cur);
      cur = null;
      skip[i] = true;
    } else if (state) {
      cur.lines.push(line);
      skip[i] = true;
    }
    state = next;
  });
  if (cur) page.fences.push(cur); // an unclosed fence keeps what it gathered

  // Prose: code and frontmatter lines blanked, inline code blanked, same line count and lengths.
  const prose = lines.map((l, i) => (skip[i] ? '' : l.replace(INLINE_CODE, blank)));

  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue;
    const line = prose[i];
    const lineNo = i + 1;

    const h = lines[i].match(HEADING);
    if (h) page.headings.push({ level: h[1].length, raw: h[2].trim(), line: lineNo });

    // A table is a run of `|`-led lines whose second line is a separator row. Its lines are still scanned for
    // links, images and the rest below.
    if (line.trimStart().startsWith('|') && (i === 0 || skip[i - 1] || !prose[i - 1].trimStart().startsWith('|'))) {
      let j = i;
      while (j < lines.length && !skip[j] && prose[j].trimStart().startsWith('|')) j++;
      if (j - i >= 2 && TABLE_SEP.test(prose[i + 1].trim())) page.tables.push({ columns: cellCount(lines[i]), rows: j - i - 2, line: lineNo });
    }

    const a = line.match(ADMONITION);
    if (a) page.admonitions.push({ type: a[1].toLowerCase(), line: lineNo });
    for (const _ of line.matchAll(DETAILS)) page.details.push({ line: lineNo });
    for (const m of line.matchAll(IMG_MD)) page.images.push({ src: m[1], line: lineNo });
    for (const m of line.matchAll(IMG_HTML)) page.images.push({ src: m[1], line: lineNo });
    for (const m of line.matchAll(LINK)) page.links.push({ target: m[1], line: lineNo });
  }

  // Markers may span lines, so they are found in the whole prose text.
  const whole = prose.join('\n');
  const lineAt = (offset) => whole.slice(0, offset).split('\n').length;
  for (const { kind, re } of MARKERS) {
    for (const m of whole.matchAll(re)) page.markers.push({ kind, text: m[1].trim().replace(/\s+/g, ' '), line: lineAt(m.index) });
  }
  page.markers.sort((x, y) => x.line - y.line);

  // The section of a marker: the index of the last heading above it, -1 before the first heading.
  for (const mk of page.markers) mk.section = page.headings.filter((h) => h.line <= mk.line).length - 1;
  return page;
}
