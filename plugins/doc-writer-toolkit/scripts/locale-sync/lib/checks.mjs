import fs from 'node:fs/promises';
import path from 'node:path';
import { loadStore, mergedLabels } from '../../ui-labels/lib/store.mjs';
import { structureMismatches } from './diff.mjs';
import { CYRILLIC, uaOnlyLetters } from './letters.mjs';
import { checkCategoryUnit } from './categories.mjs';
import { acceptedLabels } from './labels.mjs';
import { abs, localePagePath, readIfExists, readState } from './pages.mjs';
import { cachedBlob } from './plan.mjs';
import { assetRefs, boldSpans, canonicalTags, cleanRef, linkTargets, markerCount, otherCommentCount, parsePage, PROSE_FM_KEYS, sections, splitCode } from './parse.mjs';


function analyze(text) {
  const sc = splitCode(text);
  const page = parsePage(text);
  const prose = sc.prose.join('\n');
  return {
    text,
    sc,
    page,
    prose,
    headings: [...sections(page.root)].map((n) => ({ level: n.level, anchor: n.anchor, title: n.title })),
    counts: sectionCounts(page, sc.prose),
    tags: canonicalTags(prose),
    inline: sc.inline,
    links: linkTargets(sc.prose),
    images: assetRefs(sc.prose),
    markers: markerCount(prose),
    otherComments: otherCommentCount(prose),
  };
}

// Per section (own lines only): list items, ordered items, table rows and admonition types.
function sectionCounts(page, proseLines) {
  const own = [page.root, ...sections(page.root)].map((sec) => {
    const firstChild = sec.children.find((c) => c.type === 'section');
    return { sec, from: sec.level ? sec.start : sec.start, to: firstChild ? firstChild.start - 1 : sec.end };
  });
  return own.map(({ sec, from, to }) => {
    const c = {};
    for (let i = from; i <= to && i < proseLines.length; i++) {
      const l = proseLines[i];
      let m;
      if (/^\s*[-*+]\s+\S/.test(l)) c.bullets = (c.bullets ?? 0) + 1;
      else if (/^\s*\d+[.)]\s+\S/.test(l)) c.steps = (c.steps ?? 0) + 1;
      else if (/^\s*\|/.test(l)) c.tableRows = (c.tableRows ?? 0) + 1;
      else if ((m = l.match(/^\s*:{3,}\s*([A-Za-z][\w-]*)/))) c[`:::${m[1]}`] = (c[`:::${m[1]}`] ?? 0) + 1;
    }
    return { title: sec.title, anchor: sec.anchor, counts: c };
  });
}

function multisetDiff(a, b) {
  const count = (list) => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const missing = [];
  const extra = [];
  for (const [k, n] of ca) for (let i = 0; i < n - (cb.get(k) ?? 0); i++) missing.push(k);
  for (const [k, n] of cb) for (let i = 0; i < n - (ca.get(k) ?? 0); i++) extra.push(k);
  return { missing, extra };
}

const head = (list, n = 8) => (list.length > n ? [...list.slice(0, n), `… and ${list.length - n} more`] : list);

// Mermaid diagrams carry translatable labels. Flowcharts compare with their labels blanked; other diagram types only by
// their first line and length, because their label syntax differs.
function canonMermaid(f) {
  const first = f.lines.find((l) => l.trim())?.trim() ?? '';
  if (!/^(flowchart|graph)\b/.test(first)) return `${f.lines.length} lines, ${first}`;
  return f.lines
    .map((l) =>
      l
        .replace(/"[^"\n]*"/g, '""')
        .replace(/\|[^|\n]*\|/g, '||')
        .replace(/(--|==|-\.)\s+[^\n]*?\s+(-->|==>|\.->)/g, '$1 $2')
        .replace(/\[[^\]\n]*\]/g, '[]')
        .replace(/\([^()\n]*\)/g, '()')
        .replace(/\{[^}\n]*\}/g, '{}')
        .trimEnd(),
    )
    .join('\n');
}

const fenceKey = (f) => (/^mermaid\b/i.test(f.info) ? `mermaid\0${canonMermaid(f)}` : `${f.info}\0${f.lines.join('\n')}`);

const frontmatterKeys = (fm) => new Map((fm?.entries ?? []).filter((e) => e.key !== 'last_update').map((e) => [e.key, e]));

// Requirement 8: every deterministic check on one translated page. Pure: reads nothing but its arguments and the disk
// (for asset links).
export async function checkPage({ locale, uaText, targetText, targetFile, state, labels, meta, unverified = [], root }) {
  const failures = [];
  const warnings = [];
  const fail = (check, message, detail = {}) => failures.push({ check, message, ...detail });

  if (targetText === null) {
    return { ok: false, failures: [{ check: 'target-missing', message: `The translation does not exist at ${targetFile}.` }], warnings, checks: ['target-missing'] };
  }
  const ua = analyze(uaText);
  const tr = analyze(targetText);

  // Frontmatter: same keys, same non-prose values, title and description translated.
  const fa = ua.page.fm;
  const ft = tr.page.fm;
  if (!fa !== !ft) fail('frontmatter', fa ? 'The translation has no frontmatter.' : 'The translation has frontmatter the UA page does not have.');
  else if (fa) {
    const ka = frontmatterKeys(fa);
    const kt = frontmatterKeys(ft);
    const d = multisetDiff([...ka.keys()], [...kt.keys()]);
    if (d.missing.length || d.extra.length) fail('frontmatter', 'Frontmatter keys differ from the UA page.', { missing: d.missing, extra: d.extra });
    for (const [key, a] of ka) {
      const t = kt.get(key);
      if (!t) continue;
      if (!PROSE_FM_KEYS.has(key) && a.raw !== t.raw) fail('frontmatter', `The value of '${key}' must stay identical to the UA page.`, { ua: a.raw, target: t.raw });
    }
    for (const key of ['title', 'description']) {
      const a = ka.get(key);
      const t = kt.get(key);
      if (a && t && CYRILLIC.test(a.value) && a.value === t.value) fail('frontmatter', `'${key}' is not translated.`, { value: t.value });
      if (a && t && !t.value) fail('frontmatter', `'${key}' is empty.`);
    }
  }

  // Headings: count, levels and anchor comments.
  const ha = ua.headings;
  const ht = tr.headings;
  let headingsOk = ha.length === ht.length;
  if (headingsOk) {
    const bad = ha.map((h, i) => ({ i, h, t: ht[i] })).filter(({ h, t }) => h.level !== t.level || h.anchor !== t.anchor);
    if (bad.length) {
      headingsOk = false;
      fail('headings', 'Heading levels or anchor comments differ from the UA page.', {
        differences: bad.slice(0, 6).map(({ i, h, t }) => ({ index: i + 1, ua: `${'#'.repeat(h.level)} ${h.title} {/* #${h.anchor} */}`, target: `${'#'.repeat(t.level)} ${t.title} {/* #${t.anchor} */}` })),
      });
    }
  } else {
    fail('headings', `The UA page has ${ha.length} headings but the translation has ${ht.length}.`);
  }

  // Block structure: every section holds the same sequence of blocks as UA, so the next incremental run can map blocks.
  if (headingsOk) {
    const bad = structureMismatches(ua.page.root, tr.page.root);
    if (bad.length) fail('structure', 'The translation does not mirror the UA block structure 1:1 (sentences may be reordered inside a block, but blocks may not be split, merged or moved).', { sections: bad.slice(0, 6) });
  }

  // List, step, table-row and admonition counts per section.
  if (headingsOk) {
    const bad = [];
    ua.counts.forEach((a, i) => {
      const t = tr.counts[i];
      const keys = new Set([...Object.keys(a.counts), ...Object.keys(t.counts)]);
      const diff = Object.fromEntries([...keys].filter((k) => (a.counts[k] ?? 0) !== (t.counts[k] ?? 0)).map((k) => [k, { ua: a.counts[k] ?? 0, target: t.counts[k] ?? 0 }]));
      if (Object.keys(diff).length) bad.push({ section: a.title ?? '(before the first heading)', anchor: a.anchor, diff });
    });
    if (bad.length) fail('counts', 'List, step, table-row or admonition counts differ from the UA page.', { sections: bad.slice(0, 6) });
  }

  // Code blocks (mermaid labels excepted), inline code, links, images and MDX tags.
  const fa2 = ua.sc.fences.map(fenceKey);
  const ft2 = tr.sc.fences.map(fenceKey);
  if (fa2.length !== ft2.length) fail('code', `The UA page has ${fa2.length} code blocks but the translation has ${ft2.length}.`);
  else {
    const bad = fa2.map((k, i) => (k === ft2[i] ? null : i + 1)).filter(Boolean);
    if (bad.length) fail('code', 'Code blocks must be byte-identical to the UA page (only the labels inside a mermaid flowchart may be translated).', { blocks: bad });
  }
  // Inline code that holds Cyrillic is UI text shown in code style, not code: it is translated like prose.
  const codeLike = multisetDiff(ua.inline.filter((c) => !CYRILLIC.test(c)), tr.inline);
  if (codeLike.missing.length) fail('inline-code', 'Inline code is missing or changed (code, identifiers and values must stay byte-identical).', { missing: head(codeLike.missing) });
  for (const [check, label, a, b] of [
    ['links', 'Link targets and URLs', ua.links, tr.links],
    ['images', 'Image paths', ua.images, tr.images],
    ['tags', 'MDX tags, attribute names and non-prose attribute values', ua.tags, tr.tags],
  ]) {
    const d = multisetDiff(a, b);
    if (d.missing.length || d.extra.length) fail(check, `${label} differ from the UA page.`, { missing: head(d.missing), extra: head(d.extra) });
  }

  // ToDo / NEEDS CONFIRMATION markers and other comments.
  if (ua.markers !== tr.markers) fail('markers', `The UA page has ${ua.markers} ToDo / NEEDS CONFIRMATION markers but the translation has ${tr.markers}.`);
  if (ua.otherComments !== tr.otherComments) fail('markers', `The UA page has ${ua.otherComments} other {/* … */} comments but the translation has ${tr.otherComments}.`);

  // UI labels: bound spans use the target-locale string from the label store, or are recorded as unverified.
  const bound = Object.entries(state?.spans ?? {}).filter(([, d]) => typeof d === 'string' && d.startsWith('label:'));
  if (bound.length) {
    const uaBold = new Set(boldSpans(ua.sc.prose));
    const trProse = tr.prose;
    const excused = new Set(unverified.map((u) => (typeof u === 'string' ? u : u.span)));
    const bad = [];
    for (const [span, decision] of bound) {
      if (!uaBold.has(span)) continue;
      const key = decision.slice(6);
      const expected = labels?.[locale]?.[key];
      if (expected === undefined) {
        if (!labels) bad.push({ span, key, problem: 'no label store: run ui-labels import' });
        else if (!excused.has(span)) bad.push({ span, key, problem: `the label store has no '${locale}' string for this key, so the span must be recorded as unverified` });
      } else if (!acceptedLabels(span, labels.uk?.[key], expected).some((form) => trProse.includes(`**${form}**`))) {
        bad.push({ span, key, expected: `**${expected}**`, problem: 'the UI label is not in bold, verbatim, in the translation' });
      }
    }
    if (bad.length) fail('labels', 'UI labels do not match the app strings for this locale.', { labels: bad.slice(0, 12) });
    if (meta && state?.locales?.[locale]?.labelSnapshot && state.locales[locale].labelSnapshot !== meta.commit) warnings.push('The label snapshot has changed since this page was translated.');
  }

  // Asset references resolve relative to the translation's own location (a dangling symlink breaks the build).
  const dir = path.dirname(abs({ root }, targetFile));
  const broken = [];
  for (const ref of tr.images) {
    const p = path.resolve(dir, cleanRef(ref));
    try {
      if (!(await fs.stat(p)).isFile()) broken.push({ ref, problem: 'not a file' });
    } catch {
      const l = await fs.lstat(p).catch(() => null);
      broken.push({ ref, problem: l?.isSymbolicLink() ? 'dangling symlink' : 'file not found' });
    }
  }
  if (broken.length) fail('assets', 'Some image or asset references do not resolve.', { broken: broken.slice(0, 12) });

  // Ukrainian-only letters left in the translation (prose, plus labels inside mermaid blocks).
  const hits = [];
  const scan = (text, line) => {
    const letters = uaOnlyLetters(text, locale);
    if (letters) hits.push({ line, letters, text: text.trim().slice(0, 100) });
  };
  tr.sc.prose.forEach((l, i) => scan(l, i + 1));
  for (const f of tr.sc.fences) if (/^mermaid\b/i.test(f.info)) f.lines.forEach((l, i) => scan(l, f.startLine + i + 2));
  if (hits.length) fail('ukrainian-letters', 'Letters that exist only in Ukrainian remain: part of the text was not translated.', { hits: hits.slice(0, 8), total: hits.length });

  // A translation written mostly in Latin letters must not keep any Cyrillic text either (the Ukrainian-only letters
  // above miss untranslated words that happen to avoid them), mermaid labels included.
  const count = (re) => (tr.prose.match(re) ?? []).length;
  const cyr = count(/\p{Script=Cyrillic}/gu);
  const lat = count(/\p{Script=Latin}/gu);
  if (!hits.length && lat > 0 && cyr / (cyr + lat) < 0.5) {
    const stray = [];
    const find = (text, line) => CYRILLIC.test(text) && stray.push({ line, text: text.trim().slice(0, 100) });
    tr.sc.prose.forEach((l, i) => find(l, i + 1));
    for (const f of tr.sc.fences) if (/^mermaid\b/i.test(f.info)) f.lines.forEach((l, i) => find(l, f.startLine + i + 2));
    // Only a warning: language pickers and similar lists legitimately show Cyrillic names on a Latin-script page.
    if (stray.length) warnings.push(`Cyrillic text remains in a translation written in Latin letters (${stray.length} lines, first at line ${stray[0].line}: ${stray[0].text}). Fine for language names; otherwise it is untranslated.`);
  }

  return { ok: failures.length === 0, failures, warnings, checks: [...new Set(failures.map((f) => f.check))] };
}

// Loads everything `checkPage` needs for one page in one locale. `candidate` is a file to check instead of the
// translation on disk (it is judged as if it were at the translation's path).
export async function checkTranslation(s, page, locale, { candidate = null, unverified = [], store } = {}) {
  if (page.kind === 'category') return checkCategoryUnit(s, page, locale, { candidate, unverified, store });
  const uaText = await cachedBlob(s.root, page.blob);
  const targetFile = localePagePath(s, locale, page);
  const targetText = await readIfExists(candidate ? path.resolve(candidate) : abs(s, targetFile));
  const state = await readState(s, page.id);
  const st = store === undefined ? await loadStore(s.labelsDir) : store;
  const labels = st ? mergedLabels(st).labels : null;
  const result = await checkPage({ locale, uaText, targetText, targetFile, state, labels, meta: st?.meta, unverified: [...unverified, ...(state.locales[locale]?.unverified ?? [])].filter(Boolean), root: s.root });
  return { ...result, page: page.id, locale, file: targetFile, uaText, targetText, state, store: st, labels };
}

