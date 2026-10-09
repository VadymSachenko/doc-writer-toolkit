// Trailing punctuation a page may drop from a UI label as decoration: the app shows `Статус:`, the page `**Статус**`.
const TRAILING = /\s*[:.…!?]+$/u;

// The renderings of a bound label that pass the `labels` check: the store string for the locale, and, when the UA
// span drops the trailing punctuation of the UA store string, the locale's string without its own trailing punctuation.
export function acceptedLabels(span, uaString, expected) {
  const forms = [expected];
  if (typeof uaString === 'string' && TRAILING.test(uaString) && !TRAILING.test(span)) {
    const bare = expected.replace(TRAILING, '');
    if (bare && bare !== expected) forms.push(bare);
  }
  return forms;
}
