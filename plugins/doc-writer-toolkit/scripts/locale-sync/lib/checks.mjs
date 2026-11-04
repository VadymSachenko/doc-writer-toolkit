import fs from 'node:fs/promises';
import path from 'node:path';
import { loadStore, mergedLabels } from '../../ui-labels/lib/store.mjs';
import { structureMismatches } from './diff.mjs';
import { CYRILLIC, uaOnlyLetters } from './letters.mjs';
import { checkCategoryUnit } from './categories.mjs';
import { acceptedLabels } from './labels.mjs';
import { abs, localePagePath, readIfExists, readState } from './pages.mjs';
import { cachedBlob } from './plan.mjs';
import { decidedOccurrences } from './spans.mjs';
import { sectionMap } from './scope.mjs';
import { offTitleLinks, titleLinks } from './links.mjs';
import { nodeAt } from './redo.mjs';
import { readTerms } from './terms.mjs';
import { alignTrees } from './diff.mjs';
import { assetRefs, canonicalTags, cleanRef, linkTargets, markerCount, otherCommentCount, parsePage, PROSE_FM_KEYS, sections, splitCode } from './parse.mjs';
import { fenceLang, fenceParts } from '../../doc-align/lib/fences.mjs';


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

const normString = (t) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk');

const head = (list, n = 8) => (list.length > n ? [...list.slice(0, n), `… and ${list.length - n} more`] : list);

// A code block compares by its info string and its code part: diagram labels, comments and tree descriptions are
// translated (context/doc-rules/project-rules/code-blocks.md, one implementation with doc-align). A diagram's info
// string is not compared.
const fenceKey = (f) => `${fenceLang(f.info) === 'mermaid' ? 'mermaid' : f.info}\0${fenceParts(f.info, f.lines).code.join('\n')}`;

// Why a one-line frontmatter value would not parse as the string it shows, or null. The build stops on such a value,
// and a translation adds them: an unquoted `: ` in a translated description is the usual one.
export function yamlScalarProblem(value) {
  if (!value) return null;
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? null : 'its single quotes are not closed';
  if (value.startsWith('"')) return /^"(?:[^"\\]|\\.)*"$/.test(value) ? null : 'its double quotes are not closed';
  if (/^[[\]{}&*!|>%@`]/.test(value) || /^[-?:](\s|$)/.test(value)) return `it starts with '${value[0]}', which YAML reads as syntax`;
  if (/: |:$/.test(value)) return "it holds ': ' without quotes";
  if (/\s#/.test(value)) return "it holds ' #' without quotes, which starts a comment";
  return null;
}

// A page link must be site-root-relative and have the form its pair declares (context/doc-rules/project-rules/
// internal-links.md). `route` (the default): no .md/.mdx. `file-path`: a link to a page of the same pair is the file's
// path from the pair's UA content root, .md/.mdx kept; a link to another pair is still a route, since Docusaurus resolves
// a file link only inside its own docs instance. `pair` is the linking page's: { linkForm, urlPrefix, ua }; `prefixes`
// are the URL prefixes of every declared pair. Links to assets, anchors and other sites are not page links.
const ASSET_LINK = /\.(png|jpe?g|gif|svg|webp|pdf|zip|csv|json|ya?ml|txt|mp4|webm)(#.*)?$/i;
const segments = (p) => p.split('/').filter(Boolean);
const startsWith = (segs, prefix) => prefix.every((x, i) => segs[i] === x);
export function linkFormProblem(target, { pair = null, prefixes = [] } = {}) {
  if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target) || ASSET_LINK.test(target) || target.includes('.assets/')) return null;
  const bare = target.split(/[?#]/)[0];
  const hasExt = /\.mdx?$/i.test(bare);
  if (pair?.linkForm !== 'file-path') {
    if (hasExt) return 'it has a file extension';
    if (!target.startsWith('/')) return 'it is not site-root-relative';
    return null;
  }
  if (!target.startsWith('/')) return 'it is not site-root-relative';
  const segs = segments(bare);
  if (hasExt) {
    const root = segments(pair.ua);
    return root.length && startsWith(segs, root) ? `it repeats the UA content root ${pair.ua}/: a file-path link starts below it` : null;
  }
  // The longest whole-segment prefix match names the target's pair; an unmatched route is left to the skills.
  const own = segments(pair.urlPrefix);
  const best = prefixes.map(segments).filter((p) => startsWith(segs, p)).sort((a, b) => b.length - a.length)[0];
  return best && best.join('/') === own.join('/') ? 'it is a route, but this root pair links its own pages by file path (Page link form: file-path)' : null;
}

const frontmatterKeys = (fm) => new Map((fm?.entries ?? []).filter((e) => e.key !== 'last_update').map((e) => [e.key, e]));

// Every deterministic check on one translated page. Pure: reads nothing but its arguments and the disk
// (for asset links).
export async function checkPage({ locale, uaText, targetText, targetFile, state, labels, meta, unverified = [], root, linkTitles = [], knownStrings = new Set(), linkForm = {} }) {
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
    for (const e of ft.entries) {
      const problem = e.start === e.end ? yamlScalarProblem(e.first) : null;
      if (problem) fail('frontmatter', `'${e.key}' would not parse as YAML: ${problem}. Quote the value.`, { key: e.key, value: e.first });
    }
    for (const key of ['title', 'description']) {
      const a = ka.get(key);
      const t = kt.get(key);
      // A loanword title can legitimately equal the UA one (kk «Месенджер») when the locale's term memory or the app has it.
      if (a && t && CYRILLIC.test(a.value) && a.value === t.value && !(key === 'title' && knownStrings.has(normString(t.value)))) fail('frontmatter', `'${key}' is not translated.`, { value: t.value });
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

  // Code blocks (their code part), inline code, links, images and MDX tags.
  const fa2 = ua.sc.fences.map(fenceKey);
  const ft2 = tr.sc.fences.map(fenceKey);
  if (fa2.length !== ft2.length) fail('code', `The UA page has ${fa2.length} code blocks but the translation has ${ft2.length}.`);
  else {
    const bad = fa2.map((k, i) => (k === ft2[i] ? null : i + 1)).filter(Boolean);
    if (bad.length) fail('code', 'Code blocks must keep the code of the UA page byte for byte, line for line: only diagram labels, comments and tree descriptions are translated (code-blocks.md).', { blocks: bad });
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
  // A link copied verbatim from UA in the wrong form is wrong on the UA page too: it has to be fixed there.
  const badForm = [...new Set(tr.links)].map((target) => [target, linkFormProblem(target, linkForm)]).filter(([, p]) => p);
  const formRule = linkForm.pair?.linkForm === 'file-path'
    ? 'Page links must be site-root-relative: file paths with .md/.mdx to pages of this root pair (Page link form: file-path), routes with no .md/.mdx to other pairs.'
    : 'Page links must be site-root-relative routes with no .md/.mdx.';
  if (badForm.length) fail('link-form', `${formRule} Fix them on the UA page too, then translate again.`, { links: head(badForm.map(([target, problem]) => `${target}: ${problem}`)) });

  // ToDo / NEEDS CONFIRMATION markers and other comments.
  if (ua.markers !== tr.markers) fail('markers', `The UA page has ${ua.markers} ToDo / NEEDS CONFIRMATION markers but the translation has ${tr.markers}.`);
  if (ua.otherComments !== tr.otherComments) fail('markers', `The UA page has ${ua.otherComments} other {/* … */} comments but the translation has ${tr.otherComments}.`);

  // UI labels: bound spans use the target-locale string from the label store, or are recorded as unverified. A span with
  // decisions scoped to headings (`scope.mjs`) is checked section by section, because each section must show the string
  // of the key that applies there; the headings check guarantees the sections line up. Any other span is checked
  // anywhere on the page.
  const uaMap = sectionMap(uaText);
  const occ = decidedOccurrences([{ text: uaText, firstLine: 1, pathAt: (i) => uaMap.paths[uaMap.at[i]] }], state?.spans ?? {}).filter((o) => o.kind === 'bold' && o.decision?.startsWith('label:'));
  if (occ.length) {
    const scopedSpans = new Set(occ.filter((o) => o.scope).map((o) => o.span));
    const trMap = headingsOk && scopedSpans.size ? sectionMap(targetText) : null;
    const regions = new Map();
    const regionText = (k) => {
      if (!regions.has(k)) regions.set(k, tr.sc.prose.filter((_, i) => trMap.at[i] === k).join('\n'));
      return regions.get(k);
    };
    const excused = new Set(unverified.map((u) => (typeof u === 'string' ? u : u.span)));
    // Where to fix a label: the first line of each translated block that holds the span (in that section, for a scoped
    // check), ready for `blocks --redo`.
    const align = headingsOk ? alignTrees(ua.page.root, tr.page.root).map : null;
    const fixLines = (span, key, k) => {
      if (!align) return {};
      const lines = new Set();
      for (const o of occ) {
        if (o.span !== span || o.decision !== `label:${key}` || (k !== null && uaMap.at[o.line - 1] !== k)) continue;
        const t = align.get(nodeAt(ua.page.root, o.line - 1));
        if (t) lines.add(t.start + 1);
      }
      return lines.size ? { redo: [...lines].sort((a, b) => a - b).join(',') } : {};
    };
    const bad = [];
    const done = new Set();
    for (const o of occ) {
      const key = o.decision.slice(6);
      const k = trMap && scopedSpans.has(o.span) ? uaMap.at[o.line - 1] : null;
      const id = `${o.span}\0${key}\0${k}`;
      if (done.has(id)) continue;
      done.add(id);
      const where = k === null ? {} : { section: uaMap.paths[k].at(-1)?.title ?? '(before the first heading)' };
      const expected = labels?.[locale]?.[key];
      if (expected === undefined) {
        if (!labels) bad.push({ span: o.span, key, problem: 'no label store: run ui-labels import' });
        else if (!excused.has(o.span)) bad.push({ span: o.span, key, problem: `the label store has no '${locale}' string for this key, so the span must be recorded as unverified` });
      } else if (!acceptedLabels(o.span, labels.uk?.[key], expected).some((form) => (k === null ? tr.prose : regionText(k)).includes(`**${form}**`))) {
        bad.push({ span: o.span, key, ...where, expected: `**${expected}**`, problem: k === null ? 'the UI label is not in bold, verbatim, in the translation' : 'the UI label is not in bold, verbatim, in this section of the translation', ...fixLines(o.span, key, k) });
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

  // Ukrainian-only letters left in the translation: prose, plus the reader text of code blocks (diagram labels, comments,
  // tree descriptions). The code part is data and keeps its letters.
  const codeText = tr.sc.fences.flatMap((f) => fenceParts(f.info, f.lines).texts.map((t) => ({ text: t.text, line: f.startLine + t.line + 2 })));
  const hits = [];
  const scan = (text, line) => {
    const letters = uaOnlyLetters(text, locale);
    if (letters) hits.push({ line, letters, text: text.trim().slice(0, 100) });
  };
  tr.sc.prose.forEach((l, i) => scan(l, i + 1));
  for (const t of codeText) scan(t.text, t.line);
  if (hits.length) fail('ukrainian-letters', 'Letters that exist only in Ukrainian remain: part of the text was not translated.', { hits: hits.slice(0, 8), total: hits.length });

  // A translation written mostly in Latin letters must not keep any Cyrillic text either (the Ukrainian-only letters
  // above miss untranslated words that happen to avoid them), the reader text of code blocks included.
  const count = (re) => (tr.prose.match(re) ?? []).length;
  const cyr = count(/\p{Script=Cyrillic}/gu);
  const lat = count(/\p{Script=Latin}/gu);
  if (!hits.length && lat > 0 && cyr / (cyr + lat) < 0.5) {
    const stray = [];
    const find = (text, line) => CYRILLIC.test(text) && stray.push({ line, text: text.trim().slice(0, 100) });
    tr.sc.prose.forEach((l, i) => find(l, i + 1));
    for (const t of codeText) find(t.text, t.line);
    // Only a warning: language pickers and similar lists legitimately show Cyrillic names on a Latin-script page.
    if (stray.length) warnings.push(`Cyrillic text remains in a translation written in Latin letters (${stray.length} lines, first at line ${stray[0].line}: ${stray[0].text}). Fine for language names; otherwise it is untranslated.`);
  }

  // A link whose UA text names the target page's title names it by that page's title in the translation too, inflected
  // as needed. Only a warning: the reader still reaches the page.
  const offTitle = offTitleLinks(linkTitles, tr.sc.prose);
  if (offTitle.length) {
    const shown = offTitle.map((o) => `line ${o.line} "${o.text}" for "${o.title}"`).join('; ');
    warnings.push(`${offTitle.length} link text${offTitle.length > 1 ? 's name their target pages' : ' names its target page'} differently from the page title: ${shown}.`);
  }

  return { ok: failures.length === 0, failures, warnings, checks: [...new Set(failures.map((f) => f.check))], linkTitles: offTitle };
}

// Loads everything `checkPage` needs for one page in one locale. `candidate` is a file to check instead of the
// translation on disk (it is judged as if it were at the translation's path).
export async function checkTranslation(s, page, locale, { candidate = null, unverified = [], store } = {}) {
  if (page.kind === 'category') return checkCategoryUnit(s, page, locale, { candidate, unverified, store });
  const uaText = await cachedBlob(s.root, page.blob);
  const targetFile = localePagePath(locale, page);
  const targetText = await readIfExists(candidate ? path.resolve(candidate) : abs(s, targetFile));
  const state = await readState(page);
  const st = store === undefined ? await loadStore(s.labelsDir) : store;
  const labels = st ? mergedLabels(st).labels : null;
  const terms = await readTerms(s, locale);
  const knownStrings = new Set([...terms.entries.map((e) => e.target), ...Object.values(labels?.[locale] ?? {})].map(normString));
  const linkTitles = targetText === null ? [] : await titleLinks(s, page, uaText, locale);
  const result = await checkPage({ locale, uaText, targetText, targetFile, state, labels, meta: st?.meta, unverified: [...unverified, ...(state.locales[locale]?.unverified ?? [])].filter(Boolean), root: s.root, linkTitles, knownStrings, linkForm: { pair: page.ps, prefixes: (s.declaredPairs ?? [page.ps]).map((p) => p.urlPrefix) } });
  return { ...result, page: page.ref, locale, file: targetFile, uaText, targetText, state, store: st, labels };
}

