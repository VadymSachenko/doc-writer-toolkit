import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canon, checkoutKind, clonePath, cloneOf, isReadCheckout, listWorktrees, removeWorktree, targetOf, worktreePath } from './worktree.mjs';

// Cleanup when a ticket's PRs are merged (D-074). The ticket's work files outside git (videos and their parts, audio,
// transcripts, frames, downloaded attachments, run folders, clones) are recorded in the ledger as each stage makes
// them (`files`). The close step removes them, except:
//   - a path the ledger did not record (nothing is found by searching);
//   - a path git tracks, in its own repo;
//   - a path outside the host repo and the state root;
//   - a path the keep list names (`cleanup.keep`: the distilled notes later page updates read);
//   - everything, while a PR of the ticket is open or was closed unmerged; a PR closed as won't merge
//     (`forge.wontMergeLabel`, dropped from the ticket) keeps nothing, and its branch on the forge is never touched.
// `cleanup.mode` `trash` (default) moves them into the macOS Trash, `delete` removes them.
// First, the ticket's worktrees (lib/worktree.mjs) go with `git worktree remove --force`, then the clone's list is
// pruned. A recorded folder that is a worktree, or holds one, goes the same way; one that is a repository of its own is
// kept whole. A `.git` link or folder is never moved on its own: the checkout and its link go together, or nothing does.

export const KINDS = ['video', 'videoPart', 'audio', 'transcript', 'frames', 'attachment', 'runDir', 'clone', 'other'];
export const DEFAULT_KEEP = ['**/sme-interview.md', '**/app-notes.md'];

// A glob as a regular expression over a path from the host root: `**` any folders, `*` any name part, `?` one char.
export function globRe(glob) {
  let re = '';
  const g = String(glob).replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function sizeOf(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  for (const e of fs.readdirSync(abs)) sum += sizeOf(path.join(abs, e));
  return sum;
}

// The files under a path, and nothing inside a folder in `skip` (a checkout, handled whole before the walk).
function walk(abs, skip = new Set()) {
  if (skip.has(abs)) return [];
  const st = fs.lstatSync(abs);
  if (!st.isDirectory()) return [abs];
  return fs.readdirSync(abs).flatMap((e) => walk(path.join(abs, e), skip));
}

// The checkouts at or under a folder (a folder with a `.git` link or folder), not looking inside one, nor through a link.
function checkoutsUnder(abs) {
  const kind = checkoutKind(abs);
  if (kind) return [{ path: abs, kind }];
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).flatMap((e) => checkoutsUnder(path.join(abs, e.name)));
}

const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

// The files under a path that git tracks, in the repo that holds the path (none outside a repo).
export function trackedUnder(abs) {
  const dir = fs.existsSync(abs) && fs.lstatSync(abs).isDirectory() ? abs : path.dirname(abs);
  const top = git(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return [];
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = path.relative(real(top), real(abs)) || '.';
  const out = git(top, ['ls-files', '-z', '--', rel]);
  return (out ?? '').split('\0').filter(Boolean).map((f) => path.join(top, f));
}

// Where the Trash is, and a name there no file has yet ("name", "name 2", "name 3" …, as the Finder does).
function trashTarget(trashDir, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} ${n}${ext}`;
    const dest = path.join(trashDir, name);
    if (!fs.existsSync(dest)) return dest;
  }
}

// Moves a path into the Trash: a rename, or across volumes a copy then a removal.
export function moveToTrash(abs, trashDir) {
  fs.mkdirSync(trashDir, { recursive: true });
  const dest = trashTarget(trashDir, path.basename(abs));
  try {
    fs.renameSync(abs, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(abs, dest, { recursive: true, preserveTimestamps: true });
    fs.rmSync(abs, { recursive: true, force: true });
  }
  return dest;
}

// What the close step removes for one ticket, and does. `prState(pr)`: the forge's state of a PR of the ticket
// (`merged`, `open`, `closed`, or `dropped` for one closed with `forge.wontMergeLabel`); `forgeHeads`: the heads the forge gives for them now. With `dryRun` nothing is removed:
// the list says what would go.
export function cleanupTicket({ settings, ledger, prState, forgeHeads = [], dryRun = false, trashDir = path.join(os.homedir(), '.Trash') }) {
  const { mode, keep } = settings.cleanup;
  const out = { mode, dryRun, removed: [], kept: [], deletedWithWorktree: [], freedBytes: 0, blocked: null, worktrees: [] };
  const files = ledger.files ?? [];
  // The ticket's worktrees: one per PR branch, made by the runner.
  // The heads the forge had for the ticket's PRs, as the forge gave them (a record's check, the close step's read): a
  // worktree at one of them, or behind one, holds nothing unpushed. Never `pipelineCommits`: that is what a session
  // reported, whether or not its push went through.
  const pushed = [...(ledger.prs ?? []).flatMap((p) => [p.lastSeenHead, ...(p.readyForMerge ?? []).map((r) => r.head)]), ...forgeHeads].filter(Boolean);
  const trees = (ledger.prs ?? [])
    .map((p) => ({ path: worktreePath(settings, p), clone: clonePath(settings, targetOf(settings, p)), branch: p.branch }))
    .filter((t) => t.path && t.clone && listWorktrees(t.clone).some((x) => canon(x.path) === canon(t.path)));
  if (!files.length && !trees.length) return out;
  const open = (ledger.prs ?? []).filter((p) => !p.number || !['merged', 'dropped'].includes(prState(p)));
  if (!(ledger.prs ?? []).length || open.length) {
    const closed = open.filter((p) => p.number && prState(p) === 'closed');
    out.blocked = closed.length ? `${closed.map((p) => `${p.repo}#${p.number}`).join(', ')} closed unmerged: nothing is removed` : `${open.length ? open.map((p) => (p.number ? `${p.repo}#${p.number}` : `${p.repo}:${p.branch}`)).join(', ') : 'no PR'} not merged: nothing is removed`;
    out.kept = [...trees.map((t) => ({ path: t.path, reason: 'not every PR is merged' })), ...files.map((f) => ({ path: f.path, reason: 'not every PR is merged' }))];
    return out;
  }
  // `git worktree remove` (never `--force`), then prune: the worktree and its `.git` link go together. One with work
  // files (`.sources/`, the keep list) or unsaved work is kept.
  const keeps = (keep ?? []).map(globRe);
  for (const t of trees) out.worktrees.push(removeWorktree(t.clone, t.path, { dryRun, pushed, branch: t.branch, keep: keeps }));
  const roots = [settings.root, settings.state].map((r) => path.resolve(r));
  const kept = (abs) => keeps.some((re) => re.test(path.relative(settings.root, abs).split(path.sep).join('/')));
  const go = (abs, entry) => {
    const bytes = sizeOf(abs);
    if (!dryRun) {
      if (mode === 'delete') fs.rmSync(abs, { recursive: true, force: true });
      else moveToTrash(abs, trashDir);
    }
    out.removed.push({ path: path.relative(settings.root, abs), kind: entry.kind ?? 'other', bytes });
    out.freedBytes += bytes;
  };
  for (const entry of files) {
    const abs = path.resolve(settings.root, entry.path);
    // A recorded file a session wrote inside a ticket worktree went, or stays, with that worktree. One that went was an
    // ignored file outside `.sources/` and the keep list (a pack's output, say): git deleted it with the worktree, so it
    // is not in the Trash, and the record says so.
    const inTree = out.worktrees.find((t) => inside(canon(abs), canon(t.path)));
    if (inTree) {
      if (inTree.removed || inTree.wouldRemove) out.deletedWithWorktree.push({ path: entry.path, worktree: inTree.path, kind: entry.kind ?? 'other' });
      else out.kept.push({ path: entry.path, reason: `inside the worktree ${inTree.path}, kept with it` });
      continue;
    }
    if (!roots.some((r) => inside(abs, r))) {
      out.kept.push({ path: entry.path, reason: 'outside the host repo and the state root' });
      continue;
    }
    if (!fs.existsSync(abs)) {
      out.kept.push({ path: entry.path, reason: 'already gone' });
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      real = abs;
    }
    if (!roots.some((r) => inside(real, fs.existsSync(r) ? fs.realpathSync(r) : r))) {
      out.kept.push({ path: entry.path, reason: 'a link that leads outside the host repo and the state root' });
      continue;
    }
    const isDir = fs.lstatSync(abs).isDirectory();
    // A recorded folder that is, or holds, a checkout: a worktree goes with git (never its files one by one, which
    // would move its `.git` link alone); a repository of its own is kept whole.
    const skip = new Set();
    const whole = new Set();
    if (isDir) {
      for (const c of checkoutsUnder(abs)) {
        const r = path.relative(settings.root, c.path);
        const clone = c.kind === 'worktree' ? cloneOf(c.path) : null;
        // A read checkout is the runner's, kept across tickets (lib/worktree.mjs, `ensureReadCheckout`): never the
        // ticket's to remove, even inside a folder a session recorded.
        if (isReadCheckout(c.path)) out.kept.push({ path: r, reason: 'the runner\'s read checkout, shared by every ticket: kept whole, never split' });
        else if (clone) {
          const bytes = sizeOf(c.path);
          const res = removeWorktree(clone, c.path, { dryRun, pushed, keep: keeps });
          out.worktrees.push(res);
          skip.add(c.path);
          if (res.removed || res.wouldRemove) {
            out.removed.push({ path: r, kind: 'worktree', bytes });
            out.freedBytes += bytes;
            continue;
          }
          out.kept.push({ path: r, reason: res.kept ? `a worktree kept whole (${res.kept}); ${res.todo}` : `a worktree git would not remove (${res.error}): never split` });
        } else out.kept.push({ path: r, reason: c.kind === 'repo' ? 'a repository of its own: kept whole, never split' : 'a worktree whose clone is not found: kept whole, never split' });
        skip.add(c.path);
        whole.add(c.path);
      }
      if (!fs.existsSync(abs) || skip.has(abs)) continue;
    }
    const tracked = new Set(trackedUnder(abs).map((p) => path.resolve(p)));
    if (!isDir) {
      if (tracked.has(abs) || tracked.has(real)) out.kept.push({ path: entry.path, reason: 'git tracks it' });
      else if (kept(abs)) out.kept.push({ path: entry.path, reason: 'on the keep list' });
      else go(abs, entry);
      continue;
    }
    // A folder: whole when nothing in it is tracked, kept or a checkout; else file by file, keeping those.
    const inner = walk(abs, skip);
    const holds = inner.filter((f) => tracked.has(path.resolve(f)) || kept(f));
    if (!holds.length && !tracked.size && !whole.size && !(dryRun && skip.size)) {
      go(abs, entry);
      continue;
    }
    for (const f of inner) {
      const r = path.relative(settings.root, f);
      if (tracked.has(path.resolve(f))) out.kept.push({ path: r, reason: 'git tracks it' });
      else if (kept(f)) out.kept.push({ path: r, reason: 'on the keep list' });
      else go(f, entry);
    }
  }
  return out;
}

// The size of a recorded path now (a folder's files summed), for the ledger.
export const recordedSize = (root, rel) => sizeOf(path.resolve(root, rel));
