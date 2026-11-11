import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, ago, card, gitRepo, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { briefFor, codeReposFor, commandFor, runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { validateSettings } from '../lib/settings.mjs';
import { ensureWorktree, codeClonePath } from '../lib/worktree.mjs';
import { passRepos, resolveCompanyRepos, validateCompanyRepos } from '../lib/company-repos.mjs';
import { passInput, prLinesAfterPass, roundInput } from '../lib/answer-pass.mjs';
import { DEFAULT_LABELS, renderSections } from '../lib/pr-description.mjs';
import { labelChanges, labelSnapshot } from '../lib/pr-labels.mjs';
import { answerMeasures, missesPath, readMisses, renderAnswers, weekOf, weeklyAnswers } from '../lib/misses.mjs';
import { renderReport } from '../lib/report.mjs';

// The answer pass (TASK-105): a stage between the UA review and the PR whose only job is to answer what the write and
// the review left open, with every company repo, the docs, the earlier tickets and the test environment; the same on a
// PR after a review round asks new questions; and the misses log with its week. The host, its repos and its data are
// invented: a lending product's docs (`guide-docs`, `api-docs`), a backend (`ledger-api`), a cabinet frontend
// (`cabinet-web`), a widget (`pay-widget`).

const usage = () => parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const stageOf = (cmd) => /Stage `(\w+)`/.exec(briefOf(cmd))[1];
const COMPANY = [
  { repo: 'ledger-api', url: 'https://code.example/acme/ledger-api', base: 'main', path: '../ledger-api' },
  { repo: 'cabinet-web', url: 'https://code.example/acme/cabinet-web', base: 'develop', path: '../cabinet-web' },
  { repo: 'pay-widget', url: 'https://code.example/acme/pay-widget' },
];
const rec = (w, args) => runRecord({ settings: w.settings, clients: w.clients(), now: NOW, ...args });

// A code repo the runner has cloned (`<state>/code/<repo>.git`, bare), with the files given at one commit.
function codeClone(settings, repo, files) {
  const dir = path.join(tmp('src-'), repo);
  const commit = gitRepo(dir).commit(files, 'feat: the change');
  execFileSync('git', ['clone', '-q', '--bare', dir, codeClonePath(settings, { repo })], { stdio: 'ignore' });
  return commit;
}

// A docs clone at `repos/api-docs` (target `api`, UA root `docs/`) with a bare origin and a ticket branch, so the
// runner's worktree and the marker check run on real git.
function apiClone(w, page = '# Сторінка\n\nАбзац про ліміти.\n') {
  const bare = path.join(tmp('origin-'), 'api-docs.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'api-docs'));
  clone.commit({ 'docs/a.md': page }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  clone.g('checkout', '-q', '-b', 'ticket-1');
  const push = (files, msg) => {
    const h = clone.commit(files, msg);
    clone.g('push', '-q', '-f', 'origin', 'HEAD');
    return h;
  };
  return { clone, push };
}

// A ticket whose write and UA review are done on api-docs `ticket-1`, its PR not opened yet. `open`: the write's.
function passWorld({ key = '2101', company = COMPANY, open, uaOpen = [], fixed = [], extra = {}, questions = [] } = {}) {
  const c = card({ number: Number(key), status: 'inProgress' });
  const forgePr = pr({ repo: 'api-docs', number: 7, head: 'ticket-1' });
  const w = world({ cards: [c], prs: [forgePr], extra: { ...(company ? { companyRepos: company } : {}), appRepos: [{ repo: 'ledger-api', url: 'https://code.example/acme/ledger-api', base: 'main' }], workFolder: 'work/tickets/<key>', ...extra } });
  const entry = { repo: 'api-docs', branch: 'ticket-1', targets: ['api'], review: 'places', base: 'main' };
  const l = ledger(w, c, { key, stages: { start: 'done', plan: 'done', write: { status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: ['3f1a2b0'] }], ...(open ? { open } : {}) } }, uaReview: { status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: ['8c4d9e1'] }], fixed, open: uaOpen } } }, prs: [entry], questions });
  return { w, c, l, key, entry, forgePr };
}

// The runner's frozen input, made as `freezePass` makes it (the markers given).
async function freeze(t, { markers = new Map(), pr: onPr } = {}) {
  const l = read(t.w, t.key);
  const input = onPr ? roundInput(l.prs[0]) : passInput(l, { markers });
  await rec(t.w, { key: t.key, stage: 'answerPass', status: 'running', ...(onPr ? { pr: onPr } : {}), result: { input } });
  return input;
}
const passDone = (t, result, more = {}) => rec(t.w, { key: t.key, stage: 'answerPass', status: 'done', result, ...more });
const refusedAs = async (t, p, re) => {
  const before = snapshot(t.w.settings.state);
  await assert.rejects(p, (e) => e.refused === 'answers' && re.test(e.message));
  assert.deepEqual(snapshot(t.w.settings.state), before, 'nothing written');
};

// ------------------------------------------------------------------ settings: companyRepos

test('companyRepos: a list in the shape of appRepos, or an org with exclude and a path template; anything else stops; unset is null', () => {
  assert.equal(validateCompanyRepos(undefined), null);
  assert.equal(validateCompanyRepos([]), null);
  assert.deepEqual(validateCompanyRepos(COMPANY).list.map((r) => [r.repo, r.base, r.path]), [['ledger-api', 'main', '../ledger-api'], ['cabinet-web', 'develop', '../cabinet-web'], ['pay-widget', 'main', null]]);
  assert.deepEqual(validateCompanyRepos({ org: 'acme', exclude: ['old-forms', 'old-forms'], path: '../<repo>' }), { org: 'acme', exclude: ['old-forms'], path: '../<repo>' });
  for (const [bad, re] of [
    [[{ repo: 'a' }], /companyRepos\[0\]\.url is required/],
    [[{ repo: 'a/b', url: 'https://x' }], /plain name/],
    [[{ repo: 'a', url: 'https://x' }, { repo: 'a', url: 'https://y' }], /names 'a' twice/],
    [[{ repo: 'a', url: 'https://x', branch: 'main' }], /companyRepos\[0\]\.branch is not a setting/],
    [{ org: 'acme', exclude: 'old' }, /exclude must be a list/],
    [{ org: 'acme', path: '../clones' }, /with <repo> in it/],
    [{ org: 'acme', repos: [] }, /companyRepos\.repos is not a setting/],
    ['acme', /must be a list/],
  ]) assert.throws(() => validateCompanyRepos(bad), (e) => e.exitCode === 2 && re.test(e.message), JSON.stringify(bad));
  // Through the settings, a name in appRepos too is no error: the pass shares the runner's clone of it.
  const s = validateSettings(rawSettings({ appRepos: [{ repo: 'ledger-api', url: 'https://code.example/acme/ledger-api' }], companyRepos: COMPANY }), { root: tmp(), stateRootDefault: '.flow/' });
  assert.equal(s.companyRepos.list.length, 3);
  assert.equal(validateSettings(rawSettings(), { root: tmp(), stateRootDefault: '.flow/' }).companyRepos, null);
});

// A fake `gh` that prints a repo list, or fails.
function fakeGh(body, { fail = false } = {}) {
  const dir = tmp('gh-');
  const bin = path.join(dir, 'gh');
  const args = path.join(dir, 'args.txt');
  fs.writeFileSync(bin, fail ? `#!/bin/sh\necho "$@" > '${args}'\necho 'HTTP 401: Bad credentials' >&2\nexit 1\n` : `#!/bin/sh\necho "$@" > '${args}'\ncat <<'JSON'\n${JSON.stringify(body)}\nJSON\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, args: () => fs.readFileSync(args, 'utf8').trim() };
}

test('the org form: `gh repo list` at each run, archived and excluded repos left out, the default branch and the owner\'s clone path from the template; a failing gh is a note', () => {
  const gh = fakeGh([
    { name: 'pay-widget', url: 'https://code.example/acme/pay-widget', isArchived: false, defaultBranchRef: { name: 'master' } },
    { name: 'cabinet-web', url: 'https://code.example/acme/cabinet-web', isArchived: false, defaultBranchRef: { name: 'develop' } },
    { name: 'old-forms', url: 'https://code.example/acme/old-forms', isArchived: false, defaultBranchRef: { name: 'main' } },
    { name: 'retired-app', url: 'https://code.example/acme/retired-app', isArchived: true, defaultBranchRef: { name: 'main' } },
  ]);
  const settings = { companyRepos: validateCompanyRepos({ org: 'acme', exclude: ['old-forms'], path: '../<repo>' }) };
  const r = resolveCompanyRepos(settings, { gh: gh.bin });
  assert.equal(gh.args(), 'repo list acme --limit 1000 --json name,url,isArchived,defaultBranchRef');
  assert.deepEqual(r.repos, [{ repo: 'cabinet-web', url: 'https://code.example/acme/cabinet-web', base: 'develop', path: '../cabinet-web' }, { repo: 'pay-widget', url: 'https://code.example/acme/pay-widget', base: 'master', path: '../pay-widget' }]);
  assert.deepEqual(r.excluded, ['old-forms']);
  assert.match(r.notes[0], /archived, not read: retired-app/);
  const bad = resolveCompanyRepos(settings, { gh: fakeGh(null, { fail: true }).bin });
  assert.deepEqual(bad.repos, []);
  assert.match(bad.notes[0], /the repos of acme were not listed \(`gh repo list`: HTTP 401: Bad credentials\)/);
  // The list form calls no gh at all.
  assert.deepEqual(resolveCompanyRepos({ companyRepos: validateCompanyRepos(COMPANY) }, { ghRepoList: () => assert.fail('gh called') }).repos.map((x) => x.repo), ['ledger-api', 'cabinet-web', 'pay-widget']);
});

// ------------------------------------------------------------------ the stage's place in the flow

test('the flow: with companyRepos the answer pass runs after the UA review and before the PR, the PR after it; unset, the PR follows the UA review with a note (AC-3)', async () => {
  const on = passWorld();
  assert.equal((await on.w.one('2101')).next.stage, 'answerPass');
  assert.equal((await on.w.one('2101')).next.role, 'writer');
  const l = read(on.w, '2101');
  l.stages.answerPass = { status: 'done', seq: l.seq + 1, at: ago(0.5), result: { items: [], input: { items: [] } } };
  l.seq += 1;
  fs.writeFileSync(path.join(on.w.settings.state, 'tickets', '2101.json'), JSON.stringify(l));
  assert.equal((await on.w.one('2101')).next.stage, 'pr');
  // Unset: as today, and the status says why.
  const off = passWorld({ company: null });
  const t = await off.w.one('2101');
  assert.equal(t.next.stage, 'pr');
  assert.ok(t.notes.some((n) => /no answer pass: the host sets no companyRepos/.test(n)), t.notes.join('; '));
  // A UA review again after the pass: the pass runs again before the PR.
  const again = read(on.w, '2101');
  again.stages.uaReview = { ...again.stages.uaReview, seq: again.seq + 1 };
  again.seq += 1;
  fs.writeFileSync(path.join(on.w.settings.state, 'tickets', '2101.json'), JSON.stringify(again));
  assert.equal((await on.w.one('2101')).next.stage, 'answerPass');
});

test('the company repos are checked out on the answer pass only: every other stage reads the code repos as before; the hub and the step\'s own repos are skipped', () => {
  const t = passWorld({ extra: { relatedRepos: [{ repo: 'pay-widget', url: 'https://code.example/acme/pay-widget' }] } });
  const repos = (stage, opts) => codeReposFor({ role: 'writer', stage, keys: ['2101'] }, t.w.settings, opts).map((a) => a.repo);
  assert.deepEqual(repos('answerPass'), ['ledger-api', 'pay-widget', 'cabinet-web']);
  assert.deepEqual(repos('answerPass', { skip: ['cabinet-web'] }), ['ledger-api', 'pay-widget']);
  for (const stage of ['plan', 'write', 'answerComments']) assert.deepEqual(repos(stage), ['ledger-api', 'pay-widget'], stage);
  for (const stage of ['pr', 'styleCheck']) assert.deepEqual(repos(stage), ['ledger-api'], stage);
  assert.deepEqual(codeReposFor({ role: 'reviewer', stage: 'uaReview' }, t.w.settings).map((a) => a.repo), ['ledger-api']);
  // A company repo of its own is cloned partial, like a related repo; the code repos' entry keeps its full clone.
  const all = passRepos(t.w.settings, t.w.settings.companyRepos.list);
  assert.deepEqual(all.map((a) => [a.repo, Boolean(a.related), Boolean(a.company)]), [['ledger-api', false, false], ['pay-widget', true, false], ['cabinet-web', true, true]]);
  // The owner's clones of the company repos are denied to the session.
  const cmd = commandFor({ stage: 'answerPass', role: 'writer', keys: ['2101'], codeTrees: [] }, t.w.settings, { model: 'm', agentsPath: '/a.json', roots: [] });
  const denied = cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1);
  assert.ok(denied.includes(`Read(//${path.resolve(t.w.root, '../cabinet-web').replace(/^\/+/, '')}/**)`));
});

test('the runner: the pass resolves and checks out every company repo, freezes its input in a running record before the session, and the brief frames the task; a plan step checks out none of them', async () => {
  const t = passWorld({ open: { questions: [{ text: 'Which amount does the archive column show?', reader: 'developer', why: 'the backend returns both', sources: [{ kind: 'code', ref: 'ledger-api handlers.go', result: 'both amounts' }] }] }, uaOpen: ['The term «утримання» is not in the glossary'] });
  apiClone(t.w).push({ 'docs/a.md': '# Сторінка\n\nАбзац про ліміти. {/* NEEDS CONFIRMATION: which amount the archive shows */}\n' }, 'draft');
  const asked = [];
  const ensureCodeTree = (s, app) => {
    asked.push(app.repo);
    return { repo: app.repo, path: path.join(s.state, 'code', app.repo, 'c0ffee1c0ffe'), commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff', url: app.url, notes: [], removed: [], kept: [] };
  };
  const briefs = [];
  let frozenFirst = null;
  const spawnClaude = async (cmd) => {
    briefs.push(briefOf(cmd));
    const l = read(t.w, '2101');
    frozenFirst = { running: l.stages.answerPass?.status, items: l.answerInput?.items.map((x) => x.id) };
    return { code: 1, stdout: '', stderr: 'stop' };
  };
  await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude, ensureCodeTree, ticketCommits: (dir, key) => ({ key, more: false, commits: [] }) }, options: { named: ['2101'] } });
  assert.ok(briefs.length, 'a session ran');
  assert.deepEqual([...new Set(asked)], ['ledger-api', 'cabinet-web', 'pay-widget']);
  assert.deepEqual(frozenFirst, { running: 'running', items: ['q1', 'm1', 'f1'] });
  const b = briefs[0];
  assert.match(b, /Stage `answerPass`/);
  assert.match(b, /Each item below has an answer in the company's systems\. Find it\. An item you can't answer stays, with every source you tried\./);
  assert.match(b, /\*\*q1\*\* \(a question the write left, for developer\): Which amount does the archive column show\?/);
  assert.match(b, /\*\*m1\*\* \(a marker the branch added, api-docs docs\/a\.md:3\): NEEDS CONFIRMATION: which amount the archive shows/);
  assert.match(b, /\*\*f1\*\* \(a finding the UA review left open\)/);
  assert.match(b, /- cabinet-web: .*code\/cabinet-web\/c0ffee1c0ffe/);
  assert.match(b, /Never change a setting several accounts share unless the host's rules allow it by name/);
  // A retry keeps the input it was given: the frozen list stands while no pass is done.
  const l = read(t.w, '2101');
  assert.equal(l.answerInput.after, l.stages.uaReview.seq);

  // The plan, on the same host: no company repo is cloned or named.
  const c = card({ number: 2102, status: 'inProgress', labels: ['Api'] });
  const w2 = world({ cards: [c], extra: { companyRepos: COMPANY, appRepos: [{ repo: 'ledger-api', url: 'https://code.example/acme/ledger-api' }] } });
  ledger(w2, c, { key: '2102', stages: { triage: 'done', start: 'done' }, startedBy: 'schedule', triage: { verdict: 'docs-required', targets: ['api'], size: 'edit' } });
  asked.length = 0;
  briefs.length = 0;
  await runDaily({ settings: w2.settings, clients: w2.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: async (cmd) => (briefs.push(briefOf(cmd)), { code: 1, stdout: '', stderr: 'stop' }), ensureCodeTree, ticketCommits: (dir, key) => ({ key, more: false, commits: [] }) }, options: { named: ['2102'] } });
  assert.match(briefs[0], /Stage `plan`/);
  assert.deepEqual([...new Set(asked)], ['ledger-api']);
  assert.ok(!briefs[0].includes('cabinet-web'));
});

test('the runner: the checkout budget says what it didn\'t reach, and an org that gh can\'t list is a note in the brief, never a failed step', async () => {
  const t = passWorld({ company: { org: 'acme' } });
  apiClone(t.w).push({ 'docs/a.md': '# Сторінка\n\nАбзац.\n' }, 'draft');
  let clock = NOW;
  const ensureCodeTree = (s, app) => {
    clock += 40 * 60 * 1000;
    return { repo: app.repo, path: path.join(s.state, 'code', app.repo, 'c0ffee1c0ffe'), commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff', url: app.url, notes: [], removed: [], kept: [] };
  };
  const briefs = [];
  const ghRepoList = () => [{ name: 'cabinet-web', url: 'https://code.example/acme/cabinet-web', isArchived: false, defaultBranchRef: { name: 'main' } }, { name: 'pay-widget', url: 'https://code.example/acme/pay-widget', isArchived: false, defaultBranchRef: { name: 'main' } }];
  await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => clock, spawnClaude: async (cmd) => (briefs.push(briefOf(cmd)), { code: 1, stdout: '', stderr: 'stop' }), ensureCodeTree, ghRepoList, ticketCommits: (dir, key) => ({ key, more: false, commits: [] }) }, options: { named: ['2101'] } });
  assert.match(briefs[0], /- cabinet-web: not available \(not checked out: the answer pass's checkout time ran out/);
  const failing = passWorld({ key: '2103', company: { org: 'acme' } });
  apiClone(failing.w).push({ 'docs/a.md': '# Сторінка\n\nАбзац.\n' }, 'draft');
  briefs.length = 0;
  await runDaily({ settings: failing.w.settings, clients: failing.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: async (cmd) => (briefs.push(briefOf(cmd)), { code: 1, stdout: '', stderr: 'stop' }), ensureCodeTree: (s, app) => ({ repo: app.repo, path: '/x', commit: 'c'.repeat(40), url: app.url, notes: [] }), ghRepoList: () => { throw new Error('gh: not logged in'); }, ticketCommits: (dir, key) => ({ key, more: false, commits: [] }) }, options: { named: ['2103'] } });
  assert.match(briefs[0], /Note: the repos of acme were not listed \(`gh repo list`: gh: not logged in\)/);
});

// ------------------------------------------------------------------ the record and its gate

test('the gate: an answered item needs evidence that holds, a kept one its sources and why, a place kept its live check; every item once, and no other', async () => {
  const t = passWorld({ open: { questions: [{ text: 'Which amount does the archive show?', reader: 'developer' }], places: [{ repo: 'api-docs', page: 'docs/a.md', line: 3, claim: 'Ліміт діє добу', why: 'з коду', source: 'code' }] }, extra: { hostRules: { liveChecks: '.claude/rules/live.md' } } });
  const sha = codeClone(t.w.settings, 'cabinet-web', { 'src/archive/columns.tsx': 'export const amount = row.finishedAmount;\n' });
  await freeze(t);
  const code = { kind: 'code', repo: 'cabinet-web', path: 'src/archive/columns.tsx', lines: '1', commit: sha };
  const kept = { id: 'p1', outcome: 'kept', why: 'Тестове середовище не дає цього стану без пристрою.', sources: [{ kind: 'live', ref: 'api-check.md', result: 'немає пристрою', setup: 'створено тестовий платіж; пристрій не підключити' }] };
  const ok = { items: [{ id: 'q1', outcome: 'answered', answer: 'Фактичну суму', evidence: [code] }, kept] };
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [] }, kept] }), /item q1 is answered with no "evidence"/);
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [{ ...code, path: 'src/none.tsx' }] }, kept] }), /cabinet-web has no src\/none\.tsx/);
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [{ ...code, repo: 'unknown-repo' }] }, kept] }), /no clone of unknown-repo on this machine/);
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'kept', why: 'немає', sources: [] }] }), /item p1 is kept with no "sources"/);
  await refusedAs(t, passDone(t, { items: [ok.items[0], { ...kept, sources: [{ kind: 'code', ref: 'x', result: 'y' }] }] }), /item p1 is a place kept: name the live check you ran for it/);
  await refusedAs(t, passDone(t, { items: [ok.items[0]] }), /item p1 has no outcome/);
  await refusedAs(t, passDone(t, { items: [...ok.items, { id: 'q9', outcome: 'kept', why: 'x', sources: [] }] }), /item q9 is not one of this pass's \(q1, p1\)/);
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'confirmed', answer: 'x', evidence: [code] }, kept] }), /item q1 is a question: only a place is confirmed/);
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'confirmed', answer: 'x', evidence: [code] }] }), /a place is confirmed only when it was seen working/);
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'answered', answer: 'x', evidence: [{ kind: 'live', log: 'work/tickets/2101/none.txt', setup: 'x' }] }] }), /the log work\/tickets\/2101\/none\.txt is not there/);
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'answered', answer: 'x', evidence: [{ kind: 'rule', ref: 'nowhere', text: 'x' }] }] }), /the rule 'nowhere' is neither a key of the host's rules \(liveChecks\) nor "role"/);
  await passDone(t, ok);
  const l = read(t.w, '2101');
  assert.equal(l.stages.answerPass.status, 'done');
  assert.deepEqual(l.stages.answerPass.result.input.items.map((x) => x.id), ['q1', 'p1']);
});

test('a stage\'s own question is passed through untouched: never an item, and the card\'s questions and the PR\'s answers stay as they were', async () => {
  const own = [{ id: 'fit-1', kind: 'fit', text: 'The table lists cards, not accounts: add a row?', sources: [{ kind: 'page', ref: 'docs/a.md', result: 'cards only' }], commentId: 'cm-1', answer: { at: ago(30) } }];
  const t = passWorld({ questions: own, open: { questions: [{ text: 'Keep the note?', reader: 'writer', proposal: 'Leave it as it is.' }] } });
  const input = await freeze(t);
  assert.deepEqual(input.items.map((x) => [x.id, x.kind]), [['q1', 'question']]);
  await refusedAs(t, passDone(t, { items: [{ id: 'fit-1', outcome: 'answered', answer: 'x', evidence: [{ kind: 'rule', ref: 'role', text: 'x' }] }, { id: 'q1', outcome: 'kept', why: 'x', sources: [{ kind: 'a', ref: 'b', result: 'c' }] }] }), /item fit-1 is not one of this pass's \(q1\): a stage's own question, and anything not listed, stays as it is/);
  await passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'Лишити як є: це не питання.', evidence: [{ kind: 'rule', ref: 'role', text: 'If your own proposal would be to leave the page as it is, it is no question: decide it and leave it out.' }] }] });
  assert.deepEqual(read(t.w, '2101').questions, own);
});

test('the page edits: the pass\'s edits go on the description\'s list after the UA review\'s fixes, numbered on; a pr record that leaves one out is refused', async () => {
  const fixed = [{ page: 'docs/a.md', block: 'Абзац', before: 'ліміт', after: 'денний ліміт' }];
  const t = passWorld({ fixed, open: { questions: [] } });
  const fx = apiClone(t.w);
  const head = fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац про ліміти. {/* NEEDS CONFIRMATION: the limit period */}\n' }, 'draft');
  t.forgePr.headCommit = head;
  ensureWorktree(t.w.settings, t.entry);
  await freeze(t, { markers: new Map([['api-docs:ticket-1', { found: [{ page: 'docs/a.md', line: 3, kind: 'NEEDS CONFIRMATION', text: 'the limit period' }] }]]) });
  const sha = codeClone(t.w.settings, 'ledger-api', { 'limits/period.go': 'const Period = "24h"\n' });
  const after = fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац про ліміти. Ліміт діє 24 години.\n' }, 'answers');
  t.forgePr.headCommit = after;
  const edit = { repo: 'api-docs', branch: 'ticket-1', page: 'docs/a.md', block: 'Абзац', before: '{/* NEEDS CONFIRMATION: the limit period */}', after: 'Ліміт діє 24 години.', item: 'm1' };
  await refusedAs(t, passDone(t, { items: [{ id: 'm1', outcome: 'answered', answer: '24 години', evidence: [{ kind: 'code', repo: 'ledger-api', path: 'limits/period.go', lines: '1', commit: sha }] }], edits: [{ ...edit, item: 'x' }], prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: [after] }] }), /edit 1 names no answered or confirmed item/);
  await passDone(t, { items: [{ id: 'm1', outcome: 'answered', answer: '24 години', evidence: [{ kind: 'code', repo: 'ledger-api', path: 'limits/period.go', lines: '1', commit: sha }] }], edits: [edit], prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: [after] }] });
  assert.ok(read(t.w, '2101').prs[0].pipelineCommits.includes(after), "the pass's commit is the pipeline's, never a hand edit");
  // The pr brief names the edit and the heading; the description's list takes it as item 2.
  const lines = prLinesAfterPass([read(t.w, '2101')], t.w.settings).join('\n');
  assert.match(lines, /under the heading «Edits from the answers»/);
  assert.match(lines, /docs\/a\.md` · Абзац: «\{\/\* NEEDS CONFIRMATION: the limit period \*\/\}» → «Ліміт діє 24 години\.» \(m1\)/);
  const prRec = (edits) => rec(t.w, { key: '2101', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-1', number: 7, expertReview: { recommended: false, why: 'all checked' }, edits }], places: [] } });
  await refusedAs(t, prRec([{ n: 1, ...fixed[0] }]), /lacks the answer pass's edit on docs\/a\.md \(m1\)/);
  await prRec([{ n: 1, ...fixed[0] }, { n: 2, page: edit.page, block: edit.block, before: edit.before, after: edit.after }]);
  const p = read(t.w, '2101').prs[0];
  assert.deepEqual(p.edits.map((e) => [e.n, e.list, e.answers ?? null]), [[1, 'description', null], [2, 'description', 'm1']]);
});

// ------------------------------------------------------------------ a review round's new questions

test('a review round\'s new questions are held from the description and the check label until the PR\'s pass records; then the answered ones show resolved and the kept ones open', async () => {
  const c = card({ number: 2201, status: 'finalReview' });
  const extra = { companyRepos: COMPANY, forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 31, headCommit: 'b'.repeat(40) })], extra });
  ledger(w, c, { key: '2201', stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', answerPass: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2201', number: 31, targets: ['guide'], review: 'sme', stage: 'finalReview', questions: [], openQuestions: { items: [], stage: 'pr', seq: 1 } }] });
  const before = labelSnapshot(w.settings.state, ['2201']);
  await rec(w, { key: '2201', stage: 'answerComments', pr: 'guide-docs#31', status: 'done', result: { handled: [{ id: 9, updatedAt: ago(1) }], review: { id: 600, commits: [] }, questions: [{ text: 'Is the fee charged twice?' }, { text: 'Which status ends a claim?' }], asked: [{ text: 'Is the fee charged twice?', reader: 'developer' }, { text: 'Which status ends a claim?', reader: 'developer' }], posted: [600] } });
  let l = read(w, '2201');
  let p = l.prs[0];
  assert.deepEqual(p.questions.map((q) => [q.n, q.held ?? false]), [[1, true], [2, true]]);
  assert.ok(p.answerPassDue);
  assert.equal(renderSections(l, p, DEFAULT_LABELS).questions, DEFAULT_LABELS.none, 'held: not shown yet');
  assert.deepEqual(labelChanges(before, w.settings.state, ['2201'], w.settings.forge), [], 'the check label waits too');
  // The rule asks for the pass on the PR, its items the held questions.
  const t = await w.one('2201');
  assert.deepEqual([t.next.stage, t.next.pr], ['answerPass', 'guide-docs#31']);
  assert.deepEqual(roundInput(p).items.map((x) => x.id), ['d1', 'd2']);
  await rec(w, { key: '2201', stage: 'answerPass', pr: 'guide-docs#31', status: 'running', result: { input: roundInput(p) } });
  fs.mkdirSync(path.join(w.root, 'work/tickets/2201'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'work/tickets/2201/fee-check.txt'), 'POST /v1/fees → 200, charged once\n');
  const mid = labelSnapshot(w.settings.state, ['2201']);
  w.settings.workFolder = 'work/tickets/<key>';
  await rec(w, { key: '2201', stage: 'answerPass', pr: 'guide-docs#31', status: 'done', result: { items: [{ id: 'd1', outcome: 'answered', answer: 'Once: the test call charged it once.', evidence: [{ kind: 'live', log: 'work/tickets/2201/fee-check.txt', setup: 'a test loan on the owner\'s account' }] }, { id: 'd2', outcome: 'kept', why: 'No route sets it on the test environment.', sources: [{ kind: 'code', ref: 'ledger-api claims.go', result: 'set by a job' }] }] } });
  l = read(w, '2201');
  p = l.prs[0];
  assert.equal(p.answerPassDue, undefined);
  assert.deepEqual(p.questions.map((q) => [q.n, q.held ?? false, q.answer?.by ?? null]), [[1, false, 'answerPass'], [2, false, null]]);
  assert.deepEqual(p.openQuestions.items.map((x) => x.text), ['Which status ends a claim?']);
  const shown = renderSections(l, p, DEFAULT_LABELS).questions;
  assert.match(shown, /\*\*2\.\*\* Which status ends a claim\?/);
  assert.match(shown, /~~Is the fee charged twice\?~~ Once/);
  assert.deepEqual(labelChanges(mid, w.settings.state, ['2201'], w.settings.forge).map((x) => [x.label, x.add]), [['Look at me', true]]);
  // A miss: the pass answered a question the round asked from a source in reach.
  assert.deepEqual(readMisses(w.settings.state).map((m) => [m.ticket, m.item.id, m.source.kind, m.settledBy, m.missedBy]), [['2201', 'd1', 'live', 'answerPass', 'answerComments']]);
  // With the company repos unset, a round's questions are shown at once, as before.
  const w2 = world({ cards: [card({ number: 2202, status: 'finalReview' })], prs: [pr({ repo: 'guide-docs', number: 32 })], extra: { forge: extra.forge } });
  const c2 = w2.tracker.cards[0];
  ledger(w2, c2, { key: '2202', stages: { pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2202', number: 32, targets: ['guide'], review: 'sme', stage: 'finalReview', questions: [] }] });
  await rec(w2, { key: '2202', stage: 'answerComments', pr: 'guide-docs#32', status: 'done', result: { handled: [], review: { id: 601, commits: [] }, questions: [], asked: [{ text: 'Q?', reader: 'developer' }], posted: [601] } });
  assert.equal(read(w2, '2202').prs[0].questions[0].held, undefined);
});

// ------------------------------------------------------------------ the misses log and the week

test('the misses log: the owner\'s worded answer from a source in reach is a line (once, whatever the retries); the owner\'s own word is none; the week groups by kind and proposes a kind seen twice, once', async () => {
  const c = card({ number: 2301, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 41 })], extra: { forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } } });
  ledger(w, c, { key: '2301', stages: { pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2301', number: 41, targets: ['guide'], review: 'sme', stage: 'finalReview', questions: [{ n: 1, text: 'Which column shows the amount?', reader: 'developer', stage: 'pr' }, { n: 2, text: 'Keep the note?', reader: 'writer', stage: 'pr' }, { n: 3, text: 'Does the widget retry?', reader: 'developer', stage: 'pr' }] }] });
  const round = (answered, id) => rec(w, { key: '2301', stage: 'answerComments', pr: 'guide-docs#41', status: 'done', result: { handled: [], review: { id, commits: [] }, questions: [], answered, posted: [id] } });
  await assert.rejects(round([{ n: 1, answer: 'x', source: { kind: 'guess' } }], 700), (e) => e.exitCode === 2 && /"source" is \{ "kind", "ref" \}/.test(e.message));
  await round([{ n: 1, answer: 'The actual amount, per the cabinet code', source: { kind: 'code', ref: 'cabinet-web:src/archive/columns.tsx' } }, { n: 2, answer: 'keep', source: { kind: 'owner' } }], 701);
  await round([{ n: 1, answer: 'The actual amount, per the cabinet code', source: { kind: 'code', ref: 'cabinet-web:src/archive/columns.tsx' } }], 702);
  await round([{ n: 3, answer: 'Yes, three times', by: 'expert', source: { kind: 'code', ref: 'pay-widget:src/retry.ts' } }], 703);
  const lines = readMisses(w.settings.state);
  assert.deepEqual(lines.map((m) => [m.item.id, m.source.ref, m.settledBy, m.missedBy]), [['d1', 'cabinet-web:src/archive/columns.tsx', 'owner', 'pr'], ['d3', 'pay-widget:src/retry.ts', 'expert', 'pr']]);
  // The week: two from the code, so one rule line for the writer role; given again, the kind is not proposed again.
  const now = NOW + 3600000;
  const week = weeklyAnswers(w.settings, [read(w, '2301')], now, true);
  assert.deepEqual(week.groups.map((g) => [g.kind, g.count]), [['code', 2]]);
  assert.equal(week.proposals.length, 1);
  assert.equal(week.proposals[0].for, 'writer role');
  assert.match(week.proposals[0].line, /search the company repos for the names it holds/);
  assert.equal(weeklyAnswers(w.settings, [], now + 3600000, true), null, 'once in seven days');
  assert.deepEqual(weekOf(lines, { since: 0, until: Infinity, proposed: ['code'] }).proposals, []);
  const text = renderAnswers(week).join('\n');
  assert.match(text, /## Answers and misses this week/);
  assert.match(text, /- code: 2 \(2301 d1 from cabinet-web:src\/archive\/columns\.tsx, missed at pr, settled by owner/);
  assert.match(text, /for the writer role: Before a question or a place, search the company repos/);
  assert.ok(fs.existsSync(missesPath(w.settings.state)));
});

test('the measures per ticket: the items the writer left, those the pass answered or confirmed, those that reached the owner', () => {
  const at = new Date(NOW).toISOString();
  const l = { key: '2401', stages: { answerPass: { status: 'done', at, result: { input: { items: [{ id: 'q1' }, { id: 'q2' }, { id: 'p1' }, { id: 'm1' }] }, items: [{ id: 'q1', outcome: 'answered' }, { id: 'q2', outcome: 'answered' }, { id: 'p1', outcome: 'confirmed' }, { id: 'm1', outcome: 'kept' }] } }, pr: { status: 'done', at } }, prs: [{ questions: [{ n: 1, stage: 'pr' }] }], places: [] };
  assert.deepEqual(answerMeasures([l], { since: NOW - 1000, until: NOW + 1000 }), [{ ticket: '2401', left: 4, answered: 2, confirmed: 1, kept: 1, reachedOwner: 1 }]);
  assert.deepEqual(answerMeasures([l], { since: NOW + 1000 }), []);
});

// ------------------------------------------------------------------ replays (invented data, the shapes of real tickets)

test('replay, a question answered from a frontend repo (AC-1): q1 from the cabinet\'s code with file and lines, the two leave-as-is questions settled by the question rule, and the description shows no open question', async () => {
  const open = { questions: [
    { text: 'Which amount does the archive column «Сума» show for an order closed with the actual amount?', reader: 'developer', why: 'The backend returns both amounts; which one the column shows is up to the frontend.', proposal: 'Replace the marker once answered.', sources: [{ kind: 'code', ref: 'ledger-api orders/handlers.go L463-L541', result: 'both amount and finishedAmount' }] },
    { text: 'Add a sentence that orders are closed with the actual amount when it is lower too?', reader: 'writer', proposal: 'Leave it as it is: the rule is already true for a lower amount.' },
    { text: 'Explain what the match level above 50 % measures?', reader: 'writer', proposal: 'Leave it as it is: the threshold is enough for the operator.' },
  ] };
  const t = passWorld({ key: '2501', open, extra: { forge: { ...rawSettings().forge, reviewRounds: true } } });
  const sha = codeClone(t.w.settings, 'cabinet-web', { 'src/components/Archive/columns.tsx': 'import x from "y";\n\nexport const columns = [\n  { title: "Сума", value: (row) => row.finishedAmount },\n];\n' });
  await freeze(t);
  const rule = { kind: 'rule', ref: 'role', text: 'If your own proposal would be to leave the page as it is, it is no question: decide it and leave it out.' };
  await passDone(t, { items: [
    { id: 'q1', outcome: 'answered', answer: 'Колонка «Сума» показує фактичну суму закриття (finishedAmount).', evidence: [{ kind: 'code', repo: 'cabinet-web', path: 'src/components/Archive/columns.tsx', lines: '4', commit: sha, url: `https://code.example/acme/cabinet-web/blob/${sha}/src/components/Archive/columns.tsx#L4-L4` }] },
    { id: 'q2', outcome: 'answered', answer: 'Лишити як є.', evidence: [rule] },
    { id: 'q3', outcome: 'answered', answer: 'Лишити як є.', evidence: [rule] },
  ] });
  const lines = prLinesAfterPass([read(t.w, '2501')], t.w.settings).join('\n');
  assert.match(lines, /settled 3 of 3 item\(s\) and kept 0/);
  // The PR stage posts none of them, and a question that repeats one is refused with review rounds.
  const prRec = (questions) => rec(t.w, { key: '2501', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-1', number: 7, expertReview: { recommended: false, why: 'all checked in the code' }, questions }], places: [] } });
  await refusedAs(t, prRec([{ text: 'Which amount?', reader: 'developer', item: 'q1' }]), /question \? repeats item q1, which the answer pass settled/);
  await prRec([]);
  const l = read(t.w, '2501');
  assert.equal(renderSections(l, l.prs[0], DEFAULT_LABELS).questions, DEFAULT_LABELS.none);
  const m = readMisses(t.w.settings.state).find((x) => x.item.id === 'q1');
  assert.deepEqual([m.source.kind, m.source.ref, m.settledBy, m.missedBy], ['code', 'cabinet-web:src/components/Archive/columns.tsx#L4', 'answerPass', 'write']);
  assert.deepEqual(answerMeasures([l], { since: NOW - 1000, until: NOW + 1000 })[0], { ticket: '2501', left: 3, answered: 3, confirmed: 0, kept: 0, reachedOwner: 0 });
});

test('replay, a place answered from an earlier ticket\'s live check (AC-2): it leaves the places; a "no test pool" place can\'t be kept with missing test data as its only reason', async () => {
  const open = { places: [
    { repo: 'api-docs', page: 'docs/a.md', line: 3, claim: 'Повернення доступне лише для статусу NEW', why: 'Поведінку прочитано з коду, не перевірено.', source: 'code' },
    { repo: 'api-docs', page: 'docs/a.md', line: 5, claim: 'Квазі-пул обробляє замовлення за 10 хвилин', why: 'Немає тестового пулу.', source: 'code' },
  ] };
  const t = passWorld({ key: '2601', open });
  apiClone(t.w, '# Сторінка\n\nПовернення доступне лише для статусу NEW. Абзац про ліміти й пули.\n\nКвазі-пул обробляє замовлення.\n');
  ensureWorktree(t.w.settings, t.entry);
  const old = path.join(t.w.root, 'work/tickets/2480');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'api-check.md'), '## §3 Refund\n\nPOST /v1/refund for a NEW order → 200; for DONE → 400.\n');
  await freeze(t);
  const fromTicket = { id: 'p1', outcome: 'answered', answer: 'Так: ticket 2480 on 2026-10-20 saw 200 for NEW and 400 for DONE; today the code is the same.', evidence: [{ kind: 'docs', ticket: '2480', file: 'api-check.md' }] };
  // A kept item's why is in the page's language.
  await refusedAs(t, passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'The pool timer runs only in production.', sources: [{ kind: 'live', ref: 'x', result: 'y', setup: 'z' }] }] }), /item p2's why is not in the language of docs\/a\.md \(Cyrillic script\)/);
  // "Missing test data" alone is no kept place: the pass names the live check and the setup it made.
  await refusedAs(t, passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'Немає тестового пулу.', sources: [{ kind: 'code', ref: 'ledger-api pools.go', result: 'таймер 10 хв' }] }] }), /item p2 is a place kept: name the live check/);
  await passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'Тестовий пул створено, але таймер спрацьовує лише на робочому середовищі.', sources: [{ kind: 'live', ref: 'work/tickets/2601/pool-check.txt', result: 'замовлення не закрилось за 15 хв', setup: 'створено квазі-пул на тестовому акаунті власника' }, { kind: 'code', ref: 'ledger-api pools.go L40', result: 'таймер 10 хв' }] }] });
  const lines = prLinesAfterPass([read(t.w, '2601')], t.w.settings).join('\n');
  assert.match(lines, /- p1 answered: Повернення доступне лише для статусу NEW/);
  assert.match(lines, /- p2 \(place\): .*why: Тестовий пул створено/);
  const m = readMisses(t.w.settings.state);
  assert.deepEqual(m.map((x) => [x.item.id, x.source.kind, x.source.ref]), [['p1', 'ticket', '2480/api-check.md']]);
});

test('replay, a state no screen gives, reached through a backend route (AC-4): the claim\'s question is answered with the live check\'s log and the route in the code, and reaches no one', async () => {
  const t = passWorld({ key: '2701', uaOpen: ['Update the reasons tables, or remove `reason` from the response sample? A finished claim was not reached: the console hides Finish and Reject for NEW claims.'], extra: { hostRules: { liveChecks: '.claude/rules/live.md' } } });
  const sha = codeClone(t.w.settings, 'ledger-api', { 'routes/console.go': 'r.PATCH("/api/v2/console/order/:id/claim", setClaimStatus)\n' });
  fs.mkdirSync(path.join(t.w.root, 'work/tickets/2701'), { recursive: true });
  fs.writeFileSync(path.join(t.w.root, 'work/tickets/2701/api-check.md'), '## §6 A finished claim\n\nPATCH /api/v2/console/order/:id/claim {"Status":"CANCELED"} → 200\nGET /v1/order/:id/claim → 200, no "reason" key\n');
  await freeze(t);
  assert.deepEqual((read(t.w, '2701').answerInput.items).map((x) => [x.id, x.kind, x.from]), [['f1', 'finding', 'uaReview']]);
  await passDone(t, { items: [{ id: 'f1', outcome: 'answered', answer: 'Remove `reason`: a finished claim read through the client API has no such key.', evidence: [{ kind: 'live', log: 'work/tickets/2701/api-check.md', setup: 'the test claim finished through the backend route the console calls, with the test admin account the host\'s rules name' }, { kind: 'code', repo: 'ledger-api', path: 'routes/console.go', lines: '1', commit: sha }] }] });
  const l = read(t.w, '2701');
  assert.equal(l.stages.answerPass.result.items[0].outcome, 'answered');
  assert.deepEqual(answerMeasures([l], { since: NOW - 1000, until: NOW + 1000 })[0].reachedOwner, 0);
  assert.deepEqual(readMisses(t.w.settings.state).map((x) => [x.item.id, x.source.kind]), [['f1', 'live']]);
  // The brief tells the pass how such a state is reached.
  const brief = briefFor({ stage: 'answerPass', role: 'writer', keys: ['2701'], answerItems: l.answerInput.items }, t.w.settings);
  assert.match(brief, /A state no screen gives \(an action a cabinet hides for that status\) is often set through the backend route the screens call/);
});

test('the report shows the week\'s answers on the day they were made', () => {
  const w = world();
  const st = { mode: 'on', wip: { inProgress: 0, waiting: 0, limits: { inProgress: 3, waiting: 5 } }, allowance: null, tickets: [], startable: [], notStarted: [], notTickets: [], intake: { due: [] } };
  const week = { at: new Date(NOW).toISOString(), since: new Date(NOW - 7 * 86400000).toISOString(), groups: [], proposals: [], measures: [{ ticket: '9', left: 2, answered: 1, confirmed: 0, kept: 1, reachedOwner: 1 }] };
  const text = renderReport({ settings: w.settings, st, date: '2026-11-10', answers: week, ledgers: [] });
  assert.match(text, /- 9: left 2, answered 1, confirmed 0, reached the owner 1/);
  assert.ok(!renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }).includes('Answers and misses'));
});
