// Compares two parsed pages and sorts the findings into bugs, warnings and passed. `check` is the Check number
// in skills/doc-alignment-checker/SKILL.md, null for the counts that have no Check of their own (images, links,
// admonitions). Severity follows the skill: heading count and levels and code blocks are bugs, the rest warnings.

import { parse } from './parse.mjs';
import { detectUa, enHeadingIds, headingComments, headingText, uaHeadingId } from './headings.mjs';

const trunc = (s, n = 80) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const hLabel = (h) => `${'#'.repeat(h.level)} ${trunc(headingText(h.raw))}`;

class Report {
  constructor(mainPath, secondaryPath, ua) {
    this.main = mainPath;
    this.secondary = secondaryPath;
    this.ua = ua;
    this.bugs = [];
    this.warnings = [];
    this.passed = [];
  }
  bug(check, flag, description, line, file) {
    this.bugs.push({ check, flag, description, line, file });
  }
  warn(check, flag, description, line, file) {
    this.warnings.push({ check, flag, description, line, file });
  }
  // Runs one named sub-check and lists it as passed when it added no finding. `fn` returns false when it
  // could not run, and then it is neither passed nor failed.
  sub(check, name, fn) {
    const before = this.bugs.length + this.warnings.length;
    const ran = fn();
    if (ran !== false && this.bugs.length + this.warnings.length === before) this.passed.push({ check, name });
  }
  toJSON() {
    return { main: this.main, secondary: this.secondary, ua: this.ua, bugs: this.bugs, warnings: this.warnings, passed: this.passed };
  }
}

// Points a count difference at the side that has more: its last item, else line 1 of the secondary file.
function surplus(r, m, s) {
  if (s.length > m.length) return [s.at(-1).line, r.secondary];
  if (m.length > s.length) return [m.at(-1).line, r.main];
  return [1, r.secondary];
}

function countCheck(r, check, name, flag, m, s) {
  r.sub(check, name, () => {
    if (m.length !== s.length) r.warn(check, flag, `main has ${m.length}, secondary has ${s.length}`, ...surplus(r, m, s));
  });
}

function checkDates(r, m, s) {
  r.sub(1, 'Frontmatter dates match', () => {
    if (m.date !== s.date) r.warn(1, 'DATE-MISMATCH', `main: ${m.date ?? '(none)'}, secondary: ${s.date ?? '(none)'}`, s.dateLine ?? 1, r.secondary);
  });
}

function checkHeadingStructure(r, m, s) {
  r.sub(2, 'Heading count and levels', () => {
    if (m.headings.length !== s.headings.length) {
      r.bug(2, 'HEADING-COUNT-MISMATCH', `main has ${m.headings.length} heading(s), secondary has ${s.headings.length}`, s.headings.at(-1)?.line ?? 1, r.secondary);
      return;
    }
    m.headings.forEach((mh, i) => {
      const sh = s.headings[i];
      if (mh.level !== sh.level) r.bug(2, 'HEADING-LEVEL-MISMATCH', `heading ${i + 1}: main '${hLabel(mh)}' is H${mh.level}, secondary '${hLabel(sh)}' is H${sh.level}`, sh.line, r.secondary);
    });
  });
}

// The heading-anchors.md contract. Skipped, with one warning, when neither page reads as UA.
function checkHeadingIds(r, m, s) {
  if (!r.ua) {
    r.warn(2, 'HEADING-ID-SKIPPED', 'cannot tell which page is UA (no Cyrillic text in either, or the same amount); pass --ua main|secondary to check heading ids', 1, r.secondary);
    return;
  }
  const [ua, en, uaFile, enFile] = r.ua === 'main' ? [m, s, r.main, r.secondary] : [s, m, r.secondary, r.main];
  const uaIds = ua.headings.map((h) => (h.level >= 2 ? uaHeadingId(h.raw) : null));

  r.sub(2, 'UA heading ids present, well formed and unique', () => {
    const seen = new Map();
    ua.headings.forEach((h, i) => {
      const u = uaIds[i];
      if (!u) return;
      if (u.problem === 'missing') r.warn(2, 'HEADING-ID-MISSING', `'${hLabel(h)}' has no {/* #id */} comment`, h.line, uaFile);
      else if (u.problem) r.warn(2, 'HEADING-ID-MALFORMED', `'${hLabel(h)}': ${u.problem}`, h.line, uaFile);
      if (u.id) {
        if (seen.has(u.id)) r.warn(2, 'HEADING-ID-DUPLICATE', `id '${u.id}' is also used by the heading on line ${seen.get(u.id)}`, h.line, uaFile);
        else seen.set(u.id, h.line);
      }
    });
  });

  r.sub(2, 'EN headings carry no comment', () => {
    for (const h of en.headings) {
      const c = headingComments(h.raw);
      if (c.length) r.warn(2, 'EN-HEADING-COMMENT', `'${hLabel(h)}' carries {/*${trunc(c[0].body, 40)}*/}; an EN heading takes no comment`, h.line, enFile);
    }
  });

  r.sub(2, 'EN heading ids match the UA ids', () => {
    if (ua.headings.length !== en.headings.length) return false; // positions don't line up
    const enIds = enHeadingIds(en.headings);
    ua.headings.forEach((h, i) => {
      const u = uaIds[i];
      if (!u || u.problem) return;
      const e = enIds[i];
      if (e.id !== u.id) {
        const how = e.explicit ? `explicit id '${e.id}'` : `generated id '${e.id}'`;
        r.warn(2, 'HEADING-ID-MISMATCH', `heading ${i + 1}: EN '${hLabel(en.headings[i])}' has ${how}, the UA heading's id is '${u.id}'`, en.headings[i].line, enFile);
      }
    });
  });
}

function checkTables(r, m, s) {
  r.sub(3, 'Table count, columns and rows', () => {
    if (m.tables.length !== s.tables.length) r.warn(3, 'TABLE-MISMATCH', `main has ${m.tables.length} table(s), secondary has ${s.tables.length}`, ...surplus(r, m.tables, s.tables));
    m.tables.forEach((mt, i) => {
      const st = s.tables[i];
      if (st && (mt.columns !== st.columns || mt.rows !== st.rows)) {
        r.warn(3, 'TABLE-MISMATCH', `table ${i + 1}: main ${mt.columns} columns x ${mt.rows} rows, secondary ${st.columns} columns x ${st.rows} rows`, st.line, r.secondary);
      }
    });
  });
}

function checkCode(r, m, s) {
  r.sub(6, 'Code blocks identical', () => {
    if (m.fences.length !== s.fences.length) {
      r.bug(6, 'CODE-BLOCK-MISMATCH', `main has ${m.fences.length} code block(s), secondary has ${s.fences.length}`, s.fences.at(-1)?.line ?? 1, r.secondary);
      return;
    }
    m.fences.forEach((mf, i) => {
      const sf = s.fences[i];
      if (mf.lines.join('\n') === sf.lines.join('\n')) return;
      let k = 0;
      while (k < mf.lines.length && k < sf.lines.length && mf.lines[k] === sf.lines[k]) k++;
      r.bug(6, 'CODE-BLOCK-MISMATCH', `code block ${i + 1} differs from line ${k + 1} of the block (contents must be byte-for-byte identical)`, sf.line + 1 + k, r.secondary);
    });
  });
}

function checkAdmonitions(r, m, s) {
  r.sub(null, 'Admonition count and types', () => {
    const tally = (list) => {
      const t = {};
      for (const a of list) t[a.type] = (t[a.type] ?? 0) + 1;
      return Object.fromEntries(Object.entries(t).sort());
    };
    const [mt, st] = [tally(m.admonitions), tally(s.admonitions)];
    if (JSON.stringify(mt) !== JSON.stringify(st)) r.warn(null, 'ADMONITION-MISMATCH', `main ${JSON.stringify(mt)}, secondary ${JSON.stringify(st)}`, ...surplus(r, m.admonitions, s.admonitions));
  });
}

// Markers pair by kind. When the heading counts match, they pair section by section; otherwise only the totals
// compare, and the surplus is the last markers of the side that has more.
function checkMarkers(r, m, s) {
  const aligned = m.headings.length === s.headings.length;
  for (const kind of ['ToDo', 'NEEDS CONFIRMATION']) {
    r.sub(8, `${kind} markers paired`, () => {
      const mk = m.markers.filter((x) => x.kind === kind);
      const sk = s.markers.filter((x) => x.kind === kind);
      const groups = aligned ? [...new Set([...mk, ...sk].map((x) => x.section))].sort((a, b) => a - b) : [null];
      for (const g of groups) {
        const a = mk.filter((x) => g === null || x.section === g);
        const b = sk.filter((x) => g === null || x.section === g);
        const where = g === null ? '' : g < 0 ? ' (before the first heading)' : ` (under '${hLabel(m.headings[g])}')`;
        for (const x of a.slice(b.length)) r.warn(8, 'MARKER-MISSING-IN-SECONDARY', `${kind} marker in main has no counterpart in secondary${where}: '${trunc(x.text)}'`, x.line, r.main);
        for (const x of b.slice(a.length)) r.warn(8, 'MARKER-MISSING-IN-MAIN', `${kind} marker in secondary has no counterpart in main${where}: '${trunc(x.text)}'`, x.line, r.secondary);
      }
    });
  }
}

// mainText / secondaryText: the two pages. ua: 'main' | 'secondary' | undefined (detect).
export function compare(mainText, secondaryText, { mainPath = 'main', secondaryPath = 'secondary', ua } = {}) {
  const m = parse(mainText);
  const s = parse(secondaryText);
  const r = new Report(mainPath, secondaryPath, ua ?? detectUa(mainText, secondaryText, m, s));
  checkDates(r, m, s);
  checkHeadingStructure(r, m, s);
  checkHeadingIds(r, m, s);
  checkTables(r, m, s);
  checkCode(r, m, s);
  countCheck(r, 7, '<details> block count', 'DETAILS-BLOCK-COUNT-MISMATCH', m.details, s.details);
  checkMarkers(r, m, s);
  countCheck(r, null, 'Image count', 'IMAGE-COUNT-MISMATCH', m.images, s.images);
  countCheck(r, null, 'Link count', 'LINK-COUNT-MISMATCH', m.links, s.links);
  checkAdmonitions(r, m, s);
  return r.toJSON();
}
