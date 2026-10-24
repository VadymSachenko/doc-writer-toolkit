import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationProblems, applyKnownGaps, checkFrontmatter, contractProblems, isRouted, MAX_DESCRIPTION, rootRefs, routedPaths, scalarProblem } from './lint-plugin.mjs';

const skill = (description, name = 'my-skill') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const messages = (findings) => findings.map((f) => `${f.line}: ${f.message}`);

test('frontmatter: a quoted description with an invocation example passes', () => {
  assert.deepEqual(checkFrontmatter(skill(`'Writes pages. Use explicitly ("my-skill: write the X page"). It''s explicit-only.'`), { kind: 'skill', folder: 'my-skill' }), []);
});

test('frontmatter: an unquoted ": " is reported on the description line', () => {
  const findings = checkFrontmatter(skill('Writes pages. Use explicitly ("my-skill: write the X page").'), { kind: 'skill', folder: 'my-skill' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.match(findings[0].message, /can't contain ': '/);
});

test('frontmatter: an apostrophe inside single quotes must be doubled', () => {
  assert.equal(scalarProblem("'It''s fine'"), null);
  assert.match(scalarProblem("'It's not'"), /single-quoted/);
  assert.match(scalarProblem("'never closed"), /single-quoted/);
});

test('frontmatter: plain values that YAML reads differently are reported', () => {
  assert.match(scalarProblem('[a, b]'), /can't start with/);
  assert.match(scalarProblem('- item'), /can't start with/);
  assert.match(scalarProblem('text # comment'), /' #'/);
  assert.match(scalarProblem('ends with:'), /': '/);
  assert.equal(scalarProblem('Plain text, with commas — and "quotes".'), null);
  assert.equal(scalarProblem('"double \\"quoted\\" text"'), null);
  assert.match(scalarProblem('"bad \\q escape"'), /double-quoted/);
});

test('frontmatter: name must be kebab-case and match the folder; description is required and bounded', () => {
  assert.deepEqual(messages(checkFrontmatter(skill('Fine.', 'other-name'), { kind: 'skill', folder: 'my-skill' })), [
    "2: name 'other-name' differs from its folder 'my-skill'",
  ]);
  assert.match(messages(checkFrontmatter(skill('Fine.', 'My_Skill'), { kind: 'skill', folder: 'My_Skill' }))[0], /not kebab-case/);
  assert.match(messages(checkFrontmatter(skill('x'.repeat(MAX_DESCRIPTION + 1)), { kind: 'skill', folder: 'my-skill' }))[0], /over 1024/);
  assert.deepEqual(messages(checkFrontmatter('---\nargument-hint: "<slug>"\n---\n', { kind: 'command' })), ["1: missing 'description'"]);
});

test('frontmatter: a missing or unclosed block, a continuation line and a duplicate key are reported', () => {
  assert.match(messages(checkFrontmatter('# no frontmatter\n', { kind: 'command' }))[0], /no frontmatter block/);
  assert.match(messages(checkFrontmatter('---\ndescription: x\n', { kind: 'command' }))[0], /not closed/);
  assert.deepEqual(messages(checkFrontmatter('---\ndescription: >-\n  folded\n---\n', { kind: 'command' })), [
    "2: description: an unquoted value can't start with '>-'; wrap it in single quotes",
    '3: frontmatter lines must be single-line `key: value`',
  ]);
  assert.match(messages(checkFrontmatter('---\ndescription: a\ndescription: b\n---\n', { kind: 'command' }))[0], /duplicate key/);
});

test('rootRefs: extracts plugin-root paths with line numbers and skips placeholders', () => {
  const text = [
    'Load `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` first.',
    'Then ${CLAUDE_PLUGIN_ROOT}/context/doc-templates/.',
    'Run "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs", then ${CLAUDE_PLUGIN_ROOT}/a/b.md: done',
    'Skip ${CLAUDE_PLUGIN_ROOT}/commands/<slug>.md and ${CLAUDE_PLUGIN_ROOT}/x/*.md and ${CLAUDE_PLUGIN_ROOT}/f/{name}.md',
  ].join('\n');
  assert.deepEqual(rootRefs(text), [
    { ref: '/context/project-paths.md', line: 1 },
    { ref: '/context/doc-templates/', line: 2 },
    { ref: '/scripts/x.mjs', line: 3 },
    { ref: '/a/b.md', line: 3 },
  ]);
});

test('routedPaths: reads backticked paths from the Load column only, skipping the header and separator', () => {
  const routing = [
    '# Rule router',
    '',
    '| Task or signal | Load | Scope |',
    '|---|---|---|',
    '| Voice | `shared/voice/` | mixed |',
    '| Terms | Search `en-us/terminology/INDEX.md`; load `en-us/a.md` only for X | language-specific (en-US) |',
    '',
    'Text with `not/a/row.md`.',
  ].join('\n');
  assert.deepEqual(routedPaths(routing), [
    { path: 'shared/voice/', line: 5 },
    { path: 'en-us/terminology/INDEX.md', line: 6 },
    { path: 'en-us/a.md', line: 6 },
  ]);
});

test('isRouted: a file is reached through a named file, a named folder or the allowlist', () => {
  const named = [{ path: 'shared/voice/' }, { path: 'en-us/a.md' }];
  assert.equal(isRouted('shared/voice/tone.md', named, []), true);
  assert.equal(isRouted('en-us/a.md', named, []), true);
  assert.equal(isRouted('maintenance/qa-report.md', named, ['maintenance/']), true);
  assert.equal(isRouted('en-us/b.md', named, ['README.md']), false);
  assert.equal(isRouted('shared/voices.md', named, []), false);
});

test('frontmatter: a CRLF file parses like an LF one', () => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  assert.deepEqual(checkFrontmatter(crlf(skill(`'Writes pages. Use explicitly ("my-skill: write the X page").'`)), { kind: 'skill', folder: 'my-skill' }), []);
  const findings = checkFrontmatter(crlf(skill('Writes pages. Use explicitly ("my-skill: write the X page").')), { kind: 'skill', folder: 'my-skill' });
  assert.deepEqual(messages(findings), ["3: description: an unquoted value can't contain ': ' or ' #'; wrap it in single quotes and write an apostrophe as ''"]);
  assert.deepEqual(messages(checkFrontmatter(crlf('---\nname: other\ndescription: Fine.\n---\n'), { kind: 'skill', folder: 'my-skill' })), [
    "2: name 'other' differs from its folder 'my-skill'",
  ]);
});

test('known gaps: a listed finding does not fail, an unlisted one does', () => {
  const known = [{ file: 'a.md', message: 'no ROUTING.md row reaches this rule file', reason: 'no row yet' }];
  const { failing, known: listed } = applyKnownGaps([
    { file: 'a.md', line: 1, message: 'no ROUTING.md row reaches this rule file; add a row' },
    { file: 'b.md', line: 1, message: 'no ROUTING.md row reaches this rule file; add a row' },
  ], known);
  assert.deepEqual(failing.map((f) => f.file), ['b.md']);
  assert.deepEqual(listed.map((f) => [f.file, f.reason]), [['a.md', 'no row yet']]);
});

test('known gaps: a listed gap that no longer occurs fails, so the list can only shrink', () => {
  const known = [{ file: 'a.md', message: 'no ROUTING.md row reaches this rule file', reason: 'no row yet' }];
  const { failing, known: listed } = applyKnownGaps([], known);
  assert.equal(listed.length, 0);
  assert.equal(failing.length, 1);
  assert.match(failing[0].message, /known gap no longer occurs.*remove it/);
});

test('annotations: a frame must be square and unfilled', () => {
  const block = (props) => `x\n\`\`\`javascript\nObject.assign(box.style, {\n  border: '3px solid red',\n${props}\n});\n\`\`\`\n`;
  assert.deepEqual(annotationProblems(block("  borderRadius: '0',\n  background: 'transparent',")), []);
  assert.deepEqual(annotationProblems(block("  borderRadius: '6px',\n  background: 'transparent',")).map((p) => p.message), ["annotation frame without borderRadius: '0'"]);
  assert.deepEqual(annotationProblems(block("  borderRadius: '0',\n  backgroundColor: 'rgba(255,0,0,.2)',")).map((p) => p.message), ["annotation frame without background: 'transparent'", 'annotation frame with a fill or an outline']);
  assert.equal(annotationProblems(block("  borderRadius: '0',")).length, 1);
  assert.equal(annotationProblems(block("  borderRadius: '0',\n  background: 'transparent',"))[0], undefined);
  assert.deepEqual(annotationProblems("Object.assign(el.style, { color: 'red' })"), []);
});

test('contract: the five parts are found under any heading, and each missing one is reported', () => {
  const full = '---\nname: x\n---\n\n## Overview\n\n**Out of scope:** y\n\n## Inputs\n\n- a\n\n### Step 1 — A\n\n### Step 2 — B\n\n## Self-review before saving\n\n## Explicit invocation examples\n';
  assert.deepEqual(contractProblems(full), []);
  const bare = '---\nname: x\n---\n\n# x\n\nText.\n\n```md\n## Scope\n## Explicit invocation examples\n```\n';
  assert.deepEqual(contractProblems(bare).map((p) => p.message.replace('skill contract: no ', '')), ['scope', 'sources to load', 'ordered steps', 'self-review', 'invocation examples']);
  assert.deepEqual(contractProblems(bare, { readOnly: true }).map((p) => p.message).includes('skill contract: no self-review'), false);
  assert.deepEqual(contractProblems('## Scope\n## Sources to load\n## Workflow\n\n1. Do it.\n\n## Checklist\n## Explicit invocation examples\n'), []);
});
