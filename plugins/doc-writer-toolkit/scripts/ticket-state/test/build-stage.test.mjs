import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, card, pr, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { briefFor, runDaily, scriptedCalls } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { HOLDER, buildLockDir, buildLockState, freeBuildLock, pidAlive, takeBuildLock } from '../lib/build-lock.mjs';
import { allLocks } from '../lib/locks.mjs';
import { EXIT_WHEN_BUILT, buildEnv, runSiteBuild } from '../lib/site-build.mjs';
import { localDate } from '../lib/report.mjs';

// The chain's `build` is the runner's own step: the host's build command in the PR's worktree, under the build lock,
// recorded ok or failed with the error's tail, and no `claude` session. A session that builds the site itself runs
// under the same lock, which the runner holds for it.

const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];
const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const HEAD = 'c'.repeat(40);
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
const chainDone = (n) => Object.fromEntries(CHAIN.slice(0, n).map((s, i) => [s, { status: 'done', head: HEAD, seq: 10 + i }]));
const stageOf = (cmd) => /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const noSession = async () => assert.fail('no claude session for the build');
const quick = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));

// A fake build command: a node script that counts its calls, writes the site's index, and fails when told to.
function fakeBuild(dir, { fail = false } = {}) {
  const script = path.join(dir, 'fake-build.mjs');
  const count = path.join(dir, 'builds.txt');
  fs.writeFileSync(script, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(count)}, process.cwd() + '\\n');
${fail ? "console.log('compiling 3 locales');\nconsole.error('Error: Module not found: ./missing.png');\nprocess.exit(3);" : "fs.mkdirSync('build', { recursive: true });\nfs.writeFileSync('build/index.html', '<html></html>');\nconsole.log('[SUCCESS] Generated static files');"}
`);
  return { command: [process.execPath, script], count: () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length : 0) };
}

// Tickets whose PRs stand at the chain's build: every stage before it done at the head.
function atBuild(n = 1, { done = 5 } = {}) {
  const cards = [];
  const prs = [];
  for (let i = 0; i < n; i++) {
    cards.push(card({ number: 701 + i, status: 'translation' }));
    prs.push(pr({ repo: 'guide-docs', number: 61 + i, headCommit: HEAD }));
  }
  const w = world({ cards, prs, extra: { limits: { stepsPerTicket: 1, parallel: 3 } } });
  const trees = new Map();
  cards.forEach((c, i) => {
    ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', number: 61 + i, targets: ['guide'], review: 'sme', branch: `ticket-${61 + i}`, stage: 'translation', chain: chainDone(done) }] });
    trees.set(`ticket-${61 + i}`, tmp('wt-'));
  });
  const ensureWorktree = (settings, p) => ({ repo: p.repo, branch: p.branch, path: trees.get(p.branch), head: HEAD, push: '', linked: [], missing: [], notes: [], stuck: [] });
  return { w, cards, prs, trees, ensureWorktree };
}

// The runner's renewal timer, by hand (Node 18 has no mock timers): `tick(ms)` moves its own time and runs each
// interval whose time came.
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  let at = 0;
  return {
    setInterval: (fn, ms) => (timers.set(++id, { fn, ms, next: at + ms }), id),
    clearInterval: (i) => timers.delete(i),
    tick(ms) {
      at += ms;
      for (const t of [...timers.values()]) while (t.next <= at) {
        t.next += t.ms;
        t.fn();
      }
    },
  };
}

const run = (w, io, options = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: noSession, sleep: quick, ...io }, options: { morning: false, trigger: 'watch', ...options } });

test('AC-3: a passing build: the runner runs the command in the worktree, records build ok at the head, and starts no claude session', async () => {
  const t = atBuild();
  const b = fakeBuild(tmp('bin-'));
  t.w.settings.build.command = b.command;
  const out = await run(t.w, { ensureWorktree: t.ensureWorktree }, { named: ['701'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.role, r.outcome]), [['build', null, 'done']]);
  assert.equal(b.count(), 1);
  assert.ok(fs.existsSync(path.join(t.trees.get('ticket-61'), 'build', 'index.html')), 'built in the PR\'s worktree');
  const l = read(t.w, '701');
  assert.deepEqual([l.prs[0].chain.build.status, l.prs[0].chain.build.head, l.prs[0].chain.build.result], ['done', HEAD, { ok: true }]);
  const runEntry = l.runs.at(-1);
  assert.deepEqual([runEntry.stage, runEntry.role, runEntry.script, runEntry.outcome, runEntry.session, typeof runEntry.wallMs, 'durationMs' in runEntry, 'costUsd' in runEntry], ['build', null, true, 'done', null, 'number', false, false]);
  assert.equal(buildLockState(t.w.settings.state).held, false, 'the lock is freed');
  // The next step is the visual pack, a session; the build is not the next step again.
  const tk = await t.w.one('701');
  assert.equal(tk.next.stage, 'visualPack');
  // The report counts no session for it.
  assert.match(fs.readFileSync(path.join(t.w.settings.state, 'reports', `${localDate(NOW)}.md`), 'utf8'), /0 session\(s\) today/);
});

test('AC-3: a failing build is recorded failed with the error\'s tail, waits for a person, and is not built again at the next check', async () => {
  const t = atBuild();
  const b = fakeBuild(tmp('bin-'), { fail: true });
  t.w.settings.build.command = b.command;
  const out = await run(t.w, { ensureWorktree: t.ensureWorktree }, { named: ['701'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['build', 'failed']]);
  const l = read(t.w, '701');
  const rec = l.prs[0].chain.build;
  assert.equal(rec.status, 'failed');
  assert.match(rec.note, /^the build failed \(exit 3\): .*Module not found: \.\/missing\.png/s);
  assert.deepEqual([rec.result.ok, rec.result.exit, rec.result.tail.at(-1)], [false, 3, 'Error: Module not found: ./missing.png']);
  const entry = l.runs.at(-1);
  assert.deepEqual([entry.outcome, entry.script, entry.failures, Boolean(entry.after), typeof entry.wallMs, entry.exit], ['failed', true, 1, true, 'number', 3]);
  const tk = await t.w.one('701');
  assert.match(tk.next.waits, /a person acting on the ticket/);
  // The next check builds nothing; the morning run tries once more, and a second failure holds the ticket.
  await run(t.w, { ensureWorktree: t.ensureWorktree }, { named: ['701'] });
  assert.equal(b.count(), 1);
  await run(t.w, { ensureWorktree: t.ensureWorktree }, { morning: true, trigger: 'schedule' });
  assert.equal(b.count(), 2);
  const held = await t.w.one('701');
  assert.equal(held.held, true);
  assert.match(held.gate.why, /^build on guide-docs#61 failed twice with no one acting in between, the last time in the runner's own build \(the build failed \(exit 3\)/);
});

test('AC-5: the branch moved under the build: before it (the worktree is at another head) nothing builds; during it the record is refused as stale; neither is a failure', async () => {
  const t = atBuild();
  const other = 'd'.repeat(40);
  const before = await run(t.w, { ensureWorktree: (s, p) => ({ ...t.ensureWorktree(s, p), head: other }), runBuild: () => assert.fail('no build at a head the chain did not see') }, { named: ['701'] });
  assert.deepEqual(before.ran.map((r) => [r.stage, r.outcome]), [['build', 'moved']]);
  const u = atBuild();
  const during = await run(u.w, {
    ensureWorktree: u.ensureWorktree,
    runBuild: async () => {
      // A person's commit lands while the site builds.
      for (const p of u.prs) p.headCommit = other;
      return { code: 0, tail: [] };
    },
  }, { named: ['701'] });
  assert.deepEqual(during.ran.map((r) => [r.stage, r.outcome]), [['build', 'moved']]);
  const l = read(u.w, '701');
  assert.notEqual(l.prs[0].chain.build?.status, 'done');
  assert.equal(l.runs.filter((r) => r.outcome === 'failed').length, 0);
  assert.equal(buildLockState(u.w.settings.state).held, false);
});

test('AC-5: a build whose worktree could not fetch the branch is a failure, not a move: it is told and waits for a person', async () => {
  // Offline, or a password asked: the worktree stays at the old head while the status (from the forge) has the new one.
  // Read as a move, it would read `moved` at every check and record nothing.
  const t = atBuild();
  const old = 'd'.repeat(40);
  const io = { ensureWorktree: (s, p) => ({ ...t.ensureWorktree(s, p), head: old, unfetched: true, notes: [`could not fetch ${p.branch}: origin/${p.branch} may be behind`] }), runBuild: () => assert.fail('no build at a head the chain did not see') };
  const out = await run(t.w, io, { named: ['701'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['build', 'failed']]);
  const l = read(t.w, '701');
  assert.equal(l.prs[0].chain.build.status, 'failed');
  assert.match(l.prs[0].chain.build.note, /^could not fetch ticket-61 into the worktree: it is at ddddddd, not ccccccc, so nothing was built/);
  const entry = l.runs.at(-1);
  assert.deepEqual([entry.outcome, entry.failures, 'start' in entry, Boolean(entry.after)], ['failed', 1, false, true]);
  const tk = await t.w.one('701');
  assert.match(tk.next.waits, /a person acting on the ticket/);
  // The next check tries nothing; the report lists the failure.
  const again = await run(t.w, io, { named: ['701'] });
  assert.deepEqual(again.ran, []);
  assert.match(fs.readFileSync(path.join(t.w.settings.state, 'reports', `${localDate(NOW)}.md`), 'utf8'), /could not fetch ticket-61 into the worktree/);
});

test('AC-5: two moved heads in a row stop the group: the status is read again once, not at every step', async () => {
  // A forge that lags its git refs: the worktree (fetched) is at another head than the status gives, at every read.
  const t = atBuild();
  t.w.settings.limits.stepsPerTicket = 5;
  let tries = 0;
  const out = await run(t.w, { ensureWorktree: (s, p) => (tries++, { ...t.ensureWorktree(s, p), head: 'd'.repeat(40) }), runBuild: () => assert.fail('no build at a head the chain did not see') }, { named: ['701'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['build', 'moved'], ['build', 'moved']]);
  assert.equal(tries, 2);
  const l = read(t.w, '701');
  assert.equal(l.runs.filter((r) => r.outcome === 'failed').length, 0);
  assert.notEqual(l.prs[0].chain.build?.status, 'failed');
  // One move alone doesn't stop it: the status read again gives the build, which the next fetch finds at its head.
  const u = atBuild();
  u.w.settings.limits.stepsPerTicket = 5;
  let n = 0;
  const once = await run(u.w, {
    ensureWorktree: (s, p) => ({ ...u.ensureWorktree(s, p), head: n++ === 0 ? 'd'.repeat(40) : HEAD }),
    runBuild: async () => ({ code: 0, tail: [] }),
    spawnClaude: async () => ({ code: 0, stdout: RESULT }),
  }, { named: ['701'] });
  assert.deepEqual(once.ran.map((r) => [r.stage, r.outcome]).slice(0, 2), [['build', 'moved'], ['build', 'done']]);
  assert.equal(read(u.w, '701').prs[0].chain.build.status, 'done');
});

test('AC-3: the dry run names the build command and starts nothing; the brief of a chain session never asks for the build', async () => {
  const t = atBuild();
  const out = await run(t.w, { ensureWorktree: t.ensureWorktree, runBuild: () => assert.fail('no build in a dry run') }, { named: ['701'], dryRun: true });
  const planned = out.planned.find((p) => p.stage === 'build');
  assert.equal(planned.runs, 'no model');
  assert.match(planned.calls[0], /^npm run build in .* at cccccccccccc, under the build lock \(a wait of up to 90 min, a timeout of 60 min\)$/);
  const l = read(t.w, '701');
  assert.equal(scriptedCalls({ stage: 'build', pr: 'guide-docs#61', head: HEAD, keys: ['701'] }, l, t.w.settings).length, 1);
});

test('AC-2: two tickets reaching the build at once build one after the other; a stale lock is taken over; one held for the whole wait waits', async () => {
  const t = atBuild(2);
  let active = 0;
  let most = 0;
  const holders = [];
  const runBuild = async ({ cwd }) => {
    active += 1;
    most = Math.max(most, active);
    holders.push(buildLockState(t.w.settings.state).holder?.ticket);
    await new Promise((r) => setTimeout(r, 40));
    active -= 1;
    return { code: 0, tail: [] };
  };
  // A runner that crashed holding the lock: its process is gone, so the lock is taken over.
  takeBuildLock(t.w.settings.state, { ticket: '999', pid: 2 ** 22 + 4242, now: NOW, isAlive: () => true });
  assert.equal(pidAlive(2 ** 22 + 4242), false);
  const out = await run(t.w, { ensureWorktree: t.ensureWorktree, runBuild }, { named: ['701', '702'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]).sort(), [['build', 'done'], ['build', 'done']]);
  assert.equal(most, 1, 'never two builds at once');
  assert.deepEqual(holders.sort(), ['701', '702'], 'each build under its own ticket\'s lock');
  assert.equal(buildLockState(t.w.settings.state).held, false);
  const log = fs.readFileSync(path.join(t.w.settings.state, 'runs', `${localDate(NOW)}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(log.filter((e) => e.kind === 'buildLock' && e.outcome === 'tookOver').length, 1);

  // A live holder for the whole wait (another runner's build): the step waits, not failed, and runs again later.
  const u = atBuild();
  u.w.settings.build.waitMinutes = 0;
  takeBuildLock(u.w.settings.state, { ticket: '888', pid: process.pid, now: NOW });
  const busy = await run(u.w, { ensureWorktree: u.ensureWorktree, runBuild: () => assert.fail('no build while another holds the lock') }, { named: ['701'] });
  assert.deepEqual(busy.ran.map((r) => [r.stage, r.outcome]), [['build', 'busy']]);
  const l = read(u.w, '701');
  assert.notEqual(l.prs[0].chain.build?.status, 'failed');
  assert.deepEqual([l.runs.at(-1).outcome, l.runs.at(-1).failures ?? null], ['busy', null]);
  const tk = await u.w.one('701');
  assert.deepEqual([tk.next.stage, tk.next.waits ?? null, tk.held ?? false], ['build', null, false]);
  assert.equal(buildLockState(u.w.settings.state).holder.ticket, '888', 'another holder\'s lock stays');
});

test('AC-2: a session that builds the site itself runs under the build lock, which is freed when it ends; one that reuses a build takes none', async () => {
  // The visual pack with no build of its head to reuse (its folder is gone): it builds, under the lock.
  const t = atBuild(1, { done: 6 });
  const seen = [];
  const spawnClaude = async (cmd) => {
    seen.push({ stage: stageOf(cmd), brief: briefOf(cmd), holder: buildLockState(t.w.settings.state).holder?.ticket ?? null });
    return { code: 1, stdout: '' };
  };
  await run(t.w, { ensureWorktree: t.ensureWorktree, spawnClaude }, { named: ['701'] });
  assert.ok(seen.length >= 1);
  assert.deepEqual([seen[0].stage, seen[0].holder], ['visualPack', '701']);
  assert.match(seen[0].brief, /The runner holds the build lock for this session: visual-pack's own build/);
  assert.equal(buildLockState(t.w.settings.state).held, false, 'freed when the session ended, failed');

  // With the build of its head in the worktree: the brief passes it, and no lock is taken.
  const u = atBuild(1, { done: 6 });
  fs.mkdirSync(path.join(u.trees.get('ticket-61'), 'build'), { recursive: true });
  fs.writeFileSync(path.join(u.trees.get('ticket-61'), 'build', 'index.html'), '<html></html>');
  const seen2 = [];
  await run(u.w, {
    ensureWorktree: u.ensureWorktree,
    spawnClaude: async (cmd) => {
      seen2.push({ brief: briefOf(cmd), holder: buildLockState(u.w.settings.state).holder?.ticket ?? null });
      return { code: 0, stdout: RESULT };
    },
  }, { named: ['701'] });
  assert.equal(seen2[0].holder, null);
  assert.match(seen2[0].brief, new RegExp(`run visual-pack with \`--build-dir ${path.join(u.trees.get('ticket-61'), 'build').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
});

test('AC-2: while a session that builds waits for the build lock, its group\'s lock is renewed, so it never goes stale', async () => {
  // The visual pack with no build to reuse waits behind another ticket's build for 12 minutes; the runner's 5-minute
  // renewal runs on a mocked interval, with the clock the wait moves.
  const t = atBuild(1, { done: 6 });
  takeBuildLock(t.w.settings.state, { ticket: '888', pid: process.pid, now: NOW });
  let clock = NOW;
  const leases = [];
  const timers = fakeTimers();
  const sleep = async (ms) => {
    clock += ms;
    timers.tick(ms);
    leases.push(Date.parse(allLocks(t.w.settings.state, clock).find((l) => l.group === '701').expiresAt));
    if (clock - NOW >= 12 * 60000) freeBuildLock(t.w.settings.state, { tickets: ['888'] });
  };
  const holders = [];
  await run(t.w, {
    now: () => clock,
    sleep,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ensureWorktree: t.ensureWorktree,
    spawnClaude: async () => {
      holders.push(buildLockState(t.w.settings.state).holder?.ticket);
      return { code: 0, stdout: RESULT };
    },
  }, { named: ['701'] });
  assert.equal(holders[0], '701', 'the session ran under its own build lock once the other was freed');
  const lease = t.w.settings.limits.lockLeaseMinutes * 60000;
  assert.equal(leases.length, 48, 'polled every 15 s for 12 min');
  assert.equal(leases[0], NOW + lease, 'the lease as the step took it');
  assert.equal(leases.at(-1), NOW + 10 * 60000 + lease, 'renewed at 5 and 10 minutes of the wait');
});

test('AC-2: a build lock the runner can\'t use is a recorded failure of the step, never an error out of the run; a session\'s busy wait keeps its time', async () => {
  const denied = async () => {
    throw Object.assign(new Error("EACCES: permission denied, mkdir '.build.lock'"), { code: 'EACCES' });
  };
  // The runner's build.
  const t = atBuild();
  const out = await run(t.w, { ensureWorktree: t.ensureWorktree, waitForBuildLock: denied, runBuild: () => assert.fail('no build without the lock') }, { named: ['701'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['build', 'failed']]);
  let l = read(t.w, '701');
  assert.match(l.prs[0].chain.build.note, /^the build lock: EACCES: permission denied/);
  assert.deepEqual([l.runs.at(-1).outcome, l.runs.at(-1).failures, 'start' in l.runs.at(-1)], ['failed', 1, false]);

  // A session that builds: no session starts, and the step waits for a person as a failed one does.
  const u = atBuild(1, { done: 6 });
  const out2 = await run(u.w, { ensureWorktree: u.ensureWorktree, waitForBuildLock: denied, spawnClaude: noSession }, { named: ['701'] });
  assert.deepEqual(out2.ran.map((r) => [r.stage, r.outcome]), [['visualPack', 'failed']]);
  l = read(u.w, '701');
  assert.match(l.prs[0].chain.visualPack.note, /^the build lock: EACCES/);
  assert.deepEqual([l.runs.at(-1).outcome, l.runs.at(-1).failures, 'start' in l.runs.at(-1)], ['failed', 1, false]);
  assert.match((await u.w.one('701')).next.waits, /a person acting on the ticket/);

  // Held by someone else for the whole wait: busy, with the time it waited, and still no session counted.
  const v = atBuild(1, { done: 6 });
  v.w.settings.build.waitMinutes = 2;
  takeBuildLock(v.w.settings.state, { ticket: '888', pid: process.pid, now: NOW });
  let clock = NOW;
  const out3 = await run(v.w, { now: () => clock, sleep: async (ms) => (clock += ms), ensureWorktree: v.ensureWorktree, spawnClaude: noSession }, { named: ['701'] });
  assert.deepEqual(out3.ran.map((r) => [r.stage, r.outcome]), [['visualPack', 'busy']]);
  const busy = read(v.w, '701').runs.at(-1);
  assert.deepEqual([busy.outcome, busy.waitedMs, busy.wallMs, 'start' in busy], ['busy', v.w.settings.build.waitMinutes * 60000, v.w.settings.build.waitMinutes * 60000, false]);
  assert.match(fs.readFileSync(path.join(v.w.settings.state, 'reports', `${localDate(NOW)}.md`), 'utf8'), /0 session\(s\) today/);
});

test('AC-2: a build lock that isn\'t a folder fails a session that builds, before it starts, and is left alone; a renewal that throws ends nothing', async () => {
  const t = atBuild(1, { done: 6 });
  fs.mkdirSync(t.w.settings.state, { recursive: true });
  fs.writeFileSync(buildLockDir(t.w.settings.state), 'not a folder');
  const out = await run(t.w, { ensureWorktree: t.ensureWorktree, spawnClaude: noSession }, { named: ['701'] });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['visualPack', 'failed']]);
  const l = read(t.w, '701');
  assert.match(l.prs[0].chain.visualPack.note, /^the build lock: .*not a folder/);
  assert.deepEqual([l.runs.at(-1).outcome, l.runs.at(-1).failures, 'start' in l.runs.at(-1)], ['failed', 1, false]);
  assert.equal(fs.readFileSync(buildLockDir(t.w.settings.state), 'utf8'), 'not a folder');

  // The build lock's renewal fails in its timer (here a folder where its temp file goes): the build goes on and is
  // recorded, and the run ends as usual.
  const u = atBuild();
  const timers = fakeTimers();
  const out2 = await run(u.w, {
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ensureWorktree: u.ensureWorktree,
    runBuild: async () => {
      fs.mkdirSync(path.join(buildLockDir(u.w.settings.state), `${HOLDER}.tmp-${process.pid}`));
      timers.tick(5 * 60000);
      return { code: 0, tail: [] };
    },
  }, { named: ['701'] });
  assert.deepEqual(out2.ran.map((r) => [r.stage, r.outcome]), [['build', 'done']]);
  assert.equal(read(u.w, '701').prs[0].chain.build.status, 'done');
  assert.equal(buildLockState(u.w.settings.state).held, false);
});

test('AC-1: the locales brief runs the locale-translator with --no-build; the re-sync\'s keeps its build, under the lock', () => {
  const w = world();
  const locales = briefFor({ stage: 'locales', role: 'translator', keys: ['701'], pr: 'guide-docs#61', head: HEAD }, w.settings);
  assert.match(locales, /Run the locale-translator with `--no-build`: the runner builds the site once for this PR, at the chain's `build` stage/);
  const resync = briefFor({ stage: 'resync', role: 'translator', keys: ['701'], pr: 'guide-docs#61', head: HEAD, since: 'a'.repeat(40) }, w.settings);
  assert.doesNotMatch(resync, /--no-build/);
  assert.match(resync, /The runner holds the build lock for this session: the locale-translator's build runs as usual/);
  for (const stage of ['translate', 'enReview', 'align', 'labelSync']) assert.doesNotMatch(briefFor({ stage, role: 'translator', keys: ['701'], pr: 'guide-docs#61' }, w.settings), /build lock|--no-build|--build-dir/);
});

test('TASK-110: the visual pack\'s brief says to run the pack once, since it retries what failed to capture itself, and again only after a crash or a fixed flag, never after a failed build', () => {
  const w = world();
  const once = /Run visual-pack once\. It captures each view that failed to capture once more by itself, with more time, and a view it still reports `page-missing` is a finding, not a reason to run it again\. Run it again, once, only after exit 3 \(a crash, or Chromium closed\), or after exit 2 once its cause \(a flag\) is fixed; exit 1, the build failed, is recorded as failed with the build error, not run again\./;
  for (const step of [{ buildDir: '/x/build' }, {}]) assert.match(briefFor({ stage: 'visualPack', role: 'reviewer', keys: ['701'], pr: 'guide-docs#61', head: HEAD, ...step }, w.settings), once);
  for (const stage of ['locales', 'resync', 'enReview']) assert.doesNotMatch(briefFor({ stage, role: stage === 'enReview' ? 'reviewer' : 'translator', keys: ['701'], pr: 'guide-docs#61', head: HEAD }, w.settings), /visual-pack once/);
});

test('runSiteBuild: a timeout ends the whole process group, the build\'s own children too', async () => {
  const dir = tmp('group-');
  const pidFile = path.join(dir, 'child.pid');
  const script = path.join(dir, 'parent.mjs');
  fs.writeFileSync(script, `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
console.log('building');
setInterval(() => {}, 1000);
`);
  // Long enough for node to start the parent and its child under the parallel load of the regression set.
  const r = await runSiteBuild({ cwd: dir, command: [process.execPath, script], timeoutMs: 5000, killGraceMs: 500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.tail, ['building']);
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && pidAlive(child); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(pidAlive(child), false, 'the grandchild is gone too');
  // A command that can't start: exit 127, with the reason.
  const missing = await runSiteBuild({ cwd: dir, command: [path.join(dir, 'no-such-bin')], timeoutMs: 5000 });
  assert.equal(missing.code, 127);
});

test('TASK-110: runSiteBuild\'s Node processes exit when their work is done, with their own code, the host\'s NODE_OPTIONS kept, and Docusaurus keeps no persistent cache', async () => {
  const dir = tmp('exit-');
  const script = path.join(dir, 'build.mjs');
  fs.writeFileSync(script, `console.log(JSON.stringify({ options: process.env.NODE_OPTIONS, cache: process.env.DOCUSAURUS_NO_PERSISTENT_CACHE, ci: process.env.CI, heap: (await import('node:v8')).getHeapStatistics().heap_size_limit, hooks: process.listenerCount('beforeExit') }));
process.exitCode = process.argv[2] === 'fail' ? 3 : 0;
`);
  const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=3000' };
  const ok = await runSiteBuild({ cwd: dir, command: [process.execPath, script], timeoutMs: 20000, env });
  assert.equal(ok.code, 0);
  const seen = JSON.parse(ok.tail.at(-1));
  assert.equal(seen.options, `--max-old-space-size=3000 --require ${JSON.stringify(EXIT_WHEN_BUILT)}`);
  assert.equal(Math.round(seen.heap / 2 ** 20) >= 3000, true, 'the host\'s own option still applies');
  assert.deepEqual([seen.cache, seen.ci, seen.hooks], ['true', '1', 1]);
  const failed = await runSiteBuild({ cwd: dir, command: [process.execPath, script, 'fail'], timeoutMs: 20000, env });
  assert.equal(failed.code, 3);
  assert.equal(buildEnv({ PATH: '/bin' }).NODE_OPTIONS, `--require ${JSON.stringify(EXIT_WHEN_BUILT)}`);
  // A build that stopped partway (a top-level await that never settles) still fails with Node's own 13, and work a
  // `beforeExit` listener starts still runs.
  const stalled = path.join(dir, 'stalled.mjs');
  fs.writeFileSync(stalled, 'await new Promise(() => {});\n');
  assert.equal((await runSiteBuild({ cwd: dir, command: [process.execPath, stalled], timeoutMs: 20000, env })).code, 13);
  const late = path.join(dir, 'late.mjs');
  fs.writeFileSync(late, `let once = false;
process.on('beforeExit', () => { if (!once) { once = true; setTimeout(() => console.log('late work ran'), 50); } });
`);
  const r = await runSiteBuild({ cwd: dir, command: [process.execPath, late], timeoutMs: 20000, env });
  assert.deepEqual([r.code, r.tail], [0, ['late work ran']]);
});

test('settings: build.command and the rest come from the shared file; a text command is split into words; a bad one is refused', async () => {
  const { validateSettings, localOnly } = await import('../lib/settings.mjs');
  const { rawSettings } = await import('./fakes.mjs');
  const root = tmp();
  const def = validateSettings(rawSettings({}), { root, stateRootDefault: '.x/' }).build;
  assert.deepEqual(def, { command: ['npm', 'run', 'build'], outDir: 'build', timeoutMinutes: 60, waitMinutes: 90 });
  assert.deepEqual(validateSettings(rawSettings({ build: { command: 'yarn  build --locale uk', outDir: './site/' } }), { root, stateRootDefault: '.x/' }).build.command, ['yarn', 'build', '--locale', 'uk']);
  assert.throws(() => validateSettings(rawSettings({ build: { command: [] } }), { root, stateRootDefault: '.x/' }), /build\.command/);
  assert.throws(() => validateSettings(rawSettings({ build: { outDir: '../out' } }), { root, stateRootDefault: '.x/' }), /build\.outDir/);
  assert.deepEqual(localOnly({ build: { command: 'rm -rf /' }, mode: 'on' }), { local: { mode: 'on' }, ignored: ['build'] }, 'a local build is ignored');
});
