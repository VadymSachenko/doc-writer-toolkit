import path from 'node:path';
import { CliError, unique } from '../../ui-labels/lib/util.mjs';
import { loadSettings, requirePairs, deriveLocaleRoot, readDocusaurusI18n } from '../../ui-labels/lib/config.mjs';

const posix = path.posix;
export const cleanDir = (p) => posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');
export const within = (p, dir) => p === dir || p.startsWith(`${dir}/`);

export const MODES = ['url-prefix', 'query', 'cookie', 'ui'];
const NAMED = { query: 'parameter', cookie: 'cookie' };
const list = (spec) => unique(String(spec ?? '').split(',').map((x) => x.trim()).filter(Boolean));

// `<mode> [<name>] <locale>=<token>, …`: `url-prefix uk=/, en=/en/`, `query lang uk=uk, en=en`, `cookie locale uk=uk, en=en`,
// `ui uk=Українська, en=English`. Returns { mode, name, tokens, problems }.
export function parseSwitch(spec) {
  const problems = [];
  const m = String(spec).trim().match(/^(\S+)\s*([\s\S]*)$/);
  const mode = m?.[1] ?? '';
  if (!MODES.includes(mode)) {
    return { mode, name: null, tokens: {}, problems: [`Locale switch: unknown mode '${mode}'. Use one of ${MODES.join(', ')}.`] };
  }
  let rest = m[2];
  let name = null;
  if (NAMED[mode]) {
    const n = rest.match(/^([^\s=,]+)\s+([\s\S]*)$/);
    if (n) [, name, rest] = n;
    else problems.push(`Locale switch: '${mode}' needs the ${NAMED[mode]} name before the tokens, as in \`${mode} lang uk=uk, en=en\`.`);
  }
  const tokens = {};
  for (const part of rest.split(',').map((x) => x.trim()).filter(Boolean)) {
    const t = part.match(/^([\w-]+)\s*=\s*(\S[\s\S]*)$/);
    if (t) tokens[t[1]] = t[2].trim();
    else problems.push(`Locale switch: can't read '${part}'. Write <locale>=<token>.`);
  }
  return { mode, name, tokens, problems };
}

// `en=EN_, de=DE_` -> { en: 'EN_', de: 'DE_' }
export function parsePairs(spec) {
  const map = {};
  for (const part of String(spec ?? '').split(',')) {
    const m = part.trim().match(/^([\w-]+)\s*=\s*(\S+)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

// Where a locale's pages live in one root pair: the default locale in the pair's UA content root, `en` in its EN i18n
// root, any other locale in the EN root with its `en` segment replaced (context/project-paths.md). Never declared.
export function localeRootOf(pair, locale, defaultLocale) {
  if (locale === defaultLocale) return cleanDir(pair.ua);
  if (locale === 'en') return cleanDir(pair.en);
  return cleanDir(deriveLocaleRoot(`${cleanDir(pair.en)}/`, locale));
}

// Resolves the screenshot-locale declarations of <root>/CLAUDE.md. Without `Screenshot locales:` the host is
// single-locale (multilocale: false). Collects every problem instead of stopping at the first, so the skill can ask
// one question that covers them all. `requested` is an explicitly locale-scoped request (`--locales`).
export async function resolveConfig(values) {
  const s = await loadSettings(values);
  const c = s.claude;
  const stateRel = cleanDir(path.relative(s.root, s.stateRoot)) || '.';
  const base = { root: s.root, settings: s, stagingRoot: posix.join(stateRel, 'screenshot-staging') };
  const spec = c['screenshot locales'];
  if (!spec) return { ...base, multilocale: false, problems: [], warnings: [] };

  const problems = [];
  const warnings = [];
  const problem = (field, message, extra = {}) => problems.push({ field, message, ...extra });
  const locales = list(spec);
  if (!locales.length) problem('Screenshot locales', 'Screenshot locales: is declared but lists no locale.');

  let i18n = null;
  try {
    i18n = await readDocusaurusI18n(s);
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    problem('docusaurus.config', `${e.message} The locale folders can't be derived without it.`);
  }
  if (i18n) {
    for (const locale of locales.filter((l) => !i18n.locales.includes(l))) {
      problem('Screenshot locales', `'${locale}' is not a locale of docusaurus.config (${i18n.locales.join(', ')}). Its folders can't be derived, and are never guessed.`, { locale });
    }
  }

  const switchSpec = c['locale switch'];
  let localeSwitch = null;
  if (switchSpec) {
    const parsed = parseSwitch(switchSpec);
    for (const message of parsed.problems) problem('Locale switch', message);
    localeSwitch = { mode: parsed.mode, name: parsed.name, tokens: parsed.tokens, path: c['locale switch path'] ?? null };
    if (locales.length > 1) {
      for (const locale of locales.filter((l) => !(l in parsed.tokens))) problem('Locale switch', `Locale switch: has no token for '${locale}'.`, { locale });
    }
    for (const locale of Object.keys(parsed.tokens).filter((l) => !locales.includes(l))) warnings.push(`Locale switch: has a token for '${locale}', which is not a screenshot locale.`);
    if (parsed.mode === 'ui' && !localeSwitch.path) problem('Locale switch path', "Locale switch: `ui` needs `Locale switch path:`, the way to the app's language picker.");
  } else if (locales.length > 1) {
    problem('Locale switch', 'No Locale switch: declared: how the app changes its UI language is unknown.');
  }

  const envPrefix = parsePairs(c['locale env prefix']);
  for (const locale of Object.keys(envPrefix).filter((l) => !locales.includes(l))) warnings.push(`Locale env prefix: names '${locale}', which is not a screenshot locale.`);

  let pairs = [];
  try {
    pairs = requirePairs(s);
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    problem('content roots', e.message);
  }
  const roots = {};
  if (i18n) {
    for (const pair of pairs) {
      roots[pair.id] = {};
      for (const locale of locales.filter((l) => i18n.locales.includes(l))) {
        try {
          roots[pair.id][locale] = localeRootOf(pair, locale, i18n.defaultLocale);
        } catch (e) {
          if (!(e instanceof CliError)) throw e;
          problem('EN i18n root', e.message, { locale });
        }
      }
    }
  }

  const requested = values.locales ? list(values.locales) : null;
  for (const locale of (requested ?? []).filter((l) => !locales.includes(l))) {
    problem('request', `'${locale}' is not a declared screenshot locale (declared: ${locales.join(', ')}).`, { locale });
  }

  return {
    ...base,
    multilocale: true,
    defaultLocale: i18n?.defaultLocale ?? null,
    locales,
    requested,
    localeSwitch,
    envPrefix,
    pairs,
    roots,
    problems,
    warnings,
  };
}

// The config as printed by `config`.
export function configView(cfg) {
  if (!cfg.multilocale) {
    return {
      multilocale: false,
      message: "No 'Screenshot locales:' declared: capture once, into the .assets/ folder the consuming skill names (screenshot-capture.md). No manifest, no staging.",
    };
  }
  return {
    multilocale: true,
    defaultLocale: cfg.defaultLocale,
    locales: cfg.locales,
    requested: cfg.requested,
    switch: cfg.localeSwitch,
    envPrefix: cfg.envPrefix,
    roots: cfg.roots,
    staging: cfg.stagingRoot,
    warnings: cfg.warnings,
  };
}

export function requireMultilocale(cfg) {
  if (!cfg.multilocale) {
    throw new CliError(`${configView(cfg).message} This command needs a declared 'Screenshot locales:'.`, { code: 2, data: { multilocale: false } });
  }
  if (cfg.problems.length) {
    throw new CliError(`The screenshot locales can't be resolved: ${cfg.problems.map((p) => p.message).join(' ')}`, { code: 2, data: { problems: cfg.problems } });
  }
}
