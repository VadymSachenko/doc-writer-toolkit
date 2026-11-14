// Proposes the missing heading ids of a UA page from its EN page, and finds the links that use the old fragments
// (context/doc-rules/project-rules/heading-anchors.md, rules 2, 6 and 8). The id of a UA heading without one is the
// anchor of the EN heading at the same position: its explicit `\{#id}` (or `{#id}`), else the slug Docusaurus generates from its
// text. The old fragment is the slug Docusaurus generated from the UA text. With `write`, the ids go onto the UA
// heading lines and the links get the new fragment; no other byte changes, and no line is added or removed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from './parse.mjs';
import { createSlugger, EXPLICIT_ID, enHeadingIds, headingText, ID_FORM, slugSource, uaHeadingId } from './headings.mjs';
import { docRoute } from '../../locale-sync/lib/links.mjs';

const posix = path.posix;
const toPosix = (p) => p.split(path.sep).join('/');
const label = (h) => `${'#'.repeat(h.level)} ${headingText(h.raw)}`;

// A link target: `](target)`, `href="target"` or `to="target"`, `[label]: target`. Group 2, 4 or 6 is the target.
const LINK = /(\]\(\s*<?)([^)\s>]*)|(\b(?:href|to)[ \t]*=[ \t]*["'])([^"']*)|(^[ \t]*\[[^\]]+\]:[ \t]*)(\S+)/g;

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Every link target with a fragment on one prose line (code already blanked): the path, the fragment as written and
// decoded, and where the fragment starts and ends on the line.
export function fragmentLinks(line) {
  const out = [];
  for (const m of line.matchAll(LINK)) {
    const pre = m[1] ?? m[3] ?? m[5];
    const target = m[2] ?? m[4] ?? m[6];
    const hash = target.indexOf('#');
    if (hash < 0) continue;
    const start = m.index + pre.length + hash + 1;
    out.push({ url: target, path: target.slice(0, hash), fragment: decode(target.slice(hash + 1)), start, end: m.index + pre.length + target.length });
  }
  return out;
}

const normRoute = (r) => decode(r.replace(/[?].*$/, '')).replace(/\/+$/, '') || '/';

// The site-root-relative links that reach the UA page: the route Docusaurus gives it, the route `internal-links.md`
// builds (URL prefix + path without extension) and the file-path form (`/` + path with extension).
function pageRoutes(uaAbs, uaText, roots) {
  const root = roots.find((r) => uaAbs.startsWith(r.abs + path.sep));
  if (!root) return null;
  const rel = toPosix(path.relative(root.abs, uaAbs));
  const id = rel.replace(/\.mdx?$/, '');
  const prefix = '/' + root.prefix.split('/').filter(Boolean).join('/');
  const routes = new Set([docRoute({ urlPrefix: root.prefix }, { id }, uaText), posix.join(prefix, id), `/${rel}`].map(normRoute));
  return { root: root.dir, routes };
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && /\.mdx?$/.test(e.name)) out.push(p);
  }
}

// uaPath / enPath: the two pages. roots: [{ dir, prefix }], the UA content roots to search for links (dir as given,
// prefix the root's UA URL prefix). write: apply the proposals without a problem and rewrite their links.
export async function proposeIds(uaText, enText, { uaPath, enPath, roots = [], write = false }) {
  const ua = parse(uaText);
  const en = parse(enText);
  const report = { ua: uaPath, en: enPath, proposals: [], links: [], unresolved: [], skipped: [], warnings: [] };

  // Old fragments: Docusaurus slugs every heading without an id, the page title included, in page order; a heading
  // with an id takes no slug.
  const slug = createSlugger();
  const uaInfo = ua.headings.map((h) => {
    const u = h.level >= 2 ? uaHeadingId(h.raw) : null;
    const explicit = EXPLICIT_ID.test(h.raw);
    const hasId = explicit || (u ? u.id !== null : false);
    return { h, u, explicit, oldFragment: hasId ? null : slug(slugSource(h.raw)) };
  });
  const missing = uaInfo.filter((x) => x.u?.problem === 'missing' && !x.explicit);
  for (const x of uaInfo.filter((y) => y.u?.problem === 'missing' && y.explicit)) {
    report.skipped.push({ line: x.h.line, heading: label(x.h), reason: 'the heading has an explicit id (\\{#id} or {#id}): replace it with a {/* #id */} comment by hand' });
  }
  if (!missing.length) return finish(report);

  if (ua.headings.length !== en.headings.length) {
    report.reason = `the UA page has ${ua.headings.length} heading(s), the EN page ${en.headings.length}: positions don't line up, nothing is proposed`;
    for (const x of missing) report.skipped.push({ line: x.h.line, heading: label(x.h), reason: 'heading counts differ' });
    return finish(report);
  }

  const enIds = enHeadingIds(en.headings);
  const taken = new Map(); // id -> UA line that has it
  for (const x of uaInfo) if (x.u?.id) taken.set(x.u.id, x.h.line);
  for (const x of missing) {
    const i = ua.headings.indexOf(x.h);
    const eh = en.headings[i];
    if (eh.level !== x.h.level) {
      report.skipped.push({ line: x.h.line, heading: label(x.h), reason: `the EN heading at this position is H${eh.level} ('${label(eh)}'), the UA one H${x.h.level}` });
      continue;
    }
    const e = enIds[i];
    const p = { line: x.h.line, heading: label(x.h), id: e.id, from: e.explicit ? 'explicit' : 'generated', enLine: eh.line, enHeading: label(eh), oldFragment: x.oldFragment };
    if (!ID_FORM.test(e.id)) p.problem = `'${e.id}' is not lowercase ASCII kebab-case: give the EN heading a wording that slugs to one, or an explicit \\{#id} (heading-anchors.md, rule 6), and run again`;
    else if (taken.has(e.id)) p.problem = `'${e.id}' is already the id of the UA heading on line ${taken.get(e.id)}`;
    else taken.set(e.id, x.h.line);
    report.proposals.push(p);
  }

  // Links that use an old fragment: on the UA page and the EN page themselves (EN copies UA link targets verbatim),
  // and in every page under the given roots.
  const good = report.proposals.filter((p) => !p.problem);
  const found = await linksTo({ uaPath, uaText, enPath, enText, roots, byFragment: new Map(report.proposals.map((p) => [p.oldFragment, { id: p.id, line: p.line, problem: p.problem }])) });
  report.links.push(...found.links);
  report.unresolved.push(...found.unresolved);
  report.warnings.push(...found.warnings);
  const edits = found.edits;
  const uaAbs = path.resolve(uaPath);

  if (write && good.length) {
    const lines = (edits.get(uaAbs)?.text ?? uaText).split('\n');
    for (const p of good) {
      const [, body, cr] = lines[p.line - 1].match(/^(.*?)[ \t]*(\r?)$/);
      lines[p.line - 1] = `${body} {/* #${p.id} */}${cr}`;
    }
    const uaEdits = edits.get(uaAbs);
    if (uaEdits) applyLinkEdits(lines, uaEdits.list);
    await fs.writeFile(uaAbs, lines.join('\n'));
    report.written = [uaPath];
    for (const [file, e] of edits) {
      if (file === uaAbs) continue;
      const l = e.text.split('\n');
      applyLinkEdits(l, e.list);
      await fs.writeFile(file, l.join('\n'));
      report.written.push(e.display);
    }
  }
  return finish(report);
}

// The links that reach the UA page through one of the fragments of `byFragment` (fragment -> { id, line, problem }:
// the id it becomes, the UA heading's line, and why it can't, if so): on the UA page, the EN page and the other pages
// of the same page (`selves`, the further locales'), and in every page under the roots. A link reaches the page when it
// reaches one of those files, or the UA page's route. Returns { links, unresolved, warnings, edits }: `edits` maps a
// file to its text and the fragments to replace, for a link of a fragment with no problem.
export async function linksTo({ uaPath, uaText, enPath, enText, selves = [], roots = [], byFragment }) {
  const out = { links: [], unresolved: [], warnings: [], edits: new Map() };
  const resolvedRoots = roots.map((r) => ({ ...r, abs: path.resolve(r.dir) }));
  const uaAbs = path.resolve(uaPath);
  const enAbs = path.resolve(enPath);
  const others = new Map(selves.map((x) => [path.resolve(x.path), x]));
  const self = new Set([uaAbs, enAbs, ...others.keys()]);
  const reach = pageRoutes(uaAbs, uaText, resolvedRoots);
  if (roots.length && !reach) out.warnings.push(`${uaPath} is under none of the given roots: only links on the two pages and relative .md links are found`);
  if (!roots.length) out.warnings.push('no --root given: only links on the UA and EN pages themselves are found');
  const files = [uaAbs, enAbs, ...others.keys()];
  for (const r of resolvedRoots) await walk(r.abs, files);
  for (const file of [...new Set(files)]) {
    const text = file === uaAbs ? uaText : file === enAbs ? enText : others.has(file) ? others.get(file).text : await fs.readFile(file, 'utf8');
    const display = file === uaAbs ? uaPath : file === enAbs ? enPath : others.has(file) ? others.get(file).path : toPosix(path.relative(process.cwd(), file));
    parse(text).prose.forEach((line, n) => {
      for (const l of fragmentLinks(line)) {
        const p = byFragment.get(l.fragment);
        if (!p) continue;
        let hit = null;
        if (l.path === '') hit = self.has(file);
        else if (/^[a-z][a-z0-9+.-]*:/i.test(l.path)) hit = false;
        else if (l.path.startsWith('/')) hit = reach ? reach.routes.has(normRoute(l.path)) : null;
        else if (/\.mdx?$/.test(decode(l.path))) hit = self.has(path.resolve(path.dirname(file), decode(l.path)));
        if (hit === false) continue;
        const row = { file: display, line: n + 1, url: l.url, heading: p.line };
        if (hit === null) {
          out.unresolved.push({ ...row, reason: l.path.startsWith('/') ? 'a site-root link, and the UA page is under none of the given roots' : 'a relative link that is not a .md/.mdx file path' });
          continue;
        }
        if (p.problem) continue;
        out.links.push({ ...row, newUrl: `${l.path}#${p.id}` });
        if (!out.edits.has(file)) out.edits.set(file, { display, text, list: [] });
        out.edits.get(file).list.push({ line: n, start: l.start, end: l.end, id: p.id });
      }
    });
  }
  return out;
}

// The UA and EN headings at the same position whose ids differ (`HEADING-ID-MISMATCH`, Check 2), from two parsed pages:
// { index, level, uaLine, uaHeading, uaId, enLine, enHeading, enId, explicit }. A UA heading without a well-formed id
// has none to compare. Null when the heading counts differ, so the positions don't line up.
export function headingIdMismatches(ua, en) {
  if (ua.headings.length !== en.headings.length) return null;
  const enIds = enHeadingIds(en.headings);
  const out = [];
  ua.headings.forEach((h, i) => {
    const u = h.level >= 2 ? uaHeadingId(h.raw) : null;
    if (!u || u.problem) return;
    const e = enIds[i];
    if (e.id !== u.id) out.push({ index: i, level: h.level, uaLine: h.line, uaHeading: label(h), uaId: u.id, enLine: en.headings[i].line, enHeading: label(en.headings[i]), enId: e.id, explicit: e.explicit });
  });
  return out;
}

// An EN heading line given its id explicitly (rule 6): `\{#id}` at its end, in place of an explicit id it had. Only
// the id changes, never a word.
export function withExplicitId(line, id) {
  const [, body, cr] = line.match(/^(.*?)[ \t]*(\r?)$/);
  return `${body.replace(EXPLICIT_ID, '')} \\{#${id}}${cr}`;
}

// Renames heading ids of a UA page, each `{ from, to }`: its `{/* #from */}` comment on the UA page and on the further
// locales' pages of the same page (`locales`: [{ path, text }]; they carry the comment verbatim, rule 7) becomes
// `{/* #to */}`, and every link to `#from` that reaches the page, under the roots, gets `#to`. For a heading new in the
// change, or a published one a person asked to rename (rule 4 otherwise keeps it). No other byte changes, and no line
// is added or removed. Returns { renamed: [{ from, to, line, locales }], links, unresolved, skipped, written }.
export async function renameIds(uaText, enText, { uaPath, enPath, locales = [], roots = [], renames = [], write = false }) {
  const report = { ua: uaPath, en: enPath, renamed: [], links: [], unresolved: [], skipped: [], warnings: [] };
  const ua = parse(uaText);
  const ids = new Map();
  for (const h of ua.headings) {
    const u = h.level >= 2 ? uaHeadingId(h.raw) : null;
    if (u?.id && !u.problem) ids.set(u.id, h.line);
  }
  const comment = (id) => new RegExp(`\\{\\/\\*[ \\t]*#${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\*\\/\\}`);
  // A target is checked against the ids the page has once every rename is made, so a chain (`example` → `sample`,
  // `example-1` → `example`) is made whole: a target is free when no heading keeps it and no other rename takes it.
  const todo = [];
  const formed = [];
  for (const r of renames) {
    if (!ids.has(r.from)) report.skipped.push({ from: r.from, to: r.to, reason: `no UA heading has the id '${r.from}'` });
    else if (!ID_FORM.test(r.to)) report.skipped.push({ from: r.from, to: r.to, reason: `'${r.to}' is not lowercase ASCII kebab-case` });
    else if (formed.some((x) => x.from === r.from)) report.skipped.push({ from: r.from, to: r.to, reason: `the id '${r.from}' is renamed twice` });
    else formed.push(r);
  }
  const moving = new Set(formed.map((r) => r.from));
  for (const r of formed) {
    if (ids.has(r.to) && !moving.has(r.to)) report.skipped.push({ from: r.from, to: r.to, reason: `'${r.to}' is already the id of the UA heading on line ${ids.get(r.to)}` });
    else if (formed.some((x) => x !== r && x.to === r.to)) report.skipped.push({ from: r.from, to: r.to, reason: `another heading is renamed to '${r.to}' too` });
    else todo.push({ ...r, line: ids.get(r.from) });
  }
  const pages = locales.map((x) => ({ ...x, lines: x.text.split('\n'), heads: new Set(parse(x.text).headings.map((h) => h.line - 1)) }));
  for (const r of todo) {
    const hits = [];
    for (const pg of pages) for (const i of pg.heads) if (comment(r.from).test(pg.lines[i])) hits.push({ page: pg, i });
    report.renamed.push({ from: r.from, to: r.to, line: r.line, locales: hits.map((x) => ({ file: x.page.path, line: x.i + 1 })) });
    r.hits = hits;
  }
  if (!todo.length) return finish(report);
  const found = await linksTo({ uaPath, uaText, enPath, enText, selves: locales, roots, byFragment: new Map(todo.map((r) => [r.from, { id: r.to, line: r.line }])) });
  report.links.push(...found.links);
  report.unresolved.push(...found.unresolved);
  report.warnings.push(...found.warnings);
  if (write) {
    const uaAbs = path.resolve(uaPath);
    const texts = new Map([[uaAbs, { display: uaPath, lines: uaText.split('\n') }]]);
    for (const pg of pages) texts.set(path.resolve(pg.path), { display: pg.path, lines: pg.lines });
    for (const r of todo) {
      const ul = texts.get(uaAbs).lines;
      ul[r.line - 1] = ul[r.line - 1].replace(comment(r.from), `{/* #${r.to} */}`);
      for (const x of r.hits) x.page.lines[x.i] = x.page.lines[x.i].replace(comment(r.from), `{/* #${r.to} */}`);
    }
    for (const [file, e] of found.edits) {
      if (!texts.has(file)) texts.set(file, { display: e.display, lines: e.text.split('\n') });
      applyLinkEdits(texts.get(file).lines, e.list);
    }
    report.written = [];
    for (const [file, t] of texts) {
      const before = file === uaAbs ? uaText : pages.find((pg) => path.resolve(pg.path) === file)?.text ?? found.edits.get(file)?.text;
      const after = t.lines.join('\n');
      if (after === before) continue;
      await fs.writeFile(file, after);
      report.written.push(t.display);
    }
  }
  return finish(report);
}

// Replaces each fragment on its line, right to left so the offsets stay valid. Only the fragment changes.
function applyLinkEdits(lines, list) {
  for (const e of [...list].sort((a, b) => b.line - a.line || b.start - a.start)) {
    const l = lines[e.line];
    lines[e.line] = l.slice(0, e.start) + e.id + l.slice(e.end);
  }
}

function finish(report) {
  if (!report.warnings.length) delete report.warnings;
  return report;
}
