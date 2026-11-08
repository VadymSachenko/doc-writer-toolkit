import { CliError } from './errors.mjs';

// The numbered lists of edits the owner reads on a PR, and the owner's reply to them by number (context/ticket-flow.md,
// "The list of edits and the reply by number"). No AI: the lists are what the roles posted and recorded, and a reply is
// read by its numbers only; what an item's description asks is the writer's to apply.
//
// An item: `n` (fixed once posted), `list` (where it was posted: `description` for the PR description, else the id of
// the comment), `stage`, `page`, `block`, `before` and `after` (the exact UA text), and `en` ({ page, before, after })
// when its EN changed too. One PR numbers on: a later list starts after the last number, so a reply can't hit the
// wrong list. A number found in two lists (one posted by hand, or before the numbering went on) is asked back.

export const editsOf = (pr) => pr?.edits ?? [];
export const nextEditNumber = (pr) => editsOf(pr).reduce((m, e) => Math.max(m, Number(e.n) || 0), 0) + 1;

const text = (v) => typeof v === 'string';

// The items a record brings, checked and added to the PR. A malformed item is a usage error (the session fixes its
// `--result`, nothing is posted again); a number that collides with another list, or skips, is kept as posted, since
// the owner reads it so, and named in a warning: a reply on it is asked back, never guessed.
export function addEdits(pr, items, { list, stage, at, seq }) {
  const warnings = [];
  if (items === undefined || items === null) return warnings;
  if (!Array.isArray(items)) throw new CliError('edits must be a list of { "n", "page", "block", "before", "after", "en"? }', { code: 2 });
  pr.edits ??= [];
  let next = nextEditNumber(pr);
  for (const e of items) {
    const n = Number(e?.n);
    if (!Number.isInteger(n) || n < 1) throw new CliError(`edits: each item needs "n", a whole number from 1 (got ${JSON.stringify(e?.n)})`, { code: 2 });
    if (!text(e.page) || !e.page.trim() || !text(e.before) || !text(e.after)) throw new CliError(`edits: item ${n} needs "page" and the exact "before" and "after" texts`, { code: 2 });
    if (e.en !== undefined && e.en !== null && !(text(e.en.page) && text(e.en.before) && text(e.en.after))) throw new CliError(`edits: item ${n}'s "en" needs "page", "before" and "after"`, { code: 2 });
    const item = { n, list: String(list), stage, page: e.page, block: text(e.block) ? e.block : null, before: e.before, after: e.after, ...(e.en ? { en: { page: e.en.page, before: e.en.before, after: e.en.after } } : {}), at, seq };
    const same = pr.edits.findIndex((x) => x.n === n && x.list === item.list);
    if (same >= 0) {
      pr.edits[same] = item;
      continue;
    }
    const other = pr.edits.find((x) => x.n === n);
    if (other) warnings.push(`edit ${n} is also item ${n} of ${listName(other.list)}: a reply naming ${n} will be asked back`);
    else if (n !== next) warnings.push(`edit ${n} skips from ${next - 1}: the numbers of a PR go on from the last one`);
    pr.edits.push(item);
    next = Math.max(next, n + 1);
  }
  return warnings;
}

// The EN side the re-sync wrote for items already posted: `[{ n, en: { page, before, after } }]`, onto the latest
// item of that number.
export function addEnSides(pr, items) {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw new CliError('edits must be a list of { "n", "en": { "page", "before", "after" } }', { code: 2 });
  const warnings = [];
  for (const e of items) {
    const n = Number(e?.n);
    if (!(e?.en && text(e.en.page) && text(e.en.before) && text(e.en.after))) throw new CliError(`edits: item ${e?.n}'s "en" needs "page", "before" and "after"`, { code: 2 });
    const item = editsOf(pr).findLast((x) => x.n === n);
    if (!item) {
      warnings.push(`no edit ${e.n} on this PR: its EN side is not kept`);
      continue;
    }
    item.en = { page: e.en.page, before: e.en.before, after: e.en.after };
  }
  return warnings;
}

export const listName = (list) => (list === 'description' ? 'the PR description' : `comment ${list}`);

// ------------------------------------------------------------------ the reply

const QUOTES = { '«': ['»'], '“': ['”'], '„': ['“', '”'], '"': ['"'] };
const closeOf = (s, i) => {
  const ends = QUOTES[s[i]];
  if (!ends) return -1;
  const at = ends.map((c) => s.indexOf(c, i + 1)).filter((x) => x > i);
  return at.length ? Math.min(...at) : -1;
};

// The reply cut at `;` and line ends, never inside a quote: a quoted text may hold either.
function segments(s) {
  const out = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const end = closeOf(s, i);
    if (end > i) {
      i = end;
      continue;
    }
    if (s[i] === ';' || s[i] === '\n') {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

const ITEM = /^\s*(?:[-*•]\s*)?(?:(?:пункт|п\.|item|№|#)\s*)?(\d{1,4})(?:\s*[—–:.)]\s*|\s*-\s+|\s+|$)([\s\S]*)$/i;
const RESTORE = /^(?:(?:(?:поверн|верн|відкот|відкоч|відкат|скасу)\S*|undo|revert|restore)(?:\s+(?:як\s+було|назад|було|«було»|старий\s+текст))?|як\s+було|назад)(?:,?\s*(?:будь\s+ласка|please))?$/i;

// One item's words: one quoted text and nothing else is the owner's own text, verbatim; a restore word puts «було»
// back; anything else is a description to apply; nothing at all is unclear.
function kindOf(rest) {
  const bare = rest.trim().replace(/[.;,!\s]+$/u, '');
  if (!bare) return { kind: 'unclear', text: '' };
  if (closeOf(bare, 0) === bare.length - 1) return { kind: 'verbatim', text: bare.slice(1, -1) };
  if (RESTORE.test(bare)) return { kind: 'restore', text: bare };
  return { kind: 'describe', text: rest.trim() };
}

// The owner's reply by number, or null when the comment names no item (an ordinary instruction). Words before the
// first number are left out; a line with no number goes on the item before it; a quoted line (`> `, GitHub's quote
// reply) is not the owner's words and is left out.
export function parseReply(body) {
  const s = String(body ?? '').replace(/\r\n?/g, '\n').split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  const items = [];
  const preamble = [];
  for (const seg of segments(s)) {
    if (!seg.trim()) continue;
    const m = ITEM.exec(seg);
    if (m) items.push({ n: Number(m[1]), raw: m[2] });
    else if (items.length) items.at(-1).raw += `\n${seg}`;
    else preamble.push(seg.trim());
  }
  if (!items.length) return null;
  const count = new Map();
  for (const it of items) count.set(it.n, (count.get(it.n) ?? 0) + 1);
  return { items: items.map((it) => ({ n: it.n, ...kindOf(it.raw), ...(count.get(it.n) > 1 ? { twice: true } : {}) })), preamble: preamble.join('\n') };
}

// Each named item against the PR's lists: what to do, with the exact texts, or a question back. Items not named are
// not in the result: nothing is done for them.
export function resolveReply(parsed, edits) {
  const last = edits.reduce((m, e) => Math.max(m, e.n), 0);
  return parsed.items.map((it) => {
    const hits = edits.filter((e) => e.n === it.n);
    const lists = [...new Set(hits.map((e) => e.list))];
    const ask = (why) => ({ n: it.n, do: 'ask', why, words: it.text });
    if (it.twice) return ask(`item ${it.n} is named twice in the reply`);
    if (!hits.length) return ask(last ? `there is no item ${it.n} on this PR (its items are 1–${last})` : `there is no numbered list of edits on this PR yet`);
    if (lists.length > 1) return ask(`item ${it.n} is in ${lists.length} lists (${lists.map(listName).join(', ')})`);
    if (it.kind === 'unclear') return ask(`the reply names item ${it.n} with nothing to do`);
    const e = hits.at(-1);
    const where = { page: e.page, block: e.block, now: e.after };
    if (it.kind === 'restore') return { n: it.n, do: 'restore', ...where, put: e.before, ...(e.en ? { en: { page: e.en.page, now: e.en.after, put: e.en.before } } : {}) };
    if (it.kind === 'verbatim') return { n: it.n, do: 'verbatim', ...where, put: it.text };
    return { n: it.n, do: 'rewrite', ...where, how: it.text };
  });
}

// A review comment of the owner's with a `suggestion` block: the block exactly, and the words outside it.
export function suggestionOf(body) {
  const s = String(body ?? '').replace(/\r\n?/g, '\n');
  const m = /(^|\n)(`{3,}|~{3,})suggestion[^\n]*\n([\s\S]*?)(?:\n)?\2[ \t]*(?=\n|$)/.exec(s);
  if (!m) return null;
  const note = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  return { text: m[3], note };
}

// ------------------------------------------------------------------ the brief

const q = (s) => JSON.stringify(s);
const at = (x) => `${x.page}${x.block ? `, ${x.block}` : ''}`;

export function replyLines(replies) {
  const out = [];
  for (const r of replies ?? []) {
    out.push(`The owner's reply by number (comment ${r.id}): do exactly this, item by item; the items it doesn't name stay as they are. Texts are JSON strings: put them in exactly as given. If an item's words point at another place than that item's block (the owner numbered their own instructions, not the list), change nothing for it and ask back.`);
    for (const x of r.items) {
      if (x.do === 'restore') out.push(`- ${x.n}, restore: ${at(x)}: put back ${q(x.put)} where it reads ${q(x.now)}.${x.en ? ` EN ${x.en.page}: put back ${q(x.en.put)} where it reads ${q(x.en.now)}.` : ''}`);
      else if (x.do === 'verbatim') out.push(`- ${x.n}, the owner's text: ${at(x)}: replace ${q(x.now)} with exactly ${q(x.put)}.`);
      else if (x.do === 'rewrite') out.push(`- ${x.n}, rewrite as the owner describes (${q(x.how)}): ${at(x)}, which reads ${q(x.now)}.`);
      else out.push(`- ${x.n}, ask back, change nothing: ${x.why}.`);
    }
  }
  return out;
}

export function suggestionLines(suggestions) {
  if (!suggestions?.length) return [];
  return [
    "The owner's suggestions (review comments with a `suggestion` block): unless the lines already read so (the owner committed it, a hand edit: change nothing), replace the lines the comment is on with the block exactly, no rewording; only the words outside the block are an instruction.",
    ...suggestions.map((x) => `- comment ${x.id}, ${x.path ?? '?'} line ${x.line ?? '?'}: ${q(x.text)}${x.note ? `; the words outside it: ${q(x.note)}` : ''}`),
  ];
}

export function resyncItemLines(items) {
  if (!items?.length) return [];
  return [
    'The numbered edits since ready for merge, in this range: record the EN side of each block you re-sync (`edits`: `[{ "n", "en": { "page", "before", "after" } }]`). An item marked "EN set" was changed in EN with UA (a restore of both): its EN block already matches, leave it.',
    ...items.map((x) => `- ${x.n}: ${at(x)}${x.en ? ' (EN set)' : ''}`),
  ];
}
