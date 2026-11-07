import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD, LISTS, NOW, card, pr, quietGit } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { emptyFeed, readFeed, sourcesOf, writeFeed } from '../lib/feed.mjs';
import { changeOf, inStartHours, noRoomOf, runCheck, startPrint } from '../lib/watch.mjs';
import { runDaily } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { notificationsOf } from '../lib/notify.mjs';
import { readRunLog, renderReport } from '../lib/report.mjs';
import { oneLine } from '../watcher.mjs';
import { parseStartHours } from '../lib/settings.mjs';
import { settingsFor, tmp } from './fakes.mjs';

// The watcher's start pass: when a slot frees between morning runs, inside `limits.startHours`, the watcher has the
// runner triage and start as a scheduled run would, once per change of what a start depends on. Recorded responses
// only; the start session is a stand-in that records the start and moves the card, as a real one would.

process.env.TZ = 'UTC';

const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const AT = (hhmm, day = 0) => Date.parse(`2026-11-10T${hhmm}:00Z`) + day * DAY;
const usageAt = (week) => parseUsage(`Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 's' });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const keyOfBrief = (cmd) => /Stage `(\w+)` of tickets? (\d+)/.exec(briefOf(cmd)).slice(1);
const originOf = (cmd) => /--started-by (\w+)/.exec(briefOf(cmd))?.[1] ?? null;

let n = 0;
function act(c, time, { type = 'commentCard', to = null } = {}) {
  return { id: `sp-${++n}`, type, time: iso(time), card: { id: c.id, shortLink: c.shortLink, name: c.name }, by: null, text: null, placeId: to?.id ?? c.placeId, placeBefore: null, placeAfter: to, changed: [] };
}

// A host with `limits.open` 1: one open ticket in review (a scheduled start), and a ready ticket triaged as an edit.
function flow({ limits = {}, ready = true, extra = {} } = {}) {
  const actions = { [BOARD]: [] };
  const changed = { 'guide-docs': [] };
  const w = world({ actions, changed, extra: { limits: { estimates: { edit: 4 }, open: 1, ...limits }, ...extra } });
  const open = card({ number: 801, status: 'smeReview' });
  w.tracker.cards.push(open);
  w.forge.prs.push(pr({ repo: 'guide-docs', number: 801, labels: ['in expert review'] }));
  ledger(w, open, { stages: { triage: 'done', start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, startedBy: 'schedule', prs: [{ repo: 'guide-docs', number: 801, targets: ['guide'], review: 'sme', stage: 'smeReview' }], triage: { verdict: 'docs', targets: ['guide'], size: 'edit' } });
  const cards = { 801: open };
  if (ready) {
    cards[502] = card({ number: 502, status: 'ready' });
    w.tracker.cards.push(cards[502]);
    ledger(w, cards[502], { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  }
  // The owner merges 801's PR: the forge's PR changes, and its card moves on.
  const merge = (at) => {
    w.forge.prs.find((p) => p.number === 801).state = 'merged';
    changed['guide-docs'].push({ number: 801, updatedAt: iso(at), head: 'ticket-801' });
  };
  return { w, actions, cards, merge };
}

// Every source with its cursor at `lastCheck`, today's morning run done, and what the morning run left (`starts`).
function seed(w, lastCheck, { starts = null, morning = '2026-11-10' } = {}) {
  const f = emptyFeed();
  for (const s of sourcesOf(w.settings)) f.sources[s.name] = { lastCheck: iso(lastCheck), seen: {} };
  f.morning = { lastDate: morning };
  if (starts) f.starts = starts;
  writeFeed(w.settings.state, f);
}
const morningLeft = (date, open, ready, intakeDue = []) => ({ date, at: `${date}T10:00:00.000Z`, by: 'morning', print: startPrint({ date, openKeys: open, ready, intakeDue }), nextDueAt: null, deferred: null });

// A check with the real runner for the start pass (its start session a stand-in), and a recorded stand-in for the
// watcher's own run and the morning run. No real notification: `notify` records.
function checker(w, { cards = {}, week = 7, finishTakes = 0, passThrows = 0 } = {}) {
  let throws = passThrows;
  const calls = { runs: [], sessions: [], notes: [], usage: 0 };
  let clock = NOW;
  const spawnClaude = async (cmd) => {
    const [stage, key] = keyOfBrief(cmd);
    calls.sessions.push(`${stage} ${key} ${originOf(cmd)}`);
    if (stage !== 'start') return { code: 1, stdout: '', stderr: 'not this test' };
    cards[key].placeId = LISTS.inProgress.id;
    await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'start', status: 'done', card: cards[key].shortLink, startedBy: originOf(cmd), result: { group: key }, now: clock });
    return { code: 0, stdout: RESULT };
  };
  const check = (at, options = {}) => {
    clock = at;
    return runCheck({
      settings: w.settings,
      clients: w.clients(),
      io: {
        now: () => clock,
        git: quietGit,
        runDaily: async (a) => {
          calls.runs.push(a.options);
          if (!a.options.startPass) {
            if (!a.options.morning) clock += finishTakes; // the watcher's own run, as long as its sessions take
            return { mode: w.settings.mode, named: a.options.named ?? [], ran: [], starts: [], guard: [] };
          }
          if (throws > 0) {
            throws--;
            throw new Error('the runner crashed before its first step');
          }
          return runDaily({ ...a, io: { ...a.io, now: () => clock, readUsage: () => (calls.usage++, usageAt(week)), spawnClaude, ensureWorktree: () => assert.fail('a start has no worktree') } });
        },
        readUsage: () => assert.fail('the watcher reads no /usage of its own'),
        notify: (msg) => (calls.notes.push(msg), { sent: true }),
      },
      options,
    });
  };
  const passes = () => calls.runs.filter((r) => r.startPass);
  return { check, calls, passes };
}

test('AC-1: a merge that frees the only slot at 15:00 starts the ready ticket at the next check, as a scheduled start; nothing more after', async () => {
  const { w, actions, cards, merge } = flow();
  seed(w, AT('14:50'), { starts: morningLeft('2026-11-10', ['801'], ['502']) });
  const { check, calls, passes } = checker(w, { cards });
  // An event on the open ticket that frees nothing: no start pass, no /usage.
  actions[BOARD].push(act(cards[801], AT('14:52')));
  let out = await check(AT('14:55'));
  assert.equal(out.startPass, undefined);
  assert.deepEqual([passes().length, calls.usage], [0, 0]);

  merge(AT('15:00'));
  out = await check(AT('15:05'));
  assert.deepEqual(passes().map((r) => [r.trigger, r.startPass, Boolean(r.morning), r.named ?? []]), [['schedule', true, false, []]]);
  // The start, recorded as a scheduled one; the group goes on to its plan as after any scheduled start (the stand-in
  // fails it, so it waits).
  assert.deepEqual(calls.sessions, ['start 502 schedule', 'plan 502 null']);
  assert.deepEqual([read(w, '502').startedBy, read(w, '502').stages.start.status], ['schedule', 'done']);
  assert.equal(out.startPass.why, 'a slot freed: 801 no longer open');
  assert.match(oneLine(out), /start pass \(a slot freed: 801 no longer open\): started 502/);
  assert.deepEqual(calls.notes.map((x) => [x.urgent, x.title, x.text]), [[false, 'Ticket flow: a ticket started', '502 started outside the morning run (a slot freed: 801 no longer open). /ticket-report']]);
  const memory = readFeed(w.settings.state).starts;
  assert.deepEqual([memory.by, memory.print.open, memory.print.ready, memory.outcome], ['watcher', ['502'], [], 'started 502']);
  // Counted like any scheduled start: the slot is taken, and the day's report says what the pass did.
  const st = await w.status({ usage: usageAt(7) });
  assert.deepEqual(st.wip.openKeys, ['502']);
  assert.match(renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }), /The last start pass when a slot freed: 2026-11-10T15:05:00\.000Z, started 502\./);
  assert.ok(readRunLog(w.settings.state, '2026-11-10').some((e) => e.kind === 'step' && e.stage === 'start' && e.outcome === 'done' && e.keys.includes('502')), "the start is in the day's run log");

  // The next checks: no change, no pass.
  await check(AT('15:10'));
  actions[BOARD].push(act(cards[502], AT('15:12')));
  await check(AT('15:15'));
  assert.equal(passes().length, 1);
  assert.equal(calls.sessions.length, 2);
});

test('AC-1: the same merge at 23:00 starts nothing through the night; the change waits, and the 10:00 morning run takes it', async () => {
  const { w, actions, cards, merge } = flow({ extra: { schedule: { morning: '10:00' } } });
  seed(w, AT('22:50'), { starts: morningLeft('2026-11-10', ['801'], ['502']) });
  const { check, calls, passes } = checker(w, { cards });
  merge(AT('23:00'));
  const out = await check(AT('23:05'));
  assert.equal(out.startPass, undefined);
  assert.match(readFeed(w.settings.state).starts.deferred, /a slot freed: 801 no longer open/);
  for (let at = AT('23:10'); at < AT('10:00', 1); at += 30 * MIN) {
    if (at === AT('03:10', 1)) actions[BOARD].push(act(cards[801], at - MIN));
    await check(at);
  }
  assert.deepEqual([passes().length, calls.sessions.length, calls.usage], [0, 0, 0], 'no start pass, no triage, no /usage between 22:00 and 10:00');
  await check(AT('10:00', 1));
  assert.deepEqual(calls.runs.filter((r) => r.morning).map((r) => [r.trigger, r.morning]), [['schedule', true]], 'the morning run starts it');
  assert.equal(passes().length, 0, 'not a start pass as well');
  const memory = readFeed(w.settings.state).starts;
  assert.deepEqual([memory.by, memory.date, memory.deferred], ['morning', '2026-11-11', null]);
});

test("AC-1: a check that starts at 21:50 and whose own run ends at 22:10 starts nothing: the hours are read when the pass would run", async () => {
  const { w, cards, merge } = flow();
  seed(w, AT('21:40'), { starts: morningLeft('2026-11-10', ['801'], ['502']) });
  const { check, calls, passes } = checker(w, { cards, finishTakes: 20 * MIN });
  merge(AT('21:45'));
  const out = await check(AT('21:50'));
  assert.deepEqual(calls.runs.map((r) => r.named), [['801']], "the watcher's own run follows the merged ticket");
  assert.deepEqual([out.startPass, passes().length, calls.sessions.length, calls.usage], [undefined, 0, 0, 0]);
  assert.match(readFeed(w.settings.state).starts.deferred, /a slot freed: 801 no longer open/);
});

test('AC-1: a start pass stops starting when the start hours end during it; the group it started goes on', async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 }, open: 2 } } });
  const cards = {};
  for (const n of [501, 502]) {
    cards[n] = card({ number: n, status: 'ready' });
    w.tracker.cards.push(cards[n]);
    ledger(w, cards[n], { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  }
  let clock = AT('21:50');
  const sessions = [];
  const spawnClaude = async (cmd) => {
    const [stage, key] = keyOfBrief(cmd);
    sessions.push(`${stage} ${key}`);
    clock += 10 * MIN;
    if (stage !== 'start') return { code: 1, stdout: '', stderr: 'not this test' };
    cards[key].placeId = LISTS.inProgress.id;
    await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'start', status: 'done', card: cards[key].shortLink, startedBy: originOf(cmd), result: { group: key }, now: clock });
    return { code: 0, stdout: RESULT };
  };
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { now: () => clock, readUsage: () => usageAt(7), spawnClaude }, options: { trigger: 'schedule', startPass: true, startUntil: AT('22:00') } });
  assert.deepEqual(sessions, ['start 501', 'plan 501'], 'one start, its chain goes on; no second start after 22:00');
  assert.ok(out.notes.includes('the start hours ended at 2026-11-10T22:00:00.000Z: no further start in this pass'), out.notes.join('\n'));
  // 502 could still start: only the end of the hours held it.
  assert.deepEqual((await w.status({ usage: usageAt(7) })).startable.map((g) => g.group), ['502']);
});

test('AC-2: with no ready ticket, a freed slot looks once and runs no runner; later events on other tickets look no more', async () => {
  const { w, actions, cards, merge } = flow({ ready: false });
  const blocked = card({ number: 301, status: 'blocked' });
  w.tracker.cards.push(blocked);
  ledger(w, blocked, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  seed(w, AT('14:50'), { starts: morningLeft('2026-11-10', ['801'], []) });
  const { check, calls, passes } = checker(w, { cards });
  merge(AT('15:00'));
  const out = await check(AT('15:05'));
  assert.deepEqual([out.startPass.ran, out.startPass.skipped], [false, 'no ready ticket']);
  assert.match(oneLine(out), /start pass not run \(a slot freed: 801 no longer open\): no ready ticket/);
  for (const at of [AT('15:10'), AT('15:15'), AT('15:20')]) {
    actions[BOARD].push(act(blocked, at - MIN));
    const o = await check(at);
    assert.equal(o.startPass, undefined);
  }
  assert.deepEqual([passes().length, calls.usage], [0, 0]);
});

test("AC-2: the day's allowance used: one pass per change, not one per check; a new ready card is a change", async () => {
  const { w, actions, cards, merge } = flow();
  const blocked = card({ number: 301, status: 'blocked' });
  w.tracker.cards.push(blocked);
  ledger(w, blocked, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked' });
  seed(w, AT('14:50'), { starts: morningLeft('2026-11-10', ['801'], ['502']) });
  // Day 5 of the week window: 50% allowed by now, 60% used.
  const { check, calls, passes } = checker(w, { cards, week: 60 });
  merge(AT('15:00'));
  const out = await check(AT('15:05'));
  assert.equal(passes().length, 1);
  assert.deepEqual(calls.sessions, [], "the allowance holds the start");
  assert.match(oneLine(out), /start pass \(a slot freed: 801 no longer open\): started nothing \(estimate 4% \+ 0% to finish the tickets in work > 0% left today\)/);
  for (const at of [AT('15:10'), AT('15:15'), AT('15:20'), AT('15:25')]) {
    actions[BOARD].push(act(blocked, at - MIN));
    await check(at);
  }
  assert.equal(passes().length, 1, 'the same state: no other pass');
  assert.equal(calls.usage, 1);

  // The owner adds a card to the ready list: one more pass.
  const owner = card({ number: 503, status: 'ready', labels: ['Guide'] });
  w.tracker.cards.push(owner);
  cards[503] = owner;
  actions[BOARD].push(act(owner, AT('15:28'), { type: 'createCard' }));
  const again = await check(AT('15:30'));
  assert.equal(passes().length, 2);
  assert.match(again.startPass.why, /newly ready: 503/);
  await check(AT('15:35'));
  assert.equal(passes().length, 2);
});

test('AC-3: a slot that is not free (the open ticket waits for a reviewer or the owner) starts nothing and reads no /usage', async () => {
  for (const status of ['smeReview', 'finalReview']) {
    const { w, actions, cards } = flow();
    cards[801].placeId = LISTS[status].id;
    seed(w, AT('14:50'));
    const { check, calls, passes } = checker(w, { cards });
    actions[BOARD].push(act(cards[801], AT('14:58')));
    const out = await check(AT('15:00'));
    assert.deepEqual([out.startPass.why, out.startPass.ran, out.startPass.skipped], ['no start pass yet', false, '1 open (801) of 1'], status);
    assert.deepEqual([passes().length, calls.sessions.length, calls.usage], [0, 0, 0], status);
    actions[BOARD].push(act(cards[801], AT('15:03')));
    assert.equal((await check(AT('15:05'))).startPass, undefined, `${status}: looked at once`);
  }
});

test('an intake card that arrives at 15:00 is triaged when its quiet hours end, with no event then', async () => {
  const { w, actions, cards } = flow({ ready: false });
  seed(w, AT('14:50'), { starts: morningLeft('2026-11-10', ['801'], []) });
  w.forge.prs.find((p) => p.number === 801).state = 'merged'; // no slot is taken: the triage runs whatever the slots
  const intake = card({ number: 601, status: 'intake', labels: ['Guide'], lastActivity: iso(AT('15:00')) });
  w.tracker.cards.push(intake);
  const { check, passes } = checker(w, { cards });
  actions[BOARD].push(act(intake, AT('15:00'), { type: 'createCard' }));
  await check(AT('15:05'));
  assert.equal(readFeed(w.settings.state).starts.nextDueAt, iso(AT('17:00')), 'quiet for 2 hours');
  await check(AT('16:55'));
  assert.equal(passes().length, 0);
  const out = await check(AT('17:00'));
  assert.equal(passes().length, 1);
  assert.equal(out.startPass.why, 'due for triage: 601');
});

test("no start pass before today's morning run: a check that began at 09:55 and whose own run ended at 10:05 leaves the starts to the 10:10 morning run", async () => {
  const { w, cards, merge } = flow({ extra: { schedule: { morning: '10:10' } } });
  seed(w, AT('09:45'), { morning: '2026-11-09', starts: morningLeft('2026-11-09', ['801'], ['502']) });
  const { check, calls, passes } = checker(w, { cards, finishTakes: 10 * MIN });
  merge(AT('09:50'));
  const out = await check(AT('09:55'));
  assert.deepEqual(calls.runs.map((r) => r.named), [['801']], "the watcher's own run follows the merged ticket");
  assert.deepEqual([out.startPass, passes().length, calls.usage], [undefined, 0, 0]);
  await check(AT('10:05'));
  assert.equal(passes().length, 0, 'inside the hours, but the morning run has not run today');
  await check(AT('10:10'));
  assert.deepEqual(calls.runs.filter((r) => r.morning).length, 1, 'the morning run makes the day\'s first starts');
  assert.equal(passes().length, 0);
  // A host whose start hours begin before the morning run: the same.
  const early = flow({ extra: { schedule: { morning: '10:10' } }, limits: { startHours: '08-22' } });
  seed(early.w, AT('08:55'), { morning: '2026-11-09' });
  const e = checker(early.w, { cards: early.cards });
  early.merge(AT('09:00'));
  await e.check(AT('09:05'));
  assert.equal(e.passes().length, 0);
});

test('a start pass that fails before its first step is tried again after 30 minutes, not at every check', async () => {
  const { w, actions, cards, merge } = flow();
  seed(w, AT('14:50'), { starts: morningLeft('2026-11-10', ['801'], ['502']) });
  const { check, calls, passes } = checker(w, { cards, passThrows: 1 });
  merge(AT('15:00'));
  const first = await check(AT('15:05'));
  assert.deepEqual(first.errors, [{ part: 'the start pass', error: 'the runner crashed before its first step' }]);
  const memory = readFeed(w.settings.state).starts;
  assert.deepEqual([memory.retryAt, memory.deferred], [iso(AT('15:35')), 'a slot freed: 801 no longer open']);
  for (const at of [AT('15:10'), AT('15:20'), AT('15:30')]) {
    actions[BOARD].push(act(cards[801], at - MIN));
    await check(at);
  }
  assert.equal(passes().length, 1, 'not again before 15:35');
  const again = await check(AT('15:35'));
  assert.equal(passes().length, 2);
  assert.equal(again.startPass.why, 'a slot freed: 801 no longer open');
  assert.equal(calls.sessions[0], 'start 502 schedule');
  assert.equal(readFeed(w.settings.state).starts.retryAt, null);
});

test('a watcher pass triages only the intake cards newly due; one whose triage failed waits for the morning run or a person', async () => {
  const { w, actions, cards } = flow({ ready: false });
  seed(w, AT('14:50'), { starts: morningLeft('2026-11-10', ['801'], [], ['600']) });
  w.forge.prs.find((p) => p.number === 801).state = 'merged';
  // 600 was due at the morning run already (its triage failed there); 601 becomes due at 17:00.
  const old = card({ number: 600, status: 'intake', labels: ['Guide'], lastActivity: iso(AT('06:00')) });
  const intake = card({ number: 601, status: 'intake', labels: ['Guide'], lastActivity: iso(AT('15:00')) });
  w.tracker.cards.push(old, intake);
  const { check, calls, passes } = checker(w, { cards });
  actions[BOARD].push(act(intake, AT('15:00'), { type: 'createCard' }));
  await check(AT('15:05'));
  assert.equal(passes().length, 0, '600 is not new; 601 is not due yet; no ready ticket');
  await check(AT('17:00'));
  assert.deepEqual(passes().map((r) => r.triageKeys), [['601']]);
  const triages = () => calls.sessions.filter((s) => s.startsWith('triage')).length;
  const tried = triages();
  assert.ok(tried >= 1, 'the triage session ran (and failed, the stand-in fails it)');
  // A new ready card later: a pass, with nothing to triage; the failed 601 waits.
  const owner = card({ number: 503, status: 'ready', labels: ['Guide'] });
  w.tracker.cards.push(owner);
  cards[503] = owner;
  actions[BOARD].push(act(owner, AT('17:20'), { type: 'createCard' }));
  await check(AT('17:25'));
  assert.deepEqual(passes().map((r) => r.triageKeys), [['601'], []]);
  assert.equal(triages(), tried, 'no second triage of 601 on a change');
});

test('the first check after an update, with no memory and the morning run done: a pass; a dry run plans the start and writes no memory', async () => {
  const { w, cards, merge } = flow();
  merge(AT('14:00'));
  seed(w, AT('14:50'));
  const { check, calls } = checker(w, { cards });
  const dry = await check(AT('15:00'), { dryRun: true });
  assert.equal(dry.startPass.why, 'no start pass yet');
  assert.match(oneLine(dry), /start pass \(no start pass yet\): would start 502/);
  assert.deepEqual([calls.sessions, readFeed(w.settings.state).starts], [[], undefined]);
});

test('the start hours: local time, the end not included; a bad value is refused', () => {
  assert.deepEqual([AT('09:59'), AT('10:00'), AT('21:59'), AT('22:00'), AT('23:30')].map((t) => inStartHours(t, '10-22')), [false, true, true, false, false]);
  assert.deepEqual([AT('09:29'), AT('09:30'), AT('20:59'), AT('21:00')].map((t) => inStartHours(t, '09:30-21:00')), [false, true, true, false]);
  assert.deepEqual(parseStartHours('0-24'), { from: 0, to: 1440 });
  for (const bad of ['22-10', '10', '10-25', 'ten to ten', 10]) assert.equal(parseStartHours(bad), null, String(bad));
  assert.throws(() => settingsFor(tmp(), { limits: { startHours: '22-10' } }), /limits\.startHours must be local hours/);
  assert.equal(settingsFor(tmp()).limits.startHours, '10-22');
});

test('the change rule and the counts that leave no room', () => {
  const p = (open, ready, intakeDue = [], date = '2026-11-10') => startPrint({ date, openKeys: open, ready, intakeDue });
  assert.equal(changeOf(null, p([], [])), 'no start pass yet');
  assert.equal(changeOf(p(['1'], ['2']), p(['1'], ['2'], [], '2026-11-11')), 'a new day');
  assert.equal(changeOf(p(['1'], ['2']), p(['1'], ['2'])), null);
  assert.equal(changeOf(p(['1'], ['2']), p([], ['2'])), 'a slot freed: 1 no longer open');
  assert.equal(changeOf(p(['1'], ['2']), p(['1'], ['2', '3'], ['4'])), 'newly ready: 3; due for triage: 4');
  // What can't make room or a triage counts for nothing: the open tickets growing, a ready group gone, a card back
  // in its quiet hours.
  assert.equal(changeOf(p(['1'], ['2']), p(['1', '2'], [])), null);
  assert.equal(changeOf(p(['1'], ['2', '3']), p(['1'], ['3'])), null);
  assert.equal(changeOf(p(['1'], ['2'], ['4']), p(['1'], ['2'], [])), null);
  assert.equal(changeOf(p(['1', '5'], ['2'], ['4']), p(['1', '6'], ['2'], ['4', '7'])), 'a slot freed: 5 no longer open; due for triage: 7');
  const wip = (o) => ({ inProgress: 0, waiting: 0, open: 0, openKeys: [], limits: { inProgress: 3, waiting: 5, open: null }, ...o });
  assert.equal(noRoomOf(wip({})), null);
  assert.equal(noRoomOf(wip({ open: 1, openKeys: ['7'], limits: { inProgress: 3, waiting: 5, open: 1 } })), '1 open (7) of 1');
  assert.equal(noRoomOf(wip({ inProgress: 3 })), '3 in progress of 3');
  assert.equal(noRoomOf(wip({ waiting: 5 })), '5 waiting of 5');
});

test('notifications: a started ticket is told once, not urgent; a planned one is not', () => {
  const run = { starts: [{ group: '502', steps: [{ stage: 'start', keys: ['502'], outcome: 'done' }] }, { group: '503', steps: [{ stage: 'start', keys: ['503'], outcome: 'failed' }] }], ran: [], guard: [] };
  const notes = notificationsOf({ startPass: { why: 'a slot freed: 801 no longer open', ran: true, run }, today: '2026-11-10' });
  assert.deepEqual(notes.map((x) => [x.key, x.urgent, x.title]), [['started:2026-11-10:502', false, 'Ticket flow: a ticket started']]);
  assert.deepEqual(notificationsOf({ startPass: { why: 'x', ran: true, run: { starts: [{ stage: 'start', group: '502', keys: ['502'] }] } }, today: '2026-11-10' }), []);
});
