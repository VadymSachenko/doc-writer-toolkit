import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCredentials } from '../../tracker/lib/settings.mjs';
import { createTracker } from '../../tracker/lib/tracker.mjs';
import { createAdapter as createTrackerAdapter } from '../../tracker/adapters/index.mjs';
import { createForge } from '../../forge/lib/forge.mjs';
import { createAdapter as createForgeAdapter } from '../../forge/adapters/index.mjs';
import { spawnGh } from '../../forge/adapters/github/gh.mjs';
import { withoutHeader } from '../../tracker/lib/comment-header.mjs';
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

// The change to one file from a merge-base to a head (the PR's own, plus whatever the PR merged in from that base on),
// as `git patch-id --stable` reads its diff with no context lines: the same id for the same change wherever its lines
// stand. `patch-id` ignores whitespace, so two changes that differ in whitespace only get the same id. '' when the file
// didn't change, null when git can't tell (then the file counts).
const ownPatch = (cwd, from, to, file) => {
  const diff = gitOut(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', from, to, '--', file]);
  if (diff === null) return null;
  if (!diff.trim()) return '';
  try {
    return execFileSync('git', ['-C', cwd, 'patch-id', '--stable'], { input: diff, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\s/)[0] || null;
  } catch {
    return null;
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
  //
  // With `forge.keepFresh`, a file the PR and the base both changed counts only when the PR's own change to it differs
  // between the two heads: its diff against the merge-base, with no context lines, compared by `git patch-id`, which
  // reads no line number. So a block the base changed in a page of the PR's, merged in cleanly, is the base's change, not
  // the PR's; a block the PR changed, by hand or by a conflict's resolution, still counts, unless the edit changed
  // whitespace only (`patch-id` ignores whitespace, so such an edit doesn't count in such a page).
  const ownOnly = (cwd, from, to, base, files) => {
    const ref = base && gitOut(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]) !== null ? `refs/remotes/origin/${base}` : null;
    const mbFrom = ref && gitOut(cwd, ['merge-base', from, ref])?.trim();
    const mbTo = ref && gitOut(cwd, ['merge-base', to, ref])?.trim();
    if (!mbFrom || !mbTo || mbFrom === from || mbTo === to) return files;
    const blob = (c, f) => gitOut(cwd, ['rev-parse', '-q', '--verify', `${c}:${f}`])?.trim() ?? null;
    const theirs = files.filter((f) => blob(from, f) !== blob(mbFrom, f) || blob(to, f) !== blob(mbTo, f));
    if (!settings.keepFresh || mbFrom === mbTo) return theirs;
    return theirs.filter((f) => ownPatch(cwd, mbFrom, from, f) !== ownPatch(cwd, mbTo, to, f));
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
        // `baseHead`, the base's tip the forge gives (`forge.keepFresh`): fetched too when the clone hasn't got it.
        if (!cwd || !w.branch || !w.head || asked.has(key) || !fs.existsSync(cwd) || (hasCommit(cwd, w.head) && (!w.baseHead || hasCommit(cwd, w.baseHead)))) continue;
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
    // How many commits of the base the head doesn't have (`forge.keepFresh`): of `tip`, the base's tip the forge gives,
    // when the clone has it, else of `origin/<base>`. Null when the head or the base isn't here.
    behind(target, head, base, tip = null) {
      const cwd = repoPath(target);
      if (!cwd || !hasCommit(cwd, head)) return null;
      const ref = tip && hasCommit(cwd, tip) ? tip : gitOut(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]) !== null ? `refs/remotes/origin/${base}` : null;
      if (!ref) return null;
      const out = gitOut(cwd, ['rev-list', '--count', ref, '--not', head]);
      return out === null ? null : Number(out.trim());
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
      // The paths the PR changes, as far as the forge gave them: the pages the ticket holds (lib/limits.mjs `workPages`).
      if (Array.isArray(st.files)) Object.assign(entry, { files: st.files, ...(st.filesTruncated ? { filesTruncated: true } : {}) });
      // The base's tip and the head's CI, for keeping the branch up to date with its base (`forge.keepFresh`).
      if (settings.keepFresh) Object.assign(entry, { baseCommit: st.baseCommit ?? null, checks: st.checks ?? null, updatedAt: st.updatedAt ?? null });
      if (st.state === 'open') {
        const activity = await forge.prActivity({ repo: pr.repo, number: pr.number });
        const experts = [...expertsOf(settings, pr).reviewers, ...(pr.reviewersRequested ?? [])];
        const sorted = sortComments(l, pr, activity, settings.forge.self, settings.commentHeader, { words: settings.triggerWords, experts });
        entry.newComments = sorted.items;
        entry.others = sorted.others;
        Object.assign(entry, reviewerSignals(activity, settings.forge.self, experts));
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
// and suggestion blocks in it (lib/edits.mjs). With the settings' comment header, a comment that starts with it is the
// pipeline's too, recorded or not: a summary whose id a session failed to record is never read as the owner's reply.
// A line comment carries its thread's first comment (`root`): a reply in a thread the pipeline opened is read against
// that thread's item (lib/edits.mjs).
//
// With the trigger words (`forge.triggerWords`, `opts.words`), who wrote it decides more (D-142, decision 3):
//   - the owner's comment is for the pipeline only when it starts with a word and a colon (`word:`, any case, a space
//     before the colon and leading space allowed), in the pipeline's own threads too; the word is cut off the text the
//     rule reads. A submitted review whose text starts with it covers its line comments. Without it the owner's
//     comment is a note for people and starts nothing;
//   - the PR's experts (`opts.experts`: the targets' `reviewers` and the reviewers requested on it) are reviewers as
//     before, with no word, in their own comments and reviews and in the threads an expert opened;
//   - a reply in anyone else's thread, the pipeline's or the owner's (an expert the owner tagged there too), and anyone
//     else's comment, start nothing: they are in `others`, for the owner to hand on with the word. One goes off the list
//     only when it was handed on: its id recorded in `handled` (a session took it with the owner's worded comment that
//     pointed at it). A later worded comment, in its thread or elsewhere, hands nothing on by itself: a forge thread is
//     flat, so a reply after a comment needn't be about it.
//   A comment in a thread carries the thread's earlier comments (`context`): the owner's worded reply under an
//   expert's answer may only point at it ("do as the expert says"). An expert opened a thread when its first comment
//   is the expert's own and no reply (a thread whose first comment was deleted starts with a reply).
// With no words set, every comment that isn't the owner's is a reviewer's, as before.
export function unhandled(ledger, pr, activity, self, header = null, opts = {}) {
  return sortComments(ledger, pr, activity, self, header, opts).items;
}

// The trigger word at the start of a text: the text without it, or null when it doesn't start with one. A reply made
// with the forge's "Quote reply" starts with the quoted lines (`> …`): the word is read on the first line after them,
// and the quote is kept in front of the rest (the reply by number leaves quoted lines out).
export function afterTrigger(body, words) {
  const list = (words ?? []).map((w) => String(w).trim()).filter(Boolean);
  if (!list.length) return null;
  const text = String(body ?? '');
  const lead = /^(?:[ \t]*(?:>[^\n]*)?\r?\n)*/.exec(text)[0];
  const esc = list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const m = new RegExp(`^\\s*(?:${esc})\\s*:\\s*`, 'iu').exec(text.slice(lead.length));
  return m ? `${lead}${text.slice(lead.length + m[0].length)}` : null;
}

export function sortComments(ledger, pr, activity, self, header = null, { words = [], experts = [] } = {}) {
  const posted = new Set((ledger.posted?.pr ?? []).map(String));
  const headed = (c) => Boolean(header) && withoutHeader(c.body, header) !== String(c.body ?? '');
  const ownReview = (c) => c.reviewId !== null && c.reviewId !== undefined && posted.has(String(c.reviewId));
  const handled = new Map((ledger.reviewComments ?? []).filter((c) => c.repo === pr.repo && Number(c.pr) === Number(pr.number)).map((c) => [String(c.id), c.updatedAt ?? c.at ?? '']));
  const isBot = (c) => c.authorBot === true || /\[bot\]$/.test(c.author ?? '');
  const fresh = (c) => !isBot(c) && !posted.has(String(c.id)) && !headed(c) && !(handled.has(String(c.id)) && (handled.get(String(c.id)) ?? '') >= (c.updatedAt ?? c.submittedAt ?? ''));
  const gated = (words ?? []).some((w) => String(w).trim());
  const low = (x) => String(x ?? '').toLowerCase();
  const expert = new Set((experts ?? []).map(low));
  const isOwner = (author) => Boolean(self) && low(author) === low(self); // logins are case-blind on the forge
  const who = (author) => (isOwner(author) ? 'owner' : 'reviewer');
  // The owner's reviews whose text starts with the word: their line comments are for the pipeline too.
  const wordedReviews = new Set((activity.reviews ?? []).filter((r) => isOwner(r.author) && afterTrigger(r.body, words) !== null).map((r) => String(r.id)));
  const worded = (c) => isOwner(c.author) && (afterTrigger(c.body, words) !== null || (c.reviewId !== null && c.reviewId !== undefined && wordedReviews.has(String(c.reviewId))));
  // A thread the pipeline opened (its first comment in `posted`, with the header, or of a review it posted).
  const ours = (c) => Boolean(c) && (posted.has(String(c.id)) || headed(c) || ownReview(c));
  const items = [];
  const others = [];
  // Where a fresh comment goes: the items (with the text the rule reads), the others, or nowhere (the owner's note).
  // `thread`: the thread it is in, and whether an expert opened it.
  const place = (c, item, thread = null) => {
    if (!gated) return items.push(item);
    if (isOwner(c.author)) {
      const rest = afterTrigger(c.body, words);
      if (rest !== null) return items.push({ ...item, body: rest, worded: true });
      if (worded(c)) return items.push({ ...item, worded: true });
      return null;
    }
    // An expert's own comment needs no word, and neither does a reply in a thread an expert opened; a reply in anyone
    // else's thread, the pipeline's or the owner's, is for people (decision 3: the owner may tag the expert there, and
    // hands an answer on with the word).
    if (c.author && expert.has(low(c.author)) && (!thread || thread.byExpert)) return items.push(item);
    const { body, context, ...seen } = item;
    return others.push(seen);
  };
  // The thread's comments before one, for the session to read the owner's reply against: its first one and the last 7
  // before it, each `{ by: 'pipeline' | 'owner' | 'other', author, text }` (the owner's with the word cut off).
  const contextOf = (t, i) => {
    const list = t.comments ?? [];
    const picked = i <= 8 ? list.slice(0, i) : [list[0], ...list.slice(i - 7, i)];
    return picked.map((x) => {
      const by = ours(x) ? 'pipeline' : isOwner(x.author) ? 'owner' : 'other';
      const body = by === 'pipeline' && header ? withoutHeader(x.body, header) : by === 'owner' ? afterTrigger(x.body, words) ?? x.body : x.body;
      return { by, author: x.author ?? null, text: oneText(body) };
    });
  };
  for (const t of activity.threads ?? []) {
    const first = t.comments?.[0];
    const root = first?.id ?? null;
    const thread = { byExpert: Boolean(first?.author) && !ours(first) && !isOwner(first.author) && (first.inReplyTo === null || first.inReplyTo === undefined) && expert.has(low(first.author)) };
    (t.comments ?? []).forEach((c, i) => {
      if (!fresh(c) || ownReview(c)) return;
      const item = { id: c.id, kind: 'review-comment', thread: t.id, root, author: c.author, by: who(c.author), path: c.path ?? t.path ?? null, line: c.line ?? t.line ?? null, updatedAt: c.updatedAt, body: c.body ?? '' };
      place(c, gated && i > 0 ? { ...item, context: contextOf(t, i) } : item, thread);
    });
  }
  for (const c of activity.comments ?? []) if (fresh(c)) place(c, { id: c.id, kind: 'comment', author: c.author, by: who(c.author), updatedAt: c.updatedAt, body: c.body ?? '' });
  for (const r of activity.reviews ?? []) {
    if (!String(r.body ?? '').trim()) continue; // a verdict with no text asks nothing
    const c = { id: r.id, author: r.author, authorBot: r.authorBot, updatedAt: r.submittedAt, body: r.body };
    if (fresh(c)) place(c, { id: r.id, kind: 'review', state: r.state, author: r.author, by: who(r.author), updatedAt: r.submittedAt, body: r.body ?? '' });
  }
  return { items, others };
}

// One comment's text for a brief: trimmed, on one line, cut at 400 characters.
function oneText(body) {
  const t = String(body ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 400 ? `${t.slice(0, 399)}…` : t;
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
