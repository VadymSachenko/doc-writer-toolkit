import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, pr, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { makeClients } from '../lib/world.mjs';
import { runRecord } from '../lib/record.mjs';
import { lockOf } from '../lib/locks.mjs';
import { browserLockState, noteBusy, takeBrowserLock } from '../lib/browser-lock.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { BRANCH_DENIED, PLUGIN_ROOT, PUSH_DENIED, PUSH_DENIED_PLAIN, ROLE_DIR, scriptRoots, scriptRulesFor, agentsFile, briefFor, collectSteps, commandFor, nextModelUp, proposeRoles, readRole, runDaily } from '../lib/runner.mjs';
import { localDate } from '../lib/report.mjs';
import { jobCommand } from '../lib/jobs.mjs';
import { notificationsOf } from '../lib/notify.mjs';

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
  ledger(w, planning, { stages: { triage: 'done', start: 'done' }, startedBy: 'schedule', triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
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
  // The target clones, then the toolkit roots a session reads its scripts from.
  const added = cmd.args.filter((a, i) => cmd.args[i - 1] === '--add-dir');
  assert.deepEqual(added.slice(0, 3), ['repos/guide-docs', 'repos/api-docs', 'repos/portal-docs'].map((p) => path.join(w.root, p)));
  assert.ok(added.includes(PLUGIN_ROOT));
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

test('a plan session that ends by asking is done, not a failure: no retry on a bigger model, and the ticket waits for the answer', async () => {
  const { w, ready } = busyWorld({ ...estimates, roles: { writer: { model: 'claude-sonnet-5-5' } }, limits: { ...estimates.limits, stepsPerTicket: 3 } });
  fs.rmSync(path.join(w.settings.state, 'tickets', '502.json'));
  w.tracker.cards.splice(1, 1);
  const calls = [];
  const spawnClaude = async (cmd) => {
    const stage = /Stage `(\w+)`/.exec(briefOf(cmd))[1];
    calls.push([stage, flag(cmd, '--model')]);
    const clients = w.clients();
    if (stage === 'start') {
      ready.placeId = LISTS.inProgress.id;
      await runRecord({ settings: w.settings, clients, key: '501', stage: 'start', status: 'done', card: ready.shortLink, result: { group: '501' }, now: NOW });
    }
    if (stage === 'plan') {
      ready.placeId = LISTS.blocked.id;
      await runRecord({ settings: w.settings, clients, key: '501', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', kind: 'fit', text: 'the block lists something else' }] }, now: NOW });
    }
    return { code: 0, stdout: RESULT() };
  };
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: {} });
  assert.deepEqual(calls, [['start', 'claude-sonnet-5-5'], ['plan', 'claude-sonnet-5-5']]);
  const l = read(w, '501');
  assert.equal(l.stage, 'questions');
  assert.equal(l.stages.plan, undefined);
  assert.deepEqual(l.runs.map((r) => [r.stage, r.outcome]), [['start', 'done'], ['plan', 'done']]);
});

test('the browser lock a session took is freed when the session ends, failed or not; another ticket\'s lock stays', async () => {
  for (const other of [false, true]) {
    const { w } = busyWorld({ ...estimates, limits: { ...estimates.limits, stepsPerTicket: 1 } });
    fs.rmSync(path.join(w.settings.state, 'tickets', '502.json'));
    w.tracker.cards.splice(1, 1);
    if (other) takeBrowserLock(w.settings.state, { ticket: '777', now: NOW });
    const seen = [];
    // The session takes the lock for its ticket (or finds it held), then dies without recording or freeing it.
    const spawnClaude = async () => {
      seen.push(takeBrowserLock(w.settings.state, { ticket: '501', now: NOW }).taken);
      return { code: 1, stdout: '' };
    };
    const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: {} });
    assert.ok(seen.length >= 1, 'a session ran');
    assert.deepEqual(out.starts.map((s) => s.steps.map((x) => x.outcome)), [['failed']]);
    const lock = browserLockState(w.settings.state, NOW);
    const log = fs.readFileSync(path.join(w.settings.state, 'runs', `${localDate(NOW)}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    if (other) {
      assert.deepEqual([seen.every((t) => t === false), lock.holder?.ticket], [true, '777'], 'another ticket\'s lock stays');
      assert.equal(log.filter((e) => e.kind === 'browserLock').length, 0);
    } else {
      assert.deepEqual([seen[0], lock.held], [true, false], 'freed after the session');
      assert.deepEqual(log.filter((e) => e.kind === 'browserLock').map((e) => [e.stage, e.outcome]).slice(0, 1), [['start', 'freed']]);
    }
  }
});

test('a session that ended on a busy browser lock waits: twice in a row, no failure counted, no bigger model, no hold', async () => {
  const { w, ready } = busyWorld({ ...estimates, roles: { writer: { model: 'claude-sonnet-5-5' } }, limits: { ...estimates.limits, stepsPerTicket: 2 } });
  fs.rmSync(path.join(w.settings.state, 'tickets', '502.json'));
  w.tracker.cards.splice(1, 1);
  takeBrowserLock(w.settings.state, { ticket: '777', now: NOW });
  const calls = [];
  const spawnClaude = async (cmd) => {
    const stage = /Stage `(\w+)`/.exec(briefOf(cmd))[1];
    calls.push([stage, flag(cmd, '--model')]);
    if (stage === 'start') {
      ready.placeId = LISTS.inProgress.id;
      await runRecord({ settings: w.settings, clients: w.clients(), key: '501', stage: 'start', status: 'done', card: ready.shortLink, result: { group: '501' }, now: NOW });
    } else {
      // `browser-lock.mjs take` gave up on the lock ticket 777 holds; the session ends without recording.
      const r = takeBrowserLock(w.settings.state, { ticket: '501', now: NOW });
      noteBusy(w.settings.state, { ticket: '501', holder: r.holder, now: NOW });
    }
    return { code: 0, stdout: RESULT() };
  };
  const run = () => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: {} });
  const first = await run();
  assert.deepEqual(first.starts.map((s) => s.steps.map((x) => [x.stage, x.outcome])), [[['start', 'done'], ['plan', 'busy']]]);
  await run();
  assert.deepEqual(calls, [['start', 'claude-sonnet-5-5'], ['plan', 'claude-sonnet-5-5'], ['plan', 'claude-sonnet-5-5']], 'once a check, never the next model up');
  const l = read(w, '501');
  assert.deepEqual(l.runs.filter((r) => r.stage === 'plan').map((r) => [r.outcome, r.model, r.failures ?? null, r.retryOf ?? null]), [['busy', 'claude-sonnet-5-5', null, null], ['busy', 'claude-sonnet-5-5', null, null]]);
  assert.notEqual(l.stages.plan?.status, 'failed', 'the stage is not recorded failed');
  const t = await w.one('501');
  assert.deepEqual([t.held ?? false, t.failed ?? null, t.next?.stage, t.next?.prior ?? null], [false, null, 'plan', null]);
  assert.deepEqual(fs.readdirSync(path.join(w.settings.state, '.playwright-busy')), [], 'the notes were read');
  assert.equal(proposeRoles([l], w.settings, NOW).proposals.length, 0);
});

test('a start session that ended on a busy browser lock leaves its start running, not failed: the next check starts it again on the same model', async () => {
  const { w } = busyWorld({ ...estimates, roles: { writer: { model: 'claude-sonnet-5-5' } } });
  fs.rmSync(path.join(w.settings.state, 'tickets', '502.json'));
  w.tracker.cards.splice(1, 1);
  takeBrowserLock(w.settings.state, { ticket: '777', now: NOW });
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push([/Stage `(\w+)`/.exec(briefOf(cmd))[1], flag(cmd, '--model')]);
    noteBusy(w.settings.state, { ticket: '501', holder: takeBrowserLock(w.settings.state, { ticket: '501', now: NOW }).holder, now: NOW });
    return { code: 0, stdout: RESULT() };
  };
  const run = () => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: {} });
  await run();
  assert.equal(read(w, '501').stages.start.status, 'running', 'the runner\'s own `running` stays: not recorded failed');
  await run();
  assert.deepEqual(calls, [['start', 'claude-sonnet-5-5'], ['start', 'claude-sonnet-5-5']]);
  const l = read(w, '501');
  assert.deepEqual(l.runs.map((r) => [r.stage, r.outcome, r.failures ?? null, r.retryOf ?? null]), [['start', 'busy', null, null], ['start', 'busy', null, null]]);
  const t = await w.one('501');
  assert.deepEqual([t.held ?? false, t.failed ?? null], [false, null]);
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
    ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done' }, startedBy: 'schedule', triage: { size: 'edit' } });
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

// The CLI's file rule forms, as the probes showed them: `**/` any folders, `**` anything, `*` within one name, and a
// positive character class (`[a-z]`); a rule starts `//` for an absolute path.
function fileDenied(tool, rules, file) {
  return rules.some((r) => {
    const m = new RegExp(`^${tool}\\(//(.*)\\)$`).exec(r);
    if (!m) return false;
    const re = m[1].match(/\*\*\/|\*\*|\*|\[[^\]]*\]|[^*[]+/g).map((x) => (x === '**/' ? '(?:.*/)?' : x === '**' ? '.*' : x === '*' ? '[^/]*' : x.startsWith('[') ? x : x.replace(/[.+?^${}()|\\]/g, '\\$&'))).join('');
    return new RegExp(`^/${re}$`).test(file);
  });
}

// The CLI's Bash rule forms, as the permission probes showed them: `x:*` a prefix, `*` elsewhere any text (a rule that
// ends in `:*` after a middle `*` never matches), else the exact command.
function matches(rule, cmd) {
  const body = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (body === undefined) return false;
  const prefix = /^([^*]*):\*$/.exec(body);
  if (prefix) return cmd === prefix[1] || cmd.startsWith(`${prefix[1]} `);
  if (/\*.*:\*$/.test(body)) return false;
  return new RegExp(`^${body.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(cmd);
}
const verdict = (cmd, allowed, denied) => (denied.some((r) => matches(r, cmd)) ? 'denied' : allowed.some((r) => matches(r, cmd)) ? 'allowed' : 'not allowed');

// What the owner's and a hub's settings layers allow today, besides the roles' own rules (a role session loads them all,
// and a deny in any layer wins): broad plain git, an interpreter, the forge CLI, `find`, an env prefix, a test runner.
const LAYERS = [
  'Bash(git status)', 'Bash(git status *)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git add *)', 'Bash(git commit:*)', 'Bash(git commit *)',
  'Bash(git branch:*)', 'Bash(git branch *)', 'Bash(git checkout:*)', 'Bash(git checkout *)', 'Bash(git switch:*)', 'Bash(git fetch:*)', 'Bash(git fetch *)', 'Bash(git pull:*)',
  'Bash(git push:*)', 'Bash(git stash:*)', 'Bash(git mv *)', 'Bash(git cherry-pick *)', 'Bash(git merge *)', 'Bash(git rev-list *)',
  'Bash(gh pr *)', 'Bash(gh auth *)', 'Bash(gh label:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(find:*)', 'Bash(mkdir:*)', 'Bash(rmdir:*)', 'Bash(npx playwright:*)', 'Bash(npx playwright *)',
  "Bash(python3 -c ' *)", 'Bash(python3 rebuild_catalog.py)', 'Bash(CORPUS=/corpus *)', 'Bash(node_modules/.bin/playwright test *)',
];
const WT = '/work/.worktrees/guide-docs/ticket-71';
const TREE = { repo: 'guide-docs', branch: 'ticket-71', base: 'main', path: WT };
const ROOTS = ['/runner/toolkit', '/home/.claude/plugins/cache/doc-writer-toolkit/doc-writer-toolkit/abc123'];
const rulesOf = (role, w, tree = role === 'triage' ? [] : [TREE], extra = {}) => {
  const cmd = commandFor({ stage: role === 'triage' ? 'triage' : 'write', role, keys: ['502'], group: '502', worktrees: tree }, w.settings, { agentsPath: '/x/agents.json', roots: ROOTS, ...extra });
  const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
  const after = cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1);
  const denied = after.slice(0, after.findIndex((a) => a.startsWith('--')) >>> 0);
  const addDirs = cmd.args.filter((a, i) => cmd.args[i - 1] === '--add-dir');
  return { cmd, allowed, denied, addDirs };
};

test('AC-2: every role allows its stage\'s git commands in both spellings, git -C only on its own worktree, and the brief\'s push only', () => {
  const { w } = busyWorld();
  // What each role's stages run on the ticket worktree (triage reads the target repos and has no worktree).
  const NEEDS = {
    triage: ['log', 'show', 'ls-tree'],
    writer: ['status', 'diff', 'log', 'show', 'worktree list', 'add', 'commit'],
    reviewer: ['status', 'diff', 'log', 'show', 'worktree list', 'add', 'commit'],
    translator: ['status', 'diff', 'log', 'show', 'worktree list', 'add', 'commit'],
  };
  const PLAIN = ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git push --force-if-includes:*)', 'Bash(git push --no-verify:*)', 'Bash(git push --mirror:*)', 'Bash(git push --delete:*)', 'Bash(git push -d:*)'];
  for (const [role, subs] of Object.entries(NEEDS)) {
    const tree = role === 'triage' ? [] : [TREE];
    const { allowed, denied } = rulesOf(role, w);
    for (const sub of subs) {
      // A plain change would land in the folder the session is in, the hub's checkout to begin with: reads only.
      assert.equal(verdict(`git ${sub} -q`, allowed, denied), ['add', 'commit'].includes(sub) ? 'denied' : 'allowed', `${role}: git ${sub}`);
      assert.equal(verdict(`git -C ${WT} ${sub} -q`, allowed, denied) === 'allowed', tree.length > 0, `${role}: git -C <worktree> ${sub}`);
    }
    // No wildcard folder in an allow rule, and no push but the brief's, on the worktree.
    assert.ok(!allowed.some((r) => r.includes('git -C *') || /^Bash\(git push/.test(r)), role);
    assert.equal(verdict(`git -C ${WT} push origin HEAD:refs/heads/ticket-71`, allowed, denied) === 'allowed', tree.length > 0, `${role}: the brief's push`);
    // A fetch: `git -C <worktree> fetch origin`, or the worktree's branch and base by name; never plain, never a refspec.
    for (const f of [`git -C ${WT} fetch origin`, `git -C ${WT} fetch origin ticket-71`, `git -C ${WT} fetch origin main`]) assert.equal(verdict(f, allowed, denied) === 'allowed', tree.length > 0, `${role}: ${f}`);
    // A commit message may name any flag: the `-C` denials name the worktree, so the word after it is the subcommand.
    if (tree.length) for (const msg of [`git -C ${WT} commit -m "Document the git branch -D option"`, `git -C ${WT} commit -m "Add the branch list" -m "Second paragraph"`, `git -C ${WT} commit -m "Say why git push --force is denied"`]) assert.equal(verdict(msg, allowed, denied), 'allowed', `${role}: ${msg}`);
    // The reviewer's probes: another subcommand with an allowed word later in the command, another folder, a force
    // push or a deletion in any place, another branch, a fetch refspec.
    for (const bad of [
      `git -C ${WT} tag -d probe-tag status`, `git -C ${WT} clean -fdx -e status`, `git -C ${WT} reset --hard HEAD~1 commit`, 'git -C /work/another-clone status',
      `git -C ${WT} push origin +HEAD:refs/heads/ticket-71`, `git -C ${WT} push origin --force HEAD:refs/heads/ticket-71`, `git -C ${WT} push origin -f HEAD:refs/heads/ticket-71`,
      `git -C ${WT} push origin --force-with-lease HEAD:refs/heads/ticket-71`, `git -C ${WT} push origin --delete ticket-71`, `git -C ${WT} push origin :refs/heads/ticket-71`,
      `git -C ${WT} push origin HEAD:refs/heads/main`, `git -C ${WT} fetch origin +refs/heads/main:refs/heads/other`, `git -C ${WT} fetch origin main:other`, 'git fetch --all',
      // git grep runs a command; --output writes a file past the Edit denials.
      'git grep -Osh x', 'git grep --open-files-in-pager=sh x', `git -C ${WT} grep -Osh x`, `git -C ${WT} grep --open=sh x`,
      `git -C ${WT} log --output=/home/.claude/settings.json`, `git -C ${WT} diff --output /hub/.git/info/attributes`, 'git show HEAD --output=/x', 'git log -1 --output /x',
    ]) assert.notEqual(verdict(bad, allowed, denied), 'allowed', `${role}: ${bad}`);
    for (const rule of [...PLAIN, 'Bash(npm ci:*)', 'Bash(npm install:*)', 'Bash(ln:*)']) assert.ok(denied.includes(rule), `${role} denies ${rule}`);
    assert.ok(!denied.some((r) => r.includes('git -C *')), `${role}: no wildcard folder in a deny rule either`);
    assert.ok(!allowed.some((r) => /worktree (add|remove|move|prune)|Bash\(git worktree:\*\)/.test(r)), role);
    assert.ok(![...allowed, ...denied].some((r) => /^Bash\(.*\*.*:\*\)$/.test(r) && !/^Bash\([^*]*:\*\)$/.test(r)), `${role}: no rule the CLI never matches`);
  }
  assert.ok(PLAIN.every((r) => PUSH_DENIED.includes(r) && PUSH_DENIED_PLAIN.includes(r)), 'PUSH_DENIED keeps its rules');
});

test('AC-3, AC-7: with the owner\'s and the hub\'s layers loaded, every plain-spelling change and every way to run code of its own is denied; each stage\'s own commands still run', () => {
  const { w } = busyWorld();
  const R = ROOTS[1];
  const script = (s, args = '') => `node ${R}/scripts/${s}${args}`;
  // Each stage's own commands, by role (the scripts from both roots: the runner's and the installed plugin's).
  const OWN = {
    triage: [`node ${ROOTS[0]}/scripts/tracker/tracker.mjs read-card abc`, `node ${ROOTS[0]}/scripts/ticket-state/ticket-state.mjs record 502 --stage triage`, `node ${ROOTS[0]}/scripts/ticket-state/ticket-state.mjs status --root /hub --ticket 502`, `node ${R}/scripts/ticket-state/ticket-state.mjs config --root /hub`, 'git log -1', 'ls docs'],
    writer: [script('tracker/tracker.mjs', ' move abc --to inProgress'), script('forge/forge.mjs', ' open-pr --repo guide-docs'), script('ui-labels/ui-labels.mjs', ' check'), script('screenshot-locales/screenshot-locales.mjs', ' paths docs/x'), script('video-parts/video-parts.mjs', ' --root /hub'), script('ticket-state/browser-lock.mjs', ' take --root /hub'), script('ticket-state/ticket-state.mjs', ' record 502 --stage write'), `git -C ${WT} add -A`, `git -C ${WT} commit -m "Write the page"`, `git -C ${WT} push origin HEAD:refs/heads/ticket-71`, `git -C ${WT} fetch origin`, 'npx playwright test scenario.spec.ts', 'mkdir -p docs/x/.assets'],
    reviewer: [script('visual-pack/visual-pack.mjs', ' --base main'), script('ticket-state/ticket-state.mjs', ' record 502 --stage uaReview'), `git -C ${WT} diff origin/main`, `git -C ${WT} commit -m "Fix the style"`, `git -C ${WT} push origin HEAD:refs/heads/ticket-71`],
    translator: [script('locale-sync/locale-sync.mjs', ' status'), script('screenshot-locales/screenshot-locales.mjs', ` pairs --root ${WT} --base origin/main`), script('doc-align/doc-align.mjs', ' a.md b.md'), script('ui-labels/ui-labels.mjs', ' check --root /hub'), 'npm run build', 'npx docusaurus build', `git -C ${WT} add -A`, `git -C ${WT} push origin HEAD:refs/heads/ticket-71`],
  };
  const BAD = [
    // Plain-spelling changes, after a `cd` (the reviewer's four, and the rest).
    'git push origin HEAD:refs/heads/zz', 'git push origin :refs/heads/victim', 'git push origin HEAD:refs/heads/ticket-71', 'git push', 'git fetch origin +refs/heads/main:refs/heads/other', 'git fetch origin',
    'git branch --del other2', 'git branch -rD other', 'git branch --list', 'git stash', 'git stash pop', 'git cherry-pick abc', 'git mv a.md b.md', 'git checkout main', 'git merge other', 'git tag v1', 'git config core.hooksPath /tmp/h', 'git rm a.md', 'git clean -fdx',
    `git -C ${WT} branch --del other2`, `git -C ${WT} branch -rD other`,
    // Code of its own: node by string, standard input or a file it wrote; the other interpreters; the forge CLI.
    'node -e "1"', 'node -p "1"', 'node --eval "1"', 'node --print "1"', 'node', 'node /tmp/mine.mjs', `node --require /tmp/x.js ${R}/scripts/tracker/tracker.mjs`, `node --import /tmp/x.mjs ${R}/scripts/tracker/tracker.mjs`,
    `NODE_OPTIONS=--require=/tmp/x.js node ${R}/scripts/tracker/tracker.mjs`, "python3 -c 'print(1)'", 'python3 rebuild_catalog.py', 'sh -c "id"', 'bash -c "id"', 'zsh -c "id"', "perl -e 'print 1'", 'osascript -e "beep"',
    'npx some-package', 'node_modules/.bin/playwright test x.spec.ts', 'CORPUS=/corpus node -e "1"', 'CORPUS=/corpus touch /tmp/x', 'find . -exec touch /tmp/x {} ;', 'find . -name x -delete', 'xargs -I{} sh -c {}', 'env node -e 1',
    'gh pr merge 71', 'gh api -X DELETE repos/o/r/git/refs/heads/x', 'gh repo delete o/r', 'curl -X DELETE https://api.example.com',
    // Plain add and commit: a session starts in the hub, an owner's checkout.
    'git add -A', 'git add docs/x.md', 'git commit -m x', 'git commit --amend --no-edit',
    // The owner's commands of ticket-state (`set` would widen the next session's rules), from either root.
    script('ticket-state/ticket-state.mjs', ' set roles.writer.allowedTools \'["Bash(node:*)"]\''), script('ticket-state/ticket-state.mjs', ' set mode on'), script('ticket-state/ticket-state.mjs', ' set retry all'),
    `node ${ROOTS[0]}/scripts/ticket-state/ticket-state.mjs set cleanup.mode delete`, script('ticket-state/ticket-state.mjs', ' handover 502'), script('ticket-state/ticket-state.mjs', ' unlock --stale'), script('ticket-state/ticket-state.mjs', ' import'), script('ticket-state/ticket-state.mjs', ' report'),
    // Script flags that run code.
    script('ui-labels/ui-labels.mjs', " import --source 'command sh -c id'"), script('ui-labels/ui-labels.mjs', " --source='command id' import"), script('ui-labels/ui-labels.mjs', " check --root /hub --source 'command id'"), script('ui-labels/ui-labels.mjs', ' --source=x'),
    script('visual-pack/visual-pack.mjs', ' --base main --playwright-from /tmp/pw'), script('visual-pack/visual-pack.mjs', ' --playwright-from=/tmp/pw --base main'), `node ${ROOTS[0]}/scripts/visual-pack/visual-pack.mjs --playwright-from /tmp/pw`,
  ];
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const { allowed, denied } = rulesOf(role, w);
    const wide = [...allowed, ...LAYERS];
    for (const c of OWN[role]) assert.equal(verdict(c, wide, denied), 'allowed', `${role} runs ${c}`);
    for (const c of BAD) assert.notEqual(verdict(c, wide, denied), 'allowed', `${role}: ${c}`);
    // Playwright only where the role file allows it (a hub allows `npx playwright:*` to every session).
    assert.equal(verdict('npx playwright test x.spec.ts', wide, denied), role === 'writer' ? 'allowed' : 'denied', `${role}: npx playwright`);
    // The tracker's MCP tools are denied as a whole server.
    assert.ok(['mcp__claude_ai_Trello', 'mcp__trello', 'mcp__playwright'].every((m) => denied.includes(m)), role);
    // A file that widens the session's rules, runs code at the next git command, or is the flow's own state.
    const st = (f) => `//${path.join(w.settings.state, f).slice(1)}`;
    for (const e of [
      'Edit(~/.claude/**)', 'Edit(~/.claude.json)', 'Edit(//**/.claude/**)', 'Edit(//**/.git/**)', 'Edit(//**/.git)', 'Edit(//**/package.json)', `Edit(//${ROOTS[0].slice(1)}/**)`, `Edit(//${ROOTS[1].slice(1)}/**)`,
      ...['tickets', 'locks', 'roles', 'watch', 'jobs', 'runs', 'reports'].map((d) => `Edit(${st(d)}/**)`), `Edit(${st('rearmed.json')})`, `Edit(${st('roles-proposal.json')})`,
      // What runs code later, and the flow's settings wherever they are.
      'Edit(//**/.github/**)', 'Edit(//**/CLAUDE*.md)', 'Edit(//**/node_modules/**)', 'Edit(//**/.npmrc)', 'Edit(~/.gitconfig)', 'Edit(~/.config/git/**)', 'Edit(~/.ssh/**)', 'Edit(~/Library/LaunchAgents/**)',
      ...['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile'].map((f) => `Edit(~/${f})`),
      `Edit(//${path.resolve(w.settings.root, w.settings.file).slice(1)})`, `Edit(//${path.resolve(w.settings.root, w.settings.file).replace(/\.json$/, '.local.json').slice(1)})`,
    ]) assert.ok(denied.includes(e), `${role} denies ${e}`);
    // .env files are not read; .env.example, which holds no values, is.
    for (const f of ['.env', '.env.local', '.env.production.local', '.env.development', '.env.production', '.env.test', '.env.staging', '.env.dev', '.env.prod']) assert.ok(fileDenied('Read', denied, `/work/repo/${f}`), `${role} doesn't read ${f}`);
    assert.ok(!fileDenied('Read', denied, '/work/repo/.env.example'), `${role} reads .env.example`);
    assert.ok(!denied.some((e) => e.includes(`${path.join(w.settings.state, 'tmp')}`)), `${role}: the session's own files in <state>/tmp stay writable`);
    // A layer that allows `node` itself (no layer does today): code from a string, standard input or a preload stays
    // denied, and the stage's scripts still run.
    const anyNode = [...wide, 'Bash(node:*)', 'Bash(node *)'];
    for (const c of ['node -e "1"', 'node -p "1"', 'node --eval "1"', 'node --print "1"', 'node', 'node -', `node -r /tmp/x.js ${R}/scripts/tracker/tracker.mjs`, `node --require /tmp/x.js ${R}/scripts/tracker/tracker.mjs`, `node --import /tmp/x.mjs ${R}/scripts/tracker/tracker.mjs`, `NODE_OPTIONS=--require=/tmp/x.js node ${R}/scripts/tracker/tracker.mjs`]) assert.equal(verdict(c, anyNode, denied), 'denied', `${role} with node allowed: ${c}`);
    for (const c of OWN[role].filter((x) => x.startsWith('node '))) assert.equal(verdict(c, anyNode, denied), 'allowed', `${role} with node allowed runs ${c}`);
    // A layer that allows `git -C *` (none does today) reopens other folders, but not a branch change on the worktree,
    // an abbreviation or combined flags included, or a `git grep`, which runs a command.
    if (role !== 'triage') for (const c of [`git -C ${WT} branch --del other2`, `git -C ${WT} branch -rD other`, `git -C ${WT} branch new-one`, `git -C ${WT} grep -Osh x`, `git -C ${WT} grep --open=sh x`]) assert.equal(verdict(c, [...wide, 'Bash(git -C *)'], denied), 'denied', `${role} with git -C * allowed: ${c}`);
  }
  // A step with no worktree changes no repo: no plain add or commit; it reads the target clones (its --add-dir).
  const plan = rulesOf('writer', w, []);
  for (const c of ['git add -A', 'git commit -m x']) assert.equal(verdict(c, [...plan.allowed, ...LAYERS], plan.denied), 'denied', `plan: ${c}`);
  assert.deepEqual(plan.addDirs, [...new Set(w.settings.targets.filter((t) => t.path).map((t) => path.resolve(w.settings.root, t.path))), ...ROOTS]);
  // A step with worktrees reaches them and the toolkit roots, not the target clones (a `cd` outside the add-dirs is denied).
  assert.deepEqual(rulesOf('writer', w).addDirs, [WT, ...ROOTS]);
});

test('on a step with worktrees, the target clones\' content roots are not writable; their dot folders, the state and the worktree are', () => {
  const { w } = busyWorld();
  const clone = path.resolve(w.root, 'repos/guide-docs');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'CLAUDE.md'), '# Site\n\n## Documentation toolkit configuration\n\n- **UA content root:** `docs/`\n- **EN i18n root:** `i18n/en/docusaurus-plugin-content-docs/current/`\n- **API reference UA content root:** `api/`\n- **API reference EN i18n root:** `i18n/en/docusaurus-plugin-content-docs-api/current/`\n\n## Other\n\n- **UA content root:** `ignored/`\n');
  // The hub is a target too, its UA root the default `docs/`, with the flow's state in `docs/.sources/`.
  w.settings.targets.push({ id: 'hub', repo: 'hub-docs', path: '.', review: 'sme', labels: {} });
  w.settings.state = path.join(w.root, 'docs/.sources/ticket-pipeline');
  const { denied } = rulesOf('writer', w);
  const at = (base, rel) => path.join(base, rel);
  for (const f of [at(clone, 'docs/a.md'), at(clone, 'docs/x/y.mdx'), at(clone, 'docs/x/.assets/a.png'), at(clone, 'docs/_category_.json'), at(clone, 'api/a.md'), at(clone, 'i18n/en/docusaurus-plugin-content-docs/current/a.md'), at(clone, 'i18n/de/docusaurus-plugin-content-docs/current/a.md'), at(w.root, 'docs/page.md'), at(w.root, 'docs/Zz-1/a.md')]) {
    assert.ok(fileDenied('Edit', denied, f), `not writable: ${f}`);
  }
  for (const f of [at(w.root, 'docs/.sources/ticket-pipeline/tmp/comment.md'), at(w.root, 'docs/.sources/tickets/502/notes.md'), at(WT, 'docs/a.md'), at(w.root, 'README.md'), at(clone, 'ignored/a.md')]) {
    assert.ok(!fileDenied('Edit', denied, f), `writable: ${f}`);
  }
  // A step with no worktree writes no page and gets no checkout rule.
  assert.ok(!fileDenied('Edit', rulesOf('writer', w, []).denied, at(clone, 'docs/a.md')));
  // A UA root that holds the state under a name the rule would cover stays writable (record write still checks).
  w.settings.state = path.join(w.root, 'docs/pipeline');
  const held = rulesOf('writer', w).denied;
  assert.ok(!fileDenied('Edit', held, at(w.root, 'docs/pipeline/tmp/comment.md')));
  assert.ok(fileDenied('Edit', held, at(clone, 'docs/a.md')), 'the other clones keep theirs');
});

test('the video gate: the writer runs video-parts by its path, from either root, and never ffmpeg or ffprobe itself, plain, after a cd or by a full path', () => {
  const { w } = busyWorld();
  const { allowed, denied } = rulesOf('writer', w);
  const wide = [...allowed, ...LAYERS];
  // A call with shell operators: the CLI checks each command in it, and runs it only when every one is allowed.
  const verdictOfCall = (call, a, d) => {
    const v = call.split(/\s*(?:&&|\|\||;|\|)\s*/).map((c) => verdict(c, a, d));
    return v.includes('denied') ? 'denied' : v.every((x) => x === 'allowed') ? 'allowed' : 'not allowed';
  };
  const work = 'docs/x/.sources/tickets/502';
  for (const r of ROOTS) {
    for (const c of [`node ${r}/scripts/video-parts/video-parts.mjs --root /hub --work ${work} --video ${work}/call.mp4`, `node ${r}/scripts/video-parts/video-parts.mjs --root /hub --settings /hub/flow.json --work ${work} --video ${work}/call.mp4 --transcript-name {part}-transcript.txt --dry-run`]) {
      assert.equal(verdict(c, wide, denied), 'allowed', c);
    }
  }
  // By hand: denied even under a layer that allows them (the owner's has allowed single ffprobe calls); after a `cd`
  // (its own call, which the writer may make) the same command; in one call with the `cd`, the `ffmpeg` part is denied.
  const byHand = [`ffmpeg -i ${work}/call.mp4 -ss 0 -t 1800 ${work}/a.m4a`, `ffprobe -v error -show_entries format=duration ${work}/call.mp4`, 'ffmpeg -i call.mp4 -ss 0 -t 1800 a.m4a', 'ffprobe call.mp4', 'ffmpeg', 'ffprobe'];
  const mediaLayer = [...wide, 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(ffmpeg *)', 'Bash(ffprobe *)', 'Bash(ffmpeg -i "/hub/docs/x/.sources/call.mp4")'];
  assert.equal(verdict(`cd ${work}`, wide, denied), 'allowed');
  for (const c of byHand) for (const layers of [wide, mediaLayer]) assert.equal(verdict(c, layers, denied), 'denied', c);
  assert.equal(verdict('ffmpeg -i "/hub/docs/x/.sources/call.mp4"', mediaLayer, denied), 'denied');
  for (const c of [`cd ${work} && ffmpeg -i call.mp4 a.m4a`, `cd ${work}; ffprobe call.mp4`]) assert.equal(verdictOfCall(c, mediaLayer, denied), 'denied', c);
  // A full path or another way in is allowed by no rule; nor is the script by another path, or with a preload.
  for (const c of ['/opt/homebrew/bin/ffmpeg -i call.mp4 a.m4a', '/usr/local/bin/ffprobe call.mp4', './ffmpeg -i call.mp4 a.m4a', 'npx ffmpeg -i call.mp4 a.m4a', 'node scripts/video-parts/video-parts.mjs --work x --video x/v.mp4', `node ${ROOTS[0]}/scripts/video-parts/../tracker/../../x.mjs`, `node ${ROOTS[0]}/scripts/video-parts/video-parts.mjs/../../x.mjs`, `node ${ROOTS[1]}/scripts/video-parts/video-parts.mjs/../../../../../tmp/mine.mjs --work x`, `node ${ROOTS[0]}/scripts/video-parts/video-parts.mjs.bak`, `node --require /tmp/x.js ${ROOTS[0]}/scripts/video-parts/video-parts.mjs`]) {
    assert.notEqual(verdict(c, wide, denied), 'allowed', c);
  }
  // Every role has the same denial.
  for (const role of ['triage', 'reviewer', 'translator']) assert.ok(['Bash(ffmpeg:*)', 'Bash(ffprobe:*)'].every((r) => rulesOf(role, w).denied.includes(r)), role);
});

test('the browser lock: the writer takes and frees it with the script, from either root, and can\'t remove or move the folder itself', () => {
  const { w } = busyWorld();
  const { allowed, denied } = rulesOf('writer', w);
  const wide = [...allowed, ...LAYERS];
  for (const r of ROOTS) for (const c of ['take', 'free', 'status']) assert.equal(verdict(`node ${r}/scripts/ticket-state/browser-lock.mjs ${c} --root /hub --ticket 502`, wide, denied), 'allowed', `${r}: ${c}`);
  const lock = path.join(w.settings.state, '.playwright.lock');
  for (const c of [`rm -rf ${lock}`, `rmdir ${lock}`, `mv ${lock} /tmp/x`, `mv ${lock} ${lock}.old`, `node ${ROOTS[0]}/scripts/ticket-state/browser-lock.mjs/../../x.mjs`, 'node scripts/ticket-state/browser-lock.mjs free --ticket 502']) assert.notEqual(verdict(c, wide, denied), 'allowed', c);
  // A lock with no holder, or a forged holder: denied even where a host layer allows `mkdir`, `mv` and `rmdir` outright.
  const loose = [...wide, 'Bash(mkdir:*)', 'Bash(mv:*)', 'Bash(rmdir:*)'];
  for (const c of [`mkdir ${lock}`, `mkdir -p ${lock}`, 'mkdir .playwright.lock', 'mkdir -p .playwright.lock', `mv /tmp/x ${lock}`, `rmdir ${lock}`, 'mv a b', 'rmdir x']) assert.equal(verdict(c, loose, denied), 'denied', c);
  assert.equal(verdict('mkdir -p .sources/frames', loose, denied), 'allowed', 'other folders stay as the host has them');
  const st = (f) => `//${path.join(w.settings.state, f).slice(1)}`;
  for (const d of ['.playwright.lock', '.playwright-busy']) for (const e of [`Edit(${st(d)})`, `Edit(${st(d)}/**)`]) assert.ok(denied.includes(e), e);
});

test('the toolkit roots a session may run scripts from: the runner\'s, and each install of the plugin the hub loads', () => {
  const { w } = busyWorld();
  const home = tmp('home-');
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'doc-writer-toolkit@doc-writer-toolkit': [
      { scope: 'user', installPath: '/c/doc-writer-toolkit/u1' },
      { scope: 'project', projectPath: w.settings.root, installPath: '/c/doc-writer-toolkit/p1' },
      { scope: 'project', projectPath: '/elsewhere', installPath: '/c/doc-writer-toolkit/other' },
    ],
    'another@market': [{ scope: 'user', installPath: '/c/another' }],
  } }));
  assert.deepEqual(scriptRoots(w.settings, { home, env: {} }), [PLUGIN_ROOT, '/c/doc-writer-toolkit/u1', '/c/doc-writer-toolkit/p1']);
  assert.deepEqual(scriptRoots(w.settings, { home: tmp('nohome-'), env: {} }), [PLUGIN_ROOT], 'no list: the runner\'s own root');
  // Each root gives each script by its literal path, as a prefix rule: never a wildcard that `../` could walk out of.
  const rules = scriptRulesFor(['/c/doc-writer-toolkit/u1']);
  for (const sub of ['record', 'status', 'config']) assert.ok(rules.includes(`Bash(node /c/doc-writer-toolkit/u1/scripts/ticket-state/ticket-state.mjs ${sub}:*)`), sub);
  for (const c of ['set mode on', 'set roles.writer.allowedTools x', 'handover 502', 'lock 502', 'import', '']) assert.equal(verdict(`node /c/doc-writer-toolkit/u1/scripts/ticket-state/ticket-state.mjs ${c}`.trim(), rules, []), 'not allowed', `ticket-state ${c}`);
  assert.ok(rules.every((r) => !r.slice(0, -3).includes('*')));
  assert.equal(verdict('node /c/doc-writer-toolkit/u1/scripts/../../../../tmp/x.mjs', rules, []), 'not allowed');
});

test('AC-5: a host job can\'t push, change a branch or fetch, in the plain or git -C spelling (unquoted), with a broad git allow list', () => {
  // Settings validation refuses a bare git prefix now (role-hook.test.mjs); the denials are still there under one that slips through.
  const w = world();
  const { args } = jobCommand({ name: 'notes', every: 60, run: { skill: 'notes-writer', allowedTools: ['Bash(git:*)', 'Bash(git *)', 'Bash(git -C *)'] } }, { settings: w.settings });
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const c of ['git branch -D other', 'git branch -m own own2', 'git -C /any branch -D other', 'git -C /any branch -m own own2', 'git fetch origin +refs/heads/main:refs/heads/other', 'git fetch origin main:other', 'git -C /any fetch origin main:other', 'git -C /any fetch', 'git push --force origin x', 'git -C /any push -f origin x',
    // No push at all: a `:<branch>` push deletes a remote branch, and no rule tells it from another push.
    'git push origin :refs/heads/victim', 'git push origin HEAD:refs/heads/x', 'git push', 'git -C /any push origin :x', 'git -C /any push',
    // The roles' git, code and file denials.
    'git add -A', 'git commit -m x', 'git grep -Osh x', 'git log --output=/x', 'git stash', 'git mv a b']) {
    assert.equal(verdict(c, allowed, denied), 'denied', c);
  }
  assert.equal(verdict('git status', allowed, denied), 'allowed', 'its own reads still run');
  for (const e of ['Bash(node -e:*)', 'Bash(python3:*)', 'Bash(sh:*)', 'Edit(//**/.git/**)', 'Edit(//**/.github/**)', 'Edit(//**/.claude/**)', 'Edit(//**/CLAUDE*.md)']) assert.ok(denied.includes(e), `a job denies ${e}`);
  assert.ok(!denied.some((r) => r.startsWith('mcp__')), 'a job may use its tracker through MCP');
  assert.ok(!denied.some((r) => /^Bash\(.*\*.*:\*\)$/.test(r) && !/^Bash\([^*]*:\*\)$/.test(r)), 'no rule the CLI never matches');
});

test('a role session loads the hub\'s layers, not the owner\'s, and no plugin from the toolkit it runs', () => {
  const { w } = busyWorld();
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const { cmd } = rulesOf(role, w);
    assert.equal(flag(cmd, '--setting-sources'), 'project,local', role);
    assert.ok(!cmd.args.includes('--plugin-dir'), `${role}: the plugin comes from the hub's own enabledPlugins, at the version the hub installed`);
  }
});

test('writes are an allow list: a role\'s worktrees and the state tmp/, with no unscoped file-writing rule', () => {
  const unscoped = ['Write', 'Edit', 'Edit(**)', 'NotebookEdit', 'MultiEdit', 'Write(*)', 'Edit(//**)', 'Edit(/**)', 'Edit(~/**)', 'Edit(./**)', 'Write(//**)'];
  const { w } = busyWorld({ roles: { writer: { allowedTools: [...unscoped, 'Edit(//owner/chose/this/**)'] } } });
  for (const r of unscoped) assert.ok(!rulesOf('writer', w).allowed.includes(r), `${r} is dropped`);
  const tmpRule = `Edit(/${path.join(w.settings.state, 'tmp')}/**)`;
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    assert.ok(!readRole(role).allowedTools.some((r) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(r)), `${role}.md allows no file-writing tool by itself`);
    const { allowed } = rulesOf(role, w);
    assert.deepEqual(allowed.filter((r) => /^(Edit|Write|MultiEdit|NotebookEdit)$|^(Edit|Write)\(\*{1,2}\)$/.test(r)), [], `${role} has no unscoped write`);
    assert.ok(allowed.includes(tmpRule), `${role} may write the state tmp/`);
  }
  assert.ok(rulesOf('writer', w).allowed.includes(`Edit(/${WT}/**)`));
  assert.ok(rulesOf('translator', w).allowed.includes(`Edit(/${WT}/**)`));
  assert.ok(rulesOf('writer', w).allowed.includes('Edit(//owner/chose/this/**)'), 'a scoped rule an owner adds stays');
  assert.deepEqual(rulesOf('triage', w).allowed.filter((r) => r.startsWith('Edit(')), [tmpRule], 'triage writes only in tmp/');
});

test('writes: each ticket\'s work folder when the host declares one; a step with no worktree reaches the clones\' .sources/ and its own specs, never their pages', () => {
  const { w } = busyWorld();
  const settings = { ...w.settings, workFolder: 'work/tickets/<key>' };
  const work = `Edit(/${path.join(w.root, 'work/tickets/502')}/**)`;
  const at = (role, tree, keys = ['502']) => commandFor({ stage: 'x', role, keys, group: '502', worktrees: tree }, settings, { agentsPath: '/x/agents.json', roots: ROOTS }).args;
  const edits = (args) => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')).filter((r) => r.startsWith('Edit('));
  const clones = [...new Set(settings.targets.map((t) => path.resolve(settings.root, t.path)))];
  const sources = clones.flatMap((c) => [`Edit(/${c}/**/.sources/**)`, `Edit(/${c}/screenshot-tests/_plan-502-*)`]);
  assert.ok(sources.length > 0);
  // On a worktree step: the worktree, tmp/ and the work folder, and no clone at all.
  assert.ok(edits(at('reviewer', [TREE])).includes(work));
  assert.deepEqual(edits(at('reviewer', [TREE])).filter((r) => r.includes('.sources') || r.includes('screenshot-tests')), []);
  // With no worktree: the work folder and each clone's .sources/.
  for (const r of [work, ...sources]) assert.ok(edits(at('writer', [])).includes(r), r);
  assert.deepEqual(edits(at('triage', [])), [`Edit(/${path.join(settings.state, 'tmp')}/**)`], 'triage has no work folder, no .sources/ and no spec');
  // A group: one folder per ticket. A key that isn't a plain name gets none.
  assert.ok(edits(at('writer', [], ['502', '503'])).includes(`Edit(/${path.join(w.root, 'work/tickets/503')}/**)`));
  assert.ok(!edits(at('writer', [], ['../..'])).some((r) => r.includes('tickets')));
  // The brief says where.
  const brief = briefFor({ stage: 'write', role: 'writer', keys: ['502'], worktrees: [TREE] }, settings);
  assert.match(brief, new RegExp(`only in: ${WT}, .*/tmp, .*work/tickets/502\\.`));
  assert.doesNotMatch(brief, /other write/, 'a host layer may allow more, so the brief says where to write, not what is refused');
  assert.match(briefFor({ stage: 'plan', role: 'writer', keys: ['502'] }, settings), /and the `\.sources\/` folders of the target repos/);
  assert.doesNotMatch(briefFor({ stage: 'triage', role: 'triage', keys: ['502'] }, settings), /\.sources\/` folders/);
});

test('a step with no worktree may create only its own specs: one rule per key per clone, the hub target included, and the brief names the file', () => {
  const { w } = busyWorld();
  const settings = { ...w.settings, targets: [...w.settings.targets, { ...w.settings.targets[0], id: 'the-hub', path: '.' }] };
  const clones = [...new Set(settings.targets.map((t) => path.resolve(settings.root, t.path)))];
  assert.ok(clones.includes(w.root), 'the hub is a target here');
  const specs = (role, keys, tree = []) => {
    const a = commandFor({ stage: 'plan', role, keys, group: 'g', worktrees: tree }, settings, { agentsPath: '/x/agents.json', roots: ROOTS }).args;
    return a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools')).filter((r) => r.includes('screenshot-tests'));
  };
  assert.deepEqual(specs('writer', ['502']).sort(), clones.map((c) => `Edit(/${c}/screenshot-tests/_plan-502-*)`).sort());
  // A group, and a key that is no number. A key that isn't a plain name gets no rule, and the brief offers no name for it.
  assert.deepEqual(specs('writer', ['d98', '503', '../x', 'a*b', 'a/b']).sort(), clones.flatMap((c) => [`Edit(/${c}/screenshot-tests/_plan-d98-*)`, `Edit(/${c}/screenshot-tests/_plan-503-*)`]).sort());
  assert.deepEqual(specs('writer', ['../x']), []);
  assert.ok(!specs('writer', ['502']).some((r) => r.includes('screenshot-tests/**')), 'never the whole folder');
  // Not triage, and not a step with a worktree, whose specs go in the worktree.
  assert.deepEqual(specs('triage', ['502']), []);
  assert.deepEqual(specs('writer', ['502'], [TREE]), []);
  const brief = (step) => briefFor({ stage: 'plan', role: 'writer', ...step }, settings);
  assert.match(brief({ keys: ['502'] }), /named `_plan-502-<what>\.spec\.ts`\. Use that name, import shared helpers from that folder rather than editing them/);
  assert.match(brief({ keys: ['d98', '503'] }), /`_plan-d98-<what>\.spec\.ts` or `_plan-503-<what>\.spec\.ts`/);
  assert.doesNotMatch(brief({ keys: ['../x'] }), /_plan-/);
  assert.doesNotMatch(brief({ keys: ['502'], worktrees: [TREE] }), /_plan-/);
  assert.doesNotMatch(briefFor({ stage: 'triage', role: 'triage', keys: ['502'] }, settings), /_plan-/);
  assert.match(readRole('writer').prompt, /`_plan-<key>-<what>\.spec\.ts`/);
});

test('the deny lists stay as a mistake guard: what runs code later is denied inside a worktree the allow list opens, and git ls-remote is denied', () => {
  const { w } = busyWorld();
  for (const role of ['writer', 'reviewer', 'translator']) {
    const { denied } = rulesOf(role, w);
    for (const r of ['Edit(//**/.github/**)', 'Edit(//**/CLAUDE*.md)', 'Edit(//**/node_modules/**)', 'Edit(//**/package.json)', 'Edit(//**/package-lock.json)', 'Edit(//**/docusaurus.config.*)', 'Edit(//**/sidebars.*)', 'Edit(//**/playwright.config.*)', 'Edit(//**/.git/**)', 'Edit(//**/.claude/**)']) assert.ok(denied.includes(r), `${role} denies ${r}`);
    assert.ok(denied.includes('Bash(git ls-remote:*)'), 'it runs a command: --upload-pack=<cmd>');
    assert.ok(denied.includes(`Edit(/${w.settings.state}/*.md)`), 'the Markdown ledgers, which a state folder under a .sources/ would open');
  }
});

test('the command line follows the role settings; the retry takes the next model up the ladder', () => {
  const { w } = busyWorld({ roles: { reviewer: { model: 'claude-haiku-5-5', effort: 'low', maxTurns: 30, maxBudgetUsd: 2, disallowedTools: ['WebFetch'] } } });
  const cmd = commandFor({ stage: 'uaReview', role: 'reviewer', keys: ['502'], group: '502' }, w.settings, { agentsPath: '/x/agents.json' });
  assert.deepEqual([flag(cmd, '--model'), flag(cmd, '--effort'), flag(cmd, '--max-turns'), flag(cmd, '--max-budget-usd'), flag(cmd, '--agent')], ['claude-haiku-5-5', 'low', '30', '2', 'ticket-reviewer']);
  assert.ok(cmd.args.slice(cmd.args.indexOf('--disallowedTools')).includes('WebFetch'));
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const denied = commandFor({ stage: 'x', role, keys: ['502'], group: '502' }, w.settings, { agentsPath: '/x/agents.json' }).args;
    for (const rule of PUSH_DENIED_PLAIN) assert.ok(denied.slice(denied.indexOf('--disallowedTools')).includes(rule), `${role} denies ${rule}`);
  }
  assert.equal(cmd.cwd, w.root);
  const ladder = w.settings.modelLadder;
  assert.deepEqual([nextModelUp('claude-haiku-5-5', ladder), nextModelUp('claude-sonnet-5-5', ladder), nextModelUp('claude-opus-5-5', ladder)], ['claude-sonnet-5-5', 'claude-opus-5-5', null]);
});

test('the weekly roles proposal: frequent retries propose the next model; many clean steps at high effort propose medium', () => {
  const { w } = busyWorld();
  const run = (role, extra = {}) => ({ role, start: ago(24), outcome: 'done', ...extra });
  const ledgers = [{ runs: [...Array.from({ length: 5 }, () => run('reviewer')), run('reviewer', { retryOf: 'claude-sonnet-5-5' }), run('reviewer', { retryOf: 'claude-sonnet-5-5' }), ...Array.from({ length: 10 }, () => run('translator')),
    // Sessions that ended on a busy browser lock say nothing about the model: they neither dilute the retries nor count as failed.
    run('reviewer', { outcome: 'busy' }), run('reviewer', { outcome: 'busy' }), run('translator', { outcome: 'busy' }), run('triage', { start: ago(24 * 9) })] }];
  const p = proposeRoles(ledgers, w.settings, NOW);
  assert.deepEqual(p.proposals.map((x) => [x.role, x.change]), [['reviewer', 'model claude-sonnet-5-5 → claude-opus-5-5'], ['translator', 'effort high → medium']]);
});

test('the report: waiting for the owner, places, the check label, videos, ready for merge, cards left in a watched list', async () => {
  const c = { q: card({ number: 701, status: 'blocked' }), places: card({ number: 702, status: 'finalReview' }), rfm: card({ number: 703, status: 'finalReview' }), video: card({ number: 704, status: 'blocked' }) };
  const head = '9'.repeat(40);
  const release = [card({ list: { id: '5f00000000000000000a0101', name: 'Shipping' }, board: '5f00000000000000000d0002', name: 'Release notes 1.2', lastActivity: ago(30) })];
  const w = world({ cards: Object.values(c), release, prs: [pr({ repo: 'api-docs', number: 81, labels: ['In progress', 'Look at me'] }), pr({ repo: 'guide-docs', number: 82, headCommit: head })] });
  const base = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
  ledger(w, c.q, { stages: { start: 'done', plan: 'done', questions: 'done' } });
  ledger(w, c.places, { stages: base, prs: [{ repo: 'api-docs', number: 81, targets: ['api'], review: 'places', stage: 'finalReview' }], places: [{ id: 'p1', repo: 'api-docs', pr: 81, state: 'open' }, { id: 'p2', repo: 'api-docs', pr: 81, state: 'open' }] });
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

// ------------------------------------------------------------------ a start that fails

const DAY = 86400000;
const keyOfBrief = (cmd) => /Stage `(\w+)` of tickets? (\d+)/.exec(briefOf(cmd)).slice(1);
const originOf = (cmd) => /--started-by (\w+)/.exec(briefOf(cmd))?.[1] ?? null;
// Two ready tickets as the triage left them (no start yet, so no `startedBy`), with `limits.open` at 1.
function twoReady({ limits = {} } = {}) {
  const w = world({ extra: { limits: { estimates: { edit: 4, newPage: 8 }, open: 1, startOrder: 'easiest', ...limits } } });
  const cards = {};
  for (const [n, size] of [[501, 'edit'], [502, 'newPage']]) {
    cards[n] = card({ number: n, status: 'ready' });
    w.tracker.cards.push(cards[n]);
    ledger(w, cards[n], { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size } });
  }
  return { w, cards };
}

test('a start that fails before the card moves holds no slot: the run starts the next group; the next morning run tries each once more, then holds it, with one notification', async () => {
  // A session that dies with nothing recorded, and one that records its start failed with its brief's own line.
  for (const kind of ['dies', 'records failed']) {
    const { w, cards } = twoReady();
    let day = 0;
    const sessions = [];
    const spawnClaude = async (cmd) => {
      const [stage, key] = keyOfBrief(cmd);
      sessions.push(`${day}:${stage} ${key}`);
      if (kind === 'dies') return { code: 1, stdout: '', stderr: 'the session died' };
      await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'start', status: 'failed', note: 'the attachment could not be read', card: cards[key].shortLink, startedBy: originOf(cmd), result: { group: key }, now: NOW + day * DAY });
      return { code: 0, stdout: RESULT() };
    };
    const run = (d, morning = true) => {
      day = d;
      return runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW + d * DAY, spawnClaude }, options: { morning } });
    };
    const first = await run(0);
    assert.deepEqual(sessions, ['0:start 501', '0:start 502'], `${kind}: the failed start held no slot, so the run started the next group`);
    assert.deepEqual(first.after.wip.open, 0);
    assert.deepEqual(first.notStarted.map((g) => g.group), ['501', '502']);
    for (const g of first.notStarted) assert.match(g.reasons.join(), /^its start failed at \S+ \(\d+\): waits for a person acting on the ticket, or the next morning run$/, kind);
    assert.ok(first.log.some((e) => e.group === '501' && e.outcome === 'waits' && /runs again after a person acts on the ticket, or once at the next morning run/.test(e.note)));
    assert.deepEqual([read(w, '501').startedBy, read(w, '501').stages.start.status, (await w.one('501')).state], ['schedule', 'failed', 'ready']);
    // A run that is not the morning's leaves a waiting start alone.
    await run(0.25, false);
    assert.equal(sessions.length, 2, `${kind}: no session outside the morning run`);
    // The next morning: one more try each, then held for the owner, with the notification.
    const second = await run(1);
    assert.deepEqual(sessions.slice(2), ['1:start 501', '1:start 502'], kind);
    assert.deepEqual(notificationsOf({ morning: second, today: '2026-11-11' }).filter((n) => n.title === 'Ticket flow: a step failed twice').map((n) => n.text), ['start of 501 failed twice. See /ticket-report.', 'start of 502 failed twice. See /ticket-report.']);
    assert.deepEqual(read(w, '501').runs.map((r) => [r.stage, r.outcome, r.failures]), [['start', 'failed', 1], ['start', 'failed', 2]]);
    await run(2);
    assert.equal(sessions.length, 4, `${kind}: held, so no session on the third morning`);
    const st = await w.status({ usage: usageAt(5) });
    assert.deepEqual(st.tickets.map((t) => [t.key, t.state, t.held, t.gate.who]), [['501', 'ready', true, 'owner'], ['502', 'ready', true, 'owner']]);
    assert.deepEqual(st.startable, []);
  }
});

test('a manual run gives a waiting failed start its one more try with the failures so far: a second failure holds it, and a manual run then starts nothing', async () => {
  const { w } = twoReady();
  const sessions = [];
  const spawnClaude = async (cmd) => {
    const [stage, key] = keyOfBrief(cmd);
    sessions.push(`${stage} ${key} ${originOf(cmd)}`);
    return { code: 1, stdout: '', stderr: 'the session died' };
  };
  const run = (options) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options });
  await run({ trigger: 'manual', named: ['501'] });
  assert.deepEqual([sessions, (await w.one('501')).failed?.sessions, Boolean((await w.one('501')).held)], [['start 501 manual'], 1, false], 'the first failure waits');
  await run({ trigger: 'manual', named: ['501'] });
  assert.deepEqual(sessions, ['start 501 manual', 'start 501 manual'], 'a manual run gives the waiting start its one more try');
  assert.deepEqual(read(w, '501').runs.map((r) => [r.stage, r.outcome, r.failures]), [['start', 'failed', 1], ['start', 'failed', 2]]);
  const t = await w.one('501');
  assert.deepEqual([t.state, t.held, t.gate.who], ['ready', true, 'owner']);
  const third = await run({ trigger: 'manual', named: ['501'] });
  assert.equal(sessions.length, 2, 'held: a manual run starts nothing');
  assert.ok(third.notes.some((n) => /^group 501: its start is held for the owner \(501\); `ticket-state set retry <key>` gives it one more try$/.test(n)), third.notes.join('\n'));
});

test('the runner records a start before its session: one that moves the card and dies still counts, so the open limit holds that day and the next', async () => {
  const { w, cards } = twoReady();
  let day = 0;
  const sessions = [];
  const spawnClaude = async (cmd) => {
    const [stage, key] = keyOfBrief(cmd);
    sessions.push(`${day}:${stage} ${key} ${originOf(cmd) ?? '-'}`);
    if (stage !== 'start') return { code: 1, stdout: '', stderr: 'not this test' };
    assert.deepEqual([read(w, key).startedBy, read(w, key).stages.start.status], ['schedule', 'running'], 'recorded before the session');
    cards[key].placeId = LISTS.inProgress.id; // the session moves the card ...
    if (day === 0) return { code: 1, stdout: '', stderr: 'the session died' }; // ... and dies before its record
    await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'start', status: 'done', card: cards[key].shortLink, startedBy: originOf(cmd), result: { group: key }, now: NOW + day * DAY });
    return { code: 0, stdout: RESULT() };
  };
  const run = (d) => {
    day = d;
    return runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW + d * DAY, spawnClaude }, options: { morning: true } });
  };
  const first = await run(0);
  assert.deepEqual(sessions, ['0:start 501 schedule'], 'the card in work counts: the next group waits');
  assert.deepEqual([first.after.wip.open, first.after.wip.openKeys], [1, ['501']]);
  assert.match(first.notStarted.find((g) => g.group === '502').reasons.join(), /1 open \(501\) \+ 1 > 1/);
  const a = await w.one('501');
  assert.deepEqual([a.state, a.counted, a.next.stage, a.next.again, a.next.startedBy, Boolean(a.next.waits)], ['planning', true, 'start', true, 'schedule', true]);
  // The next morning the start goes on as the scheduled start it was; the limit still holds.
  const second = await run(1);
  assert.deepEqual(sessions.filter((x) => /:start /.test(x)), ['0:start 501 schedule', '1:start 501 schedule']);
  assert.equal(read(w, '501').startedBy, 'schedule');
  assert.deepEqual([second.after.wip.open, second.after.wip.openKeys], [1, ['501']]);
  assert.ok(!sessions.some((x) => / 502 /.test(x)), '502 never started: open stayed at 1');
});

test('a card a person moved into work is a hand start: the runner and the brief record it manual, and it holds no slot', async () => {
  const { w, cards } = twoReady();
  cards[501].placeId = LISTS.inProgress.id; // a person's move: no start recorded before it
  const t = await w.one('501');
  assert.deepEqual([t.next.stage, t.next.byHand, t.next.startedBy], ['start', true, 'manual']);
  const seen = [];
  const spawnClaude = async (cmd) => {
    const [stage, key] = keyOfBrief(cmd);
    if (stage !== 'start') return { code: 1, stdout: '', stderr: 'not this test' };
    seen.push([key, originOf(cmd), read(w, key).startedBy]);
    cards[key].placeId = LISTS.inProgress.id;
    await runRecord({ settings: w.settings, clients: w.clients(), key, stage: 'start', status: 'done', card: cards[key].shortLink, startedBy: originOf(cmd), result: { group: key }, now: NOW });
    return { code: 0, stdout: RESULT() };
  };
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: {} });
  assert.deepEqual(seen, [['501', 'manual', 'manual'], ['502', 'schedule', 'schedule']], 'the hand start first, then the scheduled one: the hand start holds no slot');
  assert.deepEqual([read(w, '501').startedBy, read(w, '502').startedBy], ['manual', 'schedule']);
  assert.deepEqual([out.after.wip.open, out.after.wip.openKeys, out.after.wip.manual], [1, ['502'], 1]);
});

test('the start recorded before its session puts each ticket under its group lock at once, and gives a ready card with no ledger one, with its triage', async () => {
  const w = world({ extra: { limits: { estimates: { edit: 4 } } } });
  for (const n of [601, 602]) {
    const c = card({ number: n, status: 'ready' });
    w.tracker.cards.push(c);
    ledger(w, c, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit', together: n === 601 ? ['602'] : [] } });
  }
  const owner = card({ number: 603, status: 'ready', labels: ['Guide'] }); // an owner's card: no triage, no ledger
  w.tracker.cards.push(owner);
  const during = [];
  const spawnClaude = async (cmd) => {
    const st = await w.status(); // another reader, while the session runs
    during.push(st.tickets.filter((t) => t.locked).map((t) => t.key));
    return { code: 1, stdout: '', stderr: 'the session died' };
  };
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude }, options: { morning: true } });
  assert.deepEqual(during, [['601', '602'], ['603']], 'the group lock covers each ticket of the group during its session');
  assert.deepEqual([read(w, '601').group, read(w, '602').group], ['601-602', '601-602']);
  const l = read(w, '603');
  assert.deepEqual([l.startedBy, l.stages.start.status, l.left.status, l.triage.verdict, l.triage.targets], ['schedule', 'failed', 'ready', 'owner-card', ['guide']]);
  const st = await w.status({ usage: usageAt(5) });
  const t = st.tickets.find((x) => x.key === '603');
  assert.deepEqual([t.ledger, t.state, t.failed.sessions], ['present', 'ready', 1]);
  assert.deepEqual(st.groups.find((g) => g.keys.includes('603')).repoCount, 1, 'still grouped by its target');
});
