import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, ago, card, gitRepo, pr, quietGit, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { commandFor, runDaily, scriptedCalls } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { ensureWorktree, pushMerge, worktreePath } from '../lib/worktree.mjs';
import { makeGit } from '../lib/world.mjs';
import { HOOK_VARIABLE, refusalOf } from '../lib/role-hook.mjs';
import { CI_GRACE_MS } from '../lib/rule.mjs';
import { notReadyYet } from '../lib/ledger.mjs';
import { gatesOf } from '../lib/progress.mjs';
import { emptyFeed, sourcesOf, writeFeed } from '../lib/feed.mjs';
import { runCheck } from '../lib/watch.mjs';
import { localDate, renderReport } from '../lib/report.mjs';
import { finishRank } from '../lib/stages.mjs';

// Keeping each pipeline PR up to date with its base (`forge.keepFresh`, D-113, D-127): from ready for merge on, the
// runner merges the base into the branch with no model whenever the base moved, CI runs again on the new head, and a
// conflict goes back to a session that resolves it. Never in the owner's queue. Real git: a bare origin, the target
// clone and a second clone standing in for the other PRs merged into the base.

const usage = () => parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];
const EN = 'i18n/en/docusaurus-plugin-content-docs/current';
const PAGE = 'docs/x/index.md';
const EN_PAGE = `${EN}/x/index.md`;
const READY = 'Ready to merge';
const PAGE_V0 = '# Сторінка\n\nПерший абзац.\n\nДругий абзац.\n\nТретій абзац.\n';
const noSession = async () => assert.fail('no claude session for a merge of the base');
const stageOf = (cmd) => /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const forgeWith = (extra = {}) => ({ forge: { ...rawSettings().forge, readyLabel: READY, ...extra } });

// The target clone at `repos/guide-docs` with a bare origin: `main` holds the page and its EN, the ticket branch changes
// the page's first paragraph and its EN. `baseMoves` merges another change into `main`, as another PR's merge does.
function withClone(w) {
  const bare = path.join(tmp('origin-'), 'guide-docs.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'guide-docs'));
  clone.commit({
    '.gitignore': 'node_modules/\n.env\n.sources/\nbuild/\n',
    'CLAUDE.md': '# Site\n\n## Documentation toolkit configuration\n\n- **UA content root:** `docs/`\n' + `- **EN i18n root:** \`${EN}/\`\n`,
    'docusaurus.config.ts': "export default { i18n: { defaultLocale: 'uk', locales: ['uk', 'en'] } };\n",
    [PAGE]: PAGE_V0,
    [EN_PAGE]: '# Page\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n',
    'docs/y/other.md': '# Інша\n',
  }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  clone.g('fetch', '-q', 'origin');
  clone.g('checkout', '-q', '-b', 'ticket-71');
  const h1 = clone.commit({ [PAGE]: PAGE_V0.replace('Перший абзац.', 'Перший абзац, змінений.'), [EN_PAGE]: '# Page\n\nFirst paragraph, changed.\n\nSecond paragraph.\n\nThird paragraph.\n' }, 'Draft: page');
  clone.g('push', '-q', 'origin', 'ticket-71');
  clone.g('checkout', '-q', 'main');
  const other = path.join(tmp('other-'), 'guide-docs');
  execFileSync('git', ['clone', '-q', bare, other]);
  git(other, 'config', 'user.email', 'other@example.com');
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'commit.gpgsign', 'false');
  const baseMoves = (files) => {
    git(other, 'checkout', '-q', 'main');
    git(other, 'pull', '-q', '--ff-only', 'origin', 'main');
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(other, rel)), { recursive: true });
      fs.writeFileSync(path.join(other, rel), text);
    }
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'Another PR, merged');
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { clone, bare, h1, baseMoves, branchHead: () => git(bare, 'rev-parse', 'refs/heads/ticket-71') };
}

// A ticket whose one PR is at `stage` (ready for merge by default) at the branch's head, every chain stage done there.
function freshTicket({ stage = 'readyForMerge', keepFresh = true, labels } = {}) {
  const c = card({ number: 1501, status: stage === 'translation' ? 'translation' : 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 71, head: 'ticket-71', labels: labels ?? (stage === 'readyForMerge' ? ['In final review', READY] : ['In final review']) });
  const w = world({ cards: [c], prs: [forgePr], extra: forgeWith(keepFresh ? { keepFresh: true } : {}) });
  const fx = withClone(w);
  forgePr.headCommit = fx.h1;
  const chain = Object.fromEntries(CHAIN.map((s, i) => [s, { status: 'done', head: fx.h1, seq: 10 + i }]));
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 71, targets: ['guide'], review: 'sme', branch: 'ticket-71', base: 'main', stage, pipelineCommits: [fx.h1], chain, approval: { head: fx.h1, at: ago(3), by: 'person' }, ...(stage === 'readyForMerge' ? { readyForMerge: [{ head: fx.h1, at: ago(2), seq: 5 }] } : {}) }] });
  // The forge's view follows the runner's push, as GitHub's does.
  const io = { readUsage: usage, now: () => NOW, spawnClaude: noSession, pushMerge: (wt, a) => {
    const r = pushMerge(wt, a);
    if (r.ok) forgePr.headCommit = git(wt, 'rev-parse', 'HEAD');
    return r;
  } };
  const status = async () => (await w.status({ git: makeGit(w.settings) })).tickets.find((t) => t.key === '1501');
  const run = (extra = {}, options = {}) => runDaily({ settings: w.settings, clients: w.clients(), io: { ...io, ...extra }, options: { trigger: 'watcher', named: ['1501'], ...options } });
  return { w, c, forgePr, ...fx, status, run, wt: worktreePath(w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71' }) };
}

const green = (commit) => ({ commit, state: 'success', failing: [], pending: [] });

test('off by default: a ready PR whose base moved is left as it is, and no PR view says how far behind it is', async () => {
  const t = freshTicket({ keepFresh: false });
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  const tk = await t.status();
  assert.equal(tk.next, null);
  assert.equal('behind' in tk.prs[0], false);
  assert.equal(t.w.settings.keepFresh, false);
});

test('settings: forge.keepFresh is true or false', () => {
  assert.throws(() => world({ extra: forgeWith({ keepFresh: 'yes' }) }), /forge\.keepFresh must be true or false/);
});

test('record baseMerge: the head, and the merge commit (into the pipeline\'s commits) or the conflict; neither is bad usage', async () => {
  const c = card({ number: 1503, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 73 })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 73, targets: ['guide'], review: 'sme', branch: 'ticket-73', stage: 'readyForMerge' }] });
  const rec = (extra) => runRecord({ settings: w.settings, clients: w.clients(), key: '1503', stage: 'baseMerge', status: 'done', pr: 'guide-docs#73', now: NOW, ...extra });
  await assert.rejects(rec({ result: { commits: ['b'.repeat(40)] } }), /baseMerge done needs --head/);
  await assert.rejects(rec({ head: 'b'.repeat(40), result: {} }), /give the merge commit \("commits"\) or the "conflict"/);
  await assert.rejects(rec({ head: 'b'.repeat(40), result: { conflict: { base: 'c'.repeat(40), files: [] } } }), /"conflict" is \{ "base", "files": \[paths\] \}/);
  await rec({ head: 'b'.repeat(40), result: { merged: { base: 'c'.repeat(40), commit: 'b'.repeat(40) }, commits: ['b'.repeat(40)] } });
  const p = read(w, '1503').prs[0];
  assert.deepEqual([p.steps.baseMerge.status, p.steps.baseMerge.head, p.pipelineCommits.includes('b'.repeat(40))], ['done', 'b'.repeat(40), true]);
});

test('scope 1, D-127: a ready PR whose base moved gets the runner\'s baseMerge (no model); one in the owner\'s queue never does', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  const tk = await t.status();
  assert.deepEqual([tk.next.stage, tk.next.role, tk.next.pr, tk.next.head, tk.next.base, tk.next.behind, tk.next.tip], ['baseMerge', null, 'guide-docs#71', t.h1, 'main', 1, t.forgePr.baseCommit]);
  assert.equal(tk.prs[0].behind, 1, 'status says how far behind the PR is');
  assert.equal(finishRank(tk.next), 1, 'finished first, with ready for merge');
  assert.match(scriptedCalls({ ...tk.next, keys: ['1501'] }, read(t.w, '1501'), t.w.settings)[0], /^git merge --no-edit origin\/main in .* \(1 commit\(s\) behind\), then git push origin HEAD:refs\/heads\/ticket-71; on a conflict git merge --abort and nothing pushed$/);

  // The same PR in the owner's queue (D-127: the owner edits the branch there): nothing, but its distance is shown.
  const q = freshTicket({ stage: 'finalReview' });
  q.forgePr.baseCommit = q.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  const qk = await q.status();
  assert.equal(qk.next, null);
  assert.equal(qk.prs[0].behind, 1);
});

test('scope 1: new comments on a ready PR are answered before the base is merged in, so no merge pushes under an answer', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  t.w.forge.activity['guide-docs#71'] = { comments: [{ id: 5001, author: 'owner-login', body: 'Зміни заголовок', createdAt: ago(1), updatedAt: ago(1) }] };
  const tk = await t.status();
  assert.equal(tk.next.stage, 'answerComments');
});

test('scope 1: a PR at In translation with its chain done has the base merged in before it is marked ready for merge', async () => {
  const t = freshTicket({ stage: 'translation' });
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  assert.equal((await t.status()).next.stage, 'baseMerge');
  // Up to date: ready for merge as before.
  const u = freshTicket({ stage: 'translation' });
  const uk = await u.status();
  assert.deepEqual([uk.next.stage, uk.prs[0].behind], ['readyForMerge', 0]);
});

test('AC-1, AC-3, AC-4: one merge commit, one push, no session; it is the pipeline\'s own, so no hand edit and no UA change of the PR\'s; ready again only once CI is green on the new head', async () => {
  const t = freshTicket();
  // The base changed another block of the PR's own page: merged in cleanly, it is the base's change, not the PR's.
  t.forgePr.baseCommit = t.baseMoves({ [PAGE]: PAGE_V0.replace('Третій абзац.', 'Третій абзац, з основи.'), [EN_PAGE]: '# Page\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph, from the base.\n' });
  const out = await t.run();
  assert.deepEqual(out.ran.map((r) => [r.stage, r.role, r.outcome]), [['baseMerge', null, 'done']]);
  const merge = t.branchHead();
  assert.notEqual(merge, t.h1, 'pushed');
  assert.deepEqual(git(t.bare, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1), [t.h1, t.forgePr.baseCommit], 'a merge commit, never a rebase');
  assert.equal(git(t.bare, 'rev-list', '--count', `${t.h1}..${merge}`), '2', 'the merge and the base\'s one commit: nothing else');
  const l = read(t.w, '1501');
  const rec = l.prs[0].steps.baseMerge;
  assert.deepEqual([rec.status, rec.head, rec.result.merged.commit, rec.result.merged.base], ['done', merge, merge, t.forgePr.baseCommit]);
  assert.ok(l.prs[0].pipelineCommits.includes(merge), 'the merge commit is the pipeline\'s own');
  assert.deepEqual([l.runs.at(-1).stage, l.runs.at(-1).script, l.runs.at(-1).session, l.runs.at(-1).outcome], ['baseMerge', true, null, 'done']);
  assert.equal(t.forgePr.labels.includes(READY), false, 'the ready label comes off until CI passes');
  assert.equal(git(t.wt, 'status', '--porcelain', '--untracked-files=no'), '');

  // CI not reported yet on the push: waits, no failure (the forge may take a moment to start it).
  let tk = await t.status();
  assert.equal(tk.next, null);
  assert.ok(tk.notes.some((n) => /no CI check has reported on .*, the base merge's push, yet/.test(n)));
  // AC-3: not a hand edit, no UA change of the PR's own, the approval not stale, no re-sync.
  assert.equal(tk.mismatch.some((m) => /didn't make|changed after the approval/.test(m)), false);
  assert.equal(tk.prs[0].approvalStale, 0);
  assert.equal(tk.prs[0].behind, 0);
  // Running.
  t.forgePr.checks = { commit: merge, state: 'pending', failing: [], pending: ['build'] };
  tk = await t.status();
  assert.equal(tk.next, null);
  assert.ok(tk.notes.some((n) => /CI runs on .* \(build\): ready for merge once it passes/.test(n)));
  // AC-4: green keeps it ready: `readyForMerge` for the new head, the ready label back on.
  t.forgePr.checks = green(merge);
  tk = await t.status();
  assert.deepEqual([tk.next.stage, tk.next.head], ['readyForMerge', merge]);
  const again = await t.run();
  assert.deepEqual(again.ran.map((r) => [r.stage, r.outcome]), [['readyForMerge', 'done']]);
  assert.deepEqual(read(t.w, '1501').prs[0].readyForMerge.map((r) => r.head), [t.h1, merge]);
  assert.equal(read(t.w, '1501').prs[0].stage, 'readyForMerge');
  assert.ok(t.forgePr.labels.includes(READY));
  assert.equal((await t.status()).next, null, 'nothing more: up to date and ready');
});

test('AC-4: CI red on the head the merge made sends the PR back with the check named; it stays out of ready for merge', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  await t.run();
  const merge = t.branchHead();
  t.forgePr.checks = { commit: merge, state: 'failure', failing: ['links'], pending: [] };
  const tk = await t.status();
  assert.equal(tk.next, null);
  assert.ok(tk.mismatch.some((m) => m === `guide-docs#71: CI failed on ${merge.slice(0, 7)}: links; not ready for merge until a later head passes`));
  assert.match(tk.gate.why, /^CI failed on guide-docs#71 \(links\)/);
  assert.equal(t.forgePr.labels.includes(READY), false);
  const out = await t.run();
  assert.deepEqual(out.ran, [], 'nothing runs on a red head');
  const report = renderReport({ settings: t.w.settings, st: await t.w.status({ git: makeGit(t.w.settings) }), date: localDate(NOW) });
  assert.match(report, /CI failed on .*: links/);
  // Never called ready for the merge meanwhile, in the report or the progress file.
  assert.match(report, /## Ready for merge\n\n- \[guide-docs#71\]\(.*\) \(.*\): not ready for merge yet: CI failed on [0-9a-f]{7}: links\n/);
  assert.equal(gatesOf(read(t.w, '1501')).some((g) => g.kind === 'readyForMerge'), false);
  assert.match(notReadyYet(read(t.w, '1501').prs[0]), /^the base was merged in as [0-9a-f]{7}: ready again once CI passes on it$/);
});

test('the CI grace: a head the merge pushed with no check after CI_GRACE_MS is one the repository runs no CI for', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  await t.run();
  const later = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW + CI_GRACE_MS + 1, spawnClaude: noSession }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(later.ran.map((r) => [r.stage, r.outcome]), [['readyForMerge', 'done']]);
});

test('AC-2: a conflicting base leaves the branch untouched (no push, the worktree clean) and the PR back in work with the writer\'s baseFix named', async () => {
  const t = freshTicket();
  // The base changed the PR's own first paragraph. One step, so the run stops before the session.
  t.forgePr.baseCommit = t.baseMoves({ [PAGE]: PAGE_V0.replace('Перший абзац.', 'Перший абзац, з основи.') });
  t.w.settings.limits.stepsPerTicket = 1;
  const out = await t.run();
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['baseMerge', 'done']]);
  assert.equal(t.branchHead(), t.h1, 'nothing pushed');
  assert.equal(git(t.wt, 'rev-parse', 'HEAD'), t.h1);
  assert.equal(git(t.wt, 'status', '--porcelain', '--untracked-files=no'), '', 'git status clean after the abort');
  assert.throws(() => git(t.wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'no merge in progress');
  const rec = read(t.w, '1501').prs[0].steps.baseMerge;
  assert.deepEqual([rec.head, rec.result.conflict.base, rec.result.conflict.files], [t.h1, t.forgePr.baseCommit, [PAGE]]);
  assert.equal(t.forgePr.labels.includes(READY), false, 'the ready label comes off');
  const tk = await t.status();
  assert.deepEqual([tk.next.stage, tk.next.role, tk.next.files, tk.next.base], ['baseFix', 'writer', [PAGE], 'main']);
  assert.match(out.log.find((e) => e.stage === 'baseMerge').note, /conflicted in docs\/x\/index\.md: aborted, nothing pushed/);
  // Not ready for the merge meanwhile: the report says why, and the progress file asks nothing of the owner.
  assert.match(renderReport({ settings: t.w.settings, st: await t.w.status({ git: makeGit(t.w.settings) }), date: localDate(NOW) }), /\): not ready for merge yet: the merge of the base conflicted in docs\/x\/index\.md: a session resolves it/);
  assert.equal(gatesOf(read(t.w, '1501')).some((g) => g.kind === 'readyForMerge'), false);
  // A conflict in EN files only is the translator's.
  await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: 'baseMerge', status: 'done', pr: 'guide-docs#71', head: t.h1, result: { conflict: { base: t.forgePr.baseCommit, files: [EN_PAGE] } }, now: NOW });
  const en = await t.status();
  assert.deepEqual([en.next.stage, en.next.role, en.next.files], ['baseFix', 'translator', [EN_PAGE]]);
  // The base moved again since: the merge is tried again, it may not conflict now.
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, ще раз\n' });
  assert.equal((await t.status()).next.stage, 'baseMerge');
});

test('scope 4, AC-5: the baseFix session resolves the files only; the runner commits the merge and pushes it; the session may not commit, merge or push', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ [PAGE]: PAGE_V0.replace('Перший абзац.', 'Перший абзац, з основи.') });
  const seen = [];
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    const wt = cmd.args[cmd.args.indexOf('--add-dir') + 1];
    seen.push({ stage, brief: briefOf(cmd), cmd, wt, merging: Boolean(execFileSync('git', ['-C', wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { encoding: 'utf8' }).trim()) });
    fs.writeFileSync(path.join(wt, PAGE), PAGE_V0.replace('Перший абзац.', 'Перший абзац, змінений, з основи.'));
    git(wt, 'add', PAGE);
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', result: { files: [PAGE] }, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await t.run({ spawnClaude });
  // The conflict, then the session in the same run, then the move back to the owner's queue (below).
  assert.deepEqual(out.ran.map((r) => [r.stage, r.role, r.outcome]), [['baseMerge', null, 'done'], ['baseFix', 'writer', 'done'], ['move', null, 'done']]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].merging, true, 'the runner started the merge before the session');
  assert.match(seen[0].brief, /conflicted in 1 file\(s\): docs\/x\/index\.md/);
  assert.match(seen[0].brief, /Never commit, merge, abort the merge or push: the runner commits the merge and pushes it/);
  // AC-5: no push rule; commit, merge and push denied in the worktree's spelling; the hook refuses them too.
  const { cmd, wt } = seen[0];
  const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
  const denied = cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1);
  assert.equal(allowed.some((r) => /push origin HEAD:refs\/heads\/ticket-71/.test(r)), false);
  for (const c of ['commit', 'merge', 'push']) assert.ok(denied.includes(`Bash(git -C ${wt} ${c}:*)`), c);
  const cfg = JSON.parse(cmd.env[HOOK_VARIABLE]);
  assert.match(refusalOf(`git -C ${wt} commit -m x`, cfg), /the runner commits the merge and pushes it/);
  assert.match(refusalOf(`git -C ${wt} push origin HEAD:refs/heads/ticket-71`, cfg), /the runner commits the merge and pushes it/);
  assert.match(refusalOf(`git -C ${wt} merge origin/main`, cfg), /no stage runs it/);
  assert.equal(refusalOf(`git -C ${wt} add ${PAGE}`, cfg), null);
  // Another stage keeps its push.
  const write = commandFor({ stage: 'write', role: 'writer', keys: ['1501'], worktrees: [{ repo: 'guide-docs', branch: 'ticket-71', base: 'main', path: wt }] }, t.w.settings, { agentsPath: '/x/agents.json' });
  assert.ok(write.args.includes(`Bash(git -C ${wt} push origin HEAD:refs/heads/ticket-71)`));
  assert.equal(JSON.parse(write.env[HOOK_VARIABLE]).noCommit, undefined);
  // The runner's merge commit, pushed, with the session's resolution, and recorded as the pipeline's.
  const merge = t.branchHead();
  assert.deepEqual(git(t.bare, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1), [t.h1, t.forgePr.baseCommit]);
  assert.equal(git(t.bare, 'show', `${merge}:${PAGE}`), PAGE_V0.replace('Перший абзац.', 'Перший абзац, змінений, з основи.').trim());
  const l = read(t.w, '1501');
  assert.deepEqual([l.prs[0].steps.baseMerge.head, l.prs[0].steps.baseMerge.result.merged.resolved], [merge, [PAGE]]);
  assert.ok(l.prs[0].pipelineCommits.includes(merge));
  // The resolution changed a UA block of the PR's own: D-112, back to the owner's queue (no re-sync by itself).
  assert.equal(out.ran[2].to, 'finalReview');
  assert.equal(read(t.w, '1501').prs[0].stage, 'finalReview');
});

test('scope 4: a baseFix session that leaves a conflict marker fails the stage; the merge is aborted, nothing pushed, the worktree clean', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ [PAGE]: PAGE_V0.replace('Перший абзац.', 'Перший абзац, з основи.') });
  const spawnClaude = async (cmd) => {
    const wt = cmd.args[cmd.args.indexOf('--add-dir') + 1];
    git(wt, 'add', PAGE);
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: 'baseFix', pr: 'guide-docs#71', status: 'done', result: { files: [PAGE] }, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await t.run({ spawnClaude });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['baseMerge', 'done'], ['baseFix', 'failed']]);
  const rec = read(t.w, '1501').prs[0].steps.baseFix;
  assert.equal(rec.status, 'failed');
  assert.match(rec.note, /the resolved merge was not committed: a conflict marker is still in a staged file/);
  assert.equal(t.branchHead(), t.h1);
  assert.equal(git(t.wt, 'rev-parse', 'HEAD'), t.h1);
  assert.equal(git(t.wt, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('the watcher looks at every ready ticket in each full check with keepFresh, events or none', async () => {
  const run = async (keepFresh) => {
    const c = card({ number: 1502, status: 'finalReview' });
    const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 72 })], extra: forgeWith(keepFresh ? { keepFresh: true } : {}) });
    ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 72, targets: ['guide'], review: 'sme', branch: 'ticket-72', stage: 'readyForMerge', readyForMerge: [{ head: 'a'.repeat(40), at: ago(2) }], chain: Object.fromEntries(CHAIN.map((s) => [s, { status: 'done', head: 'a'.repeat(40) }])) }] });
    const f = emptyFeed();
    for (const s of sourcesOf(w.settings)) f.sources[s.name] = { lastCheck: new Date(NOW - 5 * 60000).toISOString(), seen: {} };
    f.morning = { lastDate: localDate(NOW) };
    writeFeed(w.settings.state, f);
    return runCheck({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, git: quietGit, runDaily: async () => assert.fail('nothing to run'), readUsage: () => assert.fail('no /usage'), notify: () => ({ sent: true }) }, options: {} });
  };
  assert.deepEqual((await run(true)).tickets.map((t) => t.key), ['1502']);
  assert.deepEqual((await run(false)).tickets ?? [], []);
});

test('the morning report lists the day\'s merges of the base, their conflicts, and the PRs still behind', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  const out = await t.run();
  const report = renderReport({ settings: t.w.settings, st: await t.w.status({ git: makeGit(t.w.settings) }), date: localDate(NOW), runLog: out.log });
  assert.match(report, /## Kept up to date with the base\n\n- .* guide-docs#71 baseMerge: merged origin\/main \(1 commit\(s\), to [0-9a-f]{7}\) into ticket-71 as [0-9a-f]{7}, pushed/);
  const q = freshTicket({ stage: 'finalReview' });
  q.forgePr.baseCommit = q.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  assert.match(renderReport({ settings: q.w.settings, st: await q.w.status({ git: makeGit(q.w.settings) }), date: localDate(NOW), runLog: [] }), /guide-docs#71\]\(.*\) \(.*\): 1 commit\(s\) behind its base, at finalReview \(merged in from ready for merge on\)/);
  // Off: no such section.
  const off = freshTicket({ keepFresh: false });
  assert.doesNotMatch(renderReport({ settings: off.w.settings, st: await off.w.status({ git: makeGit(off.w.settings) }), date: localDate(NOW), runLog: [] }), /Kept up to date/);
});

test('the patch-id reading is gated: with keepFresh off, a base block merged into a PR\'s page by the forge\'s "Update branch" counts as before', async () => {
  const t = freshTicket({ keepFresh: false });
  t.baseMoves({ [PAGE]: PAGE_V0.replace('Третій абзац.', 'Третій абзац, з основи.') });
  // The forge's "Update branch", made elsewhere: a merge commit the pipeline didn't make.
  const other = path.join(tmp('upd-'), 'g');
  execFileSync('git', ['clone', '-q', t.bare, other]);
  git(other, 'config', 'user.email', 'f@example.com');
  git(other, 'config', 'user.name', 'Forge');
  git(other, 'config', 'commit.gpgsign', 'false');
  git(other, 'checkout', '-q', 'ticket-71');
  git(other, 'merge', '-q', '--no-edit', 'origin/main');
  git(other, 'push', '-q', 'origin', 'ticket-71');
  t.forgePr.headCommit = git(other, 'rev-parse', 'HEAD');
  const gitNow = makeGit(t.w.settings);
  const target = t.w.settings.targets[0];
  gitNow.fetchHeads([{ target, branch: 'ticket-71', base: 'main', head: t.forgePr.headCommit }]);
  assert.deepEqual(gitNow.changedUnder(target, t.h1, t.forgePr.headCommit, ['docs/'], 'main'), [PAGE]);
  // With it on, the same change is the base's.
  const on = makeGit({ ...t.w.settings, keepFresh: true });
  assert.deepEqual(on.changedUnder(target, t.h1, t.forgePr.headCommit, ['docs/'], 'main'), []);
});

test('a push of the merge that fails leaves the worktree at its head and a failed run that waits, then holds; a rejected one is moved', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  const down = (wt, a) => {
    git(wt, 'reset', '-q', '--hard', a.head);
    return { error: 'fatal: could not read from remote repository', rejected: false };
  };
  const out = await t.run({ pushMerge: down });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['baseMerge', 'failed']]);
  assert.equal(t.branchHead(), t.h1);
  assert.equal(git(t.wt, 'rev-parse', 'HEAD'), t.h1);
  const l = read(t.w, '1501');
  assert.match(l.prs[0].steps.baseMerge.note, /^the push of the base merge: fatal: could not read from remote repository/);
  assert.deepEqual([l.runs.at(-1).script, l.runs.at(-1).failures, Boolean(l.runs.at(-1).after)], [true, 1, true]);
  assert.match((await t.status()).next.waits, /a person acting on the ticket/);
  // The morning run tries once more; a second failure holds the ticket, named as the runner's merge.
  await t.run({ pushMerge: down }, { morning: true, trigger: 'schedule', named: [] });
  const held = await t.status();
  assert.equal(held.held, true);
  assert.match(held.gate.why, /^baseMerge on guide-docs#71 failed twice with no one acting in between, the last time in the runner's own merge of the base/);

  const r = freshTicket();
  r.forgePr.baseCommit = r.baseMoves({ 'docs/y/other.md': '# Інша, змінена\n' });
  const reject = (wt, a) => {
    git(wt, 'reset', '-q', '--hard', a.head);
    return { error: '! [rejected] HEAD -> ticket-71 (fetch first)', rejected: true };
  };
  const rejected = await r.run({ pushMerge: reject });
  assert.deepEqual(rejected.ran.map((x) => x.outcome), ['moved', 'moved'], 'no failure counted; read again, twice at most');
  assert.equal(read(r.w, '1501').runs.some((x) => x.outcome === 'failed'), false);
});

test('a merge left in progress in the worktree (a run that stopped during baseFix) is aborted, not a stuck worktree', async () => {
  const t = freshTicket();
  t.forgePr.baseCommit = t.baseMoves({ [PAGE]: PAGE_V0.replace('Перший абзац.', 'Перший абзац, з основи.') });
  // The worktree as a stopped run left it: the conflicting merge in progress.
  ensureWorktree(t.w.settings, read(t.w, '1501').prs[0]);
  assert.throws(() => git(t.wt, 'merge', '--no-edit', 'origin/main'));
  assert.ok(git(t.wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
  t.w.settings.limits.stepsPerTicket = 1;
  const out = await t.run();
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['baseMerge', 'done']], 'the merge tried again, and recorded its conflict');
  assert.equal(git(t.wt, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.deepEqual(read(t.w, '1501').prs[0].steps.baseMerge.result.conflict.files, [PAGE]);
});
