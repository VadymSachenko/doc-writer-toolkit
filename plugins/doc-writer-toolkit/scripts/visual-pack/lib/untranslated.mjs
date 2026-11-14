// Text left untranslated, decided from the blocks of a page and the same page in the default locale. No model.
//
// A block is { text, plain, strong }: the block's whole text; its text outside bold, bold-italic and code spans; and the
// text inside bold spans. The signals, strongest first:
//
//   identical          the block is word for word the default locale's block. The signal that works for every script:
//                      Kazakh shares letters with Ukrainian and Uzbek, Turkish, Azerbaijani, Spanish and English are
//                      Latin, so letters alone prove nothing there.
//   cyrillic-in-latin  a Cyrillic block in a locale that writes Latin.
//   ukrainian-letters  ї, є or ґ in a Cyrillic locale that is not Ukrainian. Never і: Kazakh has it.
//
// A bold label that stays as the app shows it (the app's string wins over a translation of it) is not a problem. It is a
// `label` to look at, for the owner to confirm against the app.

const LATIN = new Set(['en', 'es', 'tr', 'uz', 'az', 'de', 'fr', 'it', 'pt', 'pl', 'ro', 'nl', 'cs', 'sk', 'hu', 'id', 'vi']);
const CYRILLIC = new Set(['uk', 'ru', 'kk', 'ky', 'tg', 'be', 'bg', 'sr', 'mk', 'mn']);

export const languageOf = (locale) => String(locale).split(/[-_]/)[0].toLowerCase();

// 'latin', 'cyrillic' or null when the locale's script is not known (then only `identical` applies).
export function scriptOf(locale) {
  const lang = languageOf(locale);
  if (LATIN.has(lang)) return 'latin';
  if (CYRILLIC.has(lang)) return 'cyrillic';
  return null;
}

const CYR = /[Ѐ-ӿ]/g;
const LAT = /[A-Za-zÀ-ɏ]/g;
const UA_ONLY = /[їєґЇЄҐ]/;
const WORD = /[\p{L}][\p{L}\p{M}'’-]*/gu;

export const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s.,:;!?()"'«»]+|[\s.,:;!?()"'«»]+$/g, '');
const count = (s, re) => (String(s ?? '').match(re) ?? []).length;
export const letters = (s) => count(s, /\p{L}/gu);
export const words = (s) => count(s, WORD);

// Share of the letters that are Cyrillic (0 when there are no letters).
export function cyrillicShare(s) {
  const total = letters(s);
  return total ? count(s, CYR) / total : 0;
}

// A block with at least three words and a dozen letters outside its bold and code spans: prose, not a label or a name.
export const isProse = (block) => words(block.plain) >= 3 && letters(block.plain) >= 12;

// A block that is mostly a bold span: the label of a control or a field.
export function isLabel(block) {
  const total = letters(block.text);
  return total > 0 && words(block.text) >= 2 && letters(block.strong) / total >= 0.5;
}

// The prose of a Latin-script source or of an unknown one is compared as it is. For a Cyrillic source, a block must be
// mostly Cyrillic to count as prose in it: a Latin sentence (a header, a path) legitimately stays the same everywhere.
function sourceProse(block, sourceScript) {
  if (!isProse(block)) return false;
  if (sourceScript === 'cyrillic') return cyrillicShare(block.plain) >= 0.5;
  if (sourceScript === 'latin') return cyrillicShare(block.plain) < 0.5;
  return true;
}

// -> { problems: [{ reason, text }], labels: [{ reason, text }], prose: <count of prose blocks in the source> }
export function checkBlocks({ sourceBlocks, targetBlocks, locale, sourceLocale }) {
  const sourceScript = scriptOf(sourceLocale);
  const targetScript = scriptOf(locale);
  const sourceText = new Set((sourceBlocks ?? []).map((b) => norm(b.text)));
  const sameLanguage = languageOf(locale) === languageOf(sourceLocale);
  const problems = [];
  const labels = [];
  const seen = new Set();
  for (const block of targetBlocks ?? []) {
    const key = norm(block.text);
    if (!key || seen.has(key) || sameLanguage) continue;
    seen.add(key);
    const identical = sourceText.has(key);
    if (identical && sourceProse(block, sourceScript)) {
      problems.push({ reason: 'identical', text: block.text });
    } else if (targetScript === 'latin' && words(block.plain) >= 2 && letters(block.plain) >= 6 && cyrillicShare(block.plain) >= 0.5) {
      problems.push({ reason: 'cyrillic-in-latin', text: block.text });
    } else if (targetScript === 'cyrillic' && languageOf(sourceLocale) === 'uk' && words(block.plain) >= 3 && UA_ONLY.test(block.plain)) {
      problems.push({ reason: 'ukrainian-letters', text: block.text });
    } else if (identical && isLabel(block)) {
      labels.push({ reason: 'identical-label', text: block.text });
    } else if (targetScript === 'latin' && isLabel(block) && cyrillicShare(block.strong) >= 0.5) {
      labels.push({ reason: 'cyrillic-label', text: block.text });
    }
  }
  const prose = (sourceBlocks ?? []).filter((b) => sourceProse(b, sourceScript)).length;
  return { problems, labels, prose };
}
