import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { CliError } from '../../ui-labels/lib/util.mjs';

const run = promisify(execFile);

export const git = (cwd, args) => run('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);

// The output as bytes: a multi-byte letter may be split across two chunks, and `--batch` gives sizes in bytes.
function gitWithInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args.join(' ')} failed: ${err.trim()}`))));
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

// The text of these blobs, read by one `git cat-file --batch` process: Map<hash, text>, decoded as `blobText` decodes.
// A hash that names no blob here (missing, ambiguous, another object type) is left out of the map, and so is anything
// that is not a hex object name. An answer the parser does not expect throws.
export async function blobTexts(root, hashes) {
  const list = [...new Set(hashes)].filter((h) => typeof h === 'string' && /^[0-9a-f]{4,64}$/.test(h));
  const texts = new Map();
  if (!list.length) return texts;
  const out = await gitWithInput(root, ['cat-file', '--batch'], list.join('\n') + '\n');
  const decoder = new StringDecoder('utf8');
  let at = 0;
  // One answer per input line, in input order: `<sha> <type> <size>\n<size bytes>\n`, or `<input> missing\n` (or
  // `ambiguous`) with no body.
  for (const hash of list) {
    const eol = out.indexOf(0x0a, at);
    const header = eol < 0 ? '' : out.toString('latin1', at, eol);
    at = eol + 1;
    if (header === `${hash} missing` || header === `${hash} ambiguous`) continue;
    const m = header.match(/^([0-9a-f]+) (\w+) (\d+)$/);
    const size = Number(m?.[3]);
    if (!m || !m[1].startsWith(hash) || out[at + size] !== 0x0a) throw new Error(`git cat-file --batch: unexpected answer for ${hash}: '${header}'.`);
    if (m[2] === 'blob') texts.set(hash, decoder.write(out.subarray(at, at + size)) + decoder.end());
    at += size + 1;
  }
  return texts;
}

// Which of these blob hashes exist in the repository?
export async function existingBlobs(root, hashes) {
  const list = [...new Set(hashes.filter(Boolean))];
  if (!list.length) return new Set();
  const out = (await gitWithInput(root, ['cat-file', '--batch-check'], list.join('\n') + '\n')).toString('utf8');
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
