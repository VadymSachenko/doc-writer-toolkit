import { CliError } from '../../ui-labels/lib/util.mjs';
import { alignTrees } from './diff.mjs';
import { anchorPath, boldSpans, nodeText, PROSE_FM_KEYS, sectionPath, splitCode, wordCount } from './parse.mjs';

// Re-translating chosen blocks of a page that is current (`blocks --redo`, `apply --redo`): a term correction reaches
// the pages through it (`terms --usage` finds the blocks). A block is picked by any line of it in the translation, and
// paired with its UA counterpart in the current UA page the way `check` pairs them (heading by heading, block by block).

// "12,14-16" -> [12, 14, 15, 16]
export function parseLines(spec) {
  const out = new Set();
  for (const part of String(spec).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m || (m[2] && Number(m[2]) < Number(m[1]))) throw new CliError(`--redo takes target line numbers ("12,14-16") or "all", not '${spec}'.`, { code: 2 });
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) out.add(i);
  }
  if (!out.size) throw new CliError('--redo needs at least one line number, or "all".', { code: 2 });
  return [...out].sort((a, b) => a - b);
}

// The node of the translation at line index i: a heading (its section), a table row, a table (its header lines) or a leaf.
export function nodeAt(sec, i) {
  for (const c of sec.children) {
    if (i < c.start || i > c.end) continue;
    if (c.type === 'section') return i <= c.headEnd ? c : nodeAt(c, i);
    if (c.type === 'table') return c.children.find((r) => r.start === i) ?? c;
    return c;
  }
  return null;
}

const span = (page, s, e) => ({ lines: [s + 1, e + 1], text: nodeText(page, s, e) });
const kindOf = (n) => (n.type === 'section' ? 'heading' : n.type === 'row' ? 'table-row' : n.type);
const endOf = (n) => (n.type === 'section' ? n.headEnd : n.end);
const isVerbatim = (page, n) => n.type === 'import' || (n.type === 'code' && !/mermaid/i.test(page.lines[n.start]));

// Changes ({ id, op: 'replace', kind, ua, target, … }, as `blocks` returns them) for the blocks at `lines` (1-based, in
// the translation), plus the lines that pick nothing (`skipped`, with a reason) or whose block has no UA counterpart
// (`unmapped`).
export function blocksAtLines(pageB, pageT, lines) {
  const { map } = alignTrees(pageB.root, pageT.root);
  const back = new Map([...map].map(([b, t]) => [t, b]));
  const picked = new Map();
  const skipped = [];
  const unmapped = [];
  for (const line of lines) {
    const i = line - 1;
    if (i < 0 || i >= pageT.lines.length) {
      skipped.push({ line, reason: 'past the end of the translation' });
      continue;
    }
    if (pageT.fm && i <= pageT.fm.end) {
      const e = pageT.fm.entries.find((x) => i >= x.start && i <= x.end);
      const b = e && pageB.fm?.entries.find((x) => x.key === e.key);
      if (!e || !PROSE_FM_KEYS.has(e.key)) skipped.push({ line, reason: e ? `frontmatter '${e.key}' is not prose` : 'frontmatter delimiter' });
      else if (!b) unmapped.push({ line, reason: `the UA page has no '${e.key}' key` });
      else picked.set(`fm:${e.key}`, { fm: true, key: e.key, t: e, b });
      continue;
    }
    const t = nodeAt(pageT.root, i);
    if (!t) {
      skipped.push({ line, reason: 'blank line' });
      continue;
    }
    if (isVerbatim(pageT, t)) {
      skipped.push({ line, reason: 'code or import, copied verbatim' });
      continue;
    }
    const b = back.get(t);
    if (!b) unmapped.push({ line, reason: 'the block has no counterpart in the UA page (the translation does not mirror it here)' });
    else picked.set(t, { t, b });
  }
  // A whole table picked through its header covers its rows.
  for (const [k, v] of picked) if (v.t?.type === 'row' && picked.has(v.t.parent)) picked.delete(k);

  const ordered = [...picked.values()].sort((x, y) => x.t.start - y.t.start);
  const changes = ordered.map((p, n) => {
    const id = `c${n + 1}`;
    if (p.fm) return { id, op: 'replace', kind: 'frontmatter', key: p.key, headingPath: [], verbatim: false, ua: { lines: [p.b.start + 1, p.b.end + 1], text: p.b.raw }, target: { lines: [p.t.start + 1, p.t.end + 1], text: p.t.raw } };
    const ua = span(pageB, p.b.start, endOf(p.b));
    const prose = splitCode(ua.text).prose;
    return { id, op: 'replace', kind: kindOf(p.b), headingPath: sectionPath(p.b), anchorPath: anchorPath(p.b), ua, bold: boldSpans(prose), words: wordCount(prose.join('\n')), verbatim: false, target: span(pageT, p.t.start, endOf(p.t)) };
  });
  return { changes, skipped, unmapped };
}
