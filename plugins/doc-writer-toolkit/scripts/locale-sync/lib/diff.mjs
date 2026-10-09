import { anchorPath, boldSpans, isLeaf, nodeText, PROSE_FM_KEYS, sectionPath, splitCode, wordCount } from './parse.mjs';

// ---------------------------------------------------------------- A -> B (what changed in the UA source)

const keyOf = (n) => (n.type === 'section' ? `§${n.level}\0${n.sig}` : `${n.type}\0${n.sig}`);

function lcsPairs(ka, kb) {
  const n = ka.length;
  const m = kb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ka[i] === kb[j]) pairs.push([i++, j++]);
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
  const pairs = lcsPairs(ca.map(keyOf), cb.map(keyOf));
  let ia = 0;
  let ib = 0;
  for (const [pi, pj] of [...pairs, [ca.length, cb.length]]) {
    if (pi > ia || pj > ib) resolveGap(a, b, a0 + ia, ca.slice(ia, pi), cb.slice(ib, pj), out, via);
    if (pi < ca.length && ca[pi].type === 'section') diffContainer(ca[pi], cb[pj], out, null); // same heading: look inside
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

const isVerbatimNode = (page, n) => n.type === 'import' || (n.type === 'code' && !/mermaid/i.test(page.lines[n.start]));

// Turns groups into the change list the translator works from. UA text is the new text (page B); target text is the
// translation as it is on disk now. Everything not listed stays untouched.
export function composeChanges({ pageA, pageB, pageT, groups, fmChanges, withOld = false }) {
  const { map, bad } = alignTrees(pageA.root, pageT.root);
  const changes = [];
  const unmapped = [];
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
  return { changes, unmapped };
}

// Bold spans in the new text of the changed blocks that the old page never used: candidates for terms to keep consistent.
export function introducedBold(changes, pageA) {
  const old = new Set(boldSpans(splitCode(pageA.lines.join('\n')).prose));
  const out = new Set();
  for (const c of changes) for (const s of c.bold ?? []) if (!old.has(s)) out.add(s);
  return [...out];
}
