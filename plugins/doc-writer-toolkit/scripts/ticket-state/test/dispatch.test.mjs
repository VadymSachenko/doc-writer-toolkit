import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD, LISTS, NOW, card, noTree, quietGit } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { emptyFeed, readFeed, sourcesOf, writeFeed } from '../lib/feed.mjs';
import { allLocks, releaseLock, takeLock } from '../lib/locks.mjs';
import { runRecord } from '../lib/record.mjs';
import { runCheck, startPrint } from '../lib/watch.mjs';
import { runHandOn } from '../lib/forge-watch.mjs';
import { emptyForge, readHandOnStep, writeForge } from '../lib/forge-state.mjs';
import { digestRun } from '../lib/progress.mjs';
import { oneLine } from '../watcher.mjs';

// TASK-092: the full check, its morning run and its start pass decide as before and hand each group to a run in a
// process of its own (`watcher.mjs --hand-on`), one group per process, and end: no check waits for a session but a
// triage's. The real runner and status decide; `io.spawn` stands in for the detached process (a live pid until the
// test finishes its run with `finish`, through the real `runHandOn`), `io.isAlive` for which pids live, and `claude` is
// a stand-in that records what it was asked.

process.env.TZ = 'UTC';

const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const usageAt = (week, session = 10) => parseUsage(`Current session: ${session}% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 's' });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const stageOf = (cmd) => /Stage `(\w+)` of tickets? (\d+)/.exec(briefOf(cmd)).slice(1);

let n = 0;
function act(c, time, { to = null, from = null } = {}) {
  return { id: `dp-${++n}`, type: to ? 'updateCard' : 'commentCard', time: iso(time), card: { id: c.id, shortLink: c.shortLink, name: c.name }, by: null, text: null, placeId: to?.id ?? c.placeId, placeBefore: from, placeAfter: to, changed: to ? ['idList'] : [] };
}
// The owner answered the questions and moved the card back to In progress: its next step is the answers (a session).
const moved = (c, at) => act(c, at, { from: { id: LISTS.blocked.id, name: 'Blocked' }, to: { id: LISTS.inProgress.id, name: 'Doing' } });

function answered(w, number) {
  const c = card({ number, status: 'inProgress' });
  w.tracker.cards.push(c);
  ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  return c;
}

function readyTicket(w, number) {
  const c = card({ number, status: 'ready' });
  w.tracker.cards.push(c);
  ledger(w, c, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  return c;
}

function seed(w, lastCheck, { morning = '2026-11-10', starts = null } = {}) {
  const f = emptyFeed();
  for (const s of sourcesOf(w.settings)) f.sources[s.name] = { lastCheck: iso(lastCheck), seen: {} };
  f.morning = { lastDate: morning };
  if (starts) f.starts = starts;
  writeFeed(w.settings.state, f);
}

// The stand-ins. A spawned process lives until `finish` runs its hand-on and ends its pid. The session stand-in records
// a start (and moves its card) as a start session would; any other stage fails, so it waits.
function harness(w, { week = 5, cards = {} } = {}) {
  let clock = NOW;
  let pids = 7000;
  const live = new Set();
  const calls = { spawns: [], usage: 0, sessions: [], notes: [] };
  const runner = {
    now: () => clock,
    readUsage: () => (calls.usage++, typeof week === 'function' ? week() : usageAt(week)),
    ensureWorktree: noTree,
    spawnClaude: async (cmd) => {
      const [stage, key] = stageOf(cmd);
      calls.sessions.push({ stage, key, at: iso(clock), usageReads: calls.usage });
      if (stage !== 'start') return { code: 1, stdout: '', stderr: 'not this test' };
      cards[key].placeId = LISTS.inProgress.id;
      await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'start', status: 'done', card: cards[key].shortLink, startedBy: 'schedule', result: { group: key }, now: clock });
      return { code: 0, stdout: RESULT };
    },
  };
  const io = () => ({
    now: () => clock,
    git: quietGit,
    isAlive: (p) => p === process.pid || live.has(p),
    runner,
    spawn: (args, { kind }) => {
      const pid = ++pids;
      live.add(pid);
      const id = args[args.indexOf('--hand-on') + 1];
      calls.spawns.push({ at: clock, kind, pid, id, keys: args.flatMap((a, i) => (a === '--ticket' ? [args[i + 1]] : [])), step: readHandOnStep(w.settings.state, id) });
      return { pid };
    },
    notify: (m) => (calls.notes.push(m), { sent: true }),
  });
  const full = (at, options = {}) => {
    clock = at;
    return runCheck({ settings: w.settings, clients: w.clients(), io: io(), options });
  };
  const finish = async (s, at) => {
    clock = at;
    const r = await runHandOn({ settings: w.settings, clients: w.clients(), io: { now: () => clock, runner }, options: { id: s.id, keys: s.keys } });
    live.delete(s.pid);
    return r;
  };
  const spawned = () => calls.spawns.map((s) => [(s.at - NOW) / MIN, s.step?.step?.stage ?? null, s.keys]);
  return { calls, live, full, finish, spawned, runner };
}

test('AC-1: a card move on a ticket not locked is handed on by the next full check while another group\'s chain runs', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 601);
  const b = answered(w, 602);
  seed(w, NOW - 5 * MIN);
  const h = harness(w);
  actions[BOARD].push(moved(a, NOW - MIN));
  let out = await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']]]);
  assert.deepEqual(h.calls.sessions, [], 'the check runs no session');
  assert.match(oneLine(out), /handed on 601 \(run [\w-]+\)/);
  // A's run goes on: its process lives and holds A's group lock through its chain.
  takeLock(w.settings.state, { group: '601', kind: 'schedule', stage: 'answers', leaseMinutes: 120, now: NOW + MIN });
  actions[BOARD].push(moved(b, NOW + 3 * MIN));
  out = await h.full(NOW + 5 * MIN);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']], [5, 'answers', ['602']]]);
  assert.deepEqual([h.calls.sessions, out.pending], [[], []]);
  assert.deepEqual(readFeed(w.settings.state).handOns.map((x) => [x.keys, x.stage, x.by]), [[['601'], 'answers', 'watcher'], [['602'], 'answers', 'watcher']]);
  // One /usage reading per check that hands on; B's run starts from it, and its own first reading is after its session.
  assert.equal(h.calls.usage, 2);
  assert.deepEqual(h.calls.spawns[1].step.usage, usageAt(5));
  await h.finish(h.calls.spawns[1], NOW + 6 * MIN);
  assert.deepEqual(h.calls.sessions.map((s) => [s.stage, s.key, s.usageReads]), [['answers', '602', 2]]);
  assert.ok(h.calls.usage > 2, 'the reading after the session is the run\'s own');
  // The next check collects B's run; A's still goes on and is kept.
  out = await h.full(NOW + 10 * MIN);
  assert.deepEqual([out.finished.map((f) => f.keys), readFeed(w.settings.state).handOns.map((x) => x.keys)], [[['602']], [['601']]]);
});

test('AC-2: the full check, the forge check\'s record and the morning run reaching one ticket in one window start one run', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 601);
  seed(w, NOW - 5 * MIN);
  const h = harness(w);
  actions[BOARD].push(moved(a, NOW - MIN));
  await h.full(NOW);
  // A second event before the run took its lock (it reads its status first): held, in pending, not handed on again.
  actions[BOARD].push(act(a, NOW + 2 * MIN));
  let out = await h.full(NOW + 5 * MIN);
  assert.deepEqual([h.spawned(), out.pending], [[[0, 'answers', ['601']]], ['601']]);

  // The forge check handed 602 on (its record lives, no lock yet); the morning run reaches 602 too and holds it.
  const b = answered(w, 602);
  h.live.add(4242);
  writeForge(w.settings.state, { ...emptyForge(), handOns: [{ id: 'f1', pid: 4242, keys: ['602'], at: iso(NOW + 9 * MIN) }] });
  writeFeed(w.settings.state, { ...readFeed(w.settings.state), morning: { lastDate: '2026-11-09' } });
  out = await h.full(NOW + 10 * MIN);
  assert.ok(out.morning, 'the morning run');
  assert.deepEqual(out.morning.handedOn.map((x) => [x.keys, x.held ? 'held' : x.handedOn ? 'handed' : 'other']), [[['601'], 'held'], [['602'], 'held']]);
  assert.deepEqual([h.spawned().length, out.pending.sort()], [1, ['601', '602']]);
  // Once both runs ended, the next check hands 602 on, once (601's session failed: it waits for a person).
  h.live.delete(4242);
  await h.finish(h.calls.spawns[0], NOW + 12 * MIN);
  actions[BOARD].push(act(b, NOW + 13 * MIN));
  await h.full(NOW + 15 * MIN);
  assert.deepEqual(h.spawned().map((x) => x[2]), [['601'], ['602']]);
});

test('AC-2: a start handed on counts as starting now until its run records it: no second start, and the limits count it', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 }, open: 1, startHours: '08-22' } } });
  const cards = { 502: readyTicket(w, 502), 503: readyTicket(w, 503) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  const out = await h.full(NOW);
  // The morning run decides the day's starts once: 502 fits limits.open 1, and 503 waits behind it.
  assert.deepEqual(h.spawned(), [[0, 'start', ['502']]]);
  assert.deepEqual(out.morning.starts.map((s) => [s.keys, Boolean(s.handedOn)]), [[['502'], true]]);
  assert.match(out.morning.notStarted.find((x) => x.keys.includes('503')).reasons.join(' '), /0 open \(502 starting now\) \+ 1 > 1|1 open/);
  // Any status meanwhile counts 502 as starting now: open, not startable again.
  const st = await w.status({ usage: usageAt(5), inFlight: new Set(['502']) });
  assert.deepEqual([st.startable, st.wip.open], [[], 1]);
  assert.deepEqual(st.notStarted.map((x) => [x.keys, x.reasons[0]]), [[['502'], 'starting now in a process of its own'], [['503'], '1 open (502 starting now) + 1 > 1']]);
  // A start pass in that window (a new ready card is a change) sees no room and reads no /usage.
  const c504 = readyTicket(w, 504);
  cards[504] = c504;
  actions[BOARD].push(act(c504, NOW + 4 * MIN, { to: LISTS.ready }));
  const usage = h.calls.usage;
  const next = await h.full(NOW + 5 * MIN);
  assert.equal(next.startPass?.ran, false);
  assert.deepEqual([h.spawned().length, h.calls.usage], [1, usage]);
  // 502's run starts 502 alone, as a scheduled start, from the check's reading.
  await h.finish(h.calls.spawns[0], NOW + 6 * MIN);
  assert.deepEqual(h.calls.sessions.map((s) => [s.stage, s.key]), [['start', '502'], ['plan', '502']]);
  assert.deepEqual([read(w, '502').startedBy, read(w, '503').stages.start], ['schedule', undefined]);
});

test('AC-3: limits.parallel holds across the processes: a group over it waits in pending and the next check with a slot hands it on', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { parallel: 1 } } });
  const a = answered(w, 601);
  const b = answered(w, 602);
  seed(w, NOW - 5 * MIN);
  const h = harness(w);
  actions[BOARD].push(moved(a, NOW - MIN), moved(b, NOW - MIN));
  let out = await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']]]);
  assert.deepEqual([out.pending, out.run.handedOn.find((x) => x.keys.includes('602')).waits], [['602'], '1 run(s) going, limits.parallel 1']);
  assert.match(oneLine(out), /602 not handed on: 1 run\(s\) going, limits.parallel 1/);
  out = await h.full(NOW + 5 * MIN);
  assert.deepEqual([h.spawned().length, out.pending], [1, ['602']]);
  await h.finish(h.calls.spawns[0], NOW + 7 * MIN);
  out = await h.full(NOW + 10 * MIN);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']], [10, 'answers', ['602']]]);
  assert.deepEqual(out.pending, []);
});

test("AC-3: the allowance guard still stops starts at the day's cap, at the hand-on and in the run handed a start", async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 } } } });
  const cards = { 502: readyTicket(w, 502) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { week: 99, cards });
  const out = await h.full(NOW);
  assert.deepEqual([h.spawned(), out.morning.starts], [[], []]);
  assert.match(out.morning.notStarted.map((g) => g.reasons.join(' ')).join(' '), /left today|allowance/);
  // A start handed on with a reading the day's allowance doesn't cover starts nothing.
  const step = { id: 's1', by: 'morning', at: iso(NOW), step: { stage: 'start', group: '502', keys: ['502'] }, usage: usageAt(99), usageAt: iso(NOW) };
  const { writeHandOnStep } = await import('../lib/forge-state.mjs');
  writeHandOnStep(w.settings.state, 's1', step);
  const r = await runHandOn({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, runner: h.runner }, options: { id: 's1', keys: ['502'] } });
  assert.deepEqual([h.calls.sessions, r.run.starts, read(w, '502').stages.start], [[], [], undefined]);
});

test("AC-4: the morning run's triage and starts happen once a day, though the groups it handed on outlive its check", async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 } } } });
  const a = answered(w, 601);
  const cards = { 502: readyTicket(w, 502) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  const out = await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']], [0, 'start', ['502']]]);
  // Its date is recorded at once: the check ended while both runs go on.
  assert.equal(readFeed(w.settings.state).morning.lastDate, '2026-11-10');
  assert.equal(h.calls.usage, 1, 'one /usage reading for the whole morning run');
  assert.match(h.calls.notes.find((x) => /morning report/.test(x.title)).text, /^1 group\(s\) handed on, 1 start\(s\) handed on/);
  actions[BOARD].push(act(a, NOW + 2 * MIN));
  for (const at of [NOW + 5 * MIN, NOW + 10 * MIN, NOW + 15 * MIN]) assert.equal((await h.full(at)).morning, null);
  assert.equal(h.spawned().length, 2);
  // Every run handed on: one group each, its step and the check's reading in its step file.
  assert.deepEqual(h.calls.spawns.map((s) => [s.step.by, s.step.step.keys, s.step.retryWaiting]), [['morning', ['601'], true], ['morning', ['502'], true]]);
  assert.equal(out.morning.ran.length, 0, 'no step ran in the check');
});

test('the start-pass defect: a pass with no /usage reading is tried again after 30 minutes with no change, and starts', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 }, startHours: '08-22' } } });
  const cards = { 502: readyTicket(w, 502) };
  const left = { date: '2026-11-10', at: iso(NOW - 60 * MIN), by: 'morning', print: startPrint({ date: '2026-11-10', openKeys: ['801'], ready: ['502'] }), nextDueAt: null, deferred: null };
  seed(w, NOW - 5 * MIN, { starts: left });
  actions[BOARD].push(act(cards[502], NOW - MIN));
  let reading = null;
  const h = harness(w, { week: () => reading, cards });
  // The morning run saw 801 open; it isn't any more (closed): a slot freed. The pass gets no reading and starts nothing.
  let out = await h.full(NOW);
  assert.equal(out.startPass.ran, true);
  assert.deepEqual(h.spawned(), []);
  const memory = readFeed(w.settings.state).starts;
  assert.deepEqual([memory.again, memory.retryAt], ['no usage reading: no scheduled start', iso(NOW + 30 * MIN)]);
  // Nothing changes; before the retry time no pass, after it one, which hands the start on.
  for (const at of [NOW + 5 * MIN, NOW + 25 * MIN]) assert.equal((await h.full(at)).startPass, undefined);
  reading = usageAt(5);
  out = await h.full(NOW + 30 * MIN);
  assert.equal(out.startPass.why, 'again: no usage reading: no scheduled start');
  assert.deepEqual(h.spawned(), [[30, 'start', ['502']]]);
  assert.equal(readFeed(w.settings.state).starts.again, undefined);
});

test('the progress file: only a run that decides starts says why a group did not start', () => {
  const st = { notStarted: [{ group: '503', keys: ['503'], reasons: ['1 open (502 starting now) + 1 > 1'] }] };
  assert.deepEqual(digestRun({ out: { trigger: 'watcher' }, st }).notStarted, []);
  assert.deepEqual(digestRun({ out: { trigger: 'schedule', startKeys: ['502'] }, st }).notStarted, []);
  assert.deepEqual(digestRun({ out: { trigger: 'schedule', startPass: true }, st }).notStarted.map((x) => x.keys), [['503']]);
});

test("the morning run's one more try of a failed start goes with its hand-on: the run starts it, with its failed session so far", async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 }, open: 1 } } });
  const c = card({ number: 501, status: 'ready' });
  w.tracker.cards.push(c);
  const at = iso(NOW - 20 * 3600000);
  ledger(w, c, { stages: { triage: 'done', start: { status: 'failed', note: 'the session ended without recording the stage' } }, startedBy: 'schedule', triage: { verdict: 'docs', targets: ['guide'], size: 'edit' }, runs: [{ seq: 9, stage: 'start', role: 'writer', outcome: 'failed', failures: 1, start: at, after: { at, list: LISTS.ready.id, comments: [], prs: {} } }] });
  const cards = { 501: c };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'start', ['501']]]);
  // Another status meanwhile (no retry of its own) still counts it as starting now.
  const st = await w.status({ usage: usageAt(5), inFlight: new Set(['501']) });
  assert.equal(st.wip.open, 1);
  await h.finish(h.calls.spawns[0], NOW + MIN);
  assert.deepEqual(h.calls.sessions.slice(0, 1).map((s) => [s.stage, s.key]), [['start', '501']]);
  assert.equal(read(w, '501').stages.start.status, 'done');
});

test('a start whose run died before recording it: the start pass looks again after 30 minutes, with no change', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 }, startHours: '08-22' } } });
  const cards = { 502: readyTicket(w, 502) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'start', ['502']]]);
  // Its process dies before its first step (a crash, a reboot): no result, no start recorded.
  h.live.delete(h.calls.spawns[0].pid);
  const out = await h.full(NOW + 5 * MIN);
  assert.match(out.notes.join(' '), /the run of 502 \(pid \d+\) ended with no result/);
  assert.deepEqual([readFeed(w.settings.state).starts.again, readFeed(w.settings.state).starts.retryAt], ['the start of 502 ended with no start recorded (no result)', iso(NOW + 35 * MIN)]);
  assert.equal((await h.full(NOW + 10 * MIN)).startPass, undefined);
  const again = await h.full(NOW + 35 * MIN);
  assert.equal(again.startPass.why, 'again: the start of 502 ended with no start recorded (no result)');
  assert.deepEqual(h.spawned(), [[0, 'start', ['502']], [35, 'start', ['502']]]);
});

test('review 1: a start whose run came back having started nothing (mode off when it began) is looked at again; a finishing run that did is put back in pending', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 }, startHours: '08-22' } } });
  const cards = { 502: readyTicket(w, 502) };
  const a = answered(w, 601);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']], [0, 'start', ['502']]]);
  // Both runs begin after the owner set mode off, and back on: each ends at once, with a result.
  w.settings.mode = 'off';
  for (const s of h.calls.spawns) assert.equal((await h.finish(s, NOW + MIN)).run.stopped, 'mode off: nothing runs');
  w.settings.mode = 'on';
  const out = await h.full(NOW + 5 * MIN);
  assert.deepEqual([h.spawned().slice(2), out.pending], [[[5, 'answers', ['601']]], []], 'the finishing ticket looked at again, and handed on');
  assert.deepEqual([readFeed(w.settings.state).starts.again, readFeed(w.settings.state).starts.retryAt], ['the start of 502 ended with no start recorded (mode off: nothing runs)', iso(NOW + 35 * MIN)]);
  void a;
});

test('review 3: the hold after a lost start holds its retry only: a new ready card meanwhile runs a pass at once', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 }, startHours: '08-22' } } });
  const cards = { 502: readyTicket(w, 502) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  await h.full(NOW);
  h.live.delete(h.calls.spawns[0].pid);
  await h.full(NOW + 5 * MIN);
  assert.equal(readFeed(w.settings.state).starts.retryAt, iso(NOW + 35 * MIN));
  // A new ready card 5 minutes later is a change: a pass now, which hands on both starts, not 30 minutes later.
  cards[503] = readyTicket(w, 503);
  actions[BOARD].push(act(cards[503], NOW + 9 * MIN, { to: LISTS.ready }));
  const out = await h.full(NOW + 10 * MIN);
  assert.match(out.startPass.why, /newly ready: 503/);
  assert.deepEqual(h.spawned().slice(1).map((x) => x[2]), [['502'], ['503']]);
});

test('review 2a: a step held for no usage reading waits 30 minutes before a check reads /usage for it again', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions });
  const a = answered(w, 601);
  seed(w, NOW - 5 * MIN);
  let reading = null;
  const h = harness(w, { week: () => reading });
  actions[BOARD].push(moved(a, NOW - MIN));
  let out = await h.full(NOW);
  assert.deepEqual([h.spawned(), out.pending, h.calls.usage], [[], ['601'], 1]);
  for (const at of [NOW + 5 * MIN, NOW + 25 * MIN]) assert.deepEqual((await h.full(at)).pending, ['601']);
  assert.equal(h.calls.usage, 1, 'no /usage read while it waits');
  reading = usageAt(5);
  out = await h.full(NOW + 30 * MIN);
  assert.deepEqual([h.spawned().map((x) => x[2]), out.pending, h.calls.usage], [[['601']], [], 2]);
});

test('review 2b: at the session bar a start pass that would only find the runs full runs no runner and reads no /usage', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { estimates: { edit: 4 }, startHours: '08-22' } } });
  const cards = { 502: readyTicket(w, 502) };
  const a = answered(w, 601);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { week: () => usageAt(5, 90), cards });
  await h.full(NOW);
  // The bar (90% ≥ 80%) gives one run at a time: 601's goes, 502's start waits for a slot.
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']]]);
  assert.match(readFeed(w.settings.state).starts.again, /a start waits for a run slot/);
  const reads = h.calls.usage;
  for (const at of [NOW + 5 * MIN, NOW + 10 * MIN]) assert.equal((await h.full(at)).startPass?.ran ?? false, false);
  assert.equal(h.calls.usage, reads, 'no /usage read while the bar keeps the one slot taken');
  // 601's run ends: the slot frees and the start goes on.
  await h.finish(h.calls.spawns[0], NOW + 12 * MIN);
  await h.full(NOW + 15 * MIN);
  assert.deepEqual(h.spawned().map((x) => x[2]), [['601'], ['502']]);
  void a;
});

test('review 4: a run handed on counts the runs again under its lock; past limits.parallel it frees the lock and waits for the next check', async () => {
  const actions = { [BOARD]: [] };
  const w = world({ actions, extra: { limits: { parallel: 1 } } });
  const a = answered(w, 601);
  seed(w, NOW - 5 * MIN);
  const h = harness(w);
  actions[BOARD].push(moved(a, NOW - MIN));
  await h.full(NOW);
  // Another check handed a run on at the same moment, and that run took its lock first.
  takeLock(w.settings.state, { group: '777', kind: 'schedule', stage: 'write', leaseMinutes: 60, now: NOW });
  const r = await h.finish(h.calls.spawns[0], NOW + MIN);
  assert.deepEqual([h.calls.sessions, r.run.waits.map((x) => x.keys), allLocks(w.settings.state, NOW + MIN).map((l) => l.group)], [[], [['601']], ['777']]);
  const out = await h.full(NOW + 5 * MIN);
  assert.deepEqual(out.pending, ['601']);
});

// A failed step's one more try that the morning run handed on, whose run then gave way at the recount (another run's
// lock older than its own): the try is owed again the same day, so the next check hands it on and it runs.
function failedAnswers(w, number) {
  const c = card({ number, status: 'inProgress' });
  w.tracker.cards.push(c);
  const at = iso(NOW - 30 * MIN);
  ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked', runs: [{ seq: 9, stage: 'answers', role: 'writer', outcome: 'failed', failures: 1, start: at, after: { at, list: c.placeId, comments: [], prs: {} } }] });
  return c;
}

function failedStart(w, number) {
  const c = card({ number, status: 'ready' });
  w.tracker.cards.push(c);
  const at = iso(NOW - 20 * 3600000);
  ledger(w, c, { stages: { triage: 'done', start: { status: 'failed', note: 'the session ended without recording the stage' } }, startedBy: 'schedule', triage: { verdict: 'docs', targets: ['guide'], size: 'edit' }, runs: [{ seq: 9, stage: 'start', role: 'writer', outcome: 'failed', failures: 1, start: at, after: { at, list: LISTS.ready.id, comments: [], prs: {} } }] });
  return c;
}

test('review 5a: a morning one more try whose run gives way at the recount is handed on again the same day, and runs', async () => {
  const w = world({ extra: { limits: { parallel: 1 } } });
  failedAnswers(w, 601);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w);
  await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'answers', ['601']]]);
  assert.equal(h.calls.spawns[0].step.retryWaiting, true);
  assert.equal(readFeed(w.settings.state).handOns[0].retried, true, 'the record carries the try');
  // Another run took its lock first: this one frees its own and ends as waiting.
  takeLock(w.settings.state, { group: '777', kind: 'schedule', stage: 'write', leaseMinutes: 60, now: NOW });
  const r = await h.finish(h.calls.spawns[0], NOW + MIN);
  assert.deepEqual([h.calls.sessions, r.run.waits.map((x) => x.keys)], [[], [['601']]]);
  releaseLock(w.settings.state, '777');
  const out = await h.full(NOW + 5 * MIN);
  assert.deepEqual([h.spawned().map((x) => x[2]), out.pending], [[['601'], ['601']], []]);
  assert.equal(h.calls.spawns[1].step.retryWaiting, true);
  assert.equal(readFeed(w.settings.state).owed, null, 'handed on: owed no more');
  await h.finish(h.calls.spawns[1], NOW + 6 * MIN);
  assert.deepEqual(h.calls.sessions.map((s) => [s.stage, s.key]), [['answers', '601']]);
});

test('review 5b: a morning one more try that finds mode off keeps its try for the same day', async () => {
  const w = world({ extra: { limits: { parallel: 1 } } });
  failedAnswers(w, 601);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w);
  await h.full(NOW);
  w.settings.mode = 'off';
  assert.equal((await h.finish(h.calls.spawns[0], NOW + MIN)).run.stopped, 'mode off: nothing runs');
  w.settings.mode = 'on';
  await h.full(NOW + 5 * MIN);
  assert.deepEqual(h.spawned().map((x) => [x[0], x[2]]), [[0, ['601']], [5, ['601']]]);
  assert.equal(h.calls.spawns[1].step.retryWaiting, true);
  assert.equal(readFeed(w.settings.state).owed, null, 'handed on again: owed no more');
});

test("review 5c: a lost start's one more try is kept: the start pass 30 minutes later hands it on, and it starts", async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 }, parallel: 1, startHours: '08-22' } } });
  const cards = { 501: failedStart(w, 501) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  await h.full(NOW);
  assert.deepEqual(h.spawned(), [[0, 'start', ['501']]]);
  takeLock(w.settings.state, { group: '777', kind: 'schedule', stage: 'write', leaseMinutes: 60, now: NOW });
  const r = await h.finish(h.calls.spawns[0], NOW + MIN);
  assert.deepEqual([h.calls.sessions, r.run.waits.map((x) => x.keys)], [[], [['501']]]);
  releaseLock(w.settings.state, '777');
  await h.full(NOW + 5 * MIN);
  const feed = readFeed(w.settings.state);
  assert.deepEqual([feed.starts.retryAt, feed.owed], [iso(NOW + 35 * MIN), { date: '2026-11-10', keys: ['501'] }]);
  const out = await h.full(NOW + 35 * MIN);
  assert.match(out.startPass.why, /^again: the start of 501 ended with no start recorded/);
  assert.deepEqual(h.spawned(), [[0, 'start', ['501']], [35, 'start', ['501']]]);
  assert.equal(h.calls.spawns[1].step.retryWaiting, true);
  assert.equal(readFeed(w.settings.state).owed, null);
  await h.finish(h.calls.spawns[1], NOW + 36 * MIN);
  assert.equal(read(w, '501').stages.start.status, 'done');
});

test('review 5d: a start pass gives the one more try only to the start owed it, not to another failed start', async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 }, parallel: 3, startHours: '08-22' } } });
  const cards = { 501: failedStart(w, 501), 502: failedStart(w, 502) };
  const lost = { date: '2026-11-10', at: iso(NOW - 40 * MIN), by: 'morning', print: startPrint({ date: '2026-11-10', openKeys: [], ready: [] }), nextDueAt: null, deferred: null, again: 'the start of 501 ended with no start recorded', retryAt: iso(NOW - 5 * MIN) };
  seed(w, NOW - 5 * MIN, { starts: lost });
  writeFeed(w.settings.state, { ...readFeed(w.settings.state), owed: { date: '2026-11-10', keys: ['501'] } });
  const h = harness(w, { cards });
  const out = await h.full(NOW);
  assert.equal(out.startPass.ran, true);
  assert.deepEqual(h.spawned(), [[0, 'start', ['501']]]);
  assert.match(out.startPass.run.notStarted.find((x) => x.keys.includes('502')).reasons.join(' '), /its start failed .*the next morning run/);
});

test("review 5e: a triage's locks are not runs: a run handed on doesn't give way to them at the recount", async () => {
  const w = world({ extra: { limits: { parallel: 1 } } });
  failedAnswers(w, 601);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w);
  await h.full(NOW);
  // The morning run's triage, in the check's process, took a lock per intake card before this run took its own.
  takeLock(w.settings.state, { group: '901', kind: 'schedule', stage: 'triage', leaseMinutes: 60, now: NOW });
  takeLock(w.settings.state, { group: '902', kind: 'schedule', stage: 'triage', leaseMinutes: 60, now: NOW });
  const r = await h.finish(h.calls.spawns[0], NOW + MIN);
  assert.deepEqual([r.run.waits, h.calls.sessions.map((s) => [s.stage, s.key])], [[], [['answers', '601']]]);
});

test('review 5f: a morning start retry it could not hand on (the runs full) is owed: the start pass gives it once a slot frees', async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 }, parallel: 1, startHours: '08-22' } } });
  const cards = { 501: failedStart(w, 501) };
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w, { cards });
  takeLock(w.settings.state, { group: '777', kind: 'schedule', stage: 'write', leaseMinutes: 60, now: NOW - MIN });
  const out = await h.full(NOW);
  assert.deepEqual([h.spawned(), out.morning.startRetriesLeft], [[], ['501']]);
  assert.deepEqual(readFeed(w.settings.state).owed, { date: '2026-11-10', keys: ['501'] });
  releaseLock(w.settings.state, '777');
  await h.full(NOW + 5 * MIN);
  assert.deepEqual(h.spawned(), [[5, 'start', ['501']]]);
  assert.equal(h.calls.spawns[0].step.retryWaiting, true);
  await h.finish(h.calls.spawns[0], NOW + 6 * MIN);
  assert.equal(read(w, '501').stages.start.status, 'done');
});

test('review 5g: a plain step whose run gives way carries no try, so none is owed; it is handed on again as before', async () => {
  const w = world({ extra: { limits: { parallel: 1 } } });
  answered(w, 601);
  seed(w, NOW - 5 * MIN, { morning: '2026-11-09' });
  const h = harness(w);
  await h.full(NOW);
  assert.equal(readFeed(w.settings.state).handOns[0].retried, undefined);
  takeLock(w.settings.state, { group: '777', kind: 'schedule', stage: 'write', leaseMinutes: 60, now: NOW });
  await h.finish(h.calls.spawns[0], NOW + MIN);
  releaseLock(w.settings.state, '777');
  await h.full(NOW + 5 * MIN);
  assert.deepEqual([h.spawned().map((x) => x[2]), readFeed(w.settings.state).owed], [[['601'], ['601']], null]);
  assert.equal(h.calls.spawns[1].step.retryWaiting, false);
});
