import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, card, pr, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { BG_WAIT_CEILING_MS, BG_WAIT_VARIABLE, NO_STATUS_STAGES, RESUME_MARGIN_MS, SESSION_TIMEOUT_MS, WORKER_STAGES, briefFor, cliStopLine, commandFor, continuationFor, resumeCeilingMs, resumeCommand, ROLE_DIR, runDaily, spawnClaude } from '../lib/runner.mjs';
import { HOOK_VARIABLE, refusalOf } from '../lib/role-hook.mjs';

// The result event of a session that ended on its own on a text message (2.1.319, as in resume.test.mjs).
const ENDED = () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', api_error_status: null, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 'sess-1', usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [] });

// A stage that starts the locale-translator's workers waits for them without polling (TASK-110): the CLI keeps the
// session up while its own background agents run, for `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` after the last turn, which
// the runner raises for these stages only; the brief says to end the turn and let the notices come; the continuation
// prompt continues stopped workers rather than starting new ones; and the workers' prompts carry the command forms
// the role hook accepts.

const HEAD = 'c'.repeat(40);
const ROOTS = ['/opt/toolkit'];
const step = (stage, extra = {}) => ({ stage, role: 'translator', keys: ['701'], group: '701', pr: 'guide-docs#61', head: HEAD, ...extra });
const cmdOf = (w, stage) => commandFor(step(stage), w.settings, { agentsPath: '/x/agents.json', roots: ROOTS });

test('the worker stages, and only they, raise the CLI\'s wait for background agents: above the longest worker, below the session timeout', () => {
  const w = world();
  assert.deepEqual(WORKER_STAGES, ['locales', 'resync']);
  assert.equal(BG_WAIT_VARIABLE, 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS');
  for (const stage of WORKER_STAGES) assert.equal(cmdOf(w, stage).env[BG_WAIT_VARIABLE], String(BG_WAIT_CEILING_MS), stage);
  for (const stage of ['translate', 'enReview', 'align', 'labelSync', 'baseFix']) assert.equal(BG_WAIT_VARIABLE in cmdOf(w, stage).env, false, stage);
  assert.equal(BG_WAIT_VARIABLE in commandFor({ stage: 'write', role: 'writer', keys: ['1'], group: '1' }, w.settings, { agentsPath: '/x/agents.json', roots: ROOTS }).env, false);
  // Never 0 (no limit): a hung worker would then hold the stage until the runner's kill, which is never resumed.
  assert.ok(BG_WAIT_CEILING_MS > 56 * 60 * 1000, 'above the longest worker measured');
  assert.ok(BG_WAIT_CEILING_MS < SESSION_TIMEOUT_MS, 'below the session timeout');
  // Not a flag on the command line: the role's tools and rules are as before.
  assert.deepEqual(cmdOf(w, 'locales').args.filter((a) => a.includes(BG_WAIT_VARIABLE)), []);
});

test('the resumed session\'s ceiling is at most the time the first process left, less a margin; never 0', () => {
  const w = world();
  const cmd = cmdOf(w, 'locales');
  const hour = 3600 * 1000;
  // A first process that used little time: the full ceiling.
  assert.equal(resumeCommand(cmd, 'sess-1', step('locales'), { left: 4 * hour - 60000 }).env[BG_WAIT_VARIABLE], String(BG_WAIT_CEILING_MS));
  // One that exited at the ceiling after 2 h 30 min: 1 h 30 min left, so the ceiling is that less the margin.
  const left = 1.5 * hour;
  const again = resumeCommand(cmd, 'sess-1', step('locales'), { left });
  assert.equal(Number(again.env[BG_WAIT_VARIABLE]), left - RESUME_MARGIN_MS);
  assert.ok(resumeCeilingMs(left) + RESUME_MARGIN_MS <= left);
  // Never 0 (no ceiling), however little is left.
  assert.equal(resumeCeilingMs(RESUME_MARGIN_MS - 5000), 1000);
  assert.equal(resumeCeilingMs(1), 1000);
  // The rest of the environment and the command are the first one's; the first command is untouched.
  assert.deepEqual({ ...again.env, [BG_WAIT_VARIABLE]: null }, { ...cmd.env, [BG_WAIT_VARIABLE]: null });
  assert.equal(cmd.env[BG_WAIT_VARIABLE], String(BG_WAIT_CEILING_MS));
  // A stage without the raised wait gets none on its resume.
  assert.equal(BG_WAIT_VARIABLE in resumeCommand(cmdOf(w, 'translate'), 'sess-1', step('translate'), { left }).env, false);
});

test('a locales session cut off at the ceiling: the resume gets the fitted ceiling, and the CLI\'s stderr line goes into the run\'s note', async () => {
  const hour = 3600 * 1000;
  let t = NOW;
  const c = card({ number: 701, status: 'translation' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 61, headCommit: HEAD })], extra: { limits: { stepsPerTicket: 1 } } });
  const chain = { translate: { status: 'done', head: HEAD, seq: 10 }, enReview: { status: 'done', head: HEAD, seq: 11 } };
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 61, targets: ['guide'], review: 'sme', branch: 'ticket-61', stage: 'translation', chain }] });
  const tree = tmp('wt-');
  const ensureWorktree = (settings, p) => ({ repo: p.repo, branch: p.branch, path: tree, head: HEAD, push: '', linked: [], missing: [], notes: [], stuck: [] });
  const STOP = 'Background tasks still running 2h after the last turn (subagent "Locale worker ru"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.';
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push(cmd);
    if (calls.length === 1) t += 2.5 * hour; // the first process: setup, then the 2 h ceiling
    return { code: 0, stdout: ENDED(), stderr: calls.length <= 2 ? `${STOP}\n` : '' };
  };
  const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => t, spawnClaude, ensureWorktree, transcripts: tmp(), sleep: async () => {} }, options: { morning: false, trigger: 'watch', named: ['701'] } });
  const flag = (cmd, name) => (cmd.args.includes(name) ? cmd.args[cmd.args.indexOf(name) + 1] : null);
  assert.equal(/Stage `locales`/.test(calls[0].args[1]), true);
  assert.equal(flag(calls[1], '--resume'), 'sess-1');
  assert.equal(calls[0].env[BG_WAIT_VARIABLE], String(BG_WAIT_CEILING_MS));
  assert.equal(Number(calls[1].env[BG_WAIT_VARIABLE]), 1.5 * hour - RESUME_MARGIN_MS, 'the time left less the margin');
  const run = read(w, '701').runs.find((r) => r.stage === 'locales' && r.resumed);
  assert.equal(run.note, `process 1: ${STOP}; process 2: ${STOP}`);
  assert.equal(cliStopLine(`warning: x\n${STOP}\nmore`), STOP);
  assert.equal(cliStopLine('Background tasks finished'), null);
  assert.equal(cliStopLine(undefined), null);
});

test('the resumed session keeps the raised wait, and the variable reaches the CLI process', async () => {
  const w = world();
  const cmd = cmdOf(w, 'locales');
  const again = resumeCommand(cmd, 'sess-1', step('locales'));
  assert.equal(again.env[BG_WAIT_VARIABLE], String(BG_WAIT_CEILING_MS));
  // A stand-in for `claude` that prints what it got.
  const dir = tmp('bin-');
  const bin = path.join(dir, 'claude.mjs');
  fs.writeFileSync(bin, `console.log(JSON.stringify({ wait: process.env.${BG_WAIT_VARIABLE} ?? null }));\n`);
  const run = await spawnClaude({ bin: process.execPath, args: [bin], cwd: dir, env: again.env }, { env: { PATH: process.env.PATH } });
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(run.stdout), { wait: String(BG_WAIT_CEILING_MS) });
  const plain = await spawnClaude({ bin: process.execPath, args: [bin], cwd: dir, env: cmdOf(w, 'translate').env }, { env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(plain.stdout), { wait: null });
});

test('the locales brief: start the workers in one message and end the turn; no polling; no status call; the line for the workers\' prompts', () => {
  const w = world();
  const brief = briefFor(step('locales'), w.settings);
  assert.match(brief, /Start the locale-translator's workers all in one message, in the background, then end your turn with one short line\./);
  assert.match(brief, /Ending a turn while your workers run does not end the session: it waits for them \(up to 2 hours with no notice\), and each worker's completion notice starts your next turn by itself\./);
  assert.match(brief, /Never check on them in a loop: no ListAgents, no git status or git diff to watch their files, no Monitor and no sleep to wait\./);
  assert.match(brief, /This brief gives all the stage needs: no `ticket-state status` call is needed\./);
  // ... and names no status call, which every other stage's brief still does.
  assert.deepEqual(NO_STATUS_STAGES, ['locales']);
  assert.doesNotMatch(brief, /The ticket now:|ticket-state\.mjs status/);
  for (const stage of ['translate', 'enReview', 'align', 'labelSync', 'resync']) assert.match(briefFor(step(stage, { since: 'a'.repeat(40) }), w.settings), /The ticket now: `node \S+ticket-state\.mjs status /, stage);
  assert.match(fs.readFileSync(path.join(ROLE_DIR, 'unattended.md'), 'utf8'), /Run `ticket-state status --ticket <key>` to see what the ticket's state is now, unless your brief says the stage needs no status call\./);
  assert.match(brief, /Give every worker's prompt this line too, after the shared lines and before the locale's own: "Run each command as one plain Bash call with literal paths/);
  assert.match(brief, /add a line to results\.jsonl by reading the file and writing it back with every line it had and the new one at the end\."/);
  // The build line stays as it was.
  assert.match(brief, /Run the locale-translator with `--no-build`/);
});

test('the re-sync brief carries the same waiting and worker lines, and keeps its build under the lock; other stages carry neither', () => {
  const w = world();
  const resync = briefFor(step('resync', { since: 'a'.repeat(40) }), w.settings);
  assert.match(resync, /Start the locale-translator's workers all in one message, in the background, then end your turn/);
  assert.match(resync, /Give every worker's prompt this line too/);
  assert.match(resync, /The runner holds the build lock for this session: the locale-translator's build runs as usual/);
  assert.doesNotMatch(resync, /no `ticket-state status` call is needed/, 'the status line is the locales stage\'s only');
  for (const stage of ['translate', 'enReview', 'align', 'labelSync']) {
    const brief = briefFor(step(stage), w.settings);
    assert.doesNotMatch(brief, /in the background, then end your turn|Give every worker's prompt|no `ticket-state status` call/, stage);
  }
  assert.match(briefFor({ stage: 'visualPack', role: 'reviewer', keys: ['701'], pr: 'guide-docs#61' }, w.settings), /The runner holds the build lock for this session: visual-pack's own build/);
});

test('the continuation: a turn on text ends the session only with no background work left; stopped agents are continued with SendMessage, never replaced by a new wave; no polling', () => {
  const text = continuationFor(step('locales', { worktrees: [{ path: '/work/tree' }] }));
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^The stage `locales` of ticket 701 is not finished: nothing is recorded for it\. Your last message was text with no tool call, and the session ended: in this mode a turn that ends on text ends the session once no background work of yours is left running\.$/);
  assert.doesNotMatch(text, /which in this mode ends the session/, 'the claim that made a measured session poll');
  assert.match(lines[1], /^If a notice lists background agents of yours as stopped, continue each one with SendMessage to its id \(load the tool with ToolSearch if it is not there yet\): its transcript keeps its progress, so start no new agent for the same work\./);
  assert.match(lines[1], /Tell it that the session's time limit stopped it, not a person, and to go on from its last finished step, redoing the one in flight\./);
  assert.match(lines[1], /Only an agent that can't be continued \(SendMessage to it fails\) is replaced, by a new one for the work it left open, never while it might still run\./);
  assert.match(lines[1], /Then end your turn with one short line: the session waits for the agents you run, and each one's completion notice starts your next turn by itself\. Never check on them in a loop \(ListAgents, git status or git diff, Monitor, sleep\)\.$/);
  assert.match(lines[2], /^Continue the stage from where it stopped and finish it: commit and push your changes as the brief says, post what the stage posts, and record it, with the record command in the brief\.$/);
  assert.match(lines[3], /record it failed with the reason/);
  // A stage with no worktree records only; the agents line is the same for every stage (any session may run agents).
  const plain = continuationFor({ stage: 'plan', role: 'writer', keys: ['502', '503'] });
  assert.match(plain, /^The stage `plan` of tickets 502, 503 is not finished/);
  assert.match(plain, /finish it: record it as the brief says, with the record command in the brief\./);
  assert.match(plain, /continue each one with SendMessage to its id/);
});

// The forms the workers of two measured locales stages were refused for (role-hook.mjs), and the forms the worker line
// gives instead, against the hook config the runner gives a real `locales` session.
test('the command forms the workers\' line names are the ones the role hook passes; the refused ones stay refused', () => {
  const w = world();
  const root = ROOTS[0];
  const ls = `${root}/scripts/locale-sync/locale-sync.mjs`;
  const tree = '/work/.worktrees/guide-docs/ticket-61';
  const locales = step('locales', { worktrees: [{ repo: 'guide-docs', branch: 'ticket-61', base: 'main', path: tree, push: `git -C ${tree} push origin HEAD:refs/heads/ticket-61` }] });
  const cfg = JSON.parse(commandFor(locales, w.settings, { agentsPath: '/x/agents.json', roots: ROOTS }).env[HOOK_VARIABLE]);
  assert.equal(cfg.role, 'translator');
  assert.deepEqual(cfg.trees.map((t) => t.path), [tree]);
  assert.ok(cfg.scripts.includes('locale-sync/locale-sync.mjs'));
  const run = `${tree}/.doc-toolkit/.run/r/ru`;
  const refused = [
    [`LS="node ${ls}"; $LS blocks docs:pay/refunds --locales ru`, /a variable/],
    [`P=${root}; node $P/scripts/locale-sync/locale-sync.mjs blocks docs:pay/refunds --locales ru`, /a variable/],
    [`node ${ls} blocks docs:pay/refunds --locales ru > ${run}/b1.json`, /a redirect into/],
    [`cat ${run}/new.txt >> ${run}/results.jsonl`, /a redirect into/],
    [`cat >> ${run}/results.jsonl <<'EOF'\n{"unit":"x"}\nEOF`, /a heredoc/],
    [`node -e "console.log(1)"`, /node -e/],
    ['ps -o pid -p $(pgrep -f bind)', /a command substitution/],
    [`until test -f ${run}/results.jsonl; do sleep 5; done`, /until \(no stage runs it\)/],
  ];
  for (const [cmd, why] of refused) assert.match(refusalOf(cmd, cfg, { cwd: tree }) ?? '', why, cmd);
  const passed = [
    `node ${ls} blocks docs:pay/refunds --locales ru`,
    `node ${ls} apply docs:pay/refunds --locales ru --translations ${run}/docs__pay__refunds.blocks.txt --out ${run}/docs__pay__refunds.candidate.md`,
    `node ${ls} check docs:pay/refunds --locales ru --candidate ${run}/docs__pay__refunds.candidate.md --unverified-file ${run}/docs__pay__refunds.unverified.json`,
    `ls ${run}`,
  ];
  for (const cmd of passed) assert.equal(refusalOf(cmd, cfg, { cwd: tree }), null, cmd);
});
