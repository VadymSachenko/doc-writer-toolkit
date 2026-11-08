import path from 'node:path';

// An id-only change of a UA page keeps the stages recorded on it (D-073). The definition, word for word as the README
// gives it:
//
//   A UA change is id-only when its only differences from the approved version are (1) `{/* #id */}` comments added
//   to headings that had none, and (2) link fragments rewritten from such a heading's old fragment to its new id.
//   Anything else makes it a real change: a changed or removed id, a changed heading text, or any other edit.
//
// `isIdOnlyChange` is that predicate. A heading's old fragment is the slug Docusaurus made of its text (github-slugger:
// lower case, punctuation dropped, spaces to hyphens, `-1`, `-2` … for repeats). A link on another page counts when its
// target resolves to a page of the same change whose heading got the id; a target that doesn't resolve is a real change.

const FENCE = /^[ \t]*(```|~~~)/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const ID_COMMENT = /[ \t]*\{\/\*[ \t]*#([^*{}\s]+)[ \t]*\*\/\}[ \t]*$/;
// A link target: `](target)` (an optional title after a space), `href="target"` or `to="target"`, `[label]: target`.
const LINK = /(\]\()([^)\s]*)|(\b(?:href|to)[ \t]*=[ \t]*["'])([^"']*)|(^[ \t]*\[[^\]]+\]:[ \t]*)(\S+)/g;

const lines = (text) => String(text).replace(/\r\n/g, '\n').split('\n');
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function heading(line) {
  const m = HEADING.exec(line);
  if (!m) return null;
  let text = m[2];
  let id = null;
  const c = ID_COMMENT.exec(text);
  if (c) {
    id = c[1];
    text = text.slice(0, c.index).replace(/[ \t]+$/, '');
  }
  return { level: m[1].length, text, id };
}

// The headings of a page, outside code fences, with each one's line and its slug as Docusaurus makes it.
function headingsOf(text) {
  const out = [];
  const seen = new Map();
  let fence = null;
  lines(text).forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = heading(line);
    if (!h) return;
    let slug = null;
    if (!h.id) {
      const base = slugOf(h.text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      slug = n ? `${base}-${n}` : base;
    }
    out.push({ ...h, line: i, slug });
  });
  return out;
}

// github-slugger's slug of a heading's rendered text.
export function slugOf(text) {
  const plain = String(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '');
  return plain.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

// The ids a change added to headings that had none: old fragment (the slug) -> new id. Only when the page keeps the
// same headings in the same order, with the same level and text.
function addedIds(before, after) {
  const a = headingsOf(before);
  const b = headingsOf(after);
  const map = new Map();
  if (a.length !== b.length) return map;
  for (let i = 0; i < a.length; i++) {
    if (a[i].level === b[i].level && a[i].text === b[i].text && !a[i].id && b[i].id) map.set(a[i].slug, b[i].id);
  }
  return map;
}

// A line with every link fragment replaced by a placeholder, and the targets in order.
function linkParts(line) {
  const targets = [];
  const skeleton = line.replace(LINK, (m, p1, t1, p2, t2, p3, t3) => {
    const pre = p1 ?? p2 ?? p3;
    const t = t1 ?? t2 ?? t3;
    const i = t.indexOf('#');
    if (i < 0) return m;
    targets.push({ path: t.slice(0, i), frag: t.slice(i + 1) });
    return `${pre}${t.slice(0, i)}#\u0000`;
  });
  return { skeleton, targets };
}

const bare = (p) => p.replace(/\.mdx?$/, '').replace(/\/index$/, '');

// The page of the change a link's path leads to: a file path relative to the linking page, or a route matched against
// the end of a page's path. Null when it leads to no page of the change, or to more than one.
function resolve(fromPath, linkPath, pages) {
  const target = decode(linkPath).replace(/[?].*$/, '');
  const candidates = pages.map((p) => p.path);
  if (!target.startsWith('/')) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), target));
    const exact = candidates.filter((c) => c === joined || bare(c) === bare(joined));
    if (exact.length === 1) return exact[0];
  }
  const route = bare(target.replace(/^\.?\//, '').replace(/\/$/, ''));
  if (!route) return null;
  const hits = candidates.filter((c) => bare(c) === route || bare(c).endsWith(`/${route}`));
  return hits.length === 1 ? hits[0] : null;
}

// True when `page` ({ path, before, after }) changed by ids only, as defined above. `changeSet`: every page of the same
// change, `page` among them, so that a link rewritten to another page's new id can be checked. A page new or removed in
// the change is a real change.
export function isIdOnlyChange(page, changeSet = [page]) {
  const { before, after } = page;
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  if (before === after) return true;
  const a = lines(before);
  const b = lines(after);
  if (a.length !== b.length) return false;
  const own = addedIds(before, after);
  const pages = changeSet.filter((p) => typeof p.before === 'string' && typeof p.after === 'string');
  const idsOf = new Map();
  const added = (p) => {
    if (!idsOf.has(p)) {
      const other = pages.find((x) => x.path === p);
      idsOf.set(p, other ? addedIds(other.before, other.after) : new Map());
    }
    return idsOf.get(p);
  };
  const headA = new Map(headingsOf(before).map((h) => [h.line, h]));
  const headB = new Map(headingsOf(after).map((h) => [h.line, h]));
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ha = headA.get(i);
    const hb = headB.get(i);
    if (ha || hb) {
      // (1) A heading that had no id got one, its level and text unchanged. A changed or removed id, a changed text,
      // or a heading added or removed is a real change.
      if (!ha || !hb || ha.level !== hb.level || ha.text !== hb.text || ha.id || !hb.id) return false;
      if (own.get(ha.slug) !== hb.id) return false;
      continue;
    }
    // (2) Any other line differs only in link fragments, each rewritten from a heading's old fragment to its new id.
    const la = linkParts(a[i]);
    const lb = linkParts(b[i]);
    if (la.skeleton !== lb.skeleton) return false;
    for (let k = 0; k < la.targets.length; k++) {
      const from = la.targets[k];
      const to = lb.targets[k];
      if (from.frag === to.frag) continue;
      const ids = from.path === '' ? own : (() => {
        const p = resolve(page.path ?? '', from.path, pages);
        return p ? added(p) : null;
      })();
      if (!ids || ids.get(decode(from.frag)) !== to.frag) return false;
    }
  }
  return true;
}
