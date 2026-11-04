// The id-only change of context/doc-rules/project-rules/heading-anchors.md ("Id-only changes"), word for word:
//
//   A UA change is id-only when its only differences from the approved version are (1) `{/* #id */}` comments added
//   to headings that had none, and (2) link fragments rewritten from such a heading's old fragment to its new id.
//   Anything else makes it a real change: a changed or removed id, a changed heading text, or any other edit. A
//   heading's old fragment is the slug Docusaurus made of its text. A link to another page counts when its path
//   resolves to a page of the same change whose heading got that id; one that doesn't resolve is a real change.
//
// `isIdOnlyChange` is that predicate, the one implementation every script uses. It compares line by line: adding a
// comment or rewriting a fragment adds no line. Fenced and inline code, and the frontmatter, are never a link: a
// difference there is a real change.

import path from 'node:path';
import { parse } from './parse.mjs';
import { createSlugger, EXPLICIT_ID, slugSource } from './headings.mjs';
import { fragmentLinks } from './ids.mjs';

const posix = path.posix;
const ID_COMMENT = /[ \t]*\{\/\*[ \t]*#([^*{}\s]+)[ \t]*\*\/\}[ \t]*$/;
const lines = (text) => String(text).replace(/\r\n/g, '\n').split('\n');
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// The headings of a page outside code, by line index: level, text without the id comment, the id (comment or explicit
// `{#id}`), and for a heading without an id its slug, numbered the way Docusaurus numbers repeats.
function headingsOf(text) {
  const slug = createSlugger();
  const out = new Map();
  for (const h of parse(text).headings) {
    const c = h.raw.match(ID_COMMENT);
    const body = c ? h.raw.slice(0, c.index) : h.raw;
    const explicit = body.match(EXPLICIT_ID);
    const id = c ? c[1] : explicit ? explicit[1] : null;
    out.set(h.line - 1, { level: h.level, text: body.trim(), id, slug: id ? null : slug(slugSource(h.raw)) });
  }
  return out;
}

// The ids a change added to headings that had none: old fragment -> new id. Only when the page keeps the same headings
// in the same order, each with the same level and text.
function addedIds(before, after) {
  const a = [...headingsOf(before).values()];
  const b = [...headingsOf(after).values()];
  const map = new Map();
  if (a.length !== b.length) return map;
  a.forEach((x, i) => {
    const y = b[i];
    if (x.level === y.level && x.text === y.text && !x.id && y.id) map.set(x.slug, y.id);
  });
  return map;
}

// A line with every link fragment (in prose: code blanked) replaced by a placeholder, and those links in order.
function linkSkeleton(raw, prose) {
  const links = fragmentLinks(prose ?? '');
  let out = raw;
  for (const l of [...links].reverse()) out = `${out.slice(0, l.start)}\u0000${out.slice(l.end)}`;
  return { skeleton: out, links };
}

const bare = (p) => p.replace(/\.mdx?$/, '');
// The forms a page's path takes in a route: without extension, `index` dropped, `folder/folder` collapsed to the
// folder, number prefixes dropped.
function routeForms(file) {
  const b = bare(file);
  const segs = b.split('/');
  const forms = new Set([b]);
  if (segs.at(-1) === 'index' || segs.at(-1) === segs.at(-2)) forms.add(segs.slice(0, -1).join('/'));
  for (const f of [...forms]) forms.add(f.split('/').map((s) => s.replace(/^\d+\s*[-_.]\s*(?=\S)/, '')).join('/'));
  return [...forms];
}

// The page of the change a link path reaches: a relative `.md`/`.mdx` path from the linking page, or a site-root route
// or file path matched against the end of a page's path. Null when it reaches no page of the change, or more than one.
function resolve(fromPath, linkPath, pages) {
  const target = decode(linkPath).replace(/[?].*$/, '');
  if (!target.startsWith('/') && /\.mdx?$/.test(target)) {
    const joined = posix.normalize(posix.join(posix.dirname(fromPath), target));
    return pages.find((p) => p.path === joined) ?? null;
  }
  if (!target.startsWith('/')) return null;
  const route = bare(target.replace(/^\/+|\/+$/g, ''));
  if (!route) return null;
  const hits = pages.filter((p) => routeForms(p.path).some((f) => f === route || f.endsWith(`/${route}`)));
  return hits.length === 1 ? hits[0] : null;
}

// True when `page` ({ path, before, after }) changed by ids only, as defined above. `changeSet`: every page of the same
// change, `page` among them, so that a link rewritten to another page's new id can be checked. A page new or removed
// in the change is a real change.
export function isIdOnlyChange(page, changeSet = [page]) {
  const { before, after } = page;
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  if (before === after) return true;
  const a = lines(before);
  const b = lines(after);
  if (a.length !== b.length) return false;
  const pages = changeSet.filter((p) => typeof p.before === 'string' && typeof p.after === 'string');
  if (!pages.includes(page)) pages.push(page);
  const added = new Map();
  const idsOf = (p) => {
    if (!added.has(p)) added.set(p, addedIds(p.before, p.after));
    return added.get(p);
  };
  const headA = headingsOf(before);
  const headB = headingsOf(after);
  const proseA = parse(before).prose;
  const proseB = parse(after).prose;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ha = headA.get(i);
    const hb = headB.get(i);
    if (ha || hb) {
      // (1) A heading that had no id got one, its level and text unchanged.
      if (!ha || !hb || ha.level !== hb.level || ha.text !== hb.text || ha.id || !hb.id) return false;
      if (idsOf(page).get(ha.slug) !== hb.id) return false;
      continue;
    }
    // (2) Any other line differs only in link fragments, each rewritten from a heading's old fragment to its new id.
    const la = linkSkeleton(a[i], proseA[i]);
    const lb = linkSkeleton(b[i], proseB[i]);
    if (la.skeleton !== lb.skeleton || la.links.length !== lb.links.length) return false;
    for (let k = 0; k < la.links.length; k++) {
      const [from, to] = [la.links[k], lb.links[k]];
      if (from.path !== to.path) return false;
      if (from.fragment === to.fragment) continue;
      const target = from.path === '' ? page : resolve(page.path ?? '', from.path, pages);
      if (!target || idsOf(target).get(from.fragment) !== to.fragment) return false;
    }
  }
  return true;
}
