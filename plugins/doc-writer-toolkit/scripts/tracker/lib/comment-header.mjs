// The line every comment the pipeline posts starts with (the shared settings' `commentHeader`), then an empty line, then
// the message; with none set, no header. The tracker and forge modules put it in front of each comment they post, and
// each check that reads a comment by its first words reads it without the header, so a comment posted before the header
// existed is read the same way. The header is only the one the settings name: unset, a headered comment reads as is.

const ZWNJ = /‌/g;

// Whether `text` starts with the header, as a line of its own or followed by a space.
function leads(text, header) {
  const t = String(text ?? '').replace(ZWNJ, '').replace(/^\s+/, '');
  const h = String(header).trim();
  return t.startsWith(h) && (t.length === h.length || /\s/.test(t[h.length])) ? t : null;
}

// The text with the header in front, unless it already starts with it (a session that copied it gets it once).
export function withHeader(text, header) {
  if (!header || leads(text, header) !== null) return text;
  return `${header}\n\n${text}`;
}

// The text without a leading header and the space and empty lines after it; the text as given when it has none.
export function withoutHeader(text, header) {
  if (!header) return String(text ?? '');
  const t = leads(text, header);
  return t === null ? String(text ?? '') : t.slice(String(header).trim().length).replace(/^\s+/, '');
}
