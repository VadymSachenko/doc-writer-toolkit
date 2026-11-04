import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, host, rawSettings, settingsFor, tmp } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { parseUsage, allowanceOf, parseReset } from '../lib/allowance.mjs';
import { loadSettings, validateSettings } from '../lib/settings.mjs';
import { estimatesOf, remainingOf } from '../lib/limits.mjs';

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
    ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, triage: { verdict: 'docs', targets: ['guide'], size: 'edit' } });
  }
};
const ready = (w, number, { labels = [], createdAt = ago(72), size = 'edit', relations = [], targets = ['guide'] } = {}) => {
  const c = card({ number, status: 'ready', labels, createdAt });
  w.tracker.cards.push(c);
  ledger(w, c, { stages: { triage: 'done' }, priority: null, triage: { verdict: 'docs', targets, size, relations } });
  return c;
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
  for (const n of [601, 602, 603, 604]) ready(w, n, { relations: [String(n === 601 ? 602 : n - 1)] });
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
  const s = settingsFor(root, { cleanup: { trashDir: 'trash-here' } });
  assert.equal(s.cleanup.trashDir, path.join(root, 'trash-here'));
  assert.ok(fs.existsSync(root));
});
