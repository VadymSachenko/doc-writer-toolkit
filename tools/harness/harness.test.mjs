import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeFixture } from './fixture.mjs';
import { changedPaths, check, frontmatterProblem, linkProblem, pageLinks } from './assertions.mjs';
import { builtInChecks, harnessSettings, loadCase, overLimit, parseUsage, readTranscript, summarize } from './run.mjs';
import { compare, verdict } from './compare.mjs';
import { coin, mask } from './blind.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('fixture: single has one pair and one commit; multi adds the API reference pair', () => {
  const single = tmp();
  const files = makeFixture(single, 'single');
  assert.equal(git(single, 'log', '--oneline').trim().split('\n').length, 1);
  assert.equal(git(single, 'status', '--porcelain'), '');
  assert.ok(files.includes('portal/transactions/transactions.md'));
  assert.ok(!files.some((f) => f.startsWith('docs/')));
  assert.doesNotMatch(fs.readFileSync(path.join(single, 'CLAUDE.md'), 'utf8'), /API reference/);

  const multi = tmp();
  makeFixture(multi, 'multi', { locales: ['de'], docusaurus: true });
  const claude = fs.readFileSync(path.join(multi, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /API reference UA content root:\*\* `docs\/`/);
  assert.match(fs.readFileSync(path.join(multi, 'docusaurus.config.ts'), 'utf8'), /locales: \['uk','en','de'\]/);
  assert.ok(fs.existsSync(path.join(multi, 'package.json')));
  const uk = fs.readFileSync(path.join(multi, 'docs/transactions/transactions.md'), 'utf8').match(/^## /gm).length;
  const en = fs.readFileSync(path.join(multi, 'i18n/en/docusaurus-plugin-content-docs/current/transactions/transactions.md'), 'utf8').match(/^## /gm).length;
  assert.equal(uk - en, 1, 'the API EN page misses exactly one section');
  assert.throws(() => makeFixture(multi, 'multi'), /not empty/);
});

test('assertions: files, patterns, frontmatter, links and the changed paths', () => {
  const host = tmp();
  makeFixture(host, 'single');
  fs.writeFileSync(path.join(host, 'new.md'), '---\ntitle: New\n---\n\n[a](/portal/a) [b](../b.md) ![i](/img/x.png) [c](https://example.com)\n');
  const status = git(host, '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all');
  const ctx = { host, output: 'Saved the page.', status };
  const run = (a) => check(a, ctx).pass;
  assert.equal(run({ type: 'exists', path: 'new.md' }), true);
  assert.equal(run({ type: 'absent', path: 'new.md' }), false);
  assert.equal(run({ type: 'match', path: 'new.md', pattern: '^title: New$', flags: 'm' }), true);
  assert.equal(run({ type: 'no-match', path: 'output', pattern: 'api-reference' }), true);
  assert.equal(run({ type: 'match', path: 'missing.md', pattern: 'x' }), false);
  assert.equal(run({ type: 'frontmatter', path: 'new.md' }), true);
  assert.equal(run({ type: 'links', path: 'new.md', form: 'root-relative' }), false);
  assert.equal(run({ type: 'unchanged' }), false);
  assert.equal(run({ type: 'unchanged', ignore: ['new.md'] }), true);
  assert.equal(run({ type: 'changed-only', paths: ['new.md'] }), true);
  assert.equal(run({ type: 'changed-only', paths: ['i18n/'] }), false);
  assert.equal(run({ type: 'command', run: 'test -f new.md' }), true);
  assert.equal(run({ type: 'command', run: 'exit 3' }), false);
  assert.equal(run({ type: 'nonsense' }), false);
});

test('assertions: helpers', () => {
  assert.deepEqual(pageLinks('[a](/x) ![i](/y.png) [b](#top) [c](/d.pdf) [e](/f "t")'), ['/x', '/f']);
  assert.equal(linkProblem('/portal/a#s', 'root-relative'), null);
  assert.equal(linkProblem('../b', 'root-relative'), 'not root-relative');
  assert.equal(linkProblem('/b.md', 'root-relative'), 'has a file extension');
  assert.equal(frontmatterProblem('---\ndescription: a: b\n---\n'), 'description: value would not parse as a plain string');
  assert.equal(frontmatterProblem("---\r\ndescription: 'a: b'\r\n---\r\n"), null);
  assert.equal(frontmatterProblem('---\ntitle: T\nlast_update:\n  date: 10/24/2026\ntags:\n  - one\n---\n'), null);
  assert.match(frontmatterProblem('---\ntitle: T\n  date: 1\n---\n'), /no parent key/);
  assert.match(frontmatterProblem('---\nlast_update:\n  date: a: b\n---\n'), /date: value would not parse/);
  assert.deepEqual(changedPaths(' M a.md\n?? b/c.md\nR  old.md -> new.md\n'), ['a.md', 'b/c.md', 'new.md']);
});

const transcript = (sources, skills = []) => [
  JSON.stringify({ type: 'system', subtype: 'init', plugins: sources.map((source) => ({ source })) }),
  ...skills.map((skill) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } })),
  JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.5, result: 'done' }),
].join('\n');

test('built-in checks: the sentinel must load, and no other copy of the plugin may be called', () => {
  const own = new Set(['doc-translator']);
  const ok = builtInChecks(readTranscript(transcript(['harness-main@inline'], ['harness-main:doc-translator'])), 'harness-main', own);
  assert.deepEqual(ok.map((c) => c.pass), [true, true]);
  const wrong = builtInChecks(readTranscript(transcript(['harness-main@inline'])), 'harness-other', own);
  assert.equal(wrong[0].pass, false);
  const foreign = builtInChecks(readTranscript(transcript(['harness-main@inline', 'doc-writer-toolkit@doc-writer-toolkit'], ['doc-writer-toolkit:doc-translator', 'other:thing'])), 'harness-main', own);
  assert.equal(foreign[1].pass, false);
  assert.match(foreign[1].detail, /doc-writer-toolkit:doc-translator/);
  assert.deepEqual(readTranscript(transcript([])).result.total_cost_usd, 0.5);
});

test('summaries and compare: pass counts per assertion, and the verdicts', () => {
  const c = { id: 'case-a' };
  const r = (passes) => ({ costUsd: 0.25, seconds: 10, checks: passes.map((pass, i) => ({ name: `a${i}`, pass })) });
  const s = summarize(c, [r([true, true]), r([true, false]), r([true, false])]);
  assert.deepEqual(s.assertions, [{ name: 'a0', passed: 3 }, { name: 'a1', passed: 1 }]);
  assert.equal(s.passedRuns, 1);
  assert.equal(s.costUsd, 0.75);
  assert.equal(verdict({ passed: 3, runs: 3 }, { passed: 2, runs: 3 }), 'regressed');
  assert.equal(verdict({ passed: 0, runs: 3 }, { passed: 3, runs: 3 }), 'fixed');
  assert.equal(verdict({ passed: 1, runs: 3 }, { passed: 3, runs: 3 }), 'mixed');
  assert.equal(verdict({ passed: 3, runs: 3 }, { passed: 3, runs: 3 }), 'same: pass');
  const after = summarize(c, [r([false, true]), r([true, true]), r([true, true])]);
  assert.deepEqual(compare({ cases: [s] }, { cases: [after] }).map((x) => x.verdict), ['regressed', 'mixed']);
});

test('blind packet helpers: a seeded coin repeats, and masking hides labels and run paths', () => {
  const a = coin(42);
  const b = coin(42);
  assert.deepEqual([a(), a(), a(), a()], [b(), b(), b(), b()]);
  const text = mask('Used harness-main:doc-translator; wrote /tmp/out/main/case/run-1/host/i18n/x.md', ['main', 'branch']);
  assert.doesNotMatch(text, /main|run-1/);
  assert.match(text, /PLUGIN:doc-translator/);
});

test('the bundled cases load', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'cases');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const c = loadCase(path.join(dir, f));
    assert.equal(`${c.id}.json`, f);
  }
});

test('usage: parses the /usage bars, and the limits stop at or above the threshold', () => {
  const text = 'Current session: 81% used · resets Oct 24 at 3:40pm (Europe/Kiev)\nCurrent week (all models): 12% used · resets Oct 31 at 6am (Europe/Kiev)\n';
  const usage = parseUsage(text);
  assert.deepEqual(usage.session, { percent: 81, resets: 'Oct 24 at 3:40pm (Europe/Kiev)' });
  assert.equal(usage.week.percent, 12);
  assert.match(overLimit(usage, { maxSessionPercent: 80, maxWeekPercent: 50 }), /5-hour session is at 81%/);
  assert.equal(overLimit(usage, { maxSessionPercent: 90, maxWeekPercent: 50 }), null);
  assert.match(overLimit(usage, { maxSessionPercent: 90, maxWeekPercent: 12 }), /week is at 12%/);
  assert.deepEqual(parseUsage('You are using an API key'), { session: null, week: null });
  assert.equal(overLimit(parseUsage(''), { maxSessionPercent: 0, maxWeekPercent: 0 }), null);
});

test('settings: defaults, then local.json, then HARNESS_* variables', () => {
  const dir = tmp();
  const file = path.join(dir, 'local.json');
  assert.deepEqual(harnessSettings({}, file), { mode: 'on', maxSessionPercent: 80, maxWeekPercent: 50 });
  fs.writeFileSync(file, JSON.stringify({ mode: 'off', maxWeekPercent: 20 }));
  assert.deepEqual(harnessSettings({}, file), { mode: 'off', maxSessionPercent: 80, maxWeekPercent: 20 });
  assert.deepEqual(harnessSettings({ HARNESS_MODE: 'on', HARNESS_MAX_SESSION_PERCENT: '30' }, file), { mode: 'on', maxSessionPercent: 30, maxWeekPercent: 20 });
});

// A stand-in for the CLI: `/usage` prints FAKE_SESSION% and FAKE_WEEK%; a run prints a passing transcript.
function fakeClaude(dir) {
  const bin = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === '/usage') {
  console.log('Current session: ' + process.env.FAKE_SESSION + '% used · resets soon');
  console.log('Current week (all models): ' + (process.env.FAKE_WEEK ?? '1') + '% used · resets later');
  process.exit(0);
}
const sentinel = args[args.indexOf('--plugin-dir') + 1].split('/').pop();
console.log(JSON.stringify({ type: 'system', subtype: 'init', plugins: [{ source: sentinel + '@inline' }] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01, result: 'ok' }));
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const runner = path.join(path.dirname(new URL(import.meta.url).pathname), 'run.mjs');
const plugin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'plugins', 'doc-writer-toolkit');
const harness = (args, env) => spawnSync('node', [runner, '--tree', plugin, ...args], { encoding: 'utf8', env: { ...process.env, HARNESS_MAX_SESSION_PERCENT: '', HARNESS_MAX_WEEK_PERCENT: '', HARNESS_MODE: '', ...env } });

test('runner: off makes no run; the guard stops before a run; --resume skips finished cases', () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  const claude = fakeClaude(dir);
  const off = harness(['--label', 'x', '--case', 'tc-01-translate-single-pair', '--out', out, '--claude', claude], { HARNESS_MODE: 'off' });
  assert.equal(off.status, 3);
  assert.equal(fs.existsSync(out), false);

  const stopped = harness(['--label', 'x', '--case', 'tc-01-translate-single-pair', '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '95' });
  assert.equal(stopped.status, 4);
  assert.match(stopped.stdout, /stopped before tc-01-translate-single-pair run 1: the 5-hour session is at 95%/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.length, 0);

  const first = harness(['--label', 'x', '--case', 'tc-01-translate-single-pair', '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10' });
  assert.equal(first.status, 0, first.stderr);
  const run = JSON.parse(fs.readFileSync(path.join(out, 'x', 'tc-01-translate-single-pair', 'run-1', 'assertions.json'), 'utf8'));
  assert.equal(run.find((c) => c.name === 'sentinel-loaded').pass, true);

  const second = path.join(dir, 'second-case.json');
  fs.writeFileSync(second, JSON.stringify({ id: 'second-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [] }));
  const resumed = harness(['--label', 'x', '--case', `tc-01-translate-single-pair,${second}`, '--runs', '1', '--out', out, '--claude', claude, '--resume'], { FAKE_SESSION: '10' });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /second-case run 1\/1/);
  assert.doesNotMatch(resumed.stderr, /tc-01-translate-single-pair run 1\/1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.map((s) => s.case), ['tc-01-translate-single-pair', 'second-case']);
});

test('runner: a bad pattern fails before any run; a crash keeps the cases already finished', () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  const claude = fakeClaude(dir);
  const bad = path.join(dir, 'bad-case.json');
  fs.writeFileSync(bad, JSON.stringify({ id: 'bad-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [{ type: 'match', path: 'output', pattern: '(?i)x' }] }));
  const refused = harness(['--label', 'x', '--case', `tc-01-translate-single-pair,${bad}`, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /bad-case\.json: assertion .*Invalid regular expression/);
  assert.equal(fs.existsSync(out), false);

  const crash = path.join(dir, 'crash-case.json');
  fs.writeFileSync(crash, JSON.stringify({ id: 'crash-case', fixture: { shape: 'single' }, setup: ['exit 1'], prompt: 'p', assertions: [] }));
  const crashed = harness(['--label', 'x', '--case', `tc-01-translate-single-pair,${crash}`, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10' });
  assert.notEqual(crashed.status, 0);
  assert.match(crashed.stderr, /crash-case: setup 'exit 1' exited 1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.map((s) => s.case), ['tc-01-translate-single-pair']);
});
