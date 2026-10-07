import path from 'node:path';
import { CliError } from '../../ui-labels/lib/util.mjs';
import { loadSettings, requireRoots, resolveLocales, deriveLocaleRoot } from '../../ui-labels/lib/config.mjs';

const posix = path.posix;
const cleanDir = (p) => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');

// Reuses the ui-labels config reader: same CLAUDE.md block, same flags, same state root.
export async function loadSyncSettings(values) {
  // `--locales` narrows the run here; ui-labels would treat it as the full target list.
  const { locales, ...rest } = values;
  const s = await loadSettings(rest);
  const roots = requireRoots(s);
  s.ua = cleanDir(roots.ua);
  s.en = cleanDir(roots.en);
  s.urlPrefix = values['url-prefix'] ?? s.claude['ua url prefix'] ?? '/';
  s.requestedLocales = locales ? locales.split(',').map((l) => l.trim()).filter(Boolean) : null;
  s.scopeSpec = values.scope ?? s.claude['translation scope'] ?? null;
  return s;
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

export const localeRoot = (s, locale) => cleanDir(deriveLocaleRoot(s.en + '/', locale));

// One selector: a page id, a page path, or a folder, relative to the repo root or to the UA content root.
export function selectorMatches(s, page, selector) {
  const sel = cleanDir(selector);
  if (!sel || sel === '.') return true;
  const variants = [sel, posix.join(s.ua, sel)];
  return variants.some((v) => {
    const bare = v.replace(/\.(md|mdx)$/, '');
    return page.path === v || page.path.startsWith(v + '/') || `${s.ua}/${page.id}` === bare;
  });
}

export function selectPages(s, pages, selectors) {
  if (!selectors?.length) return pages;
  const picked = pages.filter((p) => selectors.some((sel) => selectorMatches(s, p, sel)));
  const unmatched = selectors.filter((sel) => !pages.some((p) => selectorMatches(s, p, sel)));
  if (unmatched.length) {
    throw new CliError(`No in-scope UA page matches: ${unmatched.join(', ')}.`, { code: 2, data: { unmatched } });
  }
  return picked;
}

// The declared `Translation scope:` (comma-separated folders or pages) or the whole UA content root.
export function scopeSelectors(s) {
  if (!s.scopeSpec) return null;
  return s.scopeSpec.split(',').map((x) => x.trim()).filter(Boolean);
}
