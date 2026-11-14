// The ticket's commits in a code repo, with no model: the commits whose message names the ticket key, read with
// `git log` in the runner's read-only checkout of the repo (`ensureCodeTree`, lib/worktree.mjs), from the commit fetched
// for the session. Never in an owner's clone. Only that commit's history is read: a commit on a branch not merged into
// the base is not there.
//
// Git's own `--grep` takes the key as a fixed string (no regular expression engine of git's is assumed), over a bounded
// number of commits; the host's pattern (`ticketCommits.pattern`, `<key>` in it) or the key as a whole word then picks
// the commits whose whole message matches, newest first, up to the limit. Each comes with its sha, author date, author
// name, subject (cut at `SUBJECT_MAX`: it is the org's text, which the brief gives as data) and changed files (a few,
// then how many more). Nothing here throws: a git error is a note. The files are read with `--no-renames`, so a related
// repo's partial clone (lib/worktree.mjs) fetches no file content for them.

import { execFileSync } from 'node:child_process';

// How many commits git's fixed-string search may give before the pattern picks from them, how many files a commit
// lists in the brief, and how long a subject may be there.
export const SCAN = 500;
export const FILES_SHOWN = 10;
export const SUBJECT_MAX = 200;
const TIMEOUT_MS = 30_000;

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
// The key as a whole word: no letter, digit or underscore on either side, so `feat-1157`, `fix-1157`, `#1157` and
// `1157` match, `11570` and `a1157` don't.
export const DEFAULT_PATTERN = '(?<![A-Za-z0-9_])<key>(?![A-Za-z0-9_])';
export const keyRegex = (key, pattern) => new RegExp((pattern ?? DEFAULT_PATTERN).split('<key>').join(escape(key)), 'i');

const git = (dir, args, timeout) =>
  execFileSync('git', ['-C', dir, '-c', 'log.showSignature=false', '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
const gitError = (e, timeout) => (e?.code === 'ETIMEDOUT' || (e?.signal === 'SIGTERM' && e?.status === null) ? `timed out after ${Math.round(timeout / 1000)} s` : String(e?.stderr || e?.message || e).trim().split('\n')[0].slice(0, 200));
const cut = (s) => (s.length > SUBJECT_MAX ? `${s.slice(0, SUBJECT_MAX - 1)}…` : s);

// The commits of `dir`'s history from `commit` (HEAD when none) whose message names `key`. Returns { commits, more,
// error? }: `commits` newest first, at most `limit`; `more` true when more matched than were kept, or when git's search
// stopped at `SCAN` (older ones may name it too). `timeoutMs` bounds each git call.
export function ticketCommits(dir, key, { commit = 'HEAD', pattern = null, limit = 20, timeoutMs = TIMEOUT_MS, scan = SCAN } = {}) {
  const out = { key, commits: [], more: false };
  if (!dir || !key) return { ...out, error: 'no checkout to read' };
  let re;
  try {
    re = keyRegex(key, pattern);
  } catch (e) {
    return { ...out, error: `ticketCommits.pattern: ${e.message}` };
  }
  let log;
  try {
    log = git(dir, ['log', '--no-color', '--fixed-strings', '-i', `--grep=${key}`, '-n', String(scan), '--format=%x1e%H%x1f%as%x1f%an%x1f%s%x1f%B%x1d', commit, '--'], timeoutMs);
  } catch (e) {
    return { ...out, error: `git log: ${gitError(e, timeoutMs)}` };
  }
  const found = [];
  const records = log.split('\x1e').slice(1);
  for (const rec of records) {
    const [sha, date, author, subject, body = ''] = rec.split('\x1d')[0].split('\x1f');
    if (re.test(body) || re.test(subject)) found.push({ sha, date, author: cut(author), subject: cut(subject) });
  }
  out.more = found.length > limit || records.length >= scan;
  out.commits = found.slice(0, limit);
  if (!out.commits.length) return out;
  // The files each one changed, in one more call (a merge lists none: its changes are its parents').
  try {
    const names = git(dir, ['show', '--no-color', '--no-renames', '--name-only', '--format=%x1e%H', ...out.commits.map((c) => c.sha), '--'], timeoutMs);
    const files = new Map(names.split('\x1e').slice(1).map((r) => {
      const [sha, ...rest] = r.split('\n');
      return [sha.trim(), rest.map((x) => x.trim()).filter(Boolean)];
    }));
    for (const c of out.commits) c.files = files.get(c.sha) ?? [];
  } catch (e) {
    for (const c of out.commits) c.files = [];
    out.error = `git show: ${gitError(e, timeoutMs)} (the files are not listed)`;
  }
  return out;
}

// The lookup for each key of a step in each code checkout that was made (`codeTrees`), one entry per repo:
// { repo, related, path, commit, keys: [{ key, commits, more, error? }] }. A checkout that couldn't be made is left out:
// its own line in the brief says so. `budgetMs` is the time for every repo and key together: each git call gets what is
// left (at most its own timeout), and a lookup the budget no longer covers is not run, its key said not searched.
export function ticketCommitsFor(trees, keys, { pattern = null, limit = 20, lookup = ticketCommits, budgetMs = Infinity, now = Date.now } = {}) {
  const end = now() + budgetMs;
  return (trees ?? []).filter((t) => !t.error && t.path).map((t) => {
    const seen = new Set();
    const per = keys.map((k) => {
      const left = end - now();
      if (left <= 0) return { key: k, commits: [], more: false, error: `the lookup's time (${Math.round(budgetMs / 1000)} s for every repo) ran out before this one` };
      let r;
      try {
        r = lookup(t.path, k, { commit: t.commit ?? 'HEAD', pattern, limit, timeoutMs: Math.max(1, Math.min(TIMEOUT_MS, left)) });
      } catch (e) {
        r = { key: k, commits: [], more: false, error: String(e?.message ?? e).slice(0, 200) };
      }
      // A commit that names two keys of a group is listed once, under the first.
      return { more: false, ...r, key: k, commits: (Array.isArray(r?.commits) ? r.commits : []).filter((c) => !seen.has(c.sha) && seen.add(c.sha)) };
    });
    return { repo: t.repo, related: Boolean(t.related), path: t.path, commit: t.commit, keys: per };
  });
}
