// Heading ids, per context/doc-rules/project-rules/heading-anchors.md: the `{/* #id */}` comment that ends a UA
// heading, the id Docusaurus gives the EN heading (its explicit `{#id}` or the slug of its text), and which of
// the two pages is the UA one.

const COMMENT = /\{\/\*([\s\S]*?)\*\/\}/g;
const MARKER = /^\s*(ToDo|NEEDS CONFIRMATION)\s*:/i;
const EXPLICIT_ID = /\s*\{#([^}\s]+)\}\s*$/;
export const ID_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CYRILLIC = /[Ѐ-ӿ]/g;

// Comments in a heading other than ToDo / NEEDS CONFIRMATION markers (those pair under Check 8 instead).
export function headingComments(raw) {
  return [...raw.matchAll(COMMENT)].filter((m) => !MARKER.test(m[1])).map((m) => ({ body: m[1], start: m.index, end: m.index + m[0].length }));
}

// The heading text with every comment and an explicit `{#id}` removed, for descriptions and slugs.
export function headingText(raw) {
  return raw.replace(COMMENT, '').replace(EXPLICIT_ID, '').replace(/\s+/g, ' ').trim();
}

// Reads the id comment of a UA heading. Returns { id, problem }: id is null when there is no comment or no
// `#`; problem is null when the comment is well formed, else a short reason.
export function uaHeadingId(raw) {
  const comments = headingComments(raw);
  if (!comments.length) return { id: null, problem: 'missing' };
  const c = comments.at(-1);
  const m = c.body.match(/^\s*#(.*?)\s*$/s);
  const id = m ? m[1].trim() : null;
  if (comments.length > 1) return { id, problem: `has ${comments.length} comments, one id comment expected` };
  if (raw.slice(c.end).trim() !== '') return { id, problem: 'the comment does not end the heading' };
  if (id === null) return { id, problem: 'the comment has no `#`' };
  if (!ID_FORM.test(id)) return { id, problem: `'${id}' is not lowercase ASCII kebab-case` };
  return { id, problem: null };
}

// Plain text of an EN heading the way Docusaurus sees it before slugging: link and image text kept,
// HTML tags dropped.
function plainText(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
}

// github-slugger, which Docusaurus uses: lower case, every character that is not a letter, mark, number,
// connector (`_`), space or hyphen removed, each space turned into a hyphen. Not trimmed further or collapsed.
export function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

// One slugger per page: a repeated slug gets `-1`, `-2`, … like Docusaurus gives it.
export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text);
    let id = base;
    while (seen.has(id)) {
      seen.set(base, seen.get(base) + 1);
      id = `${base}-${seen.get(base)}`;
    }
    seen.set(id, 0);
    return id;
  };
}

// The id of every EN heading, in order: { id, explicit }.
export function enHeadingIds(headings) {
  const slug = createSlugger();
  return headings.map((h) => {
    const withoutComments = h.raw.replace(COMMENT, '').trim();
    const ex = withoutComments.match(EXPLICIT_ID);
    if (ex) return { id: ex[1], explicit: true };
    return { id: slug(plainText(headingText(h.raw))), explicit: false };
  });
}

const cyrillicCount = (s) => (s.match(CYRILLIC) ?? []).length;

// Which page is UA: the one with more Cyrillic letters in its heading text, else in its whole text.
// Returns 'main', 'secondary' or null when the two can't be told apart.
export function detectUa(mainText, secondaryText, mainPage, secondaryPage) {
  const inHeadings = (p) => cyrillicCount(p.headings.map((h) => headingText(h.raw)).join(' '));
  for (const [a, b] of [
    [inHeadings(mainPage), inHeadings(secondaryPage)],
    [cyrillicCount(mainText), cyrillicCount(secondaryText)],
  ]) {
    if (a > b) return 'main';
    if (b > a) return 'secondary';
  }
  return null;
}
