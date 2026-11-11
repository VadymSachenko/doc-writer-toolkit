import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LISTS, NOW, ago, card, gitRepo, noTree, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, snapshot, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { briefFor, codeLines, codeReposFor, commandFor, runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { validateSettings } from '../lib/settings.mjs';
import { ensureWorktree, codeClonePath } from '../lib/worktree.mjs';
import { passRepos, resolveCompanyRepos, safeUrl, validateCompanyRepos } from '../lib/company-repos.mjs';
import { blobAt, passInput, passLines, prLinesAfterPass, roundInput } from '../lib/answer-pass.mjs';
import { markersAt } from '../lib/gates.mjs';
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
const RULE = { kind: 'rule', ref: 'role', text: "If your own proposal would be to leave the page as it is, or the card's words already answer it, it is no question: decide it and leave it out." };
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
  assert.deepEqual(validateCompanyRepos({ org: 'acme', exclude: ['old-forms', 'old-forms'], path: '../<repo>' }), { org: 'acme', exclude: ['old-forms'], path: '../<repo>', max: 200 });
  assert.equal(validateCompanyRepos({ org: 'acme', max: 40 }).max, 40);
  for (const [bad, re] of [
    [[{ repo: 'a' }], /companyRepos\[0\]\.url is required/],
    // An address with a token or a user in it is never cloned from, nor shown in a brief.
    [[{ repo: 'a', url: 'https://x-access-token:ghp_abc@code.example/acme/a' }], /companyRepos\[0\]\.url carries a user or a token/],
    [[{ repo: 'a', url: 'https://someone@code.example/acme/a' }], /carries a user or a token/],
    [{ org: 'acme', max: 0 }, /companyRepos\.max must be a whole number from 1 to 1000/],
    [{ org: 'acme', max: 5000 }, /companyRepos\.max/],
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
  // One more than `max` (200 by default): a list that long says the org has more.
  assert.equal(gh.args(), 'repo list acme --limit 201 --json name,url,isArchived,defaultBranchRef');
  assert.ok(!r.notes.some((n) => /more than/.test(n)));
  assert.deepEqual(r.repos, [{ repo: 'cabinet-web', url: 'https://code.example/acme/cabinet-web', base: 'develop', path: '../cabinet-web' }, { repo: 'pay-widget', url: 'https://code.example/acme/pay-widget', base: 'master', path: '../pay-widget' }]);
  assert.deepEqual(r.excluded, ['old-forms']);
  assert.match(r.notes[0], /archived, not read: retired-app/);
  const bad = resolveCompanyRepos(settings, { gh: fakeGh(null, { fail: true }).bin });
  assert.deepEqual(bad.repos, []);
  assert.match(bad.notes[0], /the repos of acme were not listed \(`gh repo list`: HTTP 401: Bad credentials\)/);
  // The cap: with `max` 2, gh is asked for 3; three come back, so two are read and a note says the org has more. An
  // address gh gives with a token in it is never read.
  const capped = { companyRepos: validateCompanyRepos({ org: 'acme', max: 2 }) };
  let limit = null;
  const many = resolveCompanyRepos(capped, { ghRepoList: (org, o) => ((limit = o.limit), [
    { name: 'a-app', url: 'https://code.example/acme/a-app', isArchived: false },
    { name: 'b-app', url: 'https://tok@code.example/acme/b-app', isArchived: false },
    { name: 'c-app', url: 'https://code.example/acme/c-app', isArchived: false },
  ]) });
  assert.equal(limit, 3);
  assert.deepEqual(many.repos.map((x) => x.repo), ['a-app']);
  assert.match(many.notes[0], /acme has more than 2 repos: only the first 2 `gh repo list` gave are read \(raise `companyRepos\.max`/);
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
  // And nothing is held: with no pass to answer them, the plan and the write ask on the card as before.
  await assert.rejects(rec(off.w, { key: '2101', stage: 'questions', status: 'done', result: { hold: true, from: 'write', questions: [{ kind: 'fact', text: 'Which limit?' }] } }), (e) => e.exitCode === 2 && /"hold" needs the host's companyRepos/.test(e.message));
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
  // The session failed: the pass gives up (nothing waits on it), and the PR follows the UA review.
  const l = read(t.w, '2101');
  assert.equal(l.answerPassFailed.after, l.stages.uaReview.seq);
  assert.equal(l.answerInput, undefined);
  assert.equal((await t.w.one('2101')).next.stage, 'pr');

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
  const left = { questions: [{ text: 'Which amount does the archive column show?', reader: 'developer' }] };
  const t = passWorld({ company: { org: 'acme' }, open: left });
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
  const failing = passWorld({ key: '2103', company: { org: 'acme' }, open: left });
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
  // The live check's log, written in the ticket's work folder during the pass.
  const work = path.join(t.w.root, 'work/tickets/2101');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'api-check.md'), 'POST /v1/payment → 200; the device step needs a reader\n');
  const kept = { id: 'p1', outcome: 'kept', why: 'Тестове середовище не дає цього стану без пристрою.', sources: [{ kind: 'live', ref: 'work/tickets/2101/api-check.md', result: 'немає пристрою', setup: 'створено тестовий платіж; пристрій не підключити' }] };
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
  // The role's rules: only its question rule decides by itself, and only a question that proposes to leave the page.
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [{ kind: 'rule', ref: 'role', text: 'A question is always answered by leaving the page as it is.' }] }, kept] }), /only the role's question rule decides a question by itself/);
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [{ kind: 'rule', ref: 'role', text: 'Never change a setting several accounts share unless the host' }] }, kept] }), /only the role's question rule decides a question by itself/);
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [RULE] }, kept] }), /item q1 has no proposal: the role's question rule decides only a question whose proposal is to leave the page as it is/);
  // A live log: in this ticket's work folder or the state folder, written during this pass.
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'confirmed', answer: 'x', evidence: [{ kind: 'live', log: 'CLAUDE.md', setup: 'x' }] }] }), /the log CLAUDE\.md is not in ticket 2101's work folder or the state folder/);
  fs.mkdirSync(path.join(t.w.root, 'work/tickets/2001'), { recursive: true });
  fs.writeFileSync(path.join(t.w.root, 'work/tickets/2001/old-check.md'), 'an earlier ticket\'s check\n');
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'confirmed', answer: 'x', evidence: [{ kind: 'live', log: 'work/tickets/2001/old-check.md', setup: 'x' }] }] }), /is not in ticket 2101's work folder/);
  fs.writeFileSync(path.join(work, 'stale.md'), 'before the pass\n');
  fs.utimesSync(path.join(work, 'stale.md'), new Date(NOW - 3600000), new Date(NOW - 3600000));
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'confirmed', answer: 'x', evidence: [{ kind: 'live', log: 'work/tickets/2101/stale.md', setup: 'x' }] }] }), /the log work\/tickets\/2101\/stale\.md was written before this pass began/);
  // A kept place's live check names its log, checked as evidence's is.
  await refusedAs(t, passDone(t, { items: [ok.items[0], { ...kept, sources: [{ ...kept.sources[0], ref: 'the test cabinet' }] }] }), /item p1 is a place kept: its live check's "ref" is the log that check wrote/);
  // The ticket's own notes are no earlier ticket's.
  fs.writeFileSync(path.join(work, 'notes.md'), 'Ліміт діє добу.\n');
  await refusedAs(t, passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'x', evidence: [{ kind: 'docs', ticket: '2101', file: 'notes.md' }] }, kept] }), /ticket 2101 is this ticket: its own notes are no earlier ticket's/);
  // A file the hub's git tracks is no log of this pass.
  execFileSync('git', ['init', '-q', t.w.root]);
  execFileSync('git', ['-C', t.w.root, 'add', 'work/tickets/2101/notes.md']);
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'confirmed', answer: 'x', evidence: [{ kind: 'live', log: 'work/tickets/2101/notes.md', setup: 'x' }] }] }), /the log work\/tickets\/2101\/notes\.md is a file git tracks/);
  // A place is settled by a check, a page or an earlier ticket: the code alone leaves it a place.
  await refusedAs(t, passDone(t, { items: [ok.items[0], { id: 'p1', outcome: 'answered', answer: 'x', evidence: [code] }] }), /item p1 is a place: code alone doesn't settle behaviour/);
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
  await passDone(t, { items: [{ id: 'q1', outcome: 'answered', answer: 'Лишити як є: це не питання.', evidence: [{ kind: 'rule', ref: 'role', text: "If your own proposal would be to leave the page as it is, or the card's words already answer it, it is no question: decide it and leave it out." }] }] });
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
  const m1 = { id: 'm1', outcome: 'answered', answer: '24 години', evidence: [{ kind: 'code', repo: 'ledger-api', path: 'limits/period.go', lines: '1', commit: sha }] };
  // On a ticket the commits go with their PR, so the PR stage takes them as the pipeline's, never as a hand edit.
  await refusedAs(t, passDone(t, { items: [m1], edits: [edit], commits: [after] }), /on a ticket, the pass's commits go in "prs"/);
  // A commit pushed with no edit is a change the owner can't undo by number.
  await refusedAs(t, passDone(t, { items: [m1], prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: [after] }] }), /commits were pushed with no "edits"/);
  // The runner's worktree is not at the branch's head on origin: the edits the description would list are not there.
  await assert.rejects(passDone(t, { items: [{ id: 'm1', outcome: 'answered', answer: '24 години', evidence: [{ kind: 'code', repo: 'ledger-api', path: 'limits/period.go', lines: '1', commit: sha }] }], edits: [edit], prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: [after] }] }), (e) => e.refused === 'notWritten' && /push the worktree's head/.test(e.message));
  ensureWorktree(t.w.settings, t.entry);
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

test('a round\'s question is held only if the round\'s review doesn\'t ask it already', async () => {
  const c = card({ number: 2203, status: 'finalReview' });
  const extra = { companyRepos: COMPANY, forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } };
  const activity = { 'guide-docs#33': { reviews: [{ id: 620, body: 'Fixed the two comments.\n\n**Question:** Is the fee charged twice?' }, { id: 621, body: 'Fixed the two comments. The answer pass looks into one question first.' }] } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 33, headCommit: 'b'.repeat(40) })], activity, extra });
  ledger(w, c, { key: '2203', stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', answerPass: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2203', number: 33, targets: ['guide'], review: 'sme', stage: 'finalReview', questions: [] }] });
  const round = (id) => rec(w, { key: '2203', stage: 'answerComments', pr: 'guide-docs#33', status: 'done', result: { handled: [], review: { id, commits: [] }, questions: [{ text: 'Is the fee charged twice?' }], asked: [{ text: 'Is the fee charged twice?', reader: 'developer' }], posted: [id] } });
  await assert.rejects(round(620), (e) => e.refused === 'answers' && /the round's review asks "Is the fee charged twice\?" already/.test(e.message));
  assert.equal(read(w, '2203').prs[0].questions.length, 0, 'nothing recorded');
  await round(621);
  assert.equal(read(w, '2203').prs[0].questions[0].held, true);
});

test('a pass that fails gives up what it held: a round\'s questions are shown and the label follows them; held questions go back to the plan to ask on the card; after the UA review, the PR follows it', async () => {
  // On a PR: the round held two questions; the pass on the PR fails.
  const c = card({ number: 2204, status: 'finalReview' });
  const extra = { companyRepos: COMPANY, forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } };
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 34, headCommit: 'b'.repeat(40) })], extra });
  ledger(w, c, { key: '2204', stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', answerPass: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2204', number: 34, targets: ['guide'], review: 'sme', stage: 'finalReview', questions: [], openQuestions: { items: [], stage: 'pr', seq: 1 } }] });
  await rec(w, { key: '2204', stage: 'answerComments', pr: 'guide-docs#34', status: 'done', result: { handled: [], review: { id: 630, commits: [] }, questions: [{ text: 'Is the fee charged twice?' }], asked: [{ text: 'Is the fee charged twice?', reader: 'developer' }], posted: [630] } });
  await rec(w, { key: '2204', stage: 'answerPass', pr: 'guide-docs#34', status: 'running', result: { input: roundInput(read(w, '2204').prs[0]) } });
  const before = labelSnapshot(w.settings.state, ['2204']);
  await rec(w, { key: '2204', stage: 'answerPass', pr: 'guide-docs#34', status: 'failed', note: 'the session ended with no record' });
  let l = read(w, '2204');
  const p = l.prs[0];
  assert.equal(p.answerPassDue, undefined);
  assert.equal(p.questions[0].held, undefined);
  assert.deepEqual(p.openQuestions.items.map((x) => x.text), ['Is the fee charged twice?']);
  assert.match(renderSections(l, p, DEFAULT_LABELS).questions, /\*\*1\.\*\* Is the fee charged twice\?/);
  assert.deepEqual(labelChanges(before, w.settings.state, ['2204'], w.settings.forge).map((x) => [x.label, x.add]), [['Look at me', true]]);
  assert.notEqual((await w.one('2204')).next?.stage, 'answerPass');
  assert.match(l.log.at(-1).note, /given up: 1 held question\(s\) shown on guide-docs#34/);

  // Held by the plan: the pass fails, the plan runs again and asks them on the card; holding them again is refused.
  const c2 = card({ number: 2205, status: 'inProgress' });
  const w2 = world({ cards: [c2], extra: { companyRepos: COMPANY } });
  ledger(w2, c2, { key: '2205', stages: { triage: 'done', start: 'done' } });
  const q = { kind: 'fact', text: 'Which fee applies to a partial refund?', sources: [{ kind: 'code', ref: 'ledger-api fees/', result: 'full refunds only' }] };
  await rec(w2, { key: '2205', stage: 'questions', status: 'done', result: { hold: true, from: 'plan', questions: [q] } });
  await rec(w2, { key: '2205', stage: 'answerPass', status: 'running', result: { input: (await import('../lib/answer-pass.mjs')).heldInput(read(w2, '2205')) } });
  await rec(w2, { key: '2205', stage: 'answerPass', status: 'failed', note: 'no session' });
  assert.equal((await w2.one('2205')).next.stage, 'plan');
  const lines = (await import('../lib/answer-pass.mjs')).heldAnswerLines([read(w2, '2205')]).join('\n');
  assert.match(lines, /The answer pass on the questions 2205's plan held failed, so they wait on no one: ask them on the card as before/);
  assert.match(lines, /- \(fact\) Which fee applies to a partial refund\? \(tried: code ledger-api fees\/\)/);
  await assert.rejects(rec(w2, { key: '2205', stage: 'questions', status: 'done', result: { hold: true, from: 'plan', questions: [q] } }), (e) => e.refused === 'answers' && /the answer pass failed on it, so it is asked on the card/.test(e.message));

  // After the UA review: the pass fails, and the PR follows the UA review with a note.
  const t = passWorld({ key: '2206', open: { questions: [{ text: 'Which amount?', reader: 'developer' }] } });
  await freeze(t);
  await rec(t.w, { key: '2206', stage: 'answerPass', status: 'failed', note: 'no session' });
  const s = await t.w.one('2206');
  assert.equal(s.next.stage, 'pr');
  assert.ok(s.notes.some((n) => /the answer pass failed after the UA review, so the PR follows the UA review/.test(n)), s.notes.join('; '));
  l = read(t.w, '2206');
  assert.equal(l.answerPassFailed.after, l.stages.uaReview.seq);
});

test('holding a question is by what it is: a kind the pass can answer, from the stage running now; anything else is asked on the card', async () => {
  const c = card({ number: 2207, status: 'inProgress' });
  const w = world({ cards: [c], extra: { companyRepos: COMPANY } });
  ledger(w, c, { key: '2207', stages: { triage: 'done', start: 'done' } });
  const hold = (from, questions) => rec(w, { key: '2207', stage: 'questions', status: 'done', result: { hold: true, from, questions } });
  await assert.rejects(hold('plan', [{ text: 'No kind given?' }]), (e) => e.exitCode === 2 && /a held question's "kind" is one of fact, code, behaviour, text \(none given/.test(e.message));
  await assert.rejects(hold('plan', [{ kind: 'conflict', text: 'Two edits disagree: which one?' }]), (e) => e.exitCode === 2 && /\("conflict" given/.test(e.message));
  await assert.rejects(hold('plan', [{ kind: 'admin', text: 'Turn the setting on?' }]), (e) => e.exitCode === 2 && /a "admin" question is the stage's own/.test(e.message));
  await assert.rejects(hold('write', [{ kind: 'fact', text: 'Which limit?' }]), (e) => e.exitCode === 2 && /"from": "write", but the plan is not done yet/.test(e.message));
  await hold('plan', [{ kind: 'fact', text: 'Which limit?' }]);
  assert.equal(read(w, '2207').heldQuestions.items.length, 1);
});

// ------------------------------------------------------------------ the misses log and the week

test('the misses log: the owner\'s worded answer from a source in reach is a line (once, whatever the retries); the owner\'s own word is none; the week groups by kind and proposes a kind seen twice, once', async () => {
  const c = card({ number: 2301, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 41 })], extra: { forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } } });
  ledger(w, c, { key: '2301', stages: { pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2301', number: 41, targets: ['guide'], review: 'sme', stage: 'finalReview', questions: [{ n: 1, text: 'Which column shows the amount?', reader: 'developer', stage: 'pr' }, { n: 2, text: 'Keep the note?', reader: 'writer', stage: 'pr' }, { n: 3, text: 'Does the widget retry?', reader: 'developer', stage: 'pr' }] }] });
  const round = (answered, id) => rec(w, { key: '2301', stage: 'answerComments', pr: 'guide-docs#41', status: 'done', result: { handled: [], review: { id, commits: [] }, questions: [], answered, posted: [id] } });
  await assert.rejects(round([{ n: 1, answer: 'x', foundIn: { kind: 'guess' } }], 700), (e) => e.exitCode === 2 && /"foundIn" is \{ "kind", "ref" \}/.test(e.message));
  await round([{ n: 1, answer: 'The actual amount, per the cabinet code', foundIn: { kind: 'code', ref: 'cabinet-web:src/archive/columns.tsx' } }, { n: 2, answer: 'keep', foundIn: { kind: 'owner' } }], 701);
  await round([{ n: 1, answer: 'The actual amount, per the cabinet code', foundIn: { kind: 'code', ref: 'cabinet-web:src/archive/columns.tsx' } }], 702);
  await round([{ n: 3, answer: 'Yes, three times', by: 'expert', foundIn: { kind: 'code', ref: 'pay-widget:src/retry.ts' } }], 703);
  const lines = readMisses(w.settings.state);
  assert.deepEqual(lines.map((m) => [m.item.id, m.source.ref, m.settledBy, m.missedBy]), [['d1', 'cabinet-web:src/archive/columns.tsx', 'owner', 'pr'], ['d3', 'pay-widget:src/retry.ts', 'expert', 'pr']]);
  // A place's own `source` (where its claim came from) echoed in a round is no miss's source and no error, with or
  // without the company repos: the miss's is `foundIn`.
  const lw = read(w, '2301');
  lw.places = [{ id: 'P1', repo: 'guide-docs', pr: 41, page: 'docs/a.md', line: 3, claim: 'Ліміт діє добу', why: 'з коду', source: 'code' }];
  fs.writeFileSync(path.join(w.settings.state, 'tickets', '2301.json'), JSON.stringify(lw));
  await rec(w, { key: '2301', stage: 'answerComments', pr: 'guide-docs#41', status: 'done', result: { handled: [], review: { id: 704, commits: [] }, questions: [], places: [{ id: 'P1', state: 'confirmed', replyId: 705, source: 'code' }], posted: [704, 705] } });
  assert.equal(read(w, '2301').places[0].state, 'confirmed');
  assert.equal(readMisses(w.settings.state).length, 2);
  // The week: two from the code but in one ticket, so no rule line yet: one ticket's two items are one gap.
  const now = NOW + 3600000;
  assert.deepEqual(weekOf(lines, { since: 0, until: Infinity }).proposals, []);
  // A miss from the code in a second ticket: then the kind is proposed once, as one rule line for the writer role.
  fs.appendFileSync(missesPath(w.settings.state), JSON.stringify({ at: new Date(NOW).toISOString(), ticket: '2302', item: { id: 'q1', kind: 'question', text: 'Which status?' }, source: { kind: 'code', ref: 'ledger-api:claims.go#L3' }, settledBy: 'answerPass', missedBy: 'write', key: 'k-2302' }) + '\n');
  const week = weeklyAnswers(w.settings, [read(w, '2301')], now, true);
  assert.deepEqual(week.groups.map((g) => [g.kind, g.count]), [['code', 3]]);
  assert.equal(week.proposals.length, 1);
  assert.equal(week.proposals[0].for, 'writer role');
  assert.match(week.proposals[0].line, /search the company repos for the names it holds/);
  assert.equal(weeklyAnswers(w.settings, [], now + 3600000, true), null, 'once in seven days');
  assert.deepEqual(weekOf(lines, { since: 0, until: Infinity, proposed: ['code'] }).proposals, []);
  const text = renderAnswers(week).join('\n');
  assert.match(text, /## Answers and misses this week/);
  assert.match(text, /- code: 3 \(2301 d1 from cabinet-web:src\/archive\/columns\.tsx, missed at pr, settled by owner/);
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

test('replay, a question answered from a frontend repo (AC-1): the marker answered from the cabinet\'s code with file and lines, the two leave-as-is questions the PR stage asked held and settled by the question rule, and the description shows no open question', async () => {
  const t = passWorld({ key: '2501', extra: { forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } } });
  const fx = apiClone(t.w);
  const marker = '{/* NEEDS CONFIRMATION: which amount the archive column «Сума» shows */}';
  t.forgePr.headCommit = fx.push({ 'docs/a.md': `# Сторінка\n\nАбзац про ліміти.\n\nАрхів показує суму. ${marker}\n` }, 'draft');
  ensureWorktree(t.w.settings, t.entry);
  // The write left a marker, as the live write did; the runner reads it in the worktree.
  const l0 = read(t.w, '2501');
  const input = passInput(l0, { markers: new Map([['api-docs:ticket-1', markersAt(t.w.settings, l0.prs[0], 'HEAD')]]) });
  assert.deepEqual(input.items.map((x) => [x.id, x.kind, x.page, x.line]), [['m1', 'marker', 'docs/a.md', 5]]);
  await rec(t.w, { key: '2501', stage: 'answerPass', status: 'running', result: { input } });
  const sha = codeClone(t.w.settings, 'cabinet-web', { 'src/components/Archive/columns.tsx': 'import x from "y";\n\nexport const columns = [\n  { title: "Сума", value: (row) => row.finishedAmount },\n];\n' });
  const after = fx.push({ 'docs/a.md': '# Сторінка\n\nАбзац про ліміти.\n\nАрхів показує фактичну суму закриття.\n' }, 'answers');
  t.forgePr.headCommit = after;
  ensureWorktree(t.w.settings, t.entry);
  const code = { kind: 'code', repo: 'cabinet-web', path: 'src/components/Archive/columns.tsx', lines: '4', commit: sha, url: `https://code.example/acme/cabinet-web/blob/${sha}/src/components/Archive/columns.tsx#L4-L4` };
  const edit = { repo: 'api-docs', branch: 'ticket-1', page: 'docs/a.md', block: 'Архів', before: `Архів показує суму. ${marker}`, after: 'Архів показує фактичну суму закриття.', item: 'm1' };
  // A rule alone settles no fact: the marker needs the code that shows it.
  await refusedAs(t, passDone(t, { items: [{ id: 'm1', outcome: 'answered', answer: 'x', evidence: [RULE] }] }), /item m1 is a marker: a rule alone settles no fact/);
  await passDone(t, { items: [{ id: 'm1', outcome: 'answered', answer: 'Колонка «Сума» показує фактичну суму закриття (finishedAmount).', evidence: [code] }], edits: [edit], prs: [{ repo: 'api-docs', branch: 'ticket-1', commits: [after] }] });
  // The PR stage asks two questions the pass never saw, with no item: held for the pass on the PR, never shown.
  const asked = [{ text: 'Add a sentence that orders are closed with the actual amount when it is lower too?', reader: 'writer', proposal: 'Leave it as it is: the rule is already true for a lower amount.' }, { text: 'Explain what the match level above 50 % measures?', reader: 'writer', proposal: 'Leave it as it is: the threshold is enough for the operator.' }];
  const prRec = (questions) => rec(t.w, { key: '2501', stage: 'pr', status: 'done', result: { prs: [{ repo: 'api-docs', branch: 'ticket-1', number: 7, expertReview: { recommended: false, why: 'all checked in the code' }, edits: [{ n: 1, page: edit.page, block: edit.block, before: edit.before, after: edit.after }], questions }], places: [] } });
  await refusedAs(t, prRec([{ text: 'Which amount?', reader: 'developer', item: 'm1' }]), /question \? repeats item m1, which the answer pass settled/);
  await prRec(asked);
  let l = read(t.w, '2501');
  let p = l.prs[0];
  assert.deepEqual(p.questions.map((q) => [q.n, q.held ?? false]), [[1, true], [2, true]]);
  assert.ok(p.answerPassDue);
  assert.equal(renderSections(l, p, DEFAULT_LABELS).questions, DEFAULT_LABELS.none, 'nothing shown before the pass');
  assert.ok((await t.w.one('2501')).steps.some((x) => x.stage === 'answerPass' && x.pr === 'api-docs#7'));
  // The pass on the PR: both settled by the role's question rule.
  await rec(t.w, { key: '2501', stage: 'answerPass', pr: 'api-docs#7', status: 'running', result: { input: roundInput(p) } });
  await passDone(t, { items: [{ id: 'd1', outcome: 'answered', answer: 'Лишити як є.', evidence: [RULE] }, { id: 'd2', outcome: 'answered', answer: 'Лишити як є.', evidence: [RULE] }] }, { pr: 'api-docs#7' });
  l = read(t.w, '2501');
  p = l.prs[0];
  const shown = renderSections(l, p, DEFAULT_LABELS).questions;
  assert.ok(!shown.includes('<details open>'), 'no open question in the description');
  assert.match(shown, /~~Add a sentence that orders are closed/);
  const m = readMisses(t.w.settings.state);
  assert.deepEqual(m.map((x) => [x.item.id, x.source.kind, x.source.ref, x.settledBy, x.missedBy]), [['m1', 'code', 'cabinet-web:src/components/Archive/columns.tsx#L4', 'answerPass', 'write']]);
  // d1 and d2 were settled by the role's own rule: written already, so no miss and nothing to propose.
  assert.deepEqual(answerMeasures([l], { since: NOW - 1000, until: NOW + 1000 })[0], { ticket: '2501', left: 3, answered: 3, confirmed: 0, kept: 0, reachedOwner: 0 });
});

test('replay, a place answered from an earlier ticket\'s live check (AC-2): it leaves the places; a "no test pool" place can\'t be kept with missing test data as its only reason', async () => {
  const open = { places: [
    { repo: 'api-docs', page: 'docs/a.md', line: 3, claim: 'Повернення доступне лише для статусу NEW', why: 'Поведінку прочитано з коду, не перевірено.', source: 'code' },
    { repo: 'api-docs', page: 'docs/a.md', line: 5, claim: 'Черга обробки закриває замовлення за 10 хвилин', why: 'Немає тестової черги.', source: 'code' },
  ] };
  const t = passWorld({ key: '2601', open });
  apiClone(t.w, '# Сторінка\n\nПовернення доступне лише для статусу NEW. Абзац про ліміти й черги.\n\nЧерга обробки закриває замовлення.\n');
  ensureWorktree(t.w.settings, t.entry);
  const old = path.join(t.w.root, 'work/tickets/2480');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'api-check.md'), '## §3 Refund\n\nPOST /v1/refund for a NEW order → 200; for DONE → 400.\n');
  await freeze(t);
  const fromTicket = { id: 'p1', outcome: 'answered', answer: 'Так: ticket 2480 on 2026-10-20 saw 200 for NEW and 400 for DONE; today the code is the same.', evidence: [{ kind: 'docs', ticket: '2480', file: 'api-check.md' }] };
  // A kept item's why is in the page's language.
  await refusedAs(t, passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'The queue timer runs only in production.', sources: [{ kind: 'live', ref: 'x', result: 'y', setup: 'z' }] }] }), /item p2's why is not in the language of docs\/a\.md \(Cyrillic script\)/);
  // "Missing test data" alone is no kept place: the pass names the live check and the setup it made.
  await refusedAs(t, passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'Немає тестової черги.', sources: [{ kind: 'code', ref: 'ledger-api queues.go', result: 'таймер 10 хв' }] }] }), /item p2 is a place kept: name the live check/);
  // Nor a live check that wasn't run: its `ref` is the log it wrote in this ticket's work folder during the pass.
  const ran = { kind: 'live', ref: 'work/tickets/2601/queue-check.txt', result: 'замовлення не закрилось за 15 хв', setup: 'створено чергу обробки на тестовому акаунті власника' };
  await refusedAs(t, passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'Немає тестової черги.', sources: [{ ...ran, ref: 'the test cabinet' }] }] }), /item p2 is a place kept: its live check's "ref" is the log that check wrote/);
  await refusedAs(t, passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'Немає тестової черги.', sources: [ran] }] }), /the log work\/tickets\/2601\/queue-check\.txt is not there/);
  fs.mkdirSync(path.join(t.w.root, 'work/tickets/2601'), { recursive: true });
  fs.writeFileSync(path.join(t.w.root, 'work/tickets/2601/queue-check.txt'), 'POST /v1/orders → 201; after 15 min the order is still OPEN\n');
  await passDone(t, { items: [fromTicket, { id: 'p2', outcome: 'kept', why: 'Тестову чергу створено, але таймер спрацьовує лише на робочому середовищі.', sources: [{ kind: 'live', ref: 'work/tickets/2601/queue-check.txt', result: 'замовлення не закрилось за 15 хв', setup: 'створено чергу обробки на тестовому акаунті власника' }, { kind: 'code', ref: 'ledger-api queues.go L40', result: 'таймер 10 хв' }] }] });
  const lines = prLinesAfterPass([read(t.w, '2601')], t.w.settings).join('\n');
  assert.match(lines, /- p1 answered: Повернення доступне лише для статусу NEW/);
  assert.match(lines, /- p2 \(place\): .*why: Тестову чергу створено/);
  const m = readMisses(t.w.settings.state);
  assert.deepEqual(m.map((x) => [x.item.id, x.source.kind, x.source.ref]), [['p1', 'ticket', '2480/api-check.md']]);
});

test('replay, a state no screen gives, reached through a backend route (AC-4): the plan holds its question instead of asking it, the pass answers it with the live check\'s log and the route in the code, the card never goes to Blocked, and the plan goes on with the answer', async () => {
  const c = card({ number: 2701, status: 'inProgress', labels: ['Api'] });
  const w = world({ cards: [c], extra: { companyRepos: COMPANY, appRepos: [{ repo: 'ledger-api', url: 'https://code.example/acme/ledger-api' }], workFolder: 'work/tickets/<key>' } });
  ledger(w, c, { key: '2701', stages: { triage: 'done', start: 'done' }, startedBy: 'schedule', triage: { verdict: 'docs-required', targets: ['api'], size: 'edit' } });
  const sha = codeClone(w.settings, 'ledger-api', { 'routes/console.go': 'r.PATCH("/api/v2/console/order/:id/claim", setClaimStatus)\n' });
  const question = { id: 'q1', kind: 'fact', text: 'The create and the read pages describe `reason` and the reasons tables, but the API returns no `reason` to the partner: update the tables, or remove `reason` from both pages?', sources: [{ kind: 'code', ref: 'ledger-api claims.go', result: 'reason hidden for the partner' }, { kind: 'api', ref: 'work/tickets/2701/api-check.md §5', result: 'a finished claim not reached: the console hides Finish and Reject for NEW claims' }] };
  const seen = [];
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    seen.push({ stage, brief: briefOf(cmd) });
    const at = (k) => runRecord({ settings: w.settings, clients: w.clients(), now: NOW, key: '2701', ...k });
    if (stage === 'plan' && seen.filter((x) => x.stage === 'plan').length === 1) {
      // A plain question would refuse here: the card is In progress, the plan holds it instead.
      await at({ stage: 'questions', status: 'done', result: { hold: true, from: 'plan', questions: [question] } });
    } else if (stage === 'answerPass') {
      fs.mkdirSync(path.join(w.root, 'work/tickets/2701'), { recursive: true });
      fs.writeFileSync(path.join(w.root, 'work/tickets/2701/api-check.md'), '## §6 A finished claim\n\nPATCH /api/v2/console/order/:id/claim {"Status":"CANCELED"} → 200\nGET /v1/order/:id/claim → 200, no "reason" key\n');
      await at({ stage: 'answerPass', status: 'done', result: { items: [{ id: 'c1', outcome: 'answered', answer: 'Remove `reason` and the reasons tables: a finished claim read through the client API has no such key.', evidence: [{ kind: 'live', log: 'work/tickets/2701/api-check.md', setup: "the test claim finished through the backend route the console calls, with the test admin account the host's rules name" }, { kind: 'code', repo: 'ledger-api', path: 'routes/console.go', lines: '1', commit: sha }] }] } });
    } else return { code: 1, stdout: '', stderr: 'stop' };
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const ensureCodeTree = (s, app) => ({ repo: app.repo, path: path.join(s.state, 'code', app.repo, 'c0ffee1c0ffe'), commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff', url: app.url, notes: [], removed: [], kept: [] });
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude, ensureCodeTree, ticketCommits: (dir, key) => ({ key, more: false, commits: [] }) }, options: { named: ['2701'] } });
  assert.deepEqual(seen.slice(0, 3).map((x) => x.stage), ['plan', 'answerPass', 'plan']);
  // The plan's brief says to hold; the pass's frames the held question; the plan again gets the answer.
  assert.match(seen[0].brief, /Hold it instead, with its `kind` one of fact, code, behaviour, text .*--stage questions --status done --result '\{ "hold": true, "from": "plan"/);
  assert.match(seen[1].brief, /on the questions the plan or the write held instead of asking them on the card/);
  assert.match(seen[1].brief, /\*\*c1\*\* \(a question the plan held\): The create and the read pages describe/);
  assert.match(seen[2].brief, /The answer pass answered the questions 2701's plan held/);
  assert.match(seen[2].brief, /c1: .* → Remove `reason` and the reasons tables/);
  const l = read(w, '2701');
  assert.equal(c.placeId, LISTS.inProgress.id, 'the card never went to Blocked');
  assert.equal(l.stages.questions, undefined, 'nothing was asked on the card');
  assert.deepEqual(l.questions.map((q) => [q.id, q.answer?.by]), [['c1', 'answerPass']]);
  assert.deepEqual(readMisses(w.settings.state).map((x) => [x.item.id, x.source.kind, x.settledBy, x.missedBy]), [['c1', 'live', 'answerPass', 'plan']]);
  // The same question held again after the pass answered it: refused, the plan uses the answer.
  await assert.rejects(runRecord({ settings: w.settings, clients: w.clients(), now: NOW, key: '2701', stage: 'questions', status: 'done', result: { hold: true, from: 'plan', questions: [{ kind: 'fact', text: question.text }] } }), (e) => e.refused === 'answers' && /the answer pass answered it already \(c1\)/.test(e.message));
  // The company repos have their own heading in the pass's brief.
  assert.match(seen[1].brief, /Company repos \(the host's `companyRepos`/);
  assert.ok(seen[1].brief.indexOf('- cabinet-web:') > seen[1].brief.indexOf('Company repos'));
  // A fit stop is the stage's own: never held.
  await assert.rejects(runRecord({ settings: w.settings, clients: w.clients(), now: NOW, key: '2701', stage: 'questions', status: 'done', result: { hold: true, from: 'plan', questions: [{ kind: 'fit', text: 'The table lists cards: add a row?' }] } }), (e) => e.exitCode === 2 && /a "fit" question is the stage's own/.test(e.message));
});

test('a held question the pass can\'t answer is asked on the card in its session: the record needs that comment and the card in Blocked, and the ticket waits for the answer', async () => {
  const c = card({ number: 2702, status: 'inProgress' });
  const w = world({ cards: [c], extra: { companyRepos: COMPANY } });
  ledger(w, c, { key: '2702', stages: { triage: 'done', start: 'done' } });
  await rec(w, { key: '2702', stage: 'questions', status: 'done', result: { hold: true, from: 'plan', questions: [{ kind: 'fact', text: 'Which fee applies to a partial refund?' }] } });
  assert.equal((await w.one('2702')).next.stage, 'answerPass');
  await rec(w, { key: '2702', stage: 'answerPass', status: 'running', result: { input: (await import('../lib/answer-pass.mjs')).heldInput(read(w, '2702')) } });
  const kept = { items: [{ id: 'c1', outcome: 'kept', why: 'No code or page names the fee for a partial refund.', sources: [{ kind: 'code', ref: 'ledger-api, fees/', result: 'one fee for full refunds only' }] }] };
  await assert.rejects(rec(w, { key: '2702', stage: 'answerPass', status: 'done', result: kept }), (e) => e.refused === 'answers' && /ask them on the card in one comment/.test(e.message));
  await assert.rejects(rec(w, { key: '2702', stage: 'answerPass', status: 'done', result: { ...kept, asked: { commentId: 'cm-9' } } }), (e) => e.refused === 'card');
  c.placeId = LISTS.blocked.id;
  await rec(w, { key: '2702', stage: 'answerPass', status: 'done', result: { ...kept, asked: { commentId: 'cm-9' } } });
  const l = read(w, '2702');
  assert.equal(l.stage, 'questions');
  assert.deepEqual(l.stages.questions.result.questions.map((q) => [q.id, q.commentId]), [['c1', 'cm-9']]);
  const t = await w.one('2702');
  assert.equal(t.state, 'questions');
});

test('the runner: a round\'s held questions get the pass on the PR, with its items, its numbering and the PR\'s worktree', async () => {
  const c = card({ number: 2801, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 51, head: 'ticket-2801', headCommit: 'b'.repeat(40) })], extra: { companyRepos: COMPANY, forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: true } } });
  ledger(w, c, { key: '2801', stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', answerPass: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', branch: 'ticket-2801', number: 51, targets: ['guide'], review: 'sme', stage: 'finalReview', edits: [{ n: 1, list: 'description', page: 'docs/a.md', before: 'a', after: 'b' }], questions: [{ n: 1, text: 'Does the widget retry?', reader: 'developer', stage: 'answerComments', held: true }], answerPassDue: { seq: 6, at: ago(1), stage: 'answerComments' } }] });
  const briefs = [];
  let frozen = null;
  const spawnClaude = async (cmd) => {
    briefs.push(briefOf(cmd));
    frozen = read(w, '2801').prs[0].answerInput?.items.map((x) => x.id) ?? null;
    return { code: 1, stdout: '', stderr: 'stop' };
  };
  const ensureCodeTree = (s, app) => ({ repo: app.repo, path: path.join(s.state, 'code', app.repo, 'c0ffee1c0ffe'), commit: 'c'.repeat(40), url: app.url, notes: [] });
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude, ensureCodeTree, ensureWorktree: noTree, ticketCommits: (dir, key) => ({ key, more: false, commits: [] }) }, options: { named: ['2801'] } });
  assert.ok(briefs.length);
  assert.match(briefs[0], /Stage `answerPass` of ticket 2801 \(group 2801\), PR guide-docs#51/);
  assert.match(briefs[0], /\*\*d1\*\* \(a question asked at answerComments, for developer\): Does the widget retry\?/);
  assert.match(briefs[0], /Number the edits you record on this PR from 2/);
  assert.match(briefs[0], /- pay-widget: /);
  assert.deepEqual(frozen, ['d1']);
});

test('the runner: with nothing left open, the pass is recorded done with no item, before any repo is resolved or checked out, and no session runs', async () => {
  const t = passWorld({ key: '2802', company: { org: 'acme' } });
  apiClone(t.w).push({ 'docs/a.md': '# Сторінка\n\nАбзац.\n' }, 'draft');
  const touched = [];
  const io = {
    readUsage: usage,
    now: () => NOW,
    spawnClaude: async () => (touched.push('session'), { code: 1, stdout: '', stderr: 'stop' }),
    ensureCodeTree: (s, app) => (touched.push(`checkout ${app.repo}`), { repo: app.repo, path: '/x', commit: 'c'.repeat(40), url: app.url, notes: [] }),
    ghRepoList: () => (touched.push('gh'), []),
    ticketCommits: (dir, key) => ({ key, more: false, commits: [] }),
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io, options: { named: ['2802'] } });
  const l = read(t.w, '2802');
  assert.equal(l.stages.answerPass.status, 'done');
  assert.deepEqual(l.stages.answerPass.result.items, []);
  // The org was never listed and no company repo checked out; the session that ran is the PR's, after the pass.
  assert.ok(!touched.includes('gh'), touched.join(', '));
  assert.deepEqual(touched.filter((x) => /^checkout/.test(x)), ['checkout ledger-api'], 'only the PR step\'s own code repo');
  assert.deepEqual(out.ran.slice(0, 2).map((r) => [r.stage, r.outcome]), [['answerPass', 'done'], ['pr', 'failed']]);
  assert.match(out.ran[0].note, /nothing was left open: the pass is done with no item, and no session/);
  assert.equal(l.runs.find((r) => r.stage === 'answerPass')?.session, null);
});

test('a group\'s pass: each item says its ticket, since each ticket numbers its items from 1', () => {
  const w = world({ extra: { companyRepos: COMPANY } });
  const lines = passLines({ stage: 'answerPass', keys: ['2901', '2902'], answerItems: [{ id: 'q1', kind: 'question', from: 'write', text: 'Which limit?', ticket: '2901' }, { id: 'q1', kind: 'question', from: 'write', text: 'Which fee?', ticket: '2902' }] }, w.settings).join('\n');
  assert.match(lines, /answer each by its id, in its own ticket's record/);
  assert.match(lines, /- \*\*q1\*\* of ticket 2901 \(a question the write left\): Which limit\?/);
  assert.match(lines, /- \*\*q1\*\* of ticket 2902 \(a question the write left\): Which fee\?/);
});

test('the gate reads a partial clone\'s trees, never its blobs: a code reference checks with the clone\'s origin gone', () => {
  const src = path.join(tmp('src-'), 'cabinet-web');
  const g = gitRepo(src);
  const sha = g.commit({ 'src/archive/columns.tsx': 'export const amount = 1;\n' }, 'feat: columns');
  g.g('config', 'uploadpack.allowFilter', 'true');
  const clone = path.join(tmp('clone-'), 'cabinet-web.git');
  execFileSync('git', ['clone', '-q', '--bare', '--filter=blob:none', `file://${src}`, clone], { stdio: 'ignore' });
  fs.rmSync(src, { recursive: true, force: true });
  assert.equal(blobAt(clone, sha, 'src/archive/columns.tsx'), true);
  assert.equal(blobAt(clone, sha, './src/archive/columns.tsx'), true);
  assert.equal(blobAt(clone, sha, 'src/archive'), false, 'a folder is no file');
  assert.equal(blobAt(clone, sha, 'src/none.tsx'), false);
  assert.equal(blobAt(clone, 'f'.repeat(40), 'src/archive/columns.tsx'), false);
});

test('a brief never shows a user or a token in a repo\'s address', () => {
  assert.equal(safeUrl('https://x-access-token:ghp_abc@code.example/acme/a'), 'https://code.example/acme/a');
  assert.equal(safeUrl('https://code.example/acme/a'), 'https://code.example/acme/a');
  const lines = codeLines([{ repo: 'ledger-api', path: '/x', commit: 'c'.repeat(40), url: 'https://tok@code.example/acme/ledger-api' }]);
  assert.ok(!lines.includes('tok@'), lines);
});

test('the report shows the week\'s answers on the day they were made', () => {
  const w = world();
  const st = { mode: 'on', wip: { inProgress: 0, waiting: 0, limits: { inProgress: 3, waiting: 5 } }, allowance: null, tickets: [], startable: [], notStarted: [], notTickets: [], intake: { due: [] } };
  const week = { at: new Date(NOW).toISOString(), since: new Date(NOW - 7 * 86400000).toISOString(), groups: [], proposals: [], measures: [{ ticket: '9', left: 2, answered: 1, confirmed: 0, kept: 1, reachedOwner: 1 }] };
  const text = renderReport({ settings: w.settings, st, date: '2026-11-10', answers: week, ledgers: [] });
  assert.match(text, /- 9: left 2, answered 1, confirmed 0, reached the owner 1/);
  assert.ok(!renderReport({ settings: w.settings, st, date: '2026-11-10', ledgers: [] }).includes('Answers and misses'));
});
