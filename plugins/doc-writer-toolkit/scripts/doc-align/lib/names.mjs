// Names of organizations (Ж10 in formatting-conventions.md): reads the names table of a product kit glossary
// and finds each row's name in the prose of a page. An occurrence is a run of one or more words whose loose key
// (lower case, Cyrillic transliterated, letters and digits only) equals the key of the row's UA or EN form. It is
// exact when it is the form for the page's language, character for character (a Cyrillic UA form may carry a
// case ending); any other spelling is a variant. Bold spans (UI labels, Ж1), inline code (code values, Ж4),
// comments, link targets, URLs and HTML tags are not prose here and are never searched.

// The names table: the first table under `## Names` or `## Назви`. Columns: UA form, EN form, UI forms, API
// values, Source (glossary-format.md, "Names"). Only the first two, the organization's own forms, are compared
// with prose; a three-column table (UA form, EN form, Source) reads the same.
const NAMES_HEADING = /^##\s+(names|назви)\s*$/i;

function cells(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim());
}

// A form cell as plain text: surrounding backticks, bold or quotes removed.
const plainForm = (c) => c.replace(/^\*\*(.*)\*\*$/, '$1').replace(/^`(.*)`$/, '$1').replace(/^[«"](.*)[»"]$/, '$1').trim();

// Returns { found: boolean, rows: [{ ua, en, source, line }] }. `found` is false when the file has no names table.
export function parseNamesTable(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => NAMES_HEADING.test(l.trim()));
  if (start < 0) return { found: false, rows: [] };
  let i = start + 1;
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) {
    if (/^#{1,2}\s/.test(lines[i])) return { found: false, rows: [] }; // the next section began before any table
    i++;
  }
  if (i + 1 >= lines.length || !/^\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1].trim())) return { found: false, rows: [] };
  const rows = [];
  for (let j = i + 2; j < lines.length && lines[j].trimStart().startsWith('|'); j++) {
    const c = cells(lines[j]);
    const [ua = '', en = ''] = c;
    const row = { ua: plainForm(ua), en: plainForm(en), source: c.length > 2 ? c.at(-1) : '', line: j + 1 };
    if (c.length >= 5) Object.assign(row, { ui: c[2], api: c[3] });
    if (row.ua || row.en) rows.push(row);
  }
  return { found: true, rows };
}

// Merges the rows of several tables (the same table in glossary-ua.md and glossary-en.md), one row per UA/EN pair.
export function mergeRows(tables) {
  const seen = new Map();
  for (const t of tables) for (const r of t.rows) if (!seen.has(`${r.ua}\u0000${r.en}`)) seen.set(`${r.ua}\u0000${r.en}`, r);
  return [...seen.values()];
}

// Loose key. The transliteration only serves matching: forms that sound alike get the same key, so «Сонобанк»,
// «Соно банк» and "Sonobank" are one name. i/y, g/h, w/v and kh/h are folded on both sides.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ь: '', ю: 'iu', я: 'ia', ъ: '', ы: 'i', э: 'e', ё: 'e',
};
export function looseKey(s) {
  return [...s.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]/g, '')
    .replace(/shch/g, 'sch')
    .replace(/kh/g, 'h')
    .replace(/y/g, 'i')
    .replace(/g/g, 'h')
    .replace(/w/g, 'v');
}

// Case endings a Cyrillic UA form may take on a page (Лунобанк → Лунобанку, Лунобанком).
const ENDINGS = ['а', 'я', 'у', 'ю', 'ом', 'ем', 'єм', 'і', 'ї', 'ові', 'еві', 'єві', 'и', 'ам', 'ям', 'ами', 'ями', 'ах', 'ях'];
const CYRILLIC_END = /[\u0400-\u04FF]$/;
const POSSESSIVE = /['’]s$/;

const WORD = /[\p{L}\p{N}]+(?:['’ʼ-][\p{L}\p{N}]+)*/gu;
const wordsOf = (s) => [...s.matchAll(WORD)].map((m) => m[0]);

// The text a name can stand in: the prose lines of a parsed page with bold spans, comments, link targets, URLs,
// HTML tags and import lines blanked (same line count and lengths, so offsets stay line numbers).
const blank = (s) => s.replace(/[^\n]/g, ' ');
export function searchable(proseLines) {
  return proseLines
    .map((l) => (/^\s*(import|export)\s/.test(l) ? '' : l))
    .join('\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\*\*[^*\n]+?\*\*/g, blank)
    .replace(/\]\([^)\n]*\)/g, (m) => `]${blank(m.slice(1))}`)
    .replace(/https?:\/\/[^\s)>\]]+/g, blank)
    .replace(/<\/?[A-Za-z][^>\n]*>/g, blank);
}

function prepare(rows) {
  return rows.map((row, index) => {
    const forms = [row.ua, row.en].filter(Boolean);
    const capsOnly = forms.every((f) => /\p{Lu}.*\p{Lu}/u.test(f) && f === f.toUpperCase());
    const lower = new Set(forms.filter((f) => wordsOf(f).length === 1).map((f) => f.toLowerCase()));
    const lowerForm = forms.some((f) => f === f.toLowerCase());
    return { row, index, capsOnly, lower, lowerForm, keys: new Set(forms.map(looseKey).filter(Boolean)), sizes: forms.map((f) => wordsOf(f).length) };
  });
}

// True when the word at `offset` opens a line, a list item, a sentence or a table cell.
function startsSentence(text, offset) {
  const before = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
  return /^\s*(?:(?:[-*+]|\d+[.)])\s+)?$/.test(before) || /[.!?:]\s+$/.test(before) || /\|\s*$/.test(before);
}

// True when `text` is `form` for a page in `lang` ('ua' | 'en'): the same characters, or, on a UA page, a Cyrillic
// form followed by a case ending, and on an EN page, the form with a possessive.
export function isExact(text, form, lang) {
  if (!form) return false;
  if (text === form) return true;
  if (lang === 'en' && POSSESSIVE.test(text) && text.replace(POSSESSIVE, '') === form) return true;
  return lang === 'ua' && CYRILLIC_END.test(form) && text.startsWith(form) && ENDINGS.includes(text.slice(form.length));
}

// Keys of a run of words: its own key, the key without an English possessive, and on a Cyrillic last word, the
// key without each case ending.
function keysOf(text) {
  const keys = [looseKey(text)];
  if (POSSESSIVE.test(text)) keys.push(looseKey(text.replace(POSSESSIVE, '')));
  if (CYRILLIC_END.test(text)) for (const e of ENDINGS) if (text.endsWith(e) && text.length - e.length >= 3) keys.push(looseKey(text.slice(0, -e.length)));
  return keys;
}

// Finds the rows' names in `text`. Returns [{ index, text, line, exact }], where `index` is the row and `exact`
// says whether the occurrence is the row's form for `lang`. Longer runs win; each word belongs to one occurrence.
export function findNames(text, rows, lang) {
  const prepared = prepare(rows);
  if (!prepared.length) return [];
  const maxSize = Math.max(...prepared.flatMap((p) => p.sizes)) + 1;
  const words = [...text.matchAll(WORD)].map((m) => ({ s: m.index, e: m.index + m[0].length, w: m[0] }));
  const lineAt = (offset) => text.slice(0, offset).split('\n').length;
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let hit = null;
    for (let n = Math.min(maxSize, words.length - i); n >= 1 && !hit; n--) {
      const run = words.slice(i, i + n);
      // Only words separated by a space make one name.
      if (run.some((w, k) => k > 0 && !/^[ \u00a0]$/.test(text.slice(run[k - 1].e, w.s)))) continue;
      const str = text.slice(run[0].s, run.at(-1).e);
      const keys = keysOf(str);
      const p = prepared.find((x) => keys.some((k) => x.keys.has(k)));
      if (!p) continue;
      // A name written as more or fewer words than its form counts only when every word has at least three
      // letters, so "a pay slip" is never read as a spelling of "A-Pay".
      if (!p.sizes.includes(n) && run.some((w) => [...w.w].length < 3)) continue;
      // A name written in capitals only (TAP, KVB) counts only with two capitals or more, so the word "tap"
      // or "Tap" at the start of a sentence is never read as a spelling of it.
      if (p.capsOnly && !/\p{Lu}.*\p{Lu}/u.test(str)) continue;
      // A one-word name that differs from its form only in case may be an ordinary word: in lower case when no
      // form is, or at the start of a sentence, a list item or a table cell, it is not read as the name.
      if (n === 1 && p.lower.has(str.toLowerCase())) {
        const lowerWord = str === str.toLowerCase() && !p.lowerForm;
        if (lowerWord || startsSentence(text, run[0].s)) continue;
      }
      hit = { p, n, str };
    }
    if (!hit) continue;
    const form = lang === 'ua' ? hit.p.row.ua : hit.p.row.en;
    out.push({ index: hit.p.index, text: hit.str, line: lineAt(words[i].s), exact: isExact(hit.str, form, lang) });
    i += hit.n - 1;
  }
  return out;
}
