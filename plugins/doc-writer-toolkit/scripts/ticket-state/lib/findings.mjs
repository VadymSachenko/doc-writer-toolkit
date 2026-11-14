import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.mjs';
import { keyOf, prId, readLedger } from './ledger.mjs';
import { lockOf } from './locks.mjs';
import { addPostedCard } from './record.mjs';

// Findings outside the ticket (TASK-050). A session that comes across a problem its ticket doesn't change (another page,
// a block of a changed page the ticket's change leaves alone, UI the ticket doesn't cover, an app bug) records it in the
// result's `sideFindings`, never as a question, a place or a line of the PR's description; a note for the owner that
// asks nothing goes there too. `record` checks the shape and keeps each on the ledger (`sideFindings`). After each step,
// the runner, with no model, files each new one (`followFindings`):
//   - a note: a line of the run report, nothing on the tracker;
//   - a finding an open card already holds: linked, not filed again. The card is the one the session named (`card`,
//     its own match: only a model can tell that two texts name the same problem), else the card filed or linked for an
//     earlier finding with the same fingerprint (`fingerprint`: the same kind, the same page for a page finding, the
//     same title once case, punctuation and spacing are set aside). Each is read by its id, never by listing a list.
//     Open: not archived, not done, not this ticket's own card (one out of the docs' scope still holds it: decided, it
//     is not raised again). A comment on the ticket's card links it, and one on that card names the ticket, when it is
//     on the board in a status the settings read, or is a card the runner filed itself;
//   - otherwise a new card in the list the host's settings name for its kind (`tracker.findingCard.lists`), with the
//     labels they name for it and the app's label. A page or UI card takes its name and description from the settings'
//     texts; an app bug's description is built from the host's bug template file (`templates.appBug`): its lead line
//     and its `###` sections in order, each filled from the finding's fields, its example text and instructions never
//     copied. A comment on the ticket's card links the new card.
// With no template, or no list for the finding's kind, or a bug template file that can't be used, the runner files no
// card: the run report lists the finding, and the open card that holds it if one does. A card is a team text, in the
// team's language: the toolkit has no wording of its own for it (as `forge.reviewComment`). Each finding is routed once:
// `<state>/findings.jsonl` keeps one line per finding routed, which is also the index the fingerprint is matched
// against. Sessions never create a card (lib/role-hook.mjs).

export const FINDING_KINDS = ['page', 'ui', 'appBug', 'note'];
export const CARD_KINDS = ['page', 'ui', 'appBug'];
// The fields each kind takes. An app bug is a bug report: what is wrong now and what is expected, the place inside the
// app (`module`), the role it was seen under, how to reproduce it; `app` is the app's label, `side` the UI or the backend.
const KIND_FIELDS = {
  page: ['title', 'text', 'repo', 'page', 'where', 'refs', 'card', 'app'],
  ui: ['title', 'text', 'where', 'refs', 'card', 'app'],
  appBug: ['title', 'app', 'side', 'module', 'role', 'now', 'expected', 'repro', 'refs', 'card'],
  note: ['title', 'text', 'repo', 'page', 'where', 'refs'],
};
const FIELDS = [...new Set(Object.values(KIND_FIELDS).flat())];
export const SIDES = ['fe', 'be'];
// What each `###` section of the host's bug template takes, in the template's order (`templates.appBug.sections`).
// `reporter` is the runner's: who found it, from the settings' text naming the ticket.
export const BUG_SECTIONS = ['module', 'reporter', 'role', 'now', 'expected', 'repro'];
const BUG_REQUIRED = ['reporter', 'now', 'expected'];
// What a template may name: each `<…>` is replaced, and a line with one whose value is empty is left out.
export const PLACEHOLDERS = ['title', 'text', 'kind', 'repo', 'page', 'where', 'refs', 'app', 'ticket', 'ticketName', 'pr', 'card'];
export const FINDING_CARD_KEYS = ['lists', 'labels', 'apps', 'kinds', 'name', 'desc', 'templates', 'onTicket', 'onExisting'];
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

// Data that stays in a bug report's last section (`repro`): the sections above it may be read for public texts (the
// host's bug template says which). An id, JSON, SQL, an account or a card number.
const CONFIDENTIAL = [
  ['an id (UUID)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['JSON', /[{[]\s*"[^"\n]+"\s*:/],
  ['SQL', /\b(select\b[\s\S]*\bfrom|insert\s+into|update\b[\s\S]*\bset|delete\s+from)\b/i],
  ['an account number (IBAN)', /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/],
  ['a card number', /\b\d(?:[ -]?\d){12,18}\b/],
];
const confidential = (text) => CONFIDENTIAL.find(([, re]) => re.test(String(text)))?.[0] ?? null;

// The apps a finding may name (`app`): the targets' app labels and the settings' `findingCard.apps`.
export function knownApps(settings) {
  return [...new Set([...(settings?.targets ?? []).map((t) => t.appLabel), ...(settings?.findingCard?.apps ?? [])].filter(filled))];
}

// The result's `sideFindings`, checked: exit 2 on a malformed one, before the record changes anything. `apps`: the app
// labels a finding may name (`knownApps`).
export function checkFindings(list, { apps = [] } = {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw usage('"sideFindings" is a list: [{ "kind", "title", "text", … }]');
  return list.map((f, i) => {
    const at = `sideFindings[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw usage(`${at} is { "kind", "title", "text", … }`);
    const unknown = Object.keys(f).filter((k) => k !== 'kind' && !FIELDS.includes(k));
    if (unknown.length) throw usage(`${at}.${unknown[0]} is not a field (${FIELDS.join(', ')})`);
    if (!FINDING_KINDS.includes(f.kind)) throw usage(`${at}: "kind" is one of ${FINDING_KINDS.join(', ')}`);
    const note = f.kind === 'note';
    const bug = f.kind === 'appBug';
    const foreign = Object.keys(f).filter((k) => k !== 'kind' && !KIND_FIELDS[f.kind].includes(k));
    if (foreign.length) {
      if (note && foreign.includes('card')) throw usage(`${at}: a note files no card, so it names none`);
      const hint = bug ? ' (an app bug says what is wrong in "now", what should happen in "expected", the place inside the app in "module")' : '';
      throw usage(`${at}: a "${f.kind}" finding has no "${foreign[0]}": it takes ${KIND_FIELDS[f.kind].join(', ')}${hint}`);
    }
    for (const k of ['text', 'repo', 'page', 'where', 'card', 'app', 'module', 'role', 'now', 'expected', 'repro']) if (f[k] !== undefined && !filled(f[k])) throw usage(`${at}: "${k}" is a text`);
    if (!bug && !filled(f.text)) throw usage(`${at} needs its "text"`);
    if (!note && !filled(f.title)) throw usage(`${at} needs its "title", the card's name in one line`);
    if (f.title !== undefined && (!filled(f.title) || /\n/.test(f.title))) throw usage(`${at}: "title" is one line`);
    if (f.refs !== undefined && (!Array.isArray(f.refs) || f.refs.some((r) => !filled(r)))) throw usage(`${at}: "refs" is a list of texts (links, files with lines)`);
    if (f.kind === 'page' && (!f.repo || !f.page)) throw usage(`${at}: a "page" finding names its "repo" and its "page" (the path from the repo's root)`);
    if (f.kind === 'ui' && !f.where) throw usage(`${at}: a "ui" finding says "where" (the screen, the menu, the endpoint)`);
    if (bug) {
      for (const k of ['now', 'expected']) if (!f[k]) throw usage(`${at}: an "appBug" finding says "now" (what is wrong) and "expected" (what should happen instead): without "${k}" it is no bug report`);
      if (f.side !== undefined && !SIDES.includes(f.side)) throw usage(`${at}: "side" is ${SIDES.map((x) => `"${x}"`).join(' or ')} (the UI or the backend)`);
      if (apps.length && !f.app) throw usage(`${at}: an "appBug" finding names its "app": one of ${apps.join(', ')}`);
      for (const k of ['title', 'module', 'role', 'now', 'expected']) {
        const what = f[k] === undefined ? null : confidential(f[k]);
        if (what) throw usage(`${at}: "${k}" holds what looks like ${what}: ids, JSON, SQL, account and card numbers go only in "repro"`);
      }
    }
    let app;
    if (f.app !== undefined) {
      app = apps.length ? apps.find((a) => a.trim().toLowerCase() === f.app.trim().toLowerCase()) : f.app.trim();
      if (!app) throw usage(`${at}: "app" is one of ${apps.join(', ')} (the app's label)`);
    }
    // A card is a team text: the toolkit, the model and their files stay out of it.
    const said = [f.title, f.text, f.where, f.page, f.module, f.role, f.now, f.expected, f.repro, ...(f.refs ?? [])].filter(Boolean);
    if (!note && said.some(namesToolkit)) throw usage(`${at}: a card is a team text, and never names the toolkit, the model or their files: say it without them`);
    const out = { kind: f.kind };
    for (const k of ['title', 'text', 'repo', 'page', 'where', 'module', 'role', 'now', 'expected', 'repro', 'card']) if (f[k] !== undefined) out[k] = f[k].trim();
    if (app) out.app = app;
    if (f.side) out.side = f.side;
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

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const names = (v) => Array.isArray(v) && v.every(filled);

// The host's card settings (`tracker.findingCard`), checked: none is null, and the runner files no card.
//   lists      { page?, ui?, appBug? }: the list each kind's card goes to (a status, or a list of the board by name);
//              a kind with none files no card
//   labels     { page?, ui?, appBug? }: the labels of each kind's card, a list, or for an app bug { all?, fe?, be? }
//   apps       the app labels a finding may name besides the targets' `appLabel`
//   kinds      { page?, ui?, appBug? }: the team's word for each kind (`<kind>`)
//   name, desc the page and UI card's name and description (needed when `lists` names page or ui)
//   templates  { appBug: { file, sections, reporter } }: the host's bug template file, the finding's field each of its
//              `###` sections takes in order (BUG_SECTIONS), and the reporter's text (needed when `lists` names appBug)
//   onTicket, onExisting: the comments that link the card and the ticket
export function validateFindingCard(raw, fail) {
  if (raw === undefined || raw === null) return null;
  const shape = `tracker.findingCard must be { ${FINDING_CARD_KEYS.join(', ')} }`;
  if (!isMap(raw)) fail(shape);
  const unknown = Object.keys(raw).filter((k) => !FINDING_CARD_KEYS.includes(k));
  if (unknown.length) fail(`tracker.findingCard.${unknown[0]} is not a key: ${shape}`);
  const byKind = (k, ok, what) => {
    const v = raw[k] ?? {};
    if (!isMap(v) || Object.entries(v).some(([kind, x]) => !CARD_KINDS.includes(kind) || !ok(kind, x))) fail(`tracker.findingCard.${k} is { ${CARD_KINDS.join(', ')} }, each ${what}`);
    return { ...v };
  };
  const lists = byKind('lists', (_, x) => filled(x), 'the list its card goes to (a status, or a list of the board by its name)');
  const labels = byKind('labels', (kind, x) => names(x) || (kind === 'appBug' && isMap(x) && Object.entries(x).every(([s, l]) => ['all', ...SIDES].includes(s) && names(l))), `a list of label names (an app bug's may be { all, ${SIDES.join(', ')} })`);
  const kinds = byKind('kinds', (_, x) => filled(x), "the team's word for it");
  const apps = raw.apps ?? [];
  if (!names(apps)) fail('tracker.findingCard.apps is a list of app labels');
  const needs = { onTicket: true, onExisting: true, name: Boolean(lists.page || lists.ui), desc: Boolean(lists.page || lists.ui) };
  for (const [k, need] of Object.entries(NEEDS)) {
    if (raw[k] === undefined && !needs[k]) continue;
    if (!filled(raw[k])) fail(`tracker.findingCard.${k} is a text${k === 'name' || k === 'desc' ? ', needed when lists names page or ui' : ''}: ${shape}`);
    if (!raw[k].includes(`<${need}>`)) fail(`tracker.findingCard.${k} must have <${need}> in it, so the card and the ticket name each other`);
  }
  const templates = raw.templates ?? {};
  if (!isMap(templates) || Object.keys(templates).some((k) => k !== 'appBug')) fail('tracker.findingCard.templates is { appBug: { file, sections, reporter } }');
  let bug = null;
  if (templates.appBug !== undefined) {
    const t = templates.appBug;
    const where = 'tracker.findingCard.templates.appBug';
    if (!isMap(t) || Object.keys(t).some((k) => !['file', 'sections', 'reporter'].includes(k))) fail(`${where} is { file, sections, reporter }`);
    if (!filled(t.file)) fail(`${where}.file is the bug template's path from the host root`);
    if (!Array.isArray(t.sections) || t.sections.some((x) => !BUG_SECTIONS.includes(x)) || new Set(t.sections).size !== t.sections.length) fail(`${where}.sections is the field each ### section of the template takes, in order, each once: ${BUG_SECTIONS.join(', ')}`);
    const missing = BUG_REQUIRED.filter((x) => !t.sections.includes(x));
    if (missing.length) fail(`${where}.sections must have ${missing.join(' and ')}: a bug report says what is wrong and what is expected, and names the ticket it was found on`);
    if (!filled(t.reporter) || !t.reporter.includes('<ticket>')) fail(`${where}.reporter is the text of who found it, with <ticket> in it`);
    bug = { file: t.file.trim(), sections: [...t.sections], reporter: t.reporter };
  }
  if (lists.appBug && !bug) fail('tracker.findingCard.lists names appBug, so templates.appBug names the bug template');
  return { lists, labels, apps: [...apps], kinds, name: raw.name ?? null, desc: raw.desc ?? null, templates: bug ? { appBug: bug } : {}, onTicket: raw.onTicket, onExisting: raw.onExisting };
}

// The host's bug template: the fenced ```markdown block of the file, cut at its `---` line (what follows is
// instructions), its lead lines (before the first `###`) and its `###` headings in order. The example text under each
// heading is not kept. A file with no such block, or no heading in it, gives `{ error }`.
export function readBugTemplate(text) {
  const lines = String(text).split(/\r?\n/);
  const open = lines.findIndex((l) => /^\s*(`{3,}|~{3,})\s*(markdown|md)\s*$/i.test(l));
  if (open < 0) return { error: 'has no fenced markdown block' };
  const fence = lines[open].trim().match(/^(`{3,}|~{3,})/)[1];
  const lead = [];
  const headings = [];
  for (const l of lines.slice(open + 1)) {
    if (l.trim() === fence || /^\s*---\s*$/.test(l) || /^##\s/.test(l)) break;
    const h = l.match(/^###\s+(.+?)\s*$/);
    if (h) headings.push(h[1]);
    else if (!headings.length) lead.push(l);
  }
  if (!headings.length) return { error: 'has no ### section in its markdown block' };
  return { lead: lead.join('\n').trim(), headings };
}

// An app bug's description: the template's lead, then each section whose field the finding fills, in the template's
// order. `values`: the fields (`module`, `reporter`, `role`, `now`, `expected`, `repro`).
export function bugDescription(template, sections, values) {
  if (template.headings.length !== sections.length) return { error: `has ${template.headings.length} ### sections, and templates.appBug.sections names ${sections.length}` };
  const parts = template.lead ? [template.lead] : [];
  template.headings.forEach((h, i) => {
    const v = values[sections[i]];
    if (filled(v)) parts.push(`### ${h}\n${v.trim()}`);
  });
  return { desc: parts.join('\n\n') };
}

// ------------------------------------------------------------------ routing, after a step

// A card that no longer holds a finding: done. One out of the docs' scope still does (an app bug triaged away is known
// and decided: found again, it is linked, not raised again); one in a never-read status still does, but gets no comment
// unless the runner filed it there.
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
        const line = await route({ settings, clients, l, f, lines, at: new Date(now).toISOString(), events, keys, now });
        lines.push(line);
        routed.add(`${key}|${f.id}`);
      } catch (e) {
        events.push({ key, id: f.id, outcome: 'failed', note: `${f.id} «${f.title ?? f.text.slice(0, 60)}» was not routed: ${String(e.message ?? e).split('\n')[0]}` });
      }
    }
  }
  return events;
}

async function route({ settings, clients, l, f, lines, at, events, keys = [], now = Date.now() }) {
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
  // No card: the run report says why, with the open card that holds the finding, if one does.
  const unfiled = (why) => {
    const line = write({ ...base, outcome: 'unfiled', why, text: f.text ?? f.now, ...(held ? { held: card(held), by } : {}), ...(notes.length ? { notes } : {}) });
    events.push({ key, id: f.id, outcome: 'unfiled', note: `${f.id} «${f.title}»: no card, ${why}${held ? `; an open card holds it already: ${held.url}` : ''}` });
    return line;
  };
  if (!t) return unfiled('the host sets no card template (`tracker.findingCard`)');
  const ticketPr = f.pr ? (l.prs ?? []).find((p) => prId(p) === f.pr) : null;
  const values = {
    title: f.title,
    text: f.text ?? f.now,
    kind: t.kinds?.[f.kind] ?? f.kind,
    repo: f.repo ?? '',
    page: f.page ?? '',
    where: f.where ?? f.module ?? '',
    refs: (f.refs ?? []).join(', '),
    app: f.app ?? '',
    ticket: l.card?.url ?? '',
    ticketName: l.card?.name ?? '',
    pr: ticketPr?.url ?? '',
    card: '',
  };
  const ticketRef = l.card?.shortLink ?? l.card?.id ?? null;
  // The comments that link the two cards: one failed is a warning, never a second card (the line is written first).
  // Each goes into `posted.card` of the ticket whose card it is on, as the pipeline's own: no rule reads it as a person's.
  // Another ticket's ledger only while no other run holds its lock (its record could be lost under a write here).
  const comment = async (ref, text, what, ticket) => {
    try {
      const c = await tracker.comment({ card: ref, text });
      if (c.id && ticket) {
        const lock = keys.includes(ticket.key) ? null : lockOf(settings.state, ticket.group ?? ticket.key, now);
        if (!lock?.live) addPostedCard(settings, ticket.key, [c.id], now);
      }
      return true;
    } catch (e) {
      events.push({ key, id: f.id, outcome: 'failed', note: `${f.id}: the comment on ${what} was not posted: ${String(e.message ?? e).split('\n')[0]}` });
      return false;
    }
  };
  // The ticket a card is, if it has a ledger.
  const ticketOf = (c) => {
    try {
      const other = readLedger(settings.state, keyOf(c));
      return other && other.card?.id === c.id ? other : null;
    } catch {
      return null;
    }
  };
  if (held) {
    const line = write({ ...base, outcome: 'linked', card: card(held), by, ...(notes.length ? { notes } : {}) });
    // The module writes on the board only, and never on a card the settings keep unread, unless the runner filed it.
    const ours = lines.some((x) => x.outcome === 'filed' && x.card?.id === held.id);
    const onBoard = held.boardId === board && (!neverRead.includes(held.status) || ours);
    const linked = {
      ticket: ticketRef ? await comment(ticketRef, renderTemplate(t.onTicket, { ...values, card: held.url ?? held.shortLink }), "the ticket's card", l) : false,
      card: onBoard ? await comment(held.id, renderTemplate(t.onExisting, values), `the card ${held.url}`, ticketOf(held)) : false,
    };
    events.push({ key, id: f.id, outcome: 'linked', note: `${f.id} «${f.title}»: linked to the open card ${held.url} (${by})${onBoard ? '' : '; that card is on another board or kept unread, so only the ticket links it'}` });
    return { ...line, linked };
  }
  const list = t.lists?.[f.kind];
  if (!list) return unfiled(`the host names no list for ${f.kind} findings (\`tracker.findingCard.lists.${f.kind}\`)`);
  let name;
  let desc;
  if (f.kind === 'appBug') {
    // The host's bug template, read on each filing: a file that is gone or has no block files no card.
    const tpl = t.templates.appBug;
    let text;
    try {
      text = fs.readFileSync(path.resolve(settings.root, tpl.file), 'utf8');
    } catch (e) {
      return unfiled(`the bug template \`${tpl.file}\` can't be read (${e.code ?? e.message})`);
    }
    const parsed = readBugTemplate(text);
    const built = parsed.error ? parsed : bugDescription(parsed, tpl.sections, {
      module: f.module,
      reporter: renderTemplate(tpl.reporter, values),
      role: f.role,
      now: f.now,
      expected: f.expected,
      repro: [f.repro, ...(f.refs ?? [])].filter(Boolean).join('\n'),
    });
    if (built.error) return unfiled(`the bug template \`${tpl.file}\` ${built.error}`);
    [name, desc] = [f.title, built.desc];
  } else {
    [name, desc] = [renderTemplate(t.name, values).split('\n')[0] || f.title, renderTemplate(t.desc, values)];
  }
  // The kind's labels (an app bug's by its side), and the app's own label.
  const spec = t.labels?.[f.kind];
  const labels = [...new Set([...(Array.isArray(spec) ? spec : [...(spec?.all ?? []), ...(f.side ? spec?.[f.side] ?? [] : [])]), ...(f.app ? [f.app] : [])])];
  const made = await tracker.createCard({ list, name, desc, labels });
  const into = made.list?.name ?? list;
  const line = write({ ...base, outcome: 'filed', list: into, card: { id: made.id, shortLink: made.shortLink ?? null, url: made.url ?? null }, ...(labels.length ? { labels } : {}), ...(notes.length ? { notes } : {}) });
  const linked = { ticket: ticketRef ? await comment(ticketRef, renderTemplate(t.onTicket, { ...values, card: made.url ?? made.shortLink }), "the ticket's card", l) : false };
  events.push({ key, id: f.id, outcome: 'filed', note: `${f.id} «${f.title}»: filed in ${into}, ${made.url}` });
  return { ...line, linked };
}

// ------------------------------------------------------------------ what the sessions and the report are told

// The brief's lines on a stage whose session may come across one: what goes in `sideFindings`, the ticket's own
// findings so far (not to be given again), and the newest cards filed for earlier findings, for the session's own match.
export const FINDING_STAGES = ['plan', 'write', 'answerPass', 'pr', 'answerComments', 'styleCheck', 'uaReview', 'enReview', 'visualPack', 'translate', 'locales', 'align', 'labelSync'];
export function findingLines(step, settings, { cards = 15 } = {}) {
  if (!['writer', 'reviewer', 'translator'].includes(step.role) || !FINDING_STAGES.includes(step.stage)) return [];
  const t = settings.findingCard;
  const apps = knownApps(settings);
  const lists = CARD_KINDS.filter((k) => t?.lists?.[k]).map((k) => `${k} in «${t.lists[k]}»`);
  const out = [
    'Outside the ticket: a problem this ticket doesn\'t change (another page, a block of a changed page the ticket\'s change leaves alone, UI the ticket doesn\'t cover, an app bug) is no question, no place and no open item, and goes in no summary and not in the PR\'s description. Give it in the record\'s `sideFindings`:\n' +
      '- `{ "kind": "page", "title", "text", "repo", "page", "refs", "card" }`: another page, or a block the ticket leaves alone (`page` from the repo\'s root);\n' +
      '- `{ "kind": "ui", "title", "text", "where", "app", "refs", "card" }`: UI the ticket doesn\'t cover (`where`: the screen, the menu, the endpoint);\n' +
      `- \`{ "kind": "appBug", "title", "app", "side", "module", "role", "now", "expected", "repro", "refs", "card" }\`: only a clear defect of the UI or the backend that you have evidence for (the code, a response, the UI against the app's own strings); anything you are unsure of is a \`ui\` or \`page\` finding. \`title\` says the problem plainly; \`app\` is the app's label${apps.length ? ` (${apps.join(', ')})` : ''}; \`side\` is \`fe\` or \`be\`; \`module\` is the place inside the app, not the app's name; \`role\` is the role as the app names it, or that you didn't check it, never a guess; \`now\` (what is wrong) and \`expected\` (what should happen) are required; ids, JSON, SQL, account and card numbers go only in \`repro\` (the steps and the example).${t?.templates?.appBug ? ` The host's bug template, \`${t.templates.appBug.file}\`, says how each section is filled.` : ''}\n` +
      `The runner files each as a card${lists.length ? ` (${lists.join(', ')})` : ''}, linked to this ticket, or links the open card that holds it already: give that card's link as \`card\` when you know one. Never create a card yourself. Its words are a team text, in the team's language, naming no tool or model. What this ticket's pages depend on stays a question, even when its answer may be an app bug. A note for the owner that asks nothing is \`{ "kind": "note", "text" }\` there too: it goes to the run report, not the PR.`,
  ];
  let mine = [];
  try {
    mine = step.keys.flatMap((k) => (readLedger(settings.state, k)?.sideFindings ?? []).map((f) => ({ ...f, key: k })));
  } catch {
    /* an unreadable ledger: nothing listed */
  }
  if (mine.length) out.push(`Already recorded for this ticket (don't give them again): ${mine.map((f) => `${f.kind} «${f.title ?? (f.text ?? '').slice(0, 80)}»`).join('; ')}.`);
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
    if (x.outcome === 'filed') return `${x.ticket}: ${what}, filed${x.list ? ` in ${x.list}` : ''}: ${x.card.url}`;
    if (x.outcome === 'linked') return `${x.ticket}: ${what}, linked to the open card ${x.card.url} (${x.by})`;
    if (x.outcome === 'unfiled') return `${x.ticket}: ${what}: ${x.text}${/[.!?…]$/.test(x.text) ? '' : '.'} No card: ${x.why ?? 'the host sets no card template (`tracker.findingCard`)'}${x.held ? `; an open card holds it already: ${x.held.url}` : ''}`;
    return `${x.ticket}: ${what}`;
  };
  return ['## Findings outside the tickets', '', today.length ? today.map((x) => `- ${row(x)}${x.notes?.length ? ` (${x.notes.join('; ')})` : ''}`).join('\n') : '- none', ''];
}
