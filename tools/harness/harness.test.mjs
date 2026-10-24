import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture } from './fixture.mjs';
import { changedPaths, check, frontmatterProblem, linkProblem, pageLinks } from './assertions.mjs';
import { builtInChecks, loadCase, readTranscript, summarize } from './run.mjs';

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

test('summaries: pass counts per assertion, and the cost', () => {
  const c = { id: 'case-a' };
  const r = (passes) => ({ costUsd: 0.25, seconds: 10, checks: passes.map((pass, i) => ({ name: `a${i}`, pass })) });
  const s = summarize(c, [r([true, true]), r([true, false]), r([true, false])]);
  assert.deepEqual(s.assertions, [{ name: 'a0', passed: 3 }, { name: 'a1', passed: 1 }]);
  assert.equal(s.passedRuns, 1);
  assert.equal(s.costUsd, 0.75);
});
