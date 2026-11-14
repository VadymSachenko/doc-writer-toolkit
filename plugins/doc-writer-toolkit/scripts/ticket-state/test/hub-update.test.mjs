import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { host, rawSettings, tmp } from './fakes.mjs';
import { updateHub } from '../lib/hub-update.mjs';
import { loadSettings, sharedProblemAt, stateFolderOf } from '../lib/settings.mjs';
import { takeLock } from '../lib/locks.mjs';
import { takeWatchLock } from '../lib/watch.mjs';
import { busyHub, settingsForCheck } from '../watcher.mjs';

// A hub PR merged on the forge counts at the next full check with no person's pull (TASK-106): the watcher
// fast-forwards the hub's default branch when its tree is clean and on that branch, the merged settings hold and nothing
// reads the hub's files, and otherwise moves nothing and says why. Throwaway repositories: an origin (bare), the hub (a
// clone of it) and another clone that stands for the merge on the forge.

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = (dir) => {
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
};
const RELATED = [{ repo: 'code-two', url: 'https://code.example/org/code-two' }];
const settingsText = (shared = {}) => JSON.stringify(rawSettings(shared));

function hubAndOrigin({ local = null, shared = {} } = {}) {
  const bare = path.join(tmp(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = host({ shared });
  git(seed, 'init', '-q', '-b', 'main');
  ident(seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), '.claude/*.local.json\n.sources/\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hub\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'settings');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  const hub = path.join(tmp(), 'hub');
  execFileSync('git', ['clone', '-q', bare, hub]);
  ident(hub);
  if (local) fs.writeFileSync(path.join(hub, '.claude', 'ticket-flow.local.json'), JSON.stringify(local));
  // A merge on the forge, pushed from elsewhere: by default the hub PR that adds `relatedRepos`.
  const push = (files = { '.claude/ticket-flow.json': settingsText({ ...shared, relatedRepos: RELATED }) }, { force = false } = {}) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), text);
      git(seed, 'add', ...(force ? ['-f'] : []), rel);
    }
    git(seed, 'commit', '-qm', 'merged');
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  return { bare, seed, hub, merge: () => push(), push };
}

test('AC-2: the hub behind origin with a changed ticket-flow.json: the next full check reads the new settings, with no person\'s pull', async () => {
  const { hub, merge } = hubAndOrigin();
  const merged = merge();
  // A forge check, a tick that only starts the full check, a dry run: nothing moves, the settings are as they were.
  for (const values of [{ forge: true }, {}, { full: true, 'dry-run': true }]) {
    const r = await settingsForCheck({ root: hub, values });
    assert.equal(r.hub, null, JSON.stringify(values));
    assert.deepEqual(r.settings.relatedRepos, []);
  }
  assert.notEqual(git(hub, 'rev-parse', 'HEAD'), merged);
  // The full check: fast-forwarded, and the settings read again.
  const r = await settingsForCheck({ root: hub, values: { full: true } });
  assert.deepEqual([r.hub.outcome, r.hub.base, r.hub.commits, r.hub.to], ['moved', 'main', 1, merged]);
  assert.equal(r.hub.note, undefined);
  assert.deepEqual(r.settings.relatedRepos.map((x) => x.repo), ['code-two']);
  assert.equal(git(hub, 'rev-parse', 'HEAD'), merged);
  assert.equal(git(hub, 'rev-list', '--merges', '--count', 'HEAD'), '0', 'a fast-forward: no merge commit');
  // Level with origin now: nothing to say.
  assert.deepEqual(await updateHub(hub), { outcome: 'level', base: 'main', from: merged });
  // A tick that is the full check itself (the tick no shorter than watchMinutes) moves it too.
  const tick = hubAndOrigin({ local: { schedule: { forgeSeconds: 600, watchMinutes: 5 } } });
  tick.merge();
  assert.equal((await settingsForCheck({ root: tick.hub, values: {} })).hub.outcome, 'moved');
});

test('a dirty, off-branch, detached or diverged hub: nothing moves, and a note says why; an untracked file is left alone, an ignored one is never overwritten', async () => {
  // Uncommitted changes to a tracked file.
  let h = hubAndOrigin();
  h.merge();
  const before = git(h.hub, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(h.hub, 'README.md'), 'an edit in progress\n');
  let r = await updateHub(h.hub);
  assert.deepEqual([r.outcome, r.commits], ['behind', 1]);
  assert.match(r.note, /^the hub is 1 commit\(s\) behind origin\/main and was not updated: it has uncommitted changes to tracked files\./);
  assert.equal(git(h.hub, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(h.hub, 'README.md'), 'utf8'), 'an edit in progress\n');
  // Staged counts as uncommitted too.
  git(h.hub, 'add', 'README.md');
  assert.match((await updateHub(h.hub)).note, /uncommitted changes/);

  // Another branch checked out: main is not moved under it, nor the branch.
  h = hubAndOrigin();
  h.merge();
  git(h.hub, 'switch', '-q', '-c', 'side');
  const side = git(h.hub, 'rev-parse', 'HEAD');
  r = await updateHub(h.hub);
  assert.equal(r.outcome, 'behind');
  assert.match(r.note, /it is on side, not main/);
  assert.equal(git(h.hub, 'rev-parse', 'side'), side);
  assert.equal(git(h.hub, 'rev-parse', 'main'), side);
  // Detached.
  git(h.hub, 'switch', '-q', '--detach');
  assert.match((await updateHub(h.hub)).note, /its HEAD is detached/);

  // A commit of its own on main: a fast-forward can't, so nothing moves.
  h = hubAndOrigin();
  h.merge();
  fs.writeFileSync(path.join(h.hub, 'notes.md'), 'local\n');
  git(h.hub, 'add', 'notes.md');
  git(h.hub, 'commit', '-qm', 'local');
  const own = git(h.hub, 'rev-parse', 'HEAD');
  r = await updateHub(h.hub);
  assert.match(r.note, /its main has 1 commit\(s\) origin's doesn't have/);
  assert.equal(git(h.hub, 'rev-parse', 'HEAD'), own);
  // Ahead only: nothing to do, nothing to say.
  git(h.hub, 'reset', '-q', '--hard', 'origin/main');
  fs.writeFileSync(path.join(h.hub, 'notes.md'), 'local\n');
  git(h.hub, 'add', 'notes.md');
  git(h.hub, 'commit', '-qm', 'local');
  r = await updateHub(h.hub);
  assert.deepEqual([r.outcome, r.note], ['ahead', undefined]);

  // An untracked file is no dirty tree: the fast-forward goes on and keeps it. One the merge would overwrite: git
  // refuses, and that is the note.
  h = hubAndOrigin();
  h.merge();
  fs.writeFileSync(path.join(h.hub, 'scratch.txt'), 'mine\n');
  assert.equal((await updateHub(h.hub)).outcome, 'moved');
  assert.equal(fs.readFileSync(path.join(h.hub, 'scratch.txt'), 'utf8'), 'mine\n');
  h.push({ 'new.md': 'theirs\n' });
  fs.writeFileSync(path.join(h.hub, 'new.md'), 'mine\n');
  r = await updateHub(h.hub);
  assert.equal(r.outcome, 'behind');
  assert.match(r.note, /git would not fast-forward it/);
  assert.equal(fs.readFileSync(path.join(h.hub, 'new.md'), 'utf8'), 'mine\n');

  // An ignored file (the state folder's, a `.sources/` note) that the merge would overwrite: refused too, never lost.
  h = hubAndOrigin();
  h.push({ 'docs/a/.sources/notes.md': 'theirs\n' }, { force: true });
  fs.mkdirSync(path.join(h.hub, 'docs', 'a', '.sources'), { recursive: true });
  fs.writeFileSync(path.join(h.hub, 'docs', 'a', '.sources', 'notes.md'), 'the owner\'s notes\n');
  r = await updateHub(h.hub);
  assert.equal(r.outcome, 'behind');
  assert.match(r.note, /git would not fast-forward it/);
  assert.equal(fs.readFileSync(path.join(h.hub, 'docs', 'a', '.sources', 'notes.md'), 'utf8'), 'the owner\'s notes\n');
});

test('the move runs no hook, has no timeout, and is decided by HEAD after it', async () => {
  const h = hubAndOrigin();
  const merged = h.merge();
  const hooks = path.join(h.hub, '.git', 'hooks');
  const mark = path.join(tmp(), 'hook-ran');
  fs.writeFileSync(path.join(hooks, 'post-merge'), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
  const calls = [];
  const real = (root, args, opts = {}) => {
    calls.push({ args, timeout: opts.timeout });
    const r = (() => {
      try {
        return { ok: true, out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), err: '' };
      } catch (e) {
        return { ok: false, out: '', err: String(e.stderr ?? '') };
      }
    })();
    return r;
  };
  const r = await updateHub(h.hub, { git: real });
  assert.equal(r.outcome, 'moved');
  assert.equal(fs.existsSync(mark), false, 'no hook ran');
  const merge = calls.find((c) => c.args.includes('merge'));
  assert.deepEqual([merge.args.slice(0, 2), merge.args.includes('--no-overwrite-ignore'), merge.timeout], [['-c', 'core.hooksPath=/dev/null'], true, 0]);
  assert.ok(calls.find((c) => c.args[0] === 'fetch').timeout > 0, 'the fetch keeps its timeout');
  // A merge that says it worked but leaves HEAD elsewhere is no move.
  const h2 = hubAndOrigin();
  h2.merge();
  const lying = (root, args, opts) => (args.includes('merge') ? { ok: true, out: '', err: '' } : real(root, args, opts));
  const r2 = await updateHub(h2.hub, { git: lying });
  assert.equal(r2.outcome, 'behind');
  assert.match(r2.note, /git would not fast-forward it \(HEAD is \w{7} after the merge\)/);
  assert.notEqual(git(h2.hub, 'rev-parse', 'HEAD'), merged);
});

test('merged settings that don\'t hold: the hub stays where it is, with the reason; settings already broken at HEAD: the next process pulls the fix', async () => {
  // The forge's main gets a settings file that doesn't validate: the hub is not moved to it.
  let h = hubAndOrigin();
  const bad = h.push({ '.claude/ticket-flow.json': settingsText({ limits: { startOrder: 'random' } }) });
  git(h.hub, 'fetch', '-q', 'origin');
  assert.match(await sharedProblemAt({ root: h.hub, ref: bad }), /limits.startOrder/);
  assert.equal(await sharedProblemAt({ root: h.hub, ref: 'HEAD' }), null);
  let r = await settingsForCheck({ root: h.hub, values: { full: true } });
  assert.equal(r.hub.outcome, 'behind');
  assert.match(r.hub.note, /the settings at origin\/main don't hold \(.*limits\.startOrder/);
  assert.notEqual(git(h.hub, 'rev-parse', 'HEAD'), bad);
  // Not JSON at all, or the file gone: the same.
  h.push({ '.claude/ticket-flow.json': '{ not json' });
  assert.match((await settingsForCheck({ root: h.hub, values: { full: true } })).hub.note, /is not JSON/);
  git(h.seed, 'rm', '-q', '.claude/ticket-flow.json');
  git(h.seed, 'commit', '-qm', 'gone');
  git(h.seed, 'push', '-q', 'origin', 'main');
  assert.match((await settingsForCheck({ root: h.hub, values: { full: true } })).hub.note, /ticket-flow\.json is not in it/);

  // A hub whose own HEAD has broken settings (committed by hand): every process fails at its read, so the tick itself
  // tries the update, and pulls the fix once one is merged.
  h = hubAndOrigin();
  fs.writeFileSync(path.join(h.hub, '.claude', 'ticket-flow.json'), settingsText({ limits: { startOrder: 'random' } }));
  git(h.hub, 'commit', '-qam', 'by hand');
  git(h.hub, 'push', '-q', 'origin', 'main');
  await assert.rejects(loadSettings({ root: h.hub }), /startOrder/);
  // No fix yet: the error stands (nothing to pull), for a tick and a full check alike; a hand-on and a dry run don't try.
  await assert.rejects(settingsForCheck({ root: h.hub, values: {} }), /startOrder/);
  await assert.rejects(settingsForCheck({ root: h.hub, values: { 'hand-on': 'x', ticket: ['1'] }, update: () => assert.fail('no update') }), /startOrder/);
  await assert.rejects(settingsForCheck({ root: h.hub, values: { full: true, 'dry-run': true }, update: () => assert.fail('no update') }), /startOrder/);
  git(h.seed, 'pull', '-q', 'origin', 'main');
  const fix = h.push({ '.claude/ticket-flow.json': settingsText({ relatedRepos: RELATED }) });
  r = await settingsForCheck({ root: h.hub, values: {} });
  assert.deepEqual([r.hub.outcome, git(h.hub, 'rev-parse', 'HEAD')], ['moved', fix]);
  assert.deepEqual(r.settings.relatedRepos.map((x) => x.repo), ['code-two']);
});

test('the state folder when the settings don\'t parse: the working file\'s, else the one at HEAD; unknown when neither parses, and then the hub stays put', async () => {
  const h = hubAndOrigin({ shared: { state: '.flow-elsewhere/' } });
  assert.equal(await stateFolderOf({ root: h.hub }), path.join(h.hub, '.flow-elsewhere'));
  // The working file doesn't parse: HEAD's names the folder, so a hand-on's lock there is seen.
  fs.writeFileSync(path.join(h.hub, '.claude', 'ticket-flow.json'), '{ broken');
  assert.equal(await stateFolderOf({ root: h.hub }), path.join(h.hub, '.flow-elsewhere'));
  // Neither parses (committed broken): unknown, and the update moves nothing, saying why.
  git(h.hub, 'commit', '-qam', 'broken by hand');
  git(h.hub, 'push', '-q', 'origin', 'main');
  assert.equal(await stateFolderOf({ root: h.hub }), null);
  git(h.seed, 'pull', '-q', 'origin', 'main');
  const fix = h.push({ '.claude/ticket-flow.json': settingsText({ state: '.flow-elsewhere/' }) });
  await assert.rejects(settingsForCheck({ root: h.hub, values: {} }), /the state folder is not known/);
  assert.notEqual(git(h.hub, 'rev-parse', 'HEAD'), fix);
  // No settings file at all, anywhere: the default folder.
  const bare = tmp();
  assert.equal(await stateFolderOf({ root: bare }), path.resolve(bare, '.doc-toolkit/ticket-flow/'));
});

test('a run going on or another full check: the hub waits for a check with none, and says so', async () => {
  const h = hubAndOrigin();
  const merged = h.merge();
  const state = (await loadSettings({ root: h.hub })).state;
  takeLock(state, { group: '501', kind: 'schedule', stage: 'write', leaseMinutes: 120, now: Date.now() });
  assert.equal(busyHub(state), '1 run(s) going');
  let r = await settingsForCheck({ root: h.hub, values: { full: true } });
  assert.equal(r.hub.outcome, 'behind');
  assert.match(r.hub.note, /was not updated: 1 run\(s\) going, which read\(s\) the hub's files: it moves at a check with none/);
  assert.deepEqual(r.settings.relatedRepos, []);
  fs.rmSync(path.join(state, 'locks', '501'), { recursive: true, force: true });
  // Another process holds the full check's lock (a host job in it).
  const other = takeWatchLock(state, { pid: 1, isAlive: () => true });
  assert.equal(other.taken, true);
  assert.match(busyHub(state), /a full check running \(pid 1\)/);
  other.release();
  // A learning pass (TASK-054) commits in worktrees of the clones: the hub waits for it too.
  const learning = takeWatchLock(state, { pid: 1, isAlive: () => true, name: 'learn-active' });
  assert.match(busyHub(state), /a learning pass running \(pid 1\)/);
  learning.release();
  assert.equal(busyHub(state), null);
  r = await settingsForCheck({ root: h.hub, values: { full: true } });
  assert.deepEqual([r.hub.outcome, git(h.hub, 'rev-parse', 'HEAD')], ['moved', merged]);
});

test('the base the hub declares as a target wins over origin\'s default; a fetch that fails, no default branch, no repository: a note or nothing, never a throw', async () => {
  // The hub as a target of its own with base `release`: that branch is the one fast-forwarded.
  const h0 = hubAndOrigin();
  git(h0.seed, 'switch', '-q', '-c', 'release');
  git(h0.seed, 'push', '-q', 'origin', 'release');
  git(h0.hub, 'fetch', '-q', 'origin');
  git(h0.hub, 'switch', '-q', 'release');
  fs.writeFileSync(path.join(h0.seed, 'r.md'), 'r\n');
  git(h0.seed, 'add', 'r.md');
  git(h0.seed, 'commit', '-qm', 'r');
  git(h0.seed, 'push', '-q', 'origin', 'release');
  const r0 = await updateHub(h0.hub, { base: 'release' });
  assert.deepEqual([r0.outcome, r0.base], ['moved', 'release']);

  const h = hubAndOrigin();
  h.merge();
  const before = git(h.hub, 'rev-parse', 'HEAD');
  git(h.hub, 'remote', 'set-url', 'origin', path.join(tmp(), 'gone.git'));
  let r = await updateHub(h.hub);
  assert.equal(r.outcome, 'failed');
  assert.match(r.note, /^could not fetch main from origin: the hub's settings are read as its checkout has them$/);
  assert.equal(git(h.hub, 'rev-parse', 'HEAD'), before);
  // Through the watcher's settings: the check goes on with the settings as they are.
  const s = await settingsForCheck({ root: h.hub, values: { full: true } });
  assert.deepEqual([s.hub.outcome, s.settings.relatedRepos], ['failed', []]);
  // No origin/HEAD.
  git(h.hub, 'remote', 'set-head', 'origin', '-d');
  r = await updateHub(h.hub);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.note, /default branch is not known/);
  // Not a repository: nothing to update and nothing to say.
  assert.deepEqual(await updateHub(tmp()), { outcome: 'skipped', base: null });
  // Mode off: not tried.
  const off = hubAndOrigin({ local: { mode: 'off' } });
  off.merge();
  assert.equal((await settingsForCheck({ root: off.hub, values: { full: true } })).hub, null);
});
