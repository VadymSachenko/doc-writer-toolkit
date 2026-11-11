import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { host, rawSettings, tmp } from './fakes.mjs';
import { updateHub } from '../lib/hub-update.mjs';
import { settingsForCheck } from '../watcher.mjs';

// A hub PR merged on the forge counts at the next full check with no person's pull (TASK-106): the watcher
// fast-forwards the hub's default branch when its tree is clean and on that branch, and otherwise moves nothing and
// says why. Throwaway repositories: an origin (bare), the hub (a clone of it) and another clone that stands for the merge.

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = (dir) => {
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
};
const RELATED = [{ repo: 'code-two', url: 'https://code.example/org/code-two' }];

function hubAndOrigin({ local = null } = {}) {
  const bare = path.join(tmp(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = host();
  git(seed, 'init', '-q', '-b', 'main');
  ident(seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), '.claude/*.local.json\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hub\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'settings');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  const hub = path.join(tmp(), 'hub');
  execFileSync('git', ['clone', '-q', bare, hub]);
  ident(hub);
  if (local) fs.writeFileSync(path.join(hub, '.claude', 'ticket-flow.local.json'), JSON.stringify(local));
  // The merge of a hub PR that adds `relatedRepos`, pushed from elsewhere.
  const merge = (shared = { relatedRepos: RELATED }) => {
    fs.writeFileSync(path.join(seed, '.claude', 'ticket-flow.json'), JSON.stringify(rawSettings(shared)));
    git(seed, 'commit', '-qam', 'related repos');
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  return { bare, seed, hub, merge };
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
  assert.deepEqual(updateHub(hub), { outcome: 'level', base: 'main', from: merged });
  // A tick that is the full check itself (the tick no shorter than watchMinutes) moves it too.
  const tick = hubAndOrigin({ local: { schedule: { forgeSeconds: 600, watchMinutes: 5 } } });
  tick.merge();
  assert.equal((await settingsForCheck({ root: tick.hub, values: {} })).hub.outcome, 'moved');
});

test('a dirty, off-branch, detached or diverged hub: nothing moves, and a note says why; an untracked file is left alone', async () => {
  // Uncommitted changes to a tracked file.
  let h = hubAndOrigin();
  h.merge();
  const before = git(h.hub, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(h.hub, 'README.md'), 'an edit in progress\n');
  let r = updateHub(h.hub);
  assert.deepEqual([r.outcome, r.commits], ['behind', 1]);
  assert.match(r.note, /^the hub is 1 commit\(s\) behind origin\/main and was not updated: it has uncommitted changes to tracked files\./);
  assert.equal(git(h.hub, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(h.hub, 'README.md'), 'utf8'), 'an edit in progress\n');
  // Staged counts as uncommitted too.
  git(h.hub, 'add', 'README.md');
  assert.match(updateHub(h.hub).note, /uncommitted changes/);

  // Another branch checked out: main is not moved under it, nor the branch.
  h = hubAndOrigin();
  h.merge();
  git(h.hub, 'switch', '-q', '-c', 'side');
  const side = git(h.hub, 'rev-parse', 'HEAD');
  r = updateHub(h.hub);
  assert.equal(r.outcome, 'behind');
  assert.match(r.note, /it is on side, not main/);
  assert.equal(git(h.hub, 'rev-parse', 'side'), side);
  assert.equal(git(h.hub, 'rev-parse', 'main'), side);
  // Detached.
  git(h.hub, 'switch', '-q', '--detach');
  assert.match(updateHub(h.hub).note, /its HEAD is detached/);

  // A commit of its own on main: a fast-forward can't, so nothing moves.
  h = hubAndOrigin();
  h.merge();
  fs.writeFileSync(path.join(h.hub, 'notes.md'), 'local\n');
  git(h.hub, 'add', 'notes.md');
  git(h.hub, 'commit', '-qm', 'local');
  const own = git(h.hub, 'rev-parse', 'HEAD');
  r = updateHub(h.hub);
  assert.match(r.note, /its main has 1 commit\(s\) origin's doesn't have/);
  assert.equal(git(h.hub, 'rev-parse', 'HEAD'), own);
  // Ahead only: nothing to do, nothing to say.
  git(h.hub, 'reset', '-q', '--hard', 'origin/main');
  fs.writeFileSync(path.join(h.hub, 'notes.md'), 'local\n');
  git(h.hub, 'add', 'notes.md');
  git(h.hub, 'commit', '-qm', 'local');
  assert.deepEqual([updateHub(h.hub).outcome, updateHub(h.hub).note], ['ahead', undefined]);

  // An untracked file is no dirty tree: the fast-forward goes on and keeps it. One the merge would overwrite: git
  // refuses, and that is the note.
  h = hubAndOrigin();
  h.merge();
  fs.writeFileSync(path.join(h.hub, 'scratch.txt'), 'mine\n');
  assert.equal(updateHub(h.hub).outcome, 'moved');
  assert.equal(fs.readFileSync(path.join(h.hub, 'scratch.txt'), 'utf8'), 'mine\n');
  fs.writeFileSync(path.join(h.seed, 'new.md'), 'theirs\n');
  git(h.seed, 'add', 'new.md');
  git(h.seed, 'commit', '-qm', 'new');
  git(h.seed, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(h.hub, 'new.md'), 'mine\n');
  r = updateHub(h.hub);
  assert.equal(r.outcome, 'behind');
  assert.match(r.note, /git would not fast-forward it/);
  assert.equal(fs.readFileSync(path.join(h.hub, 'new.md'), 'utf8'), 'mine\n');
});

test('a fetch that fails, no default branch known, no repository: a note or nothing, never a throw', async () => {
  const h = hubAndOrigin();
  h.merge();
  const before = git(h.hub, 'rev-parse', 'HEAD');
  git(h.hub, 'remote', 'set-url', 'origin', path.join(tmp(), 'gone.git'));
  let r = updateHub(h.hub);
  assert.equal(r.outcome, 'failed');
  assert.match(r.note, /^could not fetch main from origin: the hub's settings are read as its checkout has them$/);
  assert.equal(git(h.hub, 'rev-parse', 'HEAD'), before);
  // Through the watcher's settings: the check goes on with the settings as they are.
  const s = await settingsForCheck({ root: h.hub, values: { full: true } });
  assert.deepEqual([s.hub.outcome, s.settings.relatedRepos], ['failed', []]);
  // No origin/HEAD.
  git(h.hub, 'remote', 'set-head', 'origin', '-d');
  r = updateHub(h.hub);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.note, /default branch is not known/);
  // Not a repository: nothing to update and nothing to say.
  assert.deepEqual(updateHub(tmp()), { outcome: 'skipped', base: null });
  // Mode off: not tried.
  const off = hubAndOrigin({ local: { mode: 'off' } });
  off.merge();
  assert.equal((await settingsForCheck({ root: off.hub, values: { full: true } })).hub, null);
});
