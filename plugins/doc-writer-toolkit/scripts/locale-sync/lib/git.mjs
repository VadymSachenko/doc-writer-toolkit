import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from '../../ui-labels/lib/util.mjs';

const run = promisify(execFile);

export const git = (cwd, args) => run('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);

function gitWithInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(' ')} failed: ${err.trim()}`))));
    child.stdin.end(input);
  });
}

export async function headCommit(root) {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    throw new CliError(`${root} is not a git repository with at least one commit. The stale check reads committed content.`, { code: 2 });
  }
}

// { 'docs/archive/archive.md': '<blob sha>' } for every file under `dir` at HEAD. One git call. Paths are relative to `root`.
export async function lsTree(root, dir) {
  const out = await git(root, ['ls-tree', '-r', '-z', 'HEAD', '--', dir]);
  const files = new Map();
  for (const entry of out.split('\0')) {
    const m = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s);
    if (m && m[2] === 'blob' && m[1] !== '120000') files.set(m[4], m[3]);
  }
  return files;
}

export const blobText = (root, hash) => git(root, ['cat-file', 'blob', hash]);

// Which of these blob hashes exist in the repository?
export async function existingBlobs(root, hashes) {
  const list = [...new Set(hashes.filter(Boolean))];
  if (!list.length) return new Set();
  const out = await gitWithInput(root, ['cat-file', '--batch-check'], list.join('\n') + '\n');
  const found = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40}) blob /);
    if (m) found.add(m[1]);
  }
  return found;
}

// Files under `dir` with uncommitted changes (modified, staged or untracked), as paths relative to `root`.
export async function uncommitted(root, dir) {
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
  const out = await git(root, ['status', '--porcelain', '-z', '-uall', '--', dir]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    let file = p.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the rename source
    if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
    files.push({ path: file, status: code.trim() || '?' });
  }
  return files;
}
