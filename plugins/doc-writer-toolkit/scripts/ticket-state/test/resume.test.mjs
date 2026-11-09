import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, ago, card, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { noteBusy, takeBrowserLock } from '../lib/browser-lock.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { localDate } from '../lib/report.mjs';
import { addUp, endedOnText, parseResult, recordRefused, runDaily } from '../lib/runner.mjs';

// A role session that stops on a text message with its stage unrecorded (in `claude -p` such a message ends the
// session) is resumed once, with the same command and a continuation prompt; never twice in a step, and never after a
// kill, max turns, a refused record, a record of its own or a busy browser lock.

const usageAt = (week) => parseUsage(`Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);
// The result event of a session that ended on its own on a text message, as the CLI gives it (2.1.319). `cost` is the
// session's cost so far: a resumed session's counts both processes.
const ENDED = ({ cost = 0.5, turns = 4, durationMs = 60000, session = 'sess-1', ...rest } = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', api_error_status: null, num_turns: turns, total_cost_usd: cost, duration_ms: durationMs, session_id: session, usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [], ...rest });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const flag = (cmd, name) => (cmd.args.includes(name) ? cmd.args[cmd.args.indexOf(name) + 1] : null);

// A ticket in work whose next step is its plan, on the writer's model `model`.
function planWorld(model = 'claude-opus-5-5') {
  const c = card({ number: 502, status: 'inProgress', labels: ['Guide'], lastActivity: ago(48) });
  const w = world({ cards: [c], extra: { roles: { writer: { model } }, limits: { stepsPerTicket: 1 } } });
  ledger(w, c, { stages: { triage: 'done', start: 'done' }, startedBy: 'schedule', triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  return w;
}
const recordPlan = (w, status = 'done') => runRecord({ settings: w.settings, clients: w.clients(), key: '502', stage: 'plan', status, ...(status === 'done' ? { result: { pages: ['docs/pay/refunds.md'] } } : { note: 'the section has no page to plan' }), now: NOW });
const run = (w, spawnClaude, io = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude, transcripts: tmp(), ...io }, options: {} });
const logOf = (w) => fs.readFileSync(path.join(w.settings.state, 'runs', `${localDate(NOW)}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));

test('the signal: exit 0, success, end_turn, completed, no API error and a session id; any field missing is a no', () => {
  const ok = { code: 0 };
  assert.equal(endedOnText(ok, parseResult(ENDED())), true);
  assert.equal(endedOnText({ code: 1 }, parseResult(ENDED())), false, 'a failed exit');
  assert.equal(endedOnText({ code: 0, timedOut: true }, parseResult(ENDED())), false, 'the runner killed it');
  assert.equal(endedOnText(ok, parseResult(ENDED({ subtype: 'error_max_turns', is_error: true }))), false, 'max turns');
  assert.equal(endedOnText(ok, parseResult(ENDED({ is_error: true }))), false, 'an error, a usage limit among them');
  assert.equal(endedOnText(ok, parseResult(ENDED({ api_error_status: 429 }))), false, 'an API error');
  assert.equal(endedOnText(ok, parseResult(ENDED({ stop_reason: 'tool_use' }))), false);
  assert.equal(endedOnText(ok, parseResult(ENDED({ terminal_reason: 'aborted' }))), false);
  assert.equal(endedOnText(ok, parseResult(ENDED({ session_id: null }))), false, 'nothing to resume');
  const older = JSON.parse(ENDED());
  delete older.stop_reason;
  delete older.terminal_reason;
  assert.equal(endedOnText(ok, parseResult(JSON.stringify(older))), false, 'a CLI that gives no stop reason resumes nothing');
  assert.equal(endedOnText(ok, null), false);
});

test('the figures add up: turns, duration, tokens and denials per process; the cost is the resumed total, or the sum when the CLI did not restore it', () => {
  const a = { session: 's', turns: 4, costUsd: 0.5, durationMs: 1000, tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 }, denials: 1 };
  const b = { session: 's', turns: 2, costUsd: 0.8, durationMs: 500, tokens: { in: 10, out: 20, cacheRead: 30, cacheWrite: 40 }, denials: 0 };
  assert.deepEqual(addUp(a, b), { session: 's', turns: 6, costUsd: 0.8, durationMs: 1500, tokens: { in: 11, out: 22, cacheRead: 33, cacheWrite: 44 }, denials: 1 });
  assert.equal(addUp(a, { ...b, costUsd: 0.2 }).costUsd, 0.7);
  assert.equal(addUp(a, {}).costUsd, 0.5, 'a resumed session with no result keeps the first figures');
  assert.equal(addUp(a, {}).turns, 4);
});

test('a refused record is seen in the transcript, whole; a transcript that is not there says nothing', () => {
  const dir = tmp();
  const write = (session, result, command = 'node /x/scripts/ticket-state/ticket-state.mjs record 502 --stage plan --status done') => fs.writeFileSync(path.join(dir, `${session}.jsonl`), [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: result }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The record was refused.' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  write('refused', 'Exit code 1\nticket-state: nothing recorded: the branch head is 7aaad3063871, not 7aaad30a2b5e\n{ "refused": "stale" }');
  write('other', 'Exit code 1\nsomething else went wrong');
  write('elsewhere', 'Exit code 1\nnothing recorded: a lock', 'node /x/scripts/ticket-state/ticket-state.mjs lock 502');
  assert.equal(recordRefused('refused', { root: dir, transcripts: dir }), true);
  assert.equal(recordRefused('other', { root: dir, transcripts: dir }), false);
  assert.equal(recordRefused('elsewhere', { root: dir, transcripts: dir }), false, 'only a record command');
  assert.equal(recordRefused('missing', { root: dir, transcripts: dir }), false);
  assert.equal(recordRefused('../refused', { root: dir, transcripts: dir }), false, 'a session id is a plain name');
});

test('a session that stops on a text message with its stage unrecorded is resumed once with the same command, and then records: done, one run with both ids and the figures of both', async () => {
  const w = planWorld();
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push(cmd);
    if (!flag(cmd, '--resume')) return { code: 0, stdout: ENDED({ cost: 0.5, turns: 40, durationMs: 600000 }) };
    await recordPlan(w);
    return { code: 0, stdout: ENDED({ cost: 0.7, turns: 5, durationMs: 90000 }) };
  };
  const out = await run(w, spawnClaude);
  assert.equal(calls.length, 2);
  const [first, again] = calls;
  assert.equal(flag(first, '--resume'), null);
  assert.equal(flag(again, '--resume'), 'sess-1');
  assert.match(briefOf(first), /^Stage `plan` of ticket 502/);
  assert.match(briefOf(again), /^The stage `plan` of ticket 502 is not finished: nothing is recorded for it\. Your last message was text with no tool call/);
  assert.match(briefOf(again), /record it failed with the reason/);
  // Everything but the prompt as the first: model, effort, settings, tools, hook, folders, cwd and environment.
  assert.deepEqual(again.args.filter((a, i) => i !== 1 && a !== '--resume' && a !== 'sess-1'), first.args.filter((a, i) => i !== 1));
  assert.deepEqual([again.bin, again.cwd, again.env, again.model, again.effort], [first.bin, first.cwd, first.env, first.model, first.effort]);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['plan', 'done']]);
  const l = read(w, '502');
  assert.equal(l.stages.plan.status, 'done');
  const runs = l.runs.filter((r) => r.stage === 'plan');
  assert.equal(runs.length, 1, 'one run for the two processes');
  assert.deepEqual([runs[0].outcome, runs[0].session, runs[0].resumedSession, runs[0].turns, runs[0].costUsd, runs[0].durationMs, runs[0].failures ?? null], ['done', 'sess-1', 'sess-1', 45, 0.7, 690000, null]);
  assert.deepEqual(runs[0].tokens, { in: 200, out: 100, cacheRead: 0, cacheWrite: 0 });
  const log = logOf(w);
  assert.deepEqual(log.filter((e) => e.kind === 'resume').map((e) => [e.stage, e.session]), [['plan', 'sess-1']]);
  assert.deepEqual(log.filter((e) => e.kind === 'step').map((e) => [e.stage, e.outcome, e.resumed ?? false]), [['plan', 'done', true]]);
});

test('a resumed session that still records nothing fails once, not twice; the retry on the next model up is never resumed', async () => {
  const w = planWorld('claude-sonnet-5-5');
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push([flag(cmd, '--model'), flag(cmd, '--resume')]);
    return { code: 0, stdout: ENDED({ cost: flag(cmd, '--resume') ? 0.6 : 0.5 }) };
  };
  await run(w, spawnClaude);
  assert.deepEqual(calls, [['claude-sonnet-5-5', null], ['claude-sonnet-5-5', 'sess-1'], ['claude-opus-5-5', null]]);
  const l = read(w, '502');
  assert.equal(l.stages.plan, undefined, 'nothing recorded');
  assert.deepEqual(l.runs.filter((r) => r.stage === 'plan').map((r) => [r.model, r.outcome, r.failures, r.resumedSession ?? null, r.costUsd, r.retryOf ?? null]), [
    ['claude-sonnet-5-5', 'failed', 1, 'sess-1', 0.6, null],
    ['claude-opus-5-5', 'failed', 2, null, 0.5, 'claude-sonnet-5-5'],
  ]);
  assert.equal(logOf(w).filter((e) => e.kind === 'resume').length, 1);
});

test('no resume after a kill, a failed exit, max turns, a CLI with no stop reason, a refused record, a record of the session\'s own or a busy browser lock', async () => {
  const older = JSON.parse(ENDED());
  delete older.stop_reason;
  const cases = {
    'killed on timeout': async () => ({ code: 1, timedOut: true, stdout: ENDED() }),
    'a failed exit': async () => ({ code: 143, stdout: '' }),
    'max turns': async () => ({ code: 0, stdout: ENDED({ subtype: 'error_max_turns', is_error: true }) }),
    'no stop reason': async () => ({ code: 0, stdout: JSON.stringify(older) }),
    'a refused record': async (cmd, dir) => {
      fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node /x/scripts/ticket-state/ticket-state.mjs record 502 --stage plan --status done' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Exit code 1\nticket-state: nothing recorded: the plan file docs/x.md does not exist' }] }] } },
      ].map((x) => JSON.stringify(x)).join('\n') + '\n');
      return { code: 0, stdout: ENDED() };
    },
    'recorded failed': async (cmd, dir, w) => {
      await recordPlan(w, 'failed');
      return { code: 0, stdout: ENDED() };
    },
    'a busy browser lock': async (cmd, dir, w) => {
      noteBusy(w.settings.state, { ticket: '502', holder: takeBrowserLock(w.settings.state, { ticket: '502', now: NOW }).holder, now: NOW });
      return { code: 0, stdout: ENDED() };
    },
  };
  for (const [name, session] of Object.entries(cases)) {
    const w = planWorld();
    const dir = tmp();
    if (name === 'a busy browser lock') takeBrowserLock(w.settings.state, { ticket: '777', now: NOW });
    const calls = [];
    const out = await run(w, async (cmd) => {
      calls.push(flag(cmd, '--resume'));
      return session(cmd, dir, w);
    }, { transcripts: dir });
    assert.deepEqual(calls, [null], `${name}: one session, not resumed`);
    assert.equal(out.ran[0].outcome, name === 'a busy browser lock' ? 'busy' : 'failed', name);
    const runs = read(w, '502').runs.filter((r) => r.stage === 'plan');
    assert.deepEqual(runs.map((r) => r.resumedSession ?? null), [null], name);
  }
});
