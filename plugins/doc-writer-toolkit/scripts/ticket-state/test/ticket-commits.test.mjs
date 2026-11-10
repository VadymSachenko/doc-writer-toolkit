import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, card, rawSettings, tmp } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { validateSettings } from '../lib/settings.mjs';
import { DEFAULT_PATTERN, FILES_SHOWN, keyRegex, ticketCommits, ticketCommitsFor } from '../lib/ticket-commits.mjs';
import { briefFor, codeLines, commandFor, runDaily } from '../lib/runner.mjs';
import { codeTreePath, codeTreesRoot } from '../lib/worktree.mjs';
import { parseUsage } from '../lib/allowance.mjs';

// The org's other repos as evidence (`relatedRepos`) and the ticket's commits (lib/ticket-commits.mjs): scripted with no
// model, in the runner's read-only checkouts, into the writer's brief.

const usage = () => parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];

// A repo whose commits have fixed dates and authors, so the lines don't move with the clock.
function history() {
  const dir = path.join(tmp('ticket-commits-'), 'code-repo');
  fs.mkdirSync(dir, { recursive: true });
  const env = (n, who = 'Dev One') => ({ ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: 'dev@example.com', GIT_AUTHOR_DATE: `2026-10-${String(n).padStart(2, '0')}T12:00:00Z`, GIT_COMMITTER_DATE: `2026-10-${String(n).padStart(2, '0')}T12:00:00Z` });
  const g = (args, n, who) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env(n, who) }).trim();
  g(['init', '-q', '-b', 'main'], 1);
  let n = 0;
  const commit = (message, files = { [`f${n}.txt`]: String(n) }, who) => {
    n += 1;
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    g(['add', '-A'], Math.min(n, 28), who);
    g(['commit', '-q', '-m', message], Math.min(n, 28), who);
    return g(['rev-parse', 'HEAD'], 1);
  };
  return { dir, commit };
}

test('the lookup: the commits whose message names the key as a whole word, newest first, with their files; none, and the others, are left out', () => {
  const h = history();
  const a = h.commit('feat-1157 add url to update cardDetails', { 'api/routes.go': 'r', 'api/card.go': 'c' });
  h.commit('unrelated change', { 'x.go': 'x' });
  h.commit('fix-11570 a different ticket', { 'y.go': 'y' });
  h.commit('ticket a1157 is not it either', { 'z.go': 'z' });
  const b = h.commit('queue: skip without the card number\n\nRefs #1157', { 'queue/skip.go': 's' }, 'Dev Two');
  const c = h.commit('1157: the last one', { 'w.go': 'w' });
  const r = ticketCommits(h.dir, '1157');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.commits.map((x) => x.sha), [c, b, a]);
  assert.deepEqual(r.commits[1], { sha: b, date: '2026-10-05', author: 'Dev Two', subject: 'queue: skip without the card number', files: ['queue/skip.go'] }, 'the key in the body counts; the subject is the first line');
  assert.deepEqual(r.commits[2].files.sort(), ['api/card.go', 'api/routes.go']);
  assert.equal(r.more, false);
  assert.deepEqual(ticketCommits(h.dir, '4242').commits, [], 'no commit names it');
  // From an earlier commit: only its history.
  assert.deepEqual(ticketCommits(h.dir, '1157', { commit: a }).commits.map((x) => x.sha), [a]);
});

test('the whole-word rule: feat-, fix-, # and the bare key match, any case; a longer number or word does not', () => {
  const re = keyRegex('1157');
  for (const m of ['feat-1157 x', 'fix-1157', 'Refs #1157.', '1157', '(1157)', 'FEAT-1157']) assert.ok(re.test(m), m);
  for (const m of ['11570', '21157', 'a1157', '1157b', '1157_x', 'feat_1157']) assert.ok(!re.test(m), m);
  assert.ok(keyRegex('aB3-x').test('fix-ab3-x done'), 'a short link, escaped, any case');
  assert.ok(!keyRegex('a.b').test('axb'), 'the key is escaped');
  assert.ok(DEFAULT_PATTERN.includes('<key>'));
  // A host pattern: only `feat-<key>`.
  const h = history();
  h.commit('feat-77 yes');
  h.commit('#77 not with this pattern');
  assert.deepEqual(ticketCommits(h.dir, '77', { pattern: '\\bfeat-<key>\\b' }).commits.map((x) => x.subject), ['feat-77 yes']);
});

test('the bound: at most the limit per repo, the newest, and `more` says there were others; files past the shown few are counted', () => {
  const h = history();
  const shas = [];
  for (let i = 0; i < 25; i += 1) shas.push(h.commit(`feat-900 step ${i}`));
  const r = ticketCommits(h.dir, '900', { limit: 20 });
  assert.equal(r.commits.length, 20);
  assert.equal(r.more, true);
  assert.deepEqual(r.commits.map((x) => x.sha), shas.slice(5).reverse());
  // Substring hits don't eat the bound: the pattern picks before the limit.
  const h2 = history();
  const mine = h2.commit('feat-55 mine');
  for (let i = 0; i < 5; i += 1) h2.commit(`feat-5500 other ${i}`);
  assert.deepEqual(ticketCommits(h2.dir, '55', { limit: 1 }).commits.map((x) => x.sha), [mine]);
  // A commit with many files: the brief shows a few and how many more.
  const many = Object.fromEntries(Array.from({ length: FILES_SHOWN + 3 }, (_, i) => [`m/${String(i).padStart(2, '0')}.go`, 'x']));
  const h3 = history();
  h3.commit('feat-1 many files', many);
  const t = { repo: 'code-repo', path: h3.dir, commit: 'HEAD' };
  const brief = codeLines(ticketCommitsFor([t], ['1']).map((x) => ({ ...t, ticket: x.keys })));
  assert.match(brief, new RegExp(`m/09\\.go, and 3 more\\)`));
  assert.ok(!brief.includes('m/10.go'));
});

test('a git error is a note, never a throw: no repo there, a bad commit', () => {
  const none = ticketCommits(path.join(tmp(), 'nothing'), '1157');
  assert.deepEqual(none.commits, []);
  assert.match(none.error, /git log/);
  const h = history();
  h.commit('feat-1 x');
  assert.match(ticketCommits(h.dir, '1', { commit: 'f'.repeat(40) }).error, /git log/);
  const per = ticketCommitsFor([{ repo: 'r', path: h.dir, commit: 'HEAD' }], ['1'], { lookup: () => { throw new Error('boom'); } });
  assert.deepEqual(per[0].keys, [{ key: '1', commits: [], more: false, error: 'boom' }]);
  const brief = codeLines([{ repo: 'r', path: h.dir, commit: 'c0ffee1', ticket: per[0].keys }]);
  assert.match(brief, /- r, 1: not searched \(boom\)/);
  // A checkout that couldn't be made isn't searched (its own line says so).
  assert.deepEqual(ticketCommitsFor([{ repo: 'gone', error: 'could not clone' }], ['1']), []);
});

test('a group: a commit that names two keys is listed once, under the first', () => {
  const h = history();
  const both = h.commit('feat-10 feat-11 together');
  const only = h.commit('feat-11 alone');
  const [r] = ticketCommitsFor([{ repo: 'r', path: h.dir, commit: 'HEAD' }], ['10', '11']);
  assert.deepEqual(r.keys.map((k) => [k.key, k.commits.map((c) => c.sha)]), [['10', [both]], ['11', [only]]]);
});

// ------------------------------------------------------------------ the brief

const tree = (repo, extra = {}) => ({ repo, path: `/state/code/${repo}/c0ffee1c0ffe`, commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff', url: `https://code.example/org/${repo}`, notes: [], ...extra });
const found = [{ key: '1157', more: false, commits: [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', date: '2026-10-02', author: 'Dev One', subject: "feat-1157 don't take inbound without the card number", files: ['queue/skip.go'] }] }];

test('the brief: the code repos alone read as before; related repos get their own lines; the ticket\'s commits get theirs', () => {
  const before = [
    'Code repos, each a read-only checkout at the commit the runner fetched for this session. Read code only here, with Read and Grep, never in a clone, whose files may be weeks old (Read and Grep are denied there). A fact from the code carries its reference when you read it: repo, path, lines and the commit below.',
    `- backend: /state/code/backend/c0ffee1c0ffe, commit ${tree('backend').commit}; a link to lines: https://code.example/org/backend/blob/${tree('backend').commit}/<path>#L<from>-L<to>.`,
    '- other: not available (could not clone other). A fact only this code could answer stays a marker.',
  ].join('\n');
  assert.equal(codeLines([tree('backend'), { repo: 'other', error: 'could not clone other' }]), before, 'no related repo, no commits: the lines as they were');

  const withCommits = codeLines([tree('backend', { ticket: found })]);
  assert.ok(withCommits.startsWith(before.split('\n').slice(0, 2).join('\n')));
  assert.match(withCommits, /The ticket's commits:/);
  assert.match(withCommits, /- backend, 1157: 1\n {2}- abcdef123456 2026-10-02 Dev One: feat-1157 don't take inbound without the card number \(queue\/skip\.go\)/);
  assert.match(withCommits, /a place's `why` names the sources tried/);
  assert.match(withCommits, /cites the commit that shows the behaviour/);
  assert.ok(!withCommits.includes('Related repos'));
  assert.match(codeLines([tree('backend', { ticket: [{ key: '1157', commits: [], more: false }] })]), /- backend, 1157: no commit's message names it\./);

  const related = codeLines([tree('backend', { ticket: found }), tree('widget', { related: true, ticket: [{ key: '1157', commits: [], more: false }] }), { repo: 'proxy', related: true, error: 'could not clone proxy' }]);
  assert.match(related, /Related repos \(the host's `relatedRepos`/);
  assert.match(related, /search these for it .* before you mark a place or ask a question/);
  assert.match(related, /- widget: \/state\/code\/widget\/c0ffee1c0ffe, commit c0ffee1/);
  assert.match(related, /- proxy: not available \(could not clone proxy\)\. Say so in a place's `why`/);
  assert.match(related, /- widget, 1157: no commit's message names it\./);
  assert.ok(related.indexOf('Related repos') > related.indexOf('Code repos') && related.indexOf("The ticket's commits") > related.indexOf('Related repos'));
  // Related repos only: no code repos heading.
  const alone = codeLines([tree('widget', { related: true })]);
  assert.ok(!alone.includes('Code repos,'));
  assert.match(alone, /whose caller or implementation you can't see/);
});

// ------------------------------------------------------------------ settings

test('settings: relatedRepos takes the shape of appRepos, a name in both lists is refused; ticketCommits is checked', () => {
  const root = tmp();
  const v = (extra) => validateSettings(rawSettings(extra), { root, stateRootDefault: '.x/' });
  const bad = (extra, re) => assert.throws(() => v(extra), re);
  const d = v({});
  assert.deepEqual([d.relatedRepos, d.ticketCommits], [[], { pattern: null, limit: 20 }], 'unset: none, and the default lookup');
  assert.deepEqual(v({ relatedRepos: [{ repo: 'widget', url: 'https://code.example/org/widget/', base: 'develop' }] }).relatedRepos, [{ repo: 'widget', path: null, base: 'develop', url: 'https://code.example/org/widget' }]);
  bad({ relatedRepos: { repo: 'widget' } }, /relatedRepos must be a list/);
  bad({ relatedRepos: [{ repo: 'widget' }] }, /relatedRepos\[0\]\.url is required/);
  bad({ relatedRepos: [{ repo: 'a/b', url: 'https://code.example/org/b' }] }, /relatedRepos\[0\]\.repo must be the repo's plain name/);
  bad({ relatedRepos: [{ repo: 'w', url: 'https://code.example/org/w', path: '' }] }, /relatedRepos\[0\]\.path must be the owner's clone/);
  bad({ appRepos: [{ repo: 'code', url: 'https://code.example/org/code' }], relatedRepos: [{ repo: 'code', url: 'https://code.example/org/code' }] }, /'code' is named twice/);
  bad({ relatedRepos: [{ repo: 'w', url: 'https://code.example/org/w' }, { repo: 'w', url: 'https://code.example/org/w2' }] }, /'w' is named twice/);
  assert.deepEqual(v({ ticketCommits: { pattern: '\\b(feat|fix)-<key>\\b', limit: 5 } }).ticketCommits, { pattern: '\\b(feat|fix)-<key>\\b', limit: 5 });
  assert.deepEqual(v({ ticketCommits: { limit: 3 } }).ticketCommits, { pattern: null, limit: 3 });
  bad({ ticketCommits: 'feat-<key>' }, /ticketCommits must be/);
  bad({ ticketCommits: { pattern: 'feat-only' } }, /ticketCommits.pattern must be a regular expression with <key>/);
  bad({ ticketCommits: { pattern: '(<key>' } }, /ticketCommits.pattern is not a regular expression/);
  for (const limit of [0, 101, 2.5, '20']) bad({ ticketCommits: { limit } }, /ticketCommits.limit must be a whole number from 1 to 100/);
  // The video's sign-in folder stays out of a related repo's owner's clone, as out of a code repo's.
  bad({ relatedRepos: [{ repo: 'w', url: 'https://code.example/org/w', path: 'repos/w' }], video: { browserProfile: path.join(root, 'repos/w/profile') } }, /video.browserProfile must be outside/);
});

test('a related repo\'s checkout is an added folder with the git reads, and its owner\'s clone is denied like a code repo\'s', () => {
  const w = world();
  w.settings.relatedRepos = [{ repo: 'widget', path: 'repos/widget', base: 'main', url: 'https://code.example/org/widget' }];
  const clone = path.join(w.settings.root, 'repos/widget');
  const at = codeTreePath(w.settings, w.settings.relatedRepos[0], 'c0ffee1');
  const step = { stage: 'plan', role: 'writer', keys: ['1'], group: '1', codeTrees: [{ repo: 'widget', related: true, path: at, commit: 'c0ffee1', url: 'https://code.example/org/widget', notes: [] }] };
  const cmd = commandFor(step, w.settings, { model: 'm', agentsPath: '/a.json', roots: [] });
  const after = (flag) => cmd.args.slice(cmd.args.indexOf(flag) + 1);
  assert.ok(cmd.args.includes(at));
  assert.ok(after('--allowedTools').includes(`Bash(git -C ${at} log:*)`));
  assert.ok(after('--disallowedTools').includes(`Read(//${clone.replace(/^\/+/, '')}/**)`), 'the owner\'s clone is denied');
  assert.ok(after('--disallowedTools').includes(`Edit(//${codeTreesRoot(w.settings).replace(/^\/+/, '')}/**)`), 'the checkouts are read only, with no appRepos too');
  assert.match(briefOf(cmd), /Related repos/);
});

// ------------------------------------------------------------------ the runner

async function planRun({ related = [], lookup } = {}) {
  const c = card({ number: 502, status: 'inProgress', labels: ['Guide'] });
  const w = world({ cards: [c], extra: { limits: { estimates: { edit: 4, newPage: 8 } } } });
  // A ticket in planning: its next step is the plan.
  ledger(w, c, { stages: { triage: 'done', start: 'done' }, startedBy: 'schedule', triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  w.settings.appRepos = [{ repo: 'backend', path: null, base: 'main', url: 'https://code.example/org/backend' }];
  w.settings.relatedRepos = related;
  const asked = [];
  const ensureCodeTree = (s, app) => {
    asked.push(app.repo);
    return { repo: app.repo, path: path.join(s.state, 'code', app.repo, 'c0ffee1c0ffe'), commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff', url: app.url, notes: [], removed: [], kept: [] };
  };
  const searched = [];
  const ticketCommits = lookup ?? ((dir, key) => {
    searched.push([path.basename(path.dirname(dir)), key]);
    return { key, more: false, commits: path.basename(path.dirname(dir)) === 'backend' ? found[0].commits : [] };
  });
  const briefs = [];
  const spawnClaude = async (cmd) => {
    briefs.push(briefOf(cmd));
    return { code: 1, stdout: '', stderr: 'stop' };
  };
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude, ensureCodeTree, ticketCommits }, options: { named: ['502'] } });
  return { asked, searched, briefs };
}

test('the runner: related repos get checkouts like the code repos, and the ticket\'s commits are looked up in each before the plan', async () => {
  const r = await planRun({ related: [{ repo: 'widget', path: null, base: 'main', url: 'https://code.example/org/widget' }] });
  assert.ok(r.briefs.length > 0, 'a plan session ran');
  assert.ok(/Stage `plan`/.test(r.briefs[0]), r.briefs[0].slice(0, 80));
  assert.deepEqual([...new Set(r.asked)], ['backend', 'widget']);
  assert.deepEqual([...new Set(r.searched.map((x) => x.join(' ')))], ['backend 502', 'widget 502']);
  assert.match(r.briefs[0], /Related repos/);
  assert.match(r.briefs[0], /- widget: .*code\/widget\/c0ffee1c0ffe/);
  assert.match(r.briefs[0], /- backend, 502: 1\n {2}- abcdef123456/);
  assert.match(r.briefs[0], /- widget, 502: no commit's message names it\./);
});

test('the runner, relatedRepos unset: only the code repos, as before, plus the ticket\'s commits in them; a lookup that throws stops nothing', async () => {
  const r = await planRun();
  assert.deepEqual([...new Set(r.asked)], ['backend']);
  assert.deepEqual([...new Set(r.searched.map((x) => x.join(' ')))], ['backend 502']);
  const brief = r.briefs[0];
  assert.ok(!brief.includes('Related repos'));
  // Without the commit lines, the brief is the one the code repos alone give.
  const cut = brief.split('\n').filter((l) => !l.startsWith("The ticket's commits:") && !/^- backend, 502:/.test(l) && !/^ {2}- abcdef123456/.test(l)).join('\n');
  assert.ok(cut.includes(codeLines([{ repo: 'backend', path: brief.match(/- backend: (\S+),/)[1], commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff', url: 'https://code.example/org/backend', notes: [] }])));
  const thrown = await planRun({ lookup: () => { throw new Error('git is gone'); } });
  assert.ok(thrown.briefs.length > 0, 'the session still starts');
  assert.match(thrown.briefs[0], /- backend, 502: not searched \(git is gone\)/);
});

test('a reviewer\'s brief gets the related repos but no commit lookup', () => {
  const w = world();
  const step = { stage: 'enReview', role: 'reviewer', keys: ['1'], group: '1', pr: 'x#1', worktrees: [], codeTrees: [tree('backend'), tree('widget', { related: true })] };
  const brief = briefFor(step, w.settings);
  assert.match(brief, /Related repos/);
  assert.ok(!brief.includes("The ticket's commits"));
});
