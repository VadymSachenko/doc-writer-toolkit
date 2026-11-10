import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LISTS, NOW, card, gitRepo, host, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { ensureWorktree } from '../lib/worktree.mjs';
import { DEFAULT_LABELS, renderPlaces } from '../lib/pr-description.mjs';
import { followRounds } from '../lib/pr-rounds.mjs';
import { loadSettings, validateSettings } from '../lib/settings.mjs';

// The questions-first gates (TASK-048, D-044, D-052; lib/gates.mjs), each on with the shared file's `checks`: no
// question without the sources it checked and its comment on the card (AC-1); no new marker in a PR's UA pages at the
// `pr` record (AC-2); every place with its source and why, listed in the description (AC-5).

const ALL = { checks: { questionSources: true, markers: true, places: true } };
const rec = (w, args) => runRecord({ settings: w.settings, clients: w.clients(), now: NOW, ...args });
const refused = async (w, args, name, re = /./) => {
  const before = snapshot(w.settings.state);
  await assert.rejects(rec(w, args), (e) => e.refused === name && e.exitCode === 1 && re.test(e.message));
  assert.deepEqual(snapshot(w.settings.state), before, 'nothing was written');
};

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

test('AC-1: with the check on, a question is recorded only with every source it checked and its comment on the card', async () => {
  const c = card({ number: 1601, status: 'blocked' });
  const asked = { id: 'cm-question', author: null, time: new Date(NOW).toISOString(), text: '⛔ Blocked: an answer is needed\n\n1. Which value goes in s=?\n   - Why a question: …', edited: null };
  const w = world({ cards: [c], comments: { [c.id]: [asked] }, extra: ALL });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  const q = (extra = {}) => ({ id: 'q1', kind: 'fact', text: 'Which value goes in s=?', sources: SOURCES, commentId: 'cm-question', ...extra });
  const args = (questions) => ({ key: '1601', stage: 'questions', status: 'done', result: { questions } });

  await refused(w, args([]), 'sources', /asks at least one/);
  await refused(w, args([q({ sources: undefined })]), 'sources', /question q1 names no source it checked/);
  await refused(w, args([q({ sources: [] })]), 'sources', /names no source/);
  await refused(w, args([q({ sources: [{ kind: 'code', ref: 'a.go:1' }] })]), 'sources', /question q1, source 1: no result/);
  await refused(w, args([q({ commentId: undefined })]), 'sources', /no "commentId"/);
  // An admin change the work needs (A9) gives its reason instead of sources.
  await refused(w, args([q(), { id: 'q2', kind: 'admin', text: 'Add the currency to the test partner?', commentId: 'cm-question' }]), 'sources', /question q2 asks for an admin change: give the "reason"/);
  // The comment the record names must be on the card; its words are the host's and are not compared.
  await refused(w, args([q({ commentId: 'cm-elsewhere' })]), 'comment', /the card has no comment cm-elsewhere/);

  await rec(w, args([q(), { id: 'q2', kind: 'admin', text: 'Add the currency to the test partner?', reason: 'the test request fails without it', commentId: 'cm-question' }]));
  const l = read(w, '1601');
  assert.deepEqual(l.questions.map((x) => [x.id, x.sources?.length ?? 0, x.commentId]), [['q1', 3, 'cm-question'], ['q2', 0, 'cm-question']]);
});

test('AC-1: with the check off (the default), a question records as before', async () => {
  const c = card({ number: 1602, status: 'blocked' });
  const w = world({ cards: [c] });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  await rec(w, { key: '1602', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', kind: 'fit', text: 'the block lists something else' }] } });
  assert.equal(read(w, '1602').questions.length, 1);
});

// ------------------------------------------------------------------ AC-2: markers

// A target clone at the fake world's `repos/api-docs` (target `api`, UA root `docs/`), with a bare origin: `main` with
// a page that already has a marker (the owner's, D-080), and the ticket branch.
function apiClone(w) {
  const bare = path.join(tmp('origin-'), 'api-docs.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'api-docs'));
  clone.commit({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n', 'docs/.sources/notes.md': 'notes\n' }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  clone.g('fetch', '-q', 'origin');
  clone.g('checkout', '-q', '-b', 'ticket-1');
  const push = (files, msg) => {
    const h = clone.commit(files, msg);
    clone.g('push', '-q', '-f', 'origin', 'ticket-1');
    return h;
  };
  return { clone, push };
}

function markersWorld() {
  const c = card({ number: 1610, status: 'inProgress' });
  const forgePr = pr({ repo: 'api-docs', number: 5, head: 'ticket-1' });
  const w = world({ cards: [c], prs: [forgePr], extra: { checks: { markers: true } } });
  const fx = apiClone(w);
  const entry = { repo: 'api-docs', branch: 'ticket-1', targets: ['api'], review: 'places', base: 'main' };
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [entry] });
  const at = (head) => {
    forgePr.headCommit = head;
    ensureWorktree(w.settings, entry);
  };
  const prRec = { key: '1610', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1', number: 5, expertReview: { recommended: false, why: 'all checked with test requests' } }] } };
  return { w, fx, at, prRec, forgePr };
}

test('AC-2: the pr record is refused while the PR\'s UA pages gained a marker, naming it; a marker the page already had, or one outside the UA pages, is no stop', async () => {
  const t = markersWorld();
  // The old marker moved down a line, and a new one came: only the new one is named.
  t.at(t.fx.push({
    'docs/a.md': '# Сторінка\n\nНовий рядок.\n\nАбзац. {/* ToDo: link to the settings page */}\n\nЛіміт: 100. {/* NEEDS CONFIRMATION: the daily limit */}\n',
    'docs/.sources/notes.md': 'notes {/* NEEDS CONFIRMATION: work file */}\n',
    'README.md': '{/* ToDo: outside the UA root */}\n',
  }, 'Draft'));
  await refused(t.w, t.prRec, 'markers', /api-docs#5 adds markers to its UA pages: docs\/a\.md:7 NEEDS CONFIRMATION: the daily limit\. Each is a question/);
  await assert.rejects(rec(t.w, t.prRec), (e) => e.data.markers.length === 1 && !/settings page|work file|outside/.test(e.message));
  // A marker in a code sample is not a marker.
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац. {/* ToDo: link to the settings page */}\n\n```mdx\n{/* NEEDS CONFIRMATION: an example */}\n```\n' }, 'Settled: the limit from the code'));
  await rec(t.w, t.prRec);
  assert.deepEqual(read(t.w, '1610').prs.map((p) => [p.number, p.stage]), [[5, 'finalReview']]);
});

test('AC-2: with no worktree of the PR on this machine, the marker check can\'t run and the record is refused, never passed', async () => {
  const t = markersWorld();
  t.forgePr.headCommit = t.fx.push({ 'docs/a.md': '# Сторінка\n\nНове.\n' }, 'Draft');
  await refused(t.w, t.prRec, 'markers', /the marker check can't run on api-docs#5: no worktree of api-docs ticket-1/);
});

test('AC-2: with the check off (the default), a PR with a new marker records as before', async () => {
  const t = markersWorld();
  t.w.settings.checks.markers = false;
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\n{/* NEEDS CONFIRMATION: x */}\n' }, 'Draft'));
  await rec(t.w, t.prRec);
  assert.equal(read(t.w, '1610').prs[0].stage, 'finalReview');
});

test('AC-2: a pr session whose gate found a marker ends by asking: its questions record is the result, not a failure, and the ticket waits for the answer', async () => {
  const t = markersWorld();
  t.at(t.fx.push({ 'docs/a.md': '# Сторінка\n\n{/* NEEDS CONFIRMATION: the daily limit */}\n' }, 'Draft'));
  const c = t.w.tracker.cards[0];
  const seen = [];
  const spawnClaude = async (cmd) => {
    const stage = /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];
    seen.push(stage);
    // The gate: the session finds the marker, opens no PR and asks on the card.
    c.placeId = LISTS.blocked.id;
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1610', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', kind: 'fact', text: 'What is the daily limit?', sources: SOURCES, commentId: 'cm-1' }] }, now: NOW });
    return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] }), stderr: '' };
  };
  const usage = () => parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1610'] } });
  assert.deepEqual(seen, ['pr']);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['pr', 'done']]);
  const l = read(t.w, '1610');
  assert.deepEqual([l.stage, l.stages.pr], ['questions', undefined]);
});

// ------------------------------------------------------------------ AC-5: places

function placesWorld(extra = {}) {
  const c = card({ number: 1620, status: 'inProgress' });
  const forgePr = pr({ repo: 'api-docs', number: 6, head: 'ticket-1620' });
  const w = world({ cards: [c], prs: [forgePr], extra: { checks: { places: true }, ...extra } });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done' }, prs: [{ repo: 'api-docs', branch: 'ticket-1620', targets: ['api'], review: 'places' }] });
  const place = (id, more = {}) => ({ id, repo: 'api-docs', pr: 6, page: 'docs/a.md', line: 4, claim: 'The error comes when the configuration check fails', why: 'inferred from the code, not seen on the test environment', source: 'code', commentId: id === 'p1' ? 901 : undefined, ...more });
  const args = (places) => ({ key: '1620', stage: 'pr', status: 'done', result: { prs: [{ branch: 'ticket-1620', number: 6, expertReview: { recommended: true, why: 'one place only the code shows' } }], places } });
  return { w, forgePr, place, args };
}

test('AC-5: each place needs its page, claim, source and why; without review rounds the description must list it', async () => {
  const t = placesWorld();
  await refused(t.w, t.args([t.place('p1', { why: '' })]), 'places', /place p1 has no why/);
  await refused(t.w, t.args([t.place('p1', { source: undefined, page: undefined })]), 'places', /place p1 has no page, source/);
  // The description the session wrote lists none of them.
  t.forgePr.body = '## Description\n\nA new error row.';
  await refused(t.w, t.args([t.place('p1'), t.place('p2', { line: 9 })]), 'places', /api-docs#6's description doesn't list places p1, p2/);
  // p1 by the link to its line comment, p2 (an unchanged line, no comment) by its page.
  t.forgePr.body = '## Що перевірити\n\n- `docs/a.md`: the error row — inferred from the code — [line](https://forge.example/acme/api-docs/pull/6#discussion_r901)';
  await rec(t.w, t.args([t.place('p1'), t.place('p2', { line: 9 })]));
  assert.deepEqual(read(t.w, '1620').places.map((p) => [p.id, p.source, p.why]), [['p1', 'code', 'inferred from the code, not seen on the test environment'], ['p2', 'code', 'inferred from the code, not seen on the test environment']]);
});

test('AC-5: with review rounds the runner writes the places from the record: the body is not read at the record, and each place shows its page, source and why', async () => {
  const t = placesWorld({ forge: { kind: 'github', owner: 'acme', self: 'owner-login', assignee: 'owner-login', checkLabel: 'Look at me', reviewRounds: true } });
  t.forgePr.body = ['questions', 'places', 'rounds'].map((n) => `<!-- ticket-flow:${n} -->\n<!-- /ticket-flow:${n} -->`).join('\n\n');
  const args = t.args([t.place('p1')]);
  args.result.prs[0].questions = [];
  await rec(t.w, args);
  const line = '- **p1** `docs/a.md`: The error comes when the configuration check fails (**not confirmed:** inferred from the code, not seen on the test environment; **source:** code) — [open thread ↗](https://forge.example/acme/api-docs/pull/6#discussion_r901)';
  assert.equal(renderPlaces(read(t.w, '1620').places, DEFAULT_LABELS, 'https://forge.example/acme/api-docs/pull/6', { facts: true }), line);
  // The runner's rewrite after the step puts that line in the description.
  assert.deepEqual(await followRounds({ settings: t.w.settings, clients: t.w.clients(), keys: ['1620'], before: new Map() }), []);
  assert.ok(t.forgePr.body.includes(line), t.forgePr.body);
});

test('AC-5: with the check off (the default), a place with no source or why records as before', async () => {
  const t = placesWorld();
  t.w.settings.checks.places = false;
  await rec(t.w, t.args([{ id: 'p1', repo: 'api-docs', pr: 6, page: 'docs/a.md', line: 4, claim: 'c' }]));
  assert.equal(read(t.w, '1620').places.length, 1);
  // And the description's places stay as before: the id, the claim, the state.
  assert.equal(renderPlaces(read(t.w, '1620').places, DEFAULT_LABELS, null), '- **p1** c — open thread');
});

test('the card is checked first: a questions record on a card not in Blocked is refused as before, whatever the sources', async () => {
  const c = card({ number: 1603, status: 'inProgress' });
  const w = world({ cards: [c], extra: ALL });
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  await refused(w, { key: '1603', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', text: 'x' }] } }, 'card');
  c.placeId = LISTS.blocked.id;
  await refused(w, { key: '1603', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', text: 'x' }] } }, 'sources');
});
