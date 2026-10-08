import { parsePage, sections } from './parse.mjs';

// Scoped span decisions (`context/locale-translation.md`, §4). A page state's `spans` holds one decision per span text
// for the whole page. A key `<span>@<heading>` overrides it under one heading: that section and its subsections.
// `<heading>` is the heading's title as written, or its anchor (`#anchor`). The innermost matching heading wins.
// This is how one label text bound to different app keys on one page (a tab and a switch both reading «Отримання»)
// gets the right string in each place.

const headingsOf = (sec) => {
  const out = [];
  for (let n = sec; n && n.level; n = n.parent) out.unshift({ title: n.title, anchor: n.anchor });
  return out;
};
const scopesOf = (h) => [h.title, ...(h.anchor ? [`#${h.anchor}`] : [])];

// The section structure of a page: `list` is [root, …sections in document order], `at[i]` the index in `list` of the
// innermost section that line i belongs to, `paths[k]` the heading path ({ title, anchor } from the top) of list[k].
export function sectionMap(text) {
  const page = parsePage(text);
  const list = [page.root, ...sections(page.root)];
  const at = new Array(page.lines.length).fill(0);
  list.forEach((sec, k) => {
    if (!k) return;
    for (let i = sec.start; i <= sec.end && i < at.length; i++) at[i] = k;
  });
  return { page, list, at, paths: list.map((sec, k) => (k ? headingsOf(sec) : [])) };
}

// Every title and `#anchor` of the page's headings: the scopes a key may name.
export const pageScopes = (map) => new Set(map.paths.flatMap((p) => p.flatMap(scopesOf)));

// `<span>@<heading>` → { span, scope } when <heading> names a heading of the page; otherwise null (a page-level key,
// which may contain `@` itself, such as an e-mail address in bold).
export function parseScopedKey(key, scopes) {
  for (let at = key.indexOf('@'); at > 0; at = key.indexOf('@', at + 1)) {
    const scope = key.slice(at + 1);
    if (scopes.has(scope)) return { span: key.slice(0, at), scope };
  }
  return null;
}

export const hasScopedKeys = (spans, scopes) => Object.keys(spans).some((k) => parseScopedKey(k, scopes));

// The decision for one occurrence of `span` under the heading path `path`: { decision, key, scope }. `key` is the state
// key that holds it; `decision` is null when neither a scoped nor the page-level key exists.
export function decisionAt(spans, span, path) {
  for (let i = path.length - 1; i >= 0; i--) {
    for (const scope of scopesOf(path[i])) {
      const key = `${span}@${scope}`;
      if (spans[key]) return { decision: spans[key], key, scope };
    }
  }
  return spans[span] ? { decision: spans[span], key: span, scope: null } : { decision: null, key: span, scope: null };
}

// The heading path of a change from `blocks` (its `headingPath` and `anchorPath`).
export const changePath = (c) => (c.headingPath ?? []).map((title, i) => ({ title, anchor: c.anchorPath?.[i] ?? null }));
