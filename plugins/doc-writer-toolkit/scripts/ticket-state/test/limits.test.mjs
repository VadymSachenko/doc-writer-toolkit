import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, host, pr, rawSettings, settingsFor, tmp } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { parseUsage, allowanceOf, parseReset } from '../lib/allowance.mjs';
import { loadSettings, validateSettings } from '../lib/settings.mjs';
import { estimatesOf, pageKey, pageRef, related, remainingOf, samePage, workPages } from '../lib/limits.mjs';
import { takeLock } from '../lib/locks.mjs';
import { renderReport } from '../lib/report.mjs';
import { digestRun, renderProgress } from '../lib/progress.mjs';
import { notificationsOf } from '../lib/notify.mjs';

// AC-2 (the limits), D-067 (the allowance and the estimates), D-071 (priority), AC-5 (the intake), and the settings.

// Day 4 of the week window (it reset on Nov 7 at 6am UTC; NOW is Nov 10, 9am UTC): 40% allowed by now.
const usage = (used) => parseUsage(`Current session: 12% used · resets 2pm (UTC)\nCurrent week (all models): ${used}% used · resets Nov 14 at 6am (UTC)\n`);
const estimates = { limits: { estimates: { edit: 4, newPage: 8, newSection: 20 } } };

const inProgress = (w, n, { startedBy = 'schedule', mode = 'pipeline', from = 0 } = {}) => {
  for (let i = 0; i < n; i++) {
    const c = card({ number: 300 + from + i, status: 'inProgress' });
    w.tracker.cards.push(c);
    ledger(w, c, { stages: { triage: 'done', start: 'done' }, startedBy, mode, triage: { verdict: 'docs', targets: ['guide'], size: 'edit' } });
  }
};
const waiting = (w, n) => {
  for (let i = 0; i < n; i++) {
    const c = card({ number: 400 + i, status: 'blocked' });
    w.tracker.cards.push(c);
    ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, startedBy: 'schedule', triage: { verdict: 'docs', targets: ['guide'], size: 'edit' } });
  }
};
const ready = (w, number, { labels = [], createdAt = ago(72), size = 'edit', relations = [], together = [], targets = ['guide'], pages = [] } = {}) => {
  const c = card({ number, status: 'ready', labels, createdAt });
  w.tracker.cards.push(c);
  ledger(w, c, { stages: { triage: 'done' }, priority: null, triage: { verdict: 'docs', targets, size, relations, together, pages } });
  return c;
};
// A ticket in SME review: its PR open, counted as neither in progress nor waiting.
const inReview = (w, number, { startedBy = 'schedule', mode = 'pipeline' } = {}) => {
  const c = card({ number, status: 'smeReview' });
  w.tracker.cards.push(c);
  w.forge.prs.push(pr({ repo: 'guide-docs', number, labels: ['in expert review'] }));
  ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, startedBy, mode, prs: [{ repo: 'guide-docs', number, targets: ['guide'], review: 'sme', stage: 'smeReview' }], triage: { verdict: 'docs', targets: ['guide'], size: 'edit' } });
};

test('AC-2: three tickets in progress start nothing; the reason says why', async () => {
  const w = world({ extra: estimates });
  inProgress(w, 3);
  ready(w, 501);
  const st = await w.status({ usage: usage(5) });
  assert.equal(st.wip.inProgress, 3);
  assert.deepEqual(st.startable, []);
  assert.deepEqual(st.notStarted.map((g) => g.group), ['501']);
  assert.ok(st.notStarted[0].reasons.includes('3 in progress + 1 > 3'), st.notStarted[0].reasons.join('; '));
});

test('AC-2: five tickets waiting start nothing', async () => {
  const w = world({ extra: estimates });
  waiting(w, 5);
  ready(w, 501);
  const st = await w.status({ usage: usage(5) });
  assert.equal(st.wip.waiting, 5);
  assert.equal(st.wip.inProgress, 0);
  assert.deepEqual(st.startable, []);
  assert.ok(st.notStarted[0].reasons.includes('5 waiting (limit 5)'));
});

test('AC-2: manual starts and tickets in the owner hands are not counted; a free slot starts the ready group', async () => {
  const w = world({ extra: estimates });
  inProgress(w, 3, { startedBy: 'manual' });
  inProgress(w, 2, { mode: 'hand', from: 10 });
  waiting(w, 4);
  ready(w, 501);
  const st = await w.status({ usage: usage(5) });
  assert.equal(st.wip.inProgress, 0);
  assert.equal(st.wip.manual, 3);
  assert.equal(st.wip.waiting, 4);
  assert.deepEqual(st.startable.map((g) => g.group), ['501']);
  assert.ok(st.tickets.filter((t) => t.startedBy === 'manual').every((t) => t.counts === 'inProgress' && !t.counted));
});

test('AC-2: a group larger than the ceiling starts only when nothing is in progress', async () => {
  const w = world({ extra: estimates });
  for (const n of [601, 602, 603, 604]) ready(w, n, { together: [String(n === 601 ? 602 : n - 1)] });
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable.map((g) => [g.group, g.size]), [['601-602-603-604', 4]]);
  inProgress(w, 1);
  st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable, []);
  assert.ok(st.notStarted[0].reasons.includes('1 in progress + 4 > 3'));
});

test('D-067: the estimate plus what the tickets in work still need must fit what is left today', async () => {
  const w = world({ extra: estimates });
  inProgress(w, 2); // two edits in work: 4% each still to spend
  ready(w, 501, { size: 'newSection' }); // 20%
  ready(w, 502, { size: 'edit', createdAt: ago(10) }); // 4%
  const st = await w.status({ usage: usage(15) }); // 40% allowed by day 4, 15 used: 25 left
  assert.deepEqual(st.allowance, { remaining: 25, cap: 40, used: 15, day: 4, inWork: 8, inWorkUnknown: [] });
  const blocked = st.notStarted.find((g) => g.group === '501');
  assert.match(blocked.reasons.join(), /estimate 20% \+ 8% to finish the tickets in work > 25% left today/);
  assert.deepEqual(st.startable.map((g) => [g.group, g.estimate]), [['502', 4]], 'within a level, a younger group that fits starts; a lower level would wait');
  // No usage reading: nothing starts.
  const none = await w.status();
  assert.ok(none.notStarted.every((g) => g.reasons.some((r) => /allowance is unknown/.test(r))));
});

test('D-067: no estimate for a size yet means one ticket at a time; measured costs replace the owner figure', async () => {
  const w = world();
  ready(w, 501);
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable.map((g) => g.group), ['501'], 'nothing in work: the one ticket starts');
  inProgress(w, 1);
  st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable, []);
  assert.match(st.notStarted[0].reasons.join(), /no cost estimate for size edit yet: one ticket at a time/);

  const done = { triage: { size: 'edit' }, stages: { close: { status: 'done' } }, prs: [], runs: [{ weekPercent: { before: 10, after: 13 } }, { weekPercent: { before: 13, after: 15 }, share: 0.5 }] };
  const est = estimatesOf([done, { ...done, runs: [{ weekPercent: { before: 1, after: 6 } }] }], { estimates: { edit: 9, newPage: 8 } });
  assert.deepEqual(est.edit, { percent: 4.5, source: 'measured', tickets: 2 });
  assert.deepEqual(est.newPage, { percent: 8, source: 'settings', tickets: 0 });
  assert.equal(est.newSection, null);
  assert.equal(remainingOf({ triage: { size: 'newPage' }, runs: [{ weekPercent: { before: 0, after: 7.5 } }] }, est), 1.6, 'never below a fifth of the estimate');
});

test('limits.usageGuard off: no estimate holds a start, and the report, the progress file and the morning note say the guard is off', async () => {
  const w = world({ extra: { limits: { usageGuard: false, estimates: { edit: 60 } } } });
  inProgress(w, 1);
  ready(w, 501);
  ready(w, 502, { size: 'newSection' });
  const st = await w.status({ usage: null });
  assert.deepEqual(st.startable.map((g) => g.group), ['501', '502'], 'neither an estimate above what is left nor no estimate at all holds a start');
  assert.equal(st.allowance.unlimited, true);
  assert.match(renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }), /Usage guard off \(`limits\.usageGuard`\)/);
  assert.match(renderProgress({ ledgers: [], now: NOW, mode: 'on', run: digestRun({ out: {}, st, now: NOW }) }), /Usage guard off/);
  const morning = notificationsOf({ morning: { mode: 'on', ran: [], starts: [], after: { allowance: st.allowance } }, today: '2026-11-10' });
  assert.match(morning[0].text, /usage guard off/);
});

test('D-071: high first, then the oldest within a level; a lower level waits while a higher one is held back', async () => {
  const w = world({ extra: estimates });
  ready(w, 701, { createdAt: ago(200) }); // medium, oldest
  ready(w, 702, { labels: ['high'], createdAt: ago(10) });
  ready(w, 703, { labels: ['low'], createdAt: ago(300) });
  ready(w, 704, { createdAt: ago(100) }); // medium
  ready(w, 705, { labels: ['high', 'low'], createdAt: ago(5) }); // both labels: high
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.groups.map((g) => [g.group, g.priority]), [['702', 'high'], ['705', 'high'], ['701', 'medium'], ['704', 'medium'], ['703', 'low']]);
  assert.deepEqual(st.startable.map((g) => g.group), ['702', '705', '701'], 'three slots: both highs, then the oldest medium');
  assert.match(st.notStarted.find((g) => g.group === '704').reasons.join(), /3 in progress \+ 1 > 3/);
  assert.match(st.notStarted.find((g) => g.group === '703').reasons.join(), /waits behind a medium priority group/);
  // A high group too big for today's allowance holds back every medium one.
  const w2 = world({ extra: estimates });
  ready(w2, 801, { labels: ['high'], size: 'newSection' });
  ready(w2, 802, { size: 'edit', createdAt: ago(500) });
  st = await w2.status({ usage: usage(30) }); // 10% left
  assert.deepEqual(st.startable, []);
  assert.match(st.notStarted.find((g) => g.group === '802').reasons.join(), /waits behind a high priority group/);
  // The ticket list is in priority order too.
  assert.deepEqual(st.tickets.map((t) => [t.key, t.priority]), [['801', 'high'], ['802', 'medium']]);
});

test('open: tickets a schedule started and not merged count, review included; manual and hand ones do not', async () => {
  const w = world({ extra: { limits: { ...estimates.limits, open: 2 } } });
  inProgress(w, 1);
  inReview(w, 801);
  inReview(w, 802, { startedBy: 'manual' });
  inReview(w, 803, { mode: 'hand' });
  ready(w, 501);
  let st = await w.status({ usage: usage(5) });
  assert.equal(st.wip.inProgress, 1, 'the review is not in progress');
  assert.equal(st.wip.open, 2);
  assert.equal(st.wip.limits.open, 2);
  assert.deepEqual(st.startable, []);
  assert.ok(st.notStarted[0].reasons.includes('2 open (300, 801) + 1 > 2'), st.notStarted[0].reasons.join('; '));
  // The review's PR merged: one open, the ready ticket starts.
  w.forge.prs.find((p) => p.number === 801).state = 'merged';
  st = await w.status({ usage: usage(5) });
  assert.equal(st.wip.open, 1);
  assert.deepEqual(st.startable.map((g) => g.group), ['501']);
});

test('open: no limit by default; a group larger than the limit starts only when none is open', async () => {
  let w = world({ extra: estimates });
  inReview(w, 801);
  inReview(w, 802);
  ready(w, 501);
  let st = await w.status({ usage: usage(5) });
  assert.equal(st.wip.limits.open, null);
  assert.deepEqual(st.startable.map((g) => g.group), ['501']);
  w = world({ extra: { limits: { ...estimates.limits, open: 1, inProgress: 5 } } });
  ready(w, 601, { together: ['602'] });
  ready(w, 602);
  st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable.map((g) => [g.group, g.size]), [['601-602', 2]]);
  inReview(w, 801);
  st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable, []);
  assert.ok(st.notStarted[0].reasons.includes('1 open (801) + 2 > 1'), st.notStarted[0].reasons.join('; '));
});

test('open: two starts in one run fill the limit, the third waits', async () => {
  const w = world({ extra: { limits: { ...estimates.limits, open: 2, inProgress: 5 } } });
  ready(w, 501, { createdAt: ago(90) });
  ready(w, 502, { createdAt: ago(80) });
  ready(w, 503, { createdAt: ago(70) });
  const st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable.map((g) => g.group), ['501', '502']);
  assert.deepEqual(st.notStarted.map((g) => g.group), ['503']);
  assert.ok(st.notStarted[0].reasons.includes('2 open (501 starting now, 502 starting now) + 1 > 2'), st.notStarted[0].reasons.join('; '));
});

test('startOrder easiest: the smallest size first, then fewer repos, then fewer pages, then priority; priority order unchanged', async () => {
  const make = (startOrder) => {
    const w = world({ extra: { limits: { ...estimates.limits, estimates: { edit: 4, newPage: 8, newSection: 20 }, inProgress: 5, startOrder } } });
    ready(w, 501, { labels: ['high'], size: 'newSection', createdAt: ago(90) });
    ready(w, 502, { labels: ['low'], size: 'edit', targets: ['guide', 'api'], createdAt: ago(80) });
    ready(w, 503, { size: 'edit', pages: [{ repo: 'guide-docs', path: 'docs/a.md' }, { repo: 'guide-docs', path: 'docs/b.md' }], createdAt: ago(70) });
    ready(w, 504, { size: 'edit', pages: [{ repo: 'guide-docs', path: 'docs/c.md' }], createdAt: ago(60) });
    ready(w, 505, { size: 'newPage', createdAt: ago(50) });
    ready(w, 506, { labels: ['high'], size: null, createdAt: ago(40) });
    return w;
  };
  let st = await make('easiest').status({ usage: usage(5) });
  assert.deepEqual(st.groups.map((g) => g.group), ['504', '503', '502', '505', '501', '506']);
  assert.deepEqual(st.startable.map((g) => [g.group, g.sizeRank, g.repoCount, g.pageCount]), [['504', 0, 1, 1], ['503', 0, 1, 2], ['502', 0, 2, 0], ['505', 1, 1, 0]]);
  // The new section no longer fits today's allowance; the ticket with no size yet (the hardest) waits behind it.
  assert.deepEqual(st.notStarted.map((g) => g.group), ['501', '506']);
  assert.ok(st.notStarted[1].reasons.includes('waits behind the easier group 501'), st.notStarted[1].reasons.join('; '));
  st = await make('priority').status({ usage: usage(5) });
  assert.deepEqual(st.groups.map((g) => g.group), ['501', '506', '503', '504', '505', '502']);
  assert.equal(st.startable[0].sizeRank, undefined, 'priority order adds no difficulty fields');
});

test('open: a ticket outside the flow (a PR closed unmerged, the card archived) or paused holds no slot; the report names the open ones', async () => {
  const w = world({ extra: { limits: { ...estimates.limits, open: 2, inProgress: 5 } } });
  inReview(w, 801);
  inReview(w, 802);
  w.forge.prs.find((p) => p.number === 802).state = 'closed';
  inReview(w, 803);
  w.tracker.cards.find((c) => c.number === 803).closed = true;
  inReview(w, 804);
  w.tracker.cards.find((c) => c.number === 804).placeId = LISTS.ready.id; // a person moved it back to the ready status
  ready(w, 501);
  let st = await w.status({ usage: usage(5) });
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, t.state]));
  assert.deepEqual([by['801'], by['802'], by['803'], by['804']], ['smeReview', 'outside', 'outside', 'paused']);
  assert.deepEqual([st.wip.open, st.wip.openKeys], [1, ['801']]);
  assert.deepEqual(st.startable.map((g) => g.group), ['501'], 'one slot is free: neither the closed PR, the archived card nor the pause holds it');
  assert.match(renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }), /In progress 0 of 5, waiting 0 of 5, open 1 of 2 \(801\)\./);
  // At the limit, the reason names the tickets that hold the slots.
  w.settings.limits.open = 1;
  st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((g) => [g.group, g.reasons]), [['501', ['1 open (801) + 1 > 1']]]);
  // Moving the card of the closed PR to done frees nothing more, and needs to free nothing.
  w.tracker.cards.find((c) => c.number === 802).placeId = LISTS.done.id;
  assert.deepEqual((await w.status({ usage: usage(5) })).wip.openKeys, ['801']);
});

test('open: a locked ticket counts as what it is doing', async () => {
  const w = world({ extra: { limits: { ...estimates.limits, open: 2, inProgress: 5 } } });
  inReview(w, 801);
  const c = card({ number: 802, status: 'done' });
  w.tracker.cards.push(c);
  w.forge.prs.push(pr({ repo: 'guide-docs', number: 802, state: 'merged' }));
  ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done', close: 'done' }, startedBy: 'schedule', prs: [{ repo: 'guide-docs', number: 802, targets: ['guide'], review: 'sme', stage: 'merged', merged: { at: ago(1) } }] });
  for (const g of ['801', '802']) takeLock(w.settings.state, { group: g, kind: 'manual', stage: 'close', leaseMinutes: 120, now: NOW });
  const st = await w.status({ usage: usage(5) });
  const by = Object.fromEntries(st.tickets.map((t) => [t.key, [t.state, t.derivedState]]));
  assert.deepEqual([by['801'], by['802']], [['locked', 'smeReview'], ['locked', 'closed']]);
  assert.deepEqual([st.wip.open, st.wip.openKeys], [1, ['801']], 'the review is open while a run holds it; the closed ticket is not');
});

test('startOrder easiest: a group held back only by its lock or a relation holds back no harder group', async () => {
  const limits = { ...estimates.limits, inProgress: 5, startOrder: 'easiest' };
  const w = world({ extra: { limits } });
  // Two related edits: their group's lock (a manual run on it) holds the group, not each ticket.
  ready(w, 501, { size: 'edit', together: ['502'] });
  ready(w, 502, { size: 'edit' });
  ready(w, 503, { size: 'newPage' });
  takeLock(w.settings.state, { group: '501-502', kind: 'manual', stage: 'start', leaseMinutes: 120, now: NOW });
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((g) => [g.group, g.reasons]), [['501-502', ['locked by a run']]]);
  assert.deepEqual(st.startable.map((g) => g.group), ['503']);
  const w2 = world({ extra: { limits } });
  inProgress(w2, 1);
  ready(w2, 503, { size: 'edit', relations: ['300'] });
  ready(w2, 504, { size: 'newPage' });
  st = await w2.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((g) => [g.group, g.reasons]), [['503', ['related to 300, still in work']]]);
  assert.deepEqual(st.startable.map((g) => g.group), ['504']);
});

test('a ready group whose start failed: it waits, holding no slot, until the next morning run; held after two failed sessions; a group the run tried holds no slot', async () => {
  const at = ago(2);
  const w = world({ extra: { limits: { ...estimates.limits, open: 1, startOrder: 'easiest' } } });
  const a = ready(w, 501, { size: 'edit' });
  ready(w, 502, { size: 'newPage' });
  // 501's start session failed and left the card in the ready status: the runner had recorded the start running.
  const failedStart = (failures) => ledger(w, a, { stages: { triage: 'done', start: { status: 'failed', note: 'the session ended without recording the stage' } }, startedBy: 'schedule', priority: null, triage: { verdict: 'docs', targets: ['guide'], size: 'edit' }, runs: [{ seq: 9, stage: 'start', role: 'writer', outcome: 'failed', failures, start: at, after: { at, list: LISTS.ready.id, comments: [], prs: {} } }] });
  failedStart(1);
  let st = await w.status({ usage: usage(5) });
  const t = st.tickets.find((x) => x.key === '501');
  assert.deepEqual([t.state, t.counted, t.failed.sessions, t.held ?? false], ['ready', false, 1, false]);
  assert.deepEqual([st.wip.open, st.startable.map((g) => g.group)], [0, ['502']], 'the waiting start takes no slot: the next group starts');
  assert.deepEqual(st.notStarted.map((g) => [g.group, g.reasons]), [['501', [`its start failed at ${at} (501): waits for a person acting on the ticket, or the next morning run`]]]);
  // The morning run gives it its one more try, with its failed session so far.
  st = await w.status({ usage: usage(5), retryWaiting: true });
  assert.deepEqual(st.startable.map((g) => [g.group, g.prior]), [['501', 1]]);
  assert.deepEqual(st.notStarted.map((g) => [g.group, g.reasons]), [['502', ['1 open (501 starting now) + 1 > 1']]]);
  // Once the run tried it, it holds no slot in the run's later calculations.
  st = await w.status({ usage: usage(5), retryWaiting: true, tried: new Set(['501']) });
  assert.deepEqual(st.startable.map((g) => g.group), ['502']);
  assert.match(st.notStarted[0].reasons[0], /^tried in this run already/);
  // Two failed sessions: held for the owner, in the report's waiting list; not even the morning run tries it.
  failedStart(2);
  st = await w.status({ usage: usage(5), retryWaiting: true });
  const held = st.tickets.find((x) => x.key === '501');
  assert.deepEqual([held.held, held.gate.who, held.next], [true, 'owner', null]);
  assert.match(st.notStarted.find((g) => g.group === '501').reasons[0], /^held for the owner: 501: start failed in 2 sessions .*`ticket-state set retry 501`/);
  assert.deepEqual(st.startable.map((g) => g.group), ['502']);
  assert.match(renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }), /## Waiting for you\n\n- \[501\]\S+ #501 - Change 501: ready, start failed in 2 sessions/);
  // `set retry 501` re-arms it: it may start again, its count of failures begun anew.
  fs.writeFileSync(path.join(w.settings.state, 'rearmed.json'), JSON.stringify({ all: null, tickets: { 501: new Date(NOW - 60000).toISOString() } }));
  st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.startable.map((g) => [g.group, g.prior ?? 0]), [['501', 0]]);
});

test('startOrder easiest: an easier group held back by the limits holds back every harder one, whatever its priority', async () => {
  const w = world({ extra: { limits: { ...estimates.limits, inProgress: 5, startOrder: 'easiest' } } });
  ready(w, 501, { labels: ['high'], size: 'edit' });
  ready(w, 502, { labels: ['low'], size: 'newPage' });
  // 2% of the week left today: the edit (4%) does not fit; the new page waits behind it, as the easier group only.
  const st = await w.status({ usage: usage(38) });
  assert.deepEqual(st.startable, []);
  assert.deepEqual(st.notStarted.map((g) => g.group), ['501', '502']);
  assert.ok(st.notStarted[1].reasons.includes('waits behind the easier group 501'), st.notStarted[1].reasons.join('; '));
  assert.ok(!st.notStarted[1].reasons.some((r) => /priority group/.test(r)));
});

test('D-067: the allowance reading', () => {
  const u = usage(22);
  assert.deepEqual(u.week, { percent: 22, resets: 'Nov 14 at 6am (UTC)' });
  const a = allowanceOf(u, { dailyPercent: 10, maxWeekPercent: 30 }, new Date(NOW));
  assert.deepEqual(a, { day: 4, allowance: 40, cap: 30, used: 22, remaining: 8, resets: 'Nov 14 at 6am (UTC)', session: { percent: 12, resets: '2pm (UTC)' } });
  assert.equal(allowanceOf(parseUsage('no bars'), { dailyPercent: 10 }, new Date(NOW)), null);
  assert.equal(parseReset('Nov 14 at 6am (UTC)', new Date(NOW)), Date.parse('2026-11-14T06:00:00Z'));
});

test('AC-5: the intake skips a card changed less than 2 hours ago, never reads the drafts list, and takes high first', async () => {
  const cards = [
    card({ number: 901, status: 'intake', lastActivity: ago(1), labels: ['Guide'] }),
    card({ number: 902, status: 'intake', lastActivity: ago(3), labels: ['Guide'], createdAt: ago(100) }),
    card({ number: 903, status: 'intake', lastActivity: ago(5), labels: ['Api', 'high'], createdAt: ago(20) }),
    card({ number: 904, status: 'drafts', lastActivity: ago(50) }),
  ];
  const w = world({ cards });
  const st = await w.status();
  assert.deepEqual(st.intake.due.map((c) => c.key), ['903', '902']);
  assert.deepEqual(st.intake.waiting.map((c) => [c.key, c.quietAt]), [['901', new Date(NOW + 3600000).toISOString()]]);
  assert.ok(!w.tracker.reads.some(([, place]) => place === LISTS.drafts.id), 'the drafts list was never read');
  assert.ok(!st.tickets.some((t) => t.key === '904'));
});

test('AC-5: a card with no app label gets the text check; it settles the target when the text names one', async () => {
  const cards = [
    card({ number: 911, status: 'intake', desc: 'The refunds page in the Portal UI needs the new button.', lastActivity: ago(4) }),
    card({ number: 912, status: 'intake', desc: 'See docs/payments/refunds for the old text.', lastActivity: ago(4) }),
    card({ number: 913, status: 'intake', desc: 'Something changed somewhere.', labels: ['Docs'], lastActivity: ago(4) }),
  ];
  const git = { branchCommits: () => [], changedUnder: () => [], pagesOf: (t) => (t.id === 'guide' ? ['payments/refunds', 'payments/index'] : []) };
  const w = world({ cards, git });
  const st = await w.status();
  const by = Object.fromEntries(st.intake.due.map((c) => [c.key, c]));
  assert.deepEqual([by['911'].check, by['911'].targets, by['911'].settled], ['text', ['portal-ui'], true]);
  assert.deepEqual([by['912'].targets, by['912'].evidence[0].by], [['guide'], 'page']);
  assert.deepEqual([by['913'].settled, by['913'].docLabels], [false, ['Docs']], 'only this one may get needs-info');
});

test('settings: the local file deep-merges over the shared one; the defaults fill the rest', async () => {
  const root = host({ shared: { limits: { inProgress: 2, estimates: { edit: 3 } }, roles: { writer: { model: 'claude-opus-5-5', effort: 'high' } } }, local: { mode: 'observe', limits: { waiting: 4 }, roles: { writer: { effort: 'max' } }, cleanup: { mode: 'delete' } } });
  const s = await loadSettings({ root });
  assert.equal(s.mode, 'observe');
  assert.deepEqual([s.limits.inProgress, s.limits.waiting, s.limits.parallel, s.limits.estimates], [2, 4, 3, { edit: 3 }]);
  assert.deepEqual([s.roles.writer.model, s.roles.writer.effort, s.roles.writer.maxTurns], ['claude-opus-5-5', 'max', 200]);
  assert.equal(s.roles.triage.model.length > 0, true);
  assert.deepEqual(s.cleanup, { mode: 'delete', keep: ['**/sme-interview.md', '**/app-notes.md'], trashDir: null });
  assert.equal(s.state, path.join(root, '.flow'));
  assert.ok(s.localFile.endsWith('ticket-flow.local.json'));
});

test('settings: bad values stop with the key named', () => {
  const root = tmp();
  const bad = (extra, re) => assert.throws(() => validateSettings(rawSettings(extra), { root, stateRootDefault: '.x/' }), re);
  bad({ mode: 'sometimes' }, /mode must be one of off, observe, on/);
  bad({ limits: { inProgress: 0 } }, /limits.inProgress/);
  bad({ limits: { estimates: { huge: 3 } } }, /limits.estimates.huge is not a size/);
  bad({ cleanup: { mode: 'shred' } }, /cleanup.mode/);
  bad({ cleanup: { keep: 'all' } }, /cleanup.keep/);
  bad({ roles: { writer: { model: '' } } }, /roles.writer.model/);
  bad({ limits: { open: 0 } }, /limits.open/);
  bad({ limits: { startOrder: 'random' } }, /limits.startOrder must be one of priority, easiest/);
  for (const workFolder of ['work/tickets', '/abs/<key>', '../out/<key>', 'work/../../<key>', 7]) bad({ workFolder }, /workFolder must be a path from the host root/);
  assert.equal(validateSettings(rawSettings({ workFolder: 'work/<key>' }), { root, stateRootDefault: '.x/' }).workFolder, 'work/<key>');
  bad({ appRepos: [{ repo: 'code', path: '../code', base: 'main' }] }, /appRepos\[0\]\.url is required/);
  bad({ appRepos: [{ repo: 'code', path: '', url: 'https://code.example/org/code' }] }, /appRepos\[0\]\.path must be the owner's clone/);
  assert.deepEqual(validateSettings(rawSettings({ appRepos: [{ repo: 'code', url: 'https://code.example/org/code/' }] }), { root, stateRootDefault: '.x/' }).appRepos, [{ repo: 'code', path: null, base: 'main', url: 'https://code.example/org/code' }], 'no owner\'s clone: nothing to deny');
  const d = settingsFor(root);
  assert.equal(d.workFolder, null);
  assert.deepEqual([d.limits.open, d.limits.startOrder], [null, 'priority']);
  const s = settingsFor(root, { cleanup: { trashDir: 'trash-here' } });
  assert.equal(s.cleanup.trashDir, path.join(root, 'trash-here'));
  assert.ok(fs.existsSync(root));
});

// ------------------------------------------------------------------ overlap and together

const ROUTING = 'guide-docs docs/routing/routing-mechanics/routing-mechanics.md';
const inWorkOn = (w, number, triage, stage = 'readyForMerge') => {
  const c = card({ number, status: 'finalReview' });
  w.tracker.cards.push(c);
  w.forge.prs.push(pr({ repo: 'guide-docs', number: number + 1000 }));
  ledger(w, c, { startedBy: 'schedule', stages: { triage: 'done', start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit', ...triage }, prs: [{ repo: 'guide-docs', number: number + 1000, targets: ['guide'], review: 'sme', stage }] });
};

test('the strings triage writes: a ticket with or without #, a page with or without its block; overlap holds a ticket back, and only the judgement joins', async () => {
  const repos = () => new Set(['guide-docs']);
  const a = { key: '1195', number: 1195, relations: ['#916', '#1221'], pages: [`${ROUTING} — Черга кандидатів`] };
  const b = { key: '1221', number: 1221, relations: ['#1195'], pages: ['guide-docs docs/routing/pools/pools.md', 'guide-docs docs/routing/routes/routes.md', ROUTING] };
  assert.equal(related(a, b, repos), true);
  assert.equal(related({ key: '1', pages: [`${ROUTING} — Черга кандидатів`] }, { key: '2', pages: [ROUTING] }, repos), true, 'the same page, with no relation');
  assert.equal(related({ key: '1', pages: [`${ROUTING} — Один блок`] }, { key: '2', pages: [`${ROUTING} — Інший блок`] }, repos), true, 'another block, the same page');
  assert.equal(related({ key: '1', pages: [{ repo: 'guide-docs', path: 'docs/a.md' }] }, { key: '2', pages: ['guide-docs docs/a.md — Блок'] }, repos), true, 'the older form');
  assert.equal(related({ key: '1', pages: ['guide-docs docs/a.md'] }, { key: '2', pages: ['api-docs docs/a.md'] }, repos), false, 'another repo');
  assert.equal(related({ key: '1', pages: ['a.md'] }, { key: '2', pages: ['a.md'] }, repos), false, 'a bare file name says nothing');
  assert.equal(related({ key: '1', pages: [{ repo: null, path: 'docs/a.md' }] }, { key: '2', pages: [{ repo: null, path: 'docs/a.md' }] }, repos), false, 'a path with no repo says nothing');
  assert.equal(pageKey(`${ROUTING} — Черга кандидатів`), ROUTING);
  assert.equal(pageKey('guide-docs docs/api-reference/ — нова сторінка «Отримати перелік банків» (GET /banks)'), 'guide-docs docs/api-reference/');

  const w = world({ extra: estimates });
  ready(w, 1195, { relations: ['#916', '#1221'], pages: a.pages });
  ready(w, 1221, { relations: ['#1195'], pages: b.pages });
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.groups.map((g) => g.group).sort(), ['1195', '1221'], 'without the judgement they stay apart');
  assert.deepEqual(st.startable.map((g) => g.group), ['1195']);
  assert.deepEqual(st.notStarted.map((g) => [g.group, g.reasons]), [['1221', ['related to 1195, starting now']]]);

  // #1195 in work (its PR open, at any stage): #1221 waits for it, as it would for a merge.
  const w2 = world({ extra: estimates });
  inWorkOn(w2, 1195, { relations: ['#916', '#1221'], pages: a.pages });
  ready(w2, 1221, { relations: ['#1195'], pages: b.pages });
  st = await w2.status({ usage: usage(5) });
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1221')).waitsFor, ['1195']);
  assert.deepEqual(st.startable, []);
  assert.deepEqual(st.notStarted.map((g) => g.reasons), [['related to 1195, still in work']]);
});

test('together joins in either direction, as #N or N, and not across repos; a card naming the other or one page never joins', async () => {
  const w = world({ extra: estimates });
  ready(w, 701, { together: ['#702'] });
  ready(w, 702);
  ready(w, 703, { together: ['704'], targets: ['guide'] });
  ready(w, 704, { targets: ['api'] });
  ready(w, 705, { pages: ['guide-docs docs/b.md — Перший'] });
  ready(w, 706, { pages: ['guide-docs docs/b.md — Другий'] });
  const st = await w.status({ usage: usage(5) });
  const groups = st.groups.map((g) => g.group).sort();
  assert.deepEqual(groups, ['701-702', '703', '704', '705', '706']);
  // One page, two ready tickets: the second waits for the first's start, and the reason names the page.
  const w2 = world({ extra: estimates });
  ready(w2, 705, { pages: ['guide-docs docs/b.md — Перший'] });
  ready(w2, 706, { pages: ['guide-docs docs/b.md — Другий'] });
  const st2 = await w2.status({ usage: usage(5) });
  assert.deepEqual(st2.notStarted.map((n) => [n.group, n.reasons]), [['706', ["related to 705, starting now: a page 705's triage names (guide-docs docs/b.md)"]]]);
});

// ------------------------------------------------------------------ the pages of a ticket in work (TASK-106)

// A ticket in work, in two target repos by its triage, and its PRs as the ledger has them: `prs` [{ repo, number, files }],
// a number null for a branch with no PR yet, `files` undefined for a PR whose files the forge didn't give.
const PAYMENT = 'api-docs docs/api-reference/create-payment/create-payment.md';
const workTriage = { verdict: 'docs-required', targets: ['api', 'guide'], size: 'edit', relations: ['#1194'], pages: [`${PAYMENT} — the card details paragraphs`, 'guide-docs docs/methods/cash/cash.md — Lifecycle', 'guide-docs docs/routing/queue/queue.md — Queue handling'] };
const inWorkWith = (w, number, prs, { status = 'finalReview', opened = true, triage = workTriage, archived = false, gone = false } = {}) => {
  const c = card({ number, status, closed: archived });
  if (!gone) w.tracker.cards.push(c);
  for (const p of prs) if (p.number) w.forge.prs.push(pr({ repo: p.repo, number: p.number, state: p.state ?? 'open', files: p.files, filesTruncated: p.filesTruncated, filesRenamed: p.filesRenamed }));
  const stages = { triage: 'done', start: 'done', plan: 'done', write: opened ? 'done' : 'running', ...(opened ? { uaReview: 'done', pr: 'done' } : {}) };
  ledger(w, c, { startedBy: 'schedule', stages, triage, prs: prs.map((p) => ({ repo: p.repo, number: p.number ?? null, targets: [p.repo === 'api-docs' ? 'api' : 'guide'], review: p.repo === 'api-docs' ? 'places' : 'sme', branch: `${number}-docs`, stage: p.number ? status : 'writing' })) });
};
const readyOn = (w) => ready(w, 1193, { targets: ['api'], relations: ['1254', '1258'], size: 'newPage', pages: ['api-docs docs/api-reference/ — a new page (GET /banks)', `${PAYMENT} — Request body`] });

test('AC-1: a ticket in work whose PR changes other pages holds no ready ticket back, though both triages named one page', async () => {
  // As on the morning in question: 1157 in final review, its one PR in the guide repo only; its triage also guessed the
  // payment page of the API repo, which 1193 will edit.
  const w = world({ extra: estimates });
  inWorkWith(w, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md', 'docs/routing/queue/queue.md'] }]);
  readyOn(w);
  const st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1193')).waitsFor, []);
  assert.deepEqual(st.startable.map((g) => g.group), ['1193']);
});

test('a PR that changes the shared page holds the ready ticket back, and the reason names the page and where it came from', async () => {
  const w = world({ extra: estimates });
  inWorkWith(w, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }, { repo: 'api-docs', number: 62, files: ['docs/api-reference/create-payment/create-payment.md', 'i18n/en/docusaurus-plugin-content-docs/current/api-reference/create-payment/create-payment.md'] }]);
  readyOn(w);
  const st = await w.status({ usage: usage(5) });
  const g = st.groups.find((x) => x.keys.includes('1193'));
  assert.deepEqual(g.waitsFor, ['1157']);
  assert.deepEqual(g.waitsWhy, [{ key: '1157', by: 'page', page: PAYMENT, from: 'pr', pr: 62 }]);
  const reason = `related to 1157, still in work: a page 1157's PR #62 changes (${PAYMENT})`;
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[reason]]);
  assert.ok(!reason.includes(';'), 'the report and the progress file join reasons with "; "');
  // The morning report and the progress file show it.
  assert.ok(renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }).includes(`1193 (medium) didn't start: ${reason}`));
  assert.ok(renderProgress({ ledgers: [], now: NOW, mode: 'on', run: digestRun({ out: {}, st, now: NOW }) }).includes(reason));
});

test('no PR yet: the triage pages decide, as before, and the reason says so; a relation decides first and keeps its words', async () => {
  // Writing, its branch named but no PR opened: every repo of its triage counts.
  const w = world({ extra: estimates });
  inWorkWith(w, 1157, [{ repo: 'guide-docs', number: null }], { status: 'inProgress', opened: false });
  readyOn(w);
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[`related to 1157, still in work: a page 1157's triage names, no PR yet (${PAYMENT})`]]);
  // No PR entry at all, before the PRs are opened: the same.
  const w2 = world({ extra: estimates });
  inWorkWith(w2, 1157, [], { status: 'inProgress', opened: false });
  readyOn(w2);
  st = await w2.status({ usage: usage(5) });
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1193')).waitsFor, ['1157']);
  // A relation named by the triage holds it whatever the pages, with the words it had.
  const w3 = world({ extra: estimates });
  inWorkWith(w3, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }], { triage: { ...workTriage, relations: ['#1193'] } });
  readyOn(w3);
  st = await w3.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [['related to 1157, still in work']]);
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1193')).waitsWhy, [{ key: '1157', by: 'relation' }]);
});

test('a PR in one target, none yet in the other: the second target\'s triage pages count; a PR whose files the forge did not give keeps its repo\'s triage pages', async () => {
  const w = world({ extra: estimates });
  inWorkWith(w, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }, { repo: 'api-docs', number: null }], { status: 'inProgress' });
  readyOn(w);
  let st = await w.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[`related to 1157, still in work: a page 1157's triage names, no PR yet (${PAYMENT})`]]);
  const w2 = world({ extra: estimates });
  inWorkWith(w2, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }, { repo: 'api-docs', number: 62 }]);
  readyOn(w2);
  st = await w2.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[`related to 1157, still in work: a page 1157's triage names, its PR's files not read (${PAYMENT})`]], 'unknown files: the guess stays');
  // A longer list than one read gives: the files read count, the guess beside them.
  const w3 = world({ extra: estimates });
  inWorkWith(w3, 1157, [{ repo: 'api-docs', number: 62, files: ['docs/api-reference/create-payment/create-payment.md'], filesTruncated: true }]);
  readyOn(w3);
  st = await w3.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[`related to 1157, still in work: a page 1157's PR #62 changes (${PAYMENT})`]]);
});

test('a PR closed unmerged holds its files; a rename keeps the triage pages beside them; a session on the ticket brings back the repos it has no PR in', async () => {
  // Closed to be redone, its branch still has the edits: the shared page holds 1193 back.
  const w = world({ extra: estimates });
  inWorkWith(w, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }, { repo: 'api-docs', number: 62, state: 'closed', files: ['docs/api-reference/create-payment/create-payment.md'] }], { status: 'inProgress' });
  readyOn(w);
  let st = await w.status({ usage: usage(5) });
  assert.equal(st.tickets.find((t) => t.key === '1157').state, 'outside', 'not in work, and not counted');
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1193')).waitsFor, ['1157']);
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[`related to 1157, its PR closed unmerged: a page 1157's PR #62 changes (${PAYMENT})`]]);
  // Released when its card leaves the working statuses: archived, gone, done, out of scope, the drafts or ready.
  for (const how of [{ archived: true }, { gone: true }, { status: 'done' }, { status: 'outOfScope' }, { status: 'drafts' }, { status: 'ready' }]) {
    const wr = world({ extra: estimates });
    inWorkWith(wr, 1157, [{ repo: 'api-docs', number: 62, state: 'closed', files: ['docs/api-reference/create-payment/create-payment.md'] }], { status: 'inProgress', ...how });
    readyOn(wr);
    const sr = await wr.status({ usage: usage(5) });
    assert.deepEqual(sr.groups.find((g) => g.keys.includes('1193')).waitsFor, [], JSON.stringify(how));
  }
  // In the other working statuses it still holds them.
  for (const status of ['blocked', 'smeReview', 'finalReview', 'translation']) {
    const wh = world({ extra: estimates });
    inWorkWith(wh, 1157, [{ repo: 'api-docs', number: 62, state: 'closed', files: ['docs/api-reference/create-payment/create-payment.md'] }], { status });
    readyOn(wh);
    assert.deepEqual((await wh.status({ usage: usage(5) })).groups.find((g) => g.keys.includes('1193')).waitsFor, ['1157'], status);
  }
  // Its relations don't hold anything: only its pages.
  const w1 = world({ extra: estimates });
  inWorkWith(w1, 1157, [{ repo: 'api-docs', number: 62, state: 'closed', files: ['docs/methods/other.md'] }], { status: 'inProgress', triage: { ...workTriage, relations: ['#1193'] } });
  readyOn(w1);
  assert.deepEqual((await w1.status({ usage: usage(5) })).startable.map((g) => g.group), ['1193']);
  // A rename in the API repo's PR: its old path isn't in the list, so the triage's guess counts beside the files.
  const w2 = world({ extra: estimates });
  inWorkWith(w2, 1157, [{ repo: 'api-docs', number: 62, files: ['docs/guides/other/other.md'], filesRenamed: true }]);
  readyOn(w2);
  st = await w2.status({ usage: usage(5) });
  assert.deepEqual(st.notStarted.map((n) => n.reasons), [[`related to 1157, still in work: a page 1157's triage names, its PR renames a file (${PAYMENT})`]]);
  // AC-1's 1157 with a session running on it (a review round): its API triage page counts again while the lock is live.
  const w3 = world({ extra: estimates });
  inWorkWith(w3, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }]);
  readyOn(w3);
  takeLock(w3.settings.state, { group: '1157', kind: 'schedule', stage: 'answerComments', leaseMinutes: 120, now: NOW });
  st = await w3.status({ usage: usage(5) });
  assert.ok(st.notStarted.find((n) => n.group === '1193').reasons.includes(`related to 1157, still in work: a page 1157's triage names, a session on it now (${PAYMENT})`), JSON.stringify(st.notStarted));
});

test("a PR closed as won't merge (`forge.wontMergeLabel`) holds no page and counts for no limit, beside an open PR or alone; without the label it holds them as before", async () => {
  const WONT = "won't merge";
  const extra = { ...estimates, forge: { ...rawSettings().forge, wontMergeLabel: WONT } };
  const labelled = (w) => {
    w.forge.prs.find((p) => p.number === 62).labels = [WONT];
  };
  // Beside an open PR in the guide repo: the ticket is in work by that PR alone, and the payment page holds nothing.
  const w = world({ extra });
  inWorkWith(w, 1157, [{ repo: 'guide-docs', number: 61, files: ['docs/methods/cash/cash.md'] }, { repo: 'api-docs', number: 62, state: 'closed', files: ['docs/api-reference/create-payment/create-payment.md'] }], { status: 'finalReview' });
  labelled(w);
  readyOn(w);
  let st = await w.status({ usage: usage(5) });
  assert.equal(st.tickets.find((t) => t.key === '1157').state, 'finalReview');
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1193')).waitsFor, []);
  assert.deepEqual(st.startable.map((g) => g.group), ['1193']);
  // Alone: the ticket is outside, and its card in a working status keeps no page either.
  const w1 = world({ extra });
  inWorkWith(w1, 1157, [{ repo: 'api-docs', number: 62, state: 'closed', files: ['docs/api-reference/create-payment/create-payment.md'] }], { status: 'finalReview' });
  labelled(w1);
  readyOn(w1);
  st = await w1.status({ usage: usage(5) });
  assert.equal(st.tickets.find((t) => t.key === '1157').state, 'outside');
  assert.deepEqual(st.groups.find((g) => g.keys.includes('1193')).waitsFor, []);
  assert.equal(st.wip.inProgress + st.wip.waiting, 0);
  // The same PR closed without the label, or the label with no setting: it holds the page, as before.
  for (const variant of [{ extra, label: false }, { extra: estimates, label: true }]) {
    const w2 = world({ extra: variant.extra });
    inWorkWith(w2, 1157, [{ repo: 'api-docs', number: 62, state: 'closed', files: ['docs/api-reference/create-payment/create-payment.md'] }], { status: 'finalReview' });
    if (variant.label) labelled(w2);
    readyOn(w2);
    assert.deepEqual((await w2.status({ usage: usage(5) })).groups.find((g) => g.keys.includes('1193')).waitsFor, ['1157'], JSON.stringify(variant.label));
  }
});

test('a page is its repo and its id: the EN translation, the extension, the page folder, its .assets, a URL form; a folder guess by prefix, a bare name by name', () => {
  const ref = (p) => pageRef(p, ['docs/']);
  for (const p of ['guide-docs docs/x/y/y.md', 'guide-docs docs/x/y.mdx', 'guide-docs docs/x/y/index.md', 'guide-docs docs/x/y/.assets/shot.png', 'guide-docs i18n/en/docusaurus-plugin-content-docs/current/x/y/y.md', 'guide-docs i18n/de/docusaurus-plugin-content-docs-portal/current/x/y/y.mdx', 'guide-docs /x/y', 'guide-docs docs/x/y/y.md#a-heading', { repo: 'guide-docs', path: 'docs/x/y/y.md' }]) {
    assert.deepEqual([ref(p).repo, ref(p).id], ['guide-docs', 'x/y'], JSON.stringify(p));
  }
  assert.equal(ref('guide-docs docs/x/_category_.json').id, 'x');
  assert.equal(pageRef('portal-docs portal/x/y/y.md', ['portal/']).id, 'x/y', "the repo's own root");
  const same = (a, b) => samePage(ref(a), ref(b));
  assert.equal(same('guide-docs docs/x/y/y.md — Block', 'guide-docs i18n/en/docusaurus-plugin-content-docs/current/x/y/y.md'), true, 'an EN-only change');
  assert.equal(same('guide-docs docs/x/y/y.md', 'guide-docs docs/x/y/.assets/shot.png'), true, 'a screenshot of the page');
  assert.equal(same('guide-docs docs/x/x.md', 'guide-docs docs/x/_category_.json'), true, "the section's label and its index page");
  assert.equal(same('guide-docs docs/api-reference/ — a new page', 'guide-docs docs/api-reference/create-payment/create-payment.md'), true, 'a folder guess, by prefix');
  assert.equal(same('guide-docs docs/api-reference/create-payment/create-payment.md', 'guide-docs docs/api-reference/'), true, 'either side');
  assert.equal(same('guide-docs docs/api-reference/', 'guide-docs docs/guides/a/a.md'), false);
  assert.equal(same('guide-docs create-payment.md', 'guide-docs docs/api-reference/create-payment/create-payment.md'), true, 'a bare name, by name');
  assert.equal(same('guide-docs create-payment.md', 'guide-docs docs/api-reference/refund/refund.md'), false);
  assert.equal(same('guide-docs /api-reference/create-payment', 'guide-docs docs/api-reference/create-payment/create-payment.md'), true, 'a URL form');
  assert.equal(same('guide-docs docs/x/y/y.md', 'api-docs docs/x/y/y.md'), false, 'another repo');
  assert.equal(same('guide-docs docs/x/y/y.md', 'guide-docs docs/x/z/z.md'), false);
  // In status: an EN-only PR of the work ticket holds back the ready ticket on its UA page.
  assert.equal(related({ key: '1', pages: ['guide-docs docs/x/y/y.md — Block'] }, { key: '2', pages: [{ repo: 'guide-docs', path: 'i18n/en/docusaurus-plugin-content-docs/current/x/y/y.md', from: 'pr', pr: 5 }] }, () => new Set(['guide-docs'])), true);
});

test('workPages: per repo, the open PR\'s files, the triage where no PR is opened yet or its files are unknown, nothing where it is merged', () => {
  const l = (prs, opened) => ({ key: '7', stages: opened ? { pr: { status: 'done' } } : {}, triage: { pages: ['guide-docs docs/a.md — A', 'api-docs docs/b.md — B', 'docs/c.md', { repo: 'api-docs', path: 'docs/d.md' }] }, prs });
  const at = (entries) => new Map(entries.map(([n, e]) => [`7/${n}`, e]));
  const keys = (pages) => pages.map((p) => `${p.from} ${p.repo} ${p.path}${p.pr ? ` #${p.pr}` : ''}${p.why ? ` ${p.why}` : ''}`);
  // No PR, not opened: the triage's, the pages with no repo left out.
  assert.deepEqual(keys(workPages(l([], false))), ['triage guide-docs docs/a.md noPr', 'triage api-docs docs/b.md noPr', 'triage api-docs docs/d.md noPr']);
  // Opened, one PR in the guide repo with its files: those files; the API repo has no PR and gets none.
  const one = [{ repo: 'guide-docs', number: 5 }];
  assert.deepEqual(keys(workPages(l(one, true), at([['guide-docs#5', { state: 'open', files: ['docs/x.md'] }]]))), ['pr guide-docs docs/x.md #5']);
  // Its files unknown (no files, a failed read, no read): the guide repo's triage page instead.
  for (const world of [{ state: 'open' }, { error: 'HTTP 502' }, undefined]) assert.deepEqual(keys(workPages(l(one, true), at(world ? [['guide-docs#5', world]] : []))), ['triage guide-docs docs/a.md filesUnknown']);
  // Only part of its files (more than one read gives): those it read, and the triage's beside them.
  assert.deepEqual(keys(workPages(l(one, true), at([['guide-docs#5', { state: 'open', files: ['docs/x.md'], filesTruncated: true }]]))), ['pr guide-docs docs/x.md #5', 'triage guide-docs docs/a.md filesUnknown']);
  // A branch with no PR yet in the API repo: its triage pages count beside the guide PR's files.
  const two = [{ repo: 'guide-docs', number: 5 }, { repo: 'api-docs', number: null, branch: 'b' }];
  assert.deepEqual(keys(workPages(l(two, false), at([['guide-docs#5', { state: 'open', files: ['docs/x.md'] }]]))), ['pr guide-docs docs/x.md #5', 'triage api-docs docs/b.md noPr', 'triage api-docs docs/d.md noPr']);
  // Closed unmerged: its files still count. Renamed: the triage's beside them.
  assert.deepEqual(keys(workPages(l(one, true), at([['guide-docs#5', { state: 'closed', files: ['docs/x.md'] }]]))), ['pr guide-docs docs/x.md #5']);
  assert.deepEqual(keys(workPages(l(one, true), at([['guide-docs#5', { state: 'open', files: ['docs/x.md'], filesRenamed: true }]]))), ['pr guide-docs docs/x.md #5', 'triage guide-docs docs/a.md renamed']);
  // Opened, no PR in the API repo: none from it, unless a session runs on the ticket.
  assert.deepEqual(keys(workPages(l(one, true), at([['guide-docs#5', { state: 'open', files: ['docs/x.md'] }]]), { locked: true })), ['pr guide-docs docs/x.md #5', 'triage api-docs docs/b.md session', 'triage api-docs docs/d.md session']);
  // Merged in the guide repo: nothing there, before the stage is recorded too.
  assert.deepEqual(keys(workPages(l([{ repo: 'guide-docs', number: 5, merged: { at: 'x' } }], true))), []);
  assert.deepEqual(keys(workPages(l([{ repo: 'guide-docs', number: 5 }], true), at([['guide-docs#5', { state: 'merged', files: ['docs/x.md'] }]]))), []);
});

test('open: a ticket locked at a scheduled start is open while its card is still in the ready status', async () => {
  const w = world({ extra: { limits: { ...estimates.limits, open: 1, inProgress: 5 } } });
  const c = ready(w, 801);
  // The runner recorded the start and holds the lock; its session has not moved the card yet.
  ledger(w, c, { stages: { triage: 'done', start: 'running' }, startedBy: 'schedule', triage: { verdict: 'docs', targets: ['guide'], size: 'edit' } });
  takeLock(w.settings.state, { group: '801', kind: 'schedule', stage: 'start', leaseMinutes: 120, now: NOW });
  ready(w, 501);
  const st = await w.status({ usage: usage(5) });
  assert.deepEqual([st.wip.open, st.wip.openKeys], [1, ['801']], 'a second scheduled run at the same time sees the slot taken');
  assert.deepEqual(st.startable.map((g) => g.group), []);
  assert.match(st.notStarted.find((g) => g.group === '501').reasons.join(), /1 open \(801\) \+ 1 > 1/);
});
