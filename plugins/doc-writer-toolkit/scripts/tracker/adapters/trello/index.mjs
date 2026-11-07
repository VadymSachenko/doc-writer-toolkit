import { Refusal } from '../../lib/errors.mjs';

// The Trello adapter: the only file that knows Trello's routes, field names and ids. It turns Trello's answers into
// the shapes `lib/adapter-contract.mjs` lists and takes the module's decisions as plain calls. A place is a Trello
// list. It decides nothing: the statuses, the guards and the idempotency checks are in `lib/tracker.mjs`.

const CARD_FIELDS = 'name,desc,idShort,shortLink,shortUrl,labels,idList,idBoard,idMembers,closed,dateLastActivity';
const MAX_PAGES = 200;
const LINK = /trello\.com\/c\/([A-Za-z0-9]{8})\b/g;

const cardUrl = (shortLink) => `https://trello.com/c/${shortLink}`;

// The leading `#NNNN - ` prefixes of a card name, in order, and the name without them. Copies carry two.
export function namePrefixes(name) {
  const numbers = [];
  let rest = String(name ?? '');
  for (;;) {
    const m = /^\s*#(\d+)\b\s*[-–—:]?\s*/.exec(rest);
    if (!m) break;
    numbers.push(Number(m[1]));
    rest = rest.slice(m[0].length);
  }
  return { numbers, stripped: rest };
}

function card(raw) {
  const { numbers } = namePrefixes(raw.name);
  return {
    id: raw.id,
    shortLink: raw.shortLink,
    url: raw.shortUrl || cardUrl(raw.shortLink),
    name: raw.name,
    number: numbers[0] ?? null,
    numbers,
    ...(raw.desc !== undefined ? { desc: raw.desc } : {}),
    labels: (raw.labels ?? []).map((l) => ({ id: l.id, name: l.name ?? '', color: l.color ?? null })),
    placeId: raw.idList,
    boardId: raw.idBoard,
    lastActivity: raw.dateLastActivity ?? null,
    createdAt: createdAt(raw.id),
    closed: Boolean(raw.closed),
    memberIds: Array.isArray(raw.idMembers) ? raw.idMembers : [],
  };
}

// When the card was made: a Trello id starts with the creation time, in seconds, as 8 hex digits.
export function createdAt(id) {
  if (!/^[0-9a-f]{24}$/.test(String(id ?? ''))) return null;
  return new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString();
}

const person = (m, id) => (m || id ? { id: m?.id ?? id, username: m?.username ?? null } : null);
const place = (p) => (p && p.id ? { id: p.id, name: p.name ?? null } : null);

// One Trello action in the module's shape. `text` is what a person wrote or named: a comment, a label, an attachment.
export function action(a) {
  const d = a.data ?? {};
  const old = d.old ?? {};
  let text = null;
  if (a.type === 'commentCard') text = d.text ?? null;
  else if (a.type === 'updateComment') text = d.action?.text ?? null;
  else if (/Label/.test(a.type)) text = d.label?.name ?? null;
  else if (/Attachment/.test(a.type)) text = d.attachment?.name ?? null;
  else if (/CheckItem/.test(a.type)) text = d.checkItem?.name ?? null;
  return {
    id: a.id,
    type: a.type,
    time: a.date,
    card: d.card?.id ? { id: d.card.id, shortLink: d.card.shortLink ?? null, name: d.card.name ?? null } : null,
    by: person(a.memberCreator, a.idMemberCreator),
    text,
    placeId: d.listAfter?.id ?? d.list?.id ?? null,
    placeBefore: place(d.listBefore),
    placeAfter: place(d.listAfter),
    changed: Object.keys(old),
    ...('closed' in old && typeof d.card?.closed === 'boolean' ? { closed: d.card.closed } : {}),
  };
}

function comment(a) {
  return {
    id: a.id,
    author: person(a.memberCreator, a.idMemberCreator),
    time: a.date,
    text: a.data?.text ?? '',
    edited: a.data?.dateLastEdited ?? null,
  };
}

export function createTrelloAdapter(client, { pageSize = 1000 } = {}) {
  // Pages through a Trello list endpoint, newest first, by the smallest id of each full page (the hub's method).
  async function paged(pathname, query) {
    const all = [];
    let before = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await client.get(pathname, { ...query, limit: pageSize, ...(before ? { before } : {}) });
      if (!Array.isArray(rows)) throw new Error(`${pathname}: unexpected answer`);
      all.push(...rows);
      if (rows.length < pageSize) return all;
      before = rows.reduce((min, row) => (row.id < min ? row.id : min), rows[0].id);
    }
    throw new Error(`${pathname}: more than ${MAX_PAGES} pages, giving up`);
  }

  return {
    kind: 'trello',

    // A card as the caller wrote it: the 24-character id, the 8-character short link, or the card's URL.
    cardRef(input) {
      const s = String(input ?? '').trim();
      if (/^[0-9a-f]{24}$/.test(s) || /^[A-Za-z0-9]{8}$/.test(s)) return s;
      const m = /trello\.com\/c\/([A-Za-z0-9]{8})(?:[/?#]|$)/.exec(s);
      if (m) return m[1];
      throw new Refusal('unknown', `'${s}' is not a card: give its id, its short link or its URL`);
    },

    async places(board) {
      const lists = await client.get(`/1/boards/${board}/lists`, { filter: 'open', fields: 'name,closed,pos' });
      return lists.map((l) => ({ id: l.id, name: l.name }));
    },

    async cardsIn(placeId) {
      const rows = await client.get(`/1/lists/${placeId}/cards`, { fields: CARD_FIELDS });
      return rows.map(card);
    },

    async card(ref) {
      return card(await client.get(`/1/cards/${ref}`, { fields: CARD_FIELDS }));
    },

    // Every card of a board, archived included, without descriptions.
    async allCards(board) {
      const rows = await paged(`/1/boards/${board}/cards/all`, { fields: 'name,idShort,shortLink,shortUrl,labels,idList,idBoard,closed,dateLastActivity' });
      return rows.map(card);
    },

    // The card with what hangs on it: comments (all of them), attachments, checklists, the moves between lists, and
    // the links to other cards found in the description, the comments, the checklists and the attachments.
    async cardDetail(ref) {
      const raw = await client.get(`/1/cards/${ref}`, {
        fields: CARD_FIELDS,
        attachments: 'true',
        attachment_fields: 'name,url,mimeType,bytes,isUpload,date',
        checklists: 'all',
        checklist_fields: 'name,idCard',
      });
      const comments = (await paged(`/1/cards/${raw.id}/actions`, { filter: 'commentCard' })).map(comment).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      const moves = (await paged(`/1/cards/${raw.id}/actions`, { filter: 'updateCard:idList' }))
        .filter((a) => a.data?.listBefore && a.data?.listAfter)
        .map((a) => ({ time: a.date, from: place(a.data.listBefore), to: place(a.data.listAfter) }))
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      const attachments = (raw.attachments ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url ?? null,
        mimeType: a.mimeType ?? null,
        bytes: a.bytes ?? null,
        isUpload: Boolean(a.isUpload),
        date: a.date ?? null,
      }));
      const checklists = (raw.checklists ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        items: (c.checkItems ?? []).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)).map((i) => ({ id: i.id, name: i.name, state: i.state })),
      }));

      const links = new Map();
      const scan = (where, text) => {
        for (const m of String(text ?? '').matchAll(LINK)) {
          if (m[1] === raw.shortLink) continue;
          const entry = links.get(m[1]) ?? { shortLink: m[1], url: cardUrl(m[1]), in: [] };
          if (!entry.in.includes(where)) entry.in.push(where);
          links.set(m[1], entry);
        }
      };
      scan('description', raw.desc);
      for (const c of comments) scan('comment', c.text);
      for (const c of checklists) for (const i of c.items) scan('checklist', i.name);
      for (const a of attachments) scan('attachment', `${a.url ?? ''} ${a.name ?? ''}`);

      return { card: card(raw), comments, attachments, checklists, moves, links: [...links.values()] };
    },

    async comments(ref) {
      const rows = await paged(`/1/cards/${ref}/actions`, { filter: 'commentCard' });
      return rows.map(comment);
    },

    async attachments(ref) {
      const rows = await client.get(`/1/cards/${ref}/attachments`, { fields: 'name,url,mimeType,bytes,isUpload,date' });
      return rows.map((a) => ({ id: a.id, name: a.name, url: a.url ?? null, mimeType: a.mimeType ?? null, bytes: a.bytes ?? null, isUpload: Boolean(a.isUpload), date: a.date ?? null }));
    },

    async labels(board) {
      const rows = await client.get(`/1/boards/${board}/labels`, { fields: 'name,color', limit: 1000 });
      return rows.map((l) => ({ id: l.id, name: l.name ?? '', color: l.color ?? null }));
    },

    async members(board) {
      const rows = await client.get(`/1/boards/${board}/members`, { fields: 'username,fullName' });
      return rows.map((m) => ({ id: m.id, username: m.username ?? '', name: m.fullName ?? null }));
    },

    // The board's actions since a time (an ISO date), oldest first. `types` narrows them (Trello's filter).
    async actions(board, { since, types }) {
      const rows = await paged(`/1/boards/${board}/actions`, { since, ...(types ? { filter: types.join(',') } : {}) });
      const seen = new Set();
      return rows
        .filter((a) => !seen.has(a.id) && seen.add(a.id))
        .map(action)
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1));
    },

    download: (url, dest) => client.download(url, dest),

    // Writes. Each goes through client.write, so a dry run stops them all.
    async comment(ref, text) {
      const a = await client.write('POST', `/1/cards/${ref}/actions/comments`, { text }, { data: { text } });
      return { id: a.id, time: a.date };
    },
    async moveCard(ref, placeId) {
      await client.write('PUT', `/1/cards/${ref}`, { idList: placeId, pos: 'top' });
    },
    async addLabel(ref, labelId) {
      await client.write('POST', `/1/cards/${ref}/idLabels`, { value: labelId });
    },
    async removeLabel(ref, labelId) {
      await client.write('DELETE', `/1/cards/${ref}/idLabels/${labelId}`);
    },
    async addMember(ref, memberId) {
      await client.write('POST', `/1/cards/${ref}/idMembers`, { value: memberId });
    },
    async setDescription(ref, text) {
      await client.write('PUT', `/1/cards/${ref}`, { desc: text });
    },
    async createCard({ placeId, name, desc, labelIds }) {
      const c = await client.write(
        'POST',
        '/1/cards',
        { idList: placeId, name, desc, ...(labelIds.length ? { idLabels: labelIds.join(',') } : {}), pos: 'bottom' },
        { shortLink: 'dryrun00', shortUrl: cardUrl('dryrun00') },
      );
      return { id: c.id, shortLink: c.shortLink, url: c.shortUrl || cardUrl(c.shortLink) };
    },
  };
}
