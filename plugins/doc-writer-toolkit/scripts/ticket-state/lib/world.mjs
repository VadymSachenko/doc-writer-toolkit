import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCredentials } from '../../tracker/lib/settings.mjs';
import { createTracker } from '../../tracker/lib/tracker.mjs';
import { createAdapter as createTrackerAdapter } from '../../tracker/adapters/index.mjs';
import { createForge } from '../../forge/lib/forge.mjs';
import { createAdapter as createForgeAdapter } from '../../forge/adapters/index.mjs';
import { spawnGh } from '../../forge/adapters/github/gh.mjs';
import { FLOW_STATUSES } from './settings.mjs';
import { expertsOf } from './experts.mjs';
import { prId } from './ledger.mjs';
import { isIdOnlyChange } from '../../doc-align/lib/idonly.mjs';

// What the ticket flow reads: the tracker and the forge through their modules (this script composes no tracker or
// forge request itself), and git in the target repos the settings name: reads, and one fetch of an open PR's branch into
// its remote-tracking ref when the forge's head isn't there yet (`fetchHeads`). Every request the modules send is traced
// (method and path, never a query string or a credential), so a run can show it sent nothing but reads.

export function makeClients({ settings, env = process.env, io = {}, dryRun = false }) {
  const trace = { tracker: [], forge: [] };
  let tracker = null;
  let forge = null;
  let trackerClient = null;
  let forgeClient = null;

  const tracedFetch = (fetchImpl) => async (url, init = {}) => {
    trace.tracker.push({ method: init.method ?? 'GET', path: new URL(url).pathname });
    return fetchImpl(url, init);
  };
  const tracedGh = (runner) => async (args, opts = {}) => {
    const write = args.includes('-X');
    let entry;
    if (args[1] === 'graphql') {
      const doc = (() => {
        try {
          return JSON.parse(opts.input ?? '{}').query ?? '';
        } catch {
          return '';
        }
      })();
      const m = /\b(query|mutation)\s+(\w+)/.exec(doc);
      entry = { method: 'GRAPHQL', op: m ? m[1] : 'query', name: m ? m[2] : null };
    } else {
      entry = { method: write ? args[args.indexOf('-X') + 1] : 'GET', path: (args.find((a) => /^\/?repos\//.test(a)) ?? args.at(-1) ?? '').split('?')[0] };
    }
    trace.forge.push(entry);
    return runner(args, opts);
  };

  return {
    trace,
    get tracker() {
      if (!tracker) {
        if (io.trackerAdapter) tracker = createTracker({ adapter: io.trackerAdapter, tracker: settings.tracker, dryRun });
        else {
          const { key, token } = loadCredentials({ root: settings.root, credentials: settings.tracker.credentials, env });
          const made = createTrackerAdapter(settings.tracker.kind, {
            key,
            token,
            dryRun,
            fetchImpl: tracedFetch(io.fetchImpl ?? globalThis.fetch),
            ...(io.trackerOrigin ? { origin: io.trackerOrigin } : {}),
            ...(io.sleep ? { sleep: io.sleep } : {}),
          });
          trackerClient = made.client;
          tracker = createTracker({ adapter: made.adapter, tracker: settings.tracker, dryRun });
        }
      }
      return tracker;
    },
    get forge() {
      if (!forge) {
        if (io.forgeAdapter) forge = createForge({ adapter: io.forgeAdapter, forge: settings.forge, dryRun });
        else {
          const made = createForgeAdapter(settings.forge, { dryRun, env, runner: tracedGh(io.ghRunner ?? spawnGh), ...(io.sleep ? { sleep: io.sleep } : {}) });
          forgeClient = made.client;
          forge = createForge({ adapter: made.adapter, forge: settings.forge, dryRun });
        }
      }
      return forge;
    },
    // The changes a dry run caught before they were sent (the modules' own dry-run record).
    caught() {
      return { tracker: trackerClient?.calls ?? [], forge: forgeClient?.calls ?? [] };
    },
    requests() {
      const sum = (list) => {
        const by = {};
        for (const r of list) {
          const k = r.method === 'GRAPHQL' ? `GRAPHQL ${r.op}` : r.method;
          by[k] = (by[k] ?? 0) + 1;
        }
        return by;
      };
      const writes = [
        ...trace.tracker.filter((r) => r.method !== 'GET').map((r) => ({ to: 'tracker', ...r })),
        ...trace.forge.filter((r) => !(r.method === 'GET' || (r.method === 'GRAPHQL' && r.op === 'query'))).map((r) => ({ to: 'forge', ...r })),
      ];
      return { tracker: sum(trace.tracker), forge: sum(trace.forge), writes };
    },
  };
}

// ------------------------------------------------------------------ git: reads, and the fetch of a missing head

const gitOut = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

// The fetch of `fetchHeads`: it never waits for a password (one that needs it fails) and gives up after 30 seconds.
const gitFetch = (cwd, refspecs) => {
  try {
    execFileSync('git', ['-C', cwd, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', 'origin', ...refspecs], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return true;
  } catch {
    return false;
  }
};

// A `-z` list of paths (`diff --name-only`, `ls-tree --name-only`): never quoted, so a non-ASCII name is read as it is.
const zList = (out) => (out ?? '').split('\0').filter(Boolean);

export const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

export function makeGit(settings, opts = {}) {
  const repoPath = (target) => (target?.path ? path.resolve(settings.root, target.path) : null);
  const hasCommit = (cwd, sha) => Boolean(sha) && gitOut(cwd, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
  const baseRef = (cwd, base) => {
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) if (gitOut(cwd, ['rev-parse', '--verify', '-q', ref]) !== null) return ref;
    return null;
  };
  const pages = new Map();
  // The fetches tried: one reader per check, or one set shared by every status of a run (`opts.asked`).
  const asked = opts.asked ?? new Set();
  // The files of a change between two heads of a PR that are the PR's own: a file the PR's diff against its base held at
  // `from` or holds at `to` (each against its merge-base with `origin/<base>`). A file that changed only because the base
  // was merged into the branch (the forge's "Update branch": other PRs' pages from the base) is not the PR's change. With
  // no `origin/<base>` here (never the owner's local base, which may be anywhere), or a head already on it, every file
  // counts.
  const ownOnly = (cwd, from, to, base, files) => {
    const ref = base && gitOut(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]) !== null ? `refs/remotes/origin/${base}` : null;
    const mbFrom = ref && gitOut(cwd, ['merge-base', from, ref])?.trim();
    const mbTo = ref && gitOut(cwd, ['merge-base', to, ref])?.trim();
    if (!mbFrom || !mbTo || mbFrom === from || mbTo === to) return files;
    const blob = (c, f) => gitOut(cwd, ['rev-parse', '-q', '--verify', `${c}:${f}`])?.trim() ?? null;
    return files.filter((f) => blob(from, f) !== blob(mbFrom, f) || blob(to, f) !== blob(mbTo, f));
  };
  return {
    repoPath,
    // The forge's heads of the open PRs, brought into the target clones: per clone, one fetch of the branches whose head
    // it doesn't have, with their base, into the remote-tracking refs only (`+refs/heads/<b>:refs/remotes/origin/<b>`,
    // the worktree's own fetch, lib/worktree.mjs). Never a local branch, the checkout or its files. So a commit made on
    // the forge (a suggestion accepted in the PR, an upload, an edit in the browser) is read like one pushed from the
    // clone. At most once per clone and branch for this reader's `asked` set (a check, or a whole run). A fetch that fails leaves the clone as it was,
    // and the rule notes the head as not fetched. `wanted`: [{ target, branch, base, head }]; returns [{ clone, refs, fetched }].
    fetchHeads(wanted) {
      const byClone = new Map();
      for (const w of wanted ?? []) {
        const cwd = repoPath(w.target);
        const key = `${cwd}\0${w.branch}`;
        if (!cwd || !w.branch || !w.head || asked.has(key) || !fs.existsSync(cwd) || hasCommit(cwd, w.head)) continue;
        asked.add(key);
        const refs = byClone.get(cwd) ?? new Set();
        for (const b of [w.base, w.branch]) if (b) refs.add(`+refs/heads/${b}:refs/remotes/origin/${b}`);
        byClone.set(cwd, refs);
      }
      return [...byClone].map(([cwd, refs]) => ({ clone: cwd, refs: [...refs], fetched: gitFetch(cwd, [...refs]) }));
    },
    // The commits on the PR's branch that are not on its base, newest first. Null when the head or the base isn't here.
    branchCommits(target, head, base) {
      const cwd = repoPath(target);
      if (!cwd || !hasCommit(cwd, head)) return null;
      const ref = baseRef(cwd, base);
      if (!ref) return null;
      const out = gitOut(cwd, ['rev-list', head, '--not', ref]);
      return out === null ? null : out.split('\n').filter(Boolean);
    },
    // When a commit was written and when it was committed (ms), for the style check's cutoff and its wait. Null when it
    // isn't here; a date git can't give is null.
    commitDates(target, sha) {
      const cwd = repoPath(target);
      if (!cwd || !hasCommit(cwd, sha)) return null;
      const [author, committer] = (gitOut(cwd, ['show', '-s', '--format=%aI%n%cI', sha]) ?? '').trim().split('\n').map((x) => Date.parse(x));
      return { author: Number.isNaN(author) ? null : author, committer: Number.isNaN(committer) ? null : committer };
    },
    // The commits after `from` up to `to`, newest first. Null when either commit isn't here.
    commitsBetween(target, from, to) {
      const cwd = repoPath(target);
      if (!cwd || !hasCommit(cwd, from) || !hasCommit(cwd, to)) return null;
      const out = gitOut(cwd, ['rev-list', to, '--not', from]);
      return out === null ? null : out.split('\n').filter(Boolean);
    },
    // The files under the roots that changed between two commits, leaving out an id-only change (D-073, ../../doc-align/lib/idonly.mjs):
    // such a change keeps every stage recorded on the page. With `base`, only the PR's own pages (`ownOnly`): a merge of
    // the base brings no page of another PR into the count. Null when either commit isn't here.
    changedUnder(target, from, to, roots, base = null) {
      const cwd = repoPath(target);
      if (!cwd || !hasCommit(cwd, from) || !hasCommit(cwd, to)) return null;
      if (from === to) return [];
      // `-z`: a non-ASCII page name is never quoted, so never missed.
      const out = gitOut(cwd, ['diff', '-z', '--name-only', '--no-renames', from, to, '--', ...roots]);
      if (out === null) return null;
      const changeSet = zList(out).map((f) => ({ path: f, before: gitOut(cwd, ['show', `${from}:${f}`]), after: gitOut(cwd, ['show', `${to}:${f}`]) }));
      return ownOnly(cwd, from, to, base, changeSet.filter((page) => !isIdOnlyChange(page, changeSet)).map((page) => page.path));
    },
    // The images (anywhere in the repo but a `.sources/` folder) that changed between two commits, for the visual pack
    // after a hand commit; with `base`, the PR's own only. Null when either commit isn't here.
    imagesChanged(target, from, to, base = null) {
      const cwd = repoPath(target);
      if (!cwd || !hasCommit(cwd, from) || !hasCommit(cwd, to)) return null;
      if (from === to) return [];
      // `-z`: a non-ASCII image name is never quoted, so never missed.
      const out = gitOut(cwd, ['diff', '-z', '--name-only', '--no-renames', from, to]);
      if (out === null) return null;
      return ownOnly(cwd, from, to, base, zList(out).filter((f) => IMAGE.test(f) && !f.split('/').includes('.sources')));
    },
    // The UA page paths of a target at its base (relative to the UA root, without the extension), for the text check.
    pagesOf(target) {
      if (pages.has(target.id)) return pages.get(target.id);
      const cwd = repoPath(target);
      let list = [];
      if (cwd && fs.existsSync(cwd)) {
        const ref = baseRef(cwd, target.base) ?? 'HEAD';
        const out = gitOut(cwd, ['ls-tree', '-r', '-z', '--name-only', ref, '--', target.uaRoot]);
        list = zList(out)
          .filter((f) => /\.mdx?$/.test(f) && !f.split('/').some((p) => p.startsWith('.')))
          .map((f) => f.slice(target.uaRoot.length).replace(/\.mdx?$/, ''));
      }
      pages.set(target.id, list);
      return list;
    },
  };
}

// ------------------------------------------------------------------ the snapshot

// The cards of every flow status the module may read (never a neverRead one, and not the done lists, which only grow),
// plus each open ledger's card wherever it is now (archived too). `cards` maps a card id to the card, or to null when
// the tracker no longer has it.
export async function readCards({ settings, tracker, ledgers }) {
  const { statuses, neverRead } = settings.tracker;
  const listed = FLOW_STATUSES.filter((s) => s in statuses && !neverRead.includes(s) && s !== 'done' && s !== 'outOfScope');
  const cards = new Map();
  const byStatus = {};
  for (const status of listed) {
    const r = await tracker.listCards({ status });
    byStatus[status] = r.cards;
    for (const c of r.cards) cards.set(c.id, c);
  }
  for (const l of ledgers) {
    if (!l.card?.id || cards.has(l.card.id) || l.stages?.close?.status === 'done') continue;
    const found = await tracker.findCards({ link: l.card.shortLink ?? l.card.id });
    cards.set(l.card.id, found.cards[0] ?? null);
  }
  return { cards, byStatus, listed };
}

// The forge's view of each open PR of the ledgers: its state, head, review requests and decision, labels, and the
// comments and reviews no record has handled yet.
export async function readPrs({ settings, forge, ledgers }) {
  const out = new Map();
  for (const l of ledgers) {
    if (l.stages?.close?.status === 'done') continue;
    for (const pr of l.prs ?? []) {
      if (!pr.number || pr.merged) continue;
      const st = await forge.prState({ repo: pr.repo, number: pr.number });
      const entry = { state: st.state, url: st.url ?? null, headCommit: st.headCommit, reviewRequests: st.reviewRequests ?? [], reviewDecision: st.reviewDecision ?? null, labels: st.labels ?? [], mergeCommit: st.mergeCommit ?? null, mergedAt: st.mergedAt ?? null, newComments: [] };
      if (st.state === 'open') {
        const activity = await forge.prActivity({ repo: pr.repo, number: pr.number });
        entry.newComments = unhandled(l, pr, activity, settings.forge.self);
        Object.assign(entry, reviewerSignals(activity, settings.forge.self, [...expertsOf(settings, pr).reviewers, ...(pr.reviewersRequested ?? [])]));
      }
      out.set(`${l.key}/${prId(pr)}`, entry);
    }
  }
  return out;
}

// Comments and reviews on a PR that the pipeline didn't post and no record handled (an edit after the handling counts
// as new). Each says whether the owner wrote it (an instruction) or a reviewer did. A bot's (a preview notice, a CI
// summary) asks nothing of the pipeline and starts no session. A line comment of a review the pipeline posted (its id
// in `posted`, as `review-on-lines` gives it) is the pipeline's too, whether or not its own id was recorded: the
// pipeline posts from the owner's login, so it would read as the owner's. A submitted review takes no new comment: a
// person's reply opens a review of their own. Each carries its text (`body`): the rule reads the owner's reply by number
// and suggestion blocks in it (lib/edits.mjs).
export function unhandled(ledger, pr, activity, self) {
  const posted = new Set((ledger.posted?.pr ?? []).map(String));
  const ownReview = (c) => c.reviewId !== null && c.reviewId !== undefined && posted.has(String(c.reviewId));
  const handled = new Map((ledger.reviewComments ?? []).filter((c) => c.repo === pr.repo && Number(c.pr) === Number(pr.number)).map((c) => [String(c.id), c.updatedAt ?? c.at ?? '']));
  const isBot = (c) => c.authorBot === true || /\[bot\]$/.test(c.author ?? '');
  const fresh = (c) => !isBot(c) && !posted.has(String(c.id)) && !(handled.has(String(c.id)) && (handled.get(String(c.id)) ?? '') >= (c.updatedAt ?? c.submittedAt ?? ''));
  const who = (author) => (self && author === self ? 'owner' : 'reviewer');
  const out = [];
  for (const t of activity.threads ?? []) {
    for (const c of t.comments ?? []) if (fresh(c) && !ownReview(c)) out.push({ id: c.id, kind: 'review-comment', thread: t.id, author: c.author, by: who(c.author), path: c.path ?? t.path ?? null, line: c.line ?? t.line ?? null, updatedAt: c.updatedAt, body: c.body ?? '' });
  }
  for (const c of activity.comments ?? []) if (fresh(c)) out.push({ id: c.id, kind: 'comment', author: c.author, by: who(c.author), updatedAt: c.updatedAt, body: c.body ?? '' });
  for (const r of activity.reviews ?? []) {
    if (!String(r.body ?? '').trim()) continue; // a verdict with no text asks nothing
    const c = { id: r.id, author: r.author, authorBot: r.authorBot, updatedAt: r.submittedAt };
    if (fresh(c)) out.push({ id: r.id, kind: 'review', state: r.state, author: r.author, by: who(r.author), updatedAt: r.submittedAt, body: r.body ?? '' });
  }
  return out;
}

// What the PR's experts did on it: only the logins in `experts` (the targets' `reviewers` and the reviewers requested on
// the PR), compared without case as GitHub does, never the pipeline's own login or a bot. `reviewerAt`, the time of their
// latest review or comment, for the report's quiet expert; and `approvals`, each expert's approving review whose last
// verdict it is, oldest first, with the commit it approved. When any expert's last verdict asks for changes, whatever its
// time, there are none: that expert holds the PR. The rule keeps the approvals given after the PR entered the review.
// Read from the reviews themselves: GitHub fills the PR's review decision only where a branch rule requires a review.
export function reviewerSignals(activity, self, experts = []) {
  const low = (x) => String(x ?? '').toLowerCase();
  const allowed = new Set(experts.map(low));
  const theirs = (author, bot) => Boolean(author) && low(author) !== low(self) && bot !== true && !/\[bot\]$/.test(author) && allowed.has(low(author));
  const times = [];
  for (const t of activity.threads ?? []) for (const c of t.comments ?? []) if (theirs(c.author, c.authorBot)) times.push(c.createdAt ?? c.updatedAt);
  for (const c of activity.comments ?? []) if (theirs(c.author, c.authorBot)) times.push(c.createdAt ?? c.updatedAt);
  const reviews = (activity.reviews ?? []).filter((r) => theirs(r.author, r.authorBot) && r.submittedAt);
  for (const r of reviews) times.push(r.submittedAt);
  const last = new Map();
  for (const r of [...reviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) last.set(low(r.author), r);
  const verdicts = [...last.values()];
  const approvals = verdicts.some((r) => r.state === 'CHANGES_REQUESTED') ? [] : verdicts.filter((r) => r.state === 'APPROVED').sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const valid = times.filter((x) => x && !Number.isNaN(Date.parse(x)));
  return {
    reviewerAt: valid.length ? new Date(Math.max(...valid.map((x) => Date.parse(x)))).toISOString() : null,
    approvals: approvals.map((r) => ({ id: r.id, login: r.author, commit: r.commit ?? null, at: r.submittedAt })),
  };
}

// The PRs a card's comments link to, in the repos the targets name (for a ticket whose ledger is missing).
export function prLinks(text, settings) {
  const out = [];
  const seen = new Set();
  const owner = settings.forge.owner.toLowerCase();
  for (const m of String(text ?? '').matchAll(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi)) {
    if (m[1].toLowerCase() !== owner) continue;
    const repo = settings.forge.repos.find((r) => r.toLowerCase() === m[2].toLowerCase());
    if (!repo) continue;
    const id = `${repo}#${m[3]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ repo, number: Number(m[3]) });
  }
  return out;
}
