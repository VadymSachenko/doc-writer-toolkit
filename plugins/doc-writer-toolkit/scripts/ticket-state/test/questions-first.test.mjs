import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LISTS, NOW, ago, card, gitRepo, host, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { briefFor, gateLines, runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { ensureWorktree } from '../lib/worktree.mjs';
import { DEFAULT_LABELS, renderPlaces } from '../lib/pr-description.mjs';
import { followRounds } from '../lib/pr-rounds.mjs';
import { loadSettings, validateSettings } from '../lib/settings.mjs';
import { markersIn, placesNotListed } from '../lib/gates.mjs';

// The questions-first gates (TASK-048, D-044, D-052; lib/gates.mjs), each on with the shared file's `checks`: no
// question without the sources it checked and its comment on the card (AC-1); no new marker in a PR's UA pages at the
// `pr` record (AC-2); every place with its source and why, listed in the description (AC-5). Off, nothing changes: not
// the records, not the briefs, not how the runner counts a session.

const ALL = { checks: { questionSources: true, markers: true, places: true } };
const rec = (w, args) => runRecord({ settings: w.settings, clients: w.clients(), now: NOW, ...args });
const refused = async (w, args, name, re = /./) => {
  const before = snapshot(w.settings.state);
  await assert.rejects(rec(w, args), (e) => e.refused === name && e.exitCode === 1 && re.test(e.message));
  assert.deepEqual(snapshot(w.settings.state), before, 'nothing was written');
};
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
const usage = () => parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const stageOf = (cmd) => /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];

const SOURCES = [
  { kind: 'card', ref: 'https://tracker.example/c/abc', result: 'one example, no comments' },
  { kind: 'api', ref: 'api-check.md §1', result: 'the currency is not set up for the test partner' },
  { kind: 'code', ref: 'app-be@3f969ae:internal/link.go:40', result: 'the link is built with an empty value' },
];

test('settings: the checks are off unless the shared file switches them on; a local file never can', async () => {
  const s = validateSettings(rawSettings(), { root: tmp(), stateRootDefault: '.flow/' });
  assert.deepEqual(s.checks, { questionSources: false, markers: false, places: false });
  assert.deepEqual(validateSettings(rawSettings({ checks: { markers: true } }), { root: tmp(), stateRootDefault: '.flow/' }).checks, { questionSources: false, markers: true, places: false });
  assert.throws(() => validateSettings(rawSettings({ checks: { markers: 'yes' } }), { root: tmp(), stateRootDefault: '.flow/' }), /checks.markers must be true or false/);
  assert.throws(() => validateSettings(rawSettings({ checks: { everything: true } }), { root: tmp(), stateRootDefault: '.flow/' }), /checks.everything is not a check/);
  const local = await loadSettings({ root: host({ local: { checks: { markers: true } } }) });
  assert.equal(local.checks.markers, false);
  assert.ok(local.settingsNotes.some((n) => /sets checks: ignored/.test(n)), JSON.stringify(local.settingsNotes));
});

// ------------------------------------------------------------------ AC-1: questions

test('AC-1: with the check on, a question is recorded only with every source it checked, in a comment of this session that names it', async () => {
  const c = card({ number: 1601, status: 'blocked' });
  const comment = (id, text, time = new Date(NOW).toISOString()) => ({ id, author: null, time, text, edited: null });
  const comments = [
    comment('cm-question', '⛔ **Blocked:** an answer is needed\n\n1. Which value goes in `s=`?\n   - **Why a question:** …\n2. Add the currency to the test partner? The test request fails without it.'),
    comment('cm-refs', '1. The value in the link\n   - checked: https://tracker.example/c/abc, `api-check.md §1`, app-be@3f969ae:internal/link.go:40'),
    comment('cm-vague', '1. Something about the link\n   - checked the card and the code'),
    comment('cm-old', '1. Which value goes in s=?', ago(48)),
  ];
  const w = world({ cards: [c], comments: { [c.id]: comments }, extra: ALL });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  const q = (extra = {}) => ({ id: 'q1', kind: 'fact', text: 'Which value goes in s=?', sources: SOURCES, commentId: 'cm-question', ...extra });
  const admin = (extra = {}) => ({ id: 'q2', kind: 'admin', text: 'Add the currency to the test partner?', reason: 'the test request fails without it', commentId: 'cm-question', ...extra });
  const args = (questions) => ({ key: '1601', stage: 'questions', status: 'done', result: { questions } });

  await refused(w, args([]), 'sources', /asks at least one/);
  await refused(w, args([q({ sources: undefined })]), 'sources', /question q1 names no source it checked/);
  await refused(w, args([q({ sources: [] })]), 'sources', /names no source/);
  await refused(w, args([q({ sources: [{ kind: 'code', ref: 'a.go:1' }] })]), 'sources', /question q1, source 1: no result/);
  await refused(w, args([q({ commentId: undefined })]), 'sources', /no "commentId"/);
  // An admin change the work needs (A9) gives its reason instead of sources.
  await refused(w, args([q(), admin({ reason: undefined })]), 'sources', /question q2 asks for an admin change: give the "reason"/);
  // The comment must be on the card, posted after the ticket's last record, and name the question or its sources' refs.
  await refused(w, args([q({ commentId: 'cm-elsewhere' })]), 'comment', /the card has no comment cm-elsewhere/);
  await refused(w, args([q({ commentId: 'cm-old' })]), 'comment', /comment cm-old was posted at .* before the ticket's last record/);
  await refused(w, args([q({ commentId: 'cm-vague' })]), 'comment', /comment cm-vague names neither question q1 as recorded nor every one of its sources' refs/);

  // The question's own words (Markdown marks aside), or every source's ref.
  await rec(w, args([q(), admin(), q({ id: 'q3', text: 'What does the link carry?', commentId: 'cm-refs' })]));
  const l = read(w, '1601');
  assert.deepEqual(l.questions.map((x) => [x.id, x.sources?.length ?? 0, x.commentId]), [['q1', 3, 'cm-question'], ['q2', 0, 'cm-question'], ['q3', 3, 'cm-refs']]);
});

test('AC-1: with the check off (the default), a question records as before', async () => {
  const c = card({ number: 1602, status: 'blocked' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  await rec(w, { key: '1602', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', kind: 'fit', text: 'the block lists something else' }] } });
  assert.equal(read(w, '1602').questions.length, 1);
});

test('the card is checked first: a questions record on a card not in Blocked is refused as before, whatever the sources', async () => {
  const c = card({ number: 1603, status: 'inProgress' });
  const w = world({ cards: [c], extra: ALL });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  await refused(w, { key: '1603', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', text: 'x' }] } }, 'card');
  c.placeId = LISTS.blocked.id;
  await refused(w, { key: '1603', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', text: 'x' }] } }, 'sources');
});

// ------------------------------------------------------------------ a clone of the API docs

// A target clone at the fake world's `repos/api-docs` (target `api`, UA root `docs/`), with a bare origin: `main` with
// a page that already has a marker (the owner's, D-080). `branch(name)` starts a ticket branch from main; `push` commits
// on the branch checked out and pushes it; `onMain` moves the base on.
function apiClone(w) {
  const bare = path.join(tmp('origin-'), 'api-docs.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'api-docs'));
  clone.commit({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\nКінець.\n', 'docs/.sources/notes.md': 'notes\n' }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  clone.g('fetch', '-q', 'origin');
  const branch = (name) => {
    clone.g('checkout', '-q', 'main');
    clone.g('checkout', '-q', '-b', name);
  };
  const push = (files, msg) => {
    const h = clone.commit(files, msg);
    clone.g('push', '-q', '-f', 'origin', 'HEAD');
    return h;
  };
  const onMain = (files, msg) => {
    const was = clone.g('rev-parse', '--abbrev-ref', 'HEAD');
    clone.g('checkout', '-q', 'main');
    clone.commit(files, msg);
    clone.g('push', '-q', 'origin', 'main');
    clone.g('checkout', '-q', was);
  };
  branch('ticket-1');
  return { clone, push, branch, onMain };
}

// A ticket whose write and UA review are done, with PRs on api-docs (`ticket-1` as #5 by default).
function apiWorld({ key = '1610', checks = { markers: true }, branches = [['ticket-1', 5]], extra = {} } = {}) {
  const c = card({ number: Number(key), status: 'inProgress' });
  const forgePrs = branches.map(([b, n]) => pr({ repo: 'api-docs', number: n, head: b }));
  const w = world({ cards: [c], prs: forgePrs, extra: { checks, ...extra } });
  const fx = apiClone(w);
  const entries = branches.map(([b]) => ({ repo: 'api-docs', branch: b, targets: ['api'], review: 'places', base: 'main' }));
  ledger(w, c, { key, stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: entries });
  // The forge's head of a branch is what was just pushed, and the runner's worktree follows it.
  const at = (head, i = 0) => {
    forgePrs[i].headCommit = head;
    ensureWorktree(w.settings, entries[i]);
  };
  const prRec = (more = {}) => ({ key, stage: 'pr', status: 'done', result: { prs: branches.map(([b, n]) => ({ branch: b, number: n, expertReview: { recommended: false, why: 'all checked with test requests' } })), ...more } });
  return { w, c, fx, at, prRec, forgePrs };
}

// ------------------------------------------------------------------ AC-2: markers

test('AC-2: the pr record is refused while the PR\'s UA pages gained a marker, naming it; a marker the page already had, or one outside the UA pages, is no stop', async () => {
  const t = apiWorld();
  // The old marker moved down a line, and a new one came: only the new one is named.
  t.at(t.fx.push({
    'docs/a.md': '# Сторінка\n\nНовий рядок.\n\nАбзац. {/* ToDo: link to the settings page */}\n\nЛіміт: 100. {/* NEEDS CONFIRMATION: the daily limit */}\n',
    'docs/.sources/notes.md': 'notes {/* NEEDS CONFIRMATION: work file */}\n',
    'README.md': '{/* ToDo: outside the UA root */}\n',
  }, 'Draft'));
  await refused(t.w, t.prRec(), 'markers', /api-docs#5 adds markers to its UA pages: docs\/a\.md:7 NEEDS CONFIRMATION: the daily limit\. Each is a question/);
  await assert.rejects(rec(t.w, t.prRec()), (e) => e.data.markers.length === 1 && !/settings page|work file|outside/.test(e.message));
  // A marker in a code sample is not a marker.
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\n```mdx\n{/* NEEDS CONFIRMATION: an example */}\n```\n' }, 'Settled: the limit from the code'));
  await rec(t.w, t.prRec());
  assert.deepEqual(read(t.w, '1610').prs.map((p) => [p.number, p.stage]), [[5, 'finalReview']]);
});

test('AC-2: every spelling of a marker counts: ToDo with no text, TODO with a dash; a UA root of ./ is the whole repo', async () => {
  assert.deepEqual(markersIn('a {/* ToDo */}\nb {/* TODO - the fee */}\nc {/* NEEDS CONFIRMATION: x */}\n`{/* ToDo: in code */}`\n').map((m) => [m.line, m.kind, m.text]), [[1, 'ToDo', ''], [2, 'ToDo', 'the fee'], [3, 'NEEDS CONFIRMATION', 'x']]);
  const t = apiWorld();
  t.w.settings.targets.find((x) => x.id === 'api').uaRoot = './';
  t.at(t.fx.push({ 'guide.md': '# Guide\n\n{/* ToDo */}\n' }, 'Draft'));
  await refused(t.w, t.prRec(), 'markers', /guide\.md:3 ToDo\. Each is a question/);
});

test('AC-2: a page the branch moved keeps its markers: they are read at the path it came from', async () => {
  const t = apiWorld();
  fs.mkdirSync(path.join(t.fx.clone.dir, 'docs', 'b'));
  t.fx.clone.g('mv', 'docs/a.md', 'docs/b/a.md');
  t.at(t.fx.push({ 'docs/b/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\nКінець, переписаний.\n' }, 'Move the page'));
  await rec(t.w, t.prRec());
  assert.equal(read(t.w, '1610').prs[0].stage, 'finalReview');
});

test('AC-2: the markers are compared with the merge base, not the base tip: a base that moved on brings no marker of the branch\'s', async () => {
  const t = apiWorld();
  const h = t.fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\nКінець і ще речення.\n' }, 'Draft');
  // Someone settles the old marker on main after the branch began.
  t.fx.onMain({ 'docs/a.md': '# Сторінка\n\nАбзац із посиланням.\n\nКінець.\n' }, 'Settle the old marker');
  t.at(h);
  await rec(t.w, t.prRec());
  assert.equal(read(t.w, '1610').prs[0].stage, 'finalReview');
});

test('AC-2: a pr record with two PRs names only the one that gained a marker', async () => {
  const t = apiWorld({ branches: [['ticket-1', 5], ['ticket-2', 7]] });
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\nЧисто.\n' }, 'Draft: clean'), 0);
  t.fx.branch('ticket-2');
  t.at(t.fx.push({ 'docs/c.md': '# Нова\n\n{/* NEEDS CONFIRMATION: the fee */}\n' }, 'Draft: with a marker'), 1);
  await assert.rejects(rec(t.w, t.prRec()), (e) => e.refused === 'markers' && /^nothing recorded: api-docs#7 adds markers/.test(e.message) && !/#5/.test(e.message));
  assert.equal(read(t.w, '1610').prs.some((p) => p.number), false, 'nothing recorded for the clean one either');
});

test('AC-2: with no worktree of the PR on this machine, the marker check can\'t run and the record is refused, never passed', async () => {
  const t = apiWorld();
  t.forgePrs[0].headCommit = t.fx.push({ 'docs/a.md': '# Сторінка\n\nНове.\n' }, 'Draft');
  await refused(t.w, t.prRec(), 'markers', /the marker check can't run on api-docs#5: no worktree of api-docs ticket-1/);
});

test('AC-2: with the check off (the default), a PR with a new marker records as before', async () => {
  const t = apiWorld({ checks: {} });
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\n{/* NEEDS CONFIRMATION: x */}\n' }, 'Draft'));
  await rec(t.w, t.prRec());
  assert.equal(read(t.w, '1610').prs[0].stage, 'finalReview');
});

// A pr session that, like the gate says, opens no PR and asks on the card.
async function askingPrSession(checks) {
  const t = apiWorld({ checks });
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\n{/* NEEDS CONFIRMATION: the daily limit */}\n' }, 'Draft'));
  const seen = [];
  const spawnClaude = async (cmd) => {
    seen.push(stageOf(cmd));
    t.c.placeId = LISTS.blocked.id;
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1610', stage: 'questions', status: 'done', result: { questions: [{ id: `q${seen.length}`, kind: 'fact', text: 'What is the daily limit?', sources: SOURCES, commentId: 'cm-1' }] }, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1610'] } });
  return { out, seen, l: read(t.w, '1610') };
}

test('AC-2: with the marker gate on, a pr session that ends by asking is done: its questions record is the result, and the ticket waits for the answer', async () => {
  const { out, seen, l } = await askingPrSession({ markers: true });
  assert.deepEqual(seen, ['pr']);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['pr', 'done']]);
  assert.deepEqual([l.stage, l.stages.pr], ['questions', undefined]);
});

test('with the marker gate off, a pr session that records only questions is a failure, as before', async () => {
  const { out, seen } = await askingPrSession({});
  assert.equal(seen[0], 'pr');
  assert.ok(out.ran.length && out.ran.every((r) => r.stage === 'pr' && r.outcome === 'failed'), JSON.stringify(out.ran));
});

test('the briefs: with the checks off they carry no gate line; each check on adds only its own lines, and nothing else changes', () => {
  const off = world().settings;
  const on = { ...off, checks: { ...ALL.checks } };
  const step = (stage, role = 'writer') => ({ stage, role, keys: ['1610'] });
  for (const stage of ['plan', 'write', 'pr', 'videoGate', 'answerComments']) {
    const s = { ...step(stage), ...(stage === 'answerComments' ? { pr: 'api-docs#5' } : {}) };
    assert.deepEqual(gateLines(s, off), [], stage);
    const lines = gateLines(s, on);
    assert.ok(lines.length, stage);
    const brief = briefFor(s, on);
    assert.equal(brief.split('\n').filter((x) => !lines.includes(x)).join('\n'), briefFor(s, off), `${stage}: the gate lines are the only difference`);
  }
  assert.doesNotMatch(briefFor(step('pr'), off), /gate before the PR|not a marker|commentId/);
  assert.match(gateLines(step('write'), on).join('\n'), /is a question, not a marker/);
  assert.match(gateLines(step('pr'), on).join('\n'), /The gate before the PR/);
  assert.match(gateLines(step('plan'), on).join('\n'), /A fit-check stop is such a record too, with `sources` and `commentId`/);
  assert.match(gateLines(step('videoGate'), on).join('\n'), /"kind": "video"/);
  assert.deepEqual(gateLines(step('uaReview', 'reviewer'), on), []);
});

// ------------------------------------------------------------------ AC-5: places

const WHY = 'inferred from the code, not seen on the test environment';
const place = (id, more = {}) => ({ id, repo: 'api-docs', pr: 6, page: 'docs/a.md', line: 1, claim: 'The error comes when the configuration check fails', why: WHY, source: 'code', ...more });

function placesWorld(extra = {}) {
  const t = apiWorld({ key: '1620', checks: { places: true }, branches: [['ticket-1', 6]], extra });
  // Line 5 is the branch's; line 1 stays as the base has it.
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\nПомилка, коли перевірка налаштувань не пройдена.\n' }, 'Draft'));
  const args = (places) => t.prRec({ places });
  return { ...t, args };
}

test('AC-5: each place names its PR, page, claim, a source of the known kinds and why; a place on a changed line has its line comment', async () => {
  const t = placesWorld();
  await refused(t.w, t.args([place('p1', { why: '' })]), 'places', /place p1 has no why/);
  await refused(t.w, t.args([place('p1', { source: undefined, page: undefined, repo: undefined })]), 'places', /place p1 has no repo, page, source/);
  await refused(t.w, t.args([place('p1', { source: 'code; ticket #916 for the order' })]), 'places', /place p1's source 'code; ticket #916 for the order' is not one of app, apiCall, person, code, transcript, explanation, card/);
  await refused(t.w, t.args([place('p1', { pr: 99 })]), 'places', /place p1 is on api-docs#99, not one of this record's PRs/);
  await refused(t.w, t.args([place('p1', { line: 5 })]), 'places', /place p1 is on a line api-docs#6 changed \(docs\/a\.md:5\): give the "commentId"/);
});

test('AC-5: without review rounds the description lists each place: by the link to its line comment, a longer id being another, or, on an unchanged line, by its why', async () => {
  const t = placesWorld();
  const both = [place('p1', { line: 5, commentId: 901 }), place('p2', { line: 1, why: 'the case can\'t be triggered on the test environment' })];
  t.forgePrs[0].body = '## Що перевірити\n\n- the error row — [line](https://forge.example/acme/api-docs/pull/6#discussion_r9012)';
  await refused(t.w, t.args(both), 'places', /api-docs#6's description doesn't list places p1, p2/);
  // The page path alone names no place.
  t.forgePrs[0].body = '## Що перевірити\n\n- `docs/a.md`: [line](https://forge.example/acme/api-docs/pull/6#discussion_r901)';
  await refused(t.w, t.args(both), 'places', /doesn't list place p2 /);
  t.forgePrs[0].body += '\n- `docs/a.md`, line 1: the case **can\'t be triggered** on the test environment';
  await rec(t.w, t.args(both));
  assert.deepEqual(read(t.w, '1620').places.map((p) => [p.id, p.source]), [['p1', 'code'], ['p2', 'code']]);
  assert.deepEqual(placesNotListed([{ commentId: 90 }], 'x#discussion_r901').length, 1);
});

test('AC-5: with review rounds the runner writes the places from the record: the body is not read at the record, and each place shows its page, source and why', async () => {
  const t = placesWorld({ forge: { kind: 'github', owner: 'acme', self: 'owner-login', assignee: 'owner-login', checkLabel: 'Look at me', reviewRounds: true } });
  t.forgePrs[0].body = ['questions', 'places', 'rounds'].map((n) => `<!-- ticket-flow:${n} -->\n<!-- /ticket-flow:${n} -->`).join('\n\n');
  const args = t.args([place('p1', { line: 5, commentId: 901 })]);
  args.result.prs[0].questions = [];
  await rec(t.w, args);
  const line = `- **p1** \`docs/a.md\`: The error comes when the configuration check fails (**not confirmed:** ${WHY}; **source:** code) — [open thread ↗](https://forge.example/acme/api-docs/pull/6#discussion_r901)`;
  assert.equal(renderPlaces(read(t.w, '1620').places, DEFAULT_LABELS, 'https://forge.example/acme/api-docs/pull/6', { facts: true }), line);
  // The runner's rewrite after the step puts that line in the description.
  assert.deepEqual(await followRounds({ settings: t.w.settings, clients: t.w.clients(), keys: ['1620'], before: new Map() }), []);
  assert.ok(t.forgePrs[0].body.includes(line), t.forgePrs[0].body);
});

test('AC-5: with the check off (the default), a place with no source or why records as before', async () => {
  const t = placesWorld();
  t.w.settings.checks.places = false;
  await rec(t.w, t.args([{ id: 'p1', repo: 'api-docs', pr: 6, page: 'docs/a.md', line: 4, claim: 'c' }]));
  assert.equal(read(t.w, '1620').places.length, 1);
  // And the description's places stay as before: the id, the claim, the state.
  assert.equal(renderPlaces(read(t.w, '1620').places, DEFAULT_LABELS, null), '- **p1** c — open thread');
});
