import path from 'node:path';
import { CliError } from '../../ui-labels/lib/util.mjs';
import { loadSettings, requirePairs, resolveLocales, deriveLocaleRoot, selectPairs, pagesDir } from '../../ui-labels/lib/config.mjs';

const posix = path.posix;
const cleanDir = (p) => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');

// Reuses the ui-labels config reader: same CLAUDE.md block, same flags, same state root.
// `s.pairs` are the UA/EN root pairs the run covers (all declared ones unless `--pair` narrows them), each with its own
// roots, URL prefix, scope and state folder. `s.ua`, `s.en` and `s.urlPrefix` stay the primary pair's.
export async function loadSyncSettings(values) {
  // `--locales` narrows the run here; ui-labels would treat it as the full target list.
  const { locales, ...rest } = values;
  const s = await loadSettings(rest);
  const declared = requirePairs(s);
  s.requestedLocales = locales ? locales.split(',').map((l) => l.trim()).filter(Boolean) : null;
  s.scopeOverride = values.scope ?? null;
  s.multiPair = declared.length > 1;
  s.pairIds = declared.map((p) => p.id);
  s.declaredPairs = declared.map((p) => pairView(s, p));
  s.pairs = selectPairs(s.declaredPairs.map((v) => v.pair), s.pairSpec).map((p) => s.declaredPairs.find((v) => v.pair === p));
  const primary = s.declaredPairs[0];
  s.ua = primary.ua;
  s.en = primary.en;
  s.urlPrefix = primary.urlPrefix;
  return s;
}

// What a unit of one pair resolves its paths against.
function pairView(s, pair) {
  return {
    root: s.root,
    pair,
    ua: cleanDir(pair.ua),
    en: cleanDir(pair.en),
    urlPrefix: pair.urlPrefix,
    scopeSpec: pair.scope,
    scopeOverride: s.scopeOverride,
    statesDir: pagesDir(s.stateRoot, pair),
    multiPair: s.multiPair,
    pairIds: s.pairIds,
  };
}

// Target locales = docusaurus.config i18n.locales minus default and en. `--locales` may only narrow that list.
// Without a usable config (or one with no target locales yet) an explicit `--locales` is accepted, with a warning.
export async function resolveTargets(s) {
  let configured = null;
  let failure = null;
  try {
    configured = (await resolveLocales({ ...s, explicitLocales: null })).targets;
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    failure = e;
  }
  if (!s.requestedLocales) {
    if (failure) throw failure;
    return { targets: configured, warnings: [] };
  }
  if (!configured) {
    return { targets: s.requestedLocales, warnings: [`${failure.message} Using --locales as given.`] };
  }
  const unknown = s.requestedLocales.filter((l) => !configured.includes(l));
  if (unknown.length) {
    throw new CliError(`--locales ${unknown.join(', ')} is not a configured target locale. Configured: ${configured.join(', ')}.`, { code: 2, data: { configured } });
  }
  return { targets: configured.filter((l) => s.requestedLocales.includes(l)), warnings: [] };
}

// `ps` is a pair (`s.pairs[i]`, a unit's `ps`), or the settings for the primary pair.
export const localeRoot = (ps, locale) => cleanDir(deriveLocaleRoot(ps.en + '/', locale));

// `api-reference:transactions` -> { pair: 'api-reference', rest: 'transactions' } when the prefix is a declared pair.
export function splitQualified(selector, pairIds = []) {
  const m = selector.trim().match(/^([a-z0-9]+(?:-[a-z0-9]+)*):(.*)$/);
  return m && pairIds.includes(m[1]) ? { pair: m[1], rest: m[2] } : null;
}

// How a selector (cleaned) reaches a unit: as a page id, path or folder relative to the repo root ('repo') or to the
// unit's UA content root ('ua'), or not at all (null).
function reach(ps, page, sel) {
  const hit = (v) => {
    const bare = v.replace(/\.(md|mdx)$/, '');
    return page.path === v || page.path.startsWith(v + '/') || `${ps.ua}/${page.id}` === bare;
  };
  return hit(sel) ? 'repo' : hit(posix.join(ps.ua, sel)) ? 'ua' : null;
}

// One selector within one pair: a page id, a page path, or a folder, relative to the repo root or to its UA content root.
export function selectorMatches(ps, page, selector) {
  const sel = cleanDir(selector);
  if (!sel || sel === '.') return true;
  return reach(ps, page, sel) !== null;
}

// The units one selector picks among units of several pairs. `<pair>:<selector>` looks in that pair only. Otherwise
// a selector that reaches units of more than one pair keeps only what it reaches as a path from the repo root; when it
// reaches them only relative to their UA roots (a bare id such as `transactions/transactions` in both), it is
// ambiguous: `ambiguous` lists the pairs.
export function resolveSelector(s, units, selector) {
  const q = splitQualified(selector, s.pairIds);
  const pool = q ? units.filter((u) => u.ps.pair.id === q.pair) : units;
  const sel = cleanDir(q ? q.rest : selector);
  if (!sel || sel === '.') return { hits: pool, ambiguous: null };
  const kinds = new Map(pool.map((u) => [u, reach(u.ps, u, sel)]));
  let hits = pool.filter((u) => kinds.get(u));
  const pairsOf = (list) => [...new Set(list.map((u) => u.ps.pair.id))];
  if (!q && pairsOf(hits).length > 1) {
    const fromRoot = hits.filter((u) => kinds.get(u) === 'repo');
    if (!fromRoot.length) return { hits, ambiguous: pairsOf(hits) };
    hits = fromRoot;
  }
  return { hits, ambiguous: null };
}

export function selectPages(s, pages, selectors) {
  if (!selectors?.length) return pages;
  const picked = new Set();
  const unmatched = [];
  const ambiguous = [];
  for (const selector of selectors) {
    const r = resolveSelector(s, pages, selector);
    if (r.ambiguous) {
      const candidates = r.ambiguous.map((pair) => {
        const units = r.hits.filter((u) => u.ps.pair.id === pair);
        return { selector: `${pair}:${cleanDir(selector)}`, pair, units: units.slice(0, 5).map((u) => u.path), ...(units.length > 5 ? { more: units.length - 5 } : {}) };
      });
      ambiguous.push({ selector, candidates });
    } else if (!r.hits.length) unmatched.push(selector);
    else for (const u of r.hits) picked.add(u);
  }
  if (ambiguous.length) {
    const shown = ambiguous.map((a) => `'${a.selector}' (${a.candidates.map((c) => c.selector).join(' or ')})`).join(', ');
    throw new CliError(`Ambiguous: ${shown} matches units of more than one root pair. Pass the qualified selector, or a path from the repo root.`, { code: 2, data: { ambiguous } });
  }
  if (unmatched.length) {
    throw new CliError(`No in-scope UA page matches: ${unmatched.join(', ')}.`, { code: 2, data: { unmatched } });
  }
  return pages.filter((p) => picked.has(p));
}

// The pair's `Translation scope:` (comma-separated folders or pages), or `--scope`, which replaces every pair's: an
// unqualified selector of it applies to every pair, a qualified one (`<pair>:<folder>`) to its pair only. `none` is an
// empty scope. Null means the whole UA content root.
export function scopeSelectors(ps) {
  const spec = ps.scopeOverride ?? ps.scopeSpec;
  if (!spec) return null;
  if (spec.trim().toLowerCase() === 'none') return [];
  const list = spec.split(',').map((x) => x.trim()).filter(Boolean);
  if (ps.scopeOverride == null) return list;
  return list.flatMap((sel) => {
    const q = splitQualified(sel, ps.pairIds);
    return !q ? [sel] : q.pair === ps.pair.id ? [q.rest || '.'] : [];
  });
}
