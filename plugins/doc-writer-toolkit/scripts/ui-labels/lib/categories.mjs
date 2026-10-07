import path from 'node:path';

// Sidebar category labels in `sync`. A category's state file is `<dir>/_category_` (it binds the UA label to an app string
// like a page binds a bold span). The label lives in two places:
//   UA:      <UA root>/<dir>/_category_.json                  { "label": "…", "key"?: "…", … }
//   locales: <locale root>.json  (current.json, written by write-translations)
//            sidebar.<sidebarId>.category.<key>               { "message": "…", "description": "…" }
// where <key> is the category's `key`, or its label when it has none. A category without a `key` therefore also needs its
// current.json entry keys renamed when the UA label changes, or Docusaurus no longer finds the translation.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isCategoryId = (rel) => /(^|\/)_category_$/.test(rel);

// UA: the category file. Every other locale: `<locale root>.json`.
export const categoryFile = (localeRoots, locale, rel) => (locale === 'uk' ? path.join(localeRoots.uk, `${rel}.json`) : `${localeRoots[locale]}.json`);

const parse = (text) => {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};

const format = (text, data) => JSON.stringify(data, null, text.match(/^([ \t]+)"/m)?.[1] ?? '  ') + (text.endsWith('\n') ? '\n' : '');

function locate(text, needle) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  return { line: i + 1, text: i >= 0 ? lines[i].trim().slice(0, 240) : '' };
}

// What the UA file says before any patch: its explicit key and its label.
export function categoryContext(ukText, ukChange) {
  const data = parse(ukText);
  if (!data) return null;
  return { explicitKey: typeof data.key === 'string' && data.key ? data.key : null, label: data.label, ukOld: ukChange?.old, ukNew: ukChange?.new };
}

// The `current.json` keys that carry this category's label (any sidebar), under every key the category may have had.
function labelKeys(data, ctx) {
  const keys = ctx.explicitKey ? [ctx.explicitKey] : [...new Set([ctx.label, ctx.ukOld, ctx.ukNew].filter(Boolean))];
  const re = new RegExp(`^sidebar\\..+\\.category\\.(?:${keys.map(esc).join('|')})$`);
  return Object.keys(data).filter((k) => re.test(k));
}

// Does this category file currently show `old` as its label in this locale? (sibling-binding check)
export function categoryShows(text, locale, old, ctx) {
  const data = parse(text);
  if (!data) return [];
  if (locale === 'uk') return data.label === old ? [locate(text, JSON.stringify(old))] : [];
  return labelKeys(data, ctx).filter((k) => data[k]?.message === old).map(() => locate(text, JSON.stringify(old)));
}

// Patches one bound label in one locale's file. Returns { text, hits, current, renamed, error? }:
//   hits     the label strings that were replaced      current  the file already has the new string
//   renamed  current.json entry keys that were renamed (a category without `key`)
export function patchCategory(text, locale, v, ctx) {
  const data = parse(text);
  if (!data) return { error: 'the file is not a JSON object' };
  if (format(text, data) !== text) {
    return { error: 'the file is not laid out the way JSON.stringify writes it, so it cannot be patched without reformatting it: patch the label by hand' };
  }
  const hits = [];
  const renamed = [];
  let current = false;

  if (locale === 'uk') {
    if (data.label === v.old) data.label = v.new;
    else return { text, hits, renamed, current: data.label === v.new };
    const out = format(text, data);
    return { text: out, hits: [locate(out, JSON.stringify(v.new))], renamed, current };
  }

  const keys = labelKeys(data, ctx);
  if (!keys.length) return { text, hits, renamed, current, error: 'there is no entry for this category (run write-translations)' };
  for (const k of keys) {
    const message = data[k]?.message;
    if (message === v.old) data[k] = { ...data[k], message: v.new };
    // An entry that was never translated still carries the UA text: it keeps following UA.
    else if (ctx.ukOld !== undefined && ctx.ukNew !== undefined && message === ctx.ukOld) data[k] = { ...data[k], message: ctx.ukNew };
    else {
      if (message === v.new || message === ctx.ukNew) current = true;
      continue;
    }
    hits.push({ k, untranslated: message !== v.old });
  }

  let result = data;
  if (ctx.renameKeys !== false && !ctx.explicitKey && ctx.ukOld && ctx.ukNew && ctx.ukOld !== ctx.ukNew) {
    const re = new RegExp(`^(sidebar\\..+\\.category\\.)${esc(ctx.ukOld)}((?:\\.link\\.generated-index\\.(?:title|description))?)$`);
    result = {};
    for (const [k, val] of Object.entries(data)) {
      const m = k.match(re);
      const next = m ? `${m[1]}${ctx.ukNew}${m[2]}` : k;
      if (m && next in data) return { text, hits: [], renamed: [], current, error: `cannot rename the entry '${k}': '${next}' already exists` };
      if (m) renamed.push({ from: k, to: next });
      result[next] = val;
    }
  }
  if (!hits.length && !renamed.length) return { text, hits, renamed, current };
  const out = format(text, result);
  return {
    text: out,
    // An untranslated entry changed from the old UA text to the new one: say so, not the locale's own strings.
    hits: hits.map((h) => (h.untranslated ? { ...locate(out, JSON.stringify(ctx.ukNew)), untranslated: true, old: ctx.ukOld, new: ctx.ukNew } : locate(out, JSON.stringify(v.new)))),
    renamed,
    current,
  };
}
