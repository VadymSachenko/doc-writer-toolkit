import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prId } from './ledger.mjs';

// The ticket worktrees. The runner, not a role, makes the worktree a session works in: one per PR branch, next to the
// target's clone (`<clone's parent>/.worktrees/<repo>/<branch>`), at the branch's head on the remote, detached, so a
// branch checked out in the owner's clone never blocks it. It links the clone's untracked files the stages need
// (`targets[].links`, default `node_modules`) and lists each link in the common git dir's `info/exclude`, since a
// `node_modules/` line in `.gitignore` doesn't match a symlink. The close step removes the worktree with
// `git worktree remove --force`, then prunes; nothing else ever moves a worktree's `.git` link. A step with no worktree
// gets a read checkout instead (`ensureReadCheckout`): one per target, beside the ticket worktrees, detached at
// `origin/<base>`, kept across tickets and never removed by the close step.

// The stages that work on a PR branch, so their session gets the worktree.
export const TREE_STAGES = ['write', 'uaReview', 'pr', 'answerComments', 'styleCheck', 'translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack', 'resync'];
export const DEFAULT_LINKS = ['node_modules'];

const run = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const tryRun = (cwd, args) => {
  try {
    return run(cwd, args);
  } catch {
    return null;
  }
};
// Paths git prints: `-z` output, split on NUL. A path with a non-ASCII byte, a quote, a backslash or a control
// character is quoted in line output (`core.quotePath` covers only the first), so a path matched by name is never read
// from it. Null when git fails.
const tryPaths = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
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
  // `-z`: each attribute ends in NUL, each worktree in one more, so a path is never quoted or split.
  let out;
  try {
    out = execFileSync('git', ['-C', clone, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return [];
  }
  const list = [];
  for (const block of out.split('\0\0')) {
    const lines = block.split('\0');
    const at = lines.find((l) => l.startsWith('worktree '));
    if (!at) continue;
    list.push({ path: at.slice('worktree '.length), prunable: lines.some((l) => l.startsWith('prunable')), locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) });
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
  // Why the worktree can't be brought to the branch's head: the runner starts no session on it (lib/runner.mjs).
  const stuck = [];
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
    // The branch moved on (a fast-forward), or was rewritten (the owner rebased and force-pushed it): a clean worktree
    // whose head the branch once had, by the remote-tracking ref's own log, follows it. A head the branch never had
    // holds a session's unpushed work, and stays.
    const wasBranch = head && (tryRun(wt, ['merge-base', '--is-ancestor', head, remoteBranch]) !== null || (tryRun(clone, ['reflog', 'show', '--format=%H', `refs/remotes/origin/${pr.branch}`]) ?? '').split('\n').includes(head));
    if (dirty) stuck.push(`uncommitted changes to tracked files from an earlier session, left as they are, so it may not be at the branch's head (see the ticket-state README, "A stuck worktree")`);
    else if (wasBranch) {
      if (head !== tryRun(wt, ['rev-parse', remoteBranch])) {
        try {
          run(wt, ['checkout', '-q', '--detach', remoteBranch]);
        } catch (e) {
          stuck.push(`could not move it to origin/${pr.branch}: ${gitError(e)} (see the ticket-state README, "A stuck worktree")`);
        }
      }
    } else stuck.push(`at a commit origin/${pr.branch} never had (an earlier session's work that was never pushed), left as it is, so it is not at the branch's head (see the ticket-state README, "A stuck worktree")`);
  }
  const { linked, missing } = link(clone, wt, target?.links ?? DEFAULT_LINKS);
  exclude(wt, linked);
  for (const name of missing) notes.push(`${name}: not in the clone (${clone}), so not linked`);
  return { repo: pr.repo, branch: pr.branch, base, path: wt, clone, head: tryRun(wt, ['rev-parse', 'HEAD']), push: `git -C ${wt} push origin HEAD:refs/heads/${pr.branch}`, linked, missing, notes, stuck };
}

// A code repo a session reads as evidence (`appRepos`). The runner keeps its own clone of it, bare, under the state
// folder (`<state>/code/<repo>.git`), made once from the repo's https address (`url`) and fetched before each session,
// and makes a read-only checkout of the base as fetched, one per commit (`<state>/code/<repo>/<commit, 12 characters>`)
// and never moved, so two sessions that started at different commits each read their own. The owner's clone (`path`)
// is never touched: no fetch, no prune, no worktree registered there; the runner denies its files to Read and Grep.
// When no other session runs (`othersRunning` false), the checkouts of other commits are removed with
// `git worktree remove`: only the one this session needs stays. One git refuses to remove stays, listed in `kept`.
// Returns { repo, path, commit, url, notes, removed, kept }; one that can't be cloned, has no fetched base, or can't be
// checked out comes back with `error`, and the session still runs. `remote` is where a new clone comes from (tests).
// The commit a worktree is at, or null (no worktree there).
export const headOf = (wt) => (wt && fs.existsSync(wt) ? tryRun(wt, ['rev-parse', 'HEAD']) : null);

// After a session whose PR branch a person moved under it (lib/runner.mjs, `movedUnder`): the worktree's commits that
// never reached the branch (its push was rejected) would leave it stuck at the next step. They are kept under
// `refs/ticket-flow/set-aside/<branch>/<commit>` in the clone, never dropped, and the worktree goes back to `from`, the
// head the session started at, which the branch had: the next `ensureWorktree` then follows the branch to its new head.
// A worktree with uncommitted changes to tracked files, or whose head isn't built on `from`, is left as it is (stuck, as
// before). Returns { ref, commit }, { left: why }, or null when there is nothing to set aside.
export function setAsideWork(pr, wt, from) {
  const head = headOf(wt);
  if (!head || !from || head === from) return null;
  tryRun(wt, ['fetch', '-q', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`]);
  if (tryRun(wt, ['merge-base', '--is-ancestor', head, `refs/remotes/origin/${pr.branch}`]) !== null) return null;
  if (tryRun(wt, ['status', '--porcelain', '--untracked-files=no'])) return { left: 'uncommitted changes to tracked files' };
  if (tryRun(wt, ['merge-base', '--is-ancestor', from, head]) === null) return { left: `its head ${head.slice(0, 7)} is not built on ${from.slice(0, 7)}` };
  const ref = `refs/ticket-flow/set-aside/${pr.branch}/${head.slice(0, 12)}`;
  try {
    run(wt, ['update-ref', ref, head]);
    run(wt, ['checkout', '-q', '--detach', from]);
  } catch (e) {
    return { left: gitError(e) };
  }
  return { ref, commit: head };
}

export const codeTreesRoot = (settings) => path.join(path.resolve(settings.state), 'code');
export const codeClonePath = (settings, app) => path.join(codeTreesRoot(settings), `${app.repo}.git`);
export const codeTreePath = (settings, app, commit) => path.join(codeTreesRoot(settings), app.repo, String(commit).slice(0, 12));
// A clone or a fetch never waits for a password: one that needs it fails, and the brief says so.
const quiet = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
export function ensureCodeTree(settings, app, { remote = app.url, othersRunning = false } = {}) {
  const clone = codeClonePath(settings, app);
  const out = { repo: app.repo, base: app.base, clone, path: null, url: app.url, commit: null, notes: [], removed: [], kept: [] };
  if (!fs.existsSync(path.join(clone, 'HEAD'))) {
    if (!remote) return { ...out, error: `no url for ${app.repo} in appRepos: the runner clones the repo from it` };
    if (fs.existsSync(clone) && fs.readdirSync(clone).length) return { ...out, error: `${clone} exists and is not a clone of ${app.repo}` };
    try {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      quiet(['clone', '-q', '--bare', '--', remote, clone]);
    } catch (e) {
      return { ...out, error: `could not clone ${app.repo}: ${gitError(e)}` };
    }
  }
  try {
    quiet(['-C', clone, 'fetch', '-q', 'origin', `+refs/heads/${app.base}:refs/remotes/origin/${app.base}`]);
  } catch {
    out.notes.push(`could not fetch ${app.base} from origin: this commit may be old, so say so next to each fact read from it`);
  }
  const commit = tryRun(clone, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${app.base}^{commit}`]);
  if (!commit) return { ...out, error: `no ${app.base} fetched into the runner's clone of ${app.repo}` };
  const wt = codeTreePath(settings, app, commit);
  try {
    const registered = listWorktrees(clone).find((x) => canon(x.path) === canon(wt));
    if (!registered || registered.prunable || !fs.existsSync(wt) || tryRun(wt, ['rev-parse', 'HEAD']) !== commit) {
      if (fs.existsSync(wt) && fs.readdirSync(wt).length && !registered) return { ...out, path: wt, error: `${wt} exists and is not a checkout of ${app.repo}` };
      tryRun(clone, ['worktree', 'prune']);
      if (!registered || registered.prunable || !fs.existsSync(wt)) {
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        run(clone, ['worktree', 'add', '-q', '--detach', wt, commit]);
      } else return { ...out, path: wt, error: `${wt} is not at ${commit.slice(0, 12)}` };
    }
  } catch (e) {
    return { ...out, path: wt, error: `the checkout at ${wt}: ${gitError(e)}` };
  }
  if (!othersRunning) {
    const dir = canon(path.join(codeTreesRoot(settings), app.repo)) + path.sep;
    for (const t of listWorktrees(clone)) {
      const at = canon(t.path);
      if (at === canon(wt) || !at.startsWith(dir)) continue;
      (tryRun(clone, ['worktree', 'remove', t.path]) === null ? out.kept : out.removed).push(t.path);
    }
    tryRun(clone, ['worktree', 'prune']);
  }
  return { ...out, path: wt, commit };
}

// What a write left on one PR branch, checked in its worktree: commits beyond the base, and the branch on origin at the
// worktree's head. Returns { head, ahead } or { error }. A worktree the write never touched, a commit made elsewhere (in
// an owner's checkout), or a push of another head is not a written branch. No worktree on this machine: the check
// can't run, so the write can't pass (the runner makes the worktree before the write).
export function writtenIn(settings, pr) {
  const wt = worktreePath(settings, pr);
  if (!wt || !fs.existsSync(wt)) return { error: `no worktree of ${pr.repo} ${pr.branch} at ${wt ?? '(no targets[].path)'}: the pages are written and committed in the worktree the runner makes` };
  const head = tryRun(wt, ['rev-parse', 'HEAD']);
  if (!head) return { error: `${wt} is not a git worktree` };
  const base = pr.base ?? targetOf(settings, pr)?.base ?? 'main';
  const baseRef = hasRef(wt, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
  const ahead = Number(tryRun(wt, ['rev-list', '--count', `${baseRef}..HEAD`]) ?? 0);
  if (!ahead) return { error: `the worktree ${wt} has no commit beyond ${baseRef}: the pages were not committed there` };
  const remote = tryRun(wt, ['ls-remote', 'origin', `refs/heads/${pr.branch}`]);
  if (remote === null) return { error: `could not read ${pr.branch} from origin` };
  const pushed = remote.split(/\s/)[0] || null;
  if (!pushed) return { error: `${pr.branch} is not on origin: push it with git -C ${wt} push origin HEAD:refs/heads/${pr.branch}` };
  if (pushed !== head) return { error: `origin has ${pr.branch} at ${pushed.slice(0, 7)}, the worktree is at ${head.slice(0, 7)}: push the worktree's head` };
  return { head, ahead };
}

// A target clone as a step with no worktree finds it (the plan, the answers). The base is fetched into its
// remote-tracking ref first, as for a worktree, for the read checkout the session reads pages in (`ensureReadCheckout`).
// When that can't be made, the session reads the clone's files as they stand: off its base (a checked-out branch that
// isn't the base, or a detached HEAD: the owner's branch work), or behind `origin/<base>` (the owner merges on the
// forge, so a clone is behind after each merge), its files aren't the site's, and a note for the brief says so and how
// to read the base instead. No session is held for it. The runner never checks out, pulls or resets the clone. Null for
// a clone that isn't on this machine. Returns { repo, clone, base, branch, off, unfetched, notes }.
export function checkClone(settings, target) {
  const clone = clonePath(settings, target);
  if (!clone || !fs.existsSync(clone) || !checkoutKind(clone)) return null;
  const base = target.base ?? 'main';
  const out = { repo: target.repo, clone, base, branch: null, off: false, unfetched: false, notes: [] };
  out.branch = tryRun(clone, ['symbolic-ref', '-q', '--short', 'HEAD']);
  try {
    execFileSync('git', ['-C', clone, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch {
    out.unfetched = true;
    out.notes.push(`could not fetch ${base} from origin`);
  }
  const fetched = hasRef(clone, `refs/remotes/origin/${base}`);
  const readBase = fetched ? `read pages with \`git -C ${clone} show origin/${base}:<path>\`, never its working tree` : `read pages with \`git -C ${clone} show ${base}:<path>\`, never its working tree`;
  if (out.branch !== base) {
    const at = (tryRun(clone, ['rev-parse', '--short', 'HEAD']) ?? '').slice(0, 7);
    out.off = true;
    out.notes.push(`${out.branch ? `on the branch ${out.branch}` : `at a detached HEAD${at ? ` (${at})` : ''}`}, not on its base ${base}: its files are that branch's, not the site's; ${readBase}`);
    return out;
  }
  if (!fetched) return out;
  const count = (range) => Number(tryRun(clone, ['rev-list', '--count', range]) ?? 0);
  const behind = count(`HEAD..origin/${base}`);
  const ahead = count(`origin/${base}..HEAD`);
  if (behind) out.notes.push(`${behind} commit(s) behind origin/${base}: a page merged since is not in its files; ${readBase}`);
  if (ahead) out.notes.push(`${ahead} commit(s) on ${base} that origin doesn't have: its files hold them`);
  return out;
}

// A step with no worktree reads a target's pages in a read checkout, not in the owner's clone: a worktree of the clone,
// detached at `origin/<base>` as `checkClone` fetched it. It lives beside the ticket worktrees, outside every repo
// (`<clone's parent>/.worktrees/<repo>/.read/<target id>`; no branch name starts with a dot), so no repo's write rule
// reaches its pages: a hub that is its own target keeps its state under a `.sources/` folder, and
// `Edit(<hub>/**/.sources/**)` would match every file of a read checkout under it. One whose path has a `.sources/`
// folder in it is refused for the same reason. It is kept across runs and re-pointed (`git checkout --detach`); one
// that won't move, or has changes to tracked files, is removed and added again. The clone's hooks don't run for it. It
// is the runner's, not a ticket's: no ledger records it, and the close step never removes it.
// It is sparse: every `.sources/` folder is left out (`!.sources/`), tracked or not, and the clone's own `.sources/`
// folders are linked in at the same path instead (`linkSources`), so a skill pointed at the read checkout's section reads
// and writes the clone's evidence: the owner's untracked notes and the tracked files as the clone has them. The sparse
// settings are the runner's commands' alone (`-c core.sparseCheckout=true`, with the patterns in the read checkout's own
// `info/sparse-checkout`): nothing is written to the clone's config, and a session's `git status` there still skips the
// left-out files by their index bits. A `.sources/` folder a session makes there for the first time (a real folder) is
// moved into the clone after the session and before any re-point (`adoptSources`), and a link put in its place.
// Everything else in it is read-only to the session: no write rule names it but its `.sources/` folders
// (lib/runner.mjs), and the hook refuses `mkdir` and a script's path there (lib/role-hook.mjs).
// While another session that may read it runs (`othersRunning`), one at another commit, or with changes to tracked
// files, is left as it is, so pages never change under a session still reading them; this session then reads the clone
// with the note, as before. The clone itself is never checked out, pulled or reset: only its list of worktrees changes.
// Returns { path, commit, ref, linked, adopted } or { error } (the brief then falls back to the clone and its note).
export const readCheckoutPath = (settings, target) => {
  const clone = clonePath(settings, target);
  return clone && /^[\w-][\w.-]*$/.test(String(target?.id ?? '')) ? path.join(path.dirname(clone), '.worktrees', path.basename(clone), '.read', target.id) : null;
};
// A path that is a read checkout, by its place: `…/.worktrees/<repo>/.read/<id>`.
export const isReadCheckout = (p) => {
  const parts = path.resolve(p).split(path.sep);
  return parts.length > 4 && parts.at(-2) === '.read' && parts.at(-4) === '.worktrees';
};
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const SPARSE = [...NO_HOOKS, '-c', 'core.sparseCheckout=true', '-c', 'core.sparseCheckoutCone=false', '-c', 'sparse.expectFilesOutsideOfPatterns=true'];
const SPARSE_PATTERNS = '/*\n!.sources/\n';
// The read checkout's own sparse patterns file (`<its git dir>/info/sparse-checkout`, which git keeps per worktree), or
// null when git can't say where its git dir is.
const sparseFile = (rc) => {
  const dir = tryRun(rc, ['rev-parse', '--absolute-git-dir']);
  return dir ? path.join(dir, 'info', 'sparse-checkout') : null;
};
const isSparse = (rc) => {
  try {
    return fs.readFileSync(sparseFile(rc), 'utf8') === SPARSE_PATTERNS;
  } catch {
    return false;
  }
};
const writeSparse = (rc) => {
  const file = sparseFile(rc);
  if (!file) throw new Error(`${rc} has no git dir`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SPARSE_PATTERNS);
};
export function ensureReadCheckout(settings, target, { othersRunning = false } = {}) {
  const clone = clonePath(settings, target);
  const rc = readCheckoutPath(settings, target);
  if (!rc) return { error: `the target id ${JSON.stringify(target?.id ?? null)} is not a plain name, or the target has no clone` };
  if (!fs.existsSync(clone) || !checkoutKind(clone)) return { path: rc, error: `the clone of ${target.repo} is not on this machine` };
  if (rc.split(path.sep).includes('.sources')) return { path: rc, error: `${rc} is under a .sources/ folder, where a write rule for the evidence would reach its pages: move the clone out of it` };
  const ref = `origin/${target.base ?? 'main'}`;
  const commit = tryRun(clone, ['rev-parse', '--verify', '-q', `refs/remotes/${ref}^{commit}`]);
  if (!commit) return { path: rc, error: `no ${ref} fetched in ${clone}` };
  const at = () => tryRun(rc, ['rev-parse', 'HEAD']);
  const dirty = () => tryRun(rc, ['status', '--porcelain', '--untracked-files=no']);
  const add = () => {
    fs.mkdirSync(path.dirname(rc), { recursive: true });
    run(clone, [...NO_HOOKS, 'worktree', 'add', '-q', '--no-checkout', '--detach', rc, commit]);
    writeSparse(rc);
    run(rc, [...SPARSE, 'checkout', '-q', '--detach', commit]);
  };
  const again = () => {
    run(clone, ['worktree', 'remove', '--force', rc]);
    tryRun(clone, ['worktree', 'prune']);
    add();
  };
  let adopted = { moved: [], kept: [] };
  try {
    const registered = listWorktrees(clone).find((x) => canon(x.path) === canon(rc));
    if (!registered || registered.prunable || !fs.existsSync(rc)) {
      // A registration whose folder is gone is pruned first; a folder that isn't this clone's worktree is never touched.
      tryRun(clone, ['worktree', 'prune']);
      if (fs.existsSync(rc) && (!fs.statSync(rc).isDirectory() || fs.readdirSync(rc).length)) return { path: rc, error: strayReadCheckout(rc, target) };
      add();
    } else if (!isSparse(rc)) {
      // Not made sparse (an older one): made again, with nothing of it moved into the clone.
      if (othersRunning) return { path: rc, error: 'another session may be reading it, so it stays as it is (made before it was sparse)' };
      again();
    } else {
      // What an earlier session left in a `.sources/` folder of its own goes into the clone before anything moves; never
      // while another session may still be writing there.
      if (!othersRunning) adopted = adoptSources(settings, clone, rc);
      if (at() !== commit || dirty()) {
        const head = at();
        if (othersRunning) return { path: rc, error: `another session may be reading it, so it stays ${head !== commit ? `at ${head ? head.slice(0, 7) : 'its commit'}` : 'as it is (changes to tracked files)'}` };
        writeSparse(rc);
        if (dirty() || tryRun(rc, [...SPARSE, 'checkout', '-q', '--detach', commit]) === null) again();
      }
    }
  } catch (e) {
    return { path: rc, error: `the read checkout at ${rc}: ${gitError(e)}` };
  }
  if (at() !== commit) return { path: rc, error: `${rc} is not at ${ref}` };
  return { path: rc, commit, ref, linked: linkSources(settings, clone, rc), adopted };
}

// Why a folder in a read checkout's place isn't one, and how to clear it: most often a worktree of another clone of the
// same repo, one that was at this path before (`targets[].path` changed back and forth).
function strayReadCheckout(rc, target) {
  const owner = checkoutKind(rc) === 'worktree' ? cloneOf(rc) : null;
  if (owner && fs.existsSync(owner)) return `${rc} exists and is not a read checkout of ${target.repo}: it is a worktree of ${owner} (did targets[].path change?); clear it with \`git -C ${owner} worktree remove --force ${rc}\`, and the next step makes it again`;
  if (checkoutKind(rc) === 'worktree') return `${rc} exists and is not a read checkout of ${target.repo}: a worktree of a clone that is gone; move the folder to the Trash, and the next step makes it again`;
  return `${rc} exists and is not a read checkout of ${target.repo}: move it away, and the next step makes it again`;
}

// The `.sources/` folders under a folder, by their path from it, each with its kind (`dir` or `link`). Never through a
// link, `.git`, `node_modules` or a build's output, into another checkout (a clone kept inside the hub), and never
// inside `skip` (the state folder).
const NOT_WALKED = new Set(['.git', 'node_modules', 'build', '.docusaurus', '.worktrees']);
function sourcesFolders(root, skip = () => false) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.name === '.sources' && (e.isDirectory() || e.isSymbolicLink())) {
        out.push({ rel: r, kind: e.isSymbolicLink() ? 'link' : 'dir' });
        continue;
      }
      if (!e.isDirectory() || NOT_WALKED.has(e.name) || skip(abs) || fs.existsSync(path.join(abs, '.git'))) continue;
      walk(abs, r);
    }
  };
  walk(root, '');
  return out;
}
const within = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Each `.sources/` folder of the clone, tracked or not, as a link in the read checkout, at the same path (the sparse
// patterns leave the read checkout's own out); a link whose folder is gone goes. A folder that holds the state folder
// (a hub's own, when the hub is a target) is never linked. Returns the linked paths.
export function linkSources(settings, clone, rc) {
  const state = canon(settings.state);
  const skip = (abs) => within(canon(abs), state) || within(canon(abs), canon(rc));
  const linked = [];
  for (const { rel, kind } of sourcesFolders(clone, skip)) {
    const src = path.join(clone, rel);
    if (kind !== 'dir' || within(state, canon(src))) continue;
    const at = path.join(rc, rel);
    let st = null;
    try {
      st = fs.lstatSync(at);
    } catch {
      /* not there */
    }
    try {
      if (st?.isSymbolicLink()) {
        if (fs.readlinkSync(at) === src) {
          linked.push(rel);
          continue;
        }
        fs.unlinkSync(at);
      } else if (st) continue; // a real folder: a session's, which `adoptSources` moves first
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(src, at);
      linked.push(rel);
    } catch {
      // a path the read checkout holds as a file: no link there
    }
  }
  for (const { rel, kind } of sourcesFolders(rc)) {
    const at = path.join(rc, rel);
    if (kind === 'link' && !fs.existsSync(at)) fs.unlinkSync(at);
  }
  return linked;
}

// A `.sources/` folder a session made in the read checkout (a real folder: git writes none there, the sparse patterns
// leave them out) goes into the clone at the same path, and a link takes its place. Into a folder the clone has by then, file by file: a file the
// clone has too is kept, and the session's goes beside it as `<name>.from-read-checkout`. Never into the state folder,
// and never out of the clone. A link inside it is left (it goes with the read checkout). Returns { moved, kept }.
export function adoptSources(settings, clone, rc) {
  const out = { moved: [], kept: [] };
  if (!fs.existsSync(rc)) return out;
  const state = canon(settings.state);
  for (const { rel, kind } of sourcesFolders(rc)) {
    if (kind !== 'dir') continue;
    const from = path.join(rc, rel);
    const to = path.join(clone, rel);
    if (within(canon(to), state) || within(state, canon(to)) || !within(canon(to), canon(clone))) {
      out.kept.push({ path: rel, reason: 'it would land in the state folder or outside the clone' });
      continue;
    }
    try {
      moveInto(from, to);
      fs.rmSync(from, { recursive: true, force: true });
      fs.symlinkSync(to, from);
      out.moved.push(rel);
    } catch (e) {
      out.kept.push({ path: rel, reason: String(e.message ?? e).split('\n')[0] });
    }
  }
  return out;
}
function moveInto(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    if (e.isDirectory()) moveInto(src, dest);
    else if (e.isFile()) {
      let free = dest;
      for (let n = 1; fs.existsSync(free); n++) free = `${dest}.from-read-checkout${n > 1 ? `-${n}` : ''}`;
      fs.copyFileSync(src, free, fs.constants.COPYFILE_EXCL);
    }
  }
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

// Work in a worktree that no remote has: commits on no remote-tracking ref (unless the head is one the forge had, in
// `pushed`, or behind one), changes to tracked files, untracked files git doesn't ignore (a page a session wrote and never added), and
// ignored work files: anything under a `.sources/` folder (notes, interviews, frames) or matching `keep` (the
// `cleanup.keep` globs, over the path from the worktree's top). Other ignored files (the linked `node_modules` and
// `.env`, `build/`, `.docusaurus/`, a pack's output) go with the worktree.
export const isWorkFile = (rel, keep = []) => /(^|\/)\.sources(\/|$)/.test(rel) || keep.some((re) => re.test(rel));
export function unsavedWork(wt, pushed = [], { keep = [] } = {}) {
  const reasons = [];
  const status = tryRun(wt, ['status', '--porcelain', '--untracked-files=all']);
  if (status === null) return ['git can not read it'];
  const lines = status.split('\n').filter(Boolean);
  const changed = lines.filter((l) => !l.startsWith('??'));
  const untracked = lines.filter((l) => l.startsWith('??'));
  if (changed.length) reasons.push(`${changed.length} tracked file(s) changed and not committed`);
  if (untracked.length) reasons.push(`${untracked.length} untracked file(s) never added (${untracked.slice(0, 3).map((l) => l.slice(3)).join(', ')}${untracked.length > 3 ? ', …' : ''})`);
  const ignored = tryPaths(wt, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']);
  if (ignored === null) return ['git can not read it'];
  const work = ignored.filter((rel) => isWorkFile(rel, keep));
  if (work.length) reasons.push(`${work.length} ignored work file(s) (${work.slice(0, 3).join(', ')}${work.length > 3 ? ', …' : ''})`);
  const head = tryRun(wt, ['rev-parse', 'HEAD']);
  const unpushed = (tryRun(wt, ['rev-list', 'HEAD', '--not', '--remotes']) ?? '').split('\n').filter(Boolean);
  // A head the forge had, or one behind it (a later push built on it), was on the forge, whatever the remote-tracking
  // refs say now (the branch deleted after the merge, then pruned).
  const onForge = (h) => head?.startsWith(String(h)) || (head && tryRun(wt, ['merge-base', '--is-ancestor', head, String(h)]) !== null);
  if (unpushed.length && !pushed.filter(Boolean).some(onForge)) reasons.push(`${unpushed.length} commit(s) on no remote branch`);
  return reasons;
}

// Removes one worktree the way git does (`git worktree remove`, never `--force`), then prunes the clone's list. Never
// by moving files: the folder and its `.git` link go together, or nothing goes. The linked names are ignored files, so
// git removes the links and leaves what they point to. A worktree with work no remote has is kept, with what to do;
// so is one git refuses to remove (a locked one needs `worktree unlock` first).
export function removeWorktree(clone, wt, { dryRun = false, pushed = [], branch = null, keep = [] } = {}) {
  const push = branch ? `push it (\`git -C ${wt} push origin HEAD:refs/heads/${branch}\`) or ` : '';
  const locked = listWorktrees(clone).find((x) => canon(x.path) === canon(wt))?.locked;
  const unlock = locked ? `\`git -C ${clone} worktree unlock ${wt}\`, then ` : '';
  const todo = `${push}copy what you need (and move the work files to the Trash), then ${unlock}\`git -C ${clone} worktree remove --force ${wt}\``;
  const work = unsavedWork(wt, pushed, { keep });
  if (work.length) return { path: wt, clone, removed: false, kept: work.join('; '), todo };
  if (dryRun) return { path: wt, clone, removed: false, wouldRemove: true };
  try {
    run(clone, ['worktree', 'remove', wt]);
  } catch (e) {
    return { path: wt, clone, removed: false, kept: `git would not remove it${locked ? ' (locked)' : ''}: ${gitError(e)}`, todo };
  } finally {
    tryRun(clone, ['worktree', 'prune']);
  }
  return { path: wt, clone, removed: !fs.existsSync(wt) };
}
