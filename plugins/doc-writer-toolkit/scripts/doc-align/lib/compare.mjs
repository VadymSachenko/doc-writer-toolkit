// Compares two parsed pages and sorts the findings into bugs, warnings and passed. `check` is the Check number
// in skills/doc-alignment-checker/SKILL.md, null for the counts that have no Check of their own (images, links,
// admonitions). Severity follows the skill: heading count and levels, code blocks and Cyrillic left in the EN page's
// code text are bugs, the rest warnings.
// With a names table (--names), Check 12 also compares the names of organizations against it. With the existing pairs
// of an example values file (--examples), Check 6 counts a listed pair as the same value.

import { parse } from './parse.mjs';
import { detectUa, headingComments, headingText, uaHeadingId } from './headings.mjs';
import { findNames, searchable } from './names.mjs';
import { codeDiff, cyrillicText, fenceParts } from './fences.mjs';
import { headingIdMismatches } from './ids.mjs';
import { pairMatcher, pairedCodeDiff } from './examples.mjs';

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
    const out = { main: this.main, secondary: this.secondary, ua: this.ua, bugs: this.bugs, warnings: this.warnings, passed: this.passed };
    if (this.names) out.names = this.names;
    if (this.examples) out.examples = this.examples;
    return out;
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
    const found = headingIdMismatches(ua, en);
    if (found === null) return false; // positions don't line up
    for (const x of found) {
      const how = x.explicit ? `explicit id '${x.enId}'` : `generated id '${x.enId}'`;
      r.warn(2, 'HEADING-ID-MISMATCH', `heading ${x.index + 1}: EN '${hLabel(en.headings[x.index])}' has ${how}, the UA heading's id is '${x.uaId}'`, x.enLine, enFile);
    }
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

// Check 6 compares each block's code part (code-blocks.md, fences.mjs): a diagram by its ids, keywords, arrows and
// lines, any other block by everything but its comments and tree descriptions. Those are translated. With the existing
// pairs of an example values file, a quoted UA value of a pair may be its EN value on the EN side (examples.mjs).
function checkCode(r, m, s, examples) {
  const matcher = examplePairs(r, examples);
  r.sub(6, 'Code blocks keep their code', () => {
    if (m.fences.length !== s.fences.length) {
      r.bug(6, 'CODE-BLOCK-MISMATCH', `main has ${m.fences.length} code block(s), secondary has ${s.fences.length}`, s.fences.at(-1)?.line ?? 1, r.secondary);
      return;
    }
    const used = [];
    m.fences.forEach((mf, i) => {
      const sf = s.fences[i];
      const k = !matcher ? codeDiff(mf, sf) : r.ua === 'main' ? pairedCodeDiff(mf, sf, matcher, used) : pairedCodeDiff(sf, mf, matcher, used);
      if (k < 0) return;
      const what = fenceParts(mf.info, mf.lines).kind === 'diagram' ? 'the diagram ids, keywords, arrows and lines' : 'the code, data and line count';
      r.bug(6, 'CODE-BLOCK-MISMATCH', `code block ${i + 1} differs from line ${k + 1} of the block (${what} must be identical; only labels, comments and descriptions are translated)`, sf.line + 1 + k, r.secondary);
    });
    if (!matcher) return;
    for (const row of examples.rows) {
      const lines = used.filter((u) => u === row).length;
      if (lines) r.examples.matched.push({ ua: row.ua, en: row.en, type: row.type, lines });
    }
  });
}

// The pairs matcher for Check 6, or null. Sets the report's `examples` field, and warns when a pair can't be used: the
// file has no pairs section, a row is not a valid pair, or neither page reads as UA (a pair has a direction).
function examplePairs(r, examples) {
  if (!examples) return null;
  r.examples = { pairs: examples.rows.length, matched: [] };
  if (!examples.found) {
    r.warn(6, 'EXAMPLE-PAIRS-MISSING', `no existing pairs section ('## Existing pairs' or '## Наявні пари') in ${examples.file}`, 1, examples.file);
    return null;
  }
  for (const x of examples.invalid) r.warn(6, 'EXAMPLE-PAIR-INVALID', `row skipped: ${x.reason}`, x.line, examples.file);
  if (!r.ua) {
    r.warn(6, 'EXAMPLES-SKIPPED', 'cannot tell which page is UA (a pair goes from UA to EN); pass --ua main|secondary to use the existing pairs', 1, r.secondary);
    return null;
  }
  return examples.rows.length ? pairMatcher(examples.rows) : null;
}

// Check 9, inside code blocks: Cyrillic left in the EN page's diagram labels, code comments and tree descriptions. The
// prose part of Check 9 is the skill's. Data in a block (a JSON value, a string) keeps its Cyrillic.
function checkCodeText(r, m, s) {
  r.sub(9, 'No Cyrillic in EN diagram labels or code comments', () => {
    if (!r.ua) return false;
    const [en, enFile] = r.ua === 'main' ? [s, r.secondary] : [m, r.main];
    en.fences.forEach((f, i) => {
      for (const t of cyrillicText(f.info, f.lines)) {
        r.bug(9, 'CYRILLIC-IN-EN-CODE-TEXT', `code block ${i + 1}: '${trunc(t.text, 60)}' is a label, comment or description left untranslated`, f.line + 1 + t.line, enFile);
      }
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

// Check 12, names of organizations (Ж10): each name a names-table row finds in a page must be that row's form for
// the page's language. A UA form and an EN form that differ are a pair, not a mismatch. A row found in one page
// only is reported too. Names the table lacks are the skill's to find: the script knows only the table's rows.
function checkNames(r, m, s, names) {
  const tableFile = names.tables[0]?.file ?? r.secondary;
  r.names = { rows: names.rows.length, found: [] };
  if (!names.tables.some((t) => t.found)) {
    r.warn(12, 'NAMES-TABLE-MISSING', `no names table (a table under '## Names' or '## Назви') in ${names.tables.map((t) => t.file).join(', ')}`, 1, tableFile);
    return;
  }
  if (!r.ua) {
    r.warn(12, 'NAMES-SKIPPED', 'cannot tell which page is UA; pass --ua main|secondary to check names', 1, r.secondary);
    return;
  }
  const side = (page, isUa) => findNames(searchable(page.prose), names.rows, isUa ? 'ua' : 'en');
  const inMain = side(m, r.ua === 'main');
  const inSecondary = side(s, r.ua === 'secondary');
  r.sub(12, 'Names follow the names table', () => {
    for (const [hits, file, isUa] of [[inMain, r.main, r.ua === 'main'], [inSecondary, r.secondary, r.ua === 'secondary']]) {
      for (const h of hits.filter((x) => !x.exact)) {
        const row = names.rows[h.index];
        const lang = isUa ? 'UA' : 'EN';
        r.warn(12, 'NAME-SPELLING', `'${h.text}' is not the names table's ${lang} form '${isUa ? row.ua : row.en}'`, h.line, file);
      }
    }
    names.rows.forEach((row, i) => {
      const a = inMain.filter((h) => h.index === i);
      const b = inSecondary.filter((h) => h.index === i);
      if (a.length || b.length) r.names.found.push({ ua: row.ua, en: row.en, main: a.length, secondary: b.length });
      const label = row.ua === row.en ? `'${row.ua}'` : `'${row.ua}' / '${row.en}'`;
      if (a.length && !b.length) r.warn(12, 'NAME-MISSING-IN-SECONDARY', `${label} is named in main (${a.length}x), not in secondary`, a[0].line, r.main);
      if (b.length && !a.length) r.warn(12, 'NAME-MISSING-IN-MAIN', `${label} is named in secondary (${b.length}x), not in main`, b[0].line, r.secondary);
    });
  });
}

// mainText / secondaryText: the two pages. ua: 'main' | 'secondary' | undefined (detect). names: the names table
// for Check 12, { tables: [{ file, found }], rows: [{ ua, en, source }] }, or undefined to skip the check. examples: the
// existing pairs for Check 6, { file, found, rows: [{ ua, en, type, line }], invalid }, or undefined for none.
export function compare(mainText, secondaryText, { mainPath = 'main', secondaryPath = 'secondary', ua, names, examples } = {}) {
  const m = parse(mainText);
  const s = parse(secondaryText);
  const r = new Report(mainPath, secondaryPath, ua ?? detectUa(mainText, secondaryText, m, s));
  checkDates(r, m, s);
  checkHeadingStructure(r, m, s);
  checkHeadingIds(r, m, s);
  checkTables(r, m, s);
  checkCode(r, m, s, examples);
  checkCodeText(r, m, s);
  countCheck(r, 7, '<details> block count', 'DETAILS-BLOCK-COUNT-MISMATCH', m.details, s.details);
  checkMarkers(r, m, s);
  countCheck(r, null, 'Image count', 'IMAGE-COUNT-MISMATCH', m.images, s.images);
  countCheck(r, null, 'Link count', 'LINK-COUNT-MISMATCH', m.links, s.links);
  checkAdmonitions(r, m, s);
  if (names) checkNames(r, m, s, names);
  return r.toJSON();
}
