export const CYRILLIC = /\p{Script=Cyrillic}/u;

// Letters that exist in Ukrainian but not in the target language: any of them left in a translation is untranslated text.
export const UA_ONLY = { all: /[єїґЄЇҐ]/g, ru: /[іІ]/g, ky: /[іІ]/g, tg: /[іІ]/g };

// The Ukrainian language's own name, as language pickers show it, legitimately keeps its Ukrainian letters.
const ENDONYM = /Українськ[а-яіїєґ]*/g;

// The Ukrainian-only letters left in `text` for this locale ('' when none).
export function uaOnlyLetters(text, locale) {
  const pattern = new RegExp(`${UA_ONLY.all.source}${UA_ONLY[locale] ? `|${UA_ONLY[locale].source}` : ''}`, 'g');
  const m = text.replace(ENDONYM, '').match(pattern);
  return m ? [...new Set(m)].join('') : '';
}
