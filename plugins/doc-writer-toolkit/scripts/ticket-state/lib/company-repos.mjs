import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError } from './errors.mjs';

// Every company repo the answer pass reads (`companyRepos`, TASK-105): the host's list, or its forge org resolved at
// each run. Read only at the answer pass (lib/answer-pass.mjs): no other stage clones, fetches or names them.
//
//   - a list: [{ "repo", "url", "base", "path" }], the shape of `appRepos` (`path`, the owner's clone, is denied to
//     every session); a name may be in `appRepos` or `relatedRepos` too, and then shares the runner's clone of it;
//   - an org: { "org", "exclude": [names], "path": "<a path from the host root with <repo> in it>" }, resolved by
//     `gh repo list <org>` at each run, so a new repo is picked up with no edit; archived repos and `exclude` are left
//     out, and `path` names where the owner keeps each clone, to deny it (none: no clone of theirs is known).

const fail = (msg) => {
  throw new CliError(`ticket flow settings: ${msg}`, { code: 2 });
};
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const plainName = (v) => typeof v === 'string' && /^[^/\\\s]+$/.test(v) && v !== '.' && v !== '..';
const relPath = (p) => typeof p === 'string' && p.trim() !== '' && !path.isAbsolute(p);
const LIST_KEYS = ['repo', 'url', 'base', 'path'];
const ORG_KEYS = ['org', 'exclude', 'path'];

// The setting, checked: `null` when unset (no answer pass), `{ list }` or `{ org, exclude, path }`. Any other shape stops
// every command until it is fixed, as the other repo lists do.
export function validateCompanyRepos(raw) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    if (!raw.length) return null;
    const seen = new Set();
    const list = raw.map((r, i) => {
      if (!isObject(r)) fail(`companyRepos[${i}] must be { repo, url, base, path }`);
      const unknown = Object.keys(r).filter((k) => !LIST_KEYS.includes(k));
      if (unknown.length) fail(`companyRepos[${i}].${unknown[0]} is not a setting (${LIST_KEYS.join(', ')})`);
      if (!plainName(r.repo)) fail(`companyRepos[${i}].repo must be the repo's plain name`);
      if (seen.has(r.repo)) fail(`companyRepos names '${r.repo}' twice`);
      seen.add(r.repo);
      if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) fail(`companyRepos[${i}].url is required: the repo's https address, which the runner clones it from`);
      if (r.base !== undefined && (typeof r.base !== 'string' || !r.base.trim())) fail(`companyRepos[${i}].base must be a branch name`);
      if (r.path !== undefined && r.path !== null && !relPath(r.path)) fail(`companyRepos[${i}].path must be the owner's clone, from the host root`);
      return { repo: r.repo, url: r.url.replace(/\/+$/, ''), base: r.base ?? 'main', path: r.path ?? null };
    });
    return { list };
  }
  if (!isObject(raw)) fail('companyRepos must be a list of { repo, url, base, path }, or { "org", "exclude", "path" }');
  const unknown = Object.keys(raw).filter((k) => !ORG_KEYS.includes(k));
  if (unknown.length) fail(`companyRepos.${unknown[0]} is not a setting (${ORG_KEYS.join(', ')})`);
  if (!plainName(raw.org)) fail('companyRepos.org must be the forge org\'s plain name');
  if (raw.exclude !== undefined && (!Array.isArray(raw.exclude) || raw.exclude.some((x) => !plainName(x)))) fail('companyRepos.exclude must be a list of repo names');
  if (raw.path !== undefined && raw.path !== null && !(relPath(raw.path) && raw.path.includes('<repo>'))) fail('companyRepos.path must be a path from the host root with <repo> in it, such as "../<repo>"');
  return { org: raw.org, exclude: [...new Set(raw.exclude ?? [])], path: raw.path ?? null };
}

// Whether the host reads its company repos at all: unset, there is no answer pass and the flow is as before.
export const companyReposOn = (settings) => Boolean(settings?.companyRepos);

// How long one `gh repo list` may take before it is a note.
export const GH_TIMEOUT_MS = 60 * 1000;

// The `gh repo list` of an org, as JSON: [{ name, url, isArchived, defaultBranchRef: { name } }]. The binary and the
// environment are injectable, so a test passes a fake `gh`.
export function ghRepoList(org, { gh = 'gh', env = process.env, timeoutMs = GH_TIMEOUT_MS } = {}) {
  const out = execFileSync(gh, ['repo', 'list', org, '--limit', '1000', '--json', 'name,url,isArchived,defaultBranchRef'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 16 << 20,
    env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  const list = JSON.parse(out);
  if (!Array.isArray(list)) throw new Error('gh repo list gave no list');
  return list;
}

const ghError = (e, timeoutMs) => (e?.code === 'ETIMEDOUT' || (e?.signal === 'SIGTERM' && e?.status === null) ? `timed out after ${Math.round(timeoutMs / 1000)} s` : String(e?.stderr || e?.message || e).trim().split('\n').at(-1).slice(0, 200));

// The company repos as this run reads them: `{ repos: [{ repo, url, base, path }], from, notes }`. The org form calls
// `gh` once (`io.ghRepoList` or the binary `io.gh`); a failure is a note and no repo, never a throw, so the pass still
// runs on the repos the other lists name.
export function resolveCompanyRepos(settings, io = {}) {
  const c = settings.companyRepos;
  if (!c) return { repos: [], from: null, notes: [] };
  if (c.list) return { repos: c.list.map((r) => ({ ...r })), from: 'list', notes: [] };
  const timeoutMs = io.ghTimeoutMs ?? GH_TIMEOUT_MS;
  let raw;
  try {
    raw = (io.ghRepoList ?? ghRepoList)(c.org, { gh: io.gh ?? 'gh', env: io.ghEnv ?? process.env, timeoutMs });
  } catch (e) {
    return { repos: [], from: `org ${c.org}`, notes: [`the repos of ${c.org} were not listed (\`gh repo list\`: ${ghError(e, timeoutMs)}): only the repos the settings name are read`] };
  }
  const skipped = { archived: [], excluded: [] };
  const repos = [];
  for (const r of raw) {
    if (!plainName(r?.name) || typeof r?.url !== 'string' || !/^https:\/\//.test(r.url)) continue;
    if (r.isArchived) {
      skipped.archived.push(r.name);
      continue;
    }
    if (c.exclude.includes(r.name)) {
      skipped.excluded.push(r.name);
      continue;
    }
    repos.push({ repo: r.name, url: r.url.replace(/\/+$/, ''), base: r.defaultBranchRef?.name || 'main', path: c.path ? c.path.split('<repo>').join(r.name) : null });
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  const notes = [];
  if (skipped.archived.length) notes.push(`archived, not read: ${skipped.archived.sort().join(', ')}`);
  return { repos, from: `org ${c.org}`, notes, excluded: skipped.excluded.sort() };
}

// The repos the answer pass checks out: the code repos, the related repos, then every company repo not among them, each
// once by name (a name in two lists shares the runner's clone; the code repos' entry wins). Left out: the hub itself
// (its pages are read through the docs lookup and its own git) and the repos whose worktrees the step has (their pages
// are read there). A company repo of its own is cloned partial, as a related repo is (`related`).
export function passRepos(settings, company, { skip = [] } = {}) {
  const out = [];
  const seen = new Set(skip);
  const add = (a, extra) => {
    if (seen.has(a.repo)) return;
    seen.add(a.repo);
    out.push({ ...a, ...extra });
  };
  for (const a of settings.appRepos ?? []) add(a, {});
  for (const a of settings.relatedRepos ?? []) add(a, { related: true });
  for (const a of company ?? []) add(a, { related: true, company: true });
  return out;
}
