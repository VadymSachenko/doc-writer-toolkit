import fs from 'node:fs';
import path from 'node:path';
import { makeClients } from '../lib/world.mjs';
import { computeStatus } from '../lib/status.mjs';
import { newLedger, newPr, writeLedger, readLedger } from '../lib/ledger.mjs';
import { LISTS, NOW, forgeAdapter, quietGit, settingsFor, tmp, trackerAdapter } from './fakes.mjs';

// A world for one test: a host folder, its settings, the fake tracker and forge, and helpers to write ledgers the way
// records would leave them.
export function world({ cards = [], prs = [], activity = {}, comments = {}, release = [], actions = {}, changed = {}, events = {}, fail = {}, extra = {}, git = quietGit } = {}) {
  const root = tmp();
  const settings = settingsFor(root, extra);
  const tracker = trackerAdapter({ cards, comments, release, actions });
  const forge = forgeAdapter({ prs, activity, changed, events, fail });
  const clients = () => makeClients({ settings, io: { trackerAdapter: tracker, forgeAdapter: forge } });
  const status = (opts = {}) => computeStatus({ settings, clients: clients(), now: NOW, git, ...opts });
  const one = async (key, opts) => (await status(opts)).tickets.find((t) => t.key === key);
  return { root, settings, tracker, forge, clients, status, one, git };
}

const statusOfList = (listId) => Object.entries(LISTS).find(([, l]) => l.id === listId)?.[0];

// A ledger as the records would have left it. `stages`: { name: status } or { name: { status, seq } }, in order.
export function ledger(w, card, { key = String(card.number ?? card.shortLink), stages = {}, prs = [], left = 'same', mode = 'pipeline', startedBy = 'schedule', ...rest } = {}) {
  const l = newLedger({ key, card, now: new Date(NOW - 86400000).toISOString(), mode });
  l.startedBy = startedBy;
  let seq = 0;
  for (const [name, v] of Object.entries(stages)) {
    const rec = typeof v === 'string' ? { status: v } : v;
    l.stages[name] = { seq: ++seq, at: new Date(NOW - 3600000).toISOString(), ...rec };
    l.stage = name;
  }
  l.seq = seq;
  for (const p of prs) {
    const entry = { ...newPr({ repo: p.repo, targets: p.targets, review: p.review, branch: p.branch ?? `ticket-${p.number}` }), ...p };
    l.prs.push(entry);
  }
  const listId = left === 'same' ? card.placeId : left ? LISTS[left].id : null;
  if (listId) l.left = { status: statusOfList(listId), list: { id: listId, name: Object.values(LISTS).find((x) => x.id === listId)?.name }, at: new Date(NOW - 3600000).toISOString() };
  Object.assign(l, rest);
  writeLedger(w.settings.state, l);
  return l;
}

export const read = (w, key) => readLedger(w.settings.state, key);

// Every file under a folder with its bytes, to show that a run changed nothing.
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
