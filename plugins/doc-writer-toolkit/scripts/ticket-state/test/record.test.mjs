import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, pr } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { runHandover, runLock, runUnlock } from '../lib/handover.mjs';
import { lockOf, takeLock } from '../lib/locks.mjs';

// `record` writes one stage result only when the tracker, the forge and the files support it; on any refusal nothing is
// written. Locks, and the handover that rebuilds a lost ledger.

const rec = (w, args) => runRecord({ settings: w.settings, clients: w.clients(), now: NOW, ...args });
const refused = async (w, args, name) => {
  const before = snapshot(w.settings.state);
  await assert.rejects(rec(w, args), (e) => e.refused === name && e.exitCode === 1 && /^nothing recorded: /.test(e.message));
  assert.deepEqual(snapshot(w.settings.state), before, 'nothing was written');
};
const usage = async (w, args, re) => {
  const before = snapshot(w.settings.state);
  await assert.rejects(rec(w, args), (e) => e.exitCode === 2 && re.test(e.message));
  assert.deepEqual(snapshot(w.settings.state), before);
};

test('triage creates the ledger from the card, with its priority; nothing else creates one', async () => {
  const c = card({ number: 1201, status: 'ready', labels: ['Guide', 'high'] });
  const w = world({ cards: [c] });
  await refused(w, { key: '1201', stage: 'plan', status: 'done' }, 'noLedger');
  await refused(w, { key: '1201', stage: 'triage', status: 'done', result: { verdict: 'docs-required' } }, 'noLedger');
  await usage(w, { key: '1201', stage: 'triage', status: 'done', card: c.shortLink, result: { verdict: 'maybe' } }, /triage needs --result/);
  await refused(w, { key: '1201', stage: 'triage', status: 'done', card: c.shortLink, result: { verdict: 'docs-required', movedTo: 'blocked' } }, 'card');
  const out = await rec(w, { key: '1201', stage: 'triage', status: 'done', card: c.shortLink, result: { verdict: 'docs-required', movedTo: 'ready', targets: ['guide'], size: 'edit' } });
  assert.equal(out.seq, 1);
  const l = read(w, '1201');
  assert.deepEqual([l.priority, l.triage.priority, l.triage.size, l.left.status, l.card.shortLink], ['high', 'high', 'edit', 'ready', c.shortLink]);
  assert.deepEqual([l.stage, l.stages.triage.status, l.log.length], ['triage', 'done', 1]);
});

test('AC-5: no needs-info for a missing app label when the card text settles the target', async () => {
  const c = card({ number: 1202, status: 'intake', desc: 'The Portal UI refunds screen got a new filter.' });
  const w = world({ cards: [c] });
  await refused(w, { key: '1202', stage: 'triage', status: 'done', card: c.shortLink, result: { verdict: 'needs-info', reason: 'noAppLabel' } }, 'textSettles');
  assert.equal(read(w, '1202'), null);
  const vague = card({ number: 1203, status: 'intake', desc: 'Something changed.' });
  const w2 = world({ cards: [vague] });
  await rec(w2, { key: '1203', stage: 'triage', status: 'done', card: vague.shortLink, result: { verdict: 'needs-info', reason: 'noAppLabel' } });
  assert.equal(read(w2, '1203').triage.verdict, 'needs-info');
});

test('start checks the card is in work and records who started it', async () => {
  const c = card({ number: 1210, status: 'ready' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { triage: 'done' } });
  await refused(w, { key: '1210', stage: 'start', status: 'done' }, 'card');
  c.placeId = LISTS.inProgress.id;
  takeLock(w.settings.state, { group: '1210', kind: 'schedule', leaseMinutes: 60, now: NOW });
  const out = await rec(w, { key: '1210', stage: 'start', status: 'done' });
  assert.equal(out.lockRenewed, true);
  assert.equal(read(w, '1210').startedBy, 'schedule');
  assert.equal(lockOf(w.settings.state, '1210', NOW).expiresAt, new Date(NOW + w.settings.limits.lockLeaseMinutes * 60000).toISOString(), 'the record renewed the lease');
  // With no lock (a session the owner started by hand): manual.
  const d = card({ number: 1211, status: 'inProgress' });
  const w2 = world({ cards: [d] });
  ledger(w2, d, { stages: { triage: 'done' }, startedBy: null });
  await rec(w2, { key: '1211', stage: 'start', status: 'done' });
  assert.equal(read(w2, '1211').startedBy, 'manual');
});

test('a question on one PR stops that PR; the answer resumes it where it was', async () => {
  const c = card({ number: 1220, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'portal-docs', number: 81, head: 'b-ui' }), pr({ repo: 'portal-docs', number: 82, head: 'b-api' })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'portal-docs', number: 81, branch: 'b-ui', targets: ['portal-ui'], stage: 'smeReview' }, { repo: 'portal-docs', number: 82, branch: 'b-api', targets: ['portal-api'], stage: 'finalReview' }] });
  await refused(w, { key: '1220', stage: 'questions', status: 'done', pr: 'portal-docs#81', result: { questions: [{ text: 'Which?' }] } }, 'card');
  c.placeId = LISTS.blocked.id;
  await rec(w, { key: '1220', stage: 'questions', status: 'done', pr: 'portal-docs#81', result: { questions: [{ text: 'Which?' }] } });
  let l = read(w, '1220');
  assert.deepEqual(l.prs.map((p) => [p.number, p.stage, p.resumeTo]), [[81, 'questions', 'smeReview'], [82, 'finalReview', null]]);
  assert.deepEqual([l.questions[0].pr, l.questions[0].repo], [81, 'portal-docs']);
  c.placeId = LISTS.inProgress.id;
  await rec(w, { key: '1220', stage: 'answers', status: 'done', pr: 'portal-docs#81' });
  l = read(w, '1220');
  assert.deepEqual(l.prs.map((p) => [p.number, p.stage, p.resumeTo]), [[81, 'smeReview', null], [82, 'finalReview', null]]);
  assert.ok(l.questions[0].answer);
});

test('the plan gate keeps the plan hash; a changed plan is a new gate, not an approval', async () => {
  const c = card({ number: 1230, status: 'blocked' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  await refused(w, { key: '1230', stage: 'planGate', status: 'done', result: { planFile: 'plans/none.md' } }, 'file');
  fs.mkdirSync(path.join(w.root, 'plans'));
  fs.writeFileSync(path.join(w.root, 'plans/s.md'), 'v1');
  await rec(w, { key: '1230', stage: 'planGate', status: 'done', result: { planFile: 'plans/s.md' } });
  c.placeId = LISTS.inProgress.id;
  fs.writeFileSync(path.join(w.root, 'plans/s.md'), 'v2');
  await refused(w, { key: '1230', stage: 'planApproval', status: 'done' }, 'planChanged');
  fs.writeFileSync(path.join(w.root, 'plans/s.md'), 'v1');
  await rec(w, { key: '1230', stage: 'planApproval', status: 'done' });
  assert.ok(read(w, '1230').plan.sectionPlan.approved);
});

test('pr checks each PR is on the forge for its branch and needs the expert review recommendation; every PR goes to the owner\'s queue, whatever its review kind', async () => {
  const c = card({ number: 1240, status: 'inProgress' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 91, head: 'ticket-1240', labels: ['in expert review'] }), pr({ repo: 'api-docs', number: 92, head: 'other-branch' }), pr({ repo: 'api-docs', number: 93, head: 'ticket-1240-api' })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  await usage(w, { key: '1240', stage: 'write', status: 'done', result: { prs: [{ repo: 'portal-docs', branch: 'x', targets: ['portal-ui', 'portal-api'] }] } }, /one review kind only/);
  await usage(w, { key: '1240', stage: 'write', status: 'done', result: { prs: [{ repo: 'elsewhere', branch: 'x' }] } }, /not a repository the targets name/);
  // No worktree on this machine: a write is never done without one (worktree.test.mjs has the worktree cases).
  await refused(w, { key: '1240', stage: 'write', status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-1240', targets: ['guide'], commits: ['1111111'] }] } }, 'notWritten');
  await refused(w, { key: '1240', stage: 'write', status: 'done', result: {} }, 'noPr');
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-1240', targets: ['guide'], review: 'sme', pipelineCommits: ['1111111'] }, { repo: 'api-docs', branch: 'ticket-1240-api', targets: ['api'], review: 'places' }] });
  await rec(w, { key: '1240', stage: 'uaReview', status: 'done' });
  await refused(w, { key: '1240', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1240', number: 91, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }, { branch: 'ticket-1240-api', number: 92, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }] } }, 'noPr');
  await usage(w, { key: '1240', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1240', number: 91 }, { branch: 'ticket-1240-api', number: 93, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }] } }, /each PR needs "expertReview".*\(ticket-1240\)/);
  await usage(w, { key: '1240', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1240', number: 91, expertReview: { recommended: 'yes', why: 'x' } }, { branch: 'ticket-1240-api', number: 93, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }] } }, /expertReview/);
  await usage(w, { key: '1240', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1240', number: 91, expertReview: { recommended: true, why: ' ' } }, { branch: 'ticket-1240-api', number: 93, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }] } }, /expertReview/);
  const out = await rec(w, { key: '1240', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1240', number: 91, expertReview: { recommended: true, why: 'two open questions for the expert: the limit and the fee' } }, { branch: 'ticket-1240-api', number: 93, expertReview: { recommended: false, why: 'every fact is from the code and the UI' } }], places: [{ id: 'p1', repo: 'api-docs', pr: 93, page: 'docs/a.md', line: 4, claim: 'c', why: 'codeOnly' }] } });
  assert.equal(out.warnings, undefined, 'no PR had a review request');
  const l = read(w, '1240');
  assert.deepEqual(l.prs.map((p) => [p.repo, p.number, p.review, p.stage]), [['guide-docs', 91, 'sme', 'finalReview'], ['api-docs', 93, 'places', 'finalReview']]);
  assert.deepEqual(l.prs.map((p) => [p.expertReview.recommended, p.expertReview.why]), [[true, 'two open questions for the expert: the limit and the fee'], [false, 'every fact is from the code and the UI']]);
  assert.deepEqual(l.prs[0].pipelineCommits, ['1111111']);
});

test('move --pr checks the card status and the stage label; only a person\'s move approves, and no record takes a PR into the chain', async () => {
  const head = 'e'.repeat(40);
  const forgePr = pr({ repo: 'api-docs', number: 95, labels: ['In progress'], headCommit: head });
  const c = card({ number: 1250, status: 'inProgress' });
  const w = world({ cards: [c], prs: [forgePr] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'api-docs', number: 95, targets: ['api'], review: 'places', stage: 'reworkWait' }] });
  await refused(w, { key: '1250', stage: 'move', status: 'done', pr: 'api-docs#95', to: 'finalReview' }, 'card');
  c.placeId = LISTS.finalReview.id;
  await refused(w, { key: '1250', stage: 'move', status: 'done', pr: 'api-docs#95', to: 'finalReview' }, 'label');
  forgePr.labels = ['In final review'];
  await rec(w, { key: '1250', stage: 'move', status: 'done', pr: 'api-docs#95', to: 'finalReview' });
  const p = read(w, '1250').prs[0];
  assert.deepEqual([p.stage, p.label, p.approval ?? null], ['finalReview', 'In final review', null]);
  await usage(w, { key: '1250', stage: 'move', status: 'done', pr: 'api-docs#95', to: 'translation' }, /a PR stage/);
});

test('a chain stage is done only for the head the forge shows; ready for merge only when the whole chain is', async () => {
  const head = '7'.repeat(40);
  const c = card({ number: 1260, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 96, headCommit: head })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 96, targets: ['guide'], stage: 'finalReview' }] });
  await usage(w, { key: '1260', stage: 'translate', status: 'done' }, /is a PR stage/);
  await usage(w, { key: '1260', stage: 'translate', status: 'done', pr: 'guide-docs#96' }, /needs --head/);
  await refused(w, { key: '1260', stage: 'translate', status: 'done', pr: 'guide-docs#96', head: '8888888' }, 'stale');
  await rec(w, { key: '1260', stage: 'translate', status: 'done', pr: 'guide-docs#96', head: '7777777', result: { commits: ['7777777'] } });
  await refused(w, { key: '1260', stage: 'readyForMerge', status: 'done', pr: 'guide-docs#96', head }, 'chain');
  const p = read(w, '1260').prs[0];
  assert.deepEqual([p.chain.translate.status, p.chain.translate.head, p.pipelineCommits], ['done', head, ['7777777']]);
  await usage(w, { key: '1260', stage: 'enReview', status: 'failed', pr: 'guide-docs#96' }, /needs --note/);
  await usage(w, { key: '1260', stage: 'bake', status: 'done' }, /unknown stage 'bake'/);
});

test('close needs every PR merged and the card done', async () => {
  const forgePr = pr({ repo: 'guide-docs', number: 97 });
  const c = card({ number: 1270, status: 'done' });
  const w = world({ cards: [c], prs: [forgePr] });
  ledger(w, c, { stages: { start: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 97, targets: ['guide'], stage: 'readyForMerge' }] });
  await refused(w, { key: '1270', stage: 'close', status: 'done' }, 'notMerged');
  Object.assign(forgePr, { state: 'merged', mergedAt: ago(1), mergeCommit: 'f'.repeat(40) });
  await rec(w, { key: '1270', stage: 'close', status: 'done' });
  const l = read(w, '1270');
  assert.deepEqual([l.stages.close.status, l.prs[0].stage, l.prs[0].merged.commit], ['done', 'merged', 'f'.repeat(40)]);
});

test('D-074: a stage records its work files outside git; a path outside the host and the state is refused', async () => {
  const c = card({ number: 1280, status: 'inProgress' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  fs.mkdirSync(path.join(w.root, 'docs/a/.sources'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'docs/a/.sources/call.mp4'), Buffer.alloc(2048));
  await usage(w, { key: '1280', stage: 'plan', status: 'done', result: { files: [{ path: '../elsewhere/x.mp4', kind: 'video' }] } }, /not a path inside the host repo or the state root/);
  await usage(w, { key: '1280', stage: 'plan', status: 'done', result: { files: [{ path: 'docs/a/.sources/call.mp4', kind: 'film' }] } }, /kind 'film'/);
  await rec(w, { key: '1280', stage: 'videoGate', status: 'done', result: { videos: [{ file: 'docs/a/.sources/call.mp4', parts: [{ file: 'docs/a/.sources/call-part1.mp4', start: 0, transcript: 'docs/a/.sources/call-part1.txt' }] }], files: [{ path: '.flow/runs/1280-frames', kind: 'frames' }] } });
  const files = read(w, '1280').files;
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.bytes, f.stage]), [['docs/a/.sources/call.mp4', 'video', 2048, 'videoGate'], ['docs/a/.sources/call-part1.mp4', 'videoPart', 0, 'videoGate'], ['.flow/runs/1280-frames', 'frames', 0, 'videoGate']]);
});

test('a run record adds the session cost and changes no stage', async () => {
  const c = card({ number: 1290, status: 'inProgress' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done' } });
  await rec(w, { key: '1290', run: { role: 'writer', model: 'claude-opus-5-5', costUsd: 1.5, weekPercent: { before: 10, after: 12 } } });
  const l = read(w, '1290');
  assert.deepEqual([l.stage, l.runs.length, l.runs[0].costUsd], ['start', 1, 1.5]);
});

test('locks: one taker wins; a live lock refuses; a stale one is moved aside and its running stages fail', async () => {
  const c = card({ number: 1300, status: 'inProgress' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: { status: 'running' } } });
  const s = w.settings;
  assert.equal(runLock({ settings: s, group: '1300', kind: 'manual', stage: 'plan', now: NOW }).taken, true);
  assert.throws(() => runLock({ settings: s, group: '1300', kind: 'schedule', now: NOW }), (e) => e.refused === 'locked');
  assert.throws(() => runUnlock({ settings: s, group: '1300', stale: true, now: NOW }), (e) => e.refused === 'live');
  const later = NOW + (s.limits.lockLeaseMinutes + 1) * 60000;
  assert.throws(() => runLock({ settings: s, group: '1300', kind: 'schedule', now: later }), (e) => e.refused === 'stale');
  const out = runUnlock({ settings: s, group: '1300', stale: true, now: later });
  assert.deepEqual(out.failed, [{ key: '1300', stage: 'plan' }]);
  assert.ok(out.movedTo.includes(path.join('locks', 'stale', '1300-')));
  assert.equal(lockOf(s.state, '1300', later), null);
  assert.equal(read(w, '1300').stages.plan.status, 'failed');
  assert.throws(() => runLock({ settings: s, group: '../x', kind: 'manual', now: NOW }), /not a group id/);
});

test('handover: a ticket with no ledger is rebuilt from the card and its PR links; hand <-> pipeline', async () => {
  const c = card({ number: 1310, status: 'smeReview' });
  const comments = { [c.id]: [{ id: 'cm1', author: 'someone', time: ago(30), text: 'Triage: docs needed.' }, { id: 'cm2', author: 'someone', time: ago(20), text: 'PR: https://github.com/acme/guide-docs/pull/98' }] };
  const w = world({ cards: [c], comments, prs: [pr({ repo: 'guide-docs', number: 98, head: 'legacy-branch' })] });
  let st = await w.status();
  const before = st.tickets.find((t) => t.key === '1310');
  assert.deepEqual([before.ledger, before.mode, before.state, before.next, before.counted], ['absent', 'hand', 'smeReview', null, false]);
  const out = await runHandover({ settings: w.settings, clients: w.clients(), key: '1310', now: NOW });
  assert.deepEqual([out.rebuilt, out.prs], [true, ['guide-docs#98']]);
  const l = read(w, '1310');
  assert.deepEqual([l.mode, l.startedBy, l.prs[0].branch, l.prs[0].stage, l.stage], ['pipeline', 'manual', 'legacy-branch', 'smeReview', 'pr']);
  st = await w.status();
  assert.equal(st.tickets.find((t) => t.key === '1310').state, 'smeReview');
  assert.deepEqual(await runHandover({ settings: w.settings, clients: w.clients(), key: '1310', to: 'hand', now: NOW }), { key: '1310', mode: 'hand', changed: true });
  assert.equal(read(w, '1310').mode, 'hand');
});
