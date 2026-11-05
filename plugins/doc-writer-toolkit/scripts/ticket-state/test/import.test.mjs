import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, card, pr, quietGit, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { holdsEveryLine, parseMarkdown, removeClosedMarkdown, runImport } from '../lib/import.mjs';
import { writeLedger } from '../lib/ledger.mjs';
import { runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { makeClients } from '../lib/world.mjs';
import { main as stateMain } from '../ticket-state.mjs';

// `ticket-state import`: the Markdown ledgers from before the JSON ones, each into a JSON ledger that holds every
// line; the closed tickets' Markdown removed after the check, the open ones kept; the morning run repeats the removal.

const SIZES = { 'small fix': 'edit', 'new page': 'newPage' };
const usageAt = (week) => parseUsage(`Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);

const MD = {
  // Closed: the card is done and its PR merged.
  701: [
    'key: 701',
    'stage: triaged',
    'docs_card: https://tracker.example/c/Card0701',
    'original: https://tracker.example/c/Orig0701',
    'verdict: docs-required',
    'targets: Guide → guide-docs docs/a/a.md; Api — not documented',
    'size: small fix',
    'relations: —',
    'evidence: a description and two pictures',
    'triaged_at: 2026-11-01T08:00:00Z',
    'stage: pr-open',
    'branch[guide-docs]: 701-a-doc',
    'pr[guide-docs]: https://github.com/acme/guide-docs/pull/71 (opened, reviewer asked)',
    'commit: abc1234 «Draft» (no trailers)',
    'stage: closed',
    'closed_at: 2026-11-08 — merged',
  ],
  // Open: the card is in final review, its PR open.
  702: [
    'key: 702',
    'stage: triaged',
    'docs_card: https://tracker.example/c/Card0702',
    'verdict: docs-required',
    'targets: Api → api-docs docs/b/b.md; Guide → guide-docs docs/c/c.md',
    'size: new page',
    'relations: 701 (merged in 2026 by 3 people), PR #9 also touches it; 704',
    'pages: api-docs docs/b/b.md — the error table; docs/b/c.md (new); guide-docs docs/c/c.md, docs/c/d.md',
    'triaged_at: 2026-11-02T08:00:00Z',
    'group: 702',
    'stage: drafted',
    'branch: api-docs=702-b-doc',
    'pr.api-docs: https://github.com/acme/api-docs/pull/72',
    'stage: pr-open',
    'notes: a free line',
  ],
  // Ready: triaged only, the card still in the ready status.
  703: [
    'key: 703',
    'stage: triaged',
    'docs_card: https://tracker.example/c/Card0703',
    'verdict: docs-required',
    'targets: Guide → guide-docs docs/e/e.md',
    'size: new page',
    'relations: —',
    'pages: guide-docs docs/e/e.md — a new section',
    'missing: —',
    'triaged_at: 2026-11-03T08:00:00Z',
  ],
};
const text = (key) => MD[key].join('\n') + '\n';

function legacyWorld({ extra } = {}) {
  const cards = {
    701: card({ number: 701, status: 'done', shortLink: 'Card0701' }),
    702: card({ number: 702, status: 'finalReview', shortLink: 'Card0702', labels: ['high'] }),
    703: card({ number: 703, status: 'ready', shortLink: 'Card0703' }),
  };
  const prs = [pr({ repo: 'guide-docs', number: 71, state: 'merged', head: '701-a-doc' }), pr({ repo: 'api-docs', number: 72, head: '702-b-doc' })];
  const w = world({ cards: Object.values(cards), prs, extra: { limits: { estimates: { edit: 4, newPage: 8 } }, ...extra } });
  fs.mkdirSync(w.settings.state, { recursive: true });
  for (const k of Object.keys(MD)) fs.writeFileSync(path.join(w.settings.state, `${k}.md`), text(k));
  return { w, cards, trash: tmp('ticket-trash-') };
}
const mdIn = (w) => fs.readdirSync(w.settings.state).filter((n) => n.endsWith('.md')).sort();

test('import: closed, open and ready tickets, each with every line; only the closed Markdown goes, to the Trash', async () => {
  const { w, trash } = legacyWorld();
  const out = await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: trash });
  assert.deepEqual(out.imported.map((x) => [x.key, x.state, x.mode, x.stage, x.lastStage]), [
    ['701', 'closed', 'hand', 'close', 'closed'],
    ['702', 'open', 'hand', 'pr', 'pr-open'],
    ['703', 'ready', 'pipeline', 'triage', 'triaged'],
  ]);
  assert.deepEqual(out.removed.map((x) => [x.key, path.dirname(x.to)]), [['701', trash]]);
  assert.deepEqual(out.kept.map((x) => [x.key, x.why]), [['702', 'open'], ['703', 'open']]);
  assert.deepEqual(mdIn(w), ['702.md', '703.md']);

  // The closed one: its close recorded, the PR merged, and the JSON rebuilds the Markdown now in the Trash.
  const a = read(w, '701');
  assert.equal(a.stages.close.status, 'done');
  assert.deepEqual([a.prs[0].repo, a.prs[0].number, a.prs[0].branch, a.prs[0].stage, a.prs[0].targets], ['guide-docs', 71, '701-a-doc', 'merged', ['guide']]);
  assert.deepEqual([a.triage.targets, a.triage.size, a.original.shortLink, a.card.shortLink], [['guide'], 'edit', 'Orig0701', 'Card0701']);
  assert.ok(holdsEveryLine(a.legacy, fs.readFileSync(out.removed[0].to, 'utf8')).ok);
  assert.equal(a.legacy.mapped.length + a.legacy.fields.length, MD[701].length);
  assert.ok(a.legacy.fields.some((f) => f.key === 'commit'), 'a line no field takes is kept as it is');

  // The open one: the owner's until handover, its PR at the card's stage, its triage read.
  const b = read(w, '702');
  assert.deepEqual([b.mode, b.stages.pr.status, b.prs[0].stage, b.prs[0].branch, b.priority], ['hand', 'done', 'finalReview', '702-b-doc', 'high']);
  assert.deepEqual(b.triage.targets, ['api', 'guide']);
  assert.deepEqual(b.triage.relations, ['701', '704'], 'a PR number is not a relation');
  assert.deepEqual(b.triage.pages, [{ repo: 'api-docs', path: 'docs/b/b.md' }, { repo: 'api-docs', path: 'docs/b/c.md' }, { repo: 'guide-docs', path: 'docs/c/c.md' }, { repo: 'guide-docs', path: 'docs/c/d.md' }]);
  assert.ok(b.log.filter((e) => /the Markdown ledger's stage/.test(e.note)).map((e) => e.stage).join() === 'triage,write,pr');

  // The ready one: a ticket the scheduled run may start, with its size for the easiest-first order.
  const c = read(w, '703');
  assert.deepEqual([c.mode, c.startedBy, c.stages.triage.status, c.triage.size], ['pipeline', null, 'done', 'newPage']);
  const st = await w.status({ usage: usageAt(5) });
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t]));
  assert.deepEqual([by['701'].state, by['702'].mode, by['703'].state], ['closed', 'hand', 'ready']);
  assert.equal(by['702'].counted, false, 'an imported open ticket counts for no limit');
  assert.deepEqual(st.startable.map((g) => g.group), ['703']);
  assert.deepEqual([w.tracker.log, w.forge.log], [[], []], 'the import reads the tracker and the forge, never writes');
});

test('import: a dry run writes and moves nothing, and lists what a live one would do', async () => {
  const { w, trash } = legacyWorld();
  const before = snapshot(w.root);
  const out = await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, dryRun: true, now: NOW, trashDir: trash });
  assert.deepEqual(snapshot(w.root), before);
  assert.deepEqual(fs.readdirSync(trash), []);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.imported.map((x) => [x.key, x.state]), [['701', 'closed'], ['702', 'open'], ['703', 'ready']]);
  assert.deepEqual(out.removed.map((x) => [x.key, x.to, x.dryRun]), [['701', 'the Trash', true]]);
  assert.deepEqual(out.kept.map((x) => [x.key, x.why]), [['702', 'open'], ['703', 'open: ready, the pipeline may start it']]);
});

test('import: a Markdown changed after the import is kept until imported again; then it goes once its ticket closes', async () => {
  const { w, cards, trash } = legacyWorld();
  await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: trash });
  // The old process appends a line to the open ticket; then the card is done and its PR merged.
  fs.appendFileSync(path.join(w.settings.state, '702.md'), 'stage: closed\n');
  cards[702].placeId = card({ status: 'done' }).placeId;
  w.forge.prs.find((p) => p.number === 72).state = 'merged';
  let r = await removeClosedMarkdown({ settings: w.settings, clients: w.clients(), trashDir: trash });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.kept.find((x) => x.key === '702').why, 'closed, but the Markdown has 16 lines, the JSON holds 15 (changed since the import): run the import again');
  assert.ok(mdIn(w).includes('702.md'));
  // Imported again (nothing recorded into it since): the new line is in, the ticket closed, the Markdown removed.
  const again = await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW + 60000, trashDir: trash });
  assert.deepEqual(again.imported.map((x) => [x.key, x.again, x.state]), [['702', true, 'closed']]);
  assert.deepEqual(again.skipped.map((x) => [x.key, x.why]), [['703', 'imported before, unchanged']]);
  assert.deepEqual(again.removed.map((x) => x.key), ['702']);
  assert.equal(read(w, '702').legacy.lastStage, 'closed');
  r = await removeClosedMarkdown({ settings: w.settings, clients: w.clients(), trashDir: trash });
  assert.deepEqual([r.removed, r.kept.map((x) => x.key)], [[], ['703']]);
});

test('import: a ledger not from an import, or recorded into since, is never overwritten, and its Markdown stays', async () => {
  const { w, cards, trash } = legacyWorld();
  ledger(w, cards[701], { key: '701', stages: { triage: 'done', close: 'done' } });
  await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: trash });
  const l = read(w, '703');
  l.seq += 1;
  l.log.push({ seq: l.seq, at: new Date(NOW).toISOString(), stage: 'start', outcome: 'done' });
  writeLedger(w.settings.state, l);
  fs.appendFileSync(path.join(w.settings.state, '703.md'), 'note: later\n');
  const before = snapshot(path.join(w.settings.state, 'tickets'));
  const out = await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: trash });
  assert.deepEqual(out.imported, []);
  assert.deepEqual(out.skipped.map((x) => [x.key, x.why]), [
    ['701', 'a ledger with this key exists, not from an import: nothing written, the Markdown kept'],
    ['702', 'imported before, unchanged'],
    ['703', 'imported before and recorded into since: not imported again'],
  ]);
  assert.deepEqual(snapshot(path.join(w.settings.state, 'tickets')), before);
  assert.deepEqual(mdIn(w), ['701.md', '702.md', '703.md']);
});

test('import: the per-repo name forms, and what it could not map, are listed; every line is still kept', async () => {
  const w = world({ cards: [card({ number: 705, status: 'inProgress', shortLink: 'Card0705' })], prs: [pr({ repo: 'api-docs', number: 81 })] });
  fs.mkdirSync(w.settings.state, { recursive: true });
  const lines = [
    'key: 705',
    'stage: triaged',
    'docs_card: https://tracker.example/c/Card0705',
    'targets: Api → api-docs docs/x.md; Gide → guide-docs docs/y.md',
    'size: huge',
    'branch.api-docs: 705-x',
    'pr: api-docs=https://github.com/acme/api-docs/pull/81 (and a link elsewhere: https://github.com/someone/else/pull/3)',
    'branch: guide-docs=705-y',
    'a line with no name',
    '',
    'stage: polished',
  ];
  fs.writeFileSync(path.join(w.settings.state, '705.md'), lines.join('\n'));
  const out = await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: tmp() });
  const l = read(w, '705');
  assert.deepEqual(l.prs.map((p) => [p.repo, p.number, p.branch, p.targets]), [['api-docs', 81, '705-x', ['api']]]);
  assert.deepEqual(out.imported[0].misses, [
    "target label(s) 'Gide' name no target",
    "size 'huge' (no --size for it)",
    'a branch with no PR link in guide-docs (kept in the legacy lines only)',
    "stage 'polished' is not a known old stage",
  ]);
  assert.equal(l.legacy.endsWithNewline, false);
  assert.ok(holdsEveryLine(l.legacy, fs.readFileSync(path.join(w.settings.state, '705.md'), 'utf8')).ok);
  assert.deepEqual(parseMarkdown(lines.join('\n')).lines.filter((x) => x.raw !== undefined).map((x) => x.n), [9, 10]);
});

test('import: the check refuses a JSON that misses or changes a line', () => {
  const t = 'key: 1\nstage: triaged\n';
  const legacy = { endsWithNewline: true, mapped: [{ n: 1, key: 'key', value: '1' }], fields: [{ n: 2, key: 'stage', value: 'triaged' }] };
  assert.ok(holdsEveryLine(legacy, t).ok);
  assert.match(holdsEveryLine({ ...legacy, fields: [] }, t).why, /the Markdown has 2 lines, the JSON holds 1/);
  assert.match(holdsEveryLine({ ...legacy, fields: [{ n: 2, key: 'stage', value: 'planned' }] }, t).why, /differs/);
  assert.match(holdsEveryLine({ ...legacy, endsWithNewline: false }, t).why, /differs/);
  assert.match(holdsEveryLine({ ...legacy, fields: [...legacy.fields, { n: 2, raw: 'x' }] }, t).why, /line 3 is missing or repeated/);
});

test('import: cleanup.mode delete deletes the closed Markdown instead of moving it', async () => {
  const { w, trash } = legacyWorld({ extra: { cleanup: { mode: 'delete' } } });
  const out = await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: trash });
  assert.deepEqual(out.removed.map((x) => [x.key, x.to]), [['701', 'deleted']]);
  assert.deepEqual(fs.readdirSync(trash), []);
  assert.deepEqual(mdIn(w), ['702.md', '703.md']);
});

test('the morning run repeats the removal: a dry run lists it, a live run moves the Markdown and reports it', async () => {
  const { w, cards, trash } = legacyWorld();
  await runImport({ settings: w.settings, clients: w.clients(), sizes: SIZES, now: NOW, trashDir: trash });
  cards[702].placeId = card({ status: 'done' }).placeId;
  w.forge.prs.find((p) => p.number === 72).state = 'merged';
  const io = { readUsage: () => usageAt(5), now: () => NOW, trashDir: trash, spawnClaude: () => assert.fail('no session: only the removal is due'), git: quietGit };

  const clients = makeClients({ settings: w.settings, io: { trackerAdapter: w.tracker, forgeAdapter: w.forge }, dryRun: true });
  const before = snapshot(w.root);
  const dry = await runDaily({ settings: w.settings, clients, io, options: { dryRun: true, morning: true, trigger: 'manual' } });
  assert.deepEqual(dry.legacyMarkdown.removed.map((x) => [x.key, x.dryRun]), [['702', true]]);
  assert.deepEqual(snapshot(w.root), before);

  const noon = await runDaily({ settings: w.settings, clients: w.clients(), io, options: { trigger: 'manual' } });
  assert.equal(noon.legacyMarkdown, undefined, 'only the morning run removes');
  assert.ok(mdIn(w).includes('702.md'));

  const live = await runDaily({ settings: w.settings, clients: w.clients(), io, options: { morning: true, trigger: 'manual' } });
  assert.deepEqual(live.legacyMarkdown.removed.map((x) => [x.key, path.dirname(x.to)]), [['702', trash]]);
  assert.deepEqual(mdIn(w), ['703.md']);
  const report = fs.readFileSync(path.join(w.root, live.reportFile), 'utf8');
  assert.match(report, /702: the Markdown ledger `702\.md` \(closed; its JSON holds every line\) moved to the Trash/);
});

test('the import through the CLI: --size pairs, --dry-run, and a size that is not one stops with exit 2', async () => {
  const { w } = legacyWorld();
  fs.mkdirSync(path.join(w.root, '.claude'));
  fs.writeFileSync(path.join(w.root, '.claude', 'ticket-flow.json'), JSON.stringify(rawSettings()));
  const run = async (argv) => {
    let out = '';
    const code = await stateMain(['import', '--root', w.root, ...argv], { stdout: { write: (s) => (out += s) }, env: {}, now: () => NOW, trackerAdapter: w.tracker, forgeAdapter: w.forge });
    return { code, json: JSON.parse(out) };
  };
  const before = snapshot(w.root);
  const r = await run(['--dry-run', '--size', 'small fix=edit', '--size', 'new page=newPage']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.imported.map((x) => [x.key, x.triage.size]), [['701', 'edit'], ['702', 'newPage'], ['703', 'newPage']]);
  assert.deepEqual(snapshot(w.root), before);
  await assert.rejects(run(['--size', 'small fix=tiny']), (e) => e.exitCode === 2 && /the size must be one of edit, newPage, newSection/.test(e.message));
  await assert.rejects(run(['--size', 'nothing']), (e) => e.exitCode === 2 && /give <word>=<size>/.test(e.message));
});

test('import: a card the tracker no longer has and a PR the forge no longer has count as closed', async () => {
  const w = world({ cards: [], prs: [] });
  fs.mkdirSync(w.settings.state, { recursive: true });
  fs.writeFileSync(path.join(w.settings.state, '706.md'), ['key: 706', 'stage: pr-open', 'docs_card: https://tracker.example/c/Gone0706', 'pr: https://github.com/acme/guide-docs/pull/99', ''].join('\n'));
  const trash = tmp();
  const out = await runImport({ settings: w.settings, clients: w.clients(), now: NOW, trashDir: trash });
  assert.deepEqual(out.imported.map((x) => [x.key, x.state, x.prs]), [['706', 'closed', ['guide-docs#99']]]);
  assert.deepEqual(out.removed.map((x) => x.key), ['706']);
  assert.equal(read(w, '706').card.shortLink, 'Gone0706', 'the card the Markdown named is kept');
});

test('import: an archived card with its PR merged is closed; a ready card past triage, or with an open PR, stays the owner', async () => {
  const w = world({
    cards: [card({ number: 707, status: 'inProgress', shortLink: 'Card0707', closed: true }), card({ number: 708, status: 'ready', shortLink: 'Card0708' }), card({ number: 709, status: 'done', shortLink: 'Card0709' })],
    prs: [pr({ repo: 'guide-docs', number: 77, state: 'merged' }), pr({ repo: 'guide-docs', number: 79 })],
  });
  fs.mkdirSync(w.settings.state, { recursive: true });
  const md = (k, ...more) => fs.writeFileSync(path.join(w.settings.state, `${k}.md`), [`key: ${k}`, 'stage: triaged', `docs_card: https://tracker.example/c/Card0${k}`, ...more, ''].join('\n'));
  md(707, 'pr: https://github.com/acme/guide-docs/pull/77', 'stage: pr-open');
  md(708, 'stage: gathered');
  md(709, 'pr: https://github.com/acme/guide-docs/pull/79', 'stage: pr-open');
  const out = await runImport({ settings: w.settings, clients: w.clients(), now: NOW, trashDir: tmp() });
  assert.deepEqual(out.imported.map((x) => [x.key, x.state, x.mode]), [['707', 'closed', 'hand'], ['708', 'open', 'hand'], ['709', 'open', 'hand']]);
  assert.deepEqual(out.removed.map((x) => x.key), ['707']);
});
