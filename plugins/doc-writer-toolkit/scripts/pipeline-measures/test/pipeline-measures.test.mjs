import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main } from '../pipeline-measures.mjs';
import { openQuestions, summarize } from '../lib/measures.mjs';
import { parseCommit } from '../lib/gitdata.mjs';
import { assertGhRead, assertGitRead, makeGit } from '../lib/runners.mjs';
import { cardLinks, createTrelloClient, loadCredentials, parseEnvFile } from '../lib/trello.mjs';
import { readRunLog } from '../lib/runlog.mjs';
import { loadSettings } from '../lib/config.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'pipeline-measures.mjs');
const LIB = path.join(HERE, '..', 'lib');

const KEY = 'test-key-0123456789abcdef';
const TOKEN = 'test-token-fedcba9876543210';

// ------------------------------------------------------------------ fixture host
// A throwaway docs repo with three pull requests' worth of history, and the `gh` and Trello JSON that describe them.

const sh = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir, message) => {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
};

const DRAFT = ['# Page', '', 'Intro.', '{/* NEEDS CONFIRMATION: limit? */}', '{/* ToDo: add a screenshot */}', 'Step one.', 'Step two.', '{/* NEEDS CONFIRMATION: roles? */}'].join('\n') + '\n';

function host({ block = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-measures-'));
  sh(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md', 'docs\n');
  const base = commit(dir, 'Initial');
  const o = { base };

  // PR 1: the pipeline's commits, then the owner's, with a merge of main in the middle.
  sh(dir, 'switch', '-q', '-c', '10-add-page-doc');
  write(dir, 'docs/page.md', DRAFT);
  o.draft = commit(dir, 'Draft: add the page');
  write(dir, 'docs/page.md', DRAFT.replace('{/* NEEDS CONFIRMATION: limit? */}\n', 'The limit is 5.\n').replace('{/* ToDo: add a screenshot */}\n', ''));
  o.fix = commit(dir, 'Fix: resolve the markers');
  write(dir, 'i18n/en/page.md', '# Page\n\nIntro.\n');
  o.en = commit(dir, 'EN translation');
  write(dir, 'docs/ready.txt', 'ready\n');
  o.ready = commit(dir, 'Ready for merge');
  write(dir, 'docs/page.md', fs.readFileSync(path.join(dir, 'docs/page.md'), 'utf8').replace('Step one.\n', 'Step 1.\nStep 1b.\n'));
  o.owner1 = commit(dir, 'Update page.md');
  sh(dir, 'switch', '-q', 'main');
  write(dir, 'other.md', 'other\n');
  o.mainMove = commit(dir, 'Unrelated change on main');
  sh(dir, 'switch', '-q', '10-add-page-doc');
  sh(dir, 'merge', '-q', '--no-ff', '-m', 'Merge branch main into the branch', 'main');
  o.merge = sh(dir, 'rev-parse', 'HEAD');
  write(dir, 'docs/page.md', fs.readFileSync(path.join(dir, 'docs/page.md'), 'utf8').replace('Step two.\n', ''));
  o.owner2 = commit(dir, 'Apply a suggestion');

  // PR 2: by hand, no pipeline commit at all.
  sh(dir, 'switch', '-q', 'main');
  sh(dir, 'switch', '-q', '-c', '11-by-hand-doc');
  write(dir, 'docs/hand.md', 'one\ntwo\n');
  o.hand = commit(dir, 'Add hand.md');

  // PR 3: a branch the pattern does not match. PR 4: matches, but created before the window.
  sh(dir, 'switch', '-q', 'main');
  sh(dir, 'switch', '-q', '-c', 'tooling');
  write(dir, 'tool.mjs', 'x\n');
  o.tool = commit(dir, 'Draft: not a docs branch');
  sh(dir, 'switch', '-q', 'main');
  if (block) {
    write(dir, 'CLAUDE.md', ['# Host', '', '## Documentation toolkit configuration', '', '- **Pipeline branch pattern:** `-doc$`', '- **Pipeline commit pattern:** `^(Draft|Fix|Screenshots):|^EN translation`', '- **Draft commit pattern:** `^Draft:`', ''].join('\n'));
  }
  return { dir, o };
}

// The tests only read the repository, so one copy of each shape serves them all.
const cache = {};
const shared = ({ block = true } = {}) => (cache[block] ??= host({ block }));

const commitJson = (oid, subject, date) => ({ oid, messageHeadline: subject, committedDate: date, authoredDate: date, authors: [], messageBody: '' });

const BODY1 = [
  '## Description', '', '- `docs/page.md`: added.', '', '## Task link', '', '- [Card](https://trello.com/c/AbCd1234/10-card)', '- [Other](https://trello.com/c/WxYz5678/11-other)', '',
  '## Open questions', '', '- docs/page.md: is the limit right?', '- docs/page.md: who sees the page?', '  - a nested note', '1. numbered item', '', '## Notes', '', '- not a question', '',
].join('\n');

function ghFixture(o) {
  const list = [
    { number: 10, title: 'Add page', state: 'MERGED', isDraft: false, headRefName: '10-add-page-doc', createdAt: '2026-10-01T09:00:00Z', mergedAt: '2026-10-05T09:00:00Z', closedAt: '2026-10-05T09:00:00Z', body: BODY1, author: { login: 'owner' }, reviewRequests: [{ login: 'r1' }], reviews: [{ author: { login: 'owner' } }, { author: { login: 'r1' } }] },
    { number: 11, title: 'By hand', state: 'OPEN', isDraft: false, headRefName: '11-by-hand-doc', createdAt: '2026-10-10T09:00:00Z', mergedAt: null, closedAt: null, body: 'No sections here.', author: { login: 'owner' }, reviewRequests: [], reviews: [{ author: { login: 'owner' } }] },
    { number: 12, title: 'Tooling', state: 'OPEN', isDraft: false, headRefName: 'tooling', createdAt: '2026-10-11T09:00:00Z', mergedAt: null, closedAt: null, body: '', author: { login: 'owner' }, reviewRequests: [], reviews: [] },
    { number: 13, title: 'Early', state: 'CLOSED', isDraft: false, headRefName: '13-early-doc', createdAt: '2026-09-19T23:59:59Z', mergedAt: null, closedAt: '2026-09-20T09:00:00Z', body: '', author: { login: 'owner' }, reviewRequests: [], reviews: [] },
  ];
  const commits = {
    10: [
      commitJson(o.draft, 'Draft: add the page', '2026-10-01T10:00:00Z'),
      commitJson(o.fix, 'Fix: resolve the markers', '2026-10-01T11:00:00Z'),
      commitJson(o.en, 'EN translation', '2026-10-01T12:00:00Z'),
      commitJson(o.ready, 'Ready for merge', '2026-10-01T13:00:00Z'),
      commitJson(o.owner1, 'Update page.md', '2026-10-02T09:00:00Z'),
      commitJson(o.merge, 'Merge branch main into the branch', '2026-10-02T10:00:00Z'),
      commitJson(o.owner2, 'Apply a suggestion', '2026-10-02T11:00:00Z'),
    ],
    11: [commitJson(o.hand, 'Add hand.md', '2026-10-10T08:00:00Z')],
  };
  return { list, commits };
}

// The cards: AbCd1234 moved into the SME list twice (the earliest counts), WxYz5678 never did.
const TRELLO = {
  AbCd1234: [
    { date: '2026-10-03T09:00:00.000Z', data: { listBefore: { name: 'Blocked' }, listAfter: { name: 'In SME review' } } },
    { date: '2026-10-01T10:30:00.000Z', data: { listBefore: { name: 'In progress' }, listAfter: { name: 'in sme review' } } },
    { date: '2026-10-01T09:30:00.000Z', data: { listBefore: { name: 'ToDo' }, listAfter: { name: 'In progress' } } },
  ],
  WxYz5678: [{ date: '2026-10-01T09:30:00.000Z', data: { listBefore: { name: 'ToDo' }, listAfter: { name: 'In progress' } } }],
};

function fakeGh(fx, log = []) {
  return async (args) => {
    log.push(args);
    assertGhRead(args);
    if (args[1] === 'list') return JSON.stringify(fx.list);
    if (args[1] === 'view') return JSON.stringify({ commits: fx.commits[Number(args[2])] ?? [] });
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
}

function fakeFetch(calls = []) {
  return async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u.toString(), headers: init.headers });
    const m = u.pathname.match(/^\/1\/cards\/(\w+)\/actions$/);
    const body = m && TRELLO[m[1]];
    return { status: body ? 200 : 404, ok: Boolean(body), text: async () => JSON.stringify(body ?? { message: 'not found' }) };
  };
}

async function measure(dir, extra, io) {
  const out = [];
  const err = [];
  const code = await main(['--root', dir, '--from', '2026-09-20', '--to', '2026-11-03', ...extra], { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, env: {}, ...io });
  return { code, json: JSON.parse(out.join('')), table: err.join('') };
}

const pr = (result, n) => result.json.prs.find((p) => p.number === n);

const FLAGS = ['--sme-list', 'In SME review', '--ready-pattern', '^Ready for merge', '--review', 'places'];

// ------------------------------------------------------------------ the measures

test('every measure on a fixture repo', async () => {
  const { dir, o } = shared();
  const fx = ghFixture(o);
  const r = await measure(dir, FLAGS, { git: makeGit(dir), gh: fakeGh(fx), fetchImpl: fakeFetch(), env: { TRELLO_API_KEY: KEY, TRELLO_API_TOKEN: TOKEN } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.prs.map((p) => p.number), [10, 11], 'the window and the branch pattern pick the PRs');

  const p = pr(r, 10);
  assert.deepEqual({ ...p.commits, pipelineOids: undefined, ownerOids: undefined }, { pipeline: 4, owner: 2, merge: 1, notInClone: 0, pipelineOids: undefined, ownerOids: undefined });
  assert.deepEqual(p.commits.pipelineOids, [o.draft, o.fix, o.en, o.ready].map((x) => x.slice(0, 12)));
  assert.deepEqual(p.commits.ownerOids, [o.owner1, o.owner2].map((x) => x.slice(0, 12)));

  // The draft added three marker lines; the fix removed two.
  assert.deepEqual(p.draft, { commits: 1, markers: 3 });
  // The card entered SME review at 10:30, after the draft and before the fix: three markers were open.
  assert.equal(p.smeReview.at, '2026-10-01T10:30:00.000Z');
  assert.deepEqual({ cards: p.smeReview.cards, cardsWithEntry: p.smeReview.cardsWithEntry, entries: p.smeReview.entries }, { cards: 2, cardsWithEntry: 1, entries: 2 });
  assert.equal(p.markersAtSmeReview, 3);
  // The section "Open questions": four list items, the nested one included; the next section's item does not count.
  assert.deepEqual(p.openQuestions, { section: true, items: 4 });
  // The owner's two commits: +2 -1 in the first (one line replaced by two), -1 in the second.
  assert.deepEqual(p.owner, { commits: 2, beforePipeline: 0, linesAdded: 2, linesRemoved: 2, lines: 4, files: 1 });
  // The final edit: the owner's commits after "Ready for merge", up to the merge.
  assert.deepEqual(p.finalEdit, { readyCommit: o.ready.slice(0, 12), until: 'merge', commits: 2, linesAdded: 2, linesRemoved: 2, lines: 4, files: 1, oids: [o.owner1, o.owner2].map((x) => x.slice(0, 12)) });
  assert.deepEqual(p.review, { hadReviewer: true, requested: 1, reviewed: 1 });
  assert.ok('na' in p.places && 'na' in p.cost, 'places and cost have no source yet');

  // PR 11: by hand, no pipeline commit; a review by its own author is not a reviewer.
  const h = pr(r, 11);
  assert.deepEqual(h.commits, { pipeline: 0, owner: 1, merge: 0, notInClone: 0, pipelineOids: [], ownerOids: [o.hand.slice(0, 12)] });
  assert.match(h.draft.na, /no commit matches the draft pattern/);
  assert.deepEqual(h.owner, { commits: 1, beforePipeline: 0, linesAdded: 2, linesRemoved: 0, lines: 2, files: 1 });
  assert.match(h.smeReview.na, /links no card/);
  assert.deepEqual(h.openQuestions, { section: false, items: 0 });
  assert.match(h.finalEdit.na, /no commit marks the PR ready/);
  assert.equal(h.review.hadReviewer, false);

  // The totals, and the table, which has a row per PR.
  const s = r.json.summary;
  assert.deepEqual(s.prs, { total: 2, merged: 1, open: 1, closed: 0 });
  assert.deepEqual(s.commits, { pipeline: 4, owner: 3, merge: 1 });
  assert.equal(s.draft.markers, 3);
  assert.equal(s.owner.lines, 6);
  assert.equal(s.finalEdit.lines, 4);
  assert.equal(s.smeReview.measured, 1);
  assert.deepEqual(s.openQuestions, { prsWithSection: 1, items: 4 });
  assert.match(r.table, /#10\s+merged/);
  assert.match(r.table, /#11\s+open/);
  assert.match(r.table, /n\/a/);
});

test('a measure with no data source is n/a with a reason, never a zero', async () => {
  const { dir, o } = shared({ block: false });
  const r = await measure(dir, ['--branch-pattern=-doc$', '--commit-pattern', '^(Draft|Fix):|^EN translation'], { git: makeGit(dir), gh: fakeGh(ghFixture(o)) });
  const p = pr(r, 10);
  assert.match(p.draft.na, /no draft commit pattern declared/);
  assert.match(p.finalEdit.na, /no ready-for-merge marker is defined/);
  assert.match(p.smeReview.na, /no SME review list declared/);
  assert.match(p.markersAtSmeReview.na, /no SME review list declared/);
  assert.match(p.review.na, /review policy is sme/);
  assert.match(p.places.na, /review policy is sme/);
  assert.match(p.cost.na, /no run log declared/);
  for (const k of ['draft', 'smeReview', 'finalEdit', 'review', 'places', 'cost']) assert.ok('na' in r.json.summary[k], `${k} is n/a in the summary`);
  assert.match(r.table, /final edit: n\/a/);
  assert.match(r.table, /cost: n\/a/);
});

test('without Trello credentials the SME measure is n/a and nothing is requested', async () => {
  const { dir, o } = shared();
  const calls = [];
  const r = await measure(dir, ['--sme-list', 'In SME review'], { git: makeGit(dir), gh: fakeGh(ghFixture(o)), fetchImpl: fakeFetch(calls), env: {} });
  assert.match(pr(r, 10).smeReview.na, /no Trello credentials/);
  assert.equal(calls.length, 0);
});

test('a card Trello cannot read is a warning, and the other cards still count', async () => {
  const { dir, o } = shared();
  const fx = ghFixture(o);
  fx.list[0].body = BODY1 + '\n[Gone](https://trello.com/c/GoneGone/1-x)\n';
  const r = await measure(dir, ['--sme-list', 'In SME review'], { git: makeGit(dir), gh: fakeGh(fx), fetchImpl: fakeFetch(), env: { TRELLO_API_KEY: KEY, TRELLO_API_TOKEN: TOKEN } });
  assert.equal(pr(r, 10).smeReview.at, '2026-10-01T10:30:00.000Z');
  assert.ok(r.json.warnings.some((w) => /PR 10: a linked card could not be read \(GET .*HTTP 404\)/.test(w)));
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
});

test('commits missing from the clone are counted but their lines are not, with a warning', async () => {
  const { dir, o } = shared();
  const fx = ghFixture(o);
  fx.commits[11].push(commitJson('f'.repeat(40), 'Update elsewhere.md', '2026-10-10T09:00:00Z'));
  const r = await measure(dir, [], { git: makeGit(dir), gh: fakeGh(fx) });
  const h = pr(r, 11);
  assert.equal(h.commits.owner, 2);
  assert.equal(h.commits.notInClone, 1);
  assert.equal(h.owner.lines, 2);
  assert.ok(r.json.warnings.some((w) => /PR 11: 1 commit\(s\) are not in the clone/.test(w)));
});

test('--redact leaves out branch names and titles', async () => {
  const { dir, o } = shared();
  const r = await measure(dir, ['--redact'], { git: makeGit(dir), gh: fakeGh(ghFixture(o)) });
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes('add-page') && !text.includes('Add page') && !text.includes('hand.md'));
  assert.equal(pr(r, 10).number, 10);
});

test('an unfinished PR counts its final edit up to the head', async () => {
  const { dir, o } = shared();
  const fx = ghFixture(o);
  fx.list[0].state = 'OPEN';
  fx.list[0].mergedAt = null;
  const r = await measure(dir, ['--ready-pattern', '^Ready for merge'], { git: makeGit(dir), gh: fakeGh(fx) });
  assert.equal(pr(r, 10).finalEdit.until, 'head');
});

// ------------------------------------------------------------------ the sources a later source can replace

test('one source per measure can be replaced: a ledger would supply the ready commit, the places and the cost', async () => {
  const { dir, o } = shared();
  const sources = {
    // A ledger lists the pipeline's commits and the ready commit; no pattern is involved.
    classify: (_pr, c) => ({ role: [o.draft, o.fix].includes(c.oid) ? 'pipeline' : 'owner', draft: c.oid === o.draft, ready: c.oid === o.en }),
    places: async () => ({ listed: 4, passedToReviewer: 2, corrected: 1 }),
    runs: async () => ({ total: { cost: 3.5, inputTokens: 10, outputTokens: 5, steps: 2 }, byStage: { write: { cost: 3.5 } } }),
  };
  const r = await measure(dir, ['--review', 'places'], { git: makeGit(dir), gh: fakeGh(ghFixture(o)), sources });
  const p = pr(r, 10);
  assert.equal(p.draft.markers, 3);
  assert.equal(p.commits.pipeline, 2);
  assert.equal(p.finalEdit.readyCommit, o.en.slice(0, 12));
  assert.equal(p.finalEdit.commits, 3, 'the ready commit and the owner commits after it, minus the pipeline ones');
  assert.deepEqual(p.places, { listed: 4, passedToReviewer: 2, corrected: 1 });
  assert.equal(r.json.summary.places.passedToReviewer, 4, 'both PRs report the same stub');
  assert.equal(r.json.summary.cost.cost, 7, 'both PRs report the same stub');
});

// ------------------------------------------------------------------ run log

test('the run log is summed per PR and stage; a missing file is n/a', async () => {
  const { dir, o } = shared();
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), [
    JSON.stringify({ pr: 10, stage: 'write', cost: 1.25, inputTokens: 100, outputTokens: 50 }),
    JSON.stringify({ pr: 10, stage: 'write', cost: 0.75, inputTokens: 10, outputTokens: 5 }),
    JSON.stringify({ pr: 10, stage: 'review', cost: 0.5, inputTokens: 20, outputTokens: 10 }),
    JSON.stringify({ stage: 'orphan', cost: 9 }),
    '',
  ].join('\n'));
  const log = readRunLog(dir, 'runs.jsonl');
  assert.equal(log.skipped, 1);
  const r = await measure(dir, ['--run-log', 'runs.jsonl'], { git: makeGit(dir), gh: fakeGh(ghFixture(o)) });
  assert.deepEqual(pr(r, 10).cost.total, { cost: 2.5, inputTokens: 130, outputTokens: 65, steps: 3 });
  assert.equal(pr(r, 10).cost.byStage.write.cost, 2);
  assert.match(pr(r, 11).cost.na, /no record for this PR/);
  const missing = await measure(dir, ['--run-log', 'nope.jsonl'], { git: makeGit(dir), gh: fakeGh(ghFixture(o)) });
  assert.match(pr(missing, 10).cost.na, /file does not exist/);
  fs.writeFileSync(path.join(dir, 'bad.jsonl'), 'not json\n');
  assert.throws(() => readRunLog(dir, 'bad.jsonl'), /not JSON Lines: line 1/);
});

// ------------------------------------------------------------------ settings

test('settings: the block of CLAUDE.md through the shared reader, and flags that override it', async () => {
  const { dir } = shared();
  const base = { root: dir, from: '2026-09-20', to: '2026-11-03' };
  const s = await loadSettings(base);
  assert.equal(s.branchPatternSource, '-doc$');
  assert.equal(s.draftPatternSource, '^Draft:');
  assert.equal(s.reviewPolicy, 'sme');
  assert.equal(s.questionsHeading, 'Open questions');
  assert.equal(s.envFile, '.env');
  assert.equal(s.smeList, null);
  const over = await loadSettings({ ...base, 'branch-pattern': '^x-', review: 'places', 'sme-list': 'Review' });
  assert.equal(over.branchPatternSource, '^x-');
  assert.equal(over.reviewPolicy, 'places');
  assert.equal(over.smeList, 'Review');
});

test('settings: a missing pattern, a bad regex, a bad date and a bad policy stop the run (exit 2)', async () => {
  const { dir } = shared({ block: false });
  const base = { root: dir, from: '2026-09-20', to: '2026-11-03' };
  await assert.rejects(loadSettings(base), (e) => e.exitCode === 2 && /Pipeline branch pattern, Pipeline commit pattern/.test(e.message) && e.data.missing.length === 2);
  const ok = { ...base, 'branch-pattern': 'x', 'commit-pattern': 'y' };
  await assert.rejects(loadSettings({ ...ok, 'draft-pattern': '(' }), (e) => e.exitCode === 2 && /not a valid regular expression/.test(e.message));
  await assert.rejects(loadSettings({ ...ok, from: '2026-13-40' }), (e) => e.exitCode === 2 && /YYYY-MM-DD/.test(e.message));
  await assert.rejects(loadSettings({ ...ok, to: undefined }), (e) => e.exitCode === 2 && /--to/.test(e.message));
  await assert.rejects(loadSettings({ ...ok, from: '2026-11-04' }), (e) => e.exitCode === 2 && /after --to/.test(e.message));
  await assert.rejects(loadSettings({ ...ok, review: 'both' }), (e) => e.exitCode === 2 && /sme' or 'places/.test(e.message));
});

// ------------------------------------------------------------------ units

test('openQuestions: heading level, every list item with nested ones, the next heading ends the section', () => {
  assert.deepEqual(openQuestions('## Open questions and markers\n\n- a\n  - a1\n- b\n### Sub\n- c\n## Next\n- d', 'open questions'), { section: true, items: 4 });
  assert.deepEqual(openQuestions('# Description\ntext\n', 'Open questions'), { section: false, items: 0 });
  assert.deepEqual(openQuestions('## Open questions\r\n\r\n- a\r\n', 'Open questions'), { section: true, items: 1 });
  assert.deepEqual(openQuestions('## Open questions\n\nNone.\n', 'Open questions'), { section: true, items: 0 });
});

test('parseCommit: lines, marker lines, files, a merge and a binary file', () => {
  const diff = [
    `${'a'.repeat(40)} ${'b'.repeat(40)}`, '',
    'diff --git a/docs/x.md b/docs/x.md', 'index 1..2 100644', '--- a/docs/x.md', '+++ b/docs/x.md', '@@ -1,2 +1,3 @@',
    '-{/* ToDo: old */}', '+--- a divider that starts with dashes', '+{/* NEEDS CONFIRMATION: new */}', '+plain',
    'diff --git a/img.png b/img.png', 'index 3..4 100644', 'Binary files a/img.png and b/img.png differ', '',
  ].join('\n');
  const c = parseCommit(diff);
  assert.deepEqual({ added: c.added, removed: c.removed, markersAdded: c.markersAdded, markersRemoved: c.markersRemoved, files: c.files }, { added: 3, removed: 1, markersAdded: 1, markersRemoved: 1, files: ['docs/x.md', 'img.png'] });
  const merge = parseCommit(`${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}\n\ndiff --cc x\n@@@ -1 -1 +1 @@@\n+x\n`);
  assert.equal(merge.added, 0);
});

test('summarize: n/a when no PR could make a measure, a count of the ones that could otherwise', () => {
  const p = (extra) => ({ state: 'open', commits: { pipeline: 0, owner: 0, merge: 0 }, owner: { commits: 0, linesAdded: 0, linesRemoved: 0, lines: 0 }, openQuestions: { section: false, items: 0 }, draft: { na: 'a' }, smeReview: { na: 'b' }, finalEdit: { na: 'c' }, review: { na: 'd' }, places: { na: 'e' }, cost: { na: 'f' }, ...extra });
  assert.deepEqual(summarize([p(), p()]).draft, { na: 'a' });
  assert.deepEqual(summarize([]).draft, { na: 'no pull request in the window' });
  const s = summarize([p(), p({ draft: { commits: 1, markers: 2 } })]);
  assert.deepEqual(s.draft, { measured: 1, of: 2, draftsWithMarkers: 1, markers: 2, most: 2 });
});

test('trello helpers: the credentials file, links in a description', () => {
  assert.deepEqual(parseEnvFile('# c\nTRELLO_API_KEY=abc\nexport TRELLO_TOKEN="t k"\nOTHER=1 # note\n'), { TRELLO_API_KEY: 'abc', TRELLO_TOKEN: 't k', OTHER: '1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-measures-env-'));
  fs.writeFileSync(path.join(dir, '.env'), `TRELLO_API_KEY=${KEY}\nTRELLO_TOKEN=${TOKEN}\n`);
  assert.deepEqual(loadCredentials({ root: dir, envFile: '.env', env: {} }), { key: KEY, token: TOKEN });
  assert.equal(loadCredentials({ root: dir, envFile: '.env', env: { TRELLO_API_KEY: 'from-env' } }).key, 'from-env', 'the environment wins');
  assert.equal(loadCredentials({ root: dir, envFile: 'missing.env', env: {} }), null);
  assert.deepEqual(cardLinks('[a](https://trello.com/c/AbCd1234/1-x) [b](https://trello.com/c/AbCd1234) [c](https://trello.com/c/Zz9Zz9Zz/2-y) https://example.com/c/Qqqqqqqq'), ['AbCd1234', 'Zz9Zz9Zz']);
});

// ------------------------------------------------------------------ nothing is written

test('the Trello client sends GET with the credentials in a header, retries a 429, and never leaks a credential', async () => {
  const seen = [];
  let first = true;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url.startsWith('/1/cards/Fail')) {
      res.writeHead(500);
      res.end(`boom ${KEY} ${TOKEN}`);
    } else if (first) {
      first = false;
      res.writeHead(429);
      res.end('slow down');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[{"ok":1}]');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const sleeps = [];
    const client = createTrelloClient({ key: KEY, token: TOKEN, origin, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(await client.request('/1/cards/AbCd1234/actions', { filter: 'updateCard:idList' }), [{ ok: 1 }]);
    assert.deepEqual(sleeps, [2000]);
    assert.ok(seen.every((r) => r.method === 'GET'));
    assert.ok(seen.every((r) => !r.url.includes(KEY) && !r.url.includes(TOKEN)), 'no credential in a URL');
    assert.ok(seen.every((r) => r.auth.includes(KEY) && r.auth.includes(TOKEN)));
    await assert.rejects(client.request('/1/cards/Fail/actions'), (e) => /HTTP 500/.test(e.message) && !e.message.includes(KEY) && !e.message.includes(TOKEN));
    assert.equal(typeof client.request, 'function');
    assert.deepEqual(Object.keys(client), ['request'], 'the client has no method for anything but reading');
  } finally {
    server.close();
  }
  assert.throws(() => createTrelloClient({ key: KEY, token: TOKEN, origin: 'http://api.example.com' }), /must use https/);
});

test('the runners refuse anything that is not a read; no file in lib/ pushes or sends a write', async () => {
  for (const args of [['push'], ['commit', '-m', 'x'], ['checkout', 'main'], ['fetch', 'origin'], ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/heads/*'], ['config', 'x', 'y'], ['clean', '-fd']]) {
    assert.throws(() => assertGitRead(args), /only reads/, `git ${args.join(' ')}`);
  }
  assert.doesNotThrow(() => assertGitRead(['show', 'HEAD']));
  assert.doesNotThrow(() => assertGitRead(['cat-file', '--batch-check']));
  for (const args of [['pr', 'merge', '3'], ['pr', 'create'], ['pr', 'edit', '3'], ['pr', 'comment', '3'], ['api', '-X', 'POST', 'x'], ['issue', 'create'], ['label', 'create']]) {
    assert.throws(() => assertGhRead(args), /only reads/, `gh ${args.join(' ')}`);
  }
  assert.doesNotThrow(() => assertGhRead(['pr', 'list']));
  assert.doesNotThrow(() => assertGhRead(['pr', 'view', '3']));
  await assert.rejects(makeGit(os.tmpdir())(['push', 'origin', 'main']), /only reads/);

  for (const file of fs.readdirSync(LIB)) {
    const text = fs.readFileSync(path.join(LIB, file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/['"`]push['"`]/.test(text), `${file} names a push`);
    assert.ok(!/method:\s*['"`](?!GET)/.test(text), `${file} sends a method other than GET`);
    assert.ok(!/writeFile|appendFile|mkdir|unlink|rename|rmSync/.test(text), `${file} writes a file`);
  }
});

// ------------------------------------------------------------------ the CLI, end to end

// `gh` and `git` stand-ins on PATH log every call; gh answers from the fixture files, git is the real one.
function stubBin(fx) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-measures-bin-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'fixture.json'), JSON.stringify(fx));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(bin, 'fixture.json'))}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, 'gh ' + process.argv.slice(2).join(' ') + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') process.stdout.write(JSON.stringify(fx.list));
else if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(JSON.stringify({ commits: fx.commits[a[2]] || [] }));
else { console.error('unexpected gh call'); process.exit(1); }
`, { mode: 0o755 });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "git $*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  return { bin, log };
}

test('the CLI: JSON on stdout, the table on stderr, a local Trello, only reads, no credential printed, the clone untouched', async () => {
  const { dir, o } = shared();
  const fx = ghFixture(o);
  const { bin, log } = stubBin(fx);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-measures-out-'));
  fs.writeFileSync(path.join(outside, 'credentials'), `TRELLO_API_KEY=${KEY}\nTRELLO_API_TOKEN=${TOKEN}\n`);
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    const m = req.url.match(/^\/1\/cards\/(\w+)\/actions/);
    res.writeHead(m && TRELLO[m[1]] ? 200 : 404);
    res.end(JSON.stringify((m && TRELLO[m[1]]) ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stateBefore = sh(dir, 'status', '--porcelain') + '|' + sh(dir, 'rev-parse', 'HEAD') + '|' + sh(dir, 'for-each-ref');
  try {
    const out = path.join(outside, 'result.json');
    const args = [CLI, '--from', '2026-09-20', '--to', '2026-11-03', '--sme-list', 'In SME review', '--ready-pattern', '^Ready for merge', '--review', 'places', '--out', out, '--env', path.join(outside, 'credentials'), '--trello-origin', `http://127.0.0.1:${server.address().port}`];
    const r = await run('node', args, { cwd: dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRELLO_API_KEY: '', TRELLO_API_TOKEN: '' } });
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.prs.length, 2);
    assert.equal(json.prs[0].markersAtSmeReview, 3);
    assert.match(r.stderr, /Pipeline measures, 2026-09-20 to 2026-11-03: 2 PRs/);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), json);

    // --table prints the table alone on stdout (no SME list here, so the run needs no Trello).
    const only = await run('node', [CLI, '--from', '2026-09-20', '--to', '2026-11-03', '--table'], { cwd: dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.match(only.stdout, /^Pipeline measures, 2026-09-20 to 2026-11-03: 2 PRs/);
    assert.ok(!only.stdout.includes('"ok"'));

    for (const text of [r.stdout, r.stderr, fs.readFileSync(out, 'utf8')]) {
      assert.ok(!text.includes(KEY) && !text.includes(TOKEN), 'no credential in any output');
    }
    // Every call the script made was a read.
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.length > 3);
    for (const c of calls) assert.match(c, /^(gh pr (list|view) |git (show|cat-file) )/, c);
    assert.ok(calls.some((c) => c.startsWith('gh pr list')) && calls.some((c) => c.startsWith('git show')));
    assert.ok(seen.length > 0 && seen.every((s) => s.method === 'GET'), 'Trello got GET requests only');
  } finally {
    server.close();
  }
  assert.equal(sh(dir, 'status', '--porcelain') + '|' + sh(dir, 'rev-parse', 'HEAD') + '|' + sh(dir, 'for-each-ref'), stateBefore, 'the clone has the same files, HEAD and refs');
});

test('the CLI: a missing declaration is exit 2 with a JSON error, and --help prints the usage', async () => {
  const { dir } = shared({ block: false });
  const failed = await run('node', [CLI, '--from', '2026-09-20', '--to', '2026-11-03'], { cwd: dir }).catch((e) => e);
  assert.equal(failed.code, 2);
  assert.equal(JSON.parse(failed.stdout).ok, false);
  assert.match(failed.stderr, /Missing declaration\(s\): Pipeline branch pattern, Pipeline commit pattern/);
  const help = await run('node', [CLI, '--help']);
  assert.match(help.stdout, /^pipeline-measures --from/);
  const unknown = await run('node', [CLI, '--nope'], { cwd: dir }).catch((e) => e);
  assert.equal(unknown.code, 2);
});
