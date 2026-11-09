import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LISTS, NOW, ago, card, gitRepo, pr, rawSettings, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runDaily, scriptedCalls } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { adoptSources, checkClone, codeClonePath, codeTreePath, codeTreesRoot, ensureCodeTree, ensureReadCheckout, ensureWorktree, listWorktrees, canon, readCheckoutPath, prsForStep, unsavedWork, worktreePath } from '../lib/worktree.mjs';
import { makeGit } from '../lib/world.mjs';
import { commandFor } from '../lib/runner.mjs';
import { spentOf } from '../lib/limits.mjs';
import { writeLedger } from '../lib/ledger.mjs';
import { allLocks, releaseLock, takeLock } from '../lib/locks.mjs';
import { localDate, renderReport } from '../lib/report.mjs';

// The ticket worktree (lib/worktree.mjs): the runner makes it, with the clone's node_modules linked and excluded, so
// the build needs no role action; the close step removes it with git and never moves a `.git` link alone. And the
// steps after a hand commit at ready for merge: the re-sync, the visual pack when an image changed, then ready again.

const usage = () => parseUsage('Current session: 10% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.2, duration_ms: 1000, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];
const EN = 'i18n/en/docusaurus-plugin-content-docs/current';
const UK_IMG = 'docs/x/.assets/a.png';
const EN_IMG = `${EN}/x/.assets/a.png`;
const stageOf = (cmd) => /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];
const briefOf = (cmd) => cmd.args[cmd.args.indexOf('-p') + 1];
// What a session stand-in records: a style check lists the hand commits its brief named, and fixes nothing.
const resultOf = (cmd) => (stageOf(cmd) === 'styleCheck' ? { reviewed: [...briefOf(cmd).matchAll(/^- ([0-9a-f]{40}): /gm)].map((m) => ({ sha: m[1] })) } : {});

// A target clone at the fake world's `repos/guide-docs`, with a bare origin, the ticket branch pushed, the clone's own
// node_modules and .env (untracked; `.gitignore` names `node_modules/`, which doesn't match a link), and the branch
// checked out in the clone, as an owner's checkout may be.
function withClone(w, { declare = true } = {}) {
  const bare = path.join(tmp('origin-'), 'guide-docs.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'guide-docs'));
  clone.commit({
    // As the hosts do: `.sources/` (work files) and the build's output ignored.
    '.gitignore': 'node_modules/\n.env\n.sources/\nbuild/\n.docusaurus/\n*.local.md\n',
    'package.json': '{ "name": "site", "private": true }\n',
    'docs/x/index.md': '# Сторінка\n',
    [UK_IMG]: 'uk v1',
    [EN_IMG]: 'en v1',
    ...(declare
      ? {
          'CLAUDE.md': '# Site\n\n## Documentation toolkit configuration\n\n- **UA content root:** `docs/`\n' + `- **EN i18n root:** \`${EN}/\`\n` + '- **Screenshot locales:** `uk, en`\n- **Locale switch:** `storage lang uk="uk-UA", en="en-US"`\n',
          'docusaurus.config.ts': "export default { i18n: { defaultLocale: 'uk', locales: ['uk', 'en'] } };\n",
        }
      : {}),
  }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  clone.g('fetch', '-q', 'origin');
  clone.g('checkout', '-q', '-b', 'ticket-71');
  const h1 = clone.commit({ 'docs/x/index.md': '# Сторінка\n\nНовий абзац.\n' }, 'Draft: page');
  clone.g('push', '-q', 'origin', 'ticket-71');
  fs.mkdirSync(path.join(clone.dir, 'node_modules', 'fake-build'), { recursive: true });
  fs.writeFileSync(path.join(clone.dir, 'node_modules', 'fake-build', 'index.js'), 'module.exports = "built";\n');
  fs.writeFileSync(path.join(clone.dir, '.env'), 'APP_URL=https://test.example\n');
  // A second clone, standing in for the owner's push of a hand edit.
  const other = path.join(tmp('owner-'), 'guide-docs');
  execFileSync('git', ['clone', '-q', bare, other]);
  const og = (...args) => execFileSync('git', ['-C', other, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  og('config', 'user.email', 'owner@example.com');
  og('config', 'user.name', 'Owner');
  og('config', 'commit.gpgsign', 'false');
  og('checkout', '-q', 'ticket-71');
  const handEdit = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(other, rel)), { recursive: true });
      fs.writeFileSync(path.join(other, rel), text);
    }
    og('add', '-A');
    og('commit', '-q', '-m', 'Fix: by hand');
    og('push', '-q', 'origin', 'ticket-71');
    // The target clone isn't fetched: the commit reaches it as one made on the forge would, by status's own fetch
    // (lib/world.mjs, `fetchHeads`) or the worktree's.
    return og('rev-parse', 'HEAD');
  };
  // The owner rewrites the branch (a rebase onto the base, then a force push), as after a squash of the drafts.
  const rewrite = () => {
    og('reset', '-q', '--hard', 'origin/main');
    fs.writeFileSync(path.join(other, 'docs/x/index.md'), '# Сторінка\n\nПереписано.\n');
    og('commit', '-q', '-am', 'Draft: page, rewritten');
    og('push', '-q', '--force', 'origin', 'HEAD:ticket-71');
    clone.g('fetch', '-q', 'origin');
    return og('rev-parse', 'HEAD');
  };
  return { clone, bare, h1, handEdit, rewrite };
}

// A commit a session made in the worktree and never pushed.
function commitIn(wt, rel, text) {
  fs.writeFileSync(path.join(wt, rel), text);
  const g = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim();
  g('-c', 'user.email=s@example.com', '-c', 'user.name=Session', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'Session work');
  return g('rev-parse', 'HEAD');
}

function finalReviewTicket({ done = CHAIN.slice(0, 5), stage = 'translation', extra = {}, declare } = {}) {
  const c = card({ number: 1501, status: stage === 'translation' ? 'translation' : 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 71, head: 'ticket-71' });
  const w = world({ cards: [c], prs: [forgePr], extra });
  const fx = withClone(w, { declare });
  forgePr.headCommit = fx.h1;
  const chain = Object.fromEntries(done.map((s, i) => [s, { status: 'done', head: fx.h1, seq: 10 + i }]));
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 71, targets: ['guide'], review: 'sme', branch: 'ticket-71', stage, pipelineCommits: [fx.h1], chain, ...(stage === 'readyForMerge' ? { readyForMerge: [{ head: fx.h1, at: ago(2) }] } : {}) }] });
  return { w, c, forgePr, ...fx, wt: worktreePath(w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71' }) };
}

test('AC-1: the runner makes the ticket worktree with the clone\'s node_modules linked and excluded; the build passes with no role action', async () => {
  const t = finalReviewTicket();
  const seen = [];
  const builds = [];
  // The runner's build (no session): in the PR's worktree, the site builds from the linked node_modules, and git shows
  // nothing untracked. Nothing is installed or linked by hand.
  const runBuild = async ({ cwd, command }) => {
    builds.push({ cwd, command });
    const built = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("./node_modules/fake-build"))'], { cwd, encoding: 'utf8' });
    assert.equal(built, 'built');
    assert.equal(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the link is excluded: nothing untracked');
    fs.mkdirSync(path.join(cwd, 'build'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'build', 'index.html'), '<html></html>\n');
    return { code: 0, tail: [] };
  };
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    seen.push({ stage, brief: briefOf(cmd), addDirs: cmd.args.filter((a, i) => cmd.args[i - 1] === '--add-dir') });
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: t.h1, result: {}, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude, runBuild }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]).slice(0, 2), [['build', 'done'], ['visualPack', 'done']]);
  assert.deepEqual(builds.map((b) => [canon(b.cwd), b.command]), [[canon(t.wt), ['npm', 'run', 'build']]], 'one build, the default command, in the worktree');
  assert.deepEqual(seen.map((x) => x.stage), ['visualPack'], 'no session for the build');
  assert.match(seen[0].brief, new RegExp(`--build-dir ${path.join(t.wt, 'build').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the pack reuses the build of its head');
  const l = read(t.w, '1501');
  assert.deepEqual([l.prs[0].chain.build.status, l.prs[0].chain.build.head, l.prs[0].chain.build.result], ['done', t.h1, { ok: true }]);
  // The worktree: detached at the branch's head although the clone has the branch checked out, node_modules a link
  // to the clone's, listed in the common git dir's info/exclude without a trailing slash.
  assert.equal(execFileSync('git', ['-C', t.wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), t.h1);
  assert.equal(fs.lstatSync(path.join(t.wt, 'node_modules')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(t.wt, 'node_modules')), fs.realpathSync(path.join(t.clone.dir, 'node_modules')));
  assert.equal(fs.existsSync(path.join(t.wt, '.env')), false, '.env only when the target names it');
  assert.match(fs.readFileSync(path.join(t.clone.dir, '.git', 'info', 'exclude'), 'utf8'), /^\/node_modules$/m);
  // The brief names it, with the push command; the session may read and write there.
  assert.match(seen[0].brief, new RegExp(`guide-docs ticket-71: ${t.wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(linked from the clone: node_modules\\)`));
  assert.match(seen[0].brief, /push origin HEAD:refs\/heads\/ticket-71/);
  assert.ok(seen[0].addDirs.includes(t.wt));
});

test('AC-1: a ticket\'s chain from translate to ready for merge runs one full build: the runner\'s, with the locales stage told --no-build and the pack reusing it', async () => {
  const t = finalReviewTicket({ done: [] });
  const bin = tmp('bin-');
  const count = path.join(bin, 'builds.txt');
  fs.writeFileSync(path.join(bin, 'build.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(count)}, 'x');\nfs.mkdirSync('build', { recursive: true });\nfs.writeFileSync('build/index.html', '<html></html>');\n`);
  t.w.settings.build.command = [process.execPath, path.join(bin, 'build.mjs')];
  const seen = [];
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    seen.push({ stage, brief: briefOf(cmd) });
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: t.h1, result: {}, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => r.stage).slice(0, 8), [...CHAIN, 'readyForMerge']);
  assert.ok(out.ran.slice(0, 8).every((r) => r.outcome === 'done'));
  assert.equal(fs.readFileSync(count, 'utf8'), 'x', 'one build in the whole chain');
  assert.deepEqual(seen.map((x) => x.stage), CHAIN.filter((s) => s !== 'build'), 'no session for the build');
  assert.match(seen.find((x) => x.stage === 'locales').brief, /locale-translator with `--no-build`/);
  assert.match(seen.find((x) => x.stage === 'visualPack').brief, /--build-dir .*\/build`/);
  for (const x of seen.filter((y) => y.stage !== 'locales')) assert.doesNotMatch(x.brief, /--no-build/);
  assert.equal(read(t.w, '1501').prs[0].readyForMerge.at(-1).head, t.h1);
});

test('AC-5: a session failing on a head a person moved is followed by the step status gives at the new head: no model retry, no failure, no hold', async () => {
  // The locales stage works on h1; the owner's hand commit (a UA paragraph) moves the branch; the session's push is
  // rejected (non-fast-forward) and it records the stage failed.
  const t = finalReviewTicket({ done: CHAIN.slice(0, 2), extra: { roles: { translator: { model: 'claude-sonnet-5-5' } }, limits: { stepsPerTicket: 3 } } });
  const calls = [];
  let moved = null;
  let mine = null;
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    calls.push({ stage, model: cmd.args[cmd.args.indexOf('--model') + 1], brief: briefOf(cmd), head: execFileSync('git', ['-C', t.wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
    if (stage === 'locales') {
      fs.mkdirSync(path.join(t.wt, 'i18n/tr/docusaurus-plugin-content-docs/current/x'), { recursive: true });
      fs.writeFileSync(path.join(t.wt, 'i18n/tr/docusaurus-plugin-content-docs/current/x/index.md'), '# Sayfa\n');
      const g = (...a) => execFileSync('git', ['-C', t.wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      g('add', '-A');
      g('-c', 'user.email=s@example.com', '-c', 'user.name=Session', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Locales: tr');
      mine = g('rev-parse', 'HEAD');
      moved = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nНовий абзац, виправлений.\n' });
      t.forgePr.headCommit = moved;
      assert.throws(() => g('push', '-q', 'origin', 'HEAD:refs/heads/ticket-71'), /rejected|non-fast-forward|fetch first/);
      await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'failed', note: 'the push was rejected: the branch moved', now: NOW });
      return { code: 0, stdout: RESULT, stderr: '' };
    }
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: moved, result: {}, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  // The steps status gives at the new head: the hand commit's style check (skipped: the card was moved on), then
  // translate, stale, on the role's own model, in a worktree that followed the branch (the rejected commit set aside,
  // not stuck).
  assert.deepEqual(calls.map((c) => [c.stage, c.model]), [['locales', 'claude-sonnet-5-5'], ['translate', 'claude-sonnet-5-5']]);
  assert.match(calls[1].brief, /The UA pages changed after this stage last ran \(1 file\(s\)\): run it again on the current head/);
  assert.deepEqual([calls[0].head, calls[1].head], [t.h1, moved]);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['locales', 'moved'], ['styleCheck', 'done'], ['translate', 'done']]);
  const l = read(t.w, '1501');
  const run = l.runs.find((r) => r.stage === 'locales');
  assert.deepEqual([run.outcome, run.failures ?? null, run.retryOf ?? null], ['moved', null, null]);
  assert.match(run.note, new RegExp(`the branch moved to ${moved.slice(0, 7)} while the session worked on ${t.h1.slice(0, 7)}`));
  const log = fs.readFileSync(path.join(t.w.settings.state, 'runs', `${localDate(NOW)}.jsonl`), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(log.filter((e) => e.kind === 'retry').length, 0, 'no model retry');
  // The session's commit is kept under a ref in the clone, never dropped.
  const kept = log.find((e) => e.kind === 'worktree' && e.outcome === 'setAside');
  assert.match(kept.note, new RegExp(`${mine.slice(0, 7)} kept as refs/ticket-flow/set-aside/ticket-71/${mine.slice(0, 12)}`));
  assert.equal(execFileSync('git', ['-C', t.clone.dir, 'rev-parse', `refs/ticket-flow/set-aside/ticket-71/${mine.slice(0, 12)}`], { encoding: 'utf8' }).trim(), mine);
  // No hold and no wait: the chain goes on from enReview at the new head (status with the clone's own git).
  const tk = await t.w.one('1501', { git: makeGit(t.w.settings) });
  assert.deepEqual([tk.held ?? false, tk.failed ?? null, tk.next?.stage, tk.next?.waits ?? null], [false, null, 'enReview', null]);
});

test('AC-5: a session that pushed its own commit and then failed is an ordinary failure: the forge head is its worktree\'s', async () => {
  const t = finalReviewTicket({ done: CHAIN.slice(0, 2), extra: { roles: { translator: { model: 'claude-sonnet-5-5' } }, limits: { stepsPerTicket: 1 } } });
  const calls = [];
  const spawnClaude = async (cmd) => {
    calls.push(cmd.args[cmd.args.indexOf('--model') + 1]);
    if (calls.length === 1) {
      const pushed = commitIn(t.wt, 'docs/x/index.md', '# Сторінка\n\nНовий абзац.\n\nЩе один.\n');
      execFileSync('git', ['-C', t.wt, 'push', '-q', 'origin', 'HEAD:refs/heads/ticket-71'], { stdio: 'ignore' });
      t.forgePr.headCommit = pushed;
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(calls, ['claude-sonnet-5-5', 'claude-opus-5-5'], 'the ladder as before');
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['locales', 'failed']]);
  assert.deepEqual(read(t.w, '1501').runs.filter((r) => r.stage === 'locales').map((r) => [r.outcome, r.failures]), [['failed', 1], ['failed', 2]]);
});

test('AC-1: .env too when the target names it; a clone without node_modules is said in the brief; a branch not pushed yet starts from the base', async () => {
  const t = finalReviewTicket();
  t.w.settings.targets.find((x) => x.id === 'guide').links = ['node_modules', '.env'];
  const tree = ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' });
  assert.deepEqual(tree.linked, ['node_modules', '.env']);
  assert.equal(fs.readFileSync(path.join(t.wt, '.env'), 'utf8'), 'APP_URL=https://test.example\n');
  assert.match(fs.readFileSync(path.join(t.clone.dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.env$/m);
  assert.equal(execFileSync('git', ['-C', t.wt, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  // Again: nothing doubled.
  ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' });
  assert.equal(fs.readFileSync(path.join(t.clone.dir, '.git', 'info', 'exclude'), 'utf8').match(/^\/node_modules$/gm).length, 1);
  // A new branch: from origin/main, at the base's head.
  fs.rmSync(path.join(t.clone.dir, 'node_modules'), { recursive: true });
  const fresh = ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-72', base: 'main' });
  assert.equal(fresh.head, t.clone.g('rev-parse', 'origin/main'));
  assert.deepEqual(fresh.missing, ['node_modules']);
  assert.match(fresh.notes.join(' '), /node_modules: not in the clone/);
});

test('AC-1: an existing worktree follows the owner\'s push although a session left untracked files in it; never over uncommitted changes', async () => {
  const t = finalReviewTicket();
  const p = { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' };
  ensureWorktree(t.w.settings, p);
  fs.mkdirSync(path.join(t.wt, 'docs', 'x', '.sources'), { recursive: true });
  fs.writeFileSync(path.join(t.wt, 'docs', 'x', '.sources', 'run-notes.md'), 'a session left this');
  // An untracked file git doesn't ignore, too.
  fs.writeFileSync(path.join(t.wt, 'docs', 'x', 'session-notes.txt'), 'and this');
  const h2 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nРучна правка.\n' });
  const tree = ensureWorktree(t.w.settings, p);
  assert.equal(tree.head, h2);
  assert.deepEqual(tree.notes, []);
  assert.equal(fs.existsSync(path.join(t.wt, 'docs', 'x', '.sources', 'run-notes.md')), true);
  assert.equal(fs.readFileSync(path.join(t.wt, 'docs', 'x', 'session-notes.txt'), 'utf8'), 'and this');
  // A change to a tracked file is a session's work: the worktree stays where it is, and the brief says why.
  fs.writeFileSync(path.join(t.wt, 'docs', 'x', 'index.md'), 'unsaved work');
  const h3 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nЩе одна правка.\n' });
  const kept = ensureWorktree(t.w.settings, p);
  assert.equal(kept.head, h2);
  assert.notEqual(kept.head, h3);
  assert.match(kept.stuck.join(' '), /uncommitted changes/);
});

test('AC-1: a rewritten branch: a clean worktree moves to the new head; one with work the branch never had, or tracked changes, stays and says why', async () => {
  const p = { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' };
  // Clean: it was at an earlier head of origin/ticket-71, so it follows the rewrite.
  const t = finalReviewTicket();
  ensureWorktree(t.w.settings, p);
  const h2 = t.rewrite();
  const moved = ensureWorktree(t.w.settings, p);
  assert.deepEqual([moved.head, moved.notes, moved.stuck], [h2, [], []]);
  // A session's commit that was never pushed: kept, with the note.
  const u = finalReviewTicket();
  ensureWorktree(u.w.settings, p);
  const mine = commitIn(u.wt, 'docs/x/index.md', 'session work\n');
  u.rewrite();
  const kept = ensureWorktree(u.w.settings, p);
  assert.equal(kept.head, mine);
  assert.match(kept.stuck.join(' '), /never had .*\(see the ticket-state README, "A stuck worktree"\)/);
  assert.doesNotMatch(kept.stuck.join(' '), /push them/);
  // Uncommitted changes to a tracked file: kept too.
  const v = finalReviewTicket();
  ensureWorktree(v.w.settings, p);
  fs.writeFileSync(path.join(v.wt, 'docs/x/index.md'), 'unsaved\n');
  v.rewrite();
  const dirty = ensureWorktree(v.w.settings, p);
  assert.equal(dirty.head, v.h1);
  assert.match(dirty.stuck.join(' '), /uncommitted changes/);
});

test('AC-1: a worktree that can not be made starts no session; the stage is recorded failed with the reason', async () => {
  const t = finalReviewTicket();
  fs.mkdirSync(t.wt, { recursive: true });
  fs.writeFileSync(path.join(t.wt, 'stray.txt'), 'not a worktree');
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: () => assert.fail('no session without its worktree') }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['build', 'failed']]);
  const l = read(t.w, '1501');
  assert.equal(l.prs[0].chain.build.status, 'failed');
  assert.match(l.prs[0].chain.build.note, /the worktree: .* exists and is not a worktree/);
});

test('AC-1: a stuck worktree starts no session; the stage is recorded failed with the reason, and the failed-step rules apply', async () => {
  const t = finalReviewTicket();
  ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' });
  const mine = commitIn(t.wt, 'docs/x/index.md', 'a session\'s work, never pushed\n');
  t.rewrite();
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: () => assert.fail('no session on a stuck worktree') }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['build', 'failed']]);
  const l = read(t.w, '1501');
  assert.equal(l.prs[0].chain.build.status, 'failed');
  assert.match(l.prs[0].chain.build.note, /the worktree: .*never had .*"A stuck worktree"/);
  assert.equal(execFileSync('git', ['-C', t.wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mine, 'the work is left as it is');
  // The failed-step rules read it as they read a failed session (and a failed start): one failure, waiting for a person.
  // With no `start` it counts toward no session cap or cost, even at a cap of one session a day.
  t.w.settings.limits.sessionsPerStageDay = 1;
  const tk = await t.w.one('1501');
  assert.match(tk.next.waits, /a person acting on the ticket/);
  assert.deepEqual([tk.failed.sessions, tk.capped, tk.held], [1, undefined, undefined]);
  const entry = l.runs.at(-1);
  assert.deepEqual([entry.outcome, entry.session, entry.failures, 'start' in entry, 'weekPercent' in entry], ['failed', null, 1, false, false]);
  assert.equal(spentOf(l), null);
  // A start never has a worktree, so a failed start and a stuck worktree can't fall on the same step.
  assert.deepEqual(prsForStep({ stage: 'start', keys: ['1501'] }, [l]), []);
  // A failed step: the next run doesn't try it again until a person acts.
  const again = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW + 60000, spawnClaude: () => assert.fail('no retry without a person\'s action') }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(again.ran.filter((r) => r.stage === 'build'), []);
  // A second such failure (the morning run's one more try) holds the ticket, and the gate says no session ran.
  const l2 = read(t.w, '1501');
  l2.runs.at(-1).failures = 2;
  writeLedger(t.w.settings.state, l2);
  const held = await t.w.one('1501');
  assert.equal(held.held, true);
  assert.match(held.gate.why, /^build on guide-docs#71 failed twice with no one acting in between, the last time before any session started \(the worktree: .*never had/);
  assert.doesNotMatch(held.gate.why, /in 2 sessions/);
});

test('AC-5: the close step removes the ticket\'s worktrees with git, prunes, and never moves a .git link alone', async () => {
  const c = card({ number: 1502, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 71, head: 'ticket-71', state: 'merged' });
  const w = world({ cards: [c], prs: [forgePr] });
  const host = gitRepo(w.root);
  host.commit({ '.gitignore': '.flow/\nrepos/\ndocs/.sources/\n', 'docs/index.md': '# Host\n' });
  const fx = withClone(w);
  const p = { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' };
  ensureWorktree(w.settings, p);
  const wt = worktreePath(w.settings, p);
  // An older worktree a session made inside the host and recorded as a work file, as a ticket of the past did.
  const legacy = path.join(w.root, 'docs', '.sources', 'tickets', '1502', 'worktree-guide');
  fx.clone.g('worktree', 'add', '-q', '--detach', legacy, 'origin/ticket-71');
  fs.writeFileSync(path.join(path.dirname(legacy), 'notes.txt'), 'run notes');
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ ...p, number: 71, review: 'sme', stage: 'readyForMerge' }], files: [{ path: 'docs/.sources/tickets/1502', kind: 'runDir', bytes: 0, stage: 'write', at: ago(30) }] });
  assert.equal(listWorktrees(fx.clone.dir).length, 3);
  const trash = path.join(tmp('fake-trash-'), '.Trash');
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW, spawnClaude: () => assert.fail('no model step') }, options: {} });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['close', 'done']]);
  // The clone lists no worktree of the ticket, and the folders are gone.
  const left = listWorktrees(fx.clone.dir).map((x) => canon(x.path));
  assert.deepEqual(left, [canon(fx.clone.dir)]);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.existsSync(legacy), false);
  // No .git link went to the Trash on its own; the run notes did.
  const inTrash = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      inTrash.push(e.name);
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  if (fs.existsSync(trash)) walk(trash);
  assert.equal(inTrash.includes('.git'), false, `the Trash holds ${inTrash.join(', ')}`);
  assert.ok(inTrash.includes('notes.txt'));
  // The clone's own node_modules and .env survived the removal of the worktree they were linked into.
  assert.equal(fs.readFileSync(path.join(fx.clone.dir, 'node_modules', 'fake-build', 'index.js'), 'utf8'), 'module.exports = "built";\n');
  assert.equal(fs.existsSync(path.join(fx.clone.dir, '.env')), true);
  const cleanup = read(w, '1502').stages.close.result.cleanup;
  assert.deepEqual(cleanup.worktrees.map((x) => [canon(x.path), x.removed]), [[canon(wt), true], [canon(legacy), true]]);
});

test('the close step leaves the read checkouts: the ticket\'s worktree goes, a read checkout of the same clone stays, kept whole inside a folder recorded by mistake, and a prune keeps it', async () => {
  const c = card({ number: 1503, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 71, head: 'ticket-71', state: 'merged' })] });
  gitRepo(w.root).commit({ '.gitignore': '.flow/\nrepos/\n', 'docs/index.md': '# Host\n' });
  const fx = withClone(w);
  const p = { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' };
  ensureWorktree(w.settings, p);
  const wt = worktreePath(w.settings, p);
  const rc = ensureReadCheckout(w.settings, w.settings.targets[0]).path;
  assert.ok(rc && fs.existsSync(path.join(rc, 'docs/x/index.md')));
  // The state's read folder recorded as a work file, as a session might by mistake.
  const recorded = path.relative(w.root, path.dirname(rc));
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ ...p, number: 71, review: 'sme', stage: 'readyForMerge' }], files: [{ path: recorded, kind: 'other', bytes: 0, stage: 'plan', at: ago(30) }] });
  const trash = path.join(tmp('fake-trash-'), '.Trash');
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW, spawnClaude: () => assert.fail('no model step') }, options: {} });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['close', 'done']]);
  assert.equal(fs.existsSync(wt), false, 'the ticket\'s worktree went');
  assert.deepEqual(listWorktrees(fx.clone.dir).map((x) => canon(x.path)).sort(), [canon(fx.clone.dir), canon(rc)].sort());
  assert.equal(pageIn(rc), '# Сторінка\n');
  const cleanup = read(w, '1503').stages.close.result.cleanup;
  assert.ok(!cleanup.worktrees.some((x) => canon(x.path) === canon(rc)), 'never handed to the removal');
  assert.ok(JSON.stringify(cleanup).includes('the runner\'s read checkout, shared by every ticket'), JSON.stringify(cleanup));
  // A prune of the clone keeps a read checkout whose folder is there.
  fx.clone.g('worktree', 'prune');
  assert.ok(listWorktrees(fx.clone.dir).some((x) => canon(x.path) === canon(rc)));
  assert.equal(ensureReadCheckout(w.settings, w.settings.targets[0]).error, undefined, 'and the next step finds it as it was');
});

// A merged ticket whose worktree holds work no remote has: `make` leaves it so before the close.
async function closeWith(make, { files = [], reported = () => [] } = {}) {
  const c = card({ number: 1504, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 71, head: 'ticket-71', state: 'merged' })] });
  gitRepo(w.root).commit({ '.gitignore': '.flow/\nrepos/\n', 'docs/index.md': '# Host\n' });
  const fx = withClone(w);
  const p = { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' };
  ensureWorktree(w.settings, p);
  const wt = worktreePath(w.settings, p);
  make(wt, fx, w);
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ ...p, number: 71, review: 'sme', stage: 'readyForMerge', pipelineCommits: [fx.h1, ...reported()], readyForMerge: [{ head: fx.h1, at: ago(2) }] }], files: files.map((f) => ({ path: path.relative(w.root, path.join(wt, f)), kind: 'other', bytes: 0, stage: 'write', at: ago(30) })) });
  const trash = path.join(tmp('fake-trash-'), '.Trash');
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW, spawnClaude: () => assert.fail('no model step') }, options: {} });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['close', 'done']]);
  const l = read(w, '1504');
  const report = renderReport({ settings: w.settings, st: await w.status(), date: localDate(Date.parse(l.stages.close.at)), ledgers: [l] });
  return { w, fx, wt, l, report, tree: l.stages.close.result.cleanup.worktrees.find((x) => canon(x.path) === canon(wt)) };
}

test('AC-5: the close step keeps a worktree with a commit no remote has, and the report says what to do', async () => {
  let mine;
  const { fx, wt, tree, report } = await closeWith((wt) => { mine = commitIn(wt, 'docs/x/index.md', 'never pushed\n'); });
  assert.equal(fs.existsSync(wt), true);
  assert.equal(execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mine, 'the commit is still there');
  assert.ok(listWorktrees(fx.clone.dir).some((x) => canon(x.path) === canon(wt)), 'still the clone\'s worktree');
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /1 commit\(s\) on no remote branch/);
  assert.match(tree.todo, /push origin HEAD:refs\/heads\/ticket-71.*worktree remove --force/);
  assert.match(report, /worktree\(s\) kept: .*1 commit\(s\) on no remote branch.*worktree remove --force/);
});

test('AC-4: a commit a session reported (pipelineCommits) whose push never reached the forge keeps the worktree', async () => {
  let mine;
  const { wt, tree, l } = await closeWith((wt) => { mine = commitIn(wt, 'docs/x/index.md', 'push rejected\n'); }, { reported: () => [mine] });
  assert.ok(l.prs[0].pipelineCommits.includes(mine), 'the session listed it');
  assert.equal(fs.existsSync(wt), true);
  assert.equal(execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mine, 'the commit is still there');
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /1 commit\(s\) on no remote branch/);
});

test('unsavedWork: a head behind one the forge had was on the forge, with no remote-tracking ref left; one off it was not', () => {
  const repo = gitRepo(path.join(tmp('unsaved-'), 'repo'));
  const c1 = repo.commit({ 'a.md': 'a\n' }, 'one');
  const c2 = repo.commit({ 'a.md': 'b\n' }, 'two');
  const wt = path.join(path.dirname(repo.dir), 'wt');
  repo.g('worktree', 'add', '-q', '--detach', wt, c1);
  assert.deepEqual(unsavedWork(wt, [c2]), [], 'c1 is behind c2, a head the forge had');
  assert.deepEqual(unsavedWork(wt, [c1]), [], 'the head itself');
  assert.deepEqual(unsavedWork(wt, []), ['1 commit(s) on no remote branch']);
  // A session's commit on c1, beside c2: no head the forge had holds it.
  commitIn(wt, 'a.md', 'session\n');
  assert.deepEqual(unsavedWork(wt, [c1, c2]), ['2 commit(s) on no remote branch']);
});

test('AC-5: the close step keeps a worktree with a tracked change, and the report says what to do', async () => {
  const { wt, tree, report } = await closeWith((wt) => fs.writeFileSync(path.join(wt, 'docs/x/index.md'), 'not committed\n'));
  assert.equal(fs.readFileSync(path.join(wt, 'docs/x/index.md'), 'utf8'), 'not committed\n');
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /1 tracked file\(s\) changed and not committed/);
  assert.match(report, /worktree\(s\) kept: .*tracked file\(s\) changed/);
});

test('AC-5: the close step keeps a worktree with a page written and never added', async () => {
  const { wt, tree, report } = await closeWith((wt) => fs.writeFileSync(path.join(wt, 'docs/x/new-page.md'), '# Нова сторінка\n'));
  assert.equal(fs.readFileSync(path.join(wt, 'docs/x/new-page.md'), 'utf8'), '# Нова сторінка\n');
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /1 untracked file\(s\) never added \(docs\/x\/new-page\.md\)/);
  assert.match(report, /worktree\(s\) kept: .*never added/);
});

test('AC-5: a worktree whose only untracked entries are the linked node_modules and .env goes without --force; the clone\'s own stay', async () => {
  const { fx, wt, tree } = await closeWith((wt, f) => {
    assert.equal(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), true);
    fs.symlinkSync(path.join(f.clone.dir, '.env'), path.join(wt, '.env'));
    fs.appendFileSync(path.join(f.clone.dir, '.git', 'info', 'exclude'), '/.env\n');
  });
  assert.deepEqual([tree.removed, tree.kept], [true, undefined]);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.readFileSync(path.join(fx.clone.dir, 'node_modules', 'fake-build', 'index.js'), 'utf8'), 'module.exports = "built";\n');
  assert.equal(fs.readFileSync(path.join(fx.clone.dir, '.env'), 'utf8'), 'APP_URL=https://test.example\n');
});

const put = (wt, files) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), text);
  }
};

test('AC-5: the close step keeps a worktree with ignored work files under .sources/, and reports a recorded one as kept with it', async () => {
  const work = { 'docs/x/.sources/app-notes.md': '# Notes\n', 'docs/x/.sources/sme-interview.md': '# Interview\n', 'docs/x/.sources/frames/f1.png': 'png' };
  const { wt, tree, report, l } = await closeWith((wt) => put(wt, work), { files: ['docs/x/.sources/app-notes.md'] });
  for (const [rel, text] of Object.entries(work)) assert.equal(fs.readFileSync(path.join(wt, rel), 'utf8'), text, rel);
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /3 ignored work file\(s\) \(docs\/x\/\.sources\//);
  assert.match(tree.todo, /move the work files to the Trash/);
  assert.match(report, /worktree\(s\) kept: .*ignored work file/);
  const rec = l.stages.close.result.cleanup.kept.find((k) => k.path.endsWith('app-notes.md'));
  assert.match(rec.reason, /^inside the worktree .*, kept with it$/);
  assert.doesNotMatch(JSON.stringify(l.stages.close.result.cleanup.kept), /outside the host repo/);
});

test('AC-5: a file on the cleanup.keep list keeps the worktree too; the build output alone does not', async () => {
  const kept = await closeWith((wt, fx, w) => {
    w.settings.cleanup.keep = [...(w.settings.cleanup.keep ?? []), '**/*.local.md'];
    put(wt, { 'docs/x/draft.local.md': 'mine\n' });
  });
  assert.equal(kept.tree.removed, false);
  assert.match(kept.tree.kept, /1 ignored work file\(s\) \(docs\/x\/draft\.local\.md\)/);
  const gone = await closeWith((wt) => put(wt, { 'build/index.html': '<html>', 'build/assets/a.js': 'x', '.docusaurus/client.js': 'x' }), { files: ['build'] });
  assert.deepEqual([gone.tree.removed, gone.tree.kept], [true, undefined]);
  assert.equal(fs.existsSync(gone.wt), false);
  // The recorded build folder went with the worktree: deleted by git, not in the Trash, and said so plainly.
  const cleanup = gone.l.stages.close.result.cleanup;
  assert.equal(cleanup.kept.find((k) => k.path.endsWith('build')), undefined, 'not reported as kept');
  assert.deepEqual(cleanup.deletedWithWorktree.map((d) => [d.path.endsWith('build'), canon(d.worktree)]), [[true, canon(gone.wt)]]);
  assert.match(gone.report, /deleted with the worktree, not in the Trash: `[^`]*build`/);
});

// Git quotes a non-ASCII path in line output (`".sources/\320\262…"`), so these are read with `-z`.
test('AC-5: a top-level .sources/ file with a Cyrillic name keeps the worktree, and survives', async () => {
  const { wt, tree } = await closeWith((wt) => put(wt, { '.sources/відео.mp4': 'video' }));
  assert.equal(fs.readFileSync(path.join(wt, '.sources/відео.mp4'), 'utf8'), 'video');
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /1 ignored work file\(s\) \(\.sources\/відео\.mp4\)/);
});

test('AC-5: a Cyrillic file a cleanup.keep glob matches keeps the worktree, and survives', async () => {
  const { wt, tree } = await closeWith((wt, fx, w) => {
    w.settings.cleanup.keep = [...(w.settings.cleanup.keep ?? []), '**/*.local.md'];
    put(wt, { 'docs/x/нотатки.local.md': 'mine\n' });
  });
  assert.equal(fs.readFileSync(path.join(wt, 'docs/x/нотатки.local.md'), 'utf8'), 'mine\n');
  assert.equal(tree.removed, false);
  assert.match(tree.kept, /1 ignored work file\(s\) \(docs\/x\/нотатки\.local\.md\)/);
});

test('listWorktrees reads a worktree path with Cyrillic letters and a double quote as it is', () => {
  const root = path.join(tmp('wt-names-'), 'Проєкти "доки"');
  const clone = gitRepo(path.join(root, 'repo'));
  clone.commit({ 'a.md': 'a\n' }, 'base');
  const wt = path.join(root, '.worktrees', 'гілка "1"');
  clone.g('worktree', 'add', '-q', '--detach', wt, 'HEAD');
  clone.g('worktree', 'lock', wt);
  const list = listWorktrees(clone.dir);
  assert.deepEqual(list.map((x) => [canon(x.path), x.locked]), [[canon(clone.dir), false], [canon(wt), true]]);
});

// Git prints a worktree path with a newline raw in line output, so only `-z` keeps it whole.
test('listWorktrees reads a worktree path with a newline in it as one path', () => {
  const root = tmp('wt-newline-');
  const clone = gitRepo(path.join(root, 'repo'));
  clone.commit({ 'a.md': 'a\n' }, 'base');
  const wt = path.join(root, '.worktrees', 'two\nlines');
  clone.g('worktree', 'add', '-q', '--detach', wt, 'HEAD');
  assert.deepEqual(listWorktrees(clone.dir).map((x) => canon(x.path)), [canon(clone.dir), canon(wt)]);
});

test('AC-4: a hand commit that changes an image with a Cyrillic name after ready for merge runs the pack again', async () => {
  const { out } = await afterReady({ 'docs/x/.assets/схема.png': 'uk v2', [`${EN}/x/.assets/схема.png`]: 'en v2' });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['resync', 'done'], ['visualPack', 'done'], ['readyForMerge', 'done']]);
});

test('AC-5: a worktree git refuses to remove (locked) is kept and reported with the same todo', async () => {
  const { fx, wt, tree, report } = await closeWith((wt, f) => f.clone.g('worktree', 'lock', wt));
  assert.equal(fs.existsSync(wt), true);
  assert.ok(listWorktrees(fx.clone.dir).some((x) => canon(x.path) === canon(wt)));
  assert.deepEqual([tree.removed, tree.error], [false, undefined]);
  assert.match(tree.kept, /git would not remove it \(locked\)/);
  assert.match(tree.todo, new RegExp(`worktree unlock ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`, then \`git -C .* worktree remove --force`));
  assert.match(report, /worktree\(s\) kept: .*git would not remove it/);
});

test('AC-5: a worktree at a head the pipeline pushed goes, although the forge deleted the branch after a squash merge', async () => {
  const { fx, wt, tree } = await closeWith((wt, f) => {
    execFileSync('git', ['-C', f.bare, 'branch', '-q', '-D', 'ticket-71']);
    f.clone.g('fetch', '-q', '--prune', 'origin');
  });
  assert.deepEqual(listWorktrees(fx.clone.dir).map((x) => canon(x.path)), [canon(fx.clone.dir)]);
  assert.deepEqual([tree.removed, tree.kept], [true, undefined]);
  assert.equal(fs.existsSync(wt), false);
});

test('AC-5: a recorded folder that is a repository of its own is kept whole, never split', async () => {
  const c = card({ number: 1503, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 73, state: 'merged' })] });
  gitRepo(w.root).commit({ '.gitignore': '.flow/\nclones/\n', 'docs/index.md': '# Host\n' });
  const app = gitRepo(path.join(w.root, 'clones', 'app'));
  app.commit({ 'src/a.js': 'a\n' });
  fs.writeFileSync(path.join(app.dir, 'scratch.txt'), 'untracked');
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'guide-docs', number: 73, targets: ['guide'], review: 'sme', stage: 'readyForMerge' }], files: [{ path: 'clones/app', kind: 'clone', bytes: 0, stage: 'plan', at: ago(30) }] });
  const trash = path.join(tmp('fake-trash-'), '.Trash');
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, trashDir: trash, now: () => NOW }, options: {} });
  assert.equal(fs.existsSync(path.join(app.dir, '.git')), true);
  assert.equal(fs.existsSync(path.join(app.dir, 'scratch.txt')), true);
  assert.equal(fs.existsSync(trash), false);
  assert.deepEqual(read(w, '1503').stages.close.result.cleanup.kept.map((k) => k.reason), ['a repository of its own: kept whole, never split']);
});

// A ready-for-merge PR, then a commit (a hand edit, or the pipeline's own with `pipeline`); the session stand-in
// records each model stage at the head it was given. A UA change sends the PR back to the owner's queue with no
// session (`first`); then, unless `move` is false, the owner moves the card to In translation and the run goes on
// (`out`, its follow left out).
async function afterReady(files, { pipeline = false, move = true } = {}) {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  const h2 = t.handEdit(files);
  t.forgePr.headCommit = h2;
  if (pipeline) {
    const l0 = read(t.w, '1501');
    l0.prs[0].pipelineCommits.push(h2);
    writeLedger(t.w.settings.state, l0);
  }
  const stages = [];
  const briefs = {};
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    stages.push(stage);
    briefs[stage] = briefOf(cmd);
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: h2, result: resultOf(cmd), now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const go = () => runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  const first = await go();
  const sessionsFirst = stages.length;
  const back = read(t.w, '1501');
  if (!move || back.prs[0].stage !== 'finalReview') return { t, h2, first, sessionsFirst, back, out: first, stages, briefs, l: back };
  t.c.placeId = LISTS.translation.id;
  const run2 = await go();
  const out = { ...run2, ran: run2.ran.filter((r) => !(r.stage === 'follow' || (r.stage === 'move' && !r.pr))) };
  return { t, h2, first, sessionsFirst, back, out, run2, stages, briefs, l: read(t.w, '1501') };
}

test('a UA change after ready for merge: back to the owner\'s queue with no session but the style check of the edit; the owner\'s move then re-syncs, and the card comes back', async () => {
  const { first, sessionsFirst, back, run2, t } = await afterReady({ 'docs/x/index.md': '# Сторінка\n\nВиправлений абзац.\n' });
  assert.deepEqual(first.ran.map((r) => [r.stage, r.outcome]), [['move', 'done'], ['styleCheck', 'done']]);
  assert.equal(sessionsFirst, 1, 'the style check of the owner\'s edit only');
  assert.deepEqual([back.prs[0].stage, back.left.status, back.prs[0].readyForMerge.length], ['finalReview', 'finalReview', 1]);
  assert.deepEqual(run2.ran.map((r) => r.stage), ['follow', 'resync', 'readyForMerge', 'move']);
  assert.equal(t.c.placeId, LISTS.finalReview.id, 'ready again: the card back in the owner\'s queue');
});

test('AC-4: a hand commit that changes an image after ready for merge: the re-sync, the visual pack, then ready again', async () => {
  const { t, h2, out, l } = await afterReady({ [UK_IMG]: 'uk v2', [EN_IMG]: 'en v2' });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['resync', 'done'], ['visualPack', 'done'], ['readyForMerge', 'done']]);
  const p = l.prs[0];
  assert.equal(p.chain.visualPack.head, h2);
  assert.deepEqual(p.readyForMerge.map((r) => r.head), [t.h1, h2]);
  assert.ok(p.readyForMerge.at(-1).at >= p.chain.visualPack.at && l.log.findIndex((e) => e.stage === 'readyForMerge' && e.seq > p.chain.visualPack.seq) >= 0, 'ready again only after the pack');
  // The worktree followed the owner's push.
  assert.equal(execFileSync('git', ['-C', t.wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), h2);
});

test('AC-4: a hand commit that changes only text after ready for merge: the re-sync, then ready again, with no pack', async () => {
  const { t, h2, out, l, briefs } = await afterReady({ 'docs/x/index.md': '# Сторінка\n\nВиправлений абзац.\n' });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['resync', 'done'], ['readyForMerge', 'done']]);
  assert.ok(briefs.resync.includes(`UA changed since ready for merge at ${t.h1}, and the owner moved the card to In translation: re-sync the blocks changed in ${t.h1}..${h2}, the whole range at once.`), "the session's brief names the range");
  assert.notEqual(l.prs[0].chain.visualPack.head, h2);
  assert.equal(l.prs[0].readyForMerge.at(-1).head, h2);
});

// What the owner's checkout shows: its branch, the local branches, HEAD, the working tree, a page and the tags, to
// prove the fetch of status changes none of it.
const checkoutOf = (clone) => ({
  branch: clone.g('symbolic-ref', '--short', 'HEAD'),
  local: clone.g('rev-parse', 'refs/heads/ticket-71'),
  main: clone.g('rev-parse', 'refs/heads/main'),
  head: clone.g('rev-parse', 'HEAD'),
  status: clone.g('status', '--porcelain'),
  page: fs.readFileSync(path.join(clone.dir, 'docs/x/index.md'), 'utf8'),
  tags: clone.g('tag', '-l'),
});

test('AC-1: a commit made on the forge after ready for merge is fetched by status and takes the hand-commit path; the owner\'s checkout is untouched', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  // Pushed from elsewhere (as an edit in the browser would be), and a tag on it, which status never brings in.
  const h2 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nПравка в браузері.\n' });
  execFileSync('git', ['-C', t.bare, 'tag', 'v-forge', h2]);
  t.forgePr.headCommit = h2;
  const before = checkoutOf(t.clone);
  assert.throws(() => t.clone.g('cat-file', '-e', `${h2}^{commit}`), 'not in the clone yet');
  // With no fetch, the head is noted as not fetched, and nothing is checked.
  const noFetch = { ...makeGit(t.w.settings), fetchHeads: () => [] };
  const blind = await t.w.one('1501', { git: noFetch });
  assert.equal(blind.next, null);
  assert.ok(blind.notes.some((n) => /is not fetched here/.test(n)), JSON.stringify(blind.notes));
  // A check that names other tickets fetches nothing for this one.
  await t.w.status({ git: makeGit(t.w.settings), only: ['1999'] });
  assert.throws(() => t.clone.g('cat-file', '-e', `${h2}^{commit}`), 'still not fetched');
  // Status's own fetch brings the head in: a UA change after ready, back to the owner's queue (D-112).
  const tk = await t.w.one('1501', { git: makeGit(t.w.settings) });
  assert.deepEqual([tk.next?.stage, tk.next?.to, tk.next?.uaChanged], ['move', 'finalReview', 1]);
  assert.equal(t.clone.g('rev-parse', 'refs/remotes/origin/ticket-71'), h2, 'into the remote-tracking ref');
  assert.deepEqual(checkoutOf(t.clone), before, 'no local branch, HEAD, file or tag changed');
});

// An image under the UA root is a UA change (back to the owner's queue, then the re-sync and the pack: the `afterReady`
// cases above, whose hand commits now reach the clone only by status's fetch). One outside it leaves UA alone.
test('AC-1: a commit made on the forge that changes an image outside the UA root: status fetches it, and the run takes the pack, then ready again, with no re-sync', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  const h2 = t.handEdit({ 'static/img/logo.png': 'logo v2' });
  t.forgePr.headCommit = h2;
  const stages = [];
  const spawnClaude = async (cmd) => {
    stages.push(stageOf(cmd));
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: stageOf(cmd), pr: 'guide-docs#71', status: 'done', head: h2, result: resultOf(cmd), now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.filter((r) => !(r.stage === 'move' && !r.pr)).map((r) => [r.stage, r.outcome]), [['visualPack', 'done'], ['readyForMerge', 'done']]);
  assert.deepEqual(stages, ['visualPack']);
  assert.equal(read(t.w, '1501').prs[0].readyForMerge.at(-1).head, h2);
});

test('fetchHeads: one fetch per clone and branch for a check; an origin that can\'t be reached leaves the head noted, and nothing throws', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  const h2 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nЩе правка.\n' });
  t.forgePr.headCommit = h2;
  const git = makeGit(t.w.settings);
  const target = t.w.settings.targets[0];
  const wanted = [{ target, branch: 'ticket-71', base: 'main', head: h2 }];
  assert.deepEqual(git.fetchHeads(wanted).map((f) => [f.fetched, f.refs]), [[true, ['+refs/heads/main:refs/remotes/origin/main', '+refs/heads/ticket-71:refs/remotes/origin/ticket-71']]]);
  assert.deepEqual(git.fetchHeads(wanted), [], 'not again in the same check');
  assert.deepEqual(makeGit(t.w.settings).fetchHeads(wanted), [], 'a head the clone has is never fetched');
  // Offline: the next commit can't be fetched; the rule notes it as before.
  const h3 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nОфлайн.\n' });
  t.forgePr.headCommit = h3;
  t.clone.g('remote', 'set-url', 'origin', path.join(tmp('gone-'), 'nowhere.git'));
  const runTried = new Set();
  assert.deepEqual(makeGit(t.w.settings, { asked: runTried }).fetchHeads([{ ...wanted[0], head: h3 }]).map((f) => f.fetched), [false]);
  assert.deepEqual(makeGit(t.w.settings, { asked: runTried }).fetchHeads([{ ...wanted[0], head: h3 }]), [], 'a run shares one set: not tried again in it');
  const tk = await t.w.one('1501', { git: makeGit(t.w.settings) });
  assert.ok(tk.notes.some((n) => /is not fetched here/.test(n)), JSON.stringify(tk.notes));
});

// The forge's "Update branch" after ready for merge: the base, with another PR's UA page, merged into the PR's branch.
function updateBranch(t, { ownEdit = false } = {}) {
  t.clone.g('checkout', '-q', 'main');
  t.clone.commit({ 'docs/y/other.md': '# Інша сторінка\n' }, 'Another PR, merged');
  t.clone.g('push', '-q', 'origin', 'main');
  t.clone.g('checkout', '-q', 'ticket-71');
  t.clone.g('merge', '-q', '--no-edit', 'main');
  if (ownEdit) t.clone.commit({ 'docs/x/index.md': '# Сторінка\n\nПравка власника.\n' }, 'Fix: by hand');
  t.clone.g('push', '-q', 'origin', 'ticket-71');
  return t.clone.g('rev-parse', 'HEAD');
}

test('a merge of the base into a ready PR (the forge\'s "Update branch") that brings another PR\'s UA page keeps it ready: no bounce to the owner\'s queue', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  t.forgePr.headCommit = updateBranch(t);
  const tk = await t.w.one('1501', { git: makeGit(t.w.settings) });
  assert.deepEqual([tk.next?.stage, tk.next?.head], ['readyForMerge', t.forgePr.headCommit]);
  // The plain count would have taken the other PR's page as this one's.
  assert.deepEqual(makeGit(t.w.settings).changedUnder(t.w.settings.targets[0], t.h1, t.forgePr.headCommit, ['docs/']), ['docs/y/other.md']);
  assert.deepEqual(makeGit(t.w.settings).changedUnder(t.w.settings.targets[0], t.h1, t.forgePr.headCommit, ['docs/'], 'main'), []);
});

test('a merge of the base plus the owner\'s edit of a PR page after ready: back to the owner\'s queue, counting only the PR\'s page', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  t.forgePr.headCommit = updateBranch(t, { ownEdit: true });
  const tk = await t.w.one('1501', { git: makeGit(t.w.settings) });
  assert.deepEqual([tk.next?.stage, tk.next?.to, tk.next?.uaChanged], ['move', 'finalReview', 1]);
});

test('changedUnder and pagesOf read a UA page with a Cyrillic name (which git quotes in line output)', () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  const page = 'docs/x/оплата "нова".md';
  const h2 = t.clone.commit({ [page]: '# Оплата\n' }, 'a Cyrillic page');
  t.clone.g('push', '-q', 'origin', 'HEAD:main');
  t.clone.g('fetch', '-q', 'origin');
  const git = makeGit(t.w.settings);
  const target = t.w.settings.targets[0];
  assert.deepEqual(git.changedUnder(target, t.h1, h2, ['docs/']), [page]);
  assert.ok(git.pagesOf(target).includes('x/оплата "нова"'), JSON.stringify(git.pagesOf(target)));
});

test('AC-3: record align is refused while a UA image changed without its EN counterpart, naming it; both changed passes', async () => {
  const t = finalReviewTicket({ done: CHAIN.slice(0, 3) });
  ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' });
  const h2 = t.handEdit({ [UK_IMG]: 'uk v2' });
  t.forgePr.headCommit = h2;
  ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' });
  const rec = () => runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: 'align', pr: 'guide-docs#71', status: 'done', head: t.forgePr.headCommit, result: { bugs: 0, warnings: 0 }, now: NOW });
  await assert.rejects(rec(), (e) => e.refused === 'imagePairs' && e.message.includes(`${UK_IMG} changed without ${EN_IMG}`));
  assert.equal(read(t.w, '1501').prs[0].chain.align, undefined, 'nothing written');
  t.forgePr.headCommit = t.handEdit({ [EN_IMG]: 'en v2' });
  ensureWorktree(t.w.settings, { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' });
  await rec();
  assert.match(read(t.w, '1501').prs[0].chain.align.imagePairs, /1 UA image\(s\) checked against origin\/main/);
});

test('AC-3: a hand commit after ready for merge that changes only a UA image: the re-sync and the pack, then ready is refused, naming it', async () => {
  const { out, l } = await afterReady({ [UK_IMG]: 'uk v2' });
  assert.deepEqual(out.ran.map((r) => r.stage), ['resync', 'visualPack', 'readyForMerge']);
  assert.equal(out.ran.at(-1).outcome, 'failed');
  assert.equal(l.prs[0].readyForMerge.length, 1, 'not ready again');
  assert.match(JSON.stringify(l), new RegExp(`${UK_IMG.replace(/\./g, '\\.')} changed without`));
});

test('a write session that ends by asking is done; one that asked and then recorded the write as failed is a failure', async () => {
  for (const failedToo of [false, true]) {
    const c = card({ number: 1502, status: 'inProgress' });
    const w = world({ cards: [c] });
    withClone(w);
    ledger(w, c, { stages: { start: 'done', plan: 'done' }, prs: [{ repo: 'guide-docs', targets: ['guide'], review: 'sme', branch: 'ticket-80', base: 'main' }] });
    const clients = w.clients();
    const spawnClaude = async (cmd) => {
      assert.equal(stageOf(cmd), 'write');
      c.placeId = LISTS.blocked.id;
      await runRecord({ settings: w.settings, clients, key: '1502', stage: 'questions', status: 'done', result: { questions: [{ id: 'q1', kind: 'fit', text: 'the block lists something else' }] }, now: NOW });
      if (failedToo) await runRecord({ settings: w.settings, clients, key: '1502', stage: 'write', status: 'failed', note: 'gave up after asking', now: NOW });
      return { code: 0, stdout: RESULT, stderr: '' };
    };
    const out = await runDaily({ settings: w.settings, clients, io: { readUsage: usage, now: () => NOW, spawnClaude }, options: {} });
    assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['write', failedToo ? 'failed' : 'done']]);
    assert.equal(read(w, '1502').stages.write?.status, failedToo ? 'failed' : undefined);
  }
});

test('record write is done only when the worktree holds commits beyond the base, pushed as they are; never for a page written in an owner\'s checkout', async () => {
  const c = card({ number: 1502, status: 'inProgress' });
  const w = world({ cards: [c] });
  const fx = withClone(w);
  const entry = { repo: 'guide-docs', targets: ['guide'], review: 'sme', branch: 'ticket-80', base: 'main' };
  ledger(w, c, { stages: { start: 'done', plan: 'done' }, prs: [entry] });
  const tree = ensureWorktree(w.settings, entry);
  const write = () => runRecord({ settings: w.settings, clients: w.clients(), key: '1502', stage: 'write', status: 'done', result: { prs: [{ repo: 'guide-docs', branch: 'ticket-80' }] }, now: NOW });
  const refusedWith = (re) => assert.rejects(write(), (e) => e.refused === 'notWritten' && re.test(e.message));
  // The plan's PRs are in the ledger, but a write names its own.
  await assert.rejects(runRecord({ settings: w.settings, clients: w.clients(), key: '1502', stage: 'write', status: 'done', result: {}, now: NOW }), (e) => e.refused === 'noPr');
  // The worktree as the runner made it: nothing written.
  await refusedWith(/no commit beyond origin\/main/);
  // The page written and committed in the owner's checkout instead: the worktree still holds nothing.
  fx.clone.commit({ 'docs/x/new.md': '# Нова\n' }, 'Written in the clone');
  await refusedWith(/no commit beyond origin\/main/);
  // Committed in the worktree, not pushed.
  fs.writeFileSync(path.join(tree.path, 'docs/x/new.md'), '# Нова\n');
  const g = (...a) => execFileSync('git', ['-C', tree.path, ...a], { encoding: 'utf8' }).trim();
  g('add', 'docs/x/new.md');
  g('-c', 'user.email=s@example.com', '-c', 'user.name=Session', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Write the page');
  await refusedWith(/ticket-80 is not on origin/);
  g('push', '-q', 'origin', 'HEAD:refs/heads/ticket-80');
  await write();
  assert.equal(read(w, '1502').stages.write.status, 'done');
  // One more commit, not pushed: origin is behind the worktree.
  commitIn(tree.path, 'docs/x/new.md', '# Нова\n\nЩе.\n');
  await refusedWith(/push the worktree's head/);
  // A PR with no worktree on this machine: the check can't run, so the write can't pass.
  fs.rmSync(path.join(path.dirname(tree.path)), { recursive: true });
  await refusedWith(/no worktree of guide-docs ticket-80/);
});

test('AC-3: record align with no worktree on this machine is refused, never skipped', async () => {
  const t = finalReviewTicket({ done: CHAIN.slice(0, 3) });
  assert.equal(fs.existsSync(t.wt), false);
  await assert.rejects(
    runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: 'align', pr: 'guide-docs#71', status: 'done', head: t.h1, result: { bugs: 0, warnings: 0 }, now: NOW }),
    (e) => e.refused === 'imagePairs' && /no worktree of guide-docs ticket-71/.test(e.message),
  );
  assert.equal(read(t.w, '1501').prs[0].chain.align, undefined, 'nothing written');
});

// ------------------------------------------------------------------ the end of the chain

test('after the chain: the card goes back to the owner\'s queue with one comment, which is no person\'s action; moving it on again starts no model step', async () => {
  const t = finalReviewTicket({ done: CHAIN });
  t.w.settings.readyComment = 'All set to merge';
  const go = () => runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: async () => assert.fail('a session started') }, options: { trigger: 'watcher', named: ['1501'] } });
  let out = await go();
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['readyForMerge', 'done'], ['move', 'done']]);
  assert.equal(t.c.placeId, LISTS.finalReview.id);
  let l = read(t.w, '1501');
  assert.deepEqual([l.prs[0].stage, l.left.status], ['readyForMerge', 'finalReview']);
  const said = t.w.tracker.log.filter((e) => e[0] === 'comment');
  assert.deepEqual(said.map((e) => e[2]), ['All set to merge']);
  assert.equal(l.posted.card.length, 1, "the comment is the pipeline's own");
  assert.deepEqual((await t.w.one('1501')).steps, []);

  // A person moves the finished card on again: follow (the ready PR stays ready), the card back. No session.
  t.c.placeId = LISTS.translation.id;
  out = await go();
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['follow', 'done'], ['move', 'done']]);
  assert.equal(t.c.placeId, LISTS.finalReview.id);
  l = read(t.w, '1501');
  assert.equal(l.prs[0].stage, 'readyForMerge');
  assert.deepEqual((await t.w.one('1501')).steps, []);
});

test('the end of the chain gives a PR its final review label back, at once, while the card waits for its other PR', async () => {
  const withTranslation = { targets: rawSettings().targets.map((x) => (x.id === 'guide' ? { ...x, labels: { ...x.labels, translation: 'In translation' } } : x)) };
  const t = finalReviewTicket({ done: CHAIN, extra: withTranslation });
  t.forgePr.labels = ['In translation'];
  // A second PR of the ticket, still in the chain: the card stays in In translation.
  const second = pr({ repo: 'guide-docs', number: 72, head: 'ticket-72', labels: ['In translation'] });
  t.w.forge.prs.push(second);
  const l0 = read(t.w, '1501');
  l0.prs.push({ ...l0.prs[0], number: 72, branch: 'ticket-72', pipelineCommits: [], chain: {} });
  writeLedger(t.w.settings.state, l0);
  assert.deepEqual(scriptedCalls({ stage: 'readyForMerge', pr: 'guide-docs#71', keys: ['1501'] }, l0, t.w.settings), ['forge set-stage-label --target guide --number 71 --stage finalReview']);
  const io = {
    readUsage: usage,
    now: () => NOW,
    ensureWorktree: (s, p) => (p.number === 72 ? { repo: p.repo, branch: p.branch, path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] } : ensureWorktree(s, p)),
    spawnClaude: async () => ({ code: 1, stdout: '', stderr: 'stop here' }),
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => r.stage).slice(0, 1), ['readyForMerge']);
  assert.ok(!out.ran.some((r) => r.stage === 'move'), 'the card stays with the PR still in the chain');
  assert.equal(t.c.placeId, LISTS.translation.id);
  assert.deepEqual([t.forgePr.labels, second.labels], [['In final review'], ['In translation']]);
  const l = read(t.w, '1501');
  assert.deepEqual(l.prs.map((p) => [p.stage, p.label ?? null]), [['readyForMerge', 'In final review'], ['translation', null]]);
});

test('a label the forge refuses at ready for merge is a warning: the step is done, its record stands', async () => {
  const withTranslation = { targets: rawSettings().targets.map((x) => (x.id === 'guide' ? { ...x, labels: { ...x.labels, translation: 'In translation' } } : x)) };
  const t = finalReviewTicket({ done: CHAIN, extra: withTranslation });
  t.forgePr.labels = ['In translation'];
  t.w.forge.changeLabels = async () => {
    throw new Error('the label request failed');
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: async () => assert.fail('a session started') }, options: { trigger: 'watcher', named: ['1501'] } });
  const ready = out.ran.find((r) => r.stage === 'readyForMerge');
  assert.equal(ready.outcome, 'done');
  assert.match(ready.warnings[0], /^guide-docs#71: the stage label for 'readyForMerge' was not set: .*the label request failed/);
  assert.equal(read(t.w, '1501').prs[0].stage, 'readyForMerge');
});

test('two PRs: the card goes back only when both are ready', async () => {
  const c = card({ number: 1505, status: 'translation' });
  const w = world({ cards: [c], prs: [pr({ repo: 'portal-docs', number: 91, head: 'a' }), pr({ repo: 'portal-docs', number: 92, head: 'b' })] });
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ repo: 'portal-docs', number: 91, branch: 'a', targets: ['portal-api'], review: 'places', stage: 'readyForMerge', readyForMerge: [{ head: 'a'.repeat(40), at: ago(1) }] }, { repo: 'portal-docs', number: 92, branch: 'b', targets: ['portal-ui'], review: 'sme', stage: 'translation' }] });
  const t = await w.one('1505');
  assert.deepEqual(t.steps.map((s) => s.stage), ['translate']);
  assert.equal(t.card.status, 'translation', 'it stands with the PR still in the chain');
});

// ------------------------------------------------------------------ a UA change after ready for merge

// An answer to a comment at ready for merge is the pipeline's own commit, so in `pipelineCommits` (`pipeline`).

test('a commit of the pipeline that changes UA after ready for merge: the owner\'s queue first; after the move, the re-sync, then ready for the new head', async () => {
  const { h2, first, sessionsFirst, out, l } = await afterReady({ 'docs/x/index.md': '# Сторінка\n\nВиправлено за коментарем.\n' }, { pipeline: true });
  assert.deepEqual([first.ran.map((r) => r.stage), sessionsFirst], [['move'], 0]);
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['resync', 'done'], ['readyForMerge', 'done']]);
  assert.equal(l.prs[0].readyForMerge.at(-1).head, h2);
  assert.equal(l.prs[0].stage, 'readyForMerge');
});

test('a commit of the pipeline that adds only heading ids after ready for merge keeps the PR ready (the id-only change)', async () => {
  const { out, l, t } = await afterReady({ 'docs/x/index.md': '# Сторінка {/* #page */}\n\nНовий абзац.\n' }, { pipeline: true });
  assert.deepEqual(out.ran, []);
  assert.equal(l.prs[0].stage, 'readyForMerge');
  assert.equal(l.prs[0].readyForMerge.at(-1).head, t.h1);
});

test('AC-5: several rounds of UA changes after ready for merge, then one move to In translation: one re-sync over the whole range', async () => {
  const { t, h2, stages, briefs } = await afterReady({ 'docs/x/index.md': '# Сторінка\n\nПерший раунд.\n' }, { pipeline: true, move: false });
  // A second round in the owner's queue: an answer to another comment, then the owner's own edit. Nothing runs.
  const h3 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nДругий раунд.\n' });
  const l0 = read(t.w, '1501');
  l0.prs[0].pipelineCommits.push(h3);
  writeLedger(t.w.settings.state, l0);
  const h4 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nТретій раунд, рукою.\n' });
  t.forgePr.headCommit = h4;
  // The group's lock, as another group's read checkout reads it, during each session.
  const lockStages = {};
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    stages.push(stage);
    briefs[stage] = briefOf(cmd);
    lockStages[stage] = allLocks(t.w.settings.state, NOW).filter((l) => l.live).map((l) => l.stage);
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: t.forgePr.headCommit, result: resultOf(cmd), now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const go = () => runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual((await go()).ran.map((r) => r.stage), ['styleCheck'], 'in the owner\'s queue, a new round starts nothing but the style check of the owner\'s own edit');
  assert.deepEqual(stages, ['styleCheck']);
  assert.ok(briefs.styleCheck.includes(`- ${h4}: docs/x/index.md`) && !briefs.styleCheck.includes(h3), 'the hand commit only, not the answer');
  t.c.placeId = LISTS.translation.id;
  const out = await go();
  assert.deepEqual(out.ran.map((r) => r.stage), ['follow', 'resync', 'readyForMerge', 'move']);
  assert.deepEqual(stages, ['styleCheck', 'resync'], 'one session after the move');
  assert.deepEqual(lockStages.resync, ['resync'], 'the lock, taken at follow, names the session\'s stage while it runs');
  assert.ok(briefs.resync.includes(`${t.h1}..${h4}`), 'from the head marked ready to the last round');
  assert.notEqual(h2, h4);
  const l = read(t.w, '1501');
  assert.deepEqual(l.prs[0].readyForMerge.map((r) => r.head), [t.h1, h4]);
  assert.equal(l.prs[0].approval.head, h4, 'the move approved what the owner read');
});

test('a hand edit at ready for merge and the owner\'s move in the same check: the move takes the PR along, and the re-sync runs', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  const h2 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nВиправлено й одразу передано.\n' });
  t.forgePr.headCommit = h2;
  t.c.placeId = LISTS.translation.id;
  const stages = [];
  const spawnClaude = async (cmd) => {
    stages.push(stageOf(cmd));
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: stageOf(cmd), pr: 'guide-docs#71', status: 'done', head: h2, result: resultOf(cmd), now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => r.stage), ['follow', 'styleCheck', 'resync', 'readyForMerge', 'move'], 'not sent back to the owner, who just moved it');
  assert.equal(out.ran[1].note, 'style check skipped: the card was moved on', 'the move approved the edit: the check is skipped, with a note');
  assert.deepEqual(stages, ['resync'], 'no style check session');
  assert.deepEqual(read(t.w, '1501').prs[0].styleChecked.map((x) => [x.sha, x.skipped]), [[h2, 'moved']]);
  assert.equal(t.c.placeId, LISTS.finalReview.id);
});

test('a hand commit after ready for merge that leaves UA alone: ready for its head, with no session', async () => {
  const { first, sessionsFirst, l, h2 } = await afterReady({ [`${EN}/x/index.md`]: '# Page\n\nEdited by hand.\n' });
  assert.deepEqual([first.ran.map((r) => r.stage), sessionsFirst], [['readyForMerge'], 0]);
  assert.equal(l.prs[0].readyForMerge.at(-1).head, h2);
});

// ------------------------------------------------------------------ code read at a fetched commit

function codeRepo(w) {
  const bare = path.join(tmp('code-origin-'), 'code-repo.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = gitRepo(path.join(w.root, 'repos', 'code-repo'));
  const h1 = clone.commit({ 'services/queue.go': 'const attempts = 10\n' }, 'base');
  clone.g('remote', 'add', 'origin', bare);
  clone.g('push', '-q', 'origin', 'main');
  // The owner's clone stays where it is; someone else moves origin on.
  const other = path.join(tmp('code-other-'), 'code-repo');
  execFileSync('git', ['clone', '-q', bare, other]);
  const og = (...a) => execFileSync('git', ['-C', other, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const advance = (text) => {
    fs.writeFileSync(path.join(other, 'services/queue.go'), text);
    og('-c', 'user.email=o@example.com', '-c', 'user.name=O', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'change');
    og('push', '-q', 'origin', 'main');
    return og('rev-parse', 'HEAD');
  };
  return { bare, clone, h1, advance, app: { repo: 'code-repo', path: 'repos/code-repo', base: 'main', url: 'https://code.example/org/code-repo' } };
}

test('a code repo is read at the commit fetched now, in the runner\'s own clone; one checkout per commit, the others removed only when no other session runs; the owner\'s clone is never touched', async () => {
  const w = world();
  const code = codeRepo(w);
  const owner = () => [code.clone.g('rev-parse', 'HEAD'), code.clone.g('rev-parse', 'refs/remotes/origin/main'), listWorktrees(code.clone.dir).length];
  const before = owner();
  const h2 = code.advance('const attempts = 4\n');
  const a = ensureCodeTree(w.settings, code.app, { remote: code.bare });
  assert.equal(a.error, undefined);
  assert.equal(a.commit, h2);
  assert.equal(a.path, codeTreePath(w.settings, code.app, h2));
  assert.equal(a.clone, codeClonePath(w.settings, code.app));
  assert.ok(a.path.startsWith(codeTreesRoot(w.settings)) && a.clone.startsWith(path.resolve(w.settings.state)), 'under the state folder');
  assert.equal(execFileSync('git', ['-C', a.clone, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim(), 'true', 'no working tree to read stale files from');
  assert.equal(fs.readFileSync(path.join(a.path, 'services/queue.go'), 'utf8'), 'const attempts = 4\n');
  assert.equal(fs.readFileSync(path.join(code.clone.dir, 'services/queue.go'), 'utf8'), 'const attempts = 10\n', 'the owner\'s clone keeps its own files');

  // Another session runs: a new commit gets its own checkout, and the first one stays.
  const h3 = code.advance('const attempts = 3\n');
  const b = ensureCodeTree(w.settings, code.app, { remote: code.bare, othersRunning: true });
  assert.equal(b.commit, h3);
  assert.notEqual(b.path, a.path);
  assert.equal(fs.readFileSync(path.join(b.path, 'services/queue.go'), 'utf8'), 'const attempts = 3\n');
  assert.equal(fs.readFileSync(path.join(a.path, 'services/queue.go'), 'utf8'), 'const attempts = 4\n', 'a session still reading the first one is not moved under');
  assert.deepEqual(b.removed, []);

  // No other session: only the checkout this one needs stays.
  const c = ensureCodeTree(w.settings, code.app, { remote: code.bare });
  assert.equal(c.path, b.path, 'the same commit: the same checkout');
  assert.deepEqual(c.removed.map(canon), [canon(a.path)]);
  assert.ok(!fs.existsSync(a.path));
  assert.ok(fs.existsSync(path.join(b.path, 'services/queue.go')));
  assert.deepEqual(owner(), before, 'no fetch, no worktree, no prune in the owner\'s clone');
});

test('a code repo that can\'t be fetched, cloned, or has no url is said, and stops nothing', async () => {
  const w = world();
  const code = codeRepo(w);
  const first = ensureCodeTree(w.settings, code.app, { remote: code.bare });
  execFileSync('git', ['-C', first.clone, 'remote', 'set-url', 'origin', '/nowhere/at/all.git']);
  code.advance('const attempts = 2\n');
  const a = ensureCodeTree(w.settings, code.app, { remote: code.bare });
  assert.equal(a.commit, code.h1, 'the commit fetched last time');
  assert.match(a.notes.join(' '), /could not fetch main/);
  const none = ensureCodeTree(w.settings, { repo: 'other', path: null, base: 'main', url: null });
  assert.match(none.error, /no url for other/);
  const bad = ensureCodeTree(w.settings, { repo: 'gone', path: null, base: 'main', url: 'https://code.example/org/gone' }, { remote: '/nowhere/at/all.git' });
  assert.match(bad.error, /could not clone gone/);
});

test('a writer\'s session gets the checkout and the commit; every role is denied the clone\'s own files', () => {
  const w = world();
  w.settings.appRepos = [{ repo: 'code-repo', path: 'repos/code-repo', base: 'main', url: 'https://code.example/org/code-repo' }];
  const clone = path.join(w.settings.root, 'repos/code-repo');
  const tree = codeTreePath(w.settings, w.settings.appRepos[0], 'c0ffee1');
  const step = { stage: 'plan', role: 'writer', keys: ['1'], group: '1', codeTrees: [{ repo: 'code-repo', path: tree, commit: 'c0ffee1', url: 'https://code.example/org/code-repo', notes: [] }] };
  const cmd = commandFor(step, w.settings, { model: 'm', agentsPath: '/a.json', roots: [] });
  const brief = briefOf(cmd);
  assert.match(brief, /commit c0ffee1/);
  assert.match(brief, /https:\/\/code\.example\/org\/code-repo\/blob\/c0ffee1\/<path>#L<from>-L<to>/);
  const after = (flag) => cmd.args.slice(cmd.args.indexOf(flag) + 1);
  assert.ok(cmd.args.includes(tree), 'the checkout is an added folder');
  assert.ok(after('--disallowedTools').includes(`Read(//${clone.replace(/^\/+/, '')}/**)`), 'the clone is denied');
  assert.ok(after('--disallowedTools').includes(`Edit(//${codeTreesRoot(w.settings).replace(/^\/+/, '')}/**)`), 'the checkouts are read only');
  assert.ok(after('--allowedTools').includes(`Bash(git -C ${tree} show:*)`));
  const translator = commandFor({ stage: 'build', role: 'translator', keys: ['1'], group: '1', pr: 'x#1', worktrees: [] }, w.settings, { model: 'm', agentsPath: '/a.json', roots: [] });
  assert.ok(!translator.args.includes(tree));
  assert.ok(translator.args.includes(`Read(//${clone.replace(/^\/+/, '')}/**)`));
});

test('an answer pushed while the owner moved a ready card to In translation is not taken along: the owner reads it first, nothing is translated', async () => {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  // The answer session's commit (the pipeline's own: in pipelineCommits), pushed while the owner moved the card.
  const h2 = t.handEdit({ 'docs/x/index.md': '# Сторінка\n\nКоротше, як просив власник.\n' });
  t.forgePr.headCommit = h2;
  const l0 = read(t.w, '1501');
  l0.prs[0].pipelineCommits.push(h2);
  writeLedger(t.w.settings.state, l0);
  t.c.placeId = LISTS.translation.id;
  const stages = [];
  const spawnClaude = async (cmd) => {
    stages.push(stageOf(cmd));
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: stageOf(cmd), pr: 'guide-docs#71', status: 'done', head: h2, result: resultOf(cmd), now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const go = () => runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  const out = await go();
  assert.deepEqual(out.ran.map((r) => [r.stage, r.pr ?? null, r.outcome]), [['follow', null, 'done'], ['move', 'guide-docs#71', 'done']]);
  assert.deepEqual(stages, [], 'no re-sync of a rewrite the owner never read');
  assert.ok(!t.w.tracker.log.some((e) => e[0] === 'comment'), 'not said ready: it goes back to the owner');
  const l = read(t.w, '1501');
  assert.equal(l.prs[0].stage, 'finalReview');
  assert.equal(l.prs[0].approval ?? null, null, 'the move approved nothing it did not see');
  assert.equal(t.c.placeId, LISTS.finalReview.id, "the card back in the owner's queue");
  // The owner reads it and moves the card again: now the re-sync runs.
  t.c.placeId = LISTS.translation.id;
  const again = await go();
  assert.deepEqual(again.ran.map((r) => r.stage), ['follow', 'resync', 'readyForMerge', 'move']);
  assert.equal(read(t.w, '1501').prs[0].approval.head, h2);
});

// A step with no worktree (the plan, the answers, a start) reads pages in a read checkout of each target clone at
// `origin/<base>`, never in the owner's working tree; with none, the clone as it stands, and one off its base or behind
// its origin is said in the brief, with how to read the base. Nothing is held for either.
function planTicket({ onBase = true, behind = 0, status = 'inProgress', stages = { start: 'done' }, left = 'same', targets = ['guide'] } = {}) {
  const c = card({ number: 1601, status });
  const w = world({ cards: [c] });
  const fx = withClone(w);
  if (onBase) fx.clone.g('checkout', '-q', 'main');
  // Merged on the forge: on origin, not in the clone's own main.
  if (behind) {
    for (let i = 0; i < behind; i++) fx.clone.commit({ [`docs/merged-${i}.md`]: '# Злито\n' }, `merged ${i}`);
    fx.clone.g('push', '-q', 'origin', 'main');
    fx.clone.g('reset', '-q', '--hard', `HEAD~${behind}`);
  }
  ledger(w, c, { stages, left, triage: { verdict: 'docs-required', targets, size: 'edit' } });
  return { w, c, ...fx };
}

// Each session's brief, folders (`--add-dir`) and, read while it runs, the page in each folder it may reach.
const briefsOf = async (t) => {
  const briefs = [];
  const sessions = [];
  const spawnClaude = async (cmd) => {
    briefs.push(briefOf(cmd));
    const dirs = cmd.args.flatMap((a, i) => (a === '--add-dir' ? [cmd.args[i + 1]] : []));
    const pages = Object.fromEntries(dirs.filter((d) => fs.existsSync(path.join(d, 'docs/x/index.md'))).map((d) => [d, pageIn(d)]));
    sessions.push({ brief: briefOf(cmd), dirs, pages });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1601'] } });
  return { out, briefs, sessions };
};
const readCheckoutOf = (t) => path.join(path.dirname(t.clone.dir), '.worktrees', 'guide-docs', '.read', 'guide');

test('a plan step with the target clone on another branch runs on a read checkout at origin/<base>: in its folders with the base\'s page, named in the brief, with no off-base note; the clone never moves', async () => {
  const t = planTicket({ onBase: false });
  const before = t.clone.g('rev-parse', 'HEAD');
  const { briefs, sessions } = await briefsOf(t);
  assert.ok(briefs.length >= 1, 'the session started: an off-base clone holds nothing');
  const rc = readCheckoutOf(t);
  assert.ok(sessions[0].dirs.includes(rc), 'the read checkout is one of the session\'s folders');
  assert.equal(sessions[0].pages[rc], '# Сторінка\n', 'origin/main\'s page, not the branch draft');
  assert.match(sessions[0].pages[t.clone.dir], /Новий абзац/, 'the clone\'s working tree is the owner\'s draft, and the brief doesn\'t send the session there');
  assert.match(briefs[0], new RegExp(`Read checkouts \\(the runner made them[^\\n]*never the clone[^\\n]*\\n- guide-docs: ${rc}, origin/main at ${t.clone.g('rev-parse', '--short=7', 'origin/main')}; its clone: ${t.clone.dir}\\.`));
  assert.doesNotMatch(briefs[0], /Target clones|on the branch ticket-71|show origin\/main:<path>/, 'no off-base note with a read checkout');
  assert.deepEqual([t.clone.g('symbolic-ref', '--short', 'HEAD'), t.clone.g('rev-parse', 'HEAD')], ['ticket-71', before], 'the runner never moves the clone');
  assert.equal(t.clone.g('status', '--porcelain', '--untracked-files=no'), '');
  // A detached HEAD is off its base too.
  t.clone.g('checkout', '-q', '--detach', 'main');
  const c = checkClone(t.w.settings, t.w.settings.targets[0]);
  assert.equal(c.off, true);
  assert.match(c.notes.join(' '), /at a detached HEAD \(\w+\), not on its base main/);
});

test('a second run re-points the read checkout at the base merged since, unless another plan session may be reading it; one the runner can\'t make leaves the session on the clone with its off-base note, said in the run log', async () => {
  const t = planTicket({ onBase: false });
  const before = t.clone.g('rev-parse', 'HEAD');
  const first = await briefsOf(t);
  const rc = readCheckoutOf(t);
  assert.ok(first.sessions[0].dirs.includes(rc));
  const merged = mergeOnForge(t.bare, { 'docs/x/index.md': '# Сторінка\n\nЗлито.\n' });
  fs.writeFileSync(path.join(rc, 'marker.local.md'), 'from the first run\n');
  // The plan step is due again (the stand-in session recorded nothing): a fresh ledger at the same stage.
  const again = () => ledger(t.w, t.c, { stages: { start: 'done' }, left: 'same', triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  again();
  // Another group's session on a worktree stage reads no read checkout: it doesn't keep this one from moving.
  takeLock(t.w.settings.state, { group: 'other-write', kind: 'schedule', stage: 'write', leaseMinutes: 120, now: NOW });
  const second = await briefsOf(t);
  releaseLock(t.w.settings.state, 'other-write');
  assert.ok(second.sessions.length >= 1);
  assert.equal(second.sessions[0].pages[rc], '# Сторінка\n\nЗлито.\n', 'the page merged since');
  assert.match(second.briefs[0], new RegExp(`- guide-docs: ${rc}, origin/main at ${merged.slice(0, 7)};`));
  assert.ok(fs.existsSync(path.join(rc, 'marker.local.md')), 'the same folder, re-pointed, not made again');
  assert.equal(listWorktrees(t.clone.dir).filter((x) => canon(x.path) === canon(rc)).length, 1);
  assert.deepEqual([t.clone.g('symbolic-ref', '--short', 'HEAD'), t.clone.g('rev-parse', 'HEAD')], ['ticket-71', before], 'the clone never moves');
  // Another group's plan session may be reading it: a newer base leaves it where it is, and this session reads the clone.
  mergeOnForge(t.bare, { 'docs/y.md': '# Нова\n' });
  takeLock(t.w.settings.state, { group: 'other-plan', kind: 'schedule', stage: 'plan', leaseMinutes: 120, now: NOW });
  again();
  const busy = await briefsOf(t);
  releaseLock(t.w.settings.state, 'other-plan');
  assert.ok(busy.sessions.length >= 1);
  assert.equal(t.clone.g('-C', rc, 'rev-parse', 'HEAD'), merged, 'not moved under the other session');
  assert.match(busy.briefs[0], /- guide-docs: .*guide-docs; no read checkout \(another session may be reading it, so it stays at \w{7}\); on the branch ticket-71/);
  // Its folder taken by something else (a person's files, say): no read checkout, and the step still runs, on the
  // clone with today's note; the run log says why.
  t.clone.g('worktree', 'remove', '--force', rc);
  fs.mkdirSync(rc, { recursive: true });
  fs.writeFileSync(path.join(rc, 'notes.md'), 'not a checkout\n');
  again();
  const third = await briefsOf(t);
  assert.ok(third.sessions.length >= 1, 'never blocks the step');
  assert.ok(!third.sessions[0].dirs.includes(rc));
  assert.ok(third.sessions[0].dirs.includes(t.clone.dir));
  assert.match(third.briefs[0], /Target clones, read as they stand \(the runner never moves them\):\n- guide-docs: .*guide-docs; no read checkout \(.*exists and is not a read checkout of guide-docs: move it away, and the next step makes it again\); on the branch ticket-71, not on its base main: its files are that branch's, not the site's; read pages with `git -C .*guide-docs show origin\/main:<path>`, never its working tree\./);
  assert.doesNotMatch(third.briefs[0], /Read checkouts/);
  assert.deepEqual(third.out.log.filter((e) => e.kind === 'readCheckout').map((e) => [e.stage, e.repo, e.outcome]), [['plan', 'guide-docs', 'failed']]);
  assert.match(third.out.log.find((e) => e.kind === 'readCheckout').note, /^no read checkout of guide-docs, so the session reads its clone: .*exists and is not a read checkout/);
  assert.equal(fs.readFileSync(path.join(rc, 'notes.md'), 'utf8'), 'not a checkout\n', 'nothing of it touched');
});

test('a start of an owner\'s card in the ready status reads the target its label names in a read checkout, and a ticket that names no target gets none', async () => {
  const c = card({ number: 1602, status: 'ready', labels: ['Guide'] });
  const w = world({ cards: [c] });
  withClone(w);
  const briefs = [];
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude: async (cmd) => (briefs.push(briefOf(cmd)), { code: 0, stdout: RESULT, stderr: '' }) }, options: {} });
  assert.deepEqual(read(w, '1602').triage.targets, ['guide'], 'the start recorded the target before the check');
  assert.match(briefs[0], /Stage `start`[\s\S]*Read checkouts[^\n]*\n- guide-docs: .*read\/guide, origin\/main at \w{7}; its clone: /);
  const none = planTicket({ onBase: false, targets: [] });
  const { briefs: b2, sessions } = await briefsOf(none);
  assert.doesNotMatch(b2[0], /Target clones|Read checkouts/, 'no target named: no clone checked');
  assert.ok(!sessions[0].dirs.includes(readCheckoutOf(none)));
});

test('a plan step with the target clone on its base but behind origin reads the pages merged since in its read checkout; the clone stays behind', async () => {
  const t = planTicket({ behind: 2 });
  const { briefs, sessions } = await briefsOf(t);
  assert.ok(briefs.length >= 1, 'the session started');
  const rc = readCheckoutOf(t);
  assert.ok(sessions[0].dirs.includes(rc));
  assert.equal(pageIn(rc, 'docs/merged-1.md'), '# Злито\n', 'the newer page is in the read checkout');
  assert.ok(!fs.existsSync(path.join(t.clone.dir, 'docs/merged-1.md')));
  assert.match(briefs[0], new RegExp(`- guide-docs: ${rc}, origin/main at ${t.clone.g('rev-parse', '--short=7', 'origin/main')}; its clone: `));
  assert.doesNotMatch(briefs[0], /Target clones|behind origin/);
  assert.equal(t.clone.g('rev-list', '--count', 'HEAD..origin/main'), '2', 'still behind: never pulled');
  // At origin's base, it reads the read checkout all the same, with no note.
  const u = planTicket();
  const { briefs: seen } = await briefsOf(u);
  assert.match(seen[0], /Read checkouts/);
  assert.doesNotMatch(seen[0], /Target clones|could not fetch/);
});

test('the translation label on a ready PR: taken along by the owner\'s move it is in translation for the re-sync and back in the final review at ready; sent back by row 8 it never leaves the final review', async () => {
  const withTranslation = { targets: rawSettings().targets.map((x) => (x.id === 'guide' ? { ...x, labels: { ...x.labels, translation: 'In translation' } } : x)) };
  for (const pipeline of [false, true]) {
    const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge', extra: withTranslation });
    t.forgePr.labels = ['In final review'];
    const h2 = t.handEdit({ 'docs/x/index.md': `# Сторінка\n\nВиправлено${pipeline ? ' відповіддю' : ''}.\n` });
    t.forgePr.headCommit = h2;
    if (pipeline) {
      const l0 = read(t.w, '1501');
      l0.prs[0].pipelineCommits.push(h2);
      writeLedger(t.w.settings.state, l0);
    }
    t.c.placeId = LISTS.translation.id;
    const seen = [];
    const spawnClaude = async (cmd) => {
      seen.push([stageOf(cmd), [...t.forgePr.labels]]);
      await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: stageOf(cmd), pr: 'guide-docs#71', status: 'done', head: h2, result: resultOf(cmd), now: NOW });
      return { code: 0, stdout: RESULT, stderr: '' };
    };
    const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
    const changes = t.w.forge.log.filter((e) => e[0] === 'changeLabels').map((e) => [e[3], e[4]]);
    if (!pipeline) {
      assert.deepEqual(out.ran.map((r) => r.stage), ['follow', 'styleCheck', 'resync', 'readyForMerge', 'move']);
      assert.deepEqual(seen, [['resync', ['In translation']]], 'taken along: in translation for the re-sync; the style check skipped, with no session');
      assert.deepEqual(changes, [[['In translation'], ['In final review']], [['In final review'], ['In translation']]]);
    } else {
      // An answer the owner hasn't read: not taken, back to the owner's queue (row 8), the label untouched.
      assert.deepEqual(out.ran.map((r) => [r.stage, r.pr ?? null]), [['follow', null], ['move', 'guide-docs#71']]);
      assert.deepEqual(seen, []);
      assert.deepEqual(changes, [], 'never in translation');
    }
    assert.deepEqual([t.forgePr.labels, read(t.w, '1501').prs[0].label], [['In final review'], 'In final review']);
  }
});

// The read checkout (lib/worktree.mjs, `ensureReadCheckout`): a step with no worktree reads pages at `origin/<base>`,
// in a detached worktree of the clone under the state folder, never in the owner's working tree.
// A merge on the forge: a commit on origin's base the clone hasn't fetched.
function mergeOnForge(bare, files) {
  const d = path.join(tmp('forge-'), 'merge');
  execFileSync('git', ['clone', '-q', bare, d]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('add', '-A');
  g('-c', 'user.email=f@example.com', '-c', 'user.name=Forge', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Merged on the forge');
  g('push', '-q', 'origin', 'HEAD:main');
  return g('rev-parse', 'HEAD');
}
const pageIn = (dir, rel = 'docs/x/index.md') => fs.readFileSync(path.join(dir, rel), 'utf8');

test('the read checkout is a detached worktree of the clone at origin/<base> beside the ticket worktrees; the next run re-points the same folder, and the clone never moves', () => {
  const t = planTicket({ onBase: false });
  const target = t.w.settings.targets[0];
  const before = t.clone.g('rev-parse', 'HEAD');
  checkClone(t.w.settings, target);
  const r = ensureReadCheckout(t.w.settings, target);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.path, path.join(path.dirname(t.clone.dir), '.worktrees', 'guide-docs', '.read', 'guide'), 'beside the ticket worktrees, outside every repo');
  assert.deepEqual([r.commit, r.ref], [t.clone.g('rev-parse', 'origin/main'), 'origin/main']);
  assert.equal(pageIn(r.path), '# Сторінка\n', 'the base\'s page, not the branch draft in the clone');
  assert.match(pageIn(t.clone.dir), /Новий абзац/, 'the clone keeps its draft');
  // A merge on the forge: the next run's fetch brings it, and the same folder moves to it.
  const merged = mergeOnForge(t.bare, { 'docs/x/index.md': '# Сторінка\n\nЗлито.\n' });
  fs.writeFileSync(path.join(r.path, 'marker.local.md'), 'left by the first run\n');
  checkClone(t.w.settings, target);
  const again = ensureReadCheckout(t.w.settings, target);
  assert.deepEqual([again.path, again.commit, again.error], [r.path, merged, undefined]);
  assert.equal(pageIn(again.path), '# Сторінка\n\nЗлито.\n');
  assert.ok(fs.existsSync(path.join(r.path, 'marker.local.md')), 're-pointed, not made again');
  assert.equal(listWorktrees(t.clone.dir).filter((x) => canon(x.path) === canon(r.path)).length, 1);
  assert.deepEqual([t.clone.g('symbolic-ref', '--short', 'HEAD'), t.clone.g('rev-parse', 'HEAD')], ['ticket-71', before], 'the clone never moves');
  assert.equal(t.clone.g('status', '--porcelain', '--untracked-files=no'), '');
});

test('the read checkout of a clone behind origin has the page merged since; one with changes to tracked files is made again; while another session runs, one at another commit stays', () => {
  const t = planTicket({ behind: 2 });
  const target = t.w.settings.targets[0];
  checkClone(t.w.settings, target);
  const r = ensureReadCheckout(t.w.settings, target);
  assert.equal(pageIn(r.path, 'docs/merged-1.md'), '# Злито\n');
  assert.ok(!fs.existsSync(path.join(t.clone.dir, 'docs/merged-1.md')), 'the clone stays behind');
  // A change to a tracked file (a session can't write here, a person might): gone at the next run.
  fs.writeFileSync(path.join(r.path, 'docs/x/index.md'), 'changed\n');
  const clean = ensureReadCheckout(t.w.settings, target);
  assert.deepEqual([clean.error, pageIn(clean.path)], [undefined, '# Сторінка\n']);
  // Another session may be reading it: a newer base doesn't move it under that session.
  const merged = mergeOnForge(t.bare, { 'docs/y.md': '# Нова\n' });
  checkClone(t.w.settings, target);
  const held = ensureReadCheckout(t.w.settings, target, { othersRunning: true });
  assert.match(held.error, /another session may be reading it, so it stays at \w{7}/);
  assert.ok(!fs.existsSync(path.join(r.path, 'docs/y.md')));
  assert.equal(ensureReadCheckout(t.w.settings, target).commit, merged, 'alone again, it moves');
  // Its folder gone (removed by hand): the stale registration is pruned and the read checkout made again.
  fs.rmSync(r.path, { recursive: true, force: true });
  const back = ensureReadCheckout(t.w.settings, target);
  assert.deepEqual([back.error, back.commit, pageIn(back.path, 'docs/y.md')], [undefined, merged, '# Нова\n']);
  assert.equal(listWorktrees(t.clone.dir).filter((x) => canon(x.path) === canon(r.path)).length, 1);
});

test('no read checkout when its folder holds something else, the base was never fetched or the target id is no plain name: an error, and nothing touched', () => {
  const t = planTicket({ onBase: false });
  const target = t.w.settings.targets[0];
  const rc = readCheckoutPath(t.w.settings, target);
  fs.mkdirSync(rc, { recursive: true });
  fs.writeFileSync(path.join(rc, 'notes.md'), 'not a checkout\n');
  assert.match(ensureReadCheckout(t.w.settings, target).error, /exists and is not a read checkout of guide-docs/);
  assert.equal(fs.readFileSync(path.join(rc, 'notes.md'), 'utf8'), 'not a checkout\n');
  assert.match(ensureReadCheckout(t.w.settings, { ...target, id: 'other', base: 'release' }).error, /no origin\/release fetched/);
  assert.match(ensureReadCheckout(t.w.settings, { ...target, id: '../x' }).error, /not a plain name/);
  assert.equal(listWorktrees(t.clone.dir).length, 1, 'no worktree registered');
});

test('no read checkout under a .sources/ folder (a write rule for the evidence would reach its pages); one made before it was sparse is made again', () => {
  const t = planTicket({ onBase: false });
  const target = t.w.settings.targets[0];
  // A clone kept under a `.sources/` folder: its read checkout would be too.
  const under = path.join(t.w.root, 'docs', '.sources', 'clones', 'guide-docs');
  execFileSync('git', ['clone', '-q', t.bare, under]);
  assert.match(ensureReadCheckout(t.w.settings, { ...target, path: 'docs/.sources/clones/guide-docs' }).error, /is under a \.sources\/ folder, where a write rule for the evidence would reach its pages/);
  assert.equal(listWorktrees(under).length, 1);
  // An older read checkout, full (no sparse patterns): made again, sparse.
  const rc = readCheckoutPath(t.w.settings, target);
  t.clone.g('worktree', 'add', '-q', '--detach', rc, 'origin/main');
  fs.writeFileSync(path.join(rc, 'marker.local.md'), 'old\n');
  assert.equal(ensureReadCheckout(t.w.settings, target, { othersRunning: true }).error, 'another session may be reading it, so it stays as it is (made before it was sparse)');
  const r = ensureReadCheckout(t.w.settings, target);
  assert.equal(r.error, undefined);
  assert.ok(!fs.existsSync(path.join(rc, 'marker.local.md')), 'made again');
  assert.equal(fs.readFileSync(path.join(execFileSync('git', ['-C', rc, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), 'info', 'sparse-checkout'), 'utf8'), '/*\n!.sources/\n');
});

test('a clone that moved gets a read checkout of its own; one cloned again in the same place finds the old folder and is told how to clear it', () => {
  const t = planTicket({ onBase: false });
  const target = t.w.settings.targets[0];
  const rc = ensureReadCheckout(t.w.settings, target).path;
  // The same repo, cloned again elsewhere, and the settings pointed at it: its read checkout sits beside it.
  const moved = path.join(t.w.root, 'repos', 'guide-docs-2');
  execFileSync('git', ['clone', '-q', t.bare, moved]);
  const r2 = ensureReadCheckout(t.w.settings, { ...target, path: 'repos/guide-docs-2' });
  assert.deepEqual([r2.error, r2.path], [undefined, path.join(t.w.root, 'repos', '.worktrees', 'guide-docs-2', '.read', 'guide')]);
  // The clone thrown away and cloned again in its place: the old folder is a worktree of a repo that is gone.
  fs.rmSync(t.clone.dir, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', t.bare, t.clone.dir]);
  assert.match(ensureReadCheckout(t.w.settings, target).error, /exists and is not a read checkout of guide-docs: a worktree of a clone that is gone; move the folder to the Trash, and the next step makes it again/);
  // Registered to another clone of the repo (a path changed back and forth): the command that clears it.
  fs.rmSync(rc, { recursive: true, force: true });
  execFileSync('git', ['-C', moved, 'worktree', 'add', '-q', '--detach', rc]);
  assert.match(ensureReadCheckout(t.w.settings, target).error, new RegExp(`it is a worktree of [^ ]*/repos/guide-docs-2 \\(did targets\\[\\]\\.path change\\?\\); clear it with \`git -C [^ ]*/repos/guide-docs-2 worktree remove --force ${rc}\``));
  execFileSync('git', ['-C', moved, 'worktree', 'remove', '--force', rc]);
  assert.equal(ensureReadCheckout(t.w.settings, target).error, undefined, 'made again');
});

test('a .sources/ folder git tracks is left out of the read checkout (sparse) and linked like the others: the tracked and the untracked files as the clone has them; the owner\'s clone keeps its own config and checkout', () => {
  const t = planTicket({ onBase: true });
  const target = t.w.settings.targets[0];
  // A section whose `.sources/` git tracks (a README, an interview), on origin's base; the clone's `.gitignore` names
  // `.sources/`, so it is added by force, as a host that tracks a few does.
  fs.mkdirSync(path.join(t.clone.dir, 'docs/archive/.sources'), { recursive: true });
  fs.writeFileSync(path.join(t.clone.dir, 'docs/archive/index.md'), '# Архів\n');
  fs.writeFileSync(path.join(t.clone.dir, 'docs/archive/.sources/README.md'), 'tracked readme\n');
  fs.writeFileSync(path.join(t.clone.dir, 'docs/archive/.sources/sme-interview.md'), 'tracked interview\n');
  t.clone.g('add', '-f', 'docs/archive');
  t.clone.g('commit', '-q', '-m', 'archive with tracked sources');
  t.clone.g('push', '-q', 'origin', 'main');
  // The owner's evidence beside them, untracked, and an edit of a tracked one not committed yet.
  fs.writeFileSync(path.join(t.clone.dir, 'docs/archive/.sources/notes.md'), 'owner notes\n');
  fs.writeFileSync(path.join(t.clone.dir, 'docs/archive/.sources/README.md'), 'tracked readme, owner edit\n');
  const configBefore = fs.readFileSync(path.join(t.clone.dir, '.git', 'config'), 'utf8');
  const statusBefore = t.clone.g('status', '--porcelain');
  checkClone(t.w.settings, target);
  const r = ensureReadCheckout(t.w.settings, target);
  assert.equal(r.error, undefined, r.error);
  const link = path.join(r.path, 'docs/archive/.sources');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'a link, not the tracked folder');
  assert.deepEqual(fs.readdirSync(link).sort(), ['README.md', 'notes.md', 'sme-interview.md']);
  assert.equal(pageIn(r.path, 'docs/archive/.sources/README.md'), 'tracked readme, owner edit\n', 'as the clone has it');
  assert.equal(pageIn(r.path, 'docs/archive/index.md'), '# Архів\n', 'the page is there');
  const rg = (...a) => execFileSync('git', ['-C', r.path, ...a], { encoding: 'utf8' }).trim();
  assert.equal(rg('status', '--porcelain', '--untracked-files=no'), '', 'a plain git status there (as a session runs it) is clean');
  assert.match(rg('ls-files', '-t', 'docs/archive/.sources'), /^S docs\/archive\/\.sources\/README\.md$/m, 'left out by its index bit');
  assert.equal(rg('show', 'HEAD:docs/archive/.sources/README.md'), 'tracked readme', 'git show still reads the committed one');
  // A write through the link lands in the clone; re-pointed at a newer base, the link and the owner's files stay.
  fs.writeFileSync(path.join(link, 'section-readiness.json'), '{}\n');
  const merged = mergeOnForge(t.bare, { 'docs/archive/index.md': '# Архів\n\nНове.\n', 'docs/archive/.sources/README.md': 'tracked readme v2\n' });
  checkClone(t.w.settings, target);
  const again = ensureReadCheckout(t.w.settings, target);
  assert.deepEqual([again.error, again.commit], [undefined, merged]);
  assert.equal(pageIn(again.path, 'docs/archive/index.md'), '# Архів\n\nНове.\n');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(pageIn(t.clone.dir, 'docs/archive/.sources/README.md'), 'tracked readme, owner edit\n', 'git never wrote through the link');
  assert.equal(pageIn(t.clone.dir, 'docs/archive/.sources/section-readiness.json'), '{}\n');
  assert.equal(rg('status', '--porcelain', '--untracked-files=no'), '');
  // Made again (a change to a tracked page): still sparse, still linked, and the clone's files untouched.
  fs.writeFileSync(path.join(again.path, 'docs/archive/index.md'), 'changed\n');
  const third = ensureReadCheckout(t.w.settings, target);
  assert.equal(third.error, undefined);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(path.join(t.clone.dir, 'docs/archive/.sources')).sort(), ['README.md', 'notes.md', 'section-readiness.json', 'sme-interview.md']);
  // The owner's clone: no sparse settings, its config and its checkout as they were (plus the session's report).
  assert.equal(fs.readFileSync(path.join(t.clone.dir, '.git', 'config'), 'utf8'), configBefore);
  assert.ok(!fs.existsSync(path.join(t.clone.dir, '.git', 'info', 'sparse-checkout')));
  assert.throws(() => t.clone.g('config', '--get', 'core.sparseCheckout'), 'no sparse setting in the clone');
  assert.equal(t.clone.g('status', '--porcelain'), statusBefore);
  assert.match(t.clone.g('ls-files', '-t', 'docs/archive/.sources'), /^H docs\/archive\/\.sources\/README\.md$/m);
});

test('a read checkout\'s .sources/ folders are the clone\'s: linked at the same path, written through, a new one moved into the clone, and never lost when it is made again', () => {
  const t = planTicket({ onBase: false });
  const target = t.w.settings.targets[0];
  // The clone's work files (git-ignored), in a section the base has, and in one only the owner's branch has.
  fs.mkdirSync(path.join(t.clone.dir, 'docs/x/.sources'), { recursive: true });
  fs.writeFileSync(path.join(t.clone.dir, 'docs/x/.sources/sme-interview.md'), 'interview\n');
  fs.mkdirSync(path.join(t.clone.dir, 'docs/draft/.sources'), { recursive: true });
  fs.writeFileSync(path.join(t.clone.dir, 'docs/draft/.sources/notes.md'), 'notes\n');
  checkClone(t.w.settings, target);
  const r = ensureReadCheckout(t.w.settings, target);
  assert.deepEqual(r.linked.sort(), ['docs/draft/.sources', 'docs/x/.sources']);
  const link = path.join(r.path, 'docs/x/.sources');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), path.join(t.clone.dir, 'docs/x/.sources'));
  assert.equal(pageIn(r.path, 'docs/x/.sources/sme-interview.md'), 'interview\n');
  assert.equal(pageIn(r.path, 'docs/draft/.sources/notes.md'), 'notes\n');
  assert.equal(execFileSync('git', ['-C', r.path, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }), '', 'no tracked change');
  // A skill writes its report through the link: it lands in the clone.
  fs.writeFileSync(path.join(link, 'section-readiness.json'), '{}\n');
  assert.equal(pageIn(t.clone.dir, 'docs/x/.sources/section-readiness.json'), '{}\n');
  // A section with no `.sources/` yet: the session makes a real one in the read checkout; it goes into the clone.
  fs.mkdirSync(path.join(r.path, 'docs/new/.sources/frames'), { recursive: true });
  fs.writeFileSync(path.join(r.path, 'docs/new/.sources/app-notes.md'), 'notes from the app\n');
  fs.writeFileSync(path.join(r.path, 'docs/new/.sources/frames/a.png'), 'png');
  // Not while another session may still write there.
  assert.deepEqual(ensureReadCheckout(t.w.settings, target, { othersRunning: true }).adopted.moved, []);
  assert.ok(!fs.lstatSync(path.join(r.path, 'docs/new/.sources')).isSymbolicLink());
  const a = adoptSources(t.w.settings, t.clone.dir, r.path);
  assert.deepEqual(a, { moved: ['docs/new/.sources'], kept: [] });
  assert.equal(pageIn(t.clone.dir, 'docs/new/.sources/app-notes.md'), 'notes from the app\n');
  assert.equal(pageIn(t.clone.dir, 'docs/new/.sources/frames/a.png'), 'png');
  assert.ok(fs.lstatSync(path.join(r.path, 'docs/new/.sources')).isSymbolicLink(), 'a link in its place');
  // One the clone made meanwhile too: file by file, the clone's kept, the session's beside it.
  fs.mkdirSync(path.join(r.path, 'docs/both/.sources'), { recursive: true });
  fs.writeFileSync(path.join(r.path, 'docs/both/.sources/plan.md'), 'session\n');
  fs.mkdirSync(path.join(t.clone.dir, 'docs/both/.sources'), { recursive: true });
  fs.writeFileSync(path.join(t.clone.dir, 'docs/both/.sources/plan.md'), 'owner\n');
  assert.deepEqual(adoptSources(t.w.settings, t.clone.dir, r.path).moved, ['docs/both/.sources']);
  assert.deepEqual([pageIn(t.clone.dir, 'docs/both/.sources/plan.md'), pageIn(t.clone.dir, 'docs/both/.sources/plan.md.from-read-checkout')], ['owner\n', 'session\n']);
  // Made again (a change to a tracked file): the links go with the folder, never what they lead to; a session's real
  // folder goes into the clone first.
  fs.mkdirSync(path.join(r.path, 'docs/late/.sources'), { recursive: true });
  fs.writeFileSync(path.join(r.path, 'docs/late/.sources/late.md'), 'late\n');
  fs.writeFileSync(path.join(r.path, 'docs/x/index.md'), 'changed\n');
  const again = ensureReadCheckout(t.w.settings, target);
  assert.deepEqual([again.error, again.adopted.moved], [undefined, ['docs/late/.sources']]);
  assert.equal(pageIn(again.path), '# Сторінка\n', 'made again');
  for (const [rel, text] of [['docs/x/.sources/sme-interview.md', 'interview\n'], ['docs/x/.sources/section-readiness.json', '{}\n'], ['docs/new/.sources/app-notes.md', 'notes from the app\n'], ['docs/late/.sources/late.md', 'late\n']]) {
    assert.equal(pageIn(t.clone.dir, rel), text, rel);
    assert.equal(pageIn(again.path, rel), text, `${rel} through the new link`);
  }
  // The clone's folder gone: its link goes.
  fs.rmSync(path.join(t.clone.dir, 'docs/draft/.sources'), { recursive: true });
  ensureReadCheckout(t.w.settings, target);
  assert.throws(() => fs.lstatSync(path.join(r.path, 'docs/draft/.sources')));
});

test('a read checkout runs none of the clone\'s hooks, never links a .sources/ folder that holds the state folder, and never moves one into it', () => {
  const t = planTicket({ onBase: false });
  const target = t.w.settings.targets[0];
  const marker = path.join(tmp('hook-'), 'ran');
  const hook = path.join(t.clone.dir, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`);
  fs.chmodSync(hook, 0o755);
  const r = ensureReadCheckout(t.w.settings, target);
  mergeOnForge(t.bare, { 'docs/z.md': '# Z\n' });
  checkClone(t.w.settings, target);
  ensureReadCheckout(t.w.settings, target);
  assert.equal(fs.existsSync(marker), false, 'no post-checkout hook ran');
  // The hub as a target: its own `.sources/` holds the state folder. Stand-in: a state folder inside the clone's.
  const inside = { ...t.w.settings, state: path.join(t.clone.dir, '.sources', 'flow') };
  fs.mkdirSync(path.join(inside.state, 'tickets'), { recursive: true });
  const rc2 = readCheckoutPath(inside, target);
  assert.equal(ensureReadCheckout(inside, target).error, undefined);
  assert.throws(() => fs.lstatSync(path.join(rc2, '.sources')), 'no link to the folder that holds the state');
  fs.mkdirSync(path.join(rc2, '.sources', 'flow', 'tickets'), { recursive: true });
  fs.writeFileSync(path.join(rc2, '.sources', 'flow', 'tickets', 'x.json'), '{}');
  const a = adoptSources(inside, t.clone.dir, rc2);
  assert.deepEqual([a.moved, a.kept.map((k) => k.reason)], [[], ['it would land in the state folder or outside the clone']]);
  assert.ok(!fs.existsSync(path.join(inside.state, 'tickets', 'x.json')));
  assert.ok(r.path);
});

test('a plan session works on the read checkout\'s section: the clone\'s .sources/ through the link, a new .sources/ moved into the clone when the session ends, said in the run log', async () => {
  const t = planTicket({ onBase: false });
  fs.mkdirSync(path.join(t.clone.dir, 'docs/x/.sources'), { recursive: true });
  fs.writeFileSync(path.join(t.clone.dir, 'docs/x/.sources/sme-interview.md'), 'interview\n');
  const rc = readCheckoutOf(t);
  const seen = [];
  const spawnClaude = async () => {
    // As section-readiness would on the read checkout's section: it reads the interview and writes its report; and
    // app-explorer, on a section with no `.sources/` yet.
    seen.push(pageIn(rc, 'docs/x/.sources/sme-interview.md'));
    fs.writeFileSync(path.join(rc, 'docs/x/.sources/section-readiness.json'), '{"x":1}\n');
    fs.mkdirSync(path.join(rc, 'docs/new/.sources'), { recursive: true });
    fs.writeFileSync(path.join(rc, 'docs/new/.sources/app-notes.md'), 'app\n');
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1601'] } });
  assert.equal(seen[0], 'interview\n');
  assert.equal(pageIn(t.clone.dir, 'docs/x/.sources/section-readiness.json'), '{"x":1}\n');
  assert.equal(pageIn(t.clone.dir, 'docs/new/.sources/app-notes.md'), 'app\n', 'moved into the clone after the session');
  assert.ok(fs.lstatSync(path.join(rc, 'docs/new/.sources')).isSymbolicLink());
  assert.ok(out.log.some((e) => e.kind === 'readCheckout' && e.outcome === 'moved' && /moved into the clone: docs\/new\/\.sources/.test(e.note)), JSON.stringify(out.log.filter((e) => e.kind === 'readCheckout')));
  assert.equal(execFileSync('git', ['-C', t.clone.dir, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'nothing git sees changed in the clone');
});
