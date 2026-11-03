import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSettings, readDocusaurusI18n, requirePairs, selectPairs } from '../../ui-labels/lib/config.mjs';
import { CliError, exists, unique } from '../../ui-labels/lib/util.mjs';

const num = (flag, value, fallback, { min = 1 } = {}) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new CliError(`--${flag} must be a whole number of at least ${min}, got '${value}'.`, { code: 2 });
  return n;
};

// The viewport is "<width>x<height>".
export function parseViewport(spec = '1280x800') {
  const m = String(spec).match(/^(\d{3,5})x(\d{3,5})$/);
  if (!m) throw new CliError(`--viewport must be <width>x<height>, such as 1280x800, got '${spec}'.`, { code: 2 });
  return { width: Number(m[1]), height: Number(m[2]) };
}

// '/docs' -> '/docs/', '' -> '/'
export function normalizeBaseUrl(value) {
  let v = String(value ?? '/').trim();
  if (!v.startsWith('/')) v = `/${v}`;
  return v.endsWith('/') ? v : `${v}/`;
}

const CONFIG_FILES = ['docusaurus.config.ts', 'docusaurus.config.js', 'docusaurus.config.mjs', 'docusaurus.config.cjs'];

// `baseUrl: '/x/'` as a string literal in the Docusaurus config; null when it is not one.
export async function readBaseUrl(settings) {
  const candidates = settings.docusaurusConfig ? [path.resolve(settings.root, settings.docusaurusConfig)] : CONFIG_FILES.map((f) => path.join(settings.root, f));
  for (const file of candidates) {
    if (!(await exists(file))) continue;
    const m = (await fs.readFile(file, 'utf8')).match(/\bbaseUrl\s*:\s*['"]([^'"]*)['"]/);
    return m ? m[1] : null;
  }
  return null;
}

// The columns of the sheet. The default locale is always one: it is the reference the other locales are compared with.
// `--locales` names the columns; otherwise they are every locale docusaurus.config lists. Without a docusaurus.config,
// `--locales` is required and its first locale is the default one.
export async function resolveColumns(settings) {
  let cfg = null;
  try {
    cfg = await readDocusaurusI18n(settings);
  } catch (e) {
    if (!settings.explicitLocales) throw e;
  }
  const defaultLocale = cfg?.defaultLocale ?? settings.explicitLocales[0];
  const known = unique([defaultLocale, ...(cfg?.locales ?? []), ...(settings.explicitLocales ?? [])]);
  const columns = unique([defaultLocale, ...(settings.explicitLocales ?? cfg.locales)]);
  return { defaultLocale, columns, known };
}

export async function loadPackSettings(values, env = process.env) {
  if (!values.range) {
    throw new CliError('--range <git range> is required: the commits whose pages to show, such as origin/main...HEAD.', { code: 2, data: { missing: ['--range'] } });
  }
  if (values.range.startsWith('-')) throw new CliError(`--range '${values.range}' is not a git range.`, { code: 2 });
  const settings = await loadSettings(values);
  const pairs = selectPairs(requirePairs(settings), values.pair);
  const { defaultLocale, columns, known } = await resolveColumns(settings);
  const baseUrl = normalizeBaseUrl(values['base-url'] ?? settings.claude['site base url'] ?? (await readBaseUrl(settings)) ?? '/');
  return {
    ...settings,
    pairs,
    defaultLocale,
    columns,
    knownLocales: known,
    baseUrl,
    range: values.range,
    buildDir: values['build-dir'] ? path.resolve(settings.root, values['build-dir']) : null,
    outDir: path.resolve(settings.root, values.out ?? path.join(settings.stateRoot, 'visual-pack')),
    viewport: parseViewport(values.viewport),
    maxHeight: num('max-height', values['max-height'], 8000, { min: 500 }),
    jobs: num('jobs', values.jobs, 4),
    timeoutMs: num('timeout', values.timeout, 30000, { min: 1000 }),
    playwrightFrom: path.resolve(values['playwright-from'] ?? env.VISUAL_PACK_PLAYWRIGHT_FROM ?? settings.root),
    dryRun: Boolean(values['dry-run']),
    json: Boolean(values.json),
  };
}
