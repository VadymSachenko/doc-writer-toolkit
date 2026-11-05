import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, pr } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { makeClients } from '../lib/world.mjs';
import { runRecord } from '../lib/record.mjs';
import { lockOf } from '../lib/locks.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { PUSH_DENIED, ROLE_DIR, agentsFile, briefFor, collectSteps, commandFor, nextModelUp, proposeRoles, readRole, runDaily } from '../lib/runner.mjs';
import { localDate } from '../lib/report.mjs';

// The daily run: finishing first, the morning triage, starts within the limits; one `claude -p` session per model
// step in its role; a dry run that plans and changes nothing; observe mode; the guard; the retry; the report.

const usageAt = (week, session = 10) => parseUsage(`Current session: ${session}% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);
const estimates = { limits: { estimates: { edit: 4, newPage: 8 } } };
const RESULT = (cost = 0.5) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: cost, duration_ms: 60000, session_id: 'session-1', usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [] });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const flag = (cmd, name) => cmd.args[cmd.args.indexOf(name) + 1];

// A ready ticket, a ticket in planning, and an intake card quiet for its hours.
function busyWorld(extra = estimates) {
  const ready = card({ number: 501, status: 'ready', labels: ['Guide'] });
  const planning = card({ number: 502, status: 'inProgress', labels: ['Guide'] });
  const intake = card({ number: 503, status: 'intake', labels: ['Api'], lastActivity: ago(5) });
  const w = world({ cards: [ready, planning, intake], extra });
  ledger(w, ready, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  ledger(w, planning, { stages: { triage: 'done', start: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  return { w, ready, planning, intake };
}

test('the dry run prints the plan and each claude command line, and writes and sends nothing', async () => {
  const { w } = busyWorld();
  const clients = makeClients({ settings: w.settings, io: { trackerAdapter: w.tracker, forgeAdapter: w.forge }, dryRun: true });
  const before = snapshot(w.root);
  const out = await runDaily({ settings: w.settings, clients, io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude: () => assert.fail('a dry run starts no session') }, options: { dryRun: true, morning: true } });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.planned.map((p) => [p.stage, p.keys, p.role, p.model, p.effort]), [['plan', ['502'], 'writer', 'claude-opus-5-5', 'high']]);
  const cmd = { args: out.planned[0].command.slice(1) };
  assert.equal(out.planned[0].command[0], 'claude');
  assert.equal(flag(cmd, '--agent'), 'ticket-writer');
  assert.equal(flag(cmd, '--agents'), path.join(w.settings.state, 'roles', 'agents.json'));
  assert.equal(flag(cmd, '--permission-prompts'), 'none');
  assert.equal(flag(cmd, '--output-format'), 'json');
  assert.equal(flag(cmd, '--max-turns'), '200');
  assert.ok(cmd.args.includes('--allowedTools') && cmd.args.includes('--disallowedTools'));
  assert.deepEqual(cmd.args.filter((a, i) => cmd.args[i - 1] === '--add-dir'), ['repos/guide-docs', 'repos/api-docs', 'repos/portal-docs'].map((p) => path.join(w.root, p)));
  assert.match(briefOf(cmd), /record 502 --root .* --stage plan --status done --result <json>/);
  // The morning triage: one session for the due cards, highest priority first; the start of the ready group.
  assert.deepEqual([out.triage.stage, out.triage.keys, out.triage.model, out.triage.effort], ['triage', ['503'], 'claude-sonnet-5-5', 'medium']);
  assert.deepEqual(out.starts.map((s) => [s.stage, s.group, s.role]), [['start', '501', 'writer']]);
  assert.match(briefOf({ args: out.starts[0].command.slice(1) }), /record 501 .* --stage start --status done --card \S+ --started-by schedule --result '\{"group":"501"\}'/);
  assert.match(out.report, /^# Ticket flow, /);
  // Nothing written, nothing sent.
  assert.deepEqual(snapshot(w.root), before);
  assert.deepEqual([w.tracker.log, w.forge.log], [[], []]);
  assert.deepEqual(clients.caught(), { tracker: [], forge: [] });
});

test('observe mode plans and writes only the report: no session, no ledger change, no lock', async () => {
  const { w } = busyWorld({ ...estimates, mode: 'observe' });
  const tickets = snapshot(path.join(w.settings.state, 'tickets'));
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude: () => assert.fail('observe starts no session') }, options: { morning: true } });
  assert.equal(out.observe, true);
  assert.equal(out.planned.length, 1);
  assert.deepEqual(out.ran, []);
  assert.deepEqual(snapshot(path.join(w.settings.state, 'tickets')), tickets);
  assert.equal(fs.existsSync(path.join(w.settings.state, 'locks')), false);
  assert.ok(fs.existsSync(path.join(w.root, out.reportFile)));
  assert.deepEqual([w.tracker.log, w.forge.log], [[], []]);
});

test('mode off runs nothing', async () => {
  const { w } = busyWorld({ mode: 'off' });
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW }, options: {} });
  assert.equal(out.stopped, 'mode off: nothing runs');
});

test('the dry run at the allowance says the guard would hold each model step back', async () => {
  const { w } = busyWorld();
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(45), now: () => NOW }, options: { dryRun: true, morning: true } });
  assert.deepEqual([out.planned[0].stage, out.planned[0].guard], ['plan', 'a live run would not start it: the week is at 45%, the allowance by now is 40%']);
  assert.match(out.triage.guard, /a live run would not start it/);
  assert.deepEqual(out.guard.map((g) => g.what), ['the plan']);
  assert.match(out.report, /## Failures and guard stops\n\n- \S+ the plan: the week is at 45%, the allowance by now is 40%: a live run would start no model step/);
});

test('a scheduled run: the session records its stage; a session that does not is retried once with the next model up', async () => {
  const { w, ready } = busyWorld({ ...estimates, roles: { writer: { model: 'claude-sonnet-5-5' } }, limits: { ...estimates.limits, stepsPerTicket: 2 } });
  // Only the ready ticket: the planning one is someone else's for this test.
  fs.rmSync(path.join(w.settings.state, 'tickets', '502.json'));
  w.tracker.cards.splice(1, 1);
  let week = 5;
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push({ stage: /Stage `(\w+)`/.exec(briefOf(cmd))[1], model: flag(cmd, '--model'), lock: lockOf(w.settings.state, '501', NOW) });
    week += 1;
    const clients = w.clients();
    const stage = calls.at(-1).stage;
    if (stage === 'start') {
      ready.placeId = LISTS.inProgress.id;
      await runRecord({ settings: w.settings, clients, key: '501', stage: 'start', status: 'done', card: ready.shortLink, result: { group: '501' }, now: NOW });
    }
    if (stage === 'plan' && calls.at(-1).model === 'claude-opus-5-5') await runRecord({ settings: w.settings, clients, key: '501', stage: 'plan', status: 'done', result: { pages: ['docs/pay/refunds.md'] }, now: NOW });
    return { code: 0, stdout: RESULT() };
  };
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(week), now: () => NOW, spawnClaude }, options: {} });
  assert.deepEqual(calls.map((c) => [c.stage, c.model]), [['start', 'claude-sonnet-5-5'], ['plan', 'claude-sonnet-5-5'], ['plan', 'claude-opus-5-5']]);
  assert.ok(calls.every((c) => c.lock?.live && c.lock.kind === 'schedule'), 'the group is locked while its session runs');
  assert.equal(lockOf(w.settings.state, '501', NOW), null, 'released after the run');
  assert.deepEqual(out.starts.map((s) => s.steps.map((x) => [x.stage, x.outcome, x.model])), [[['start', 'done', 'claude-sonnet-5-5'], ['plan', 'done', 'claude-opus-5-5']]]);
  const l = read(w, '501');
  assert.deepEqual([l.startedBy, l.stages.plan.status], ['schedule', 'done']);
  assert.deepEqual(l.runs.map((r) => [r.stage, r.role, r.model, r.outcome, r.retryOf ?? null, r.weekPercent.before, r.weekPercent.after, r.costUsd, r.turns]), [
    ['start', 'writer', 'claude-sonnet-5-5', 'done', null, 5, 6, 0.5, 4],
    ['plan', 'writer', 'claude-sonnet-5-5', 'failed', null, 6, 7, 0.5, 4],
    ['plan', 'writer', 'claude-opus-5-5', 'done', 'claude-sonnet-5-5', 7, 8, 0.5, 4],
  ]);
  const date = localDate(NOW);
  const report = fs.readFileSync(path.join(w.settings.state, 'reports', `${date}.md`), 'utf8');
  assert.match(report, /3 session\(s\) today, about \$1\.50 by the CLI's estimate\. Week: 8% used\./);
  const log = fs.readFileSync(path.join(w.settings.state, 'runs', `${date}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.deepEqual(log.filter((e) => e.kind === 'retry').map((e) => [e.stage, e.from, e.to]), [['plan', 'claude-sonnet-5-5', 'claude-opus-5-5']]);
  assert.ok(fs.existsSync(path.join(w.settings.state, 'roles', 'agents.json')));
});

test('the guard: at the allowance by now, no model step starts, and the report says why', async () => {
  const { w } = busyWorld();
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(45), now: () => NOW, spawnClaude: () => assert.fail('the guard stops it') }, options: {} });
  assert.deepEqual(out.ran, []);
  assert.deepEqual(out.starts, []);
  assert.ok(out.guard.some((g) => /the week is at 45%, the allowance by now is 40%/.test(g.reason)));
  const report = fs.readFileSync(path.join(w.root, out.reportFile), 'utf8');
  assert.match(report, /## Failures and guard stops\n\n- \S+ 502 plan: the week is at 45%/);
  assert.match(report, /501 \(medium\) didn't start: .*estimate 4% \+ 4% to finish the tickets in work > 0% left today/);
});

test('a manual run starts the named ready ticket past the limits, and the ticket is never counted', async () => {
  const { w, ready } = busyWorld();
  for (const n of [601, 602, 603]) {
    const c = card({ number: n, status: 'inProgress' });
    w.tracker.cards.push(c);
    ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done' }, triage: { size: 'edit' } });
  }
  const seen = [];
  const spawnClaude = async (cmd) => {
    const stage = /Stage `(\w+)`/.exec(briefOf(cmd))[1];
    seen.push([stage, /--started-by (\w+)/.exec(briefOf(cmd))?.[1] ?? null, lockOf(w.settings.state, '501', NOW)?.kind]);
    if (stage === 'start') {
      ready.placeId = LISTS.inProgress.id;
      await runRecord({ settings: w.settings, clients: w.clients(), key: '501', stage: 'start', status: 'done', card: ready.shortLink, now: NOW });
    }
    return { code: 0, stdout: RESULT() };
  };
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: { trigger: 'manual', named: ['501'] } });
  assert.deepEqual(seen[0], ['start', 'manual', 'manual']);
  assert.ok(!seen.some(([s]) => s !== 'start' && s !== 'plan'), 'only the named ticket ran');
  const st = await w.status({ usage: usageAt(5) });
  const t = st.tickets.find((x) => x.key === '501');
  assert.deepEqual([t.startedBy, t.counts, t.counted], ['manual', 'inProgress', false]);
  assert.deepEqual([st.wip.inProgress, st.wip.manual], [4, 1], "past the limit of 3; the manual ticket stays out of the count");
});

test('a manual morning run that names an intake card triages that card only; a scheduled morning takes every due card', async () => {
  const { w } = busyWorld();
  w.tracker.cards.push(card({ number: 504, status: 'intake', labels: ['Api'], lastActivity: ago(6) }));
  const io = { readUsage: () => usageAt(5), now: () => NOW, spawnClaude: () => assert.fail('a dry run starts no session') };
  const manual = await runDaily({ settings: w.settings, clients: w.clients(), io, options: { dryRun: true, morning: true, trigger: 'manual', named: ['503'] } });
  assert.deepEqual(manual.triage.keys, ['503']);
  const scheduled = await runDaily({ settings: w.settings, clients: w.clients(), io, options: { dryRun: true, morning: true } });
  assert.deepEqual([...scheduled.triage.keys].sort(), ['503', '504']);
});

test('the brief passes the settings file the runner read to every command it names', () => {
  const { w } = busyWorld();
  const brief = briefFor({ stage: 'plan', role: 'writer', keys: ['502'], group: '502' }, { ...w.settings, file: '/elsewhere/flow.json' });
  for (const cmd of ['config', 'status', 'record 502']) assert.match(brief, new RegExp(`${cmd} --root \\S+ --settings /elsewhere/flow\\.json`));
  assert.doesNotMatch(briefFor({ stage: 'plan', role: 'writer', keys: ['502'], group: '502' }, { ...w.settings, file: undefined }), /--settings/);
});

test('finishing comes first: merged, ready for merge, the chain, comments, answers, writing; higher priority first within a kind', () => {
  const t = (key, stage, extra = {}, priority = 'medium', createdAt = ago(10)) => ({ key, group: key, priority, createdAt, next: { stage, role: null, ...extra }, card: null });
  const st = { tickets: [t('1', 'plan'), t('2', 'write', {}, 'high'), t('3', 'answerComments', { pr: 'r#1' }), t('4', 'close'), t('5', 'translate', { pr: 'r#2' }), t('6', 'answers'), t('7', 'readyForMerge', { pr: 'r#3' }), t('8', 'plan', {}, 'medium', ago(100)), t('9', 'start')] };
  assert.deepEqual(collectSteps(st).map((s) => s.keys[0]), ['4', '7', '5', '3', '6', '2', '8', '1']);
});

test('the roles: every role file has its frontmatter and allows no compound shell call; the shared rules go to every role', () => {
  const agents = agentsFile();
  assert.deepEqual(Object.keys(agents), ['ticket-triage', 'ticket-writer', 'ticket-reviewer', 'ticket-translator']);
  for (const [name, a] of Object.entries(agents)) {
    assert.ok(a.description.length > 40, name);
    assert.match(a.prompt, /One command per Bash call/);
    assert.match(a.prompt, /A rejected push means someone else pushed/);
  }
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const r = readRole(role, ROLE_DIR);
    assert.equal(r.name, `ticket-${role}`);
    for (const rule of r.allowedTools) assert.doesNotMatch(rule, /&&|\|\||;|\||\$\(/, `${role}: ${rule}`);
    for (const deny of ['Bash(git checkout:*)', 'Bash(git pull:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(rm:*)']) assert.ok(r.disallowedTools.includes(deny), `${role} denies ${deny}`);
    assert.ok(!r.allowedTools.some((x) => /^Bash\((rm|gh|curl)\b/.test(x)), role);
  }
});

test('AC-2: every role allows its stage\'s git commands in both spellings, plain and git -C <worktree>, and carries every push and setup denial', () => {
  const { w } = busyWorld();
  // What each role's stages run on the ticket worktree or the target repos.
  const NEEDS = {
    triage: ['log', 'show', 'ls-tree', 'grep'],
    writer: ['status', 'diff', 'log', 'show', 'fetch', 'worktree list', 'add', 'commit', 'push'],
    reviewer: ['status', 'diff', 'log', 'show', 'fetch', 'worktree list', 'add', 'commit', 'push'],
    translator: ['status', 'diff', 'log', 'show', 'fetch', 'worktree list', 'add', 'commit', 'push'],
  };
  // The denials as they stood, each still carried, plus their git -C twins and the setup the runner now does.
  const PLAIN = ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git push --force-if-includes:*)', 'Bash(git push --no-verify:*)', 'Bash(git push --mirror:*)', 'Bash(git push --delete:*)', 'Bash(git push -d:*)'];
  for (const [role, subs] of Object.entries(NEEDS)) {
    const cmd = commandFor({ stage: role === 'triage' ? 'triage' : 'write', role, keys: ['502'], group: '502' }, w.settings, { agentsPath: '/x/agents.json' });
    const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
    const denied = cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1).filter((a, i, all) => !a.startsWith('--') && !all.slice(0, i).some((x) => x.startsWith('--')));
    for (const sub of subs) {
      for (const rule of [`Bash(git ${sub}:*)`, `Bash(git -C * ${sub})`, `Bash(git -C * ${sub} *)`]) assert.ok(allowed.includes(rule), `${role} allows ${rule}`);
    }
    for (const rule of PLAIN) {
      assert.ok(denied.includes(rule), `${role} denies ${rule}`);
      const flagged = /^Bash\(git push (.+):\*\)$/.exec(rule)[1];
      for (const twin of [`Bash(git -C * push ${flagged})`, `Bash(git -C * push ${flagged} *)`]) assert.ok(denied.includes(twin), `${role} denies ${twin}`);
    }
    for (const rule of ['Bash(npm ci:*)', 'Bash(npm install:*)', 'Bash(ln:*)']) assert.ok(denied.includes(rule), `${role} denies ${rule}`);
    // A session never makes or removes a worktree itself.
    assert.ok(!allowed.some((r) => /worktree (add|remove|move|prune)|Bash\(git worktree:\*\)|Bash\(git -C \* worktree\)/.test(r)), role);
    // Every git -C rule uses the forms the CLI matches: a `:*` after a mid-rule `*` never does.
    assert.ok(![...allowed, ...denied].some((r) => /^Bash\(git -C \*.*:\*\)$/.test(r)), role);
  }
  assert.ok(PLAIN.every((r) => PUSH_DENIED.includes(r)), 'PUSH_DENIED keeps its rules');
});

test('the command line follows the role settings; the retry takes the next model up the ladder', () => {
  const { w } = busyWorld({ roles: { reviewer: { model: 'claude-haiku-5-5', effort: 'low', maxTurns: 30, maxBudgetUsd: 2, disallowedTools: ['WebFetch'] } } });
  const cmd = commandFor({ stage: 'uaReview', role: 'reviewer', keys: ['502'], group: '502' }, w.settings, { agentsPath: '/x/agents.json' });
  assert.deepEqual([flag(cmd, '--model'), flag(cmd, '--effort'), flag(cmd, '--max-turns'), flag(cmd, '--max-budget-usd'), flag(cmd, '--agent')], ['claude-haiku-5-5', 'low', '30', '2', 'ticket-reviewer']);
  assert.ok(cmd.args.slice(cmd.args.indexOf('--disallowedTools')).includes('WebFetch'));
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const denied = commandFor({ stage: 'x', role, keys: ['502'], group: '502' }, w.settings, { agentsPath: '/x/agents.json' }).args;
    for (const rule of PUSH_DENIED) assert.ok(denied.slice(denied.indexOf('--disallowedTools')).includes(rule), `${role} denies ${rule}`);
  }
  assert.equal(cmd.cwd, w.root);
  const ladder = w.settings.modelLadder;
  assert.deepEqual([nextModelUp('claude-haiku-5-5', ladder), nextModelUp('claude-sonnet-5-5', ladder), nextModelUp('claude-opus-5-5', ladder)], ['claude-sonnet-5-5', 'claude-opus-5-5', null]);
});

test('the weekly roles proposal: frequent retries propose the next model; many clean steps at high effort propose medium', () => {
  const { w } = busyWorld();
  const run = (role, extra = {}) => ({ role, start: ago(24), outcome: 'done', ...extra });
  const ledgers = [{ runs: [...Array.from({ length: 5 }, () => run('reviewer')), run('reviewer', { retryOf: 'claude-sonnet-5-5' }), run('reviewer', { retryOf: 'claude-sonnet-5-5' }), ...Array.from({ length: 10 }, () => run('translator')), run('triage', { start: ago(24 * 9) })] }];
  const p = proposeRoles(ledgers, w.settings, NOW);
  assert.deepEqual(p.proposals.map((x) => [x.role, x.change]), [['reviewer', 'model claude-sonnet-5-5 → claude-opus-5-5'], ['translator', 'effort high → medium']]);
});

test('the report: waiting for the owner, places, the check label, videos, ready for merge, cards left in a watched list', async () => {
  const c = { q: card({ number: 701, status: 'blocked' }), places: card({ number: 702, status: 'inProgress' }), rfm: card({ number: 703, status: 'finalReview' }), video: card({ number: 704, status: 'blocked' }) };
  const head = '9'.repeat(40);
  const release = [card({ list: { id: '5f00000000000000000a0101', name: 'Shipping' }, board: '5f00000000000000000d0002', name: 'Release notes 1.2', lastActivity: ago(30) })];
  const w = world({ cards: Object.values(c), release, prs: [pr({ repo: 'api-docs', number: 81, labels: ['In progress', 'Look at me'] }), pr({ repo: 'guide-docs', number: 82, headCommit: head })] });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  ledger(w, c.q, { stages: { start: 'done', plan: 'done', questions: 'done' } });
  ledger(w, c.places, { stages: base, prs: [{ repo: 'api-docs', number: 81, targets: ['api'], review: 'places', stage: 'placesWait' }], places: [{ id: 'p1', repo: 'api-docs', pr: 81, state: 'open' }, { id: 'p2', repo: 'api-docs', pr: 81, state: 'open' }] });
  ledger(w, c.rfm, { stages: base, prs: [{ repo: 'guide-docs', number: 82, targets: ['guide'], stage: 'readyForMerge', readyForMerge: [{ head, at: ago(2) }], chain: Object.fromEntries(['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'].map((s) => [s, { status: 'done', head }])) }] });
  ledger(w, c.video, { stages: { start: 'done', plan: 'done', videoGate: 'done', videoBlock: 'done' }, video: { videos: [{ file: 'v.mp4', parts: [{ file: 'v-part1.mp4', start: 0, transcript: 'v-part1.txt', tries: [{ at: ago(20), outcome: 'failed', reason: 'a sign-in wall' }] }] }] } });
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW }, options: { dryRun: true } });
  const r = out.report;
  assert.match(r, /## Waiting for you\n\n- \[701\]\(\S+\) #701 - Change 701: questions, answers on the card/);
  assert.match(r, /## PRs with places\n\n- \[api-docs#81\]\(\S+\) \(\[702\]\(\S+\)\): 2 open place\(s\)/);
  assert.match(r, /## PRs labelled «Look at me»\n\n- \[api-docs#81\]/);
  assert.match(r, /## Videos waiting for transcripts\n\n- \[704\]\(\S+\): 1 part\(s\) without a transcript; to upload today: `v-part1\.mp4` \(from 0 s, save as `v-part1\.txt`\); the automatic try failed: a sign-in wall/);
  assert.match(r, /## Ready for merge\n\n- \[guide-docs#82\]\(\S+\) \(\[703\]\(\S+\)\): ready for your final edit and the merge/);
  assert.match(r, /## Cards left in Shipping\n\n- \[Release notes 1\.2\]\(\S+\), last activity /);
});
