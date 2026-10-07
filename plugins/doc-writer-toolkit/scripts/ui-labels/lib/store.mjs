import path from 'node:path';
import { readJson, CliError } from './util.mjs';

export const PENDING_DIFF = '.pending-diff.json';
export const isLib = (key) => key.startsWith('lib.');

// Reads <dir>/meta.json, <dir>/<locale>.json for each locale in meta, and <dir>/overlay.json.
export async function loadStore(dir) {
  const meta = await readJson(path.join(dir, 'meta.json'));
  if (!meta) return null;
  const labels = {};
  for (const locale of meta.locales) {
    const data = await readJson(path.join(dir, `${locale}.json`));
    if (!data) throw new CliError(`${dir}/${locale}.json is missing although meta.json lists it. Re-run import.`);
    labels[locale] = data;
  }
  const overlay = (await readJson(path.join(dir, 'overlay.json'))) ?? { tickets: [], branches: {} };
  return { meta, labels, overlay };
}

// Base labels with the ticket overlay on top (overlay wins). `origin[key]` names the overlay branch a key came from.
export function mergedLabels(store) {
  const merged = Object.fromEntries(Object.entries(store.labels).map(([l, m]) => [l, { ...m }]));
  const origin = {};
  for (const branch of Object.keys(store.overlay.branches).sort()) {
    for (const [key, values] of Object.entries(store.overlay.branches[branch].keys)) {
      for (const [locale, text] of Object.entries(values)) {
        (merged[locale] ??= {})[key] = text;
      }
      origin[key] = branch;
    }
  }
  return { labels: merged, origin };
}
