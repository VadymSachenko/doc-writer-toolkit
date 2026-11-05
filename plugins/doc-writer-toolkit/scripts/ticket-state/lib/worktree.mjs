import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prId } from './ledger.mjs';

// The ticket worktrees. The runner, not a role, makes the worktree a session works in: one per PR branch, next to the
// target's clone (`<clone's parent>/.worktrees/<repo>/<branch>`), at the branch's head on the remote, detached, so a
// branch checked out in the owner's clone never blocks it. It links the clone's untracked files the stages need
// (`targets[].links`, default `node_modules`) and lists each link in the common git dir's `info/exclude`, since a
// `node_modules/` line in `.gitignore` doesn't match a symlink. The close step removes the worktree with
// `git worktree remove --force`, then prunes; nothing else ever moves a worktree's `.git` link.

// The stages that work on a PR branch, so their session gets the worktree.
export const TREE_STAGES = ['write', 'uaReview', 'pr', 'answerComments', 'translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack', 'resync'];
export const DEFAULT_LINKS = ['node_modules'];

const run = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryRun = (cwd, args) => {
  try {
    return run(cwd, args);
  } catch {
    return null;
  }
};
const gitError = (e) => String(e?.stderr ?? e?.message ?? e).trim().split('\n').filter(Boolean).at(-1) ?? 'git failed';

export const targetOf = (settings, pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo) ?? null;
export const clonePath = (settings, target) => (target?.path ? path.resolve(settings.root, target.path) : null);

// Where a PR's worktree lives: beside the clone, outside every repo.
export function worktreePath(settings, pr) {
  const clone = clonePath(settings, targetOf(settings, pr));
  if (!clone || !pr.branch) return null;
  return path.join(path.dirname(clone), '.worktrees', path.basename(clone), ...String(pr.branch).split('/'));
}

// The worktrees a clone lists (`git worktree list --porcelain`): absolute paths, with `prunable` when the folder is gone.
export function listWorktrees(clone) {
  const out = tryRun(clone, ['worktree', 'list', '--porcelain']);
  if (out === null) return [];
  const list = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '));
    if (!at) continue;
    list.push({ path: at.slice('worktree '.length), prunable: lines.some((l) => l.startsWith('prunable')) });
  }
  return list;
}

// A path with its existing part resolved through links (macOS: /tmp is /private/tmp), so git's paths compare.
export function canon(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const up = path.dirname(abs);
    return up === abs ? abs : path.join(canon(up), path.basename(abs));
  }
}
const commonDir = (cwd) => {
  const out = tryRun(cwd, ['rev-parse', '--git-common-dir']);
  return out ? path.resolve(cwd, out) : null;
};

// Adds `/<name>` to the common git dir's info/exclude, once. Anchored, with no trailing slash: it matches the link.
function exclude(worktree, names) {
  const common = commonDir(worktree);
  if (!common) return [];
  const file = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  const add = names.map((n) => `/${n}`).filter((l) => !lines.has(l));
  if (add.length) fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  return add;
}

// The clone's untracked files linked into the worktree. A link already there is kept; a name the clone doesn't have is
// reported, never invented.
function link(clone, worktree, names) {
  const linked = [];
  const missing = [];
  for (const name of names) {
    const src = path.join(clone, name);
    const dest = path.join(worktree, name);
    if (!fs.existsSync(src)) {
      missing.push(name);
      continue;
    }
    let st = null;
    try {
      st = fs.lstatSync(dest);
    } catch {
      /* not there */
    }
    if (!st) fs.symlinkSync(src, dest);
    else if (!st.isSymbolicLink()) {
      missing.push(name);
      continue;
    }
    linked.push(name);
  }
  return { linked, missing };
}

const hasRef = (cwd, ref) => tryRun(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) !== null;

// Makes (or brings up to date) the worktree of one PR branch. Returns { repo, branch, path, head, push, linked,
// missing, notes } or throws with git's reason. The worktree is detached at `origin/<branch>` (or the base, for a
// branch not pushed yet); the session pushes with `git -C <path> push origin HEAD:refs/heads/<branch>`.
export function ensureWorktree(settings, pr) {
  const target = targetOf(settings, pr);
  const clone = clonePath(settings, target);
  if (!clone || !fs.existsSync(clone)) throw new Error(`${prId(pr)}: the clone of ${pr.repo} (targets[].path) is not on this machine`);
  if (!pr.branch) throw new Error(`${prId(pr)}: no branch recorded`);
  const wt = worktreePath(settings, pr);
  const base = pr.base ?? target?.base ?? 'main';
  const notes = [];
  // Fresh refs, best effort: offline, the refs the clone has are used, and the brief says so.
  if (tryRun(clone, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]) === null) notes.push(`could not fetch ${base} from origin: the clone's refs are used`);
  const branchFetched = tryRun(clone, ['fetch', '-q', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`]) !== null;
  const remoteBranch = hasRef(clone, `refs/remotes/origin/${pr.branch}`) ? `origin/${pr.branch}` : null;
  if (!branchFetched && remoteBranch) notes.push(`could not fetch ${pr.branch}: origin/${pr.branch} may be behind`);
  const start = remoteBranch ?? (hasRef(clone, `refs/remotes/origin/${base}`) ? `origin/${base}` : base);

  const registered = listWorktrees(clone).find((x) => canon(x.path) === canon(wt));
  if (!registered || registered.prunable || !fs.existsSync(wt)) {
    // A registration whose folder is gone is pruned first; a folder that isn't this clone's worktree is never touched.
    tryRun(clone, ['worktree', 'prune']);
    if (fs.existsSync(wt) && fs.readdirSync(wt).length) throw new Error(`${wt} exists and is not a worktree of ${pr.repo}: move it away, then run again`);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    try {
      run(clone, ['worktree', 'add', '-q', '--detach', wt, start]);
    } catch (e) {
      throw new Error(`${prId(pr)}: git worktree add failed: ${gitError(e)}`);
    }
  } else if (remoteBranch) {
    // Up to date with the branch: a fast-forward only, never over the session's own unpushed commits or changes to
    // tracked files. Untracked files (a session's notes, a pack's output) don't stop it; one git would overwrite does,
    // and the brief says so.
    const dirty = tryRun(wt, ['status', '--porcelain', '--untracked-files=no']);
    const head = tryRun(wt, ['rev-parse', 'HEAD']);
    if (dirty) notes.push('the worktree has uncommitted changes from an earlier session: left as they are');
    else if (head && tryRun(wt, ['merge-base', '--is-ancestor', head, remoteBranch]) !== null) {
      if (head !== tryRun(wt, ['rev-parse', remoteBranch])) {
        try {
          run(wt, ['checkout', '-q', '--detach', remoteBranch]);
        } catch (e) {
          notes.push(`could not move the worktree to origin/${pr.branch}: ${gitError(e)}`);
        }
      }
    } else notes.push(`the worktree has commits that are not on origin/${pr.branch}: push them, or record the stage failed`);
  }
  const { linked, missing } = link(clone, wt, target?.links ?? DEFAULT_LINKS);
  exclude(wt, linked);
  for (const name of missing) notes.push(`${name}: not in the clone (${clone}), so not linked`);
  return { repo: pr.repo, branch: pr.branch, path: wt, clone, head: tryRun(wt, ['rev-parse', 'HEAD']), push: `git -C ${wt} push origin HEAD:refs/heads/${pr.branch}`, linked, missing, notes };
}

// The PRs a step's session works on: the step's PR, or every open PR of its tickets with a branch.
export function prsForStep(step, ledgers) {
  if (!TREE_STAGES.includes(step.stage)) return [];
  const out = [];
  const seen = new Set();
  for (const l of ledgers.filter(Boolean)) {
    for (const pr of l.prs ?? []) {
      if (!pr.branch || pr.merged) continue;
      if (step.pr && prId(pr) !== step.pr && `${pr.repo}:${pr.branch}` !== step.pr) continue;
      const k = `${pr.repo}:${pr.branch}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(pr);
    }
  }
  return out;
}

// The checkout a folder is: a worktree (`.git` is a file pointing into another repo's `worktrees/`), a repository of its
// own (`.git` is a folder), or null.
export function checkoutKind(dir) {
  let st;
  try {
    st = fs.lstatSync(path.join(dir, '.git'));
  } catch {
    return null;
  }
  if (st.isDirectory()) return 'repo';
  if (st.isFile() && /^gitdir:/.test(fs.readFileSync(path.join(dir, '.git'), 'utf8'))) return 'worktree';
  return null;
}

// The main clone a worktree belongs to (the folder holding its common git dir).
export function cloneOf(worktree) {
  const common = commonDir(worktree);
  return common ? path.dirname(common) : null;
}

// Removes one worktree the way git does (`git worktree remove --force`), then prunes the clone's list. Never by moving
// files: the folder and its `.git` link go together, or nothing goes. A linked `node_modules` is only unlinked.
export function removeWorktree(clone, wt, { dryRun = false } = {}) {
  if (dryRun) return { path: wt, clone, removed: false, wouldRemove: true };
  try {
    run(clone, ['worktree', 'remove', '--force', wt]);
  } catch (e) {
    return { path: wt, clone, removed: false, error: gitError(e) };
  } finally {
    tryRun(clone, ['worktree', 'prune']);
  }
  return { path: wt, clone, removed: !fs.existsSync(wt) };
}
