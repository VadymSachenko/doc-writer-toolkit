import fs from 'node:fs';
import path from 'node:path';
import { CliError, Refusal, TrackerError } from './errors.mjs';
import { assertAdapter } from './adapter-contract.mjs';
import { withHeader, withoutHeader } from './comment-header.mjs';

// The tracker module, in statuses and transitions. It owns every decision and calls an adapter (see
// `adapter-contract.mjs`) for the tracker's own API. Nothing here knows Trello.
//
// The rules held here, whatever the adapter:
//   - a status is named in the host's settings and mapped to places by name, resolved on each run; a name that
//     matches no place stops the run;
//   - `listCards`, `readCard` and `downloadAttachment` refuse a status the settings mark `neverRead`;
//   - `move` runs only a (from, to) pair the settings list in `transitions`;
//   - `createCard` creates only in the `intake` status;
//   - an empty comment or description is refused;
//   - every comment starts with the settings' `commentHeader`, when they set one, and a comment is looked up by its
//     first words without it (lib/comment-header.mjs);
//   - only the people the settings name (`tracker.owner`, the targets' `cardMembers`) are added to a card, and each
//     must be a member of the board, resolved with the statuses: a name that matches no member stops the run;
//   - no operation archives, deletes or renames a card, or removes anyone from it;
//   - `markComment` takes off only the reactions the credentials' own person put, and only those of the marks.

const ZWNJ = /‌/g;
// U+200C is kept in stored text and stripped only to compare (or to see that a text is empty).
const bare = (text) => String(text ?? '').replace(ZWNJ, '').trim();
const norm = (name) => String(name ?? '').replace(ZWNJ, '').replace(/\s+/g, ' ').trim().toLowerCase();

const patternOf = (name) => new RegExp(`^${norm(name).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const isPattern = (name) => name.includes('*');

// Maps the settings' statuses onto the places a board has. Exact names claim a place before patterns do; a place
// belongs to the first status that claims it. `target` is where a move into the status goes: the place of the
// status's first name that is not a pattern, never a pattern's match.
export function resolveStatuses(statuses, places) {
  const unresolved = [];
  const claimed = new Map(); // place id -> status
  const resolved = Object.fromEntries(Object.keys(statuses).map((s) => [s, { names: statuses[s], places: [], target: null }]));
  const matches = (name) => places.filter((p) => patternOf(name).test(norm(p.name)));

  for (const [status, names] of Object.entries(statuses)) {
    for (const name of names) if (!matches(name).length) unresolved.push({ status, name });
  }
  if (unresolved.length) {
    throw new CliError(`no list matches ${unresolved.map((u) => `'${u.name}' (status ${u.status})`).join(', ')}. Fix the settings or the board.`, {
      code: 2,
      data: { unresolved },
    });
  }
  for (const wantPatterns of [false, true]) {
    for (const [status, names] of Object.entries(statuses)) {
      for (const name of names.filter((n) => isPattern(n) === wantPatterns)) {
        for (const p of matches(name)) {
          if (claimed.has(p.id)) continue;
          claimed.set(p.id, status);
          resolved[status].places.push(p);
        }
      }
    }
  }
  for (const [status, names] of Object.entries(statuses)) {
    const first = names.find((n) => !isPattern(n));
    resolved[status].target = first ? matches(first)[0] : null;
    // keep the board's order
    resolved[status].places.sort((a, b) => places.findIndex((p) => p.id === a.id) - places.findIndex((p) => p.id === b.id));
  }
  return { statuses: resolved, statusOfPlace: claimed, places };
}

// Maps the people the settings name (`[{ name, where }]`) onto the board's members, by username, without case or a
// leading `@`. A name that matches no member stops the run, as a list name does.
const userKey = (name) => String(name ?? '').replace(ZWNJ, '').trim().replace(/^@/, '').toLowerCase();
export function resolveMembers(spec, boardMembers) {
  const unresolved = spec.filter((m) => !boardMembers.some((b) => userKey(b.username) === userKey(m.name)));
  if (unresolved.length) {
    throw new CliError(`no board member matches ${unresolved.map((u) => `'${u.name}' (${u.where})`).join(', ')}. Fix the settings or the board.`, {
      code: 2,
      data: { unresolvedMembers: unresolved },
    });
  }
  return new Map(spec.map((m) => [userKey(m.name), boardMembers.find((b) => userKey(b.username) === userKey(m.name))]));
}

export const PRIORITIES = ['high', 'medium', 'low'];

// The status marks the ticket flow puts on a comment it took (its reactions): picked up, applied, asked back or not
// done. The adapter says which reaction stands for each on its tracker.
export const MARKS = ['seen', 'applied', 'asked'];

// A card's priority: the tracker's own field when the adapter gives one (Jira), else the labels the settings name
// (`priority: { high, low }`). Neither is medium; a card with both labels is high.
export function priorityOf(card, names = { high: 'high', low: 'low' }) {
  if (PRIORITIES.includes(card.priority)) return card.priority;
  const has = (name) => (card.labels ?? []).some((l) => norm(l.name) === norm(name));
  if (has(names.high)) return 'high';
  if (has(names.low)) return 'low';
  return 'medium';
}

export function createTracker({ adapter, tracker, dryRun = false, now = () => Date.now() }) {
  assertAdapter(adapter);
  const { board, statuses: statusSpec, neverRead, transitions, labels: labelNames } = tracker;
  const memberSpec = tracker.members ?? [];
  const owner = tracker.owner ?? null;
  const priorityNames = tracker.priority ?? { high: 'high', low: 'low' };
  const header = tracker.commentHeader ?? null;
  const boards = [board, ...tracker.watchBoards];

  const knownStatus = (status) => {
    if (!(status in statusSpec)) throw new Refusal('unknown', `'${status}' is not a status in the settings. Known: ${Object.keys(statusSpec).join(', ')}.`);
    return status;
  };
  const checkBoard = (id) => {
    if (!boards.includes(id)) throw new Refusal('notAllowed', `board ${id} is not the board or a watched board in the settings`);
    return id;
  };

  let resolution = null;
  // The lists, and the people the settings name, once per run. The board's members are read only when the settings name
  // someone.
  const resolve = async () => {
    if (!resolution) {
      const res = resolveStatuses(statusSpec, await adapter.places(board));
      res.members = memberSpec.length ? resolveMembers(memberSpec, await adapter.members(board)) : new Map();
      resolution = res;
    }
    return resolution;
  };
  // The person the credentials act as, once per run: the pipeline's own reactions are theirs.
  let self = null;
  const me = async () => (self ??= await adapter.me());
  const statusOf = (res, placeId) => res.statusOfPlace.get(placeId) ?? null;
  const placeName = (res, placeId) => res.places.find((p) => p.id === placeId)?.name ?? null;

  // A card as the caller sees it: its status, and the list it stands in.
  const present = (res, card, { desc = true } = {}) => {
    const onBoard = card.boardId === board;
    const { placeId, boardId, ...rest } = card;
    if (!desc) delete rest.desc;
    return {
      ...rest,
      priority: priorityOf(card, priorityNames),
      boardId,
      status: onBoard ? statusOf(res, placeId) : null,
      list: { id: placeId, name: onBoard ? placeName(res, placeId) : null },
    };
  };
  const refuseIfNeverRead = (res, card, what) => {
    const status = card.boardId === board ? statusOf(res, card.placeId) : null;
    if (status && neverRead.includes(status)) {
      throw new Refusal('neverRead', `${what} refused: the card is in '${status}', which the settings mark neverRead`, { status });
    }
  };
  const need = async (input) => {
    const ref = adapter.cardRef(input);
    const res = await resolve();
    const card = await adapter.card(ref);
    return { ref: card.id, card, res };
  };

  // Labels, by name on the card's board. A key of the settings' `labels` stands for the label name it maps to.
  const labelIds = async (boardId, wanted) => {
    const all = await adapter.labels(boardId);
    return wanted.map((raw) => {
      const name = labelNames[raw] ?? raw;
      if (!bare(name)) throw new Refusal('unknown', 'a label needs a name');
      // An exact name wins; otherwise names are compared without case and spacing.
      const exact = all.filter((l) => l.name.trim() === name.trim());
      const hits = exact.length === 1 ? exact : all.filter((l) => norm(l.name) === norm(name));
      if (!hits.length) throw new Refusal('unknown', `no label '${name}' on the board`, { label: name });
      if (hits.length > 1) throw new Refusal('ambiguous', `${hits.length} labels named '${name}' on the board`, { label: name });
      return { ...hits[0], asked: raw };
    });
  };

  // A person to add: `owner` stands for `tracker.owner`; any other name must be one the settings name.
  const memberOf = (res, wanted) => {
    if (!bare(wanted)) throw new CliError('a member is needed (--member): a username the settings name, or owner', { code: 2 });
    const name = String(wanted).trim() === 'owner' ? owner : String(wanted);
    if (!name) throw new Refusal('unknown', 'the settings name no owner (tracker.owner)');
    const m = res.members.get(userKey(name));
    if (!m) throw new Refusal('notAllowed', `'${wanted}' is not a person the settings name (tracker.owner, the targets' cardMembers)`, { member: String(wanted) });
    return m;
  };

  const sinceOf = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (Number.isNaN(Date.parse(value))) throw new CliError(`'${value}' is not a time: give an ISO date such as 2026-11-04T08:00:00Z`, { code: 2 });
    return new Date(value).toISOString();
  };

  return {
    dryRun,

    // The settings' statuses resolved to the board's lists (no card is read).
    async statuses() {
      const res = await resolve();
      return {
        board,
        statuses: Object.entries(res.statuses).map(([status, s]) => ({
          status,
          names: s.names,
          lists: s.places,
          target: s.target,
          neverRead: neverRead.includes(status),
        })),
        unmapped: res.places.filter((p) => !res.statusOfPlace.has(p.id)),
        transitions,
        ...(memberSpec.length ? { members: memberSpec.map((m) => ({ name: m.name, where: m.where, id: res.members.get(userKey(m.name)).id, username: res.members.get(userKey(m.name)).username })) } : {}),
      };
    },

    async listCards({ status }) {
      knownStatus(status);
      if (neverRead.includes(status)) throw new Refusal('neverRead', `'${status}' is never listed: the settings mark it neverRead`, { status });
      const res = await resolve();
      const cards = [];
      for (const p of res.statuses[status].places) for (const c of await adapter.cardsIn(p.id)) cards.push(present(res, c));
      return { status, lists: res.statuses[status].places, count: cards.length, cards };
    },

    // The open cards of a list on a watched board, by the list's name (`*` allowed). The board in the settings is read
    // by status only (`listCards`), so its neverRead statuses stay unread.
    async listCardsOn({ board: wanted, list }) {
      const b = checkBoard(wanted);
      if (b === board) throw new Refusal('notAllowed', 'the board in the settings is read by status (--status), not by list name');
      if (!bare(list)) throw new CliError('listCardsOn needs a list name (--list)', { code: 2 });
      const places = (await adapter.places(b)).filter((p) => patternOf(list).test(norm(p.name)));
      if (!places.length) throw new Refusal('unknown', `no list '${list}' on board ${b}`, { list });
      const cards = [];
      for (const p of places) {
        for (const c of await adapter.cardsIn(p.id)) {
          const { placeId, ...rest } = c;
          cards.push({ ...rest, priority: priorityOf(c, priorityNames), status: null, list: { id: placeId, name: p.name } });
        }
      }
      return { board: b, lists: places, count: cards.length, cards };
    },

    async readCard({ card: input }) {
      const { ref, card, res } = await need(input);
      refuseIfNeverRead(res, card, 'readCard');
      const d = await adapter.cardDetail(ref);
      const withStatus = (p) => (p ? { ...p, status: statusOf(res, p.id) } : null);
      return {
        ...present(res, d.card),
        comments: d.comments,
        attachments: d.attachments,
        checklists: d.checklists,
        links: d.links,
        moves: d.moves.map((m) => ({ time: m.time, from: withStatus(m.from), to: withStatus(m.to) })),
      };
    },

    // By the team's number (the first `#NNNN` of the name) or by a link to the original; archived cards too.
    async findCards({ number, link, boards: wanted }) {
      if ((number === undefined || number === null) === !link) throw new CliError('findCards needs exactly one of number or link', { code: 2 });
      const res = await resolve();
      const where = (wanted?.length ? wanted : [board]).map(checkBoard);
      const out = [];
      if (link) {
        const ref = adapter.cardRef(link);
        let c;
        try {
          c = await adapter.card(ref);
        } catch (e) {
          if (e.data?.status === 404) return { query: { link }, count: 0, cards: [] };
          throw e;
        }
        const names = c.boardId === board ? res.places : await adapter.places(c.boardId).catch(() => []);
        out.push(foundCard(res, c, names));
      } else {
        const n = Number(number);
        if (!Number.isInteger(n) || n < 0) throw new CliError(`'${number}' is not a card number`, { code: 2 });
        for (const b of where) {
          const names = b === board ? res.places : await adapter.places(b);
          for (const c of await adapter.allCards(b)) if (c.number === n) out.push(foundCard(res, c, names));
        }
      }
      return { query: link ? { link } : { number: Number(number), boards: where }, count: out.length, cards: out };
    },

    // The board's actions since a time, oldest first, with the status each move came from and went to. Actions on a
    // card that stands in a neverRead status are left out and counted.
    async actionsSince({ since, board: wanted, types }) {
      const from = sinceOf(since);
      if (!from) throw new CliError('actionsSince needs a time (--since)', { code: 2 });
      const b = checkBoard(wanted ?? board);
      const res = await resolve();
      const mine = b === board;
      const rows = await adapter.actions(b, { since: from, ...(types?.length ? { types } : {}) });
      let skipped = 0;
      const actions = [];
      for (const a of rows) {
        const status = mine && a.placeId ? statusOf(res, a.placeId) : null;
        if (status && neverRead.includes(status)) {
          skipped++;
          continue;
        }
        const { placeId, placeBefore, placeAfter, ...rest } = a;
        actions.push({
          ...rest,
          list: placeId ? { id: placeId, name: placeAfter?.name ?? (mine ? placeName(res, placeId) : null) } : null,
          status,
          statusBefore: mine && placeBefore ? statusOf(res, placeBefore.id) : null,
          statusAfter: mine && placeAfter ? statusOf(res, placeAfter.id) : null,
          listBefore: placeBefore,
          listAfter: placeAfter,
        });
      }
      return { board: b, since: from, count: actions.length, skippedNeverRead: skipped, actions };
    },

    async downloadAttachment({ card: input, attachment, out, overwrite = false }) {
      if (!out) throw new CliError('downloadAttachment needs a destination path (--out)', { code: 2 });
      if (!attachment) throw new CliError('downloadAttachment needs an attachment (--attachment: its id or its exact name)', { code: 2 });
      const { ref, card, res } = await need(input);
      refuseIfNeverRead(res, card, 'downloadAttachment');
      const all = await adapter.attachments(ref);
      const hits = all.filter((a) => a.id === attachment);
      const named = hits.length ? hits : all.filter((a) => a.name === attachment);
      if (!named.length) throw new Refusal('unknown', `the card has no attachment '${attachment}'`, { attachments: all.map((a) => ({ id: a.id, name: a.name })) });
      if (named.length > 1) throw new Refusal('ambiguous', `${named.length} attachments are named '${attachment}': give the id`, { ids: named.map((a) => a.id) });
      const [att] = named;
      if (!att.isUpload) throw new Refusal('unknown', `'${att.name}' is a link, not an uploaded file`, { attachment: att.id });
      const dest = path.resolve(out);
      if (!overwrite && fs.existsSync(dest)) throw new Refusal('notAllowed', `${dest} exists; pass --overwrite to replace it`);
      if (!fs.existsSync(path.dirname(dest))) throw new Refusal('notAllowed', `the folder ${path.dirname(dest)} does not exist`);
      if (dryRun) return { card: card.id, attachment: pickAttachment(att), path: dest, bytes: null };
      const { bytes } = await adapter.download(att.url, dest);
      return { card: card.id, attachment: pickAttachment(att), path: dest, bytes, ...(att.bytes && att.bytes !== bytes ? { warning: `the card says ${att.bytes} bytes, the file has ${bytes}` } : {}) };
    },

    // `unlessHeader`: skip the comment when the card already has one (since `since`) that starts with this header. Both
    // are read without the comment header, so a comment from before the header existed counts too.
    async comment({ card: input, text, unlessHeader, since }) {
      if (!bare(withoutHeader(text, header))) throw new Refusal('empty', 'an empty comment is refused');
      const { ref, card } = await need(input);
      if (unlessHeader) {
        const from = sinceOf(since);
        const first = bare(withoutHeader(unlessHeader, header));
        if (!first) throw new Refusal('empty', "the header to look for is the comment header alone: give the message's first line");
        const existing = (await adapter.comments(ref)).find((c) => (!from || c.time >= from) && bare(withoutHeader(c.text, header)).startsWith(first));
        if (existing) return { card: card.id, commented: false, reason: 'a comment with this header is already there', existing: existing.id };
      }
      const made = await adapter.comment(ref, withHeader(text, header));
      return { card: card.id, commented: true, id: made.id, time: made.time };
    },

    async move({ card: input, to }) {
      knownStatus(to);
      const { ref, card, res } = await need(input);
      if (card.boardId !== board) throw new Refusal('outsideFlow', 'the card is not on the board in the settings', { boardId: card.boardId });
      if (card.closed) throw new Refusal('archived', 'the card is archived; it is not moved');
      const target = res.statuses[to].target;
      if (!target) throw new Refusal('unknown', `status '${to}' names no list without a pattern, so there is no list to move into`, { status: to });
      const from = statusOf(res, card.placeId);
      if (card.placeId === target.id) return { card: card.id, moved: false, reason: 'the card is already in that list', from, to, list: target };
      if (!from) throw new Refusal('outsideFlow', `the card stands in '${placeName(res, card.placeId) ?? card.placeId}', a list outside the flow: not moved`, { list: placeName(res, card.placeId) });
      if (!transitions.some(([f, t]) => f === from && t === to)) {
        throw new Refusal('transition', `${from} -> ${to} is not a transition in the settings`, { from, to });
      }
      await adapter.moveCard(ref, target.id);
      return { card: card.id, moved: true, from, to, list: target };
    },

    async addLabel({ card: input, label }) {
      const { ref, card } = await need(input);
      const [l] = await labelIds(card.boardId, [label]);
      if (card.labels.some((x) => x.id === l.id)) return { card: card.id, label: l.name, changed: false, reason: 'the card already has the label' };
      await adapter.addLabel(ref, l.id);
      return { card: card.id, label: l.name, changed: true };
    },

    async removeLabel({ card: input, label }) {
      const { ref, card } = await need(input);
      const [l] = await labelIds(card.boardId, [label]);
      if (!card.labels.some((x) => x.id === l.id)) return { card: card.id, label: l.name, changed: false, reason: 'the card does not have the label' };
      await adapter.removeLabel(ref, l.id);
      return { card: card.id, label: l.name, changed: true };
    },

    // A person the settings name, onto the card. One already on it is no change; no call removes anyone.
    async addMember({ card: input, member }) {
      const { ref, card, res } = await need(input);
      const m = memberOf(res, member);
      if (card.boardId !== board) throw new Refusal('outsideFlow', 'the card is not on the board in the settings', { boardId: card.boardId });
      if (card.closed) throw new Refusal('archived', 'the card is archived; no one is added');
      if ((card.memberIds ?? []).includes(m.id)) return { card: card.id, member: m.username, changed: false, reason: 'the person is already on the card' };
      await adapter.addMember(ref, m.id);
      return { card: card.id, member: m.username, changed: true };
    },

    // Whether a person the settings name is on the card (no change).
    async hasMember({ card: input, member }) {
      const { card, res } = await need(input);
      const m = memberOf(res, member);
      return { card: card.id, member: m.username, on: (card.memberIds ?? []).includes(m.id) };
    },

    // The text is sent as given (U+200C kept). An empty text is refused: a PUT with it once blanked a description.
    async setDescription({ card: input, text }) {
      if (!bare(text)) throw new Refusal('empty', 'an empty description is refused');
      const { ref, card } = await need(input);
      if (card.desc === text) return { card: card.id, changed: false, reason: 'the description is already this text' };
      await adapter.setDescription(ref, text);
      return { card: card.id, changed: true };
    },

    // The pipeline's mark on one comment of the card: its reaction for `mark` put on (one there already is no change),
    // and its own reactions for the other marks taken off. Anyone else's reactions, and its own that stand for no mark,
    // stay. The ticket flow's runner calls it; the CLI has no command for it.
    async markComment({ card: input, comment, mark }) {
      if (!MARKS.includes(mark)) throw new Refusal('unknown', `'${mark}' is not a mark. Known: ${MARKS.join(', ')}.`, { mark: mark ?? null });
      if (!bare(comment)) throw new CliError('markComment needs the comment (its id)', { code: 2 });
      const { card, res } = await need(input);
      refuseIfNeverRead(res, card, 'markComment');
      const who = await me();
      const mine = (await adapter.reactions(String(comment))).filter((r) => r.memberId === who.id);
      const added = mine.some((r) => r.mark === mark) ? [] : [mark];
      const others = mine.filter((r) => r.mark !== mark);
      if (added.length) await adapter.addReaction(String(comment), mark);
      for (const r of others) await adapter.removeReaction(String(comment), r.id);
      return { card: card.id, comment: String(comment), mark, added, removed: others.map((r) => r.mark), changed: Boolean(added.length || others.length) };
    },

    // Only the `intake` status: a card that people made lands there and the triage reads it.
    async createCard({ status, name, desc = '', labels = [] }) {
      if (status !== 'intake') throw new Refusal('intake', `cards are created only in the 'intake' status, not '${status ?? ''}'`, { status: status ?? null });
      if (!('intake' in statusSpec)) throw new Refusal('intake', "the settings have no 'intake' status");
      if (!bare(name)) throw new Refusal('empty', 'a card needs a name');
      const res = await resolve();
      const target = res.statuses.intake.target;
      if (!target) throw new Refusal('intake', "the 'intake' status names no list without a pattern");
      const picked = await labelIds(board, labels);
      const made = await adapter.createCard({ placeId: target.id, name, desc, labelIds: picked.map((l) => l.id) });
      return { id: made.id, shortLink: made.shortLink, url: made.url, status: 'intake', list: target, labels: picked.map((l) => l.name) };
    },
  };

  function foundCard(res, card, names) {
    const onBoard = card.boardId === board;
    const { placeId, desc, ...rest } = card;
    return {
      ...rest,
      priority: priorityOf(card, priorityNames),
      status: onBoard ? statusOf(res, placeId) : null,
      list: { id: placeId, name: names.find((p) => p.id === placeId)?.name ?? null },
    };
  }
}

const pickAttachment = (a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, bytes: a.bytes });

export { TrackerError };
