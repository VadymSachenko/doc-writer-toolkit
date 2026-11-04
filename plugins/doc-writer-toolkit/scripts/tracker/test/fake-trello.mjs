import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A stand-in for Trello on 127.0.0.1, serving the recorded-shape responses in ./fixtures (invented data, in the shape
// Trello answers with). It records every request, answers the routes the tracker uses, and keeps a little state so a
// write is visible to the next read.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KEY = 'test-key-0123456789abcdef';
export const TOKEN = 'test-token-fedcba9876543210';
export const BOARD = '5f00000000000000000d0001';
export const WATCH = '5f00000000000000000d0002';
export const L = {
  inbox: '5f00000000000000000a0001', drafts: '5f00000000000000000a0002', ready: '5f00000000000000000a0003', doing: '5f00000000000000000a0004',
  blocked: '5f00000000000000000a0005', sme: '5f00000000000000000a0006', final: '5f00000000000000000a0007', finished: '5f00000000000000000a0008',
  octDone: '5f00000000000000000a0009', sepDone: '5f00000000000000000a000a', notNeeded: '5f00000000000000000a000b', bugs: '5f00000000000000000a000c',
};
export const C = { inbox1: '5f00000000000000000c0001', inbox2: '5f00000000000000000c0002', doing: '5f00000000000000000c0003', archived: '5f00000000000000000c0004', draft: '5f00000000000000000c0005', orig: '5f00000000000000000c0006' };

export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', `${name}.json`), 'utf8'));

// The host settings the tests share (the tracker part of the ticket flow settings).
export const trackerSettings = (extra = {}) => ({
  kind: 'trello',
  credentials: { envFile: '.env', key: 'TEST_TRACKER_KEY', token: 'TEST_TRACKER_TOKEN' },
  board: BOARD,
  watchBoards: [WATCH],
  statuses: {
    intake: ['Inbox'], drafts: ['Drafts'], ready: ['Ready'], inProgress: ['Doing'], blocked: ['Blocked'], smeReview: ['SME check'],
    finalReview: ['Final check'], done: ['Finished', 'Closed*'], outOfScope: ['Not needed'],
  },
  neverRead: ['drafts'],
  transitions: [['intake', 'ready'], ['intake', 'outOfScope'], ['ready', 'inProgress'], ['inProgress', 'blocked'], ['blocked', 'inProgress'], ['inProgress', 'finalReview'], ['finalReview', 'done'], ['intake', 'done']],
  labels: { needsAnswer: 'needs answer' },
  ...extra,
});

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startFake({ onRequest } = {}) {
  const requests = [];
  const state = { cardList: { [C.inbox1]: L.inbox, [C.inbox2]: L.inbox, [C.doing]: L.doing }, labels: { [C.doing]: ['5f00000000000000000b0002'] }, desc: {}, nextId: 1 };
  const behaviour = { throttle: 0, throttleStatus: 429 }; // answer this many requests with 429 first
  let origin = '';

  const cards = () => {
    const all = [...fixture('cards-inbox'), ...fixture('cards-doing')];
    all.push({ id: C.archived, name: '#2003 - Archived card', desc: '', shortLink: 'Arch0004', shortUrl: 'https://trello.com/c/Arch0004', idShort: 44, labels: [], idList: L.finished, idBoard: BOARD, closed: true, dateLastActivity: '2026-10-01T00:00:00.000Z' });
    all.push({ id: C.draft, name: '#2004 - Hidden draft', desc: 'private plans', shortLink: 'Drft0005', shortUrl: 'https://trello.com/c/Drft0005', idShort: 45, labels: [], idList: L.drafts, idBoard: BOARD, closed: false, dateLastActivity: '2026-10-02T00:00:00.000Z' });
    for (const c of all) {
      if (state.cardList[c.id]) c.idList = state.cardList[c.id];
      if (state.desc[c.id] !== undefined) c.desc = state.desc[c.id];
      if (state.labels[c.id]) {
        const known = fixture('labels');
        c.labels = state.labels[c.id].map((id) => known.find((l) => l.id === id));
      }
    }
    return all;
  };
  const watchCards = () => [{ id: C.orig, name: '#2001 - Rename a field', desc: 'the original', shortLink: 'Orig0001', shortUrl: 'https://trello.com/c/Orig0001', idShort: 7, labels: [], idList: '5f00000000000000000a0101', idBoard: WATCH, closed: false, dateLastActivity: '2026-10-30T00:00:00.000Z' }];
  const findCard = (ref) => [...cards(), ...watchCards()].find((c) => c.id === ref || c.shortLink === ref);

  // Newest first, as Trello answers; `before` is an id, `limit` a count.
  const page = (rows, q) => {
    let out = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1));
    if (q.get('before')) out = out.filter((r) => r.id < q.get('before'));
    return out.slice(0, Number(q.get('limit') ?? 1000));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks).toString();
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)), url: req.url, body };
      requests.push(record);
      if (behaviour.throttle > 0) {
        behaviour.throttle--;
        return json(res, behaviour.throttleStatus, { message: 'slow down' });
      }
      const custom = onRequest?.(record, { res, json: (s, b) => (json(res, s, b), true), origin, state });
      if (custom !== undefined) return custom;
      const q = url.searchParams;
      const p = url.pathname;
      let m;
      if (req.method === 'GET') {
        if ((m = /^\/1\/boards\/([^/]+)\/lists$/.exec(p))) return json(res, 200, m[1] === BOARD ? fixture('lists') : [{ id: '5f00000000000000000a0101', name: 'Shipped' }]);
        if ((m = /^\/1\/lists\/([^/]+)\/cards$/.exec(p))) return json(res, 200, cards().filter((c) => c.idList === m[1] && !c.closed));
        if ((m = /^\/1\/boards\/([^/]+)\/cards\/all$/.exec(p))) return json(res, 200, page(m[1] === BOARD ? cards() : watchCards(), q));
        if ((m = /^\/1\/boards\/([^/]+)\/labels$/.exec(p))) return json(res, 200, fixture('labels'));
        if ((m = /^\/1\/boards\/([^/]+)\/actions$/.exec(p))) {
          const since = q.get('since');
          const rows = m[1] === BOARD ? fixture('board-actions').filter((a) => !since || a.date >= since) : [];
          return json(res, 200, page(rows, q));
        }
        if ((m = /^\/1\/cards\/([^/]+)\/actions$/.exec(p))) {
          const rows = fixture(q.get('filter') === 'commentCard' ? 'card-comments' : 'card-moves');
          return json(res, 200, page(rows, q));
        }
        if ((m = /^\/1\/cards\/([^/]+)\/attachments$/.exec(p))) return json(res, 200, fixture('card-detail').attachments.map((a) => ({ ...a, url: a.url.replace('https://trello.com', origin) })));
        if ((m = /^\/1\/cards\/([^/]+)\/attachments\/([^/]+)\/download\/(.+)$/.exec(p))) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          return res.end(m[2].endsWith('1') ? 'video-bytes' : m[2].endsWith('3') ? 'hello' : 'hello!');
        }
        if ((m = /^\/1\/cards\/([^/]+)$/.exec(p))) {
          const c = findCard(m[1]);
          if (!c) return json(res, 404, 'The requested resource was not found.');
          if (q.get('attachments') === 'true') {
            const d = fixture('card-detail');
            return json(res, 200, { ...c, attachments: d.attachments.map((a) => ({ ...a, url: a.url.replace('https://trello.com', origin) })), checklists: d.checklists, desc: c.id === C.doing ? d.desc : c.desc });
          }
          return json(res, 200, c);
        }
      } else {
        if ((m = /^\/1\/cards\/([^/]+)\/actions\/comments$/.exec(p)) && req.method === 'POST') return json(res, 200, { id: `5f0000000000000000900${state.nextId++}`, type: 'commentCard', date: '2026-11-04T10:00:00.000Z', data: { text: record.form.text } });
        if ((m = /^\/1\/cards\/([^/]+)\/idLabels$/.exec(p)) && req.method === 'POST') {
          const c = findCard(m[1]);
          state.labels[c.id] = [...new Set([...(state.labels[c.id] ?? c.labels.map((l) => l.id)), record.form.value])];
          return json(res, 200, [record.form.value]);
        }
        if ((m = /^\/1\/cards\/([^/]+)\/idLabels\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
          const c = findCard(m[1]);
          state.labels[c.id] = (state.labels[c.id] ?? c.labels.map((l) => l.id)).filter((id) => id !== m[2]);
          return json(res, 200, {});
        }
        if ((m = /^\/1\/cards\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
          const c = findCard(m[1]);
          if (record.form.idList) state.cardList[c.id] = record.form.idList;
          if (record.form.desc !== undefined) state.desc[c.id] = record.form.desc;
          return json(res, 200, { ...c });
        }
        if (p === '/1/cards' && req.method === 'POST') return json(res, 200, { id: '5f0000000000000000c0ff01', shortLink: 'New00001', shortUrl: 'https://trello.com/c/New00001', name: record.form.name, idList: record.form.idList });
      }
      return json(res, 404, `no route ${req.method} ${p}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    state,
    behaviour,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
