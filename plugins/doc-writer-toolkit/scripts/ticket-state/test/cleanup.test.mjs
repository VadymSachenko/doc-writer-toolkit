import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, ago, card, gitRepo, pr, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { cleanupTicket, globRe, moveToTrash } from '../lib/cleanup.mjs';
import { runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';

// D-074: when every PR of a ticket is merged, the close step removes the work files the ledger recorded, except a path
// git tracks, a path the ledger didn't record, a path outside the host and the state, and a kept glob. Nothing goes
// while a PR is open or was closed unmerged.

const usage = () => parseUsage('Current week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const put = (root, rel, bytes = 100) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), Buffer.alloc(bytes, 1));
};
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

// A merged ticket with its work files: a video and its part, a transcript, the frames folder in the state root, the
// distilled interview notes, a tracked page, and one more file no stage recorded.
function mergedTicket({ prState = 'merged', extra } = {}) {
  const forgePr = pr({ repo: 'guide-docs', number: 111, state: prState });
  const c = card({ number: 1401, status: 'finalReview' });
  const w = world({ cards: [c], prs: [forgePr], extra });
  const repo = gitRepo(w.root);
  repo.commit({ 'docs/pay/index.md': '# Pay\n', '.gitignore': '.flow/\n*.mp4\n*.txt\n' });
  put(w.root, 'docs/pay/.sources/call.mp4', 5000);
  put(w.root, 'docs/pay/.sources/call-part1.mp4', 3000);
  put(w.root, 'docs/pay/.sources/call-part1.txt', 700);
  put(w.root, 'docs/pay/.sources/sme-interview.md', 400);
  put(w.root, 'docs/pay/.sources/notes-by-hand.txt', 50);
  put(w.root, '.flow/runs/1401-frames/f1.png', 1000);
  put(w.root, '.flow/runs/1401-frames/f2.png', 1000);
  const files = [
    { path: 'docs/pay/.sources/call.mp4', kind: 'video' },
    { path: 'docs/pay/.sources/call-part1.mp4', kind: 'videoPart' },
    { path: 'docs/pay/.sources/call-part1.txt', kind: 'transcript' },
    { path: 'docs/pay/.sources/sme-interview.md', kind: 'transcript' },
    { path: 'docs/pay/index.md', kind: 'other' },
    { path: '.flow/runs/1401-frames', kind: 'frames' },
  ].map((f) => ({ ...f, bytes: 0, stage: 'videoGate', at: ago(30) }));
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 111, targets: ['guide'], review: 'sme', stage: 'readyForMerge' }], files });
  return { w, c, forgePr, trash: path.join(tmp('fake-trash-'), '.Trash') };
}

test('a merged ticket: its recorded work files go to the Trash; tracked, kept and unrecorded files stay; the report says what went', async () => {
  const { w, c, trash } = mergedTicket();
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW, spawnClaude: () => assert.fail('no model step here') }, options: {} });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['close', 'done']]);
  // Removed, into the Trash.
  for (const rel of ['docs/pay/.sources/call.mp4', 'docs/pay/.sources/call-part1.mp4', 'docs/pay/.sources/call-part1.txt', '.flow/runs/1401-frames']) assert.equal(exists(w.root, rel), false, rel);
  assert.deepEqual(fs.readdirSync(trash).sort(), ['1401-frames', 'call-part1.mp4', 'call-part1.txt', 'call.mp4']);
  assert.deepEqual(fs.readdirSync(path.join(trash, '1401-frames')).sort(), ['f1.png', 'f2.png']);
  // Kept.
  assert.equal(exists(w.root, 'docs/pay/index.md'), true, 'git tracks it');
  assert.equal(exists(w.root, 'docs/pay/.sources/sme-interview.md'), true, 'on the keep list');
  assert.equal(exists(w.root, 'docs/pay/.sources/notes-by-hand.txt'), true, 'the ledger never recorded it');
  // The ledger and the report.
  const l = read(w, '1401');
  const cl = l.stages.close.result.cleanup;
  assert.equal(l.stages.close.status, 'done');
  assert.deepEqual(cl.removed.map((r) => [r.path, r.bytes]), [['docs/pay/.sources/call.mp4', 5000], ['docs/pay/.sources/call-part1.mp4', 3000], ['docs/pay/.sources/call-part1.txt', 700], ['.flow/runs/1401-frames', 2000]]);
  assert.deepEqual(cl.kept, [{ path: 'docs/pay/.sources/sme-interview.md', reason: 'on the keep list' }, { path: 'docs/pay/index.md', reason: 'git tracks it' }]);
  assert.equal(cl.freedBytes, 10700);
  assert.equal(w.tracker.cards.find((x) => x.id === c.id).placeId, '5f00000000000000000a0008', 'the card went to the done list');
  const report = fs.readFileSync(path.join(w.root, out.reportFile), 'utf8');
  assert.match(report, /## Work files removed after the merge\n\n- 1401: 4 path\(s\), 0\.0 MB moved to the Trash \(`docs\/pay\/\.sources\/call\.mp4`/);
  assert.match(report, /kept `docs\/pay\/\.sources\/sme-interview\.md` \(on the keep list\), `docs\/pay\/index\.md` \(git tracks it\)/);
  assert.match(report, /Space freed today: 0\.0 MB\./);
});

test('an open PR, or one closed unmerged, removes nothing, and the report says so', async () => {
  for (const state of ['open', 'closed']) {
    const { w, trash } = mergedTicket({ prState: state });
    const before = snapshot(w.root);
    const l = read(w, '1401');
    const r = cleanupTicket({ settings: w.settings, ledger: l, prState: () => state, trashDir: trash });
    assert.deepEqual(r.removed, []);
    assert.match(r.blocked, state === 'open' ? /guide-docs#111 not merged: nothing is removed/ : /guide-docs#111 closed unmerged: nothing is removed/);
    assert.equal(r.kept.length, 6);
    const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW, spawnClaude: () => ({ code: 0, stdout: '' }) }, options: {} });
    assert.ok(!out.ran.some((x) => x.stage === 'close'));
    for (const rel of Object.keys(before).filter((f) => !f.startsWith('.flow/') && !f.startsWith('.git/'))) assert.ok(exists(w.root, rel), rel);
    assert.equal(fs.existsSync(trash), false);
    if (state === 'closed') {
      const report = fs.readFileSync(path.join(w.root, out.reportFile), 'utf8');
      assert.match(report, /- 1401: a PR was closed unmerged, so its 6 work file\(s\) stay/);
    }
  }
});

test('the dry run removes nothing and prints the list', async () => {
  const { w, trash } = mergedTicket();
  const before = snapshot(w.root);
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW }, options: { dryRun: true } });
  const close = out.planned.find((p) => p.stage === 'close');
  assert.deepEqual(close.cleanup.wouldRemove.map((r) => r.path), ['docs/pay/.sources/call.mp4', 'docs/pay/.sources/call-part1.mp4', 'docs/pay/.sources/call-part1.txt', '.flow/runs/1401-frames']);
  assert.deepEqual(close.cleanup.keeps.map((k) => k.reason), ['on the keep list', 'git tracks it']);
  assert.equal(close.cleanup.freesBytes, 10700);
  assert.deepEqual(close.calls, ['tracker move ' + read(w, '1401').card.shortLink + ' --to done']);
  assert.deepEqual(snapshot(w.root), before, 'no file changed, the ledger included');
  assert.equal(fs.existsSync(trash), false);
  assert.deepEqual(w.tracker.log, []);
  assert.deepEqual(w.forge.log, []);
});

test('delete mode removes for good; a folder holding a kept or tracked file is removed file by file', () => {
  const { w } = mergedTicket({ extra: { cleanup: { mode: 'delete' } } });
  put(w.root, '.flow/runs/1401-frames/app-notes.md', 10);
  const l = read(w, '1401');
  const r = cleanupTicket({ settings: w.settings, ledger: l, prState: () => 'merged', trashDir: '/nonexistent-trash' });
  assert.equal(r.mode, 'delete');
  assert.equal(exists(w.root, 'docs/pay/.sources/call.mp4'), false);
  assert.equal(exists(w.root, '.flow/runs/1401-frames/f1.png'), false);
  assert.equal(exists(w.root, '.flow/runs/1401-frames/app-notes.md'), true);
  assert.deepEqual(r.removed.filter((x) => x.path.startsWith('.flow')).map((x) => x.path), ['.flow/runs/1401-frames/f1.png', '.flow/runs/1401-frames/f2.png']);
  assert.equal(fs.existsSync('/nonexistent-trash'), false);
});

test('a path outside the host and the state, or a link leading out, is never removed', () => {
  const { w, trash } = mergedTicket();
  const outside = tmp('outside-');
  put(outside, 'keep.mp4', 10);
  fs.symlinkSync(path.join(outside, 'keep.mp4'), path.join(w.root, 'docs/pay/.sources/link.mp4'));
  const l = read(w, '1401');
  l.files = [{ path: path.relative(w.root, path.join(outside, 'keep.mp4')), kind: 'video' }, { path: 'docs/pay/.sources/link.mp4', kind: 'video' }, { path: 'docs/pay/.sources/gone.mp4', kind: 'video' }];
  const r = cleanupTicket({ settings: w.settings, ledger: l, prState: () => 'merged', trashDir: trash });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.kept.map((k) => k.reason), ['outside the host repo and the state root', 'a link that leads outside the host repo and the state root', 'already gone']);
  assert.equal(fs.existsSync(path.join(outside, 'keep.mp4')), true);
});

test('the Trash gets a free name, as the Finder gives one', () => {
  const dir = tmp('trash-names-');
  const trash = path.join(dir, '.Trash');
  for (const n of [1, 2, 3]) {
    put(dir, `src${n}/call.mp4`, 10);
    moveToTrash(path.join(dir, `src${n}/call.mp4`), trash);
  }
  assert.deepEqual(fs.readdirSync(trash).sort(), ['call 2.mp4', 'call 3.mp4', 'call.mp4']);
  assert.equal(globRe('**/sme-interview.md').test('sme-interview.md'), true);
  assert.equal(globRe('**/sme-interview.md').test('docs/a/.sources/sme-interview.md'), true);
  assert.equal(globRe('docs/*.md').test('docs/a/b.md'), false);
});
