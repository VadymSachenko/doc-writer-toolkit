import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './util.mjs';

const run = promisify(execFile);
const enc = encodeURIComponent;
const encPath = (p) => p.split('/').map(enc).join('/');

async function api(endpoint, { raw = false, jq, paginate = false } = {}) {
  const args = ['api'];
  if (raw) args.push('-H', 'Accept: application/vnd.github.raw');
  if (paginate) args.push('--paginate');
  if (jq) args.push('--jq', jq);
  args.push(endpoint);
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new CliError('The `gh` CLI is not installed or not on PATH. Install it and run `gh auth login`.');
    }
    throw new CliError(`gh api ${endpoint} failed: ${(e.stderr || e.message).trim()}`);
  }
}

// SHA of the latest commit on `ref` that touched `dir`. This is the cheap "did the locale files change?" signal.
export async function latestCommit(repo, ref, dir) {
  const out = await api(`repos/${repo}/commits?sha=${enc(ref)}&path=${enc(dir)}&per_page=1`, { jq: '.[0].sha // empty' });
  return out.trim() || null;
}

export async function listDir(repo, ref, dir) {
  const out = await api(`repos/${repo}/contents/${encPath(dir)}?ref=${enc(ref)}`);
  return JSON.parse(out);
}

export const readFile = (repo, ref, file) =>
  api(`repos/${repo}/contents/${encPath(file)}?ref=${enc(ref)}`, { raw: true });

export async function listBranches(repo) {
  const out = await api(`repos/${repo}/branches?per_page=100`, { paginate: true, jq: '.[].name' });
  return out.split('\n').filter(Boolean);
}

// Merge base of `head` against `base`, and the files `head` changed since then.
export async function compare(repo, base, head) {
  const out = await api(`repos/${repo}/compare/${enc(base)}...${enc(head)}`, {
    jq: '{mergeBase: .merge_base_commit.sha, files: [.files[].filename]}',
  });
  return JSON.parse(out);
}
