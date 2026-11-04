import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { kitSource, makeFixture, resolveKit } from './fixture.mjs';
import { changedPaths, check, frontmatterProblem, headingIdProblems, linkProblem, pageLinks, wasRead } from './assertions.mjs';
import { builtInChecks, harnessSettings, loadCase, overLimit, parseReset, parseUsage, readTranscript, summarize, weekAllowance } from './run.mjs';
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

test('fixture: a product kit is declared and written; with no files it is declared only', () => {
  const host = tmp();
  const files = makeFixture(host, 'single', { kit: { files: { 'glossary-en.md': '# Glossary\n', 'templates/a.md': ['one\n', 'two\n'] } } });
  assert.match(fs.readFileSync(path.join(host, 'CLAUDE.md'), 'utf8'), /^- \*\*Product kit:\*\* `doc-kit\/`$/m);
  assert.ok(files.includes('doc-kit/glossary-en.md'));
  assert.equal(fs.readFileSync(path.join(host, 'doc-kit/templates/a.md'), 'utf8'), 'one\ntwo\n');
  assert.equal(git(host, 'status', '--porcelain'), '');

  const missing = tmp();
  makeFixture(missing, 'single', { kit: { folder: 'kit', files: {} } });
  assert.match(fs.readFileSync(path.join(missing, 'CLAUDE.md'), 'utf8'), /Product kit:\*\* `kit\/`/);
  assert.equal(fs.existsSync(path.join(missing, 'kit')), false);

  const none = tmp();
  makeFixture(none, 'single');
  assert.doesNotMatch(fs.readFileSync(path.join(none, 'CLAUDE.md'), 'utf8'), /Product kit/);
});

test('fixture: kit sources from git, with lines and replacements; kit names resolve', () => {
  assert.equal(kitSource({ git: 'HEAD:tools/harness/README.md', lines: '1,1-1' }), '# Skill harness\n# Skill harness\n');
  assert.equal(kitSource({ git: 'HEAD:tools/harness/README.md', lines: '1', replace: [['Skill', 'Case']] }), '# Case harness\n');
  assert.throws(() => kitSource({ git: 'HEAD:tools/harness/README.md', lines: '1', replace: [['nowhere', 'x']] }, 'a.md'), /a\.md: 'nowhere' is not in/);
  assert.throws(() => resolveKit({ files: { 'a.md': { path: 'x' } } }), /a source is a string/);
  assert.throws(() => resolveKit('no-such-kit'), /unknown kit 'no-such-kit'/);
  const absent = '0123456789abcdef0123456789abcdef01234567';
  assert.throws(() => kitSource({ git: `${absent}:README.md` }, 'a.md'), new RegExp(`a\\.md: the kit needs commit ${absent}: fetch full history`));
  const kit = resolveKit('migrated-701654b');
  assert.equal(kit.folder, 'doc-kit/');
  for (const f of ['glossary-ua.md', 'glossary-en.md', 'product-facts.md', 'product-rules.md', 'templates/ua-user-guide-template.md']) assert.ok(f in kit.files, f);
  assert.equal(resolveKit(null), null);
});

test('assertions: read and not-read, from the Read calls of a transcript', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/out/x/case/run-1/host/doc-kit/glossary-en.md' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/out/x/.plugin/harness-x/context/doc-rules/glossary-format.md' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat doc-kit/product-rules.md' } }] } }),
  ].join('\n');
  const { reads } = readTranscript(lines);
  assert.equal(reads.length, 2);
  const run = (a) => check(a, { host: tmp(), output: '', status: '', reads }).pass;
  assert.equal(run({ type: 'read', path: 'doc-kit/glossary-en.md' }), true);
  assert.equal(run({ type: 'read', path: 'context/doc-rules/glossary-format.md' }), true);
  assert.equal(run({ type: 'not-read', path: 'doc-kit/glossary-en.md' }), false);
  assert.equal(run({ type: 'read', path: 'kit/glossary-en.md' }), false, 'a path matches whole segments');
  assert.equal(run({ type: 'read', path: 'doc-kit/product-rules.md' }), false, 'only Read calls count');
  assert.equal(wasRead([], 'a.md'), false);
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
  const page = 'portal/transactions/transactions.md';
  const before = fs.readFileSync(path.join(host, page), 'utf8');
  fs.writeFileSync(path.join(host, page), before.replace('1. У меню', '0. Відкрийте кабінет.\n1. У меню').replace('**Фільтри**', '**Фільтрування**'));
  const after = { ...ctx, status: git(host, 'status', '--porcelain') };
  assert.equal(check({ type: 'diff-lines', path: page, allow: 'Фільтри' }, after).pass, true);
  assert.equal(check({ type: 'diff-lines', path: page }, after).pass, false);
  fs.writeFileSync(path.join(host, page), before.replace('Список оновлюється автоматично.', 'Список оновлюється автоматично. Його можна експортувати.'));
  assert.equal(check({ type: 'diff-lines', path: page }, ctx).pass, true);
  fs.writeFileSync(path.join(host, page), before);
  const calls = { ...ctx, skills: ['harness-x:extract-sme-screenshots'] };
  assert.equal(check({ type: 'skill-called', skill: 'extract-sme-screenshots' }, calls).pass, true);
  assert.equal(check({ type: 'skill-not-called', skill: 'extract-sme-screenshots' }, calls).pass, false);
  assert.equal(check({ type: 'skill-not-called', skill: 'convert-sme-input' }, calls).pass, true);
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
  const ok = '# Title\n\n## Статуси {/* #statuses */}\n\n### Нові {/* #new-statuses */}\n\nДив. [статуси](#statuses).\n\n```md\n## Code\n```\n';
  assert.deepEqual(headingIdProblems(ok), []);
  assert.deepEqual(headingIdProblems('## Old\n\n## A {/* #a */}\n\n## B {/* #a */}\n\n[x](#b)\n', ['Old']), ['repeated id: a', 'link to a missing id: #b']);
  assert.deepEqual(headingIdProblems('## Bad {/* #Bad_Id */}\n## Plain\n'), ["no id: 'Bad {/* #Bad_Id */}'", "no id: 'Plain'"]);
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

// Recorded /usage texts (2026-11-04). The reset prints as "6am" and, on the same day, as "5:59am".
const usageText = (week, reset = 'Nov 7 at 5:59am (Europe/Kiev)', extra = '') => `Current session: 21% used · resets Nov 4 at 12:10pm (Europe/Kiev)\nCurrent week (all models): ${week}% used · resets ${reset}\n${extra}`;
const fableLine = 'Current week (Fable): 0% used · resets Nov 7 at 6am (Europe/Kiev)\n';
const daily = { maxSessionPercent: 80, dailyWeekPercent: 10, maxWeekPercent: null };
const at = (iso) => new Date(iso);

test('usage: parses the /usage bars; the session limit stops at or above the threshold', () => {
  const text = 'Current session: 81% used · resets Oct 24 at 3:40pm (Europe/Kiev)\nCurrent week (all models): 12% used · resets Oct 31 at 6am (Europe/Kiev)\n';
  const usage = parseUsage(text);
  assert.deepEqual(usage.session, { percent: 81, resets: 'Oct 24 at 3:40pm (Europe/Kiev)' });
  assert.deepEqual(usage.week, { percent: 12, resets: 'Oct 31 at 6am (Europe/Kiev)' });
  const now = at('2026-10-26T10:00:00Z'); // day 2 of the week that resets Oct 31
  assert.match(overLimit(usage, daily, now), /5-hour session is at 81%/);
  assert.equal(overLimit(usage, { ...daily, maxSessionPercent: 90 }, now), null);
  assert.deepEqual(parseUsage('You are using an API key'), { session: null, week: null });
  assert.equal(overLimit(parseUsage(''), { maxSessionPercent: 0, dailyWeekPercent: 0, maxWeekPercent: 0 }), null);
});

test('reset: both time formats, the zone across DST, no year, the leap day', () => {
  const now = at('2026-11-04T08:00:00Z');
  const iso = (t, n = now) => new Date(parseReset(t, n)).toISOString();
  assert.equal(iso('Nov 7 at 6am (Europe/Kiev)'), '2026-11-07T04:00:00.000Z');
  assert.equal(iso('Nov 7 at 5:59am (Europe/Kiev)'), '2026-11-07T03:59:00.000Z');
  assert.equal(iso('Nov 7 at 12pm (Europe/Kiev)'), '2026-11-07T10:00:00.000Z');
  assert.equal(iso('Nov 7 at 12am (UTC)'), '2026-11-07T00:00:00.000Z');
  // Kyiv leaves summer time on Oct 25, 2026: +3 before the switch, +2 after it.
  const oct = at('2026-10-20T08:00:00Z');
  assert.equal(iso('Oct 20 at 6am (Europe/Kiev)', oct), '2026-10-20T03:00:00.000Z');
  assert.equal(iso('Oct 25 at 6am (Europe/Kiev)', oct), '2026-10-25T04:00:00.000Z');
  // New York leaves summer time on Nov 1, 2026.
  assert.equal(iso('Nov 1 at 6am (America/New_York)', oct), '2026-11-01T11:00:00.000Z');
  assert.equal(iso('Oct 31 at 6am (America/New_York)', oct), '2026-10-31T10:00:00.000Z');
  // The year: the next occurrence, or one that is less than a day past.
  assert.equal(iso('Jan 2 at 6am (Europe/Kiev)', at('2026-12-30T10:00:00Z')), '2027-01-02T04:00:00.000Z');
  assert.equal(iso('Dec 31 at 6am (Europe/Kiev)', at('2027-01-01T01:00:00Z')), '2026-12-31T04:00:00.000Z');
  assert.equal(iso('Nov 7 at 6am (Europe/Kiev)', at('2026-11-07T09:00:00Z')), '2026-11-07T04:00:00.000Z');
  assert.equal(iso('Nov 7 at 6am (Europe/Kiev)', at('2026-11-09T09:00:00Z')), '2027-11-07T04:00:00.000Z');
  assert.equal(iso('Feb 29 at 6am (UTC)', at('2027-02-20T00:00:00Z')), '2028-02-29T06:00:00.000Z');
  // Unreadable.
  for (const bad of [null, '', 'soon', 'Nov 7', 'Nov 7 at 6 (Europe/Kiev)', 'Nov 7 at 13am (UTC)', 'Foo 7 at 6am (UTC)', 'Feb 30 at 6am (UTC)', 'Nov 7 at 6am (Mars/Olympus)']) {
    assert.equal(parseReset(bad, now), null, String(bad));
  }
  // A wall-clock time the zone skips (Kyiv jumps from 3:00 to 4:00 on Mar 29, 2026).
  assert.equal(parseReset('Mar 29 at 3:30am (Europe/Kiev)', at('2026-03-20T00:00:00Z')), null);
  assert.equal(new Date(parseReset('Mar 29 at 4:30am (Europe/Kiev)', at('2026-03-20T00:00:00Z'))).toISOString(), '2026-03-29T01:30:00.000Z');
});

test('allowance: each day of the window, 10% a day, stops at the day\'s figure', () => {
  // The reset is Sat Nov 7, 5:59 Kyiv (03:59Z), so the window starts Sat Oct 31 at 03:59Z. Day n is [start + (n-1) d, start + n d).
  const start = Date.parse('2026-10-31T03:59:00Z');
  for (let day = 1; day <= 7; day++) {
    for (const offsetMin of [0, 13 * 60, 24 * 60 - 1]) {
      const now = new Date(start + (day - 1) * 86400000 + offsetMin * 60000);
      const below = usageText(10 * day - 1);
      const atFigure = usageText(10 * day);
      assert.equal(overLimit(parseUsage(below), daily, now), null, `day ${day} +${offsetMin} min, ${10 * day - 1}%`);
      assert.match(overLimit(parseUsage(atFigure), daily, now), new RegExp(`week is at ${10 * day}% \\(allowance ${10 * day}%: 10% a day, day ${day} of 7\\)`), `day ${day} +${offsetMin} min`);
    }
  }
  // The example: on Wednesday 10:00 (Kyiv) it is day 5, so a run is allowed below 50%.
  const wed = at('2026-11-04T08:00:00Z');
  assert.deepEqual(weekAllowance(parseUsage(usageText(39)).week, daily, wed), { day: 5, allowance: 50, cap: 50 });
  assert.equal(overLimit(parseUsage(usageText(39)), daily, wed), null);
  assert.equal(overLimit(parseUsage(usageText(49)), daily, wed), null);
  assert.match(overLimit(parseUsage(usageText(50)), daily, wed), /week is at 50%/);
  // The "6am" form reads the same way.
  assert.equal(overLimit(parseUsage(usageText(49, 'Nov 7 at 6am (Europe/Kiev)')), daily, wed), null);
  assert.match(overLimit(parseUsage(usageText(50, 'Nov 7 at 6am (Europe/Kiev)')), daily, wed), /week is at 50%/);
});

test('allowance: the day is clamped to the window, the figure to 100, and a day can add more than 10', () => {
  const week = { percent: 0, resets: 'Nov 7 at 6am (Europe/Kiev)' };
  assert.equal(weekAllowance(week, daily, at('2026-10-30T00:00:00Z')).day, 1); // a clock before the window
  assert.equal(weekAllowance(week, daily, at('2026-11-07T08:00:00Z')).day, 7); // the reset just passed
  assert.equal(weekAllowance(week, { ...daily, dailyWeekPercent: 20 }, at('2026-11-06T08:00:00Z')).allowance, 100);
  assert.equal(weekAllowance(week, { ...daily, dailyWeekPercent: 20 }, at('2026-11-04T08:00:00Z')).allowance, 100);
  assert.equal(weekAllowance(week, { ...daily, dailyWeekPercent: 25 }, at('2026-11-02T08:00:00Z')).allowance, 75);
});

test('allowance: a reset across the end of a month and of a year', () => {
  // Reset Sun Nov 1, 5:59 Kyiv (03:59Z; the clocks went back on Oct 25): the window starts Oct 25 at 03:59Z.
  const monthEnd = 'Nov 1 at 5:59am (Europe/Kiev)';
  const cases = [['2026-10-25T10:00:00Z', 1], ['2026-10-27T10:00:00Z', 3], ['2026-10-31T10:00:00Z', 7]];
  for (const [iso, day] of cases) {
    assert.deepEqual(weekAllowance({ percent: 0, resets: monthEnd }, daily, at(iso)), { day, allowance: 10 * day, cap: 10 * day }, iso);
  }
  assert.equal(overLimit(parseUsage(usageText(69, monthEnd)), daily, at('2026-10-31T10:00:00Z')), null);
  assert.match(overLimit(parseUsage(usageText(70, monthEnd)), daily, at('2026-10-31T10:00:00Z')), /week is at 70%/);
  // Reset Sat Jan 2, 2027, 6am Kyiv: Dec 31 is day 6.
  assert.equal(weekAllowance({ percent: 0, resets: 'Jan 2 at 6am (Europe/Kiev)' }, daily, at('2026-12-31T10:00:00Z')).day, 6);
});

test('allowance: the per-model week lines are ignored', () => {
  const wed = at('2026-11-04T08:00:00Z');
  const fable90 = 'Current week (Fable): 90% used · resets Nov 7 at 6am (Europe/Kiev)\n';
  assert.equal(overLimit(parseUsage(usageText(39, undefined, fableLine)), daily, wed), null);
  assert.equal(overLimit(parseUsage(usageText(39, undefined, fable90)), daily, wed), null);
  // Even above the all-models line, and with a different reset.
  const before = `Current week (Fable): 90% used · resets Nov 9 at 6am (Europe/Kiev)\n${usageText(39)}`;
  assert.deepEqual(parseUsage(before).week, { percent: 39, resets: 'Nov 7 at 5:59am (Europe/Kiev)' });
  assert.equal(overLimit(parseUsage(before), daily, wed), null);
  // Only a per-model week line: no plan bar for the guard to read.
  assert.equal(parseUsage(fable90).week, null);
});

test('allowance: maxWeekPercent, when set, lowers the figure; the smaller cap wins', () => {
  const wed = at('2026-11-04T08:00:00Z'); // day 5, allowance 50
  assert.match(overLimit(parseUsage(usageText(35)), { ...daily, maxWeekPercent: 30 }, wed), /week is at 35% \(limit 30%\)/);
  assert.equal(overLimit(parseUsage(usageText(29)), { ...daily, maxWeekPercent: 30 }, wed), null);
  assert.match(overLimit(parseUsage(usageText(55)), { ...daily, maxWeekPercent: 80 }, wed), /allowance 50%: 10% a day, day 5 of 7/);
  assert.equal(overLimit(parseUsage(usageText(45)), { ...daily, maxWeekPercent: 80 }, wed), null);
});

test('allowance: a reset that can\'t be read stops the run with a message that says so', () => {
  const wed = at('2026-11-04T08:00:00Z');
  for (const reset of ['soon', 'later', 'Nov 7 at 6am (Mars/Olympus)', 'Nov 7']) {
    const reason = overLimit(parseUsage(usageText(1, reset)), daily, wed);
    assert.match(reason, /reset can't be read from \/usage/, reset);
    assert.match(reason, /not running blind/, reset);
    assert.ok(reason.includes(`"${reset}"`), reset);
  }
  // The week line printed with no reset at all.
  const noReset = overLimit(parseUsage('Current session: 5% used\nCurrent week (all models): 1% used\n'), daily, wed);
  assert.match(noReset, /no reset printed/);
  // A high session reading still reports first.
  assert.match(overLimit(parseUsage('Current session: 95% used · resets later\nCurrent week (all models): 1% used · resets later\n'), daily, wed), /5-hour session/);
});

test('settings: defaults, then local.json, then HARNESS_* variables', () => {
  const dir = tmp();
  const file = path.join(dir, 'local.json');
  assert.deepEqual(harnessSettings({}, file), { mode: 'on', maxSessionPercent: 80, dailyWeekPercent: 10, maxWeekPercent: null });
  fs.writeFileSync(file, JSON.stringify({ mode: 'off', maxWeekPercent: 20 }));
  assert.deepEqual(harnessSettings({}, file), { mode: 'off', maxSessionPercent: 80, dailyWeekPercent: 10, maxWeekPercent: 20 });
  fs.writeFileSync(file, JSON.stringify({ maxSessionPercent: 100, dailyWeekPercent: 15 }));
  assert.deepEqual(harnessSettings({}, file), { mode: 'on', maxSessionPercent: 100, dailyWeekPercent: 15, maxWeekPercent: null });
  assert.deepEqual(harnessSettings({ HARNESS_MODE: 'on', HARNESS_MAX_SESSION_PERCENT: '30', HARNESS_DAILY_WEEK_PERCENT: '5' }, file), { mode: 'on', maxSessionPercent: 30, dailyWeekPercent: 5, maxWeekPercent: null });
});

// A stand-in for the CLI: `/usage` prints FAKE_SESSION%, FAKE_WEEK% and the week's reset (FAKE_WEEK_RESET, or in about 3 days: day 5, 50% allowed);
// a run prints a passing transcript.
function fakeClaude(dir) {
  const bin = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === '/usage') {
  console.log('Current session: ' + process.env.FAKE_SESSION + '% used · resets soon');
  const soon = new Date(Date.now() + 3 * 86400000);
  const reset = process.env.FAKE_WEEK_RESET || soon.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + soon.getUTCDate() + ' at 6am (UTC)';
  console.log('Current week (all models): ' + (process.env.FAKE_WEEK ?? '1') + '% used · resets ' + reset);
  console.log('Current week (Fable): 0% used · resets ' + reset);
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
const harness = (args, env) => spawnSync('node', [runner, '--tree', plugin, ...args], { encoding: 'utf8', env: { ...process.env, HARNESS_MAX_SESSION_PERCENT: '', HARNESS_MAX_WEEK_PERCENT: '', HARNESS_DAILY_WEEK_PERCENT: '', HARNESS_MODE: '', ...env } });

// A plain case with no kit: the runner tests build no kit, so they pass in a shallow clone too.
function plainCase(dir) {
  const file = path.join(dir, 'plain-case.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'plain-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [] }));
  return file;
}

test('runner: off makes no run; the guard stops before a run; --resume skips finished cases', () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  const claude = fakeClaude(dir);
  const plain = plainCase(dir);
  const off = harness(['--label', 'x', '--case', plain, '--out', out, '--claude', claude], { HARNESS_MODE: 'off' });
  assert.equal(off.status, 3);
  assert.equal(fs.existsSync(out), false);

  const stopped = harness(['--label', 'x', '--case', plain, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '95' });
  assert.equal(stopped.status, 4);
  assert.match(stopped.stdout, /stopped before plain-case run 1: the 5-hour session is at 95%/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.length, 0);

  // The week: about 3 days to the reset is day 5, so 50% is allowed; 60% stops, 20% runs.
  const overAllowance = harness(['--label', 'x', '--case', plain, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10', FAKE_WEEK: '60' });
  assert.equal(overAllowance.status, 4);
  assert.match(overAllowance.stdout, /stopped before plain-case run 1: the week is at 60% \(allowance 50%: 10% a day, day 5 of 7\)/);
  // A reset the guard can't read stops the run, and says so.
  const blind = harness(['--label', 'x', '--case', plain, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10', FAKE_WEEK_RESET: 'soon' });
  assert.equal(blind.status, 4);
  assert.match(blind.stdout, /stopped before plain-case run 1: the week is at 1%, but its reset can't be read from \/usage \("soon"\).*not running blind/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.length, 0);

  const first = harness(['--label', 'x', '--case', plain, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10', FAKE_WEEK: '20' });
  assert.equal(first.status, 0, first.stderr);
  const run = JSON.parse(fs.readFileSync(path.join(out, 'x', 'plain-case', 'run-1', 'assertions.json'), 'utf8'));
  assert.equal(run.find((c) => c.name === 'sentinel-loaded').pass, true);

  const second = path.join(dir, 'second-case.json');
  fs.writeFileSync(second, JSON.stringify({ id: 'second-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [] }));
  const resumed = harness(['--label', 'x', '--case', `${plain},${second}`, '--runs', '1', '--out', out, '--claude', claude, '--resume'], { FAKE_SESSION: '10' });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /second-case run 1\/1/);
  assert.doesNotMatch(resumed.stderr, /plain-case run 1\/1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.map((s) => s.case), ['plain-case', 'second-case']);

  // rescore: a corrected assertion re-checks the saved run, with no model call.
  fs.writeFileSync(second, JSON.stringify({ id: 'second-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [{ type: 'match', path: 'output', pattern: 'nope' }] }));
  const rescore = (args) => spawnSync('node', [path.join(path.dirname(runner), 'rescore.mjs'), ...args], { encoding: 'utf8' });
  assert.match(rescore(['--out', out, '--label', 'x', '--case', second]).stdout, /second-case: 0\/1 runs passed/);
  fs.writeFileSync(second, JSON.stringify({ id: 'second-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [{ type: 'match', path: 'output', pattern: '^ok$' }] }));
  assert.match(rescore(['--out', out, '--label', 'x', '--case', second]).stdout, /second-case: 1\/1 runs passed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.find((s) => s.case === 'second-case').passedRuns, 1);
});

test('runner: a bad pattern fails before any run; a crash keeps the cases already finished', () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  const claude = fakeClaude(dir);
  const plain = plainCase(dir);
  const bad = path.join(dir, 'bad-case.json');
  fs.writeFileSync(bad, JSON.stringify({ id: 'bad-case', fixture: { shape: 'single' }, prompt: 'p', assertions: [{ type: 'match', path: 'output', pattern: '(?i)x' }] }));
  const refused = harness(['--label', 'x', '--case', `${plain},${bad}`, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /bad-case\.json: assertion .*Invalid regular expression/);
  assert.equal(fs.existsSync(out), false);

  const crash = path.join(dir, 'crash-case.json');
  fs.writeFileSync(crash, JSON.stringify({ id: 'crash-case', fixture: { shape: 'single' }, setup: ['exit 1'], prompt: 'p', assertions: [] }));
  const crashed = harness(['--label', 'x', '--case', `${plain},${crash}`, '--runs', '1', '--out', out, '--claude', claude], { FAKE_SESSION: '10' });
  assert.notEqual(crashed.status, 0);
  assert.match(crashed.stderr, /crash-case: setup 'exit 1' exited 1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8')).cases.map((s) => s.case), ['plain-case']);
});

test('runner: a harness copy outside any repo reads kit sources from the tree; a missing commit fails its case only', () => {
  const dir = fs.realpathSync(tmp());
  const out = path.join(dir, 'out');
  const claude = fakeClaude(dir);
  const copy = path.join(dir, 'harness');
  fs.cpSync(path.dirname(runner), copy, { recursive: true, filter: (src) => path.basename(src) !== 'local.json' });
  assert.equal(spawnSync('git', ['-C', copy, 'rev-parse'], { stdio: 'ignore' }).status === 0, false, 'the copy sits outside any repo');
  const kitCase = path.join(dir, 'kit-case.json');
  fs.writeFileSync(kitCase, JSON.stringify({ id: 'kit-case', fixture: { shape: 'single', kit: { files: { 'a.md': { git: 'HEAD:tools/harness/README.md', lines: '1' } } } }, prompt: 'p', assertions: [{ type: 'match', path: 'doc-kit/a.md', pattern: '^# Skill harness\\n$' }] }));
  const absent = '0123456789abcdef0123456789abcdef01234567';
  const missing = path.join(dir, 'missing-case.json');
  fs.writeFileSync(missing, JSON.stringify({ id: 'missing-case', fixture: { shape: 'single', kit: { files: { 'a.md': { git: `${absent}:README.md` } } } }, prompt: 'p', assertions: [] }));
  const plain = plainCase(dir);
  const run = spawnSync('node', [path.join(copy, 'run.mjs'), '--tree', plugin, '--label', 'x', '--case', `${kitCase},${missing},${plain}`, '--runs', '1', '--out', out, '--claude', claude],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, HARNESS_MAX_SESSION_PERCENT: '', HARNESS_MAX_WEEK_PERCENT: '', HARNESS_DAILY_WEEK_PERCENT: '', HARNESS_MODE: '', FAKE_SESSION: '10' } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /missing-case: not run: a\.md: the kit needs commit 0123456789abcdef0123456789abcdef01234567: fetch full history/);
  const pass = JSON.parse(fs.readFileSync(path.join(out, 'x', 'pass.json'), 'utf8'));
  assert.deepEqual(pass.cases.map((s) => [s.case, s.passedRuns, Boolean(s.error)]), [['kit-case', 1, false], ['missing-case', 0, true], ['plain-case', 1, false]]);
});
