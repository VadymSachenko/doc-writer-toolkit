import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.mjs';
import { prId, readLedger } from './ledger.mjs';

// Findings outside the ticket (TASK-050). A session that comes across a problem its ticket doesn't change (another page,
// a block of a changed page the ticket's change leaves alone, UI the ticket doesn't cover, an app bug) records it in the
// result's `sideFindings`, never as a question, a place or a line of the PR's description; a note for the owner that
// asks nothing goes there too. `record` checks the shape and keeps each on the ledger (`sideFindings`). After each step,
// the runner, with no model, files each new one (`followFindings`):
//   - a note: a line of the run report, nothing on the tracker;
//   - a finding an open card already holds: linked, not filed again. The card is the one the session named (`card`,
//     its own match: only a model can tell that two texts name the same problem), else the card filed for an earlier
//     finding with the same fingerprint (`fingerprint`: the same kind, the same page for a page finding, the same title
//     once case, punctuation and spacing are set aside). Open: not archived, not done, not this ticket's own card (one
//     out of the docs' scope still holds it: decided, it is not raised again). A comment on the ticket's card links
//     it, and one on that card names the ticket, when it is on the board in a status the settings read (the module
//     writes on no other board);
//   - otherwise a new card in the intake status, its text from the host's template (`tracker.findingCard`), its
//     description naming the ticket, and a comment on the ticket's card linking it.
// With no template the runner writes nothing on the tracker: the run report lists the finding, and the open card that
// holds it if one does. A card is a team text, in the team's language: the toolkit has no wording of its own for it
// (as `forge.reviewComment`). Each finding is routed once: `<state>/findings.jsonl` keeps one line per finding routed,
// which is also the index the fingerprint is matched against. Sessions never create a card (lib/role-hook.mjs).

export const FINDING_KINDS = ['page', 'ui', 'appBug', 'note'];
export const CARD_KINDS = ['page', 'ui', 'appBug'];
const FIELDS = ['kind', 'title', 'text', 'repo', 'page', 'where', 'refs', 'card'];
// What a template may name: each `<…>` is replaced, and a line with one whose value is empty is left out.
export const PLACEHOLDERS = ['title', 'text', 'kind', 'repo', 'page', 'where', 'refs', 'ticket', 'ticketName', 'pr', 'card'];
export const FINDING_CARD_KEYS = ['name', 'desc', 'onTicket', 'onExisting', 'kinds'];
// What each text of the template must name, so that the card and the ticket link each other.
const NEEDS = { name: 'title', desc: 'ticket', onTicket: 'card', onExisting: 'ticket' };

export const findingsPath = (state) => path.join(state, 'findings.jsonl');

// The toolkit's own name (its manifest) and its folder: a card is a team text, and never names them, nor the model or
// its files (`claude`, `.claude/`, `CLAUDE.md`).
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN_NAME = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name || path.basename(PLUGIN_ROOT);
  } catch {
    return path.basename(PLUGIN_ROOT);
  }
})();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HIDDEN = new RegExp(`${escape(PLUGIN_NAME)}|\\bclaude\\b`, 'i');
export const namesToolkit = (text) => HIDDEN.test(String(text)) || String(text).includes(PLUGIN_ROOT);

const usage = (message) => new CliError(message, { code: 2 });
const filled = (v) => typeof v === 'string' && v.trim() !== '';

// The result's `sideFindings`, checked: exit 2 on a malformed one, before the record changes anything.
export function checkFindings(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw usage('"sideFindings" is a list: [{ "kind", "title", "text", … }]');
  return list.map((f, i) => {
    const at = `sideFindings[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw usage(`${at} is { "kind", "title", "text", … }`);
    const unknown = Object.keys(f).filter((k) => !FIELDS.includes(k));
    if (unknown.length) throw usage(`${at}.${unknown[0]} is not a field (${FIELDS.join(', ')})`);
    if (!FINDING_KINDS.includes(f.kind)) throw usage(`${at}: "kind" is one of ${FINDING_KINDS.join(', ')}`);
    const note = f.kind === 'note';
    if (!filled(f.text)) throw usage(`${at} needs its "text"`);
    if (!note && !filled(f.title)) throw usage(`${at} needs its "title", the card's name in one line`);
    if (f.title !== undefined && (!filled(f.title) || /\n/.test(f.title))) throw usage(`${at}: "title" is one line`);
    for (const k of ['repo', 'page', 'where', 'card']) if (f[k] !== undefined && !filled(f[k])) throw usage(`${at}: "${k}" is a text`);
    if (f.refs !== undefined && (!Array.isArray(f.refs) || f.refs.some((r) => !filled(r)))) throw usage(`${at}: "refs" is a list of texts (links, files with lines)`);
    if (f.kind === 'page' && (!f.repo || !f.page)) throw usage(`${at}: a "page" finding names its "repo" and its "page" (the path from the repo's root)`);
    if ((f.kind === 'ui' || f.kind === 'appBug') && !f.where) throw usage(`${at}: a "${f.kind}" finding says "where" (the screen, the menu, the endpoint)`);
    if (note && f.card !== undefined) throw usage(`${at}: a note files no card, so it names none`);
    // A card is a team text: the toolkit, the model and their files stay out of it.
    const said = [f.title, f.text, f.where, f.page, ...(f.refs ?? [])].filter(Boolean);
    if (!note && said.some(namesToolkit)) throw usage(`${at}: a card is a team text, and never names the toolkit, the model or their files: say it without them`);
    const out = { kind: f.kind };
    for (const k of ['title', 'text', 'repo', 'page', 'where', 'card']) if (f[k] !== undefined) out[k] = f[k].trim();
    if (f.refs?.length) out.refs = f.refs.map((r) => r.trim());
    return out;
  });
}

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const normPath = (p) => String(p ?? '').trim().replace(/^\.\/+/, '').replace(/\/+/g, '/').toLowerCase();

// Two findings are the same when this is: the same kind, the same page (repo and path) for a page finding, and the same
// title once case, punctuation and spacing are set aside. Anything looser needs a model: that is the session's `card`.
export function fingerprint(f) {
  const where = f.kind === 'page' ? `${String(f.repo ?? '').toLowerCase()}:${normPath(f.page)}` : '';
  return crypto.createHash('sha1').update([f.kind, where, norm(f.title ?? f.text)].join('|')).digest('hex').slice(0, 16);
}

// The findings of a record, onto the ledger: each with its id, the stage and PR that found it, and when. One already on
// the ledger (the same fingerprint: the stage run again, a later stage saying it again) is kept once.
export function addFindings(l, list, { stage, pr = null, seq, at }) {
  if (!list.length) return [];
  l.sideFindings ??= [];
  const have = new Set(l.sideFindings.map((f) => f.fp));
  const added = [];
  for (const f of list) {
    const fp = fingerprint(f);
    if (have.has(fp)) continue;
    have.add(fp);
    const entry = { id: `f${l.sideFindings.length + 1}`, ...f, fp, stage, ...(pr ? { pr } : {}), seq, at };
    l.sideFindings.push(entry);
    added.push(entry);
  }
  return added;
}

// ------------------------------------------------------------------ the registry

export function readFindings(state) {
  let raw;
  try {
    raw = fs.readFileSync(findingsPath(state), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line: skipped */
    }
  }
  return out;
}

function appendFinding(state, line) {
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(findingsPath(state), JSON.stringify(line) + '\n');
}

// ------------------------------------------------------------------ the template

// A template's text with its placeholders filled in. A line that names a placeholder with no value is left out, as the
// host's templates leave out a line that doesn't apply.
export function renderTemplate(text, values) {
  const re = new RegExp(`<(${PLACEHOLDERS.join('|')})>`, 'g');
  return String(text)
    .split('\n')
    .filter((line) => [...line.matchAll(re)].every((m) => filled(values[m[1]])))
    .map((line) => line.replace(re, (_, k) => String(values[k]).trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The host's card template (`tracker.findingCard`), checked: none is null, and the runner files no card.
export function validateFindingCard(raw, fail) {
  if (raw === undefined || raw === null) return null;
  const shape = `tracker.findingCard must be { ${FINDING_CARD_KEYS.join(', ')} } (kinds optional)`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(shape);
  const unknown = Object.keys(raw).filter((k) => !FINDING_CARD_KEYS.includes(k));
  if (unknown.length) fail(`tracker.findingCard.${unknown[0]} is not a key: ${shape}`);
  for (const [k, needs] of Object.entries(NEEDS)) {
    if (!filled(raw[k])) fail(`tracker.findingCard.${k} is a text: ${shape}`);
    if (!raw[k].includes(`<${needs}>`)) fail(`tracker.findingCard.${k} must have <${needs}> in it, so the card and the ticket name each other`);
  }
  const kinds = raw.kinds ?? {};
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds) || Object.entries(kinds).some(([k, v]) => !CARD_KINDS.includes(k) || !filled(v))) fail(`tracker.findingCard.kinds is { ${CARD_KINDS.join(', ')} }, each the team's word for it`);
  return { name: raw.name, desc: raw.desc, onTicket: raw.onTicket, onExisting: raw.onExisting, kinds: { ...kinds } };
}

// ------------------------------------------------------------------ routing, after a step

// A card that no longer holds a finding: done. One out of the docs' scope still does (an app bug triaged away is known
// and decided: found again, it is linked, not raised again); one in a never-read status still does, but gets no comment.
const STOP = ['done'];

// Each finding the tickets' ledgers hold that no line of the registry routed yet, routed now. Returns the events for the
// run log: `{ key, id, outcome, note }`, outcome `filed`, `linked`, `unfiled`, `noted`, or `failed` (a tracker call
// that failed: the finding stays unrouted, and the ticket's next step tries it again).
export async function followFindings({ settings, clients, keys, now = Date.now() }) {
  const events = [];
  let lines = null;
  for (const key of keys) {
    let l;
    try {
      l = readLedger(settings.state, key);
    } catch (e) {
      events.push({ key, outcome: 'failed', note: `the ledger can't be read: ${e.message}` });
      continue;
    }
    if (!l?.sideFindings?.length) continue;
    lines ??= readFindings(settings.state);
    const routed = new Set(lines.map((x) => `${x.ticket}|${x.id}`));
    for (const f of l.sideFindings) {
      if (routed.has(`${key}|${f.id}`)) continue;
      try {
        const line = await route({ settings, clients, l, f, lines, at: new Date(now).toISOString(), events });
        lines.push(line);
        routed.add(`${key}|${f.id}`);
      } catch (e) {
        events.push({ key, id: f.id, outcome: 'failed', note: `${f.id} «${f.title ?? f.text.slice(0, 60)}» was not routed: ${String(e.message ?? e).split('\n')[0]}` });
      }
    }
  }
  return events;
}

async function route({ settings, clients, l, f, lines, at, events }) {
  const key = l.key;
  const base = { at, ticket: key, id: f.id, fp: f.fp, kind: f.kind, title: f.title ?? null, stage: f.stage, ...(f.pr ? { pr: f.pr } : {}) };
  const write = (line) => {
    appendFinding(settings.state, line);
    return line;
  };
  if (f.kind === 'note') {
    const line = write({ ...base, outcome: 'noted', text: f.text });
    events.push({ key, id: f.id, outcome: 'noted', note: `note: ${f.text.slice(0, 200)}` });
    return line;
  }
  const tracker = clients.tracker;
  const board = settings.tracker.board;
  const neverRead = settings.tracker.neverRead ?? [];
  // A card holds the finding when it isn't archived, isn't done, and isn't this ticket's own card.
  const openCard = async (ref) => {
    const r = await tracker.findCards({ link: ref });
    const c = r.cards[0];
    if (!c) return { card: null, why: 'gone' };
    if (c.closed) return { card: null, why: 'archived' };
    if (c.boardId === board && STOP.includes(c.status)) return { card: null, why: `in ${c.status}` };
    if (c.id === l.card?.id) return { card: null, why: "this ticket's own card" };
    return { card: c, why: null };
  };
  let held = null;
  let by = null;
  const notes = [];
  if (f.card) {
    // A link the tracker can't take (not a card's) is said, and the finding goes on as if none were named; a tracker
    // that fails stops the routing, which the next step tries again.
    const r = await openCard(f.card).catch((e) => {
      if (e?.refused) return { card: null, why: `not a card the tracker reads (${String(e.message).split('\n')[0]})` };
      throw e;
    });
    if (r.card) [held, by] = [r.card, 'session'];
    else notes.push(`the card the session named (${f.card}) is ${r.why}`);
  }
  if (!held) {
    const earlier = [...lines].reverse().find((x) => x.fp === f.fp && x.card?.url);
    if (earlier) {
      const r = await openCard(earlier.card.shortLink ?? earlier.card.url);
      if (r.card) [held, by] = [r.card, `fingerprint, as ${earlier.ticket} ${earlier.id}`];
      else notes.push(`the card filed for ${earlier.ticket} ${earlier.id} (${earlier.card.url}) is ${r.why}`);
    }
  }
  const card = (c) => ({ id: c.id, shortLink: c.shortLink ?? null, url: c.url ?? null });
  const t = settings.findingCard;
  if (!t) {
    const line = write({ ...base, outcome: 'unfiled', text: f.text, ...(held ? { held: card(held), by } : {}), ...(notes.length ? { notes } : {}) });
    events.push({ key, id: f.id, outcome: 'unfiled', note: `${f.id} «${f.title}»: no card, the host sets no card template (tracker.findingCard)${held ? `; an open card holds it already: ${held.url}` : ''}` });
    return line;
  }
  const ticketPr = f.pr ? (l.prs ?? []).find((p) => prId(p) === f.pr) : null;
  const values = {
    title: f.title,
    text: f.text,
    kind: t.kinds?.[f.kind] ?? f.kind,
    repo: f.repo ?? '',
    page: f.page ?? '',
    where: f.where ?? '',
    refs: (f.refs ?? []).join(', '),
    ticket: l.card?.url ?? '',
    ticketName: l.card?.name ?? '',
    pr: ticketPr?.url ?? '',
    card: '',
  };
  const ticketRef = l.card?.shortLink ?? l.card?.id ?? null;
  // The comments that link the two cards: one failed is a warning, never a second card (the line is written first).
  const comment = async (ref, text, what) => {
    try {
      await tracker.comment({ card: ref, text });
      return true;
    } catch (e) {
      events.push({ key, id: f.id, outcome: 'failed', note: `${f.id}: the comment on ${what} was not posted: ${String(e.message ?? e).split('\n')[0]}` });
      return false;
    }
  };
  if (held) {
    const line = write({ ...base, outcome: 'linked', card: card(held), by, ...(notes.length ? { notes } : {}) });
    // The module writes on the board only, and never on a card the settings keep unread.
    const onBoard = held.boardId === board && !neverRead.includes(held.status);
    const linked = {
      ticket: ticketRef ? await comment(ticketRef, renderTemplate(t.onTicket, { ...values, card: held.url ?? held.shortLink }), "the ticket's card") : false,
      card: onBoard ? await comment(held.id, renderTemplate(t.onExisting, values), `the card ${held.url}`) : false,
    };
    events.push({ key, id: f.id, outcome: 'linked', note: `${f.id} «${f.title}»: linked to the open card ${held.url} (${by})${onBoard ? '' : '; that card is on another board or kept unread, so only the ticket links it'}` });
    return { ...line, linked };
  }
  const made = await tracker.createCard({ status: 'intake', name: renderTemplate(t.name, values).split('\n')[0] || f.title, desc: renderTemplate(t.desc, values) });
  const line = write({ ...base, outcome: 'filed', card: { id: made.id, shortLink: made.shortLink ?? null, url: made.url ?? null }, ...(notes.length ? { notes } : {}) });
  const linked = { ticket: ticketRef ? await comment(ticketRef, renderTemplate(t.onTicket, { ...values, card: made.url ?? made.shortLink }), "the ticket's card") : false };
  events.push({ key, id: f.id, outcome: 'filed', note: `${f.id} «${f.title}»: filed in the intake list, ${made.url}` });
  return { ...line, linked };
}

// ------------------------------------------------------------------ what the sessions and the report are told

// The brief's lines on a stage whose session may come across one: what goes in `sideFindings`, the ticket's own
// findings so far (not to be given again), and the newest cards filed for earlier findings, for the session's own match.
export const FINDING_STAGES = ['plan', 'write', 'answerPass', 'pr', 'answerComments', 'styleCheck', 'uaReview', 'enReview', 'visualPack', 'translate', 'locales', 'align', 'labelSync'];
export function findingLines(step, settings, { cards = 15 } = {}) {
  if (!['writer', 'reviewer', 'translator'].includes(step.role) || !FINDING_STAGES.includes(step.stage)) return [];
  const out = [
    'Outside the ticket: a problem this ticket doesn\'t change (another page, a block of a changed page the ticket\'s change leaves alone, UI the ticket doesn\'t cover, an app bug) is no question, no place and no open item, and goes in no summary and not in the PR\'s description. Give it in the record\'s `sideFindings`: `[{ "kind": "page" | "ui" | "appBug", "title", "text", "repo", "page", "where", "refs", "card" }]` (a `page` one names its `repo` and `page`, from the repo\'s root; a `ui` or `appBug` one says `where`: the screen, the menu, the endpoint). The runner files each as a card in the tracker\'s intake list, linked to this ticket, or links the open card that holds it already: give that card\'s link as `card` when you know one. Never create a card yourself. `title` and `text` are a team text, in the team\'s language, naming no tool or model. What this ticket\'s pages depend on stays a question, even when its answer may be an app bug. A note for the owner that asks nothing is `{ "kind": "note", "text" }` there too: it goes to the run report, not the PR.',
  ];
  let mine = [];
  try {
    mine = step.keys.flatMap((k) => (readLedger(settings.state, k)?.sideFindings ?? []).map((f) => ({ ...f, key: k })));
  } catch {
    /* an unreadable ledger: nothing listed */
  }
  if (mine.length) out.push(`Already recorded for this ticket (don't give them again): ${mine.map((f) => `${f.kind} «${f.title ?? f.text.slice(0, 80)}»`).join('; ')}.`);
  let filed = [];
  try {
    filed = readFindings(settings.state).filter((x) => x.card?.url && x.outcome === 'filed' && !step.keys.includes(x.ticket));
  } catch {
    /* an unreadable registry: nothing listed */
  }
  if (filed.length) out.push(`Cards filed for earlier findings, newest first (one that holds your finding is its \`card\`):\n${filed.slice(-cards).reverse().map((x) => `- ${x.card.url} ${x.kind} «${x.title}»`).join('\n')}`);
  return out;
}

// The report's section: the findings routed on the date, by ticket.
export function renderFindings(lines, onDate) {
  const today = lines.filter((x) => onDate(x.at));
  const row = (x) => {
    const what = x.outcome === 'noted' ? `note: ${x.text}` : `${x.kind} «${x.title}»`;
    if (x.outcome === 'filed') return `${x.ticket}: ${what}, filed: ${x.card.url}`;
    if (x.outcome === 'linked') return `${x.ticket}: ${what}, linked to the open card ${x.card.url} (${x.by})`;
    if (x.outcome === 'unfiled') return `${x.ticket}: ${what}: ${x.text}${/[.!?…]$/.test(x.text) ? '' : '.'} No card: the host sets no card template (\`tracker.findingCard\`)${x.held ? `; an open card holds it already: ${x.held.url}` : ''}`;
    return `${x.ticket}: ${what}`;
  };
  return ['## Findings outside the tickets', '', today.length ? today.map((x) => `- ${row(x)}${x.notes?.length ? ` (${x.notes.join('; ')})` : ''}`).join('\n') : '- none', ''];
}
