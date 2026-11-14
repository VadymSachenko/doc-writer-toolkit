import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptionOf, parseDetails, tokens, verdict } from './check-visibility.mjs';

const details = [
  'visibility-sentinel',
  '  Source: visibility-sentinel@inline',
  '',
  'Per-component (rounded)',
  '  component                   always-on  on-invoke',
  '  loaded-skill                     ~200      ~5.6k',
  '  empty-skill                      < 20      ~3.9k',
  '  barely-skill                      ~20        ~4k',
  '  a-command                         ~30        ~80',
  '  twin                             ~30        ~80',
  '  twin                            ~140      ~2.2k',
  '',
  '  On-invoke cost is paid each time a skill or agent fires.',
].join('\n');

test('descriptionOf: reads plain, single-quoted and CRLF descriptions without a YAML parser', () => {
  assert.equal(descriptionOf('---\nname: x\ndescription: Plain: text\n---\n'), 'Plain: text');
  assert.equal(descriptionOf("---\r\nname: x\r\ndescription: 'It''s quoted'\r\n---\r\n"), "It's quoted");
  assert.equal(descriptionOf('# no frontmatter\n'), '');
});

test('tokens: reads the CLI estimates', () => {
  assert.equal(tokens('< 20'), 0);
  assert.equal(tokens('~320'), 320);
  assert.equal(tokens('~1.6k'), 1600);
  assert.equal(tokens('~2,440'), 2440);
});

test('parseDetails: reads the Source line and the per-component rows, each row of a repeated name kept', () => {
  const { source, components } = parseDetails(details);
  assert.equal(source, 'visibility-sentinel@inline');
  assert.deepEqual([...components.keys()], ['loaded-skill', 'empty-skill', 'barely-skill', 'a-command', 'twin']);
  assert.equal(components.get('empty-skill')[0].alwaysOn, '< 20');
  assert.deepEqual(components.get('twin').map((r) => r.alwaysOn), ['~30', '~140']);
});

const skill = (name, length) => ({ kind: 'skill', name, description: 'x'.repeat(length) });
const command = (name, length) => ({ kind: 'command', name, description: 'x'.repeat(length) });

test('verdict: flags `< 20`, an estimate under half the predicted size, a missing row and a foreign Source', () => {
  const expected = [skill('loaded-skill', 560), skill('empty-skill', 520), skill('barely-skill', 494), skill('missing-skill', 100), command('a-command', 63)];
  const findings = verdict(parseDetails(details), expected);
  assert.deepEqual(findings.map((f) => f.split(':')[0]), ['skill empty-skill', 'skill barely-skill', 'skill missing-skill']);
  assert.match(verdict(parseDetails(details.replace('visibility-sentinel@inline', 'doc-writer-toolkit@market')), [])[0], /not 'visibility-sentinel@inline'/);
});

test('verdict: a skill and a command of the same name are a finding, and each is still checked against a row of that name', () => {
  // The command's row comes first in the table: the rows pair in the order with the fewest findings.
  assert.deepEqual(verdict(parseDetails(details), [skill('twin', 560), command('twin', 63)]), [
    "twin: a skill and a command of the same name; the table can't tell them apart and a session lists one description for both",
  ]);
  // A skill half that loads without its description is not hidden by the command's row.
  const empty = details.replace('  twin                            ~140      ~2.2k', '  twin                            < 20      ~2.2k');
  assert.deepEqual(verdict(parseDetails(empty), [skill('twin', 560), command('twin', 63)]).map((f) => f.split(':')[0]), ['twin', 'skill twin']);
  // Only one row for the two: the other half is missing.
  const one = details.replace('  twin                            ~140      ~2.2k\n', '');
  assert.match(verdict(parseDetails(one), [skill('twin', 560), command('twin', 63)])[1], /^skill twin: not in the per-component table/);
});
