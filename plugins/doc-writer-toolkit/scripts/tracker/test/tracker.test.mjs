import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main } from '../tracker.mjs';
import { createTracker, priorityOf, resolveStatuses } from '../lib/tracker.mjs';
import { assertAdapter, READS, WRITES } from '../lib/adapter-contract.mjs';
import { deepMerge, loadCredentials, loadSettings, parseEnvFile, validateTracker } from '../lib/settings.mjs';
import { CliError, Refusal, TrackerError } from '../lib/errors.mjs';
import { createAdapter, kinds } from '../adapters/index.mjs';
import { createTrelloClient } from '../adapters/trello/client.mjs';
import { action, createTrelloAdapter, createdAt, namePrefixes } from '../adapters/trello/index.mjs';
import { BOARD, C, KEY, L, TOKEN, WATCH, fixture, startFake, trackerSettings } from './fake-trello.mjs';
import { memoryAdapter } from './memory-adapter.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'tracker.mjs');
const ZWNJ = '‌';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));

// A tracker over the fake Trello server. `sleeps` collects the back-off waits instead of waiting.
async function setup({ dryRun = false, settings = trackerSettings(), fake: fakeOptions, pageSize } = {}) {
  const fake = await startFake(fakeOptions);
  const sleeps = [];
  const client = createTrelloClient({ key: KEY, token: TOKEN, origin: fake.origin, sleep: async (ms) => void sleeps.push(ms), dryRun });
  const adapter = createTrelloAdapter(client, pageSize ? { pageSize } : {});
  const tracker = createTracker({ adapter, tracker: validateTracker(settings), dryRun });
  return { fake, client, adapter, tracker, sleeps, close: () => fake.close() };
}
const withFake = (options, fn) => async () => {
  const s = await setup(options);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
};
const rejects = (promise, refused) =>
  assert.rejects(promise, (e) => {
    assert.ok(e instanceof CliError, `expected a CliError, got ${e}`);
    if (refused) assert.equal(e.refused, refused, e.message);
    return true;
  });

// ------------------------------------------------------------------ settings

test('settings: the local file overrides the shared one key by key; arrays are replaced', () => {
  const merged = deepMerge({ tracker: { board: 'a', neverRead: ['x', 'y'], labels: { p: '1', q: '2' } } }, { tracker: { neverRead: ['z'], labels: { q: '9' } } });
  assert.deepEqual(merged, { tracker: { board: 'a', neverRead: ['z'], labels: { p: '1', q: '9' } } });
});

test('settings: validation names what is wrong', () => {
  const ok = trackerSettings();
  assert.equal(validateTracker(ok).credentials.envFile, '.env');
  const bad = (patch, re) => assert.throws(() => validateTracker({ ...ok, ...patch }), (e) => e instanceof CliError && e.exitCode === 2 && re.test(e.message));
  bad({ board: undefined }, /tracker\.board/);
  bad({ statuses: {} }, /tracker\.statuses/);
  bad({ transitions: [['intake', 'nowhere']] }, /'nowhere'/);
  bad({ neverRead: ['ghost'] }, /'ghost'/);
  bad({ credentials: { key: 'A' } }, /credentials/);
  bad({ statuses: { ...ok.statuses, intake: [] } }, /tracker\.statuses\.intake/);
  assert.throws(() => validateTracker(undefined), /no 'tracker' object/);
});

test('settings: found by flag, by the CLAUDE.md field, or at the default place; the local file next to it merges', async () => {
  const root = tmp();
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await assert.rejects(loadSettings({ root }), /no settings file/);
  write('.claude/ticket-flow.json', { tracker: trackerSettings({ board: 'default-board' }) });
  assert.equal((await loadSettings({ root })).tracker.board, 'default-board');
  write('.claude/ticket-flow.local.json', { tracker: { board: 'local-board' } });
  const local = await loadSettings({ root });
  assert.equal(local.tracker.board, 'local-board');
  assert.equal(local.local, true);
  write('flow/custom.json', { tracker: trackerSettings({ board: 'custom-board' }) });
  write('CLAUDE.md', '## Documentation toolkit configuration\n\n- **Ticket flow settings:** `flow/custom.json`\n');
  assert.equal((await loadSettings({ root })).tracker.board, 'custom-board');
  assert.equal((await loadSettings({ root, settings: '.claude/ticket-flow.json' })).tracker.board, 'local-board');
  write('flow/custom.json', '{ not json');
  await assert.rejects(loadSettings({ root }), /not valid JSON/);
});

test('credentials: the variable names come from the settings; the environment wins over the file; a missing one is named, never a value', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.env'), `# comment\nexport TEST_TRACKER_KEY="from-file-key"\nTEST_TRACKER_TOKEN=from-file-token # note\n`);
  const credentials = validateTracker(trackerSettings()).credentials;
  assert.deepEqual(parseEnvFile('A=1\n#B=2\nC="x y"'), { A: '1', C: 'x y' });
  assert.deepEqual(loadCredentials({ root, credentials, env: {} }), { key: 'from-file-key', token: 'from-file-token' });
  assert.deepEqual(loadCredentials({ root, credentials, env: { TEST_TRACKER_KEY: 'env-key' } }), { key: 'env-key', token: 'from-file-token' });
  assert.throws(
    () => loadCredentials({ root, credentials: { ...credentials, envFile: 'nope.env' }, env: { TEST_TRACKER_KEY: 'only-key-value' } }),
    (e) => e.exitCode === 2 && /TEST_TRACKER_TOKEN/.test(e.message) && !/only-key-value/.test(e.message) && !/TEST_TRACKER_KEY/.test(e.message),
  );
});

// ------------------------------------------------------------------ statuses

test('statuses: exact names claim a list before a pattern; a move target is the first named list, never a pattern match', () => {
  const places = fixture('lists').map(({ id, name }) => ({ id, name }));
  const r = resolveStatuses(validateTracker(trackerSettings()).statuses, places);
  assert.deepEqual(r.statuses.done.places.map((p) => p.name), ['Finished', 'Closed, Oct 2026', 'Closed Sep, 2026']);
  assert.equal(r.statuses.done.target.name, 'Finished');
  assert.equal(r.statusOfPlace.get(L.octDone), 'done');
  assert.equal(r.statusOfPlace.get(L.bugs), undefined);
  // 'Closed*' listed first still doesn't win the exact 'Finished'; and a list two statuses name goes to the exact claim.
  const both = resolveStatuses({ pattern: ['Fin*'], exact: ['Finished'] }, places);
  assert.deepEqual(both.statuses.exact.places.map((p) => p.name), ['Finished']);
  assert.equal(both.statuses.pattern.target, null);
});

test('statuses: names compare without case, spacing or U+200C; a name that matches no list stops the run with that name', async () => {
  const places = [{ id: '1', name: `  Ready${ZWNJ}  to   go ` }];
  assert.equal(resolveStatuses({ ready: ['ready to GO'] }, places).statuses.ready.target.id, '1');
  assert.throws(
    () => resolveStatuses({ ready: ['Ready'], later: ['Archive*', 'Missing list'] }, [{ id: '1', name: 'Ready' }]),
    (e) => e.exitCode === 2 && /'Archive\*' \(status later\)/.test(e.message) && /'Missing list'/.test(e.message) && e.data.unresolved.length === 2,
  );
});

test('statuses: a run with an unresolvable name stops before it reads a card', withFake({ settings: trackerSettings({ statuses: { ...trackerSettings().statuses, ready: ['Ready', 'No such list'] } }) }, async (s) => {
  await assert.rejects(s.tracker.listCards({ status: 'intake' }), (e) => e.data.unresolved?.[0]?.name === 'No such list');
  assert.equal(s.fake.requests.filter((r) => /\/cards/.test(r.path)).length, 0);
}));

test('statuses: the operation shows each status with its lists, and the lists no status owns', withFake({}, async (s) => {
  const r = await s.tracker.statuses();
  assert.equal(r.statuses.find((x) => x.status === 'done').target.name, 'Finished');
  assert.equal(r.statuses.find((x) => x.status === 'drafts').neverRead, true);
  assert.deepEqual(r.unmapped.map((p) => p.name), ['Side lane']);
}));

// ------------------------------------------------------------------ listCards

test('listCards: the cards of a status, each with its status, list and last activity time', withFake({}, async (s) => {
  const r = await s.tracker.listCards({ status: 'intake' });
  assert.equal(r.count, 2);
  const [a, b] = r.cards;
  assert.equal(a.id, C.inbox1);
  assert.equal(a.shortLink, 'Inbx0001');
  assert.equal(a.url, 'https://trello.com/c/Inbx0001');
  assert.equal(a.number, 2001);
  assert.deepEqual(a.numbers, [2001, 1990]);
  assert.equal(a.status, 'intake');
  assert.deepEqual(a.list, { id: L.inbox, name: 'Inbox' });
  assert.equal(a.lastActivity, '2026-11-03T07:51:45.358Z');
  assert.equal(a.closed, false);
  assert.deepEqual(a.labels.map((l) => l.name), ['Billing', '']);
  assert.ok(a.desc.includes(ZWNJ), 'U+200C stays in the description');
  assert.equal(b.number, null);
  assert.equal(b.lastActivity, '2026-11-04T06:00:00.000Z');
  const sent = s.fake.requests.find((r) => r.path === `/1/lists/${L.inbox}/cards`);
  assert.match(sent.query.fields, /dateLastActivity/);
}));

test('listCards: a status with several lists reads each of them; a "done" card in a Closed list is done', withFake({}, async (s) => {
  s.fake.state.cardList[C.inbox2] = L.octDone;
  const r = await s.tracker.listCards({ status: 'done' });
  assert.deepEqual(r.lists.map((l) => l.name), ['Finished', 'Closed, Oct 2026', 'Closed Sep, 2026']);
  assert.deepEqual(r.cards.map((c) => [c.id, c.status, c.list.name]), [[C.inbox2, 'done', 'Closed, Oct 2026']]);
  assert.equal(s.fake.requests.filter((q) => /^\/1\/lists\/.*\/cards$/.test(q.path)).length, 3);
}));

test('listCards: each card has a priority from the labels the settings name, medium without one, and when it was made', withFake({ settings: trackerSettings({ priority: { high: 'billing', low: 'needs answer' } }) }, async (s) => {
  const intake = await s.tracker.listCards({ status: 'intake' });
  assert.deepEqual(intake.cards.map((c) => [c.id, c.priority]), [[C.inbox1, 'high'], [C.inbox2, 'medium']]);
  const doing = await s.tracker.listCards({ status: 'inProgress' });
  assert.equal(doing.cards[0].priority, 'low', 'the low label');
  // Trello's id starts with the creation time; the invented ids all start 5f000000.
  assert.equal(intake.cards[0].createdAt, '2020-07-04T04:05:20.000Z');
  s.fake.state.labels[C.doing] = ['5f00000000000000000b0001', '5f00000000000000000b0002'];
  assert.equal((await s.tracker.listCards({ status: 'inProgress' })).cards[0].priority, 'high', 'both labels: high wins');
  assert.equal((await s.tracker.readCard({ card: 'Doin0003' })).priority, 'high');
  assert.equal((await s.tracker.findCards({ number: 2002 })).cards[0].priority, 'high');
}));

test('priority: the default label names are high and low; a tracker field of its own wins; the settings check the levels', () => {
  assert.deepEqual(validateTracker(trackerSettings()).priority, { high: 'high', low: 'low' });
  assert.deepEqual(validateTracker(trackerSettings({ priority: { low: 'later' } })).priority, { high: 'high', low: 'later' });
  assert.throws(() => validateTracker(trackerSettings({ priority: { urgent: 'x' } })), (e) => e.exitCode === 2 && /tracker\.priority\.urgent is not a level/.test(e.message));
  assert.throws(() => validateTracker(trackerSettings({ priority: { high: '' } })), /tracker\.priority\.high must be a label name/);
  assert.throws(() => validateTracker(trackerSettings({ priority: 'high' })), /tracker\.priority must be/);
  const label = (name) => ({ id: name, name, color: null });
  assert.equal(priorityOf({ labels: [label('High ')] }), 'high', 'compared without case and spacing');
  assert.equal(priorityOf({ labels: [label('low')] }), 'low');
  assert.equal(priorityOf({ labels: [] }), 'medium');
  assert.equal(priorityOf({ labels: [label('high')], priority: 'low' }), 'low', "a tracker's own field wins");
  assert.equal(priorityOf({ labels: [], priority: 'urgent' }), 'medium', 'an unknown value is not a level');
  assert.equal(createdAt('5f0000000000000000000001'), '2020-07-04T04:05:20.000Z');
  assert.equal(createdAt('PROJ-1'), null);
});

test('listCardsOn: the open cards of a list on a watched board, by name; the board in the settings is read by status only', withFake({}, async (s) => {
  const r = await s.tracker.listCardsOn({ board: WATCH, list: 'ship*' });
  assert.deepEqual(r.lists.map((l) => l.name), ['Shipped']);
  assert.deepEqual(r.cards.map((c) => [c.shortLink, c.status, c.list.name, c.priority]), [['Orig0001', null, 'Shipped', 'medium']]);
  await rejects(s.tracker.listCardsOn({ board: BOARD, list: 'Drafts' }), 'notAllowed');
  await rejects(s.tracker.listCardsOn({ board: '5f00000000000000000d0009', list: 'Shipped' }), 'notAllowed');
  await rejects(s.tracker.listCardsOn({ board: WATCH, list: 'Nowhere' }), 'unknown');
  assert.equal(s.fake.requests.filter((q) => q.path === `/1/lists/${L.drafts}/cards`).length, 0, 'the drafts list was never read');
}));

test('listCards: refuses a neverRead status without asking for its cards; refuses an unknown status', withFake({}, async (s) => {
  await rejects(s.tracker.listCards({ status: 'drafts' }), 'neverRead');
  await rejects(s.tracker.listCards({ status: 'nonsense' }), 'unknown');
  assert.equal(s.fake.requests.filter((r) => r.path === `/1/lists/${L.drafts}/cards`).length, 0);
}));

// ------------------------------------------------------------------ readCard

test('readCard: comments, attachments, checklists, moves and links to other cards', withFake({}, async (s) => {
  const r = await s.tracker.readCard({ card: 'Doin0003' });
  assert.equal(r.status, 'inProgress');
  assert.equal(r.name, '#2002 - Add a currency');
  assert.deepEqual(r.labels.map((l) => l.name), ['needs answer']);
  assert.deepEqual(r.comments.map((c) => [c.author.username, c.time, c.edited]), [
    ['test_reader', '2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z'],
    ['test_writer', '2026-11-02T10:51:00.000Z', null],
  ]);
  assert.match(r.comments[0].text, /^Triage: needed\nKey: d2$/);
  assert.deepEqual(r.attachments.map((a) => [a.name, a.isUpload, a.bytes]), [['clip.mp4', true, 11], ['spec', false, null], ['notes.txt', true, 5], ['notes.txt', true, 6]]);
  assert.deepEqual(r.checklists[0].items.map((i) => [i.name, i.state]), [['first', 'complete'], ['second, see https://trello.com/c/Link0002', 'incomplete']]);
  assert.deepEqual(r.links.map((l) => [l.shortLink, l.in]), [['Link0001', ['description']], ['Link0003', ['comment']], ['Link0002', ['checklist']]]);
  assert.equal(r.links.find((l) => l.shortLink === 'Doin0003'), undefined, 'the card does not link to itself');
  assert.deepEqual(r.moves.map((m) => [m.from.name, m.from.status, m.to.name, m.to.status]), [['Drafts', 'drafts', 'Ready', 'ready'], ['Ready', 'ready', 'Doing', 'inProgress']]);
}));

test('readCard: takes the id, the short link or the URL; anything else is refused before a request', withFake({}, async (s) => {
  for (const ref of [C.doing, 'Doin0003', 'https://trello.com/c/Doin0003/2002-add-a-currency']) assert.equal((await s.tracker.readCard({ card: ref })).id, C.doing);
  await rejects(s.tracker.readCard({ card: '../boards/x' }), 'unknown');
  await rejects(s.tracker.readCard({ card: 'short' }), 'unknown');
}));

test('readCard: refuses a card that stands in a neverRead status', withFake({}, async (s) => {
  await rejects(s.tracker.readCard({ card: 'Drft0005' }), 'neverRead');
  assert.equal(s.fake.requests.filter((r) => /actions/.test(r.path)).length, 0);
}));

test('readCard: pages the comments by the smallest id until a page is short', withFake({ pageSize: 1 }, async (s) => {
  const r = await s.tracker.readCard({ card: 'Doin0003' });
  assert.equal(r.comments.length, 2);
  const pages = s.fake.requests.filter((q) => q.path === `/1/cards/${C.doing}/actions` && q.query.filter === 'commentCard');
  assert.deepEqual(pages.map((q) => q.query.before ?? null), [null, '5f0000000000000000100003', '5f0000000000000000100002']);
}));

// ------------------------------------------------------------------ findCards

test('findCards: by number, archived too, with the status of the list each stands in', withFake({}, async (s) => {
  const one = await s.tracker.findCards({ number: '2001' });
  assert.deepEqual(one.cards.map((c) => [c.shortLink, c.status, c.list.name]), [['Inbx0001', 'intake', 'Inbox']]);
  assert.equal(one.cards[0].desc, undefined, 'find returns identity, not text');
  const archived = await s.tracker.findCards({ number: 2003 });
  assert.deepEqual(archived.cards.map((c) => [c.closed, c.status]), [[true, 'done']]);
  assert.equal((await s.tracker.findCards({ number: 9999 })).count, 0);
  // the second number of a copy is not the card's own
  assert.equal((await s.tracker.findCards({ number: 1990 })).count, 0);
}));

test('findCards: the board and the watched boards; a board the settings do not name is refused', withFake({}, async (s) => {
  const all = await s.tracker.findCards({ number: 2001, boards: [BOARD, WATCH] });
  assert.deepEqual(all.cards.map((c) => [c.shortLink, c.status, c.list.name]), [['Inbx0001', 'intake', 'Inbox'], ['Orig0001', null, 'Shipped']]);
  await rejects(s.tracker.findCards({ number: 2001, boards: ['5f0000000000000000ffffff'] }), 'notAllowed');
}));

test('findCards: by link or short link, archived too; a link to nothing finds nothing', withFake({}, async (s) => {
  const r = await s.tracker.findCards({ link: 'https://trello.com/c/Arch0004/2003-archived-card' });
  assert.deepEqual(r.cards.map((c) => [c.id, c.closed]), [[C.archived, true]]);
  const other = await s.tracker.findCards({ link: 'Orig0001' });
  assert.deepEqual(other.cards.map((c) => [c.status, c.list.name]), [[null, 'Shipped']]);
  assert.equal((await s.tracker.findCards({ link: 'Nope0000' })).count, 0);
  await assert.rejects(s.tracker.findCards({}), CliError);
  await assert.rejects(s.tracker.findCards({ number: 1, link: 'Nope0000' }), CliError);
}));

test('findCards: pages /cards/all by the smallest id', withFake({ pageSize: 2 }, async (s) => {
  const r = await s.tracker.findCards({ number: 2004 });
  assert.equal(r.count, 1);
  assert.equal(r.cards[0].status, 'drafts');
  assert.equal(r.cards[0].desc, undefined, 'a drafts card is found by name, its text is not returned');
  assert.ok(s.fake.requests.some((q) => q.path === `/1/boards/${BOARD}/cards/all` && q.query.before));
}));

test('namePrefixes: the leading numbers of a card name, in order', () => {
  assert.deepEqual(namePrefixes('#1102 - #1089 - Title #5'), { numbers: [1102, 1089], stripped: 'Title #5' });
  assert.deepEqual(namePrefixes('No number'), { numbers: [], stripped: 'No number' });
});

// ------------------------------------------------------------------ actionsSince

test('actionsSince: oldest first, with the status each move came from and went to; archiving and edits are marked', withFake({}, async (s) => {
  const r = await s.tracker.actionsSince({ since: '2026-11-04T07:30:00Z' });
  assert.equal(r.since, '2026-11-04T07:30:00.000Z');
  assert.deepEqual(r.actions.map((a) => a.type), ['addLabelToCard', 'commentCard', 'updateCard', 'updateCard']);
  const [label, comment, move, archive] = r.actions;
  assert.equal(label.text, 'needs answer');
  assert.equal(comment.text, 'A question');
  assert.equal(comment.status, 'inProgress');
  assert.equal(comment.by.username, 'test_reader');
  assert.deepEqual([move.statusBefore, move.statusAfter, move.listBefore.name, move.listAfter.name], ['inProgress', 'blocked', 'Doing', 'Blocked']);
  assert.deepEqual(move.card, { id: C.doing, shortLink: 'Doin0003', name: '#2002 - Add a currency' });
  assert.equal(archive.closed, true);
  assert.deepEqual(archive.changed, ['closed']);
  assert.equal(archive.status, 'done');
}));

test('actionsSince: leaves out actions on a card in a neverRead status and counts them', withFake({}, async (s) => {
  const r = await s.tracker.actionsSince({ since: '2026-11-04T07:00:00Z' });
  assert.equal(r.skippedNeverRead, 1);
  assert.ok(!r.actions.some((a) => a.id === '5f0000000000000000300006'));
  assert.equal(r.count, 5);
}));

test('actionsSince: pages by the smallest id, drops duplicates, passes the filter and the time', withFake({ pageSize: 2 }, async (s) => {
  const r = await s.tracker.actionsSince({ since: '2026-11-04T07:00:00Z', types: ['commentCard', 'updateCard'] });
  assert.equal(r.count, 5);
  const pages = s.fake.requests.filter((q) => q.path === `/1/boards/${BOARD}/actions`);
  assert.ok(pages.length >= 3);
  assert.ok(pages.every((q) => q.query.filter === 'commentCard,updateCard' && q.query.since === '2026-11-04T07:00:00.000Z'));
  assert.equal(pages[0].query.before, undefined);
  assert.ok(pages[1].query.before);
}));

test('actionsSince: a watched board is readable and has no statuses; a bad time or board is refused; no cursor is kept', withFake({}, async (s) => {
  const r = await s.tracker.actionsSince({ since: '2026-11-04T07:00:00Z', board: WATCH });
  assert.deepEqual([r.board, r.count], [WATCH, 0]);
  await assert.rejects(s.tracker.actionsSince({ since: 'yesterday-ish' }), (e) => e instanceof CliError && e.exitCode === 2);
  await assert.rejects(s.tracker.actionsSince({}), CliError);
  await rejects(s.tracker.actionsSince({ since: '2026-11-04T07:00:00Z', board: '5f0000000000000000ffffff' }), 'notAllowed');
}));

test('actions: a Trello action in the module shape', () => {
  const a = action({ id: 'a1', type: 'updateComment', date: 'd', data: { action: { text: 'edited' }, card: { id: 'c', shortLink: 's', name: 'n' }, old: { text: 'was' } }, idMemberCreator: 'm1' });
  assert.deepEqual([a.text, a.changed, a.by, a.card.shortLink], ['edited', ['text'], { id: 'm1', username: null }, 's']);
});

// ------------------------------------------------------------------ downloadAttachment

test('downloadAttachment: by name or id into the path; the credentials go in the header, not the URL', withFake({}, async (s) => {
  const dir = tmp();
  const dest = path.join(dir, 'clip.mp4');
  const r = await s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'clip.mp4', out: dest });
  assert.equal(r.bytes, 11);
  assert.equal(r.attachment.name, 'clip.mp4');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'video-bytes');
  assert.deepEqual(fs.readdirSync(dir), ['clip.mp4'], 'no temp file is left');
  const get = s.fake.requests.find((q) => q.path.endsWith('/download/clip.mp4'));
  assert.match(get.headers.authorization, /^OAuth oauth_consumer_key=".+", oauth_token=".+"$/);
  assert.ok(!get.url.includes(KEY) && !get.url.includes(TOKEN));
  const byId = path.join(dir, 'by-id.txt');
  assert.equal((await s.tracker.downloadAttachment({ card: 'Doin0003', attachment: '5f00000000000000000e0003', out: byId })).bytes, 5);
}));

test('downloadAttachment: refuses a link, an ambiguous name, an unknown name, an existing file and a missing folder', withFake({}, async (s) => {
  const dir = tmp();
  const out = (n) => path.join(dir, n);
  await rejects(s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'spec', out: out('a') }), 'unknown');
  await rejects(s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'notes.txt', out: out('b') }), 'ambiguous');
  await rejects(s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'ghost.bin', out: out('c') }), 'unknown');
  fs.writeFileSync(out('exists'), 'keep');
  await rejects(s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'clip.mp4', out: out('exists') }), 'notAllowed');
  assert.equal(fs.readFileSync(out('exists'), 'utf8'), 'keep');
  await s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'clip.mp4', out: out('exists'), overwrite: true });
  assert.equal(fs.readFileSync(out('exists'), 'utf8'), 'video-bytes');
  await rejects(s.tracker.downloadAttachment({ card: 'Doin0003', attachment: 'clip.mp4', out: path.join(dir, 'no', 'such', 'f') }), 'notAllowed');
  await rejects(s.tracker.downloadAttachment({ card: 'Drft0005', attachment: 'x', out: out('d') }), 'neverRead');
}));

test('download: credentials are never sent to a host that is not Trello', async () => {
  const calls = [];
  const client = createTrelloClient({ key: KEY, token: TOKEN, fetchImpl: async (...a) => void calls.push(a) });
  const dest = path.join(tmp(), 'f');
  await assert.rejects(client.download('https://files.example.com/a.png', dest), (e) => e instanceof TrackerError && /not a Trello host/.test(e.message));
  await assert.rejects(client.download('http://trello.com/x', dest), TrackerError);
  await assert.rejects(client.download('not a url', dest), TrackerError);
  assert.equal(calls.length, 0);
});

test('download: a failed answer leaves no file behind and no secret in the message', async () => {
  const fake = await startFake({ onRequest: (r, h) => (r.path === '/1/gone' ? h.json(500, `broken ${TOKEN}`) : undefined) });
  try {
    const client = createTrelloClient({ key: KEY, token: TOKEN, origin: fake.origin });
    const dest = path.join(tmp(), 'f');
    await assert.rejects(client.download(`${fake.origin}/1/gone`, dest), (e) => e.exitCode === 1 && !e.message.includes(TOKEN) && e.message.includes('***'));
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), []);
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------------------ comment

test('comment: sent as given (U+200C kept), credentials in the header and the form, not the URL', withFake({}, async (s) => {
  const text = `Line one${ZWNJ}\n\nLine two `;
  const r = await s.tracker.comment({ card: 'Doin0003', text });
  assert.equal(r.commented, true);
  assert.match(r.id, /^5f0000/);
  const post = s.fake.writes()[0];
  assert.deepEqual([post.method, post.path], ['POST', `/1/cards/${C.doing}/actions/comments`]);
  assert.equal(post.form.text, text);
  assert.equal(post.form.key, KEY);
  assert.ok(!post.url.includes(KEY) && !post.url.includes(TOKEN));
  assert.match(post.headers.authorization, /oauth_consumer_key/);
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
}));

test('comment: an empty comment is refused, with no request', withFake({}, async (s) => {
  await rejects(s.tracker.comment({ card: 'Doin0003', text: '' }), 'empty');
  await rejects(s.tracker.comment({ card: 'Doin0003', text: `  ${ZWNJ}\n ` }), 'empty');
  assert.equal(s.fake.requests.length, 0);
}));

test('comment: skipped when a comment since the time already starts with the header', withFake({}, async (s) => {
  const same = await s.tracker.comment({ card: 'Doin0003', text: 'Triage: again', unlessHeader: `${ZWNJ}Triage:`, since: '2026-10-31T00:00:00Z' });
  assert.equal(same.commented, false);
  assert.equal(same.existing, '5f0000000000000000100002');
  assert.equal(s.fake.writes().length, 0);
  const later = await s.tracker.comment({ card: 'Doin0003', text: 'Triage: again', unlessHeader: 'Triage:', since: '2026-11-02T00:00:00Z' });
  assert.equal(later.commented, true);
  assert.equal(s.fake.writes().length, 1);
}));

// ------------------------------------------------------------------ move

const lastPut = (s) => s.fake.writes().filter((w) => w.method === 'PUT').at(-1);

test('move: a transition in the settings runs, at the top of the list', withFake({}, async (s) => {
  const r = await s.tracker.move({ card: 'Inbx0001', to: 'ready' });
  assert.deepEqual([r.moved, r.from, r.to, r.list.name], [true, 'intake', 'ready', 'Ready']);
  assert.deepEqual(lastPut(s).form, { idList: L.ready, pos: 'top', key: KEY, token: TOKEN });
  assert.equal(lastPut(s).path, `/1/cards/${C.inbox1}`);
}));

test('move: a pair the settings do not list is refused with no write', withFake({}, async (s) => {
  await rejects(s.tracker.move({ card: 'Inbx0001', to: 'inProgress' }), 'transition');
  await rejects(s.tracker.move({ card: 'Doin0003', to: 'ready' }), 'transition');
  await rejects(s.tracker.move({ card: 'Doin0003', to: 'drafts' }), 'transition');
  assert.equal(s.fake.writes().length, 0);
}));

test('move: blocked -> inProgress is a transition (the video gate); the card follows its list', withFake({}, async (s) => {
  await s.tracker.move({ card: 'Doin0003', to: 'blocked' });
  const back = await s.tracker.move({ card: 'Doin0003', to: 'inProgress' });
  assert.deepEqual([back.from, back.to], ['blocked', 'inProgress']);
  assert.equal(s.fake.state.cardList[C.doing], L.doing);
}));

test('move: into done goes to the first named list, never a Closed list; from a Closed list the card counts as done', withFake({}, async (s) => {
  s.fake.state.cardList[C.doing] = L.final;
  const r = await s.tracker.move({ card: 'Doin0003', to: 'done' });
  assert.equal(r.list.name, 'Finished');
  assert.equal(lastPut(s).form.idList, L.finished);
  s.fake.state.cardList[C.doing] = L.octDone;
  await rejects(s.tracker.move({ card: 'Doin0003', to: 'inProgress' }), 'transition');
  await rejects(s.tracker.move({ card: 'Doin0003', to: 'done' }), 'transition');
}));

test('move: a card already in the target list is not moved again', withFake({}, async (s) => {
  const r = await s.tracker.move({ card: 'Doin0003', to: 'inProgress' });
  assert.equal(r.moved, false);
  assert.equal(s.fake.writes().length, 0);
}));

test('move: refuses an archived card, a card in a list outside the flow, a card on another board, an unknown status', withFake({}, async (s) => {
  await rejects(s.tracker.move({ card: 'Arch0004', to: 'done' }), 'archived');
  s.fake.state.cardList[C.doing] = L.bugs;
  await rejects(s.tracker.move({ card: 'Doin0003', to: 'blocked' }), 'outsideFlow');
  await rejects(s.tracker.move({ card: 'Orig0001', to: 'ready' }), 'outsideFlow');
  await rejects(s.tracker.move({ card: 'Inbx0001', to: 'sideways' }), 'unknown');
  assert.equal(s.fake.writes().length, 0);
}));

test('move: a status whose names are all patterns has no list to move into', withFake({ settings: trackerSettings({ statuses: { intake: ['Inbox'], old: ['Closed*'] }, neverRead: [], transitions: [['intake', 'old']] }) }, async (s) => {
  await rejects(s.tracker.move({ card: 'Inbx0001', to: 'old' }), 'unknown');
  assert.equal(s.fake.writes().length, 0);
}));

// ------------------------------------------------------------------ labels

test('addLabel and removeLabel: by name, idempotent, and the settings can name a label by a short key', withFake({}, async (s) => {
  const add = await s.tracker.addLabel({ card: 'Inbx0002', label: 'Billing' });
  assert.deepEqual([add.changed, add.label], [true, 'Billing']);
  assert.deepEqual(s.fake.writes()[0].form, { value: '5f00000000000000000b0001', key: KEY, token: TOKEN });
  assert.equal(s.fake.writes()[0].path, `/1/cards/${C.inbox2}/idLabels`);
  assert.equal((await s.tracker.addLabel({ card: 'Inbx0002', label: 'billing' })).changed, false, 'already there (read back from the card)');
  assert.equal(s.fake.writes().length, 1);

  const rem = await s.tracker.removeLabel({ card: 'Doin0003', label: 'needsAnswer' });
  assert.deepEqual([rem.changed, rem.label], [true, 'needs answer']);
  const del = s.fake.writes()[1];
  assert.deepEqual([del.method, del.path], ['DELETE', `/1/cards/${C.doing}/idLabels/5f00000000000000000b0002`]);
  assert.equal(del.body, '', 'a DELETE carries no body');
  assert.match(del.headers.authorization, /oauth_consumer_key/);
  assert.equal((await s.tracker.removeLabel({ card: 'Doin0003', label: 'needs answer' })).changed, false);
  assert.equal(s.fake.writes().length, 2);
}));

test('labels: an unknown, ambiguous or empty label is refused; an exact name wins over a case-only match', withFake({}, async (s) => {
  await rejects(s.tracker.addLabel({ card: 'Inbx0002', label: 'No such label' }), 'unknown');
  await rejects(s.tracker.addLabel({ card: 'Inbx0002', label: 'TWIN' }), 'ambiguous');
  await rejects(s.tracker.addLabel({ card: 'Inbx0002', label: ' ' }), 'unknown');
  assert.equal((await s.tracker.addLabel({ card: 'Inbx0002', label: 'Twin' })).label, 'Twin');
  assert.equal(s.fake.writes().length, 1);
}));

// ------------------------------------------------------------------ setDescription

test('setDescription: refuses an empty text; sends the text exactly; skips an unchanged one', withFake({}, async (s) => {
  await rejects(s.tracker.setDescription({ card: 'Inbx0002', text: '' }), 'empty');
  await rejects(s.tracker.setDescription({ card: 'Inbx0002', text: `\n ${ZWNJ} ` }), 'empty');
  assert.equal(s.fake.requests.length, 0);
  const text = `#### Notes${ZWNJ}\n\nBody\n`;
  const r = await s.tracker.setDescription({ card: 'Inbx0002', text });
  assert.equal(r.changed, true);
  assert.equal(lastPut(s).form.desc, text);
  assert.deepEqual(Object.keys(lastPut(s).form).sort(), ['desc', 'key', 'token']);
  assert.equal((await s.tracker.setDescription({ card: 'Inbx0002', text })).changed, false);
  assert.equal(s.fake.writes().length, 1);
}));

// ------------------------------------------------------------------ createCard

test('createCard: only in the intake status, at the bottom of its list, with the labels by name', withFake({}, async (s) => {
  const r = await s.tracker.createCard({ status: 'intake', name: 'New request', desc: `Text${ZWNJ}`, labels: ['Billing', 'needsAnswer'] });
  assert.deepEqual([r.shortLink, r.url, r.status, r.list.name], ['New00001', 'https://trello.com/c/New00001', 'intake', 'Inbox']);
  assert.deepEqual(r.labels, ['Billing', 'needs answer']);
  const post = s.fake.writes()[0];
  assert.deepEqual([post.method, post.path], ['POST', '/1/cards']);
  assert.deepEqual(
    { ...post.form, key: undefined, token: undefined },
    { idList: L.inbox, name: 'New request', desc: `Text${ZWNJ}`, idLabels: '5f00000000000000000b0001,5f00000000000000000b0002', pos: 'bottom', key: undefined, token: undefined },
  );
}));

test('createCard: any other status, an empty name, or an unknown label is refused with no write', withFake({}, async (s) => {
  for (const status of ['ready', 'drafts', 'inProgress', 'done', undefined, 'Inbox']) await rejects(s.tracker.createCard({ status, name: 'x' }), 'intake');
  await rejects(s.tracker.createCard({ status: 'intake', name: ' ' }), 'empty');
  await rejects(s.tracker.createCard({ status: 'intake', name: 'x', labels: ['No such label'] }), 'unknown');
  assert.equal(s.fake.writes().length, 0);
}));

// ------------------------------------------------------------------ dry run

test('dry run: every write is printed with the secrets removed and none is sent', async () => {
  const s = await setup({ dryRun: true });
  try {
    await s.tracker.comment({ card: 'Doin0003', text: 'hello' });
    await s.tracker.move({ card: 'Inbx0001', to: 'ready' });
    await s.tracker.addLabel({ card: 'Inbx0002', label: 'Billing' });
    await s.tracker.removeLabel({ card: 'Doin0003', label: 'needs answer' });
    await s.tracker.setDescription({ card: 'Inbx0002', text: 'new' });
    const made = await s.tracker.createCard({ status: 'intake', name: 'n' });
    assert.equal(s.fake.writes().length, 0);
    assert.deepEqual(s.client.calls.map((c) => `${c.method} ${c.path.replace(/5f0+[0-9a-f]+/g, '<id>')}`), [
      'POST /1/cards/<id>/actions/comments',
      'PUT /1/cards/<id>',
      'POST /1/cards/<id>/idLabels',
      'DELETE /1/cards/<id>/idLabels/<id>',
      'PUT /1/cards/<id>',
      'POST /1/cards',
    ]);
    assert.ok(!JSON.stringify(s.client.calls).includes(KEY) && !JSON.stringify(s.client.calls).includes(TOKEN));
    assert.match(made.id, /^dry-run-/);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ 429 and errors

test('429: retried after 2, 4 and 8 s, as the hub does; reads and writes alike', withFake({}, async (s) => {
  s.fake.behaviour.throttle = 3;
  const r = await s.tracker.listCards({ status: 'intake' });
  assert.equal(r.count, 2);
  assert.deepEqual(s.sleeps, [2000, 4000, 8000]);
  s.sleeps.length = 0;
  s.fake.behaviour.throttle = 1;
  // the first request of a comment is the read of the card; the write itself is retried the same way
  await s.tracker.comment({ card: 'Doin0003', text: 'x' });
  assert.deepEqual(s.sleeps, [2000]);
  s.sleeps.length = 0;
  s.fake.requests.length = 0;
  const posts = [];
  s.fake.behaviour.throttle = 0;
  await s.client.write('POST', `/1/cards/${C.doing}/actions/comments`, { text: 'y' });
  posts.push(...s.fake.writes());
  assert.equal(posts.length, 1);
}));

test('429: after three retries the fourth answer is reported, with the call and no secret', withFake({}, async (s) => {
  s.fake.behaviour.throttle = 10;
  await assert.rejects(s.tracker.listCards({ status: 'intake' }), (e) => e instanceof TrackerError && e.exitCode === 1 && e.data.status === 429 && /GET \/1\/boards/.test(e.message));
  assert.deepEqual(s.sleeps, [2000, 4000, 8000]);
  assert.equal(s.fake.requests.length, 4);
}));

test('other errors are reported once, not retried, and the token never appears in the message', async () => {
  const fake = await startFake({ onRequest: (r, h) => (r.path.endsWith('/lists') ? h.json(401, `invalid token ${TOKEN} for key ${KEY}`) : undefined) });
  try {
    const client = createTrelloClient({ key: KEY, token: TOKEN, origin: fake.origin, sleep: async () => {} });
    const tracker = createTracker({ adapter: createTrelloAdapter(client), tracker: validateTracker(trackerSettings()) });
    await assert.rejects(tracker.listCards({ status: 'intake' }), (e) => e.data.status === 401 && !e.message.includes(TOKEN) && !e.message.includes(KEY) && /\*\*\*/.test(e.message));
    assert.equal(fake.requests.length, 1);
  } finally {
    await fake.close();
  }
});

test('the origin must be https unless it is this computer', () => {
  assert.throws(() => createTrelloClient({ key: KEY, token: TOKEN, origin: 'http://api.example.com' }), (e) => e.exitCode === 2);
  createTrelloClient({ key: KEY, token: TOKEN, origin: 'http://127.0.0.1:1' });
});

// ------------------------------------------------------------------ the interface

test('the interface: the module runs unchanged on an adapter that is not Trello', async () => {
  const adapter = memoryAdapter();
  const settings = validateTracker({
    kind: 'memory', board: 'main', credentials: { key: 'A', token: 'B' },
    statuses: { intake: ['Inbox'], drafts: ['Drafts'], ready: ['Ready'], inProgress: ['Doing'] },
    neverRead: ['drafts'], transitions: [['intake', 'ready'], ['ready', 'inProgress']],
  });
  const tracker = createTracker({ adapter, tracker: settings });
  assert.deepEqual((await tracker.listCards({ status: 'intake' })).cards.map((c) => [c.id, c.status, c.list.name]), [['PROJ-1', 'intake', 'Inbox']]);
  await rejects(tracker.listCards({ status: 'drafts' }), 'neverRead');
  await rejects(tracker.readCard({ card: 'PROJ-2' }), 'neverRead');
  assert.equal((await tracker.findCards({ number: 10 })).cards[0].status, 'intake');
  await rejects(tracker.move({ card: 'PROJ-1', to: 'inProgress' }), 'transition');
  assert.equal((await tracker.move({ card: 'PROJ-1', to: 'ready' })).moved, true);
  assert.deepEqual(adapter.log.at(-1), ['move', 'PROJ-1', 'p3']);
  await rejects(tracker.setDescription({ card: 'PROJ-1', text: '' }), 'empty');
  await rejects(tracker.createCard({ status: 'ready', name: 'x' }), 'intake');
  assert.equal((await tracker.createCard({ status: 'intake', name: 'x' })).id, 'PROJ-3');
  assert.deepEqual(adapter.log.at(-1), ['createCard', 'p1', 'x']);
});

test('the interface: an adapter that lacks a method is rejected; the Trello adapter has them all; the registry names the kinds', () => {
  assert.throws(() => assertAdapter({ kind: 'half', places() {} }), /lacks: cardRef/);
  assertAdapter(memoryAdapter());
  const { adapter } = createAdapter('trello', { key: KEY, token: TOKEN });
  assertAdapter(adapter);
  assert.deepEqual(kinds(), ['trello']);
  assert.throws(() => createAdapter('jira', {}), (e) => e.exitCode === 2 && /no adapter for tracker kind 'jira'/.test(e.message));
});

test('no operation archives, deletes or renames a card; every write the module made is one of the allowed shapes', withFake({}, async (s) => {
  assert.deepEqual(Object.keys(s.tracker).sort(), ['actionsSince', 'addLabel', 'comment', 'createCard', 'downloadAttachment', 'dryRun', 'findCards', 'listCards', 'listCardsOn', 'move', 'readCard', 'removeLabel', 'setDescription', 'statuses']);
  assert.deepEqual([...WRITES].sort(), ['addLabel', 'comment', 'createCard', 'moveCard', 'removeLabel', 'setDescription']);
  assert.equal(READS.length, 11);
  await s.tracker.comment({ card: 'Doin0003', text: 'a' });
  await s.tracker.move({ card: 'Inbx0001', to: 'ready' });
  await s.tracker.addLabel({ card: 'Inbx0002', label: 'Billing' });
  await s.tracker.removeLabel({ card: 'Doin0003', label: 'needs answer' });
  await s.tracker.setDescription({ card: 'Inbx0002', text: 'd' });
  await s.tracker.createCard({ status: 'intake', name: 'n' });
  for (const w of s.fake.writes()) {
    const shape = `${w.method} ${w.path.replace(/\/[0-9a-f]{24}/g, '/:id')}`;
    assert.ok(['POST /1/cards/:id/actions/comments', 'PUT /1/cards/:id', 'POST /1/cards/:id/idLabels', 'DELETE /1/cards/:id/idLabels/:id', 'POST /1/cards'].includes(shape), shape);
    for (const field of Object.keys(w.form)) assert.ok(['text', 'idList', 'pos', 'value', 'desc', 'name', 'idLabels', 'key', 'token'].includes(field), `${shape} sends ${field}`);
  }
}));

// ------------------------------------------------------------------ the CLI

function hostRoot(overrides = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.json'), JSON.stringify({ schemaVersion: 1, tracker: trackerSettings(overrides) }));
  return root;
}

async function cli(args, { root, fake, env = { TEST_TRACKER_KEY: KEY, TEST_TRACKER_TOKEN: TOKEN } } = {}) {
  let out = '';
  const code = await main([...args, '--root', root, '--origin', fake.origin], { stdout: { write: (s) => void (out += s) }, env, sleep: async () => {} });
  return { code, json: JSON.parse(out), out };
}

test('cli: every command prints JSON with ok, and not one byte of output holds a credential', async () => {
  const fake = await startFake();
  const root = hostRoot();
  const dest = path.join(tmp(), 'got.txt');
  try {
    const outputs = [];
    const go = async (...args) => {
      const r = await cli(args, { root, fake });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.json.ok, true);
      outputs.push(r.out);
      return r.json;
    };
    assert.equal((await go('statuses')).statuses.length, 9);
    assert.equal((await go('list-cards', '--status', 'intake')).count, 2);
    assert.equal((await go('read-card', 'Doin0003')).comments.length, 2);
    assert.equal((await go('find-cards', '--number', '2001', '--all-boards')).count, 2);
    assert.equal((await go('find-cards', '--link', 'https://trello.com/c/Arch0004')).count, 1);
    assert.equal((await go('actions-since', '--since', '2026-11-04T07:00:00Z', '--types', 'commentCard,updateCard')).count, 5);
    assert.equal((await go('download-attachment', 'Doin0003', '--attachment', '5f00000000000000000e0003', '--out', dest)).bytes, 5);
    assert.equal((await go('comment', 'Doin0003', '--text', 'hi')).commented, true);
    assert.equal((await go('move', 'Inbx0001', '--to', 'ready')).moved, true);
    assert.equal((await go('add-label', 'Inbx0002', '--label', 'Billing')).changed, true);
    assert.equal((await go('remove-label', 'Doin0003', '--label', 'needsAnswer')).changed, true);
    assert.equal((await go('set-description', 'Inbx0002', '--text', 'new text')).changed, true);
    assert.equal((await go('create-card', '--status', 'intake', '--name', 'n', '--label', 'Billing')).shortLink, 'New00001');
    const dry = await go('move', 'Inbx0001', '--to', 'ready', '--dry-run');
    assert.equal(dry.dryRun, true);
    assert.equal(dry.calls.length, 0, 'the card is already in the target list: nothing to send');
    const dry2 = await go('comment', 'Doin0003', '--text', 'hi', '--dry-run');
    assert.equal(dry2.calls[0].path, `/1/cards/${C.doing}/actions/comments`);
    for (const o of outputs) assert.ok(!o.includes(KEY) && !o.includes(TOKEN));
  } finally {
    await fake.close();
  }
});

test('cli: text from a file or from standard input is stored exactly; both flags together are refused', async () => {
  const fake = await startFake();
  const root = hostRoot();
  const file = path.join(tmp(), 'desc.txt');
  const text = `# Title${ZWNJ}\n\nBody line\n`;
  fs.writeFileSync(file, text);
  try {
    await cli(['set-description', 'Inbx0002', '--text-file', file], { root, fake });
    assert.equal(fake.state.desc[C.inbox2], text);
    await assert.rejects(cli(['comment', 'Doin0003', '--text', 'a', '--text-file', file], { root, fake }), /not both/);
    await assert.rejects(cli(['set-description', 'Inbx0002', '--text-file', path.join(root, 'missing')], { root, fake }), /cannot read --text-file/);
  } finally {
    await fake.close();
  }
});

test('cli: usage errors are exit-2 errors; help prints the commands', async () => {
  const fake = await startFake();
  const root = hostRoot();
  const exit2 = (re) => (e) => e.exitCode === 2 && re.test(e.message);
  try {
    await assert.rejects(cli(['frobnicate'], { root, fake }), exit2(/unknown command/));
    await assert.rejects(cli(['move', '--to', 'ready'], { root, fake }), exit2(/needs the card/));
    await assert.rejects(cli(['list-cards', 'extra'], { root, fake }), exit2(/unexpected argument/));
    await assert.rejects(cli(['list-cards'], { root, fake }), exit2(/needs --status/));
    await assert.rejects(cli(['list-cards', '--list', 'Shipped'], { root, fake }), exit2(/needs one --board/));
    await assert.rejects(cli(['add-label', 'Inbx0001'], { root, fake }), exit2(/exactly one --label/));
    assert.equal((await cli(['list-cards', '--board', WATCH, '--list', 'Shipped'], { root, fake })).json.count, 1);
    const unknown = await run('node', [CLI, 'frobnicate', '--root', root]).catch((e) => e);
    assert.equal(unknown.code, 2, 'an unknown command exits 2, as in the forge');
    let help = '';
    assert.equal(await main(['--help'], { stdout: { write: (s) => void (help += s) } }), 0);
    for (const c of ['statuses', 'list-cards', 'read-card', 'find-cards', 'actions-since', 'download-attachment', 'comment', 'move', 'add-label', 'remove-label', 'set-description', 'create-card']) assert.ok(help.includes(c), c);
  } finally {
    await fake.close();
  }
});

test('cli: a refusal exits 2 with a JSON error and its rule; missing credentials exit 2 and name the variables only', async () => {
  const fake = await startFake();
  const root = hostRoot();
  try {
    const env = { ...process.env, TEST_TRACKER_KEY: KEY, TEST_TRACKER_TOKEN: TOKEN };
    const refused = await run('node', [CLI, 'list-cards', '--status', 'drafts', '--root', root, '--origin', fake.origin], { env }).catch((e) => e);
    assert.equal(refused.code, 2);
    assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: "'drafts' is never listed: the settings mark it neverRead", refused: 'neverRead', status: 'drafts' });
    const bare = { ...process.env };
    delete bare.TEST_TRACKER_KEY;
    delete bare.TEST_TRACKER_TOKEN;
    const missing = await run('node', [CLI, 'statuses', '--root', root, '--origin', fake.origin], { env: bare }).catch((e) => e);
    assert.equal(missing.code, 2);
    assert.deepEqual(JSON.parse(missing.stdout).missing, ['TEST_TRACKER_KEY', 'TEST_TRACKER_TOKEN']);
    const failed = await run('node', [CLI, 'read-card', 'Nope0000', '--root', root, '--origin', fake.origin], { env }).catch((e) => e);
    assert.equal(failed.code, 1, 'a failed call exits 1');
    assert.equal(JSON.parse(failed.stdout).status, 404);
    assert.ok(!failed.stdout.includes(TOKEN) && !failed.stderr.includes(TOKEN) && !failed.stderr.includes(KEY));
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------------------ the folder itself

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('the folder has no dependency: every import is node: or a file here or in the sibling scripts', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies, undefined);
  for (const file of walk(ROOT).filter((f) => f.endsWith('.mjs'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${path.relative(ROOT, file)} imports ${spec}`);
    }
  }
});

test('the folder names no real id: every 24-character id in it is an invented one', () => {
  for (const file of walk(ROOT)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\b[0-9a-f]{24}\b/g)) assert.ok(m[0].startsWith('5f00000000'), `${path.relative(ROOT, file)} holds ${m[0]}`);
  }
});

test('the README documents every command, flag and exit code', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const source = fs.readFileSync(CLI, 'utf8');
  for (const m of source.matchAll(/^\s{2}'?([a-z-]+)'?: \{ type/gm)) if (m[1] !== 'help') assert.ok(readme.includes(`--${m[1]}`), `README lacks --${m[1]}`);
  for (const c of ['statuses', 'list-cards', 'read-card', 'find-cards', 'actions-since', 'download-attachment', 'comment', 'move', 'add-label', 'remove-label', 'set-description', 'create-card']) assert.ok(readme.includes(`\`${c}`), `README lacks ${c}`);
  for (const w of ['neverRead', 'transitions', 'intake', 'lastActivity', 'skippedNeverRead', 'unresolved', 'refused', '429']) assert.ok(readme.includes(w), `README lacks ${w}`);
});
