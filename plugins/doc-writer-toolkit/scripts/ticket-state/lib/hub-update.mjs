import { spawnSync } from 'node:child_process';

// The hub after a merge (TASK-106). The settings are read from the hub's HEAD (lib/settings.mjs `trustedShared`), and
// a session reads the hub's working tree (its CLAUDE.md, skills, host-job scripts), so a merged hub PR counts only once
// the hub's checkout has it. Before a full check the watcher fast-forwards the hub's default branch to origin's, and
// only then:
//   - the default branch is origin's (`refs/remotes/origin/HEAD`), and the hub has it checked out;
//   - the working tree has no uncommitted change to a tracked file (an untracked file is left alone: a fast-forward
//     that would overwrite one is refused by git, and that is a note);
//   - the branch has no commit origin's doesn't have: only a fast-forward, never a merge commit or a reset.
// The fetch is of that one branch into its remote-tracking ref, with a timeout and no password prompt. Anything else
// (a fetch that fails, another branch, a dirty tree, a branch ahead) moves nothing and gives a note when the hub is
// behind origin or couldn't be compared; a hub level with origin, or ahead of it, gives none.
// Returns { outcome: 'moved' | 'level' | 'ahead' | 'behind' | 'failed' | 'skipped', base, from?, to?, commits?, note? }.

export const HUB_FETCH_MS = 30 * 1000;

const runGit = (root, args, { timeout = 15000 } = {}) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim().split('\n')[0], timedOut: r.error?.code === 'ETIMEDOUT' };
};

export function updateHub(root, { git = runGit, fetchMs = HUB_FETCH_MS } = {}) {
  if (!git(root, ['rev-parse', '--is-inside-work-tree']).ok) return { outcome: 'skipped', base: null };
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (!head.ok) return { outcome: 'skipped', base: null, note: "the hub's default branch is not known (no origin/HEAD; `git remote set-head origin --auto` sets it): the hub is not updated" };
  const base = head.out.replace(/^origin\//, '');
  const fetched = git(root, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeout: fetchMs });
  if (!fetched.ok) return { outcome: 'failed', base, note: `could not fetch ${base} from origin${fetched.timedOut ? ` (timed out after ${Math.round(fetchMs / 1000)} s)` : ''}: the hub's settings are read as its checkout has them` };
  const to = git(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]).out;
  const from = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).out;
  if (!to || !from) return { outcome: 'failed', base, note: `the hub's HEAD or origin/${base} doesn't read: the hub is not updated` };
  if (to === from) return { outcome: 'level', base, from };
  const counts = git(root, ['rev-list', '--left-right', '--count', `${from}...${to}`]).out.split(/\s+/).map(Number);
  const [ahead, behind] = counts.length === 2 && counts.every(Number.isFinite) ? counts : [null, null];
  if (behind === null) return { outcome: 'failed', base, note: `the hub's HEAD can't be compared with origin/${base}: the hub is not updated` };
  if (!behind) return { outcome: 'ahead', base, from, ahead };
  const stay = (why) => ({ outcome: 'behind', base, from, to, commits: behind, note: `the hub is ${behind} commit(s) behind origin/${base} and was not updated: ${why}. Its settings are read as they were until a person updates it` });
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch.ok || branch.out !== base) return stay(branch.ok ? `it is on ${branch.out}, not ${base}` : 'its HEAD is detached');
  if (ahead) return stay(`its ${base} has ${ahead} commit(s) origin's doesn't have`);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (!dirty.ok) return stay(`git status failed (${dirty.err || 'no reason given'})`);
  if (dirty.out) return stay('it has uncommitted changes to tracked files');
  const merged = git(root, ['merge', '--ff-only', '-q', to]);
  if (!merged.ok) return stay(`git would not fast-forward it (${merged.err || 'no reason given'})`);
  return { outcome: 'moved', base, from, to, commits: behind };
}

// One phrase for the watcher's line and the run log.
export const hubLine = (h) => (h?.outcome === 'moved' ? `the hub fast-forwarded ${h.commits} commit(s) to origin/${h.base} (${h.to.slice(0, 7)})` : h?.note ?? null);
