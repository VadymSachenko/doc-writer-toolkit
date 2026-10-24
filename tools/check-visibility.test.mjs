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

test('parseDetails: reads the Source line and the per-component rows', () => {
  const { source, components } = parseDetails(details);
  assert.equal(source, 'visibility-sentinel@inline');
  assert.deepEqual([...components.keys()], ['loaded-skill', 'empty-skill', 'barely-skill', 'a-command']);
  assert.equal(components.get('empty-skill').alwaysOn, '< 20');
});

test('verdict: flags `< 20`, an estimate under half the predicted size, a missing row and a foreign Source', () => {
  const expected = new Map([
    ['loaded-skill', 'x'.repeat(560)],
    ['empty-skill', 'x'.repeat(520)],
    ['barely-skill', 'x'.repeat(494)],
    ['a-command', 'x'.repeat(63)],
    ['missing-skill', 'x'.repeat(100)],
  ]);
  const findings = verdict(parseDetails(details), expected);
  assert.deepEqual(findings.map((f) => f.split(':')[0]), ['empty-skill', 'barely-skill', 'missing-skill']);
  assert.match(verdict(parseDetails(details.replace('visibility-sentinel@inline', 'doc-writer-toolkit@market')), new Map())[0], /not 'visibility-sentinel@inline'/);
});
