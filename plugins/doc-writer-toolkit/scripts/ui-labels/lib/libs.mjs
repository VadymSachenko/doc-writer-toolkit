import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, flatten, log } from './util.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// UI libraries whose per-locale strings are imported under `lib.<name>.*`.
// `localeFiles` returns the library's locale ids ('tr_TR') for a version.
const LIBRARIES = {
  antd: { localeDir: 'locale', module: (cacheDir, id) => path.join(cacheDir, 'node_modules', 'antd', 'locale', `${id}.js`) },
};

const DEFAULT_REGION = { en: 'en_US' };

const cacheRoot = () => process.env.DOC_TOOLKIT_CACHE || path.join(os.homedir(), '.cache', 'doc-writer-toolkit', 'ui-libs');

// The frontend's package.json decides which libraries and versions apply.
export function detectLibraries(packageJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return {};
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  const found = {};
  for (const name of Object.keys(LIBRARIES)) {
    const version = deps[name]?.match(/\d+\.\d+\.\d+/)?.[0];
    if (version) found[name] = version;
  }
  return found;
}

async function install(name, version) {
  const dir = path.join(cacheRoot(), `${name}-${version}`);
  if (await exists(path.join(dir, 'node_modules', name))) return dir;
  log(`Installing ${name}@${version} into ${dir} (one-time, to read its locale strings)...`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"ui-lib-cache","private":true}\n');
  await run('npm', ['install', `${name}@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--omit=peer', '--loglevel=error'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  return dir;
}

// Picks the library locale id for a docs locale: the region of the app's own locale file if the library has it
// (es-AR.json -> es_AR), else the only candidate, else <lang>_<LANG> (es_ES), else a fixed default (en_US).
// Null when the library has none.
function pickLibraryLocale(available, docsLocale, appFileName) {
  const lang = docsLocale.split(/[-_]/)[0].toLowerCase();
  const candidates = available.filter((id) => id.split('_')[0].toLowerCase() === lang);
  if (!candidates.length) return null;
  const region = appFileName?.replace(/\.json$/i, '').split(/[-_]/)[1];
  const regional = region && candidates.find((id) => id.toLowerCase() === `${lang}_${region.toLowerCase()}`);
  if (regional) return regional;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((id) => id.toLowerCase() === `${lang}_${lang}` || id === DEFAULT_REGION[lang]) ?? null;
}

// Returns { strings: { locale: { 'lib.antd.…': string } }, info: { version, localeMap, missingLocales } }.
export async function importLibrary(name, version, locales, appFiles) {
  const lib = LIBRARIES[name];
  const cacheDir = await install(name, version);
  const localeDir = path.join(cacheDir, 'node_modules', name, lib.localeDir);
  const available = (await fs.readdir(localeDir)).filter((f) => /^[a-z]+_[A-Z]+\.js$/.test(f)).map((f) => f.replace(/\.js$/, ''));
  const strings = {};
  const localeMap = {};
  const missingLocales = [];
  for (const locale of locales) {
    const id = pickLibraryLocale(available, locale, appFiles[locale]);
    if (!id) {
      missingLocales.push(locale);
      continue;
    }
    const mod = require(lib.module(cacheDir, id));
    const data = mod.default ?? mod;
    const { locale: _id, ...rest } = data;
    strings[locale] = flatten(rest, `lib.${name}`);
    localeMap[locale] = id;
  }
  return { strings, info: { version, localeMap, missingLocales } };
}
