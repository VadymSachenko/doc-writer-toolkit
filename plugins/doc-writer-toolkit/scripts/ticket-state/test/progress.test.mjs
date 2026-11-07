import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTS, NOW, card, host, quietGit, rawSettings } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { newLedger, newPr, writeLedger } from '../lib/ledger.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { runRecord } from '../lib/record.mjs';
import { runDaily } from '../lib/runner.mjs';
import { runCheck } from '../lib/watch.mjs';
import { setLocal } from '../lib/setlocal.mjs';
import { loadSettings } from '../lib/settings.mjs';
import { digestRun, gatesOf, liveProgress, memoryPath, notifyGates, progressAfterCheck, progressPath, readMemory, renderProgress, writeProgress } from '../lib/progress.mjs';

// The live progress file: a checklist of phases from the ledgers, with no model and no network.

const at = (ms) => new Date(ms).toISOString();
const rec = (seq, status, extra = {}) => ({ status, seq, at: at(NOW - 3600000 + seq * 1000), ...extra });
const run = (stage, extra = {}) => ({ seq: 1, stage, role: 'writer', model: 'claude-sonnet-5-5', effort: 'high', trigger: 'schedule', start: at(NOW - 7200000), durationMs: 385000, turns: 10, costUsd: 1.3, outcome: 'done', share: 1, ...extra });

// A ledger in the shape the records leave, with invented names.
function mk(key, patch = {}) {
  const l = { ...newLedger({ key, card: { id: `id-${key}`, shortLink: `Sl${key}`, url: `https://tracker.example/c/Sl${key}`, name: `Change ${key}` }, now: at(NOW - 86400000) }), mode: 'pipeline', startedBy: 'schedule', ...patch };
  return l;
}
const render = (ledgers, extra = {}) => renderProgress({ ledgers, now: NOW, mode: 'on', ...extra });
const linesOf = (text, from) => {
  const all = text.split('\n');
  const i = all.findIndex((x) => x.startsWith(from));
  assert.ok(i >= 0, `no line starts with ${from}`);
  return all.slice(i + 1);
};

test('AC-1: the rows of a ticket in work: done with cost and time, running with the elapsed time, failed with its reason, not yet', () => {
  const l = mk('701', {
    stages: { triage: rec(1, 'done'), start: rec(3, 'done'), plan: rec(5, 'done'), write: rec(7, 'failed', { note: 'the session ended without recording the stage' }), uaReview: { status: 'running', seq: 8, at: at(NOW - 180000) } },
    runs: [run('triage', { share: 0.1, costUsd: 1.5, durationMs: 90000 }), run('start'), run('plan', { costUsd: 2.5, durationMs: 3 * 60000 + 5000 })],
  });
  const text = render([l]);
  assert.match(text, /^# Ticket flow progress\n\nUpdated \d\d:\d\d · mode on\n/);
  assert.match(text, /### 701 · Change 701 \(3 of \d+\)/);
  assert.match(text, /- ✅ Triaging — \$0\.15 \(a share\)\n/, 'a shared session: the cost share, no duration on the card');
  assert.match(text, /- ✅ Picking up the ticket — \$1\.30, 6m 25s/);
  assert.match(text, /- ✅ Drafting a plan — \$2\.50, 3m 05s/);
  assert.match(text, /- ❌ Writing the UA pages — the session ended without recording the stage/);
  assert.match(text, /- ⏳ Reviewing the UA text — since \d\d:\d\d \(3m 00s\)/);
  assert.match(text, /- ⬜ Opening the PR/);
  assert.match(text, /- ⬜ Review, translation and merge — after the PR opens/);
  assert.match(text, /- ⬜ Closing the ticket/);
  // Optional phases show only when the ledger has them.
  assert.doesNotMatch(text, /Applying the answers|video transcripts/i);
});

test('AC-1: a step the runner has in flight shows as running before its session recorded anything', () => {
  const l = mk('702', { stages: { triage: rec(1, 'done') } });
  const text = render([l], { flights: [{ keys: ['702'], stage: 'start', pr: null, since: NOW - 60000 }], live: true, run: { trigger: 'schedule', steps: [], guard: [], notStarted: [] } });
  assert.match(text, /- ⏳ Picking up the ticket — since \d\d:\d\d \(1m 00s\)/);
  assert.match(text, /## The current run/);
  assert.match(text, /- ⏳ Picking up the ticket — 702, since/);
});

test('AC-1: the chain of a PR: stale stages go back to not done, the gates name who they wait for', () => {
  const pr = newPr({ repo: 'guide-docs', targets: ['guide'], review: 'sme', branch: '703-edit' });
  Object.assign(pr, {
    number: 12,
    stage: 'translation',
    approval: { head: 'h1' },
    chain: { translate: rec(10, 'done', { head: 'h1' }), enReview: rec(11, 'done', { head: 'h1' }), locales: rec(12, 'done', { head: 'h1' }), align: rec(13, 'failed', { head: 'h1', note: 'an image has no EN counterpart' }) },
  });
  const l = mk('703', {
    stages: { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), write: rec(4, 'done'), uaReview: rec(5, 'done'), pr: rec(6, 'done') },
    prs: [pr],
    runs: [run('translate', { pr: 'guide-docs#12', role: 'translator', costUsd: 0.8, durationMs: 125000 })],
  });
  const plain = render([l]);
  assert.match(plain, /\*\*PR guide-docs#12\*\* — sme review, stage translation/);
  assert.doesNotMatch(plain, /Expert review/, 'no expert was asked, recommended or called');
  assert.match(plain, /- ✅ Your read of the UA/);
  assert.match(plain, /- ✅ Translating into EN — \$0\.80, 2m 05s/);
  assert.match(plain, /- ❌ Checking UA and EN alignment — an image has no EN counterpart/);
  assert.match(plain, /- ⬜ Building the site/);
  // The status says UA changed after head h1: the stage it names and every later stage that saw h1 are stale.
  const stale = render([l], { memory: { stale: { '703|guide-docs#12': { stage: 'enReview', head: 'h2', count: 1 } } } });
  assert.match(stale, /- ✅ Translating into EN/);
  assert.match(stale, /- ⬜ Reviewing the EN text — stale: UA changed since/);
  assert.match(stale, /- ⬜ Translating into the other locales — stale: UA changed since/);
  // A stage the runner re-ran for the new head is not stale any more.
  pr.chain.enReview = rec(14, 'done', { head: 'h2' });
  const rerun = render([l], { memory: { stale: { '703|guide-docs#12': { stage: 'enReview', head: 'h2', count: 1 } } } });
  assert.match(rerun, /- ✅ Reviewing the EN text/);
});

test('AC-1: the gates: the owner\'s read, the final merge, questions and the plan, each naming who it waits for', () => {
  const prA = Object.assign(newPr({ repo: 'guide-docs', review: 'places', branch: 'a' }), { number: 1, stage: 'finalReview', pipelineCommits: ['c1', 'c2'] });
  const prB = Object.assign(newPr({ repo: 'api-docs', review: 'sme', branch: 'b' }), { number: 2, stage: 'smeReview' });
  const prC = Object.assign(newPr({ repo: 'guide-docs', review: 'places', branch: 'c' }), { number: 3, stage: 'readyForMerge', readyForMerge: [{ head: 'abc', at: at(NOW) }] });
  const done = { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), write: rec(4, 'done'), uaReview: rec(5, 'done'), pr: rec(6, 'done') };
  const ledgers = [
    mk('711', { stages: done, prs: [prA] }),
    mk('712', { stages: done, prs: [prB] }),
    mk('713', { stages: done, prs: [prC] }),
    mk('714', { stages: { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), questions: rec(4, 'done') }, questions: [{ askedAt: at(NOW - 1000), text: 'Which role?' }] }),
    mk('715', { stages: { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), planGate: rec(4, 'done') } }),
  ];
  const text = render(ledgers);
  const waiting = text.slice(text.indexOf('## Waiting for you'), text.indexOf('## The last run'));
  assert.match(waiting, /- 👉 711 · Change 711 — guide-docs#1: read the UA/);
  assert.match(waiting, /- 👉 713 .* guide-docs#3: make the final edit and merge/);
  assert.match(waiting, /- 👉 714 .* answer the questions on the card/);
  assert.match(waiting, /- 👉 715 .* approve the section plan/);
  assert.doesNotMatch(waiting, /712/, 'an expert review waits for the reviewer, not for you');
  assert.match(text, /- ⏸ Expert review — waits for the reviewer: the expert review, then a person moves the card/);
  assert.match(text, /- 👉 Your read of the UA — waits for you: comments first, then the card to In translation, or to the review status to call the expert\n/, 'the wording once, not doubled');
  assert.match(text, /- 👉 Ready for merge — waits for you/);
  assert.match(text, /- 👉 Questions — waits for you/);
  assert.match(text, /- 👉 Plan approval — waits for you/);
  // A question answered, a plan approved: no gate.
  assert.deepEqual(gatesOf(mk('716', { stages: { questions: rec(4, 'done') }, questions: [{ askedAt: at(NOW), answer: { at: at(NOW) } }] })), []);
  assert.deepEqual(gatesOf(mk('717', { stages: { planGate: rec(4, 'done'), planApproval: rec(5, 'done'), write: rec(6, 'done') } })), []);
});

test('a session working on a PR at the owner\'s gate is running, not the owner\'s turn', () => {
  const pr = Object.assign(newPr({ repo: 'guide-docs', review: 'places', branch: 'a' }), { number: 1, stage: 'finalReview', pipelineCommits: ['c1'] });
  const l = mk('791', { stages: { triage: rec(1, 'done'), start: rec(2, 'done'), pr: rec(6, 'done') }, prs: [pr] });
  const idle = render([l]);
  assert.match(idle, /- 👉 791 .* read the UA/);
  const busy = render([l], { flights: [{ keys: ['791'], stage: 'answerComments', pr: 'guide-docs#1', since: NOW - 120000 }], live: true, run: { trigger: 'watcher' } });
  assert.match(busy, /Nothing waits for you\./);
  assert.match(busy, /- ⏳ Answering the review comments — since \d\d:\d\d \(2m 00s\)/);
  assert.doesNotMatch(busy, /👉/);
});

test('AC-1: a ticket with no runs, no ledgers at all, tickets that are closed or in the owner\'s hands, and a ledger that does not read', () => {
  const fresh = mk('721', { stages: { start: rec(1, 'done') } });
  const text = render([fresh]);
  assert.match(text, /### 721 · Change 721 \(1 of 8\)/);
  assert.equal(text.match(/- ✅/g).length, 1, 'only the start is done; the ticket has no runs');
  // A triaged ticket that has not started gets one line, no block; a step running on it gives it a block.
  const triaged = mk('725', { stages: { triage: rec(1, 'done') } });
  const lone = render([triaged, fresh]);
  assert.match(lone, /Triaged, not started: 725\n/);
  assert.doesNotMatch(lone, /### 725/);
  assert.match(render([triaged], { flights: [{ keys: ['725'], stage: 'start', pr: null, since: NOW - 1000 }] }), /### 725 .*\n\n- ✅ Triaging\n- ⏳ Picking up the ticket/);
  assert.match(text, /Nothing waits for you\./);
  assert.match(render([]), /No ledgers yet: nothing has started\./);
  const closed = mk('722', { stages: { close: rec(9, 'done') } });
  const hand = mk('723', { mode: 'hand' });
  const mixed = render([closed, hand, fresh], { bad: [{ key: '724', error: 'cannot parse the file' }] });
  assert.doesNotMatch(mixed, /### 722/);
  assert.doesNotMatch(mixed, /### 723/);
  assert.match(mixed, /In the owner's hands \(observed only\): 723/);
  assert.match(mixed, /1 closed ticket\(s\) not shown\./);
  assert.match(mixed, /The ledger 724 does not read: cannot parse the file/);
  assert.match(render([closed]), /No ticket is in work\./);
});

test('the run section: why nothing starts, the slots, the allowance and the guard', () => {
  const text = render([], {
    run: { at: at(NOW), trigger: 'schedule', steps: [{ stage: 'plan', keys: ['731'], outcome: 'done' }, { stage: 'write', keys: ['731'], outcome: 'failed', note: 'no commit' }], triage: { keys: ['732', '733'], outcome: 'done' }, picked: ['731'], notStarted: [{ keys: ['734'], reasons: ['3 in progress + 1 > 3'] }], guard: [{ what: 'start', reason: 'the week is at 9%, the allowance by now is 8%' }], wip: { inProgress: 3, waiting: 1, open: 4, limits: { inProgress: 3, waiting: 5, open: null } }, allowance: { remaining: 0, cap: 8, used: 9 } },
  });
  assert.match(text, /## The last run\n\nLast run \(\d\d:\d\d\), started by schedule/);
  assert.match(text, /- ✅ Triaging: 2 intake card\(s\) — done/);
  assert.match(text, /- ✅ Drafting a plan — 731/);
  assert.match(text, /- ❌ Writing the UA pages — 731: failed \(no commit\)/);
  assert.match(text, /- ✅ Picked: 731/);
  assert.match(text, /- ⬜ Not started: 734 — 3 in progress \+ 1 > 3/);
  assert.match(text, /- ⏸ start: the week is at 9%, the allowance by now is 8%/);
  assert.match(text, /- Slots: 3 in progress of 3, 1 waiting of 5/);
  assert.match(text, /- Today's allowance: 0% left of 8% \(the week is at 9%\)/);
});

test('Claude\'s planned steps: the file named in the local settings is shown as it is, at the end; none, or a missing file: no block', () => {
  const w = world();
  const stepsFile = path.join(w.root, 'notes', 'steps.md');
  fs.mkdirSync(path.dirname(stepsFile), { recursive: true });
  fs.writeFileSync(stepsFile, '- [x] read the brief\n- [ ] write the renderer\n');
  assert.equal(writeProgress({ settings: { ...w.settings, progress: { stepsFile } }, now: NOW }).written, true);
  const text = fs.readFileSync(progressPath(w.settings.state), 'utf8');
  assert.match(text, /\n## Claude's planned steps\n\n- \[x\] read the brief\n- \[ \] write the renderer\n$/);
  writeProgress({ settings: { ...w.settings, progress: { stepsFile: path.join(w.root, 'missing.md') } }, now: NOW });
  assert.doesNotMatch(fs.readFileSync(progressPath(w.settings.state), 'utf8'), /planned steps/);
  writeProgress({ settings: w.settings, now: NOW });
  assert.doesNotMatch(fs.readFileSync(progressPath(w.settings.state), 'utf8'), /planned steps/);
});

test('settings: progress.stepsFile is a local key, none by default, resolved from the host root', async () => {
  const { validateSettings, LOCAL_KEYS } = await import('../lib/settings.mjs');
  assert.ok(LOCAL_KEYS.includes('progress'));
  const w = world();
  assert.equal(w.settings.progress.stepsFile, null);
  const opts = { root: w.root, stateRootDefault: '.doc-toolkit/ticket-flow/' };
  assert.throws(() => validateSettings(rawSettings({ progress: { stepsFile: 5 } }), opts), /progress\.stepsFile must be a file path/);
  const ok = validateSettings(rawSettings({ progress: { stepsFile: 'notes/steps.md' } }), opts);
  assert.equal(ok.progress.stepsFile, path.join(w.root, 'notes', 'steps.md'));
  // `ticket-state set` carries it into the local file, and loading reads it back.
  const hostRoot = host();
  const loaded = await loadSettings({ root: hostRoot });
  const r = setLocal({ settings: loaded, key: 'progress.stepsFile', value: 'notes/steps.md' });
  assert.deepEqual([r.key, r.after, r.changed], ['progress.stepsFile', path.join(hostRoot, 'notes', 'steps.md'), true]);
  assert.equal((await loadSettings({ root: hostRoot })).progress.stepsFile, path.join(hostRoot, 'notes', 'steps.md'));
});

test('a status that calls a chain stage stale is remembered, so a quiet pass with no status shows the same', () => {
  const w = world();
  const pr = Object.assign(newPr({ repo: 'guide-docs', review: 'sme', branch: 'b' }), { number: 5, stage: 'translation', chain: { translate: rec(10, 'done', { head: 'h1' }), enReview: rec(11, 'done', { head: 'h1' }) } });
  writeLedger(w.settings.state, mk('741', { stages: { start: rec(2, 'done'), pr: rec(6, 'done') }, prs: [pr] }));
  const st = { tickets: [{ key: '741', steps: [{ stage: 'translate', pr: 'guide-docs#5', head: 'h2', stale: 2 }] }] };
  writeProgress({ settings: w.settings, now: NOW, st });
  assert.match(fs.readFileSync(progressPath(w.settings.state), 'utf8'), /- ⬜ Translating into EN — stale: UA changed since/);
  writeProgress({ settings: w.settings, now: NOW + 1000 });
  assert.match(fs.readFileSync(progressPath(w.settings.state), 'utf8'), /- ⬜ Translating into EN — stale/, 'a pass with no status keeps it');
  // The status no longer calls it stale (the chain ran again): the mark goes.
  writeProgress({ settings: w.settings, now: NOW + 2000, st: { tickets: [{ key: '741', steps: [] }] } });
  assert.match(fs.readFileSync(progressPath(w.settings.state), 'utf8'), /- ✅ Translating into EN/);
});

test('AC-3: rendering makes no model or network call: no clients, no fetch, no process, and the module imports none', async () => {
  const w = world();
  ledger(w, card({ number: 751, status: 'inProgress' }), { stages: { triage: 'done', start: 'done' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('rendering made a network call');
  try {
    const r = writeProgress({ settings: w.settings, now: NOW });
    assert.equal(r.written, true);
    assert.equal(notifyGates({ settings: w.settings, notify: null }).sent.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'progress.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./feed.mjs', './ledger.mjs', './stages.mjs', 'node:crypto', 'node:fs', 'node:path']);
  assert.doesNotMatch(src, /fetch\(|spawn|exec/);
});

test('AC-2: a failed write is returned, never thrown, and a run goes on: the step is still done', async () => {
  const w = world();
  // The file's place is a folder, so the rename fails.
  fs.mkdirSync(progressPath(w.settings.state), { recursive: true });
  const r = writeProgress({ settings: w.settings, now: NOW });
  assert.equal(r.written, false);
  assert.ok(r.error);
  assert.equal(fs.readdirSync(path.dirname(progressPath(w.settings.state))).filter((n) => n.includes('.tmp-')).length, 0, 'no temp file is left');
  const live = liveProgress({ settings: w.settings, clock: () => NOW, getRun: () => assert.fail('never reached') });
  const noRun = liveProgress({ settings: w.settings, clock: () => NOW, getRun: () => { throw new Error('boom'); } });
  assert.equal(await noRun.tracked({ keys: ['1'], stage: 'plan' }, async () => 'the step result'), 'the step result');
  void live;

  // A whole run, with the progress file unwritable all the way: the start still runs and is recorded done.
  const ready = card({ number: 761, status: 'ready', labels: ['Guide'] });
  const w2 = world({ cards: [ready], extra: { limits: { estimates: { edit: 4, newPage: 8 } } } });
  ledger(w2, ready, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  fs.mkdirSync(progressPath(w2.settings.state), { recursive: true });
  const spawnClaude = async () => {
    ready.placeId = LISTS.inProgress.id;
    await runRecord({ settings: w2.settings, clients: w2.clients(), key: '761', stage: 'start', status: 'done', card: ready.shortLink, result: { group: '761' }, now: NOW });
    return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5, duration_ms: 60000, session_id: 's1', usage: {} }) };
  };
  const usage = parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
  const out = await runDaily({ settings: w2.settings, clients: w2.clients(), io: { readUsage: () => usage, now: () => NOW, spawnClaude }, options: { named: [] } });
  assert.equal(out.starts[0].steps[0].stage, 'start');
  assert.equal(out.starts[0].steps[0].outcome, 'done');
});

test('a run writes the file at its step boundaries: the finished step is a tick, and a dry run writes nothing', async () => {
  const ready = card({ number: 771, status: 'ready', labels: ['Guide'] });
  const w = world({ cards: [ready], extra: { limits: { estimates: { edit: 4, newPage: 8 } } } });
  ledger(w, ready, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  const usage = parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
  let during = null;
  const spawnClaude = async () => {
    during ??= fs.readFileSync(progressPath(w.settings.state), 'utf8');
    ready.placeId = LISTS.inProgress.id;
    await runRecord({ settings: w.settings, clients: w.clients(), key: '771', stage: 'start', status: 'done', card: ready.shortLink, result: { group: '771' }, now: NOW });
    return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5, duration_ms: 60000, session_id: 's1', usage: {} }) };
  };
  const dry = world({ cards: [card({ number: 772, status: 'ready', labels: ['Guide'] })] });
  await runDaily({ settings: dry.settings, clients: dry.clients(), io: { readUsage: () => usage, now: () => NOW, spawnClaude: () => assert.fail('dry') }, options: { dryRun: true } });
  assert.equal(fs.existsSync(path.join(dry.settings.state, 'watch')), false, 'a dry run writes nothing');
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usage, now: () => NOW, spawnClaude }, options: {} });
  assert.match(during, /- ⏳ Picking up the ticket — since/, 'while the session runs, its step is running');
  assert.match(during, /## The current run/);
  const after = fs.readFileSync(progressPath(w.settings.state), 'utf8');
  assert.match(after, /- ✅ Picking up the ticket/);
  assert.match(after, /## The last run/);
  assert.doesNotMatch(after, /⏳/);
});

// ------------------------------------------------------------------ "your turn"

function gateWorld() {
  const w = world();
  const done = { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), write: rec(4, 'done'), uaReview: rec(5, 'done'), pr: rec(6, 'done') };
  const put = (key, pr) => writeLedger(w.settings.state, mk(key, { stages: done, prs: [pr] }));
  const finalReview = (key, number, commits) => put(key, Object.assign(newPr({ repo: 'guide-docs', review: 'places', branch: `b${number}` }), { number, stage: 'finalReview', pipelineCommits: commits }));
  return { w, put, finalReview };
}

test('AC-4: "your turn" is sent once for a gate, not at every pass; a gate left and reached again tells again', () => {
  const { w, put, finalReview } = gateWorld();
  const sent = [];
  const notify = (m) => (sent.push(m), { sent: true });
  // The first write only seeds: a host that starts using the file is not told about every gate already standing.
  finalReview('801', 1, ['c1']);
  progressAfterCheck({ settings: w.settings, now: NOW, notify });
  assert.equal(sent.length, 0, 'the first pass seeds');
  finalReview('802', 2, ['c1']);
  progressAfterCheck({ settings: w.settings, now: NOW + 1000, notify });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Ticket flow: your turn');
  assert.match(sent[0].text, /^802 Change 802: read the UA \(guide-docs#2\)$/);
  assert.equal(sent[0].urgent, false);
  // Passes while it waits tell nothing more, the runner's writes included.
  for (let i = 2; i < 6; i++) progressAfterCheck({ settings: w.settings, now: NOW + i * 1000, notify });
  writeProgress({ settings: w.settings, now: NOW + 9000 });
  assert.equal(sent.length, 1);
  // The owner sends it back (rework) and the pipeline answers with a new commit: a new arrival at the gate.
  finalReview('802', 2, ['c1', 'c2']);
  progressAfterCheck({ settings: w.settings, now: NOW + 10000, notify });
  assert.equal(sent.length, 2, 'a new head of the pipeline is a new turn');
  // The gate ends (the PR moves on) and comes back later.
  put('802', Object.assign(newPr({ repo: 'guide-docs', review: 'places', branch: 'b2' }), { number: 2, stage: 'translation', pipelineCommits: ['c1', 'c2'] }));
  progressAfterCheck({ settings: w.settings, now: NOW + 11000, notify });
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(readMemory(w.settings.state).data.notified).filter((k) => k.startsWith('802|')), [], 'a gate that is gone is forgotten');
  put('802', Object.assign(newPr({ repo: 'guide-docs', review: 'places', branch: 'b2' }), { number: 2, stage: 'readyForMerge', pipelineCommits: ['c2'], readyForMerge: [{ head: 'h9', at: at(NOW) }] }));
  progressAfterCheck({ settings: w.settings, now: NOW + 12000, notify });
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /make the final edit and merge/);
});

test('AC-4: only the owner\'s own turns notify: not a reviewer\'s wait, a card the owner moved back, a hand ticket or a failed step', () => {
  const w = world();
  const done = { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), write: rec(4, 'done'), uaReview: rec(5, 'done'), pr: rec(6, 'done') };
  const sent = [];
  const notify = (m) => (sent.push(m), { sent: true });
  writeProgress({ settings: w.settings, now: NOW });
  const pr = (stage, n) => Object.assign(newPr({ repo: 'guide-docs', review: 'sme', branch: `b${n}` }), { number: n, stage });
  writeLedger(w.settings.state, mk('811', { stages: done, prs: [pr('smeReview', 1)] }));
  writeLedger(w.settings.state, mk('812', { stages: done, prs: [pr('reworkWait', 2)] }));
  writeLedger(w.settings.state, mk('813', { mode: 'hand', stages: done, prs: [pr('finalReview', 3)] }));
  writeLedger(w.settings.state, mk('814', { stages: { ...done, write: rec(7, 'failed', { note: 'x' }) }, prs: [pr('writing', 4)] }));
  writeLedger(w.settings.state, mk('815', { stages: { ...done, close: rec(9, 'done') }, prs: [Object.assign(pr('finalReview', 5), { merged: { at: at(NOW) } })] }));
  progressAfterCheck({ settings: w.settings, now: NOW + 1000, notify });
  assert.equal(sent.length, 0);
  // The questions and the plan are the owner's turn.
  writeLedger(w.settings.state, mk('816', { stages: { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), planGate: rec(4, 'done') } }));
  writeLedger(w.settings.state, mk('817', { stages: { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), questions: rec(4, 'done') }, questions: [{ askedAt: at(NOW), text: 'Which role?' }] }));
  progressAfterCheck({ settings: w.settings, now: NOW + 2000, notify });
  assert.deepEqual(sent.map((m) => m.text.split(' ')[0]).sort(), ['816', '817']);
});

test('AC-4: with no sender nothing is sent and nothing is remembered as sent', () => {
  const { w, finalReview } = gateWorld();
  writeProgress({ settings: w.settings, now: NOW });
  finalReview('821', 1, ['c1']);
  assert.deepEqual(progressAfterCheck({ settings: w.settings, now: NOW + 1000 }).sent, []);
  const sent = [];
  progressAfterCheck({ settings: w.settings, now: NOW + 2000, notify: (m) => (sent.push(m), { sent: true }) });
  assert.equal(sent.length, 1, 'the gate was not marked as told');
});

test('AC-4: the watcher\'s check refreshes the file and tells a gate once over two checks', async () => {
  const { w, finalReview } = gateWorld();
  const sent = [];
  const usage = parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
  const check = (n) => runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => NOW + n * 5 * 60000, git: quietGit, runner: { now: () => NOW + n * 5 * 60000, readUsage: () => usage }, notify: (m) => (sent.push(m), { sent: true }) }, options: {} });
  await check(0);
  assert.ok(fs.existsSync(progressPath(w.settings.state)), 'a quiet check writes the file');
  finalReview('831', 1, ['c1']);
  await check(1);
  await check(2);
  assert.deepEqual(sent.filter((m) => m.title === 'Ticket flow: your turn').map((m) => m.text), ['831 Change 831: read the UA (guide-docs#1)']);
  assert.match(fs.readFileSync(progressPath(w.settings.state), 'utf8'), /- 👉 831 · Change 831 — guide-docs#1: read the UA/);
  // A dry check writes nothing.
  const dry = world();
  await runCheck({ settings: dry.settings, clients: dry.clients(), io: { now: () => NOW, git: quietGit, runner: { now: () => NOW, readUsage: () => usage }, notify: () => assert.fail('dry') }, options: { dryRun: true } });
  assert.equal(fs.existsSync(memoryPath(dry.settings.state)), false);
});

// ------------------------------------------------------------------ the expert review, the start pass, the closing of a run

const READY = { triage: rec(1, 'done'), start: rec(2, 'done'), plan: rec(3, 'done'), write: rec(4, 'done'), uaReview: rec(5, 'done'), pr: rec(6, 'done') };
const prAt = (stage, extra = {}) => Object.assign(newPr({ repo: 'guide-docs', review: 'sme', branch: 'e' }), { number: 20, stage, pipelineCommits: ['c1'], ...extra });
const expertRow = (text) => text.split('\n').find((x) => x.includes('Expert review')) ?? null;

test('the expert row follows the stage and the history, not the review kind', () => {
  // An sme PR at the owner's read, nobody asked: no expert row, and never a tick.
  assert.equal(expertRow(render([mk('901', { stages: READY, prs: [prAt('finalReview')] })])), null);
  // The shape the records leave: the `pr` record's result names the requests that came with it; a person's move to the
  // review adds the expert's (lib/record.mjs). A request the `pr` record brought is not a review: not done.
  const withResult = () => ({ ...READY, pr: rec(6, 'done', { result: { prs: [{ branch: 'e', number: 20, reviewersRequested: ['pr-record-login'] }] } }) });
  const requested = expertRow(render([mk('902', { stages: withResult(), prs: [prAt('finalReview', { reviewersRequested: ['pr-record-login'] })] })]));
  assert.match(requested, /^- ⬜ Expert review — requested, not called$/);
  const late = expertRow(render([mk('908', { stages: withResult(), prs: [prAt('translation', { reviewersRequested: ['pr-record-login'] })] })]));
  assert.match(late, /^- ⬜ Expert review — requested, not called$/, 'no doubled wording');
  // A places PR the owner sent to the expert: the wait is the reviewer's.
  const places = render([mk('903', { stages: withResult(), prs: [prAt('smeReview', { review: 'places', reviewersRequested: ['pr-record-login', 'expert-login'] })] })]);
  assert.match(expertRow(places), /^- ⏸ Expert review — waits for the reviewer/);
  assert.ok(places.indexOf('Your read of the UA') < places.indexOf('Expert review'), "after the owner's read");
  // A PR a person's move took to the review and back: the expert's request is in the PR, not in the `pr` record: done.
  const back = render([mk('904', { stages: withResult(), prs: [prAt('finalReview', { reviewersRequested: ['pr-record-login', 'expert-login'] })] })]);
  assert.equal(expertRow(back), '- ✅ Expert review');
  // Only a recommendation: not done, with the reason; the owner's line names it too.
  const text = render([mk('905', { stages: READY, prs: [prAt('finalReview', { expertReview: { recommended: true, why: 'the role rights are not in the code' } })] })]);
  assert.equal(expertRow(text), '- ⬜ Expert review — recommended: the role rights are not in the code');
  assert.match(text, /- 👉 905 .* guide-docs#20: read the UA \(an expert review is recommended: the role rights are not in the code\)/);
  assert.match(text, /- 👉 Your read of the UA — waits for you: comments first, then the card to In translation, or to the review status to call the expert; an expert review is recommended: the role rights/);
  // Not recommended: nothing to say.
  assert.equal(expertRow(render([mk('906', { stages: READY, prs: [prAt('finalReview', { expertReview: { recommended: false, why: 'a typo' } })] })])), null);
});

test('the start pass: the reason a pass started nothing, from the feed, under the run', () => {
  const w = world();
  const put = (starts) => fs.writeFileSync(path.join(w.settings.state, 'watch', 'feed.json'), JSON.stringify({ version: 1, starts }));
  fs.mkdirSync(path.join(w.settings.state, 'watch'), { recursive: true });
  const text = () => (writeProgress({ settings: w.settings, now: NOW }), fs.readFileSync(progressPath(w.settings.state), 'utf8'));
  put({ date: '2026-11-10', at: at(NOW - 60000), by: 'watcher', outcome: 'not run: no ready ticket' });
  assert.match(text(), /- ⬜ Start pass \(\d\d:\d\d\): not run: no ready ticket/);
  put({ date: '2026-11-10', at: at(NOW - 60000), by: 'watcher', outcome: 'not run: no room: 3 in progress of 3' });
  assert.match(text(), /not run: no room/);
  put({ date: '2026-11-10', at: at(NOW - 60000), by: 'watcher', outcome: 'started nothing' });
  assert.match(text(), /Start pass \(\d\d:\d\d\): started nothing/);
  put({ date: '2026-11-10', at: at(NOW - 60000), deferred: 'a card changed in the ready or intake list', outcome: null });
  assert.match(text(), /- ⏸ Start pass deferred \(\d\d:\d\d\): a card changed in the ready or intake list — waits for the start hours \(10-22\) or a board that reads/);
  put({ date: '2026-11-10', at: at(NOW - 60000), deferred: 'a slot freed', retryAt: at(NOW + 15 * 60000) });
  assert.match(text(), /- ⏸ Start pass \(\d\d:\d\d\): retry at \d\d:\d\d — a slot freed/);
  put({ date: '2026-11-10', at: at(NOW - 60000), outcome: 'failed: the status could not be read' });
  assert.match(text(), /- ❌ Start pass .*: failed: the status could not be read/);
  // A pass that started something, or is running, adds no line; a feed that does not read does not drop the file.
  put({ date: '2026-11-10', at: at(NOW), outcome: 'started 801' });
  assert.doesNotMatch(text(), /Start pass/);
  // The morning run's own record is the morning run, not a start pass.
  put({ date: '2026-11-10', at: at(NOW), by: 'morning', outcome: 'started nothing' });
  assert.doesNotMatch(text(), /Start pass/);
  fs.writeFileSync(path.join(w.settings.state, 'watch', 'feed.json'), '{ not json');
  assert.match(text(), /^# Ticket flow progress/);
});

test('a run is labelled by what it was: the morning run, a start pass, the watcher, by hand', () => {
  const label = (out, trigger = 'schedule') => render([], { run: digestRun({ out, trigger, now: NOW }) }).match(/Last run \(\d\d:\d\d\), (.*)\n/)[1];
  assert.equal(label({ morning: true }), 'the morning run');
  assert.equal(label({ startPass: true }), 'a start pass');
  assert.equal(label({}, 'watcher'), 'the watcher');
  assert.equal(label({}, 'manual'), 'a run started by hand');
  assert.equal(label({ startPass: { why: 'a slot freed' } }, 'schedule'), 'a scheduled run', "the watcher's own record is not the runner's flag");
});

test('a shared triage session shows its duration once, in the run, and a share on each card', () => {
  const session = () => run('triage', { share: 0.5, costUsd: 1, durationMs: 120000, session: 's-1', start: at(NOW - 60000) });
  const a = mk('911', { stages: { triage: rec(1, 'done') }, runs: [session()] });
  const b = mk('912', { stages: { triage: rec(1, 'done') }, runs: [session()] });
  const text = render([a, b], { run: { at: at(NOW), startedAt: at(NOW - 300000), triage: { keys: ['911', '912'], outcome: 'done' }, steps: [] } });
  assert.match(text, /Triaging: 2 intake card\(s\) — done, 2m 00s/);
  const started = mk('913', { stages: { triage: rec(1, 'done'), start: rec(2, 'done') }, runs: [session()] });
  assert.match(render([started]), /- ✅ Triaging — \$0\.50 \(a share\)\n/);
});

test('a run that throws does not leave the file saying it is in progress', async () => {
  const ready = card({ number: 921, status: 'ready', labels: ['Guide'] });
  const w = world({ cards: [ready], extra: { limits: { estimates: { edit: 4, newPage: 8 } } } });
  ledger(w, ready, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  const usage = parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
  const spawnClaude = async () => {
    throw new Error('the session could not start');
  };
  await assert.rejects(runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usage, now: () => NOW, spawnClaude }, options: {} }), /could not start/);
  const text = fs.readFileSync(progressPath(w.settings.state), 'utf8');
  assert.match(text, /## The last run/);
  assert.doesNotMatch(text, /Run in progress/);
  assert.doesNotMatch(text.split('## Tickets in work')[0], /⏳/, 'the run section shows no step in flight');
});

test('the memory is written before the notification is sent, and the sender gets its io', () => {
  const { w, finalReview } = gateWorld();
  writeProgress({ settings: w.settings, now: NOW });
  finalReview('931', 1, ['c1']);
  const seen = [];
  const io = { osascript: '/usr/bin/true' };
  const r = notifyGates({ settings: w.settings, now: NOW + 1000, notifyIo: io, notify: (m, got) => (seen.push(got), Object.keys(readMemory(w.settings.state).data.notified).length ? { sent: true } : assert.fail('the memory was written after the send')) });
  assert.deepEqual(seen, [io]);
  assert.equal(r.sent.length, 1);
  // A sender that throws: told once, not at every pass.
  finalReview('932', 2, ['c1']);
  const bad = notifyGates({
    settings: w.settings,
    now: NOW + 2000,
    notify: () => {
      throw new Error('osascript is gone');
    },
  });
  assert.equal(bad.sent[0].sent, false);
  const again = [];
  notifyGates({ settings: w.settings, now: NOW + 3000, notify: (m) => (again.push(m), { sent: true }) });
  assert.deepEqual(again, []);
});
