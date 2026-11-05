import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, ago, card, gitRepo, pr, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runDaily } from '../lib/runner.mjs';
import { runRecord } from '../lib/record.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { ensureWorktree, listWorktrees, canon, prsForStep, worktreePath } from '../lib/worktree.mjs';
import { spentOf } from '../lib/limits.mjs';
import { writeLedger } from '../lib/ledger.mjs';
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
    // The target clone sees it, as when the owner pushes from it (status reads git there and fetches nothing).
    clone.g('fetch', '-q', 'origin');
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

function finalReviewTicket({ done = CHAIN.slice(0, 5), stage = 'finalReview', extra = {}, declare } = {}) {
  const c = card({ number: 1501, status: 'finalReview' });
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
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    seen.push({ stage, brief: briefOf(cmd), addDirs: cmd.args.filter((a, i) => cmd.args[i - 1] === '--add-dir') });
    // The session: in the worktree its brief names, the site builds from the linked node_modules, and git shows
    // nothing untracked. It installs nothing and links nothing.
    const built = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("./node_modules/fake-build"))'], { cwd: t.wt, encoding: 'utf8' });
    assert.equal(built, 'built');
    assert.equal(execFileSync('git', ['-C', t.wt, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the link is excluded: nothing untracked');
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: t.h1, result: { ok: true }, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]).slice(0, 1), [['build', 'done']]);
  assert.equal(read(t.w, '1501').prs[0].chain.build.status, 'done');
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

// A merged ticket whose worktree holds work no remote has: `make` leaves it so before the close.
async function closeWith(make, { files = [] } = {}) {
  const c = card({ number: 1504, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 71, head: 'ticket-71', state: 'merged' })] });
  gitRepo(w.root).commit({ '.gitignore': '.flow/\nrepos/\n', 'docs/index.md': '# Host\n' });
  const fx = withClone(w);
  const p = { repo: 'guide-docs', targets: ['guide'], branch: 'ticket-71', base: 'main' };
  ensureWorktree(w.settings, p);
  const wt = worktreePath(w.settings, p);
  make(wt, fx, w);
  ledger(w, c, { stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' }, prs: [{ ...p, number: 71, review: 'sme', stage: 'readyForMerge', pipelineCommits: [fx.h1], readyForMerge: [{ head: fx.h1, at: ago(2) }] }], files: files.map((f) => ({ path: path.relative(w.root, path.join(wt, f)), kind: 'other', bytes: 0, stage: 'write', at: ago(30) })) });
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
  assert.match(gone.l.stages.close.result.cleanup.kept.find((k) => k.path.endsWith('build')).reason, /^inside the worktree .*, removed with it/);
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

// A ready-for-merge PR, then a hand commit; the session stand-in records each model stage at the head it was given.
async function afterReady(files) {
  const t = finalReviewTicket({ done: CHAIN, stage: 'readyForMerge' });
  const h2 = t.handEdit(files);
  t.forgePr.headCommit = h2;
  const stages = [];
  const spawnClaude = async (cmd) => {
    const stage = stageOf(cmd);
    stages.push(stage);
    await runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage, pr: 'guide-docs#71', status: 'done', head: h2, result: {}, now: NOW });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: t.w.settings, clients: t.w.clients(), io: { readUsage: usage, now: () => NOW, spawnClaude }, options: { trigger: 'watcher', named: ['1501'] } });
  return { t, h2, out, stages, l: read(t.w, '1501') };
}

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
  const { h2, out, l } = await afterReady({ 'docs/x/index.md': '# Сторінка\n\nВиправлений абзац.\n' });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['resync', 'done'], ['readyForMerge', 'done']]);
  assert.notEqual(l.prs[0].chain.visualPack.head, h2);
  assert.equal(l.prs[0].readyForMerge.at(-1).head, h2);
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

test('AC-3: record align with no worktree on this machine is refused, never skipped', async () => {
  const t = finalReviewTicket({ done: CHAIN.slice(0, 3) });
  assert.equal(fs.existsSync(t.wt), false);
  await assert.rejects(
    runRecord({ settings: t.w.settings, clients: t.w.clients(), key: '1501', stage: 'align', pr: 'guide-docs#71', status: 'done', head: t.h1, result: { bugs: 0, warnings: 0 }, now: NOW }),
    (e) => e.refused === 'imagePairs' && /no worktree of guide-docs ticket-71/.test(e.message),
  );
  assert.equal(read(t.w, '1501').prs[0].chain.align, undefined, 'nothing written');
});
