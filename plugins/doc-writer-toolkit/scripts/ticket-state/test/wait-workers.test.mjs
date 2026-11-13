import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './fakes.mjs';
import { world } from './helpers.mjs';
import { BG_WAIT_CEILING_MS, BG_WAIT_VARIABLE, SESSION_TIMEOUT_MS, WORKER_STAGES, briefFor, commandFor, continuationFor, resumeCommand, spawnClaude } from '../lib/runner.mjs';
import { refusalOf } from '../lib/role-hook.mjs';

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
  assert.match(lines[1], /Only an agent that can't be continued is replaced, by a new one for the work it left open\./);
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
// gives instead.
test('the command forms the workers\' line names are the ones the role hook passes; the refused ones stay refused', () => {
  const root = '/opt/toolkit';
  const ls = `${root}/scripts/locale-sync/locale-sync.mjs`;
  const tree = '/work/tree';
  const cfg = { role: 'translator', trees: [{ path: tree, branch: 'b', base: 'main' }], roots: [root], scripts: ['locale-sync/locale-sync.mjs'], write: [tree], commands: ['ls', 'git'] };
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
