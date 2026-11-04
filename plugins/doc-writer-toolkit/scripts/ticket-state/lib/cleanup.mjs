import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Cleanup when a ticket's PRs are merged (D-074). The ticket's work files outside git (videos and their parts, audio,
// transcripts, frames, downloaded attachments, run folders, clones) are recorded in the ledger as each stage makes
// them (`files`). The close step removes them, except:
//   - a path the ledger did not record (nothing is found by searching);
//   - a path git tracks, in its own repo;
//   - a path outside the host repo and the state root;
//   - a path the keep list names (`cleanup.keep`: the distilled notes later page updates read);
//   - everything, while a PR of the ticket is open or was closed unmerged.
// `cleanup.mode` `trash` (default) moves them into the macOS Trash, `delete` removes them.

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

function walk(abs) {
  const st = fs.lstatSync(abs);
  if (!st.isDirectory()) return [abs];
  return fs.readdirSync(abs).flatMap((e) => walk(path.join(abs, e)));
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
// (`merged`, `open`, `closed`). With `dryRun` nothing is removed: the list says what would go.
export function cleanupTicket({ settings, ledger, prState, dryRun = false, trashDir = path.join(os.homedir(), '.Trash') }) {
  const { mode, keep } = settings.cleanup;
  const out = { mode, dryRun, removed: [], kept: [], freedBytes: 0, blocked: null };
  const files = ledger.files ?? [];
  if (!files.length) return out;
  const open = (ledger.prs ?? []).filter((p) => !p.number || prState(p) !== 'merged');
  if (!(ledger.prs ?? []).length || open.length) {
    const closed = open.filter((p) => p.number && prState(p) === 'closed');
    out.blocked = closed.length ? `${closed.map((p) => `${p.repo}#${p.number}`).join(', ')} closed unmerged: nothing is removed` : `${open.length ? open.map((p) => (p.number ? `${p.repo}#${p.number}` : `${p.repo}:${p.branch}`)).join(', ') : 'no PR'} not merged: nothing is removed`;
    out.kept = files.map((f) => ({ path: f.path, reason: 'not every PR is merged' }));
    return out;
  }
  const roots = [settings.root, settings.state].map((r) => path.resolve(r));
  const keeps = (keep ?? []).map(globRe);
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
    const tracked = new Set(trackedUnder(abs).map((p) => path.resolve(p)));
    const isDir = fs.lstatSync(abs).isDirectory();
    if (!isDir) {
      if (tracked.has(abs) || tracked.has(real)) out.kept.push({ path: entry.path, reason: 'git tracks it' });
      else if (kept(abs)) out.kept.push({ path: entry.path, reason: 'on the keep list' });
      else go(abs, entry);
      continue;
    }
    // A folder: whole when nothing in it is tracked or kept; else file by file, keeping those.
    const inner = walk(abs);
    const holds = inner.filter((f) => tracked.has(path.resolve(f)) || kept(f));
    if (!holds.length && !tracked.size) {
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
