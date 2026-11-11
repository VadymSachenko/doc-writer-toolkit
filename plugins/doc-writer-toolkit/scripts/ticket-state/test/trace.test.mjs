import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { host, tmp } from './fakes.mjs';
import { snapshot } from './helpers.mjs';
import { main } from '../ticket-state.mjs';
import { newLedger, writeLedger } from '../lib/ledger.mjs';
import { cleaner, isRefusal, slugOf } from '../lib/trace.mjs';
import { ROLE_SESSION_VARIABLE } from '../lib/env.mjs';

// `trace` on synthetic transcripts. Every run names its transcripts folder (`--transcripts`) or a throwaway
// CLAUDE_CONFIG_DIR, so nothing here reads a real config folder. The invented secrets below must never reach the output.

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ticket-state.mjs');
const T0 = Date.parse('2026-11-10T10:00:00Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const TIME = '\\d\\d:\\d\\d:\\d\\d';

// Transcript lines.
const use = (s, id, name, input) => ({ type: 'assistant', timestamp: iso(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const text = (s, t) => ({ type: 'assistant', timestamp: iso(s), message: { content: [{ type: 'text', text: t }] } });
const result = (id, content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};

// A host with a ledger of runs; `runs` get a seq in order. Returns the folders.
function setup({ runs = [], extra = {}, plan = null, shared = {} } = {}) {
  const root = host({ shared });
  const transcripts = tmp('trace-transcripts-');
  const config = tmp('trace-config-');
  const l = newLedger({ key: '7', card: { id: 'c1', shortLink: 'Card0007', url: 'https://tracker.example/c/Card0007', name: 'A change' }, now: iso(0) });
  l.runs = runs.map((r, i) => ({ seq: i + 1, stage: 'plan', role: 'writer', model: 'claude-opus-5-5', effort: 'high', trigger: 'schedule', start: iso(0), durationMs: 90000, turns: 12, costUsd: 0.5, outcome: 'done', share: 1, ...r }));
  l.plan = plan;
  Object.assign(l, extra);
  writeLedger(path.join(root, '.flow'), l);
  return { root, transcripts, config };
}

async function trace(w, args = [], env = {}) {
  let out = '';
  const code = await main(['trace', '7', '--root', w.root, '--transcripts', w.transcripts, ...args], { stdout: { write: (s) => (out += s) }, env: { CLAUDE_CONFIG_DIR: w.config, ...env }, home: w.config });
  return { code, out };
}
const fails = (promise, code, re) => assert.rejects(promise, (e) => e.exitCode === code && re.test(e.message));
const lineOf = (out, re) => out.split('\n').find((l) => re.test(l));

test('the kinds of action, the count line and a line per action in file order', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  const j = (p) => path.join(w.root, p);
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Read', { file_path: j('docs/a.md') }),
    result('a', 'FILE-CONTENT-ONE'),
    use(2, 'b', 'Grep', { pattern: 'Payout', path: j('docs') }),
    use(3, 'c', 'Glob', { pattern: '**/*.md' }),
    use(4, 'd', 'Bash', { command: 'git status' }),
    use(5, 'e', 'Bash', { command: 'npx playwright test _plan-7-live.spec.ts' }),
    use(6, 'f', 'Monitor', { command: 'tail -f build.log' }),
    use(7, 'g', 'Write', { file_path: j('work/tickets/7/notes.md'), content: 'x' }),
    use(8, 'h', 'Edit', { file_path: j('docs/a.md'), old_string: 'x', new_string: 'y' }),
    use(9, 'i', 'NotebookEdit', { notebook_path: j('n.ipynb'), new_source: 'z' }),
    use(10, 'k', 'Skill', { skill: 'doc-writer-toolkit:user-guide-writer' }),
    use(11, 'l', 'Agent', { description: 'Find the page' }),
    use(12, 'm', 'WebFetch', { url: 'https://example.com' }),
    text(13, 'Done.'),
  ]);
  const { out } = await trace(w);
  const re = (kind, what) => new RegExp(`^  ${TIME} ${kind} ${what}$`, 'm');
  assert.match(out, re('read', '\\./docs/a\\.md'));
  assert.match(out, re('search', 'Payout in \\./docs'));
  assert.match(out, re('search', '\\*\\*/\\*\\.md'));
  assert.match(out, re('ran', 'git status'));
  assert.match(out, re('app', 'npx playwright test _plan-7-live\\.spec\\.ts'));
  assert.match(out, re('ran', 'tail -f build\\.log'));
  assert.match(out, re('wrote', 'work/tickets/7/notes\\.md'.replace('work', '\\./work')));
  assert.match(out, re('wrote', '\\./docs/a\\.md'));
  assert.match(out, re('wrote', '\\./n\\.ipynb'));
  assert.match(out, re('skill', 'doc-writer-toolkit:user-guide-writer'));
  assert.match(out, re('agent', 'Find the page'));
  assert.match(out, re('other', 'WebFetch'));
  assert.match(out, /^  read 1, searched 2, ran 3 \(app 1\), wrote 3, refused 0, failed 0, skills 1, agents 1, other 1$/m);
  assert.match(out, /^  last text: Done\.$/m);
  assert.ok(out.indexOf(' read ') < out.indexOf(' wrote '), 'file order');
  assert.doesNotMatch(out, /FILE-CONTENT-ONE/, 'a result is never printed');
});

test('refused is told from failed; a failed result is never printed, a refusal prints its first line', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Bash', { command: 'cat secrets.txt' }),
    result('a', 'cat: secrets.txt: Permission denied\nOUTPUT-SECRET-LINE password=hunter2', true),
    use(2, 'b', 'Bash', { command: 'curl --token abc123 https://example.com' }),
    result('b', [{ type: 'text', text: 'Permission to use Bash with command curl --token abc123 https://example.com has been denied.\nSECOND-LINE-HIDDEN' }], true),
    use(3, 'c', 'Read', { file_path: '/etc/shadow' }),
    result('c', '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>', true),
    use(4, 'd', 'Write', { file_path: 'x' }),
    result('d', 'Permission for this tool use was denied. The user said no.', true),
    use(5, 'e', 'Bash', { command: 'npm test' }),
    result('e', 'Exit code 1\nPermission denied (publickey).\nTOKEN=zzz-leak', true),
    use(6, 'f', 'Bash', { command: 'git push' }),
    result('f', 'PreToolUse:Bash hook blocking error from command: "guard.sh": no pushes', true),
    use(7, 'g', 'Bash', { command: 'ls' }),
    result('g', 'fine'),
  ]);
  const { out } = await trace(w);
  assert.match(out, /^ {11}refused: Permission to use Bash with command curl --token \*\*\* https:\/\/example\.com has been denied\.$/m);
  assert.match(out, /^ {11}refused: File is in a directory that is denied by your permission settings\.$/m);
  assert.match(out, /^ {11}refused: Permission for this tool use was denied\. The user said no\.$/m);
  assert.match(out, /^ {11}refused: PreToolUse:Bash hook blocking error/m);
  assert.equal(out.match(/^ {11}failed$/gm).length, 2, 'the OS and the command failures are plain failed');
  assert.match(out, /refused 4, failed 2/);
  for (const leak of ['OUTPUT-SECRET-LINE', 'hunter2', 'SECOND-LINE-HIDDEN', 'zzz-leak', 'publickey', 'abc123']) assert.ok(!out.includes(leak), `${leak} is not printed`);
  assert.ok(isRefusal('Permission for this action was denied. Reason'));
  assert.ok(!isRefusal('Permission denied'));
  assert.ok(!isRefusal('Exit code 1'));
  const long = 'Permission to use Bash with command ' + 'x'.repeat(300) + ' has been denied';
  assert.ok(cleaner({ root: '/r', targets: [] })(long, 160).length <= 161);
});

test('a Write or an Edit prints its path only, never its content', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Write', { file_path: path.join(w.root, 'docs/new.md'), content: 'BODY-OF-THE-PAGE api_key=abc' }),
    use(2, 'b', 'Edit', { file_path: path.join(w.root, 'docs/old.md'), old_string: 'OLD-TEXT', new_string: 'NEW-TEXT' }),
  ]);
  const { out } = await trace(w);
  assert.match(out, /wrote \.\/docs\/new\.md$/m);
  assert.match(out, /wrote \.\/docs\/old\.md$/m);
  for (const leak of ['BODY-OF-THE-PAGE', 'OLD-TEXT', 'NEW-TEXT', 'abc']) assert.ok(!out.includes(leak));
});

test('secrets are masked in flags and NAME=value, our own --root and --settings are dropped, long commands are cut', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  const cmds = [
    'curl --token tok-111 --api-key=key-222 --password "pa ss" --verbose https://example.com',
    'API_SECRET=sec-333 MY_KEY=\'k 444\' node run.mjs --note keep-me',
    'curl -H "Authorization: Bearer bear-555" https://example.com',
    `node ticket-state.mjs status --root ${w.root} --settings ${w.root}/.claude/ticket-flow.json --ticket 7`,
    `echo ${'a'.repeat(190)} --token tok-666`,
  ];
  write(path.join(w.transcripts, 's1.jsonl'), cmds.map((command, i) => use(i, `t${i}`, 'Bash', { command })));
  const { out } = await trace(w);
  assert.match(out, /ran curl --token \*\*\* --api-key=\*\*\* --password \*\*\* --verbose https:\/\/example\.com$/m);
  assert.match(out, /ran API_SECRET=\*\*\* MY_KEY=\*\*\* node run\.mjs --note keep-me$/m);
  assert.match(out, /ran curl -H "Authorization: Bearer \*\*\*" https:\/\/example\.com$/m);
  assert.match(out, /ran node ticket-state\.mjs status --ticket 7$/m);
  for (const leak of ['tok-111', 'key-222', 'pa ss', 'sec-333', 'k 444', 'bear-555', 'tok-666', '--root', '--settings']) assert.ok(!out.includes(leak), `${leak} is not printed`);
  const cut = lineOf(out, /echo a{20}/);
  assert.ok(cut.endsWith('…') && cut.length < 230, 'the command is cut at 200 characters');
  assert.match(cut, /echo a{190}/);
});

test('paths: the host root becomes ".", a target clone its folder name, a sibling folder is left alone', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  const { root } = w;
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Read', { file_path: `${root}/repos/guide-docs/docs/a.md` }),
    use(2, 'b', 'Bash', { command: `cd ${root}/repos/portal-docs && ls ${root}` }),
    use(3, 'c', 'Read', { file_path: `${root}-other/x.md` }),
    use(4, 'd', 'Read', { file_path: `${root}/docs/b.md` }),
  ]);
  const { out } = await trace(w);
  assert.match(out, /read guide-docs\/docs\/a\.md$/m);
  assert.match(out, /ran cd portal-docs && ls \.$/m);
  assert.match(out, new RegExp(`read ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-other/x\\.md$`, 'm'));
  assert.match(out, /read \.\/docs\/b\.md$/m);
  assert.ok(!out.includes(`${root}/`));
});

test('a ticket worktree prints as <wt:repo>, before the clone and the root are shortened', async () => {
  const prs = [{ repo: 'guide-docs', targets: ['guide'], branch: 'ticket-7' }, { repo: 'portal-docs', targets: ['portal-ui'], branch: 'ticket/7' }];
  const w = setup({ runs: [{ session: 's1' }], extra: { prs } });
  const { root } = w;
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Read', { file_path: `${root}/repos/.worktrees/guide-docs/ticket-7/docs/a.md` }),
    use(2, 'b', 'Bash', { command: `cd ${root}/repos/.worktrees/portal-docs/ticket/7 && git status` }),
    use(3, 'c', 'Read', { file_path: `${root}/repos/.worktrees/guide-docs/other-branch/x.md` }),
    use(4, 'd', 'Read', { file_path: `${root}/repos/guide-docs/docs/a.md` }),
    use(5, 'e', 'Read', { file_path: `${root}/repos/.worktrees/guide-docs-extra/y.md` }),
  ]);
  const { out } = await trace(w);
  assert.match(out, /read <wt:guide-docs>\/docs\/a\.md$/m);
  assert.match(out, /ran cd <wt:portal-docs> && git status$/m);
  assert.match(out, /read <wt:guide-docs>\/other-branch\/x\.md$/m, 'a worktree the ledger does not know keeps its branch');
  assert.match(out, /read guide-docs\/docs\/a\.md$/m, 'the clone itself is still its folder name');
  assert.match(out, /read \.\/repos\/\.worktrees\/guide-docs-extra\/y\.md$/m, 'a folder that only starts like one is left alone');
});

test("the toolkit's own install prints as <toolkit>, also when it sits inside the host root", async () => {
  const TK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Bash', { command: `node ${TK}/scripts/tracker/tracker.mjs comment 123 --text-file notes.md` }),
    use(2, 'b', 'Read', { file_path: `${TK}-live/scripts/x.mjs` }),
  ]);
  const { out } = await trace(w);
  assert.match(out, /ran node <toolkit>\/scripts\/tracker\/tracker\.mjs comment 123 --text-file notes\.md$/m);
  assert.ok(out.includes(`read ${TK}-live/scripts/x.mjs`), 'a sibling folder with the same start is left alone');
  const clean = cleaner({ root: '/h', targets: [] }, { toolkit: '/h/plugins/tk' });
  assert.equal(clean('/h/plugins/tk/scripts/a.mjs and /h/docs/b.md', 200), '<toolkit>/scripts/a.mjs and ./docs/b.md');
});

test('a missing transcript, and a run with no session, print the ledger facts and "transcript not found"', async () => {
  const w = setup({ runs: [{ session: 'gone-session', stage: 'plan' }, { stage: 'write', session: null, outcome: 'failed' }] });
  const { out, code } = await trace(w);
  assert.equal(code, 0);
  assert.match(out, /^Run 1: plan, writer, claude-opus-5-5, effort high, trigger schedule$/m);
  assert.match(out, /^ {2}start \d{4}-\d\d-\d\d \d\d:\d\d:\d\d, 1m 30s, 12 turns, cost \$0\.50, outcome done$/m);
  assert.match(out, /^ {2}transcript not found$/m);
  assert.match(out, /^Run 2: write, writer/m);
  assert.match(out, /outcome failed/);
  assert.match(out, /^ {2}transcript not found \(no session recorded\)$/m);
});

test('no ledger for the key: exit 2 with a clear message and nothing written', async () => {
  const w = setup();
  const before = snapshot(w.root);
  await fails(main(['trace', '99', '--root', w.root, '--transcripts', w.transcripts], { stdout: { write() {} }, env: { CLAUDE_CONFIG_DIR: w.config } }), 2, /^ticket 99 has no ledger$/);
  await fails(main(['trace', '--root', w.root], { stdout: { write() {} }, env: {} }), 2, /needs the ticket key/);
  assert.deepEqual(snapshot(w.root), before);
});

test('--stage prints that stage only; an unknown stage is exit 2; a known stage with no run says so', async () => {
  const w = setup({ runs: [{ stage: 'plan', session: 's1' }, { stage: 'write', session: 's2' }, { stage: 'write', session: 's3' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [use(1, 'a', 'Read', { file_path: 'PLAN-ONLY.md' })]);
  write(path.join(w.transcripts, 's2.jsonl'), [use(1, 'a', 'Read', { file_path: 'WRITE-ONE.md' })]);
  write(path.join(w.transcripts, 's3.jsonl'), [use(1, 'a', 'Read', { file_path: 'WRITE-TWO.md' })]);
  const all = (await trace(w)).out;
  assert.match(all, /^Sessions: 3; total time 4m 30s; cost \$1\.50/m);
  const { out } = await trace(w, ['--stage', 'write']);
  assert.match(out, /^Sessions: 3, 2 of stage write shown/m);
  assert.match(out, /WRITE-ONE\.md/);
  assert.match(out, /WRITE-TWO\.md/);
  assert.ok(!out.includes('PLAN-ONLY.md') && !out.includes('Run 1:'));
  await fails(trace(w, ['--stage', 'nonsense']), 2, /unknown stage 'nonsense'/);
  assert.match((await trace(w, ['--stage', 'close'])).out, /No session of stage close in this ledger\./);
});

test("a session's subagents are printed under the run, marked, and counted in its count line", async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [use(1, 'a', 'Agent', { description: 'Look at the app' }), use(2, 'b', 'Read', { file_path: 'main.md' }), text(9, 'Main result.')]);
  write(path.join(w.transcripts, 's1', 'subagents', 'agent-aaa.jsonl'), [
    use(3, 'x', 'Bash', { command: 'npx playwright test a.spec.ts' }),
    result('x', 'boom', true),
    use(4, 'y', 'Read', { file_path: 'sub.md' }),
    text(5, 'Subagent report.'),
  ]);
  write(path.join(w.transcripts, 's1', 'subagents', 'notes.txt'), ['not a transcript']);
  const { out } = await trace(w);
  assert.match(out, /^ {2}read 2, searched 0, ran 1 \(app 1\), wrote 0, refused 0, failed 1, agents 1 \(the session and its 1 subagent\(s\) together\)$/m);
  assert.match(out, /^ {2}subagent agent-aaa: read 1, searched 0, ran 1 \(app 1\), wrote 0, refused 0, failed 1$/m);
  assert.match(out, new RegExp(`^ {4}${TIME} app npx playwright test a\\.spec\\.ts$`, 'm'));
  assert.match(out, /^ {4}last text \(subagent\): Subagent report\.$/m);
  assert.match(out, /^ {2}last text: Main result\.$/m);
  assert.ok(out.indexOf('read main.md') < out.indexOf('subagent agent-aaa'));
});

test('a malformed line, an unknown type, a block of an unknown shape and a line with no timestamp break nothing', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [
    '{"type":"assistant","timestamp":"',
    'not json at all',
    '',
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'attachment', attachment: { type: 'x' } },
    { type: 'brand-new-type', message: { content: 5 } },
    { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'mystery' }, null, { type: 'text', text: '   ' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'no-time.md' } }] } },
    { type: 'user', message: { content: 'a plain prompt' } },
    use(2, 'b', 'Read', { file_path: 'timed.md' }),
    use(2, 'b', 'Read', { file_path: 'timed.md' }),
    { type: 'assistant', timestamp: iso(3), message: { content: [{ type: 'tool_use', name: 'Bash', input: null }] } },
    text(4, 'Final words.'),
    { type: 'assistant', timestamp: iso(5), message: { content: [{ type: 'thinking', thinking: '' }] } },
  ]);
  const { out, code } = await trace(w);
  assert.equal(code, 0);
  assert.match(out, /^ {2}--:--:-- read no-time\.md$/m);
  assert.match(out, new RegExp(`^ {2}${TIME} read timed\\.md$`, 'm'));
  assert.equal(out.match(/read timed\.md/g).length, 1, 'a repeated tool call id counts once');
  assert.match(out, /^ {2}last text: Final words\.$/m);
  assert.match(out, /read 2, searched 0, ran 1 \(app 0\)/);
});

test('the header: card, sessions, time, cost by share, plan pages, live check, work folder files, shared session, last text cut', async () => {
  const w = setup({
    shared: { workFolder: 'work/tickets/<key>' },
    plan: { pages: [{ repo: 'guide-docs', path: 'docs/a.md' }, 'docs/b.md'], liveCheck: { needed: true, reason: 'a new field' }, size: 'edit' },
    runs: [
      { stage: 'triage', role: 'triage', session: 's1', share: 0.2, costUsd: 1, durationMs: 60000, denials: 2 },
      { stage: 'plan', session: 's2', costUsd: 0.5, durationMs: 3700000, retryOf: 'claude-sonnet-5-5' },
    ],
  });
  fs.mkdirSync(path.join(w.root, 'work/tickets/7/sub'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'work/tickets/7/notes.md'), 'NOTES-BODY');
  fs.writeFileSync(path.join(w.root, 'work/tickets/7/sub/shot.png'), 'x');
  write(path.join(w.transcripts, 's1.jsonl'), [text(1, 'w'.repeat(500))]);
  write(path.join(w.transcripts, 's2.jsonl'), [use(1, 'a', 'Read', { file_path: 'x' })]);
  const before = snapshot(w.root);
  const { out } = await trace(w);
  assert.match(out, /^Ticket 7\nCard: https:\/\/tracker\.example\/c\/Card0007\n/);
  assert.match(out, /^Sessions: 2; total time 1h 02m; cost \$0\.70 \(a shared session counts this ticket's share\)$/m);
  assert.match(out, /^Plan pages: guide-docs docs\/a\.md, docs\/b\.md$/m);
  assert.match(out, /^Live check: \{"needed":true,"reason":"a new field"\}$/m);
  assert.match(out, /^Work folder work\/tickets\/7: notes\.md, sub\/shot\.png$/m);
  assert.match(out, /private reasoning/);
  assert.match(out, /^ {2}shared by about 5 tickets: every action of the session is shown/m);
  assert.match(out, /2 denied \(the CLI's count\)/);
  assert.match(out, /retry of claude-sonnet-5-5/);
  assert.ok(!out.includes('NOTES-BODY'), 'file names only');
  const last = lineOf(out, /last text:/);
  assert.equal(last, `  last text: ${'w'.repeat(400)}…`);
  assert.deepEqual(snapshot(w.root), before, 'trace writes nothing');
});

test('the default lookup: <CLAUDE_CONFIG_DIR>/projects/<slug of the host root>/<session>.jsonl', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  const slug = slugOf(w.root);
  assert.ok(!/[/.]/.test(slug) && slug.startsWith('-'));
  assert.equal(slugOf('/Users/x/Projects/HOST-DOC'), '-Users-x-Projects-HOST-DOC');
  assert.equal(slugOf('/Users/x/a.b/c'), '-Users-x-a-b-c');
  write(path.join(w.config, 'projects', slug, 's1.jsonl'), [use(1, 'a', 'Read', { file_path: 'from-config.md' })]);
  let out = '';
  await main(['trace', '7', '--root', w.root], { stdout: { write: (s) => (out += s) }, env: { CLAUDE_CONFIG_DIR: w.config } });
  assert.match(out, /read from-config\.md$/m);
  // Without CLAUDE_CONFIG_DIR the folder is <home>/.claude.
  const home = tmp('trace-home-');
  write(path.join(home, '.claude', 'projects', slug, 's1.jsonl'), [use(1, 'a', 'Read', { file_path: 'from-home.md' })]);
  out = '';
  await main(['trace', '7', '--root', w.root], { stdout: { write: (s) => (out += s) }, env: {}, home });
  assert.match(out, /read from-home\.md$/m);
});

test('trace refuses in a role session (DOC_TOOLKIT_ROLE_SESSION), before it reads anything; other commands are not affected', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [use(1, 'a', 'Read', { file_path: 'secret-plan.md' })]);
  let out = '';
  await fails(main(['trace', '7', '--root', w.root, '--transcripts', w.transcripts], { stdout: { write: (s) => (out += s) }, env: { DOC_TOOLKIT_ROLE_SESSION: '1' } }), 2, /^trace is for people/);
  assert.equal(out, '');
  await fails(main(['trace', '--root', '/nonexistent'], { stdout: { write() {} }, env: { DOC_TOOLKIT_ROLE_SESSION: '1' } }), 2, /^trace is for people/);
  await main(['config', '--root', w.root], { stdout: { write: (s) => (out += s) }, env: { DOC_TOOLKIT_ROLE_SESSION: '1' } });
  assert.match(out, /"command": "config"/);
});

test('--transcripts belongs to trace only', async () => {
  const w = setup();
  await fails(main(['config', '--root', w.root, '--transcripts', w.transcripts], { stdout: { write() {} }, env: {} }), 2, /--transcripts is an option of trace only/);
});

test('as a program: plain text on stdout, exit 0; an unknown stage and a role session exit 2', () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [use(1, 'a', 'Read', { file_path: 'x.md' })]);
  const env = { PATH: process.env.PATH, HOME: w.config, CLAUDE_CONFIG_DIR: w.config };
  const run = (args, e = env) => spawnSync(process.execPath, [CLI, 'trace', '7', '--root', w.root, '--transcripts', w.transcripts, ...args], { encoding: 'utf8', env: e });
  const ok = run([]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^Ticket 7\n/);
  assert.equal(run(['--stage', 'nonsense']).status, 2);
  const role = run([], { ...env, DOC_TOOLKIT_ROLE_SESSION: '1' });
  assert.equal(role.status, 2);
  assert.match(role.stderr, /trace is for people/);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env });
  assert.match(help.stdout, /trace <key>/);
});

// One test per form the mask knows. Each runs the form through the filter alone and checks the whole result: the value
// goes, the name and the scheme stay, the rest of the line is as it was.
const MASKED = [
  ['an X-Api-Key header', 'curl -H "X-Api-Key: v-one" https://host.test', 'curl -H "X-Api-Key: ***" https://host.test'],
  ['Authorization: Basic', 'curl -H "Authorization: Basic v-two" https://host.test', 'curl -H "Authorization: Basic ***" https://host.test'],
  ['Authorization: token', 'curl -H "Authorization: token v-three" https://host.test', 'curl -H "Authorization: token ***" https://host.test'],
  ['Authorization: Bearer (the scheme stays)', 'curl -H "Authorization: Bearer v-four" https://host.test', 'curl -H "Authorization: Bearer ***" https://host.test'],
  ['a Bearer value outside a header', 'the header is Bearer v-five and more', 'the header is Bearer *** and more'],
  ['a JSON password', `curl -d '{"password":"v-six"}' https://h`, `curl -d '{"password":***}' https://h`],
  ['a JSON password with spaces', `curl -d '{"password":"v seven x"}' https://h`, `curl -d '{"password":***}' https://h`],
  ['a JSON password inside an escaped string', 'curl -d "{\\"password\\":\\"v-eight\\"}" https://host.test', 'curl -d "{\\"password\\":\\"***\\"}" https://host.test'],
  ['curl -u user:password', 'curl -u admin:v-nine https://host.test', 'curl -u *** https://host.test'],
  ['a password in a URL', 'git clone https://bot:v-ten@host.example/x.git', 'git clone https://bot:***@host.example/x.git'],
  ['passwd=', 'run passwd=v-eleven now', 'run passwd=*** now'],
  ['pwd=', 'run pwd=v-twelve now', 'run pwd=*** now'],
  ['--password followed by a short flag', 'tool --password -v run', 'tool --password *** run'],
];
for (const [name, input, expected] of MASKED) {
  test(`mask: ${name}`, () => {
    const clean = cleaner({ root: '/zz-root', targets: [] }, { toolkit: null });
    assert.equal(clean(input, 500), expected);
  });
}

test('mask: what is not a secret is left alone', () => {
  const clean = cleaner({ root: '/zz-root', targets: [] }, { toolkit: null });
  for (const same of ['git push -u origin ticket-trace', 'tool --no-secret-check --foo bar', 'ls -u /tmp', 'cd /h2 && pwd']) assert.equal(clean(same, 500), same);
});

test('mask: every printed place is covered (a command, a refusal, the last text, the plan), not only the command', async () => {
  const w = setup({ plan: { pages: ['docs/a.md'], liveCheck: { reason: 'see "password": "e2e-four"' } }, runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Bash', { command: 'curl -H "X-Api-Key: e2e-one" https://host.test' }),
    use(2, 'b', 'Bash', { command: 'curl -u admin:e2e-two https://host.test' }),
    result('b', 'Permission to use Bash with command curl -u admin:e2e-two https://h has been denied.', true),
    text(3, 'I cloned https://bot:e2e-three@host.example/x.git and checked pwd=e2e-five'),
  ]);
  const { out } = await trace(w);
  for (const leak of ['e2e-one', 'e2e-two', 'e2e-three', 'e2e-four', 'e2e-five']) assert.ok(!out.includes(leak), `${leak} is not printed`);
  assert.match(out, /refused: Permission to use Bash with command curl -u \*\*\* https:\/\/h has been denied\./);
});

test('masking comes before the cut: a quoted secret that straddles character 200 is not left half shown', async () => {
  const command = `echo ${'a'.repeat(170)} --password "pa-secret-straddle-${'b'.repeat(30)}"`;
  assert.ok(command.indexOf('pa-secret') < 200 && command.length > 200 + 20, 'the fixture straddles the cut');
  const clean = cleaner({ root: '/zz-root', targets: [] }, { toolkit: null });
  const printed = clean(command, 200);
  assert.ok(!printed.includes('pa-secr') && !printed.includes('bbbb'));
  assert.match(printed, /--password \*\*\*$/);
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [use(1, 'a', 'Bash', { command })]);
  assert.ok(!(await trace(w)).out.includes('pa-secr'));
});

test('control characters are removed from every printed value: a transcript line, a last text, and the ledger fields', async () => {
  const esc = '\u001b[2K\u001b[1A';
  const w = setup({
    runs: [{ session: 's1', model: `claude-opus${esc}`, effort: `high\u009b31m`, role: `writer\u0007`, trigger: `sched${esc}ule`, outcome: `done${esc}`, stage: 'plan', pr: `repo#1${esc}`, retryOf: `m${esc}`, start: `not a date${esc}` }],
    extra: { card: { id: 'c1', url: `https://tracker.example/c/x${esc}`, name: 'n' } },
  });
  write(path.join(w.transcripts, 's1.jsonl'), [
    use(1, 'a', 'Bash', { command: `echo ${esc}hidden\u0000 done` }),
    result('a', `Permission to use Bash with command ${esc} has been denied.`, true),
    text(2, `all ${esc}done\u0008\u0008`),
  ]);
  const { out } = await trace(w);
  assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, 'no control character but the newlines of the layout');
  assert.match(out, /ran echo \[2K\[1Ahidden done$/m, 'the text stays, the escape characters go');
  assert.match(out, /claude-opus\[2K\[1A/);
  assert.match(out, /^Card: https:\/\/tracker\.example\/c\/x\[2K\[1A$/m);
});

test('a session id that starts with a dot is not a transcript name: ".." and ".hidden" print "transcript not found"', async () => {
  const w = setup({ runs: [{ session: '..' }, { session: '.hidden' }, { session: '../x' }] });
  write(path.join(w.transcripts, '...jsonl'), [use(1, 'a', 'Read', { file_path: 'LEAK-DOTS.md' })]);
  write(path.join(w.transcripts, '.hidden.jsonl'), [use(1, 'a', 'Read', { file_path: 'LEAK-HIDDEN.md' })]);
  const { out } = await trace(w);
  assert.equal(out.match(/transcript not found \(no session recorded\)/g).length, 3);
  assert.ok(!out.includes('LEAK-'));
});

test('a transcript that cannot be read is reported as unreadable, with no detail, and the report goes on', async () => {
  const w = setup({ runs: [{ session: 's1' }, { session: 's2', stage: 'write' }] });
  fs.mkdirSync(path.join(w.transcripts, 's1.jsonl'), { recursive: true });
  write(path.join(w.transcripts, 's2.jsonl'), [use(1, 'a', 'Read', { file_path: 'fine.md' })]);
  fs.mkdirSync(path.join(w.transcripts, 's2', 'subagents', 'bad.jsonl'), { recursive: true });
  write(path.join(w.transcripts, 's2', 'subagents', 'good.jsonl'), [use(2, 'b', 'Read', { file_path: 'sub.md' })]);
  const { out, code } = await trace(w);
  assert.equal(code, 0);
  assert.match(out, /^ {2}transcript unreadable$/m);
  assert.match(out, /^ {2}subagent bad: transcript unreadable$/m);
  assert.match(out, /read fine\.md$/m);
  assert.match(out, /^ {4}\S+ read sub\.md$/m);
  assert.match(out, /read 2, .*\(the session and its 1 subagent\(s\) together\)/);
  assert.doesNotMatch(out, /EISDIR|EACCES|ENOENT|\bat \S+ \(/);
});

test('the role-session guard: any value of the variable refuses, before the ledger is read, and the error names the variable', async () => {
  const w = setup({ runs: [{ session: 's1' }] });
  write(path.join(w.transcripts, 's1.jsonl'), [use(1, 'a', 'Read', { file_path: 'plan.md' })]);
  for (const value of ['writer', 'reviewer', '1', '']) {
    let out = '';
    // A key with no ledger would say "no ledger" if the ledger were read first.
    for (const key of ['7', '99']) {
      await assert.rejects(
        main(['trace', key, '--root', w.root, '--transcripts', w.transcripts], { stdout: { write: (s) => (out += s) }, env: { [ROLE_SESSION_VARIABLE]: value, CLAUDE_CONFIG_DIR: w.config } }),
        (e) => e.exitCode === 2 && e.message === `trace is for people: it is refused in a role session (${ROLE_SESSION_VARIABLE} is set)`,
        `value '${value}', key ${key}`,
      );
    }
    assert.equal(out, '', 'nothing printed');
  }
  // Without the variable the same call prints the trace.
  assert.match((await trace(w)).out, /read plan\.md$/m);
});

test('the mask does not backtrack on one very long line: 100k of "a-" is handled fast and comes out unchanged', () => {
  const clean = cleaner({ root: '/zz-root', targets: [] }, { toolkit: null });
  const line = 'a-'.repeat(50000);
  const started = Date.now();
  const printed = clean(line, 1e6);
  const took = Date.now() - started;
  assert.equal(printed, line);
  // Backtracking on 100k would take minutes: 15 s tells it apart from a slow machine under the parallel load of the
  // regression set.
  assert.ok(took < 15000, `took ${took} ms`);
  assert.equal(clean(`${line} --password "x y"`, 1e6), `${line} --password ***`);
});
