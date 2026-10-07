import path from 'node:path';
import { CliError, readJson, writeFileAtomic } from '../../ui-labels/lib/util.mjs';
import { loadStore, mergedLabels } from '../../ui-labels/lib/store.mjs';
import { abs, readIfExists, readState } from './pages.mjs';
import { cachedBlob } from './plan.mjs';
import { localeRoot } from './settings.mjs';
import { CYRILLIC, uaOnlyLetters } from './letters.mjs';
import { acceptedLabels } from './labels.mjs';

// Sidebar category labels. Docusaurus reads `_category_.json` from the UA content root only. A locale's text for it lives
// in that locale's `current.json` (written by `write-translations`), as up to three entries per category:
//   sidebar.<sidebarId>.category.<key>                                 the label
//   sidebar.<sidebarId>.category.<key>.link.generated-index.title      the generated index title
//   sidebar.<sidebarId>.category.<key>.link.generated-index.description
// where <key> is the category's `key`, or its `label` when it has none. A category is always translated whole.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `<locale root>.json`: i18n/tr/docusaurus-plugin-content-docs/current -> .../current.json
export const categoryFile = (s, locale) => `${localeRoot(s, locale)}.json`;

export function parseCategory(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: e.message, fields: [] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'not a JSON object', fields: [] };
  const fields = [];
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  if (str(data.label)) fields.push({ field: 'label', suffix: '', ua: data.label });
  if (data.link?.type === 'generated-index') {
    if (str(data.link.title)) fields.push({ field: 'link.title', suffix: '.link.generated-index.title', ua: data.link.title });
    if (str(data.link.description)) fields.push({ field: 'link.description', suffix: '.link.generated-index.description', ua: data.link.description });
  }
  return { key: str(data.key) ?? str(data.label), fields };
}

// The category's entries in a locale's current.json. `exists` means every entry is there; `handMade` that at least one
// message already differs from the UA text (someone translated it without this process).
export async function readCategoryTarget(s, locale, parsed) {
  const file = categoryFile(s, locale);
  const raw = await readIfExists(abs(s, file));
  let data = null;
  let error = null;
  if (raw !== null) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      error = e.message;
    }
  }
  const entries = [];
  const missing = [];
  for (const f of parsed.fields) {
    const re = new RegExp(`^sidebar\\.(.+)\\.category\\.${esc(parsed.key)}${esc(f.suffix)}$`);
    const keys = data ? Object.keys(data).filter((k) => re.test(k)) : [];
    if (!keys.length) missing.push(f.field);
    for (const entryKey of keys) entries.push({ ...f, entryKey, message: data[entryKey]?.message ?? null });
  }
  return { file, raw, data, error, entries, missing, exists: data !== null && !missing.length && parsed.fields.length > 0, handMade: entries.some((e) => e.message !== e.ua) };
}

async function readCandidate(candidate) {
  const map = await readJson(path.resolve(candidate));
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some((v) => typeof v !== 'string')) {
    throw new CliError(`${candidate} must be a JSON object { "<current.json entry key>": "<translated message>" } for this category.`, { code: 2 });
  }
  return map;
}

// Check one category in one locale. `candidate` is a { entryKey: message } file judged as if it were applied.
export async function checkCategoryUnit(s, unit, locale, { candidate = null, unverified = [], store } = {}) {
  const parsed = parseCategory(await cachedBlob(s.root, unit.blob));
  const target = await readCategoryTarget(s, locale, parsed);
  const state = await readState(s, unit.id);
  const st = store === undefined ? await loadStore(s.labelsDir) : store;
  const labels = st ? mergedLabels(st).labels : null;
  const overrides = candidate ? await readCandidate(candidate) : {};
  const failures = [];
  const fail = (check, message, detail = {}) => failures.push({ check, message, ...detail });
  const known = unverified.concat(state.locales[locale]?.unverified ?? []).map((u) => (typeof u === 'string' ? u : u.span));

  if (parsed.error) fail('category', `The UA category file is not valid: ${parsed.error}.`);
  else if (target.error) fail('target-missing', `${target.file} is not valid JSON: ${target.error}.`);
  else if (target.data === null) fail('target-missing', `${target.file} does not exist. Run \`write-translations --locale ${locale}\` first.`);
  else if (target.missing.length) fail('target-missing', `${target.file} has no entry for: ${target.missing.join(', ')}. Run \`write-translations --locale ${locale}\` first.`);

  const messages = new Map();
  for (const e of target.entries) messages.set(e.entryKey, overrides[e.entryKey] ?? e.message);
  const unknownKeys = Object.keys(overrides).filter((k) => !target.entries.some((e) => e.entryKey === k));
  if (unknownKeys.length) fail('category', 'The candidate has keys that are not entries of this category.', { unknown: unknownKeys });

  for (const e of target.entries) {
    const msg = messages.get(e.entryKey);
    const where = { entry: e.entryKey, field: e.field };
    if (typeof msg !== 'string' || !msg.trim()) {
      fail('category', `The message of '${e.field}' is empty.`, where);
      continue;
    }
    if (CYRILLIC.test(e.ua) && msg === e.ua) fail('category', `The ${e.field} is not translated.`, { ...where, message: msg });
    const letters = uaOnlyLetters(msg, locale);
    if (letters) fail('ukrainian-letters', `Letters that exist only in Ukrainian remain in the ${e.field}.`, { ...where, letters, message: msg });

    // Label store first: a category label that is bound to an app string uses the app's string for this locale.
    const decision = e.field === 'label' ? state.spans[e.ua] : undefined;
    if (typeof decision === 'string' && decision.startsWith('label:')) {
      const expected = labels?.[locale]?.[decision.slice(6)];
      if (!labels) fail('labels', 'No label store: run ui-labels import.', { ...where, key: decision.slice(6) });
      else if (expected === undefined) {
        if (!known.includes(e.ua)) fail('labels', `The label store has no '${locale}' string for this key, so the label must be recorded as unverified.`, { ...where, key: decision.slice(6) });
      } else if (!acceptedLabels(e.ua, labels.uk?.[decision.slice(6)], expected).includes(msg)) fail('labels', 'The category label is not the app string for this locale.', { ...where, expected, message: msg });
    }
  }

  const checks = [...new Set(failures.map((f) => f.check))];
  return { ok: !failures.length, failures, warnings: [], checks, page: unit.id, locale, file: target.file, state, store: st, labels, category: { parsed, target, messages, overrides } };
}

// Writes the candidate's messages into current.json. Everything else in the file (other entries, descriptions) stays.
export async function applyCategoryMessages(s, category) {
  const { target, overrides } = category;
  const data = structuredClone(target.data);
  let changed = false;
  for (const [key, message] of Object.entries(overrides)) {
    if (data[key]?.message !== message) {
      data[key] = { ...data[key], message };
      changed = true;
    }
  }
  if (changed) await writeFileAtomic(abs(s, target.file), JSON.stringify(data, null, 2) + (target.raw.endsWith('\n') ? '\n' : ''));
  return changed;
}
