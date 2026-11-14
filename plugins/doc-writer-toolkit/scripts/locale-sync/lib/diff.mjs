import { anchorPath, boldSpans, isLeaf, isVerbatimNode, nodeText, PROSE_FM_KEYS, sectionPath, sections, splitCode, wordCount } from './parse.mjs';
import { createSlugger, EXPLICIT_ID, slugify, slugSource } from '../../doc-align/lib/headings.mjs';

// ---------------------------------------------------------------- A -> B (what changed in the UA source)

const keyOf = (n) => (n.type === 'section' ? `§${n.level}\0${n.sig}` : `${n.type}\0${n.sig}`);

// Link targets in a block: `](target)`, `href="target"` or `to="target"`, `[label]: target`. The skeleton is the text
// with every fragment replaced by a placeholder; `targets` are the links that have a fragment, in order, the fragment
// decoded.
const LINK_TARGET = /(\]\(\s*<?)([^)\s>]*)|(\b(?:href|to)[ \t]*=[ \t]*["'])([^"']*)|(^[ \t]*\[[^\]]+\]:[ \t]*)(\S+)/gm;
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
function eachFragment(text, fn) {
  return text.replace(LINK_TARGET, (m, p1, t1, p2, t2, p3, t3) => {
    const t = t1 ?? t2 ?? t3;
    const i = t.indexOf('#');
    if (i < 0) return m;
    const out = fn({ path: t.slice(0, i), fragment: decode(t.slice(i + 1)) });
    return out === null ? m : `${p1 ?? p2 ?? p3}${t.slice(0, i)}#${out}`;
  });
}
export function linkFragments(text) {
  const targets = [];
  const skeleton = eachFragment(text, (link) => {
    targets.push(link);
    return '\u0000';
  });
  return { skeleton, targets };
}
// Rewrites the fragments that `rewrite` maps (`<path>#<old fragment>` -> new fragment); every other byte stays.
function rewriteFragments(text, rewrite) {
  let replaced = 0;
  const out = eachFragment(text, (link) => {
    const to = rewrite.get(`${link.path}#${link.fragment}`);
    if (to === undefined) return null;
    replaced++;
    return to;
  });
  return { text: out, replaced };
}
const linksOf = (n) => (n.links ??= linkFragments(n.sig));

// The splice cases of heading-anchors.md ("Id-only changes"), as pairs of an old and a new unit: a heading that gained
// an anchor comment or whose comment changed, its level and text the same; a block whose only difference is the
// fragments of its links. Exact matches weigh 2 and these 1, so a unit that didn't change pairs with itself first.
function weight(x, y, kx, ky) {
  if (kx === ky) return 2;
  if (x.type !== y.type) return 0;
  if (x.type === 'section') return x.level === y.level && x.title === y.title && y.anchor && x.anchor !== y.anchor ? 1 : 0;
  return linksOf(x).targets.length && linksOf(x).skeleton === linksOf(y).skeleton ? 1 : 0;
}

// A weighted longest common subsequence of two child lists. With exact matches only, it pairs what a plain LCS pairs.
function lcsPairs(ca, cb) {
  const n = ca.length;
  const m = cb.length;
  const ka = ca.map(keyOf);
  const kb = cb.map(keyOf);
  const w = ca.map((x, i) => Uint8Array.from(cb, (y, j) => weight(x, y, ka[i], kb[j])));
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], w[i][j] ? w[i][j] + dp[i + 1][j + 1] : 0);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (w[i][j] && dp[i][j] === w[i][j] + dp[i + 1][j + 1]) pairs.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const sameKind = (x, y) => x.type === y.type && (x.type !== 'section' || x.level === y.level);

function makeGroup(a, b, aIdx, aNodes, bNodes, via) {
  return {
    parentA: a,
    parentB: b,
    aNodes,
    bNodes,
    afterA: aIdx > 0 ? a.children[aIdx - 1] : null,
    beforeA: a.children[aIdx + aNodes.length] ?? null,
    viaA: via?.a ?? null,
    viaB: via?.b ?? null,
    escalated: false,
  };
}

// Unmatched runs between two matched neighbours. Equal-length runs of the same kinds are paired one to one so that
// five changed list items stay five replacements; anything else becomes one group.
function resolveGap(a, b, aIdx, aRun, bRun, out, via) {
  if (aRun.length && aRun.length === bRun.length && aRun.every((x, i) => sameKind(x, bRun[i]))) {
    aRun.forEach((x, i) => {
      const y = bRun[i];
      if (x.type === 'table' && x.headerSig === y.headerSig) diffContainer(x, y, out, { a: x, b: y });
      else out.push(makeGroup(a, b, aIdx + i, [x], [y], via));
    });
  } else {
    out.push(makeGroup(a, b, aIdx, aRun, bRun, via));
  }
}

function diffRange(a, b, a0, a1, b0, b1, out, via) {
  const ca = a.children.slice(a0, a1);
  const cb = b.children.slice(b0, b1);
  const pairs = lcsPairs(ca, cb);
  let ia = 0;
  let ib = 0;
  for (const [pi, pj] of [...pairs, [ca.length, cb.length]]) {
    if (pi > ia || pj > ib) resolveGap(a, b, a0 + ia, ca.slice(ia, pi), cb.slice(ib, pj), out, via);
    if (pi < ca.length) {
      const [x, y] = [ca[pi], cb[pj]];
      if (x.type === 'section') {
        // Same heading text: only its anchor comment may differ (a splice). Then look inside.
        if (x.sig !== y.sig) out.push({ ...makeGroup(a, b, a0 + pi, [x], [y], via), splice: 'anchor' });
        diffContainer(x, y, out, null);
      } else if (x.sig !== y.sig) {
        // Only link fragments differ. A table with the same header is looked into row by row.
        if (x.type === 'table' && x.headerSig === y.headerSig) diffContainer(x, y, out, { a: x, b: y });
        else out.push({ ...makeGroup(a, b, a0 + pi, [x], [y], via), splice: 'fragments' });
      }
    }
    ia = pi + 1;
    ib = pj + 1;
  }
}

function diffContainer(a, b, out, via) {
  if (a.type === 'table') {
    diffRange(a, b, 0, a.children.length, 0, b.children.length, out, via);
    return;
  }
  const na = a.children.filter(isLeaf).length;
  const nb = b.children.filter(isLeaf).length;
  const mark = out.length;
  diffRange(a, b, 0, na, 0, nb, out, null);

  // changed-blocks.md: when more than half of a section's blocks changed, work on the whole section body.
  const own = out.slice(mark);
  const touchedA = new Set();
  const touchedB = new Set();
  for (const g of own) {
    if (g.splice) continue; // rewritten link fragments change no text
    for (const n of g.aNodes) touchedA.add(g.viaA ?? n);
    for (const n of g.bNodes) touchedB.add(g.viaB ?? n);
  }
  const total = Math.max(na, nb);
  if (total >= 2 && 2 * Math.max(touchedA.size, touchedB.size) > total) {
    const g = makeGroup(a, b, 0, a.children.slice(0, na), b.children.slice(0, nb), null);
    g.escalated = true;
    out.splice(mark, own.length, g);
  }
  diffRange(a, b, na, a.children.length, nb, b.children.length, out, null);
}

// Groups of changed units between the old UA page (A) and the new one (B): { aNodes, bNodes, parentA, parentB, afterA, beforeA }.
export function diffBodies(pageA, pageB) {
  const groups = [];
  diffContainer(pageA.root, pageB.root, groups, null);
  return groups;
}

// Frontmatter keys whose entry changed between A and B. `last_update` is never copied from UA.
export function diffFrontmatter(fmA, fmB) {
  const out = [];
  const ea = new Map((fmA?.entries ?? []).map((e) => [e.key, e]));
  const eb = new Map((fmB?.entries ?? []).map((e) => [e.key, e]));
  for (const [key, b] of eb) {
    if (key === 'last_update') continue;
    const a = ea.get(key);
    if (!a) out.push({ op: 'add', key, a: null, b });
    else if (a.raw !== b.raw) out.push({ op: 'replace', key, a, b });
  }
  for (const [key, a] of ea) if (key !== 'last_update' && !eb.has(key)) out.push({ op: 'remove', key, a, b: null });
  return out;
}

// ---------------------------------------------------------------- A -> target (where the old UA blocks live in the translation)

const describe = (n) => (n.type === 'section' ? `section(h${n.level})` : n.type);

// Aligns the old UA tree with the translated page's tree, position by position. A container whose children do not
// line up one to one is "bad": nothing below it is mapped, because mapping would be a guess.
export function alignTrees(a, t) {
  const map = new Map();
  const bad = new Map();
  const walk = (x, y) => {
    map.set(x, y);
    if (x.type !== 'section' && x.type !== 'table') return;
    if (x.type === 'section' && x.level && x.anchor && y.anchor && x.anchor !== y.anchor) {
      bad.set(x, `the heading anchor is '${y.anchor}' in the translation but '${x.anchor}' in the UA page`);
      return;
    }
    const xc = x.children;
    const yc = y.children;
    if (xc.length !== yc.length || !xc.every((c, i) => sameKind(c, yc[i]))) {
      bad.set(x, `UA has [${xc.map(describe).join(', ')}] but the translation has [${yc.map(describe).join(', ')}]`);
      return;
    }
    xc.forEach((c, i) => walk(c, yc[i]));
  };
  if (a.type !== t.type) return { map, bad };
  walk(a, t);
  return { map, bad };
}

// Section-by-section structure differences between the UA page and a translation (empty when they mirror 1:1).
export function structureMismatches(uaRoot, tRoot) {
  const { bad } = alignTrees(uaRoot, tRoot);
  return [...bad].map(([node, reason]) => ({ section: node.level ? sectionPath(node) : [], reason }));
}

// ---------------------------------------------------------------- composing the report for the model

const span = (page, s, e) => ({ lines: [s + 1, e + 1], text: nodeText(page, s, e) });

function kindOf(g) {
  if (g.escalated) return 'section-body';
  const nodes = g.bNodes.length ? g.bNodes : g.aNodes;
  const types = new Set(nodes.map((n) => n.type));
  if (types.size !== 1) return 'blocks';
  const t = nodes[0].type;
  return t === 'row' ? 'table-row' : t;
}

// ---------------------------------------------------------------- splices (heading-anchors.md, "Id-only changes")

const ANCHOR_COMMENT = /[ \t]*\{\/\*\s*#[^\s*]+\s*\*\/\}[ \t]*$/;
// A heading line with its anchor comment set to `id`: the comment replaced, or added at the end.
export const withAnchor = (line, id) => `${line.replace(ANCHOR_COMMENT, '').replace(/[ \t]+$/, '')} {/* #${id} */}`;

const headingRaw = (page, sec) => page.lines[sec.start].replace(/^#{1,6}[ \t]+/, '');

// The fragment a link used for each heading of a page, as Docusaurus gives it: the anchor comment, an explicit `\{#id}` (or `{#id}`),
// else the slug of the heading text (a page's headings without an id are slugged in order, repeats numbered).
function headingFragments(page) {
  const slug = createSlugger();
  const out = new Map();
  for (const sec of sections(page.root)) {
    const raw = headingRaw(page, sec);
    const explicit = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').match(EXPLICIT_ID);
    out.set(sec, sec.anchor ?? explicit?.[1] ?? slug(slugSource(raw)));
  }
  return out;
}

// What another page's heading ids say about a fragment rewrite: true when the linked page has a heading whose anchor
// comment is the new fragment and whose text slugs to the old one (an id added to a heading that had none; a repeat
// `-1`, `-2`, … counts for a text the page has that often). Anything else can't be told from the page as it is now.
export function addedOn(page) {
  const counts = new Map();
  const bases = [];
  for (const sec of sections(page.root)) {
    const base = slugify(slugSource(headingRaw(page, sec)));
    counts.set(base, (counts.get(base) ?? 0) + 1);
    bases.push([sec.anchor, base]);
  }
  return (from, to) =>
    bases.some(([anchor, base]) => {
      if (anchor !== to) return false;
      if (from === base) return true;
      const m = from.startsWith(`${base}-`) ? from.slice(base.length + 1) : null;
      return m !== null && /^[1-9]\d*$/.test(m) && Number(m) < counts.get(base);
    });
}

// The rewrites of a fragment-only pair: `<path>#<old fragment>` -> new fragment, or null when one old fragment became two
// different ones, or some of its links kept it.
function fragmentRewrites(x, y) {
  const a = linksOf(x).targets;
  const b = linksOf(y).targets;
  const map = new Map();
  for (let k = 0; k < a.length; k++) {
    if (a[k].fragment === b[k].fragment) continue;
    const key = `${a[k].path}#${a[k].fragment}`;
    if (map.has(key) && map.get(key) !== b[k].fragment) return null;
    map.set(key, b[k].fragment);
  }
  for (let k = 0; k < a.length; k++) if (map.has(`${a[k].path}#${a[k].fragment}`) && a[k].fragment === b[k].fragment) return null;
  return map;
}

// The splice groups of a diff, turned into the target text to write. `verifyLink(path, from, to)` says whether a
// fragment rewrite in a link to another page follows that page's ids: true, false, or 'self' when the path is this page.
function composeSplices({ pageA, pageB, pageT, groups, map, bad, verifyLink }) {
  const renames = new Map(); // old fragment of a heading on this page -> its new anchor
  const fragA = headingFragments(pageA);
  for (const g of groups) if (g.splice === 'anchor') renames.set(fragA.get(g.aNodes[0]), g.bNodes[0].anchor);
  const spliced = [];
  const unmapped = [];
  const fallback = new Set(); // fragment groups the script can't vouch for: translated as usual
  const blocked = [];
  let n = 0;
  for (const g of groups) {
    if (!g.splice) continue;
    const [x, y] = [g.aNodes[0], g.bNodes[0]];
    const entry = { id: `s${++n}`, op: 'replace', headingPath: sectionPath(y), anchorPath: anchorPath(y) };
    const parentBad = bad.get(g.parentA) ?? (map.has(g.parentA) ? null : 'an enclosing section of the translation does not line up with the UA page');
    if (g.splice === 'anchor') {
      Object.assign(entry, { kind: 'anchor', anchor: { from: x.anchor, to: y.anchor }, ua: span(pageB, y.start, y.start) });
      const t = map.get(x);
      if (parentBad || !t) {
        unmapped.push({ ...entry, reason: parentBad ?? 'the heading has no counterpart in the translation' });
        continue;
      }
      if (t.anchor !== x.anchor) {
        const reason = `the heading's anchor comment is ${t.anchor ? `'${t.anchor}'` : 'missing'} in the translation but ${x.anchor ? `'${x.anchor}'` : 'missing'} in the old UA page`;
        blocked.push(`${sectionPath(y).join(' > ')}: ${reason}`);
        unmapped.push({ ...entry, target: span(pageT, t.start, t.start), reason });
        continue;
      }
      spliced.push({ ...entry, target: span(pageT, t.start, t.start), write: withAnchor(pageT.lines[t.start], y.anchor) });
      continue;
    }
    // A block whose only difference is its link fragments, each rewritten from a heading's old fragment to its new id.
    const rewrites = fragmentRewrites(x, y);
    const ok =
      rewrites &&
      [...rewrites].every(([key, to]) => {
        const hash = key.indexOf('#');
        const [path, from] = [key.slice(0, hash), key.slice(hash + 1)];
        const v = path === '' ? 'self' : verifyLink?.(path, from, to) ?? false;
        return v === 'self' ? renames.get(from) === to : v === true;
      });
    const t = map.get(x);
    if (!ok || parentBad || !t) {
      fallback.add(g);
      continue;
    }
    const tText = nodeText(pageT, t.start, t.end);
    const want = linksOf(x).targets.filter((l) => rewrites.has(`${l.path}#${l.fragment}`)).length;
    const r = rewriteFragments(tText, rewrites);
    if (r.replaced !== want) {
      fallback.add(g); // the translation's links differ from the old UA block's: translate the block as usual
      continue;
    }
    spliced.push({
      ...entry,
      kind: 'link',
      block: x.type === 'row' ? 'table-row' : x.type,
      fragments: [...rewrites].map(([key, to]) => ({ from: key, to: `${key.slice(0, key.indexOf('#'))}#${to}` })),
      ua: span(pageB, y.start, y.end),
      target: span(pageT, t.start, t.end),
      write: r.text,
    });
  }
  // A heading whose anchor in the translation differs from the old UA page: the page is not what the last run recorded,
  // so nothing is spliced on it.
  if (blocked.length) {
    for (const sp of spliced.splice(0)) unmapped.push({ ...sp, write: undefined, reason: `nothing is spliced on this page: ${blocked.join('; ')}` });
  }
  return { spliced, unmapped, fallback };
}

// Turns groups into the change list the translator works from. UA text is the new text (page B); target text is the
// translation as it is on disk now. Everything not listed stays untouched. `spliced` holds what the script writes
// itself (heading anchors and link fragments), never a translator.
export function composeChanges({ pageA, pageB, pageT, groups, fmChanges, withOld = false, verifyLink = null }) {
  const { map, bad } = alignTrees(pageA.root, pageT.root);
  const splices = composeSplices({ pageA, pageB, pageT, groups, map, bad, verifyLink });
  groups = groups.filter((g) => !g.splice || splices.fallback.has(g));
  const changes = [];
  const unmapped = [...splices.unmapped];
  const lastAddAfter = new Map();
  let n = 0;

  const fmT = pageT.fm;
  for (const c of fmChanges) {
    const id = `c${++n}`;
    const tEntry = fmT?.entries.find((e) => e.key === c.key) ?? null;
    const base = {
      id,
      op: c.op,
      kind: 'frontmatter',
      key: c.key,
      headingPath: [],
      verbatim: !PROSE_FM_KEYS.has(c.key),
      ...(c.b ? { ua: { lines: [c.b.start + 1, c.b.end + 1], text: c.b.raw } } : {}),
      ...(withOld && c.a ? { uaOld: { lines: [c.a.start + 1, c.a.end + 1], text: c.a.raw } } : {}),
    };
    if (!fmT) {
      unmapped.push({ ...base, reason: 'the translation has no frontmatter' });
    } else if (c.op === 'add' && !tEntry) {
      const last = fmT.entries.at(-1);
      changes.push({ ...base, insertAfter: last ? span(pageT, last.start, last.end) : span(pageT, 0, 0) });
    } else if (!tEntry) {
      unmapped.push({ ...base, reason: `the translation has no '${c.key}' key` });
    } else {
      changes.push({ ...base, target: span(pageT, tEntry.start, tEntry.end) });
    }
  }

  for (const g of groups) {
    const id = `c${++n}`;
    const op = !g.aNodes.length ? 'add' : !g.bNodes.length ? 'remove' : 'replace';
    const pathNode = g.bNodes[0] ?? g.aNodes[0];
    const uaText = g.bNodes.length ? nodeText(pageB, g.bNodes[0].start, g.bNodes.at(-1).end) : '';
    const entry = {
      id,
      op,
      kind: kindOf(g),
      headingPath: sectionPath(pathNode),
      anchorPath: anchorPath(pathNode),
      ...(g.bNodes.length ? { ua: span(pageB, g.bNodes[0].start, g.bNodes.at(-1).end), bold: boldSpans(splitCode(uaText).prose), words: wordCount(splitCode(uaText).prose.join('\n')) } : {}),
      ...(withOld && g.aNodes.length ? { uaOld: span(pageA, g.aNodes[0].start, g.aNodes.at(-1).end) } : {}),
      verbatim: g.bNodes.length > 0 && g.bNodes.every((x) => isVerbatimNode(pageB, x)),
    };
    if (g.escalated) entry.note = 'more than half of this section changed: the whole body (every block under the heading, subsections excluded) is re-translated';

    const parentBad = bad.get(g.parentA) ?? (map.has(g.parentA) ? null : 'an enclosing section of the translation does not line up with the UA page');
    if (parentBad) {
      unmapped.push({ ...entry, reason: parentBad });
      continue;
    }

    if (g.aNodes.length) {
      const tNodes = g.aNodes.map((x) => map.get(x));
      if (tNodes.some((x) => !x)) {
        unmapped.push({ ...entry, reason: 'the block has no counterpart in the translation' });
        continue;
      }
      entry.target = span(pageT, tNodes[0].start, tNodes.at(-1).end);
    } else {
      const tParent = map.get(g.parentA);
      const anchor = g.afterA ? map.get(g.afterA) : null;
      if (g.afterA && !anchor) {
        unmapped.push({ ...entry, reason: 'the block before the insertion point has no counterpart in the translation' });
        continue;
      }
      if (anchor) entry.insertAfter = span(pageT, anchor.start, anchor.end);
      else if (tParent.type === 'table') entry.insertAfter = span(pageT, tParent.start, tParent.headerEnd);
      else if (tParent.level) entry.insertAfter = span(pageT, tParent.start, tParent.headEnd);
      else if (pageT.fm) entry.insertAfter = span(pageT, pageT.fm.end, pageT.fm.end);
      else entry.insertAtStart = true;
      const next = g.beforeA ? map.get(g.beforeA) : null;
      if (next) entry.insertBefore = span(pageT, next.start, Math.min(next.end, next.start));
      // Several additions at one anchor go in the listed order, each after the previous one.
      const anchorKey = g.afterA ?? g.parentA;
      if (lastAddAfter.has(anchorKey)) entry.insertAfterChange = lastAddAfter.get(anchorKey);
      lastAddAfter.set(anchorKey, id);
    }
    changes.push(entry);
  }
  return { changes, unmapped, spliced: splices.spliced };
}

// The paths of links to other pages whose fragments a splice group rewrites: for the caller to resolve before
// `composeChanges` (its `verifyLink`).
export function spliceLinkPaths(groups) {
  const paths = new Set();
  for (const g of groups) {
    if (g.splice !== 'fragments') continue;
    for (const key of fragmentRewrites(g.aNodes[0], g.bNodes[0])?.keys() ?? []) {
      const path = key.slice(0, key.indexOf('#'));
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

// Bold spans in the new text of the changed blocks that the old page never used: candidates for terms to keep consistent.
export function introducedBold(changes, pageA) {
  const old = new Set(boldSpans(splitCode(pageA.lines.join('\n')).prose));
  const out = new Set();
  for (const c of changes) for (const s of c.bold ?? []) if (!old.has(s)) out.add(s);
  return [...out];
}
