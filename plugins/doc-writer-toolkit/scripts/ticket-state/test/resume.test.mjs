import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, NOW, ago, card, pr, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { noteBusy, takeBrowserLock } from '../lib/browser-lock.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { localDate } from '../lib/report.mjs';
import { addUp, apiErrorOf, endedOnText, parseResult, recordRefused, runDaily } from '../lib/runner.mjs';

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
  write('refused', 'Exit code 1\nticket-state: nothing recorded: the branch head is aaaaaaaaaaaa, not bbbbbbbbbbbb\n{ "refused": "stale" }');
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

test('a PR stage on a worktree, answering comments: resumed with the commit and the push to do, and recorded on the PR', async () => {
  const c = card({ number: 902, status: 'smeReview' });
  const activity = { 'guide-docs#7': { comments: [{ id: 9201, author: 'expert-one', body: 'One more thing: the limit is daily.', createdAt: ago(2), updatedAt: ago(2) }] } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 7, headCommit: 'b'.repeat(40), labels: ['in expert review'] })], activity, extra: { limits: { stepsPerTicket: 1 } } });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 7, targets: ['guide'], review: 'sme', stage: 'smeReview', smeSince: ago(5) }] });
  const tree = { repo: 'guide-docs', branch: 'ticket-902', path: tmp(), push: 'git push', linked: [], missing: [], notes: [], stuck: [] };
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push(cmd);
    if (!flag(cmd, '--resume')) return { code: 0, stdout: ENDED() };
    await runRecord({ settings: w.settings, clients: w.clients(), key: '902', stage: 'answerComments', pr: 'guide-docs#7', status: 'done', result: { handled: [{ id: 9201, updatedAt: ago(2) }], questions: [] }, now: NOW });
    return { code: 0, stdout: ENDED({ cost: 0.6 }) };
  };
  const out = await run(w, spawnClaude, { ensureWorktree: () => tree });
  assert.deepEqual(calls.map((cmd) => flag(cmd, '--resume')), [null, 'sess-1']);
  assert.match(briefOf(calls[0]), /^Stage `answerComments` of ticket 902 \(group 902\), PR guide-docs#7/);
  assert.match(briefOf(calls[1]), /^The stage `answerComments` of ticket 902 is not finished/);
  assert.match(briefOf(calls[1]), /commit and push your changes as the brief says, post what the stage posts, and record it/);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.pr, r.outcome]), [['answerComments', 'guide-docs#7', 'done']]);
  const runs = read(w, '902').runs.filter((r) => r.stage === 'answerComments');
  assert.deepEqual(runs.map((r) => [r.outcome, r.pr, r.session, r.resumedSession, r.costUsd]), [['done', 'guide-docs#7', 'sess-1', 'sess-1', 0.6]]);
});

test('a PR stage the session recorded failed on its PR is not resumed', async () => {
  const c = card({ number: 903, status: 'smeReview' });
  const activity = { 'guide-docs#8': { comments: [{ id: 9301, author: 'expert-one', body: 'And the weekly one?', createdAt: ago(2), updatedAt: ago(2) }] } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 8, headCommit: 'b'.repeat(40), labels: ['in expert review'] })], activity, extra: { limits: { stepsPerTicket: 1 } } });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 8, targets: ['guide'], review: 'sme', stage: 'smeReview', smeSince: ago(5) }] });
  const tree = { repo: 'guide-docs', branch: 'ticket-903', path: tmp(), push: 'git push', linked: [], missing: [], notes: [], stuck: [] };
  const calls = [];
  const out = await run(w, async (cmd) => {
    calls.push(flag(cmd, '--resume'));
    await runRecord({ settings: w.settings, clients: w.clients(), key: '903', stage: 'answerComments', pr: 'guide-docs#8', status: 'failed', note: 'the comment asks about a page outside the PR', now: NOW });
    return { code: 0, stdout: ENDED() };
  }, { ensureWorktree: () => tree });
  assert.deepEqual(calls, [null]);
  assert.equal(out.ran[0].outcome, 'failed');
});

test('only the first attempt is resumed: a first session at max turns is not, and the retry up the ladder that ends on text is not either; the step fails', async () => {
  const w = planWorld('claude-sonnet-5-5');
  const calls = [];
  await run(w, async (cmd) => {
    calls.push([flag(cmd, '--model'), flag(cmd, '--resume')]);
    return { code: 0, stdout: calls.length === 1 ? ENDED({ subtype: 'error_max_turns', is_error: true, stop_reason: 'tool_use' }) : ENDED() };
  });
  assert.deepEqual(calls, [['claude-sonnet-5-5', null], ['claude-opus-5-5', null]]);
  const runs = read(w, '502').runs.filter((r) => r.stage === 'plan');
  assert.deepEqual(runs.map((r) => [r.model, r.outcome, r.failures, r.resumed ?? false]), [['claude-sonnet-5-5', 'failed', 1, false], ['claude-opus-5-5', 'failed', 2, false]]);
});

test('a plan session that recorded its questions and then ended on text is done, not resumed', async () => {
  const w = planWorld();
  const calls = [];
  const out = await run(w, async (cmd) => {
    calls.push(flag(cmd, '--resume'));
    w.tracker.cards[0].placeId = LISTS.blocked.id;
    await runRecord({ settings: w.settings, clients: w.clients(), key: '502', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', kind: 'fit', text: 'the block lists something else' }] }, now: NOW });
    return { code: 0, stdout: ENDED() };
  });
  assert.deepEqual(calls, [null]);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['plan', 'done']]);
});

test('a start that ended on text with only the runner\'s own `running` record is resumed, and its record makes it done', async () => {
  const c = card({ number: 501, status: 'ready', labels: ['Guide'] });
  const w = world({ cards: [c], extra: { limits: { stepsPerTicket: 1, estimates: { edit: 4, newPage: 8 } } } });
  ledger(w, c, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  const calls = [];
  const out = await run(w, async (cmd) => {
    calls.push(flag(cmd, '--resume'));
    assert.equal(read(w, '501').stages.start.status, 'running', 'the runner recorded the start before the session');
    if (flag(cmd, '--resume')) {
      c.placeId = LISTS.inProgress.id;
      await runRecord({ settings: w.settings, clients: w.clients(), key: '501', stage: 'start', status: 'done', card: c.shortLink, result: { group: '501' }, now: NOW });
    }
    return { code: 0, stdout: ENDED() };
  });
  assert.deepEqual(calls, [null, 'sess-1']);
  assert.deepEqual(out.starts.map((s) => s.steps.map((x) => [x.stage, x.outcome])), [[['start', 'done']]]);
  assert.equal(read(w, '501').stages.start.status, 'done');
});

// A PR in the chain at its first stage, at HEAD, with its worktree.
function chainWorld() {
  const HEAD = 'c'.repeat(40);
  const c = card({ number: 701, status: 'translation' });
  const forgePr = pr({ repo: 'guide-docs', number: 61, headCommit: HEAD });
  const w = world({ cards: [c], prs: [forgePr], extra: { limits: { stepsPerTicket: 1 } } });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 61, targets: ['guide'], review: 'sme', branch: 'ticket-61', stage: 'translation', chain: {} }] });
  const tree = tmp();
  const ensureWorktree = (settings, p) => ({ repo: p.repo, branch: p.branch, path: tree, head: HEAD, push: '', linked: [], missing: [], notes: [], stuck: [] });
  return { w, forgePr, ensureWorktree };
}

test('a PR step whose branch a person moved while the session ran is not resumed: it is `moved`, as with no resume; an unmoved one is resumed', async () => {
  for (const move of [true, false]) {
    const t = chainWorld();
    const calls = [];
    const out = await run(t.w, async (cmd) => {
      calls.push(flag(cmd, '--resume'));
      if (move) t.forgePr.headCommit = 'd'.repeat(40);
      return { code: 0, stdout: ENDED() };
    }, { ensureWorktree: t.ensureWorktree });
    const stage = out.ran[0].stage;
    assert.equal(stage, 'translate');
    assert.deepEqual([calls, out.ran[0].outcome], move ? [[null], 'moved'] : [[null, 'sess-1', null], 'failed'], `moved: ${move} (unmoved: resumed, then the retry up the ladder, not resumed)`);
  }
});

test('the resume gets the time the first process left, and none when it used it all; a resume with no result is marked resumed with no session id', async () => {
  const w = planWorld();
  let t = NOW;
  const seen = [];
  await run(w, async (cmd, opts) => {
    seen.push([flag(cmd, '--resume'), opts?.timeoutMs ?? null]);
    if (!flag(cmd, '--resume')) {
      t += 3600000;
      return { code: 0, stdout: ENDED() };
    }
    return { code: 1, stdout: '' };
  }, { now: () => t });
  assert.deepEqual(seen, [[null, null], ['sess-1', 3 * 3600000]]);
  const r = read(w, '502').runs.filter((x) => x.stage === 'plan');
  assert.deepEqual(r.map((x) => [x.outcome, x.resumed ?? false, x.resumedSession ?? null, x.session]), [['failed', true, null, 'sess-1']]);

  const v = planWorld();
  let u = NOW;
  const later = [];
  await run(v, async (cmd) => {
    later.push(flag(cmd, '--resume'));
    u += 4 * 3600000;
    return { code: 0, stdout: ENDED() };
  }, { now: () => u });
  assert.deepEqual(later, [null], 'the first process used the whole timeout');
});

// TASK-114: a session the API refused (a 403 at its edge on 2.1.321: exit 1, the transcript's last assistant entry
// marked `isApiErrorMessage`) is not the model's failure.
const apiTranscript = (dir, session, text = 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', marked = true) => fs.writeFileSync(path.join(dir, `${session}.jsonl`), [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', ...(marked ? { isApiErrorMessage: true, apiErrorStatus: 403, error: 'authentication_failed' } : {}), message: { content: [{ type: 'text', text }] } },
  { type: 'last-prompt' },
].map((x) => JSON.stringify(x)).join('\n') + '\n');
const REFUSED = (session) => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 2, total_cost_usd: 0, duration_ms: 3000, session_id: session, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] });

test('TASK-114: an API error is read from the result event or the transcript\'s last assistant entry, only when marked', () => {
  const dir = tmp();
  apiTranscript(dir, 'refused');
  apiTranscript(dir, 'plain', 'Failed to authenticate. API Error: 403', false);
  const opts = { root: dir, transcripts: dir };
  assert.equal(apiErrorOf({ session: 'refused' }, opts), 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare');
  assert.equal(apiErrorOf({ session: 'plain' }, opts), null, 'text alone is not the mark');
  assert.equal(apiErrorOf({ session: 'missing' }, opts), null);
  assert.equal(apiErrorOf({ session: '../refused' }, opts), null);
  assert.equal(apiErrorOf({ apiError: 529, session: 'missing' }, opts), 'API error 529');
});

test('TASK-114: a session the API refused counts no failure, tries no bigger model and is not held; it runs again at the next run, up to the stage\'s daily cap', async () => {
  const w = planWorld('claude-sonnet-5-5');
  w.settings.limits.sessionsPerStageDay = 2;
  const transcripts = tmp();
  const calls = [];
  const spawnClaude = async (cmd) => {
    const session = `sess-${calls.length + 1}`;
    calls.push(flag(cmd, '--model'));
    apiTranscript(transcripts, session);
    return { code: 1, stdout: REFUSED(session), stderr: '' };
  };
  await run(w, spawnClaude, { transcripts });
  assert.deepEqual(calls, ['claude-sonnet-5-5'], 'no retry on the next model up');
  let plans = read(w, '502').runs.filter((r) => r.stage === 'plan');
  assert.deepEqual(plans.map((r) => [r.outcome, r.failures ?? null]), [['apiError', null]]);
  assert.match(plans[0].note, /API Error: 403/);
  assert.equal(logOf(w).find((e) => e.kind === 'step' && e.stage === 'plan').outcome, 'apiError');
  await run(w, spawnClaude, { transcripts });
  assert.deepEqual(calls, ['claude-sonnet-5-5', 'claude-sonnet-5-5'], 'the next run tries the step again, on the same model');
  await run(w, spawnClaude, { transcripts });
  assert.equal(calls.length, 2, 'the daily cap stops a refusal that lasts');
  plans = read(w, '502').runs.filter((r) => r.stage === 'plan');
  assert.deepEqual(plans.map((r) => r.outcome), ['apiError', 'apiError']);
});

test('TASK-114: a session that gave no result keeps its exit code and the end of its stderr; it still fails and retries as before', async () => {
  const w = planWorld('claude-sonnet-5-5');
  const calls = [];
  await run(w, async (cmd) => {
    calls.push(flag(cmd, '--model'));
    return { code: 1, stdout: '', stderr: 'node: something broke\nat the end\n', signal: calls.length === 2 ? 'SIGKILL' : undefined };
  });
  assert.deepEqual(calls, ['claude-sonnet-5-5', 'claude-opus-5-5']);
  const plans = read(w, '502').runs.filter((r) => r.stage === 'plan');
  assert.deepEqual(plans.map((r) => [r.outcome, r.failures, r.exit, r.signal ?? null, r.note]), [
    ['failed', 1, 1, null, 'stderr: node: something broke\nat the end'],
    ['failed', 2, 1, 'SIGKILL', 'stderr: node: something broke\nat the end'],
  ]);
});
