import { CliError } from './errors.mjs';

// The numbered lists of edits the owner reads on a PR, and the owner's reply to them by number (context/ticket-flow.md,
// "The list of edits and the reply by number"). No AI: the lists are what the roles posted and recorded, and a reply is
// read by its numbers only; what an item's description asks is the writer's to apply.
//
// An item: `n` (fixed once posted), `list` (where it was posted: `description` for the PR description, else the id of
// the comment), `stage`, `page`, `block`, `before` and `after` (the exact UA text), and `en` ({ page, before, after })
// when its EN changed too; `rule` for a fix of the style check (the guide's rule it applies), and `reason` when the
// comment or the commit message behind the edit gave one. One PR numbers on: a later list starts after the last number, so a reply can't hit the
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
    if ((e.rule !== undefined && e.rule !== null && !text(e.rule)) || (e.reason !== undefined && e.reason !== null && !text(e.reason))) throw new CliError(`edits: item ${n}'s "rule" and "reason" are texts`, { code: 2 });
    // A style fix names its rule; an edit whose comment or commit message gave a reason keeps it (the learning from
    // the owner's edits reads it).
    const item = { n, list: String(list), stage, page: e.page, block: text(e.block) ? e.block : null, before: e.before, after: e.after, ...(e.en ? { en: { page: e.en.page, before: e.en.before, after: e.en.after } } : {}), ...(text(e.rule) && e.rule.trim() ? { rule: e.rule } : {}), ...(text(e.reason) && e.reason.trim() ? { reason: e.reason } : {}), at, seq };
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

// Quotes and what closes them. Guillemets and curly quotes nest («А «Б» В»), so the close is found by depth; a straight
// quote can't nest, and „…“ closes at the first “ or ”.
const PAIRS = { '«': '»', '“': '”' };
const closeOf = (s, i) => {
  const open = s[i];
  if (PAIRS[open]) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === open) depth += 1;
      else if (s[j] === PAIRS[open] && --depth === 0) return j;
    }
    return -1;
  }
  if (open === '„') {
    const at = ['“', '”'].map((c) => s.indexOf(c, i + 1)).filter((x) => x > i);
    return at.length ? Math.min(...at) : -1;
  }
  if (open === '"') return s.indexOf('"', i + 1);
  return -1;
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

// The number first, then a separator: a dash, a colon, a dot (not a decimal point) or a bracket; a bare space is not
// one, so «5 хвилин тому…» is no item. Several numbers before one separator («2 і 3 — поверни», «2, 3: …», «2-3 —
// …») name items together.
const LEAD = /^\s*(?:[-*•]\s*)?(?:(?:пункт|пункти|п\.|item|items|№|#)\s*)?/i;
const ITEM = new RegExp(`${LEAD.source}(\\d{1,4})(?:\\s*(?:[—–:)]|\\.(?!\\d))\\s*|\\s+-\\s+|\\s*$)([\\s\\S]*)$`, 'i');
const GROUP = new RegExp(`${LEAD.source}(\\d{1,4}(?:\\s*(?:,|і|й|и|та|and|&|-|–)\\s*\\d{1,4})+)\\s*(?:[—–:)]|\\.(?!\\d)|\\s-\\s)([\\s\\S]*)$`, 'i');
const RESTORE = /^(?:(?:(?:поверн|верн|відкот|відкоч|відкат|скасу)\S*|undo|revert|restore)(?:\s+(?:як\s+було|назад|було|«було»|старий\s+текст))?|як\s+було|назад)(?:,?\s*(?:будь\s+ласка|please))?$/i;
// «не треба» may say "leave it" or "undo it": asked back.
const EITHER = /^(?:не\s+треба|не\s+потрібно|не\s+варто|не\s+так)$/i;
const KEEP = /^(?:ок|окей|ok|okay|так|добре|гаразд|норм|нормально|залиш\S*|лиши|хай\s+буде|не\s+змінюй|keep|fine)(?:,?\s*(?:дякую|thanks))?$/i;

// One item's words: one quoted text and nothing else is the owner's own text, verbatim; a restore word puts «було»
// back; a word of assent keeps the item; anything else is a description to apply; nothing at all is unclear.
function kindOf(rest) {
  const bare = rest.trim().replace(/[.;,!\s]+$/u, '');
  if (!bare) return { kind: 'unclear', text: '' };
  if (closeOf(bare, 0) === bare.length - 1) return { kind: 'verbatim', text: bare.slice(1, -1) };
  if (RESTORE.test(bare)) return { kind: 'restore', text: bare };
  if (KEEP.test(bare)) return { kind: 'keep', text: bare };
  if (EITHER.test(bare)) return { kind: 'either', text: bare };
  return { kind: 'describe', text: rest.trim() };
}

// The owner's reply by number, or null when the comment names no item (an ordinary instruction). A quoted line (`> `,
// GitHub's quote reply) is not the owner's words and is left out. A line with no number goes on the item before it
// only when that item is a description (or names nothing yet); after a restore, a quoted text or an assent it is a
// word of the whole reply (`rest`), never narrowed to one item. A comment that reads as the owner's own numbered list
// (1., 2., … in order, descriptions only, no quote in any of them) is asked back as a whole: it may answer the list,
// or be new instructions.
export function parseReply(body) {
  const s = String(body ?? '').replace(/\r\n?/g, '\n').split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  const items = [];
  const rest = [];
  for (const seg of segments(s)) {
    if (!seg.trim()) continue;
    const g = GROUP.exec(seg);
    if (g) {
      const ns = g[1].match(/\d{1,4}/g).map(Number);
      for (const n of ns) items.push({ n, raw: g[2], together: ns, dot: false });
      continue;
    }
    const m = ITEM.exec(seg);
    if (m) {
      items.push({ n: Number(m[1]), raw: m[2], dot: /^\s*\d+\s*\./.test(seg.replace(LEAD, '')) });
      continue;
    }
    const prev = items.at(-1);
    if (prev && !prev.together && ['describe', 'unclear'].includes(kindOf(prev.raw).kind)) prev.raw += `\n${seg}`;
    else rest.push(seg.trim());
  }
  if (!items.length) return null;
  const kinds = items.map((it) => kindOf(it.raw));
  const ownList = items.length >= 2 && items.every((it, i) => it.dot && it.n === i + 1) && kinds.every((k) => k.kind === 'describe' && !/[«“„"]/.test(k.text));
  const count = new Map();
  for (const it of items) count.set(it.n, (count.get(it.n) ?? 0) + 1);
  return {
    items: items.map((it, i) => ({
      n: it.n,
      ...kinds[i],
      ...(count.get(it.n) > 1 ? { twice: true } : {}),
      ...(it.together ? { together: it.together } : {}),
      ...(ownList ? { ownList: true } : {}),
    })),
    rest: rest.join('\n'),
  };
}

// The edits of a PR as the lists show them, from every ledger that shares the PR (a PR with two cards has two): one
// item per number and list, `differs` when the ledgers disagree about its text.
export function mergedEdits(lists) {
  const out = new Map();
  for (const e of lists.flat()) {
    const k = `${e.n}|${e.list}`;
    const seen = out.get(k);
    if (!seen) out.set(k, { ...e });
    else if (['page', 'block', 'before', 'after'].some((f) => (seen[f] ?? null) !== (e[f] ?? null)) || JSON.stringify(seen.en ?? null) !== JSON.stringify(e.en ?? null)) seen.differs = true;
  }
  return [...out.values()];
}

// Each named item against the PR's lists: what to do, with the exact texts, or a question back. Items not named are
// not in the result: nothing is done for them.
export function resolveReply(parsed, edits) {
  const last = edits.reduce((m, e) => Math.max(m, e.n), 0);
  return parsed.items.map((it) => {
    const hits = edits.filter((e) => e.n === it.n);
    const lists = [...new Set(hits.map((e) => e.list))];
    const ask = (why) => ({ n: it.n, do: 'ask', why, words: it.text });
    if (it.ownList) return ask('the comment reads as a numbered list of its own (1., 2., … with descriptions only): ask whether it answers the list of edits by number or gives new instructions');
    if (it.together) return ask(`the reply names items ${it.together.join(', ')} together: ask for each on its own`);
    if (it.twice) return ask(`item ${it.n} is named twice in the reply`);
    if (!hits.length) return ask(last ? `there is no item ${it.n} on this PR (its items are 1–${last})` : `there is no numbered list of edits on this PR yet`);
    if (lists.length > 1) return ask(`item ${it.n} is in ${lists.length} lists (${lists.map(listName).join(', ')})`);
    if (hits.some((e) => e.differs)) return ask(`item ${it.n} reads differently in the records of the cards that share this PR`);
    if (it.kind === 'unclear') return ask(`the reply names item ${it.n} with nothing to do`);
    if (it.kind === 'either') return ask(`${JSON.stringify(it.text)} on item ${it.n} may mean keep it or undo it`);
    const e = hits.at(-1);
    if (it.kind === 'keep') return { n: it.n, do: 'keep' };
    // A later item changed the same block: its «стало» is not what the page reads now.
    const later = edits.filter((x) => x !== e && x.page === e.page && (x.block ?? null) === (e.block ?? null) && x.n > e.n).map((x) => x.n);
    if (it.kind === 'restore' && later.length) return ask(`item ${it.n}'s block was changed again by item ${later.join(', ')}: ask which text to restore`);
    const where = { page: e.page, block: e.block, now: e.after, ...(later.length ? { later } : {}) };
    if (it.kind === 'restore') return { n: it.n, do: 'restore', ...where, put: e.before, ...(e.en ? { en: { page: e.en.page, now: e.en.after, put: e.en.before } } : {}) };
    if (it.kind === 'verbatim') return { n: it.n, do: 'verbatim', ...where, put: it.text };
    return { n: it.n, do: 'rewrite', ...where, how: it.text };
  });
}

// A review comment of the owner's with a `suggestion` block: the block exactly, and the words outside it. Two blocks
// in one comment can't both replace the comment's lines: `several`, asked back.
export function suggestionOf(body) {
  const s = String(body ?? '').replace(/\r\n?/g, '\n');
  const re = /(^|\n)(`{3,}|~{3,})suggestion[^\n]*\n([\s\S]*?)(?:\n)?\2[ \t]*(?=\n|$)/g;
  const found = [...s.matchAll(re)];
  if (!found.length) return null;
  if (found.length > 1) return { several: found.length, text: null, note: s.trim() };
  const m = found[0];
  const note = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  return { text: m[3], note };
}

// ------------------------------------------------------------------ the brief

const q = (s) => JSON.stringify(s);
const at = (x) => `${x.page}${x.block ? `, ${x.block}` : ''}`;

export function replyLines(replies) {
  const out = [];
  for (const r of replies ?? []) {
    out.push(`The owner's reply by number (comment ${r.id}): do exactly this, item by item; the items it doesn't name stay as they are. Texts are JSON strings: put them in exactly as given. Where the block doesn't read as the line says, change nothing for that item and ask back. If an item's words point at another place than that item's block (the owner numbered their own instructions, not the list), change nothing for it and ask back.`);
    for (const x of r.items) {
      if (x.do === 'restore') out.push(`- ${x.n}, restore: ${at(x)}: put back ${q(x.put)} where it reads ${q(x.now)}.${x.en ? ` EN ${x.en.page}: put back ${q(x.en.put)} where it reads ${q(x.en.now)}.` : ''}`);
      else if (x.do === 'verbatim') out.push(`- ${x.n}, the owner's text: ${at(x)}: replace ${q(x.now)}${x.later ? ` (or what items ${x.later.join(', ')} made of it)` : ''} with exactly ${q(x.put)}.`);
      else if (x.do === 'rewrite') out.push(`- ${x.n}, rewrite as the owner describes (${q(x.how)}): ${at(x)}, which reads ${q(x.now)}${x.later ? ` (or what items ${x.later.join(', ')} made of it)` : ''}.`);
      else if (x.do === 'keep') out.push(`- ${x.n}, keep: the owner agrees, change nothing.`);
      else out.push(`- ${x.n}, ask back, change nothing: ${x.why}.`);
    }
    if (r.rest) out.push(`  Words of the reply outside its items (not tied to one item; an instruction for the PR, or a remark): ${q(r.rest)}.`);
  }
  return out;
}

export function suggestionLines(suggestions) {
  if (!suggestions?.length) return [];
  return [
    "The owner's suggestions (review comments with a `suggestion` block): unless the lines already read so (the owner committed it, a hand edit: change nothing), replace the lines the comment is on with the block exactly, no rewording; only the words outside the block are an instruction. The line given is the last line the comment covers: a block of several lines may start above it, so match the lines it replaces by their content, and if that isn't certain, change nothing and ask back.",
    ...suggestions.map((x) => (x.several ? `- comment ${x.id}, ${x.path ?? '?'} line ${x.line ?? '?'}: ${x.several} suggestion blocks in one comment; ask back, change nothing.` : `- comment ${x.id}, ${x.path ?? '?'} line ${x.line ?? '?'}: ${q(x.text)}${x.note ? `; the words outside it: ${q(x.note)}` : ''}`)),
  ];
}

export function resyncItemLines(items) {
  if (!items?.length) return [];
  return [
    'The numbered edits since ready for merge, in this range: record the EN side of each block you re-sync (`edits`: `[{ "n", "en": { "page", "before", "after" } }]`). An item marked "EN set" was changed in EN with UA (a restore of both): its EN block already matches, leave it.',
    ...items.map((x) => `- ${x.n}: ${at(x)}${x.en ? ' (EN set)' : ''}`),
  ];
}

// A session that ran the style check as a skill took its report for the answer and ended there, with nothing
// recorded or pushed, whenever the review found nothing to fix (TASK-096).
const STYLE_GOES_ON = "The style check's report is a step of the stage, never its end, whatever it found (no finding, suggestions only, fixes): after it, record, commit, push and post the summary as the stage says.";

// After the review comments are applied: the style check over the blocks they changed (D-081). A plain comment that
// quotes a sentence of the page with words removed or changed is the reviewer's replacement for that sentence.
export function styleAfterCommentsLines() {
  return [
    'A plain comment (no `suggestion` block, no reply by number) that quotes a sentence of the page with words removed or changed is the reviewer\'s replacement for that sentence: put it in as quoted, the words outside the quote being an instruction.',
    'Once the comments are applied, the style check runs over the UA blocks they changed (the writer role, "The style check"), and over no other block: a block an item of the reply restores or keeps stays as the owner chose it. Its fixes go on the summary\'s numbered list after your edits, each with its `rule`; a fix that would change what the edit meant is not applied and is a note after the list, never numbered.',
    STYLE_GOES_ON,
  ];
}

// The questions to the owner the PR's earlier summaries left open (`openQuestions`): the session lists again, in
// `questions`, those the new comments didn't answer, with its own new ones; the runner sets the check label from them.
export function openQuestionLines(items) {
  const open = [
    'Record in `questions` every question to the owner left open after this round, each `{ "text", "n"? }` (`n`: the item of the numbered list it asks about), or `[]` when none is: the ones your summary asks, and the earlier ones below that the new comments didn\'t answer. The runner sets the check label from them; never add or remove it yourself.',
  ];
  if (!items?.length) return open;
  return [...open, 'Questions to the owner still open on this PR, from its earlier summaries:', ...items.map((x) => `- ${x.n ? `${x.n}: ` : ''}${q(x.text)}`)];
}

// The hand commits a style check reviews: the commits on the branch the pipeline didn't make that changed UA, with
// the UA pages each changed, oldest first.
export function styleCheckLines(commits, fixes) {
  if (!commits?.length) return [];
  return [
    'Commits on this PR\'s branch the pipeline didn\'t make (hand edits) changed UA, and no style check has reviewed them. Run the style check (the writer role, "The style check") over the UA blocks each one changed (`git -C <worktree> show <sha> -- <page>`), and over no other block. Record every sha below in `reviewed`, fixed or not, with the reason its commit message gives, if any.',
    STYLE_GOES_ON,
    ...commits.map((c) => `- ${c.sha}: ${c.pages.join(', ')}`),
    ...(fixes?.length ? ['Style fixes already on this PR\'s lists, on these pages: a block whose hand edit puts one\'s «було» back is the owner undoing that fix; leave the block out.', ...fixes.map((x) => `- ${x.n}: ${at(x)}: ${q(x.before)}`)] : []),
  ];
}
