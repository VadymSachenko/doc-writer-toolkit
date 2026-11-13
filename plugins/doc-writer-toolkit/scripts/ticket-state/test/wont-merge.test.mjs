import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, gitRepo, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runDaily, scriptedCalls } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { renderReport } from '../lib/report.mjs';
import { gatesOf, notifyGates, progressPath, writeProgress } from '../lib/progress.mjs';
import { cleanupTicket } from '../lib/cleanup.mjs';
import { droppedLabel } from '../lib/ledger.mjs';
import { parseUsage } from '../lib/allowance.mjs';

// D-155: a PR the owner closed with `forge.wontMergeLabel` is dropped from its ticket, and the ticket's other PRs go on.
// No step is made for it, nothing on the forge is done to it, and it holds no page and keeps no work file. Reopened, or
// with the label taken off, it is not dropped any more. With no such label set, a PR closed unmerged puts the ticket
// outside the flow, as before.

const WONT = "won't merge";
const WITH_LABEL = { forge: { ...rawSettings().forge, wontMergeLabel: WONT } };
// Both targets with a translation label, so a move to In translation changes the labels of every PR it takes.
const WITH_TRANSLATION = { ...WITH_LABEL, targets: rawSettings().targets.map((t) => ({ ...t, labels: { ...t.labels, translation: 'In translation' } })) };
const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'b'.repeat(40);
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const fmt = (s) => `${s.stage}${s.pr ? ` ${s.pr}` : ''}${s.to ? ` -> ${s.to}` : ''}`;
const steps = (t) => t.steps.map(fmt);
const moved = (c, status) => {
  c.placeId = LISTS[status].id;
};
const run = (w, spawnClaude, options = {}, io = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] }), spawnClaude, ...io }, options: { morning: false, trigger: 'watch', ...options } });
const noSession = async () => {
  throw new Error('a session started');
};
const stopHere = async () => ({ code: 1, stdout: '', stderr: 'stop here' });
// Every write the fake forge received that names the PR (a label, a comment, a review request, a description).
const writesOn = (w, number) => w.forge.log.filter((e) => e.some((x) => x === number || (x && typeof x === 'object' && Number(x.number) === number)));

// Two PRs on one card, the guide's open and the API's closed: with the label, or not, or reopened.
function twoPrs({ number = 1601, status = 'finalReview', apiState = 'closed', apiLabels = ['In final review', WONT], guideState = 'open', stages = { guide: 'finalReview', api: 'finalReview' }, extra = WITH_LABEL } = {}) {
  const c = card({ number, status });
  const guide = pr({ repo: 'guide-docs', number: 71, state: guideState, headCommit: HEAD, labels: ['In final review'] });
  const api = pr({ repo: 'api-docs', number: 72, state: apiState, headCommit: HEAD, labels: apiLabels });
  const w = world({ cards: [c], prs: [guide, api], extra });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 71, targets: ['guide'], review: 'sme', stage: stages.guide }, { repo: 'api-docs', number: 72, targets: ['api'], review: 'places', stage: stages.api }] });
  return { w, c, guide, api, key: String(number) };
}

test('the helper: closed, not merged and labelled, matched without case or outer spacing; never with no label set', () => {
  const settings = { forge: { wontMergeLabel: WONT } };
  assert.equal(droppedLabel({ state: 'closed', labels: ["Won't Merge "] }, settings), "Won't Merge ");
  assert.equal(droppedLabel({ state: 'closed', labels: ['wontfix'] }, settings), null);
  assert.equal(droppedLabel({ state: 'open', labels: [WONT] }, settings), null);
  assert.equal(droppedLabel({ state: 'merged', labels: [WONT] }, settings), null);
  assert.equal(droppedLabel({ state: 'closed', labels: [WONT] }, { forge: {} }), null);
});

test('AC-1: one PR closed as won\'t merge, the card moved by a person: the move is followed for the other PR, and nothing is done to the dropped one', async () => {
  const { w, c, key } = twoPrs({ extra: WITH_TRANSLATION });
  moved(c, 'translation');
  const t = await w.one(key);
  assert.deepEqual(steps(t), ['follow -> translation']);
  assert.deepEqual(t.next.dropped, ['api-docs#72'], 'the step names the dropped PR, so the runner leaves it alone');
  const api = t.prs.find((p) => p.id === 'api-docs#72');
  assert.deepEqual([api.dropped, api.next], [{ label: WONT }, null]);
  assert.equal(t.prs.find((p) => p.id === 'guide-docs#71').dropped, undefined);
  assert.ok(t.notes.includes(`api-docs#72 was closed as «${WONT}»: the ticket goes on without it`), t.notes.join('; '));
  // The plan of the step names the guide's PR only.
  const calls = scriptedCalls({ ...t.next, keys: [key] }, read(w, key), w.settings);
  assert.ok(calls.some((x) => /--number 71\b/.test(x)), calls.join('\n'));
  assert.ok(!calls.some((x) => /--number 72\b/.test(x)), calls.join('\n'));

  // The run follows the move, then the chain's first session on the guide's PR (stopped here).
  const out = await run(w, stopHere, { named: [key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome])[0], ['follow', 'done']);
  assert.deepEqual(writesOn(w, 72), [], 'no label, comment or review request on the dropped PR');
  assert.deepEqual(writesOn(w, 71).filter((e) => e[0] === 'changeLabels').map((e) => [e[3], e[4]]), [[['In translation'], ['In final review']]], 'the guide PR got its translation label');
  const l = read(w, key);
  assert.deepEqual(l.prs.map((p) => [p.number, p.stage, Boolean(p.approval)]), [[71, 'translation', true], [72, 'finalReview', false]]);

  // The next status: the chain on the guide's PR (its session stopped twice here, so it is held for the owner); the card
  // is not sent back to where the dropped PR stands.
  const after = await w.one(key);
  assert.equal(after.state, 'translation');
  assert.ok(!steps(after).some((s) => s.startsWith('move')), steps(after).join(', '));
  assert.deepEqual([after.failed?.stage, after.failed?.pr], ['translate', 'guide-docs#71']);
  const fresh = twoPrs({ number: 1613, status: 'translation', stages: { guide: 'translation', api: 'finalReview' } });
  const f = await fresh.w.one(fresh.key);
  assert.deepEqual([f.state, steps(f)], ['translation', ['translate guide-docs#71']], 'no move back to the final review');
});

test('AC-1: a dropped PR at the stage of the card moves with no step, no label and no review request on a move to the review', async () => {
  const { w, c, key } = twoPrs({ number: 1603 });
  moved(c, 'smeReview');
  const t = await w.one(key);
  assert.deepEqual(steps(t), ['follow -> smeReview']);
  const out = await run(w, noSession, { named: [key] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['follow', 'done']]);
  assert.deepEqual(writesOn(w, 72), []);
  assert.ok(writesOn(w, 71).some((e) => e[0] === 'requestReviewers'), 'the guide PR\'s expert is asked');
  assert.deepEqual(read(w, key).prs.map((p) => [p.number, p.stage]), [[71, 'smeReview'], [72, 'finalReview']]);
});

test('AC-2: the other PR merged: close, and the close records the dropped PR as dropped, its stage kept; nothing on the forge names it', async () => {
  const { w, c, key } = twoPrs({ number: 1602, status: 'translation', guideState: 'merged', stages: { guide: 'readyForMerge', api: 'finalReview' } });
  const repo = gitRepo(w.root);
  repo.commit({ '.gitignore': '.flow/\n*.mp4\n' });
  fs.mkdirSync(path.join(w.root, 'docs/pay/.sources'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'docs/pay/.sources/call.mp4'), Buffer.alloc(500, 1));
  const l0 = read(w, key);
  ledger(w, c, { stages: BASE, prs: l0.prs, files: [{ path: 'docs/pay/.sources/call.mp4', kind: 'video', bytes: 0, stage: 'videoGate', at: ago(30) }] });
  const t = await w.one(key);
  assert.equal(t.state, 'merged');
  assert.deepEqual(steps(t), ['close']);
  assert.deepEqual(t.next.dropped, ['api-docs#72']);
  const trash = path.join(tmp('fake-trash-'), '.Trash');
  const out = await run(w, noSession, { named: [key] }, { trashDir: trash });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['close', 'done']]);
  const l = read(w, key);
  assert.equal(l.stages.close.status, 'done');
  assert.deepEqual(l.prs.map((p) => [p.number, p.stage, p.dropped?.label ?? null]), [[71, 'merged', null], [72, 'finalReview', WONT]]);
  // The dropped PR kept no work file: the video went to the Trash.
  assert.equal(l.stages.close.result.cleanup.blocked, null);
  assert.equal(fs.existsSync(path.join(w.root, 'docs/pay/.sources/call.mp4')), false);
  assert.deepEqual(fs.readdirSync(trash), ['call.mp4']);
  assert.deepEqual(writesOn(w, 72), []);
  assert.equal(w.tracker.cards.find((x) => x.id === c.id).placeId, LISTS.done.id);
});

test('AC-2: `record close` needs every PR that is not dropped merged; the label taken off makes the PR count again; every PR dropped is refused', async () => {
  const ok = twoPrs({ number: 1604, status: 'done', guideState: 'merged', stages: { guide: 'readyForMerge', api: 'finalReview' } });
  const r = await runRecord({ settings: ok.w.settings, clients: ok.w.clients(), key: ok.key, stage: 'close', status: 'done', now: NOW });
  assert.ok(r);
  assert.equal(read(ok.w, ok.key).stages.close.status, 'done');

  const off = twoPrs({ number: 1605, status: 'done', guideState: 'merged', apiLabels: ['In final review'], stages: { guide: 'readyForMerge', api: 'finalReview' } });
  await assert.rejects(runRecord({ settings: off.w.settings, clients: off.w.clients(), key: off.key, stage: 'close', status: 'done', now: NOW }), /not every PR is merged: api-docs#72/);

  const unset = twoPrs({ number: 1606, status: 'done', guideState: 'merged', stages: { guide: 'readyForMerge', api: 'finalReview' }, extra: {} });
  await assert.rejects(runRecord({ settings: unset.w.settings, clients: unset.w.clients(), key: unset.key, stage: 'close', status: 'done', now: NOW }), /not every PR is merged: api-docs#72/, 'with no label set, as before');

  const all = twoPrs({ number: 1607, status: 'done', guideState: 'closed', stages: { guide: 'finalReview', api: 'finalReview' } });
  all.guide.labels = [WONT];
  await assert.rejects(runRecord({ settings: all.w.settings, clients: all.w.clients(), key: all.key, stage: 'close', status: 'done', now: NOW }), /no PR is merged: every one was closed as won't merge/);
});

test('AC-3: closed without the label, or with the setting unset: outside, as before; reopened with the label on: in the flow; every PR dropped: outside, with a note', async () => {
  for (const variant of [{ apiLabels: ['In final review', 'wontfix'] }, { extra: {} }]) {
    const { w, c, key } = twoPrs(variant);
    moved(c, 'translation');
    const t = await w.one(key);
    assert.equal(t.state, 'outside');
    assert.deepEqual(t.steps, []);
    assert.deepEqual(t.notes, ['api-docs#72 was closed unmerged']);
    assert.equal(t.prs.find((p) => p.id === 'api-docs#72').dropped, undefined);
  }

  // Reopened, the label still on: an open PR like any other, taken by the move.
  const re = twoPrs({ apiState: 'open' });
  moved(re.c, 'translation');
  const t = await re.w.one(re.key);
  assert.deepEqual(steps(t), ['follow -> translation']);
  assert.equal(t.next.dropped, undefined);
  assert.equal(t.prs.find((p) => p.id === 'api-docs#72').dropped, undefined);
  assert.ok(scriptedCalls({ ...t.next, keys: [re.key] }, read(re.w, re.key), re.w.settings).some((x) => /--number 72\b/.test(x)));

  // Every PR closed as won't merge: nothing is left for the pipeline.
  const all = twoPrs({ guideState: 'closed' });
  all.guide.labels = [WONT];
  moved(all.c, 'translation');
  const a = await all.w.one(all.key);
  assert.equal(a.state, 'outside');
  assert.deepEqual(a.steps, []);
  assert.equal(a.gate.who, 'owner');
  assert.deepEqual(a.notes, [`every PR of the ticket was closed as «${WONT}» (guide-docs#71, api-docs#72): nothing is left for the pipeline; move the card out of the flow or archive it`]);
  assert.deepEqual(a.prs.map((p) => p.dropped), [{ label: WONT }, { label: WONT }]);
});

test('AC-3: a stage left running on the dropped PR is not resumed', async () => {
  const { w, c, key } = twoPrs({ number: 1608, status: 'translation', stages: { guide: 'translation', api: 'translation' } });
  const l = read(w, key);
  l.prs[1].chain = { translate: { status: 'running', seq: 20, at: ago(1) } };
  ledger(w, c, { stages: BASE, prs: l.prs });
  const t = await w.one(key);
  assert.ok(!t.steps.some((s) => s.pr === 'api-docs#72'), steps(t).join(', '));
  assert.deepEqual([t.next?.stage, t.next?.pr], ['translate', 'guide-docs#71']);
});

test('AC-4: the report shows the dropped PR as dropped, and in no list that waits for the owner', async () => {
  const { w, key } = twoPrs({ number: 1609, stages: { guide: 'finalReview', api: 'readyForMerge' } });
  const l = read(w, key);
  l.prs[1].readyForMerge = [{ head: HEAD, at: ago(3) }];
  l.prs[1].expertReview = { recommended: true, why: 'a fee no source confirms' };
  l.places = [{ id: 'p1', repo: 'api-docs', pr: 72, page: 'docs/a.md', state: 'open' }];
  ledger(w, { ...w.tracker.cards[0] }, { stages: BASE, prs: l.prs, places: l.places });
  const st = await w.status();
  const text = renderReport({ settings: w.settings, st, date: '2026-11-10' });
  assert.match(text, new RegExp(`## PRs closed as «${WONT}»\\n\\n- \\[api-docs#72\\]\\(https://forge\\.example/acme/api-docs/pull/72\\) \\(\\[${key}\\]\\([^)]*\\)\\): closed as «${WONT}»: the ticket goes on without it`));
  const section = (name) => text.split(`## ${name}`)[1].split('\n## ')[0];
  for (const name of ['Ready for merge', 'PRs with places', 'Expert review, your call']) assert.ok(!section(name).includes('api-docs#72'), name);
  // With no label set, no such section.
  const plain = twoPrs({ number: 1610, extra: {} });
  assert.ok(!renderReport({ settings: plain.w.settings, st: await plain.w.status(), date: '2026-11-10' }).includes('PRs closed as'));
});

test('AC-4: the progress file shows the dropped PR as dropped, with no gate and no notification; reopened, it waits again', async () => {
  const { w, key, api } = twoPrs({ number: 1611, stages: { guide: 'smeReview', api: 'finalReview' } });
  writeProgress({ settings: w.settings, now: NOW, st: await w.status() });
  const sent = [];
  const notify = (m) => (sent.push(m), { sent: true });
  notifyGates({ settings: w.settings, notify, now: NOW });
  const text = fs.readFileSync(progressPath(w.settings.state), 'utf8');
  assert.match(text, /\*\*PR api-docs#72\*\* — dropped\n\n- 🚫 Closed as «won't merge»: the ticket goes on without it/);
  assert.ok(!text.split('## The current run')[0].split('## The last run')[0].includes('api-docs#72'), 'not under Waiting for you');
  assert.deepEqual(gatesOf(read(w, key), { [`${key}|api-docs#72`]: { label: WONT } }).map((g) => g.pr), ['guide-docs#71']);
  assert.ok(!sent.some((m) => m.text.includes('api-docs#72')));

  // Reopened: the next status takes the mark off, and the owner's read of its UA waits again.
  api.state = 'open';
  writeProgress({ settings: w.settings, now: NOW + 1000, st: await w.status() });
  notifyGates({ settings: w.settings, notify, now: NOW + 1000 });
  const again = fs.readFileSync(progressPath(w.settings.state), 'utf8');
  assert.ok(!again.includes('🚫'));
  assert.match(again, /- 👉 1611 [^\n]*— api-docs#72: read the UA/);
  assert.ok(sent.some((m) => m.text.includes('api-docs#72')));
});

test('AC-4: the close removes the work files with every other PR merged and one dropped; a PR closed unmerged still keeps them', () => {
  const { w, key } = twoPrs({ number: 1612 });
  const l = read(w, key);
  const base = { settings: w.settings, ledger: { ...l, files: [{ path: 'docs/x/.sources/call.mp4', kind: 'video' }] }, dryRun: true };
  const states = (api) => (p) => (p.number === 71 ? 'merged' : api);
  assert.equal(cleanupTicket({ ...base, prState: states('dropped') }).blocked, null);
  assert.match(cleanupTicket({ ...base, prState: states('closed') }).blocked, /api-docs#72 closed unmerged: nothing is removed/);
});
