import { CliError, readJson, writeJson } from '../../ui-labels/lib/util.mjs';
import { loadStore, mergedLabels } from '../../ui-labels/lib/store.mjs';
import { runLookup } from '../../ui-labels/lib/lookup.mjs';
import { runBlocks } from './blocks.mjs';
import { listUaPages, readState, statePath } from './pages.mjs';
import { cachedBlob } from './plan.mjs';
import { parseCategory } from './categories.mjs';
import { withLock } from './lock.mjs';
import { groupBySpan, inUiContext, spanOccurrences, uiParts } from './spans.mjs';

// The binding pass (Requirement 3), once for all locales. Every bold span (and Cyrillic inline-code span) in the UA text
// that some locale will translate gets one decision per page: `label:<key>`, `unverified` (UI context, no dictionary
// match), `term` or `emphasis`. The script records what it can decide on its own and returns the rest (`ask`) for the
// model, which answers through `bind --decisions`.

const DECISION = /^(?:term|emphasis|unverified|label:.+)$/;

// Namespace heuristic (Requirement 3, criterion 2): among keys with the same UA string, the one whose namespace matches
// the page's area. The area is the page path (2 points) and the namespaces of keys already bound on the page (1 point
// per bound key, at most 2). A key needs 2 points and must beat every other candidate; otherwise the model decides.
const tokens = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
const related = (a, b) => {
  const n = Math.min(a.length, b.length, 5);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
};
export function pickByNamespace(keys, pageId, boundKeys) {
  const pageTokens = tokens(pageId);
  const scored = keys.map((key) => {
    const ns = key.split('.');
    const nsTokens = tokens(ns.slice(0, -1).join('.'));
    const sameNs = boundKeys.filter((k) => k !== key && k.split('.')[0] === ns[0]).length;
    return { key, score: (nsTokens.some((t) => pageTokens.some((p) => related(t, p))) ? 2 : 0) + Math.min(2, sameNs) };
  });
  const top = Math.max(0, ...scored.map((x) => x.score));
  const best = scored.filter((x) => x.score === top);
  return top >= 2 && best.length === 1 ? best[0].key : null;
}

const clip = (text, at) => {
  const t = text.trim();
  if (t.length <= 200) return t;
  const start = Math.max(0, Math.min(at - 80, t.length - 200));
  return (start ? '…' : '') + t.slice(start, start + 200) + (start + 200 < t.length ? '…' : '');
};

// The UA text each unit will be translated from, across all target locales: the whole page when any locale translates
// it in full, otherwise the changed blocks.
async function unitsToBind(s, selectors, overwrite) {
  const { results, warnings } = await runBlocks(s, { selectors: selectors.length ? selectors : ['.'], overwrite });
  const units = new Map();
  for (const r of results) {
    if (r.mode !== 'full' && r.mode !== 'incremental') continue;
    const u = units.get(r.page) ?? { page: r.page, kind: r.kind, blob: r.blob, full: null, parts: new Set() };
    if (r.kind === 'category') {
      const label = parseCategory(await cachedBlob(s.root, r.blob)).fields.find((f) => f.field === 'label')?.ua;
      if (label) u.categoryLabel = label;
    } else if (r.mode === 'full') u.full = r.ua.text;
    else for (const c of r.changes) if (c.ua?.text) u.parts.add(c.ua.text);
    units.set(r.page, u);
  }
  return { units: [...units.values()], warnings };
}

export async function runBind(s, { selectors = [], overwrite = false, dryRun = false } = {}) {
  const store = await loadStore(s.labelsDir);
  if (!store) throw new CliError('No label snapshot found. Run the UI label check (ui-labels import) first.', { code: 2 });
  const { labels } = mergedLabels(store);
  const { units, warnings } = await unitsToBind(s, selectors, overwrite);

  // Spans per unit that need a decision, or a second look (an `unverified` span may be in the store by now).
  const work = [];
  const toLookUp = new Set();
  for (const u of units) {
    const state = await readState(s, u.page);
    const occ =
      u.kind === 'category'
        ? u.categoryLabel
          ? new Map([[u.categoryLabel, [{ span: u.categoryLabel, kind: 'category', line: 1, at: 0, end: 0, text: u.categoryLabel }]]])
          : new Map()
        : groupBySpan(spanOccurrences(u.full ?? [...u.parts].join('\n')));
    const open = [...occ].filter(([span]) => !state.spans[span] || state.spans[span] === 'unverified');
    for (const [span] of open) {
      const { markup, parts } = uiParts(span);
      if (markup) for (const p of parts) toLookUp.add(p);
      else toLookUp.add(span);
    }
    work.push({ u, state, occ, open, inScope: occ.size });
  }
  const looked = toLookUp.size ? await runLookup(s, { spans: [...toLookUp], locales: store.meta.locales.filter((l) => l !== 'uk') }) : { results: [] };
  const hits = new Map(looked.results.map((r) => [r.span, r]));

  // Decisions other pages already recorded for the same span text, so a span the docs repeat (`**Результат:**`) is
  // decided the same way everywhere. They become the `suggest` of an ask that has none (`seenOn` counts them).
  const elsewhere = new Map();
  for (const p of (await listUaPages(s)).all) {
    for (const [span, d] of Object.entries((await readState(s, p.id)).spans)) {
      const m = elsewhere.get(span) ?? new Map();
      elsewhere.set(span, m.set(d, (m.get(d) ?? 0) + 1));
    }
  }
  const fromElsewhere = (span, hit) => {
    const seen = elsewhere.get(span);
    if (!seen) return {};
    const keys = new Set(hit.status === 'no-match' ? [] : hit.status === 'ambiguous' ? hit.candidates.map((c) => c.key) : [hit.key, ...hit.alsoKeys]);
    const fits = [...seen].filter(([d]) => !d.startsWith('label:') || keys.has(d.slice(6))).sort((a, b) => b[1] - a[1]);
    const top = fits.length && (fits.length === 1 || fits[0][1] > fits[1][1]) ? fits[0][0] : null;
    return { seenOn: Object.fromEntries(seen), ...(top ? { top } : {}) };
  };

  const pages = [];
  for (const { u, state, open, inScope } of work) {
    const resolved = [];
    const ask = [];
    const bound = Object.values(state.spans).filter((d) => d.startsWith('label:')).map((d) => d.slice(6));
    const lookupFor = (hit) =>
      hit.status === 'no-match'
        ? { status: 'no-match' }
        : hit.status === 'ambiguous'
          ? { status: 'ambiguous', match: hit.match, candidates: hit.candidates.map((c) => ({ key: c.key, uk: labels.uk?.[c.key] ?? null, en: labels.en?.[c.key] ?? null })) }
          : { status: hit.status, match: hit.match, key: hit.key, alsoKeys: hit.alsoKeys, en: labels.en?.[hit.key] ?? null };
    const askFor = (span, occ, hit, suggest, why) => {
      const { seenOn, top } = fromElsewhere(span, hit);
      const guess = suggest ?? top;
      ask.push({ span, kind: occ[0].kind, why, lookup: lookupFor(hit), ...(guess ? { suggest: guess } : {}), ...(seenOn ? { seenOn } : {}), contexts: occ.slice(0, 3).map((o) => ({ line: o.line, text: clip(o.text, o.at) })) });
    };

    // Unique dictionary matches first, so their namespaces help choose among identical candidates.
    // Markup spans: `term`, written part by part from the label store, when every part is a UI string with one
    // string per locale. Otherwise the model decides, seeing each part's lookup.
    const markupSpans = open.filter(([span]) => uiParts(span).markup);
    for (const [span, occ] of markupSpans) {
      const recheck = state.spans[span] === 'unverified';
      const { parts } = uiParts(span);
      const partHits = parts.map((p) => hits.get(p));
      if (partHits.every((h) => h.class === 'label' && h.match !== 'pattern')) {
        resolved.push({ span, decision: 'term', why: 'UI text with markup: each part is written from the label store' });
        continue;
      }
      if (recheck) continue;
      const ui = occ.some(inUiContext);
      const { seenOn, top } = fromElsewhere(span, { status: 'no-match' });
      ask.push({
        span,
        kind: occ[0].kind,
        why: 'UI text with markup, not every part is a UI string',
        parts: parts.map((p, i) => ({ ua: p, lookup: lookupFor(partHits[i]) })),
        ...(ui || top ? { suggest: ui ? 'term' : top } : {}),
        ...(seenOn ? { seenOn } : {}),
        contexts: occ.slice(0, 3).map((o) => ({ line: o.line, text: clip(o.text, o.at) })),
      });
    }

    const pass = (unique) => {
      for (const [span, occ] of open) {
        if (uiParts(span).markup) continue;
        const hit = hits.get(span);
        const isUnique = hit.class === 'label' && hit.status === 'unique';
        if (isUnique !== unique) continue;
        const recheck = state.spans[span] === 'unverified';
        const category = occ[0].kind === 'category';
        const defs = occ.filter((o) => o.defList).length;
        // A definition item that is a dictionary string names a UI element (a control or a status value the list
        // describes), so it counts as UI context. Only definition items the dictionary doesn't know are terms.
        const defUi = defs > 0 && hit.status !== 'no-match' && hit.match !== 'pattern';
        const ui = category || defUi || occ.some(inUiContext);
        if (hit.status === 'no-match') {
          if (recheck) continue; // still not in the store: the decision stands
          if (category) resolved.push({ span, decision: 'term', why: 'sidebar category label not in the dictionary' });
          else if (defs === occ.length) resolved.push({ span, decision: 'term', why: 'definition list' });
          else askFor(span, occ, hit, ui ? 'unverified' : null, ui ? 'UI context, no dictionary match' : 'no dictionary match');
          continue;
        }
        const keys = hit.status === 'ambiguous' ? hit.candidates.map((c) => c.key) : [hit.key, ...hit.alsoKeys];
        const pick = keys.length === 1 ? keys[0] : pickByNamespace(keys, u.page, bound);
        if (hit.class === 'label' && hit.match !== 'pattern' && ui && pick) {
          const why = recheck
            ? 'now in the dictionary'
            : keys.length > 1
              ? `namespace of ${keys.length} keys with the same strings`
              : category
                ? 'sidebar category label in the dictionary'
                : defs === occ.length
                  ? 'definition item naming a UI string'
                  : 'dictionary match in a UI context';
          resolved.push({ span, decision: `label:${pick}`, why });
          bound.push(pick);
          continue;
        }
        if (recheck) continue; // a decision the model made: asked again only if the script can now resolve it
        const why =
          hit.status === 'ambiguous'
            ? `${keys.length} keys with different strings`
            : hit.match === 'pattern'
              ? 'matches only a placeholder pattern'
              : !ui
                ? 'dictionary match without UI context'
                : `${keys.length} keys with the same strings, no namespace fits`;
        // No namespace guess among keys with different strings: there the key decides the translation, and a
        // namespace that merely mentions the page's area (a dialog's key) misleads more than it helps.
        askFor(span, occ, hit, pick && hit.status !== 'ambiguous' ? `label:${pick}` : null, why);
      }
    };
    pass(true);
    pass(false);

    if (resolved.length && !dryRun) await writeSpans(s, u.page, Object.fromEntries(resolved.map((r) => [r.span, r.decision])));
    const rechecked = open.filter(([span]) => state.spans[span]).length;
    pages.push({ page: u.page, kind: u.kind, spans: inScope, decided: inScope - open.length + rechecked, resolved, ask });
  }
  const sum = (f) => pages.reduce((n, p) => n + f(p), 0);
  return {
    dryRun,
    pages: pages.filter((p) => p.resolved.length || p.ask.length),
    summary: { pages: pages.length, spans: sum((p) => p.spans), decided: sum((p) => p.decided), resolved: sum((p) => p.resolved.length), ask: sum((p) => p.ask.length) },
    apply: 'Decide each `ask` span: label:<key> | unverified | term | emphasis. Write { "<page>": { "<span>": "<decision>" } } to a JSON file and run `bind --decisions <file>`.',
    warnings,
  };
}

async function writeSpans(s, id, decisions) {
  const file = statePath(s, id);
  await withLock(file, async () => {
    const fresh = await readState(s, id);
    await writeJson(file, { ...fresh, spans: { ...fresh.spans, ...decisions } });
  });
}

// Records the model's decisions: { "<page id>": { "<span>": "label:<key>" | "unverified" | "term" | "emphasis" } }.
export async function runDecisions(s, file, { dryRun = false } = {}) {
  const data = await readJson(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError(`${file} must be a JSON object { "<page>": { "<span>": "<decision>" } }.`, { code: 2 });
  const store = await loadStore(s.labelsDir);
  const labels = store ? mergedLabels(store).labels : {};
  const { all, categories } = await listUaPages(s);
  const units = new Map([...all, ...categories].map((u) => [u.id, u]));
  const written = [];
  const rejected = [];
  for (const [id, decisions] of Object.entries(data)) {
    const unit = units.get(id.replace(/\.(md|mdx|json)$/, ''));
    if (!unit) {
      rejected.push({ page: id, reason: 'no UA page or category with this id' });
      continue;
    }
    const text = await cachedBlob(s.root, unit.blob);
    const present = new Set(unit.kind === 'category' ? parseCategory(text).fields.filter((f) => f.field === 'label').map((f) => f.ua) : spanOccurrences(text).map((o) => o.span));
    const state = await readState(s, unit.id);
    const accepted = {};
    for (const [span, decision] of Object.entries(decisions ?? {})) {
      const key = typeof decision === 'string' && decision.startsWith('label:') ? decision.slice(6) : null;
      const reason =
        typeof decision !== 'string' || !DECISION.test(decision)
          ? 'a decision is label:<key>, unverified, term or emphasis'
          : !present.has(span)
            ? 'the span is not on the committed UA page'
            : key && !Object.values(labels).some((m) => typeof m?.[key] === 'string')
              ? 'the label store has no such key'
              : null;
      if (reason) rejected.push({ page: unit.id, span, decision, reason });
      else {
        accepted[span] = decision;
        written.push({ page: unit.id, span, decision, ...(state.spans[span] && state.spans[span] !== decision ? { previous: state.spans[span] } : {}) });
      }
    }
    if (Object.keys(accepted).length && !dryRun) await writeSpans(s, unit.id, accepted);
  }
  return { dryRun, written, rejected };
}
