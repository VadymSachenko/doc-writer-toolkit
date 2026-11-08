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
  // and in every page under the given roots. A link reaches the page when it reaches either file, or its route.
  const good = report.proposals.filter((p) => !p.problem);
  const byFragment = new Map(report.proposals.map((p) => [p.oldFragment, p]));
  const resolvedRoots = roots.map((r) => ({ ...r, abs: path.resolve(r.dir) }));
  const uaAbs = path.resolve(uaPath);
  const enAbs = path.resolve(enPath);
  const self = new Set([uaAbs, enAbs]);
  const reach = pageRoutes(uaAbs, uaText, resolvedRoots);
  if (roots.length && !reach) report.warnings.push(`${uaPath} is under none of the given roots: only links on the two pages and relative .md links are found`);
  if (!roots.length) report.warnings.push('no --root given: only links on the UA and EN pages themselves are found');
  const files = [uaAbs, enAbs];
  for (const r of resolvedRoots) await walk(r.abs, files);
  const edits = new Map(); // abs file -> [{ line, start, end, id }]
  for (const file of [...new Set(files)]) {
    const text = file === uaAbs ? uaText : file === enAbs ? enText : await fs.readFile(file, 'utf8');
    const display = file === uaAbs ? uaPath : file === enAbs ? enPath : toPosix(path.relative(process.cwd(), file));
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
          report.unresolved.push({ ...row, reason: l.path.startsWith('/') ? 'a site-root link, and the UA page is under none of the given roots' : 'a relative link that is not a .md/.mdx file path' });
          continue;
        }
        if (p.problem) continue;
        report.links.push({ ...row, newUrl: `${l.path}#${p.id}` });
        if (!edits.has(file)) edits.set(file, { display, text, list: [] });
        edits.get(file).list.push({ line: n, start: l.start, end: l.end, id: p.id });
      }
    });
  }

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
