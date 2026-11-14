import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prId } from './ledger.mjs';

// The event feed (design §5): what changed on the boards and the PRs since the last check, with no model call. One
// cursor per source in `<state>/watch/feed.json`:
//   - the window starts WINDOW_MS before `lastCheck`; ids already in `seen` are dropped, so the overlap costs nothing;
//   - `lastCheck` moves to the start of this check only after every event of the window was handed on;
//   - a source that failed keeps its `lastCheck` for up to HOLD_MS, then the gap is reported and it starts again
//     (its `failingSince` stays, since it still fails);
//   - a source with no cursor starts from now (the morning run reconciles everything earlier);
//   - `checkedAt` is when the last check ended, and `awakeSince` the first check after a pause longer than
//     pauseMs (the Mac asleep, the agent off). A source's failure counts from the later of its `failingSince` and
//     `awakeSince`: after ALERT_MS of that it is urgent;
//   - `starts` is the last start pass (the morning run's or the watcher's, lib/watch.mjs): what it saw, so the next one
//     runs only after a change;
//   - the file is written to a temp file and renamed.

export const WINDOW_MS = 10 * 60 * 1000;
export const HOLD_MS = 24 * 3600 * 1000;
// An hour: twelve failed checks at the default 5 minutes. Long enough for a network still coming up after a wake, a
// VPN or a short outage of the tracker or the forge; short enough that a token gone at night is told the same morning,
// while the morning run waits for the board.
export const ALERT_MS = 3600 * 1000;
// A pause in the checks, as the watcher sees it: longer than ALERT_MS and three intervals.
export const pauseMs = (settings) => Math.max(ALERT_MS, 3 * settings.schedule.watchMinutes * 60000);
export const FEED_VERSION = 1;

export const watchDir = (state) => path.join(state, 'watch');
export const feedPath = (state) => path.join(watchDir(state), 'feed.json');

export function emptyFeed() {
  return { schemaVersion: FEED_VERSION, sources: {}, jobs: {}, morning: { lastDate: null }, pending: [], notified: {} };
}

export function readFeed(state) {
  let text;
  try {
    text = fs.readFileSync(feedPath(state), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyFeed();
    throw e;
  }
  const f = JSON.parse(text);
  return { ...emptyFeed(), ...f };
}

export function writeFeed(state, feed) {
  const file = feedPath(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(feed, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The sources a check reads: the board in the settings and each watched board (the boards of host jobs too), and per
// repo of the targets the PRs that changed and the PR events (a review request or a label may not move a PR's
// update time, so the events are read as well).
export function sourcesOf(settings) {
  const boards = [settings.tracker.board, ...(settings.tracker.watchBoards ?? []), ...(settings.hostJobs ?? []).map((j) => j.watch?.board).filter(Boolean)];
  const repos = [...new Set(settings.targets.map((t) => t.repo))];
  return [
    ...[...new Set(boards)].map((board) => ({ name: `board:${board}`, kind: 'board', board })),
    ...repos.flatMap((repo) => [
      { name: `prs:${repo}`, kind: 'prs', repo },
      { name: `events:${repo}`, kind: 'events', repo },
    ]),
  ];
}

// One source's events since `from`, as { id, time, source, ... }. A PR's id carries its update time, so each later
// change of the same PR is a new event.
export async function readSource(src, clients, from) {
  if (src.kind === 'board') {
    const r = await clients.tracker.actionsSince({ since: from, board: src.board });
    return r.actions.map((a) => ({
      id: a.id,
      time: a.time,
      source: src.name,
      board: src.board,
      type: a.type,
      card: a.card,
      list: a.list ?? null,
      listBefore: a.listBefore ?? null,
      listAfter: a.listAfter ?? null,
      // The flow status of the card's list (the settings' board only), and the one a move went to.
      status: a.status ?? null,
      statusAfter: a.statusAfter ?? null,
    }));
  }
  if (src.kind === 'prs') {
    const r = await clients.forge.changedPrsSince({ repo: src.repo, since: from });
    return r.prs.map((p) => ({ id: `${src.repo}#${p.number}@${p.updatedAt}`, time: p.updatedAt, source: src.name, repo: src.repo, number: p.number, head: p.head, type: 'pr' }));
  }
  const r = await clients.forge.eventsSince({ repo: src.repo, since: from });
  return r.events.map((e) => ({ id: `${src.repo}/event/${e.id}`, time: e.createdAt, source: src.name, repo: src.repo, number: e.number, type: e.event }));
}

// Which tickets the events touch, from the ledgers on disk only (no tracker or forge read): a card by id or short
// link, the original card of a ticket, a PR by number or by its head branch.
export function ticketsOf(events, ledgers) {
  const index = new Map();
  const put = (kind, id, key) => id !== undefined && id !== null && id !== '' && index.set(`${kind}:${id}`, key);
  for (const l of ledgers) {
    if (l.stages?.close?.status === 'done') continue;
    put('card', l.card?.id, l.key);
    put('card', l.card?.shortLink, l.key);
    put('card', l.original?.id, l.key);
    put('card', l.original?.shortLink, l.key);
    for (const p of l.prs ?? []) {
      if (p.number) put('pr', prId(p), l.key);
      if (p.branch) put('branch', `${p.repo}:${p.branch}`, l.key);
    }
  }
  const keys = new Map();
  const unmapped = [];
  for (const e of events) {
    const key = e.card ? index.get(`card:${e.card.id}`) ?? (e.card.shortLink ? index.get(`card:${e.card.shortLink}`) : undefined) : index.get(`pr:${e.repo}#${e.number}`) ?? (e.head ? index.get(`branch:${e.repo}:${e.head}`) : undefined);
    if (!key) {
      unmapped.push(e);
      continue;
    }
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(e);
  }
  return { keys, unmapped };
}

// The new cursor of a source that was read: `lastCheck` at the check's start, and the seen ids still inside the next
// window (older ones can't come back).
export function advance(cursor, { checkStart, events }) {
  const floor = checkStart - WINDOW_MS;
  const seen = {};
  for (const [id, time] of Object.entries({ ...(cursor?.seen ?? {}), ...Object.fromEntries(events.map((e) => [e.id, e.time])) })) {
    if (Date.parse(time) >= floor) seen[id] = time;
  }
  return { lastCheck: new Date(checkStart).toISOString(), seen };
}
