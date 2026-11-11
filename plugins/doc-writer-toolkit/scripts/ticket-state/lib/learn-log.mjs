import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeGit } from './world.mjs';
import { prId } from './ledger.mjs';

// The log of the owner's edits (TASK-054, point 1; context/ticket-flow.md, "Learning from the owner's edits"). No AI:
// after each run the collector reads every ledger's PRs and appends to `<state>/learning/edits.jsonl` what the owner
// changed, one line per block, «before» → «after», with the page, the PR and the owner's own words when there are any.
// The weekly session reads this file; nothing else does. Three sources:
//
// - `comment`: an item of `prs[].edits` the writer applied at a review comment (stage `answerComments`, no `rule`: an
//   item with a rule is the style check's own fix, the pipeline's taste, not the owner's). Its `reason` is the
//   comment's reason, kept as `comment`.
// - `restore`: a style fix the owner undid (`rejected` on the fix, TASK-085's restore): the pipeline followed a rule
//   and the owner reversed it, the direct sign of an exception to a general rule. `before` is the fix's text, `after`
//   the owner's, and `rule` the rule the fix applied.
// - `hand` and `final`: a commit on the PR's branch the pipeline didn't make (not in `pipelineCommits`, not a merge,
//   not on the base: the hand commits TASK-076 reads), at any stage, block by block over the UA pages of the PR's own
//   it changed (not an id-only change, not a page a merge of the base brought, never EN or a further locale: the owner
//   writes UA). `final` when the commit came after the PR's first `readyForMerge` head (D-062: the final edit), else
//   `hand`. The style check's `reason` for the commit, or else the commit's subject, is its `comment`. Only the owner's
//   commits (`learning.authors`, the git author), never one the ledger records as the pipeline's anywhere. A merged PR's
//   commits are those its merge commit's first parent doesn't hold.
//
// Each line has a stable `id` (a commit's lines by the commit, whatever their source), so a second run adds nothing
// twice. Which PRs: every PR still open, and every merged PR merged at or after `since` (`learning.since`, or the
// backfill's `--since`; required); a PR closed unmerged is outside the flow.
// A cursor (`learning/cursor.json`) keeps each PR's head and its count of edits as last read, so a PR with neither
// changed costs no git call; a merged PR is read once more at its final head, then never again.

export const learningDir = (state) => path.join(state, 'learning');
export const logPath = (state) => path.join(learningDir(state), 'edits.jsonl');
const cursorPath = (state) => path.join(learningDir(state), 'cursor.json');

// The longest «before» or «after» a line keeps; a longer one is cut, with `cut: true`.
export const TEXT_MAX = 1500;

export function readLog(state) {
  try {
    return fs
      .readFileSync(logPath(state), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ blocks

// A page's blocks: runs of lines between blank lines, a heading line on its own, a fenced code block whole (blank lines
// inside it included), the frontmatter whole. Each with the nearest heading above it (its own, for a heading).
export function blocksOf(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = [];
  let heading = null;
  let fence = null;
  const flush = () => {
    if (cur.length) out.push({ text: cur.join('\n'), heading });
    cur = [];
  };
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      out.push({ text: lines.slice(0, end + 1).join('\n'), heading: null, frontmatter: true });
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      cur.push(l);
      if (l.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) {
      flush();
      fence = f[1];
      cur.push(l);
      continue;
    }
    if (!l.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*(\{\/\*.*\*\/\})?\s*$/.exec(l);
    if (h) {
      flush();
      heading = h[2];
      out.push({ text: l, heading });
      continue;
    }
    cur.push(l);
  }
  flush();
  return out;
}

const same = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

// The changed runs between two pages' blocks (a longest common subsequence of the blocks' texts): [{ block, before,
// after }], `before` empty for an added block, `after` empty for a removed one. A change in whitespace only is none.
export function changedBlocks(beforeText, afterText) {
  const a = blocksOf(beforeText);
  const b = blocksOf(afterText);
  if (a.length * b.length > 4e6) return null;
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  let ra = [];
  let rb = [];
  const close = () => {
    if (!ra.length && !rb.length) return;
    const before = ra.map((x) => x.text).join('\n\n');
    const after = rb.map((x) => x.text).join('\n\n');
    if (!same(before, after)) out.push({ block: (rb[0] ?? ra[0]).heading ?? null, before, after });
    ra = [];
    rb = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i].text === b[j].text) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) rb.push(b[j++]);
    else ra.push(a[i++]);
  }
  close();
  return out;
}

const cut = (s) => (s.length > TEXT_MAX ? { text: `${s.slice(0, TEXT_MAX)}…`, cut: true } : { text: s, cut: false });

// ------------------------------------------------------------------ git

// The collector's git: the ticket flow's reader (`changedUnder`, `commitsBetween`, which leave out an id-only change and
// a page a merge of the base brought) and three reads of its own. Each returns null when git here can't tell.
export function learnGit(settings) {
  const base = makeGit(settings);
  const out = (cwd, args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const ref = (cwd, b) => {
    for (const r of [`refs/remotes/origin/${b}`, `refs/heads/${b}`]) if (out(cwd, ['rev-parse', '--verify', '-q', r]) !== null) return r;
    return null;
  };
  const has = (cwd, rev) => out(cwd, ['cat-file', '-e', `${rev}^{commit}`]) !== null;
  return {
    // The non-merge commits on the branch that are not on the base, oldest first: { sha, at, subject, email, name }.
    // An open PR: against the base as fetched. A merged PR: against its merge commit's first parent (the base as it was
    // just before the merge), since the base now holds the branch (a merge commit), and a squash or rebase merge leaves
    // the branch's own commits off the base all the same. Null when git here can't tell: no head, no merge commit fetched,
    // or a head the base already holds with no merge commit to tell where the branch began.
    commits(target, head, b, { mergeCommit = null } = {}) {
      const cwd = base.repoPath(target);
      if (!cwd || !head) return null;
      // The merge is on the base, and with it the merged head: a clone that hasn't fetched them since gets the base once
      // (the remote-tracking ref only).
      if (mergeCommit && (!has(cwd, mergeCommit) || !has(cwd, head))) out(cwd, ['-c', 'core.hooksPath=/dev/null', 'fetch', '-q', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`]);
      if (!has(cwd, head)) return null;
      let not;
      if (mergeCommit) {
        if (!has(cwd, mergeCommit)) return null;
        not = has(cwd, `${mergeCommit}^1`) ? `${mergeCommit}^1` : null;
        if (!not) return null;
      } else {
        not = ref(cwd, b);
        if (!not) return null;
        // The base holds the head: a merged branch whose merge commit isn't known. Nothing to list, and no way to tell.
        if (out(cwd, ['merge-base', '--is-ancestor', head, not]) !== null) return null;
      }
      const text = out(cwd, ['log', '--no-merges', '--reverse', '--format=%H%x09%cI%x09%ae%x09%an%x09%s', head, '--not', not]);
      if (text === null) return null;
      return text.split('\n').filter(Boolean).map((line) => {
        const [sha, at, email, name, ...subject] = line.split('\t');
        return { sha, at, email, name, subject: subject.join('\t') };
      });
    },
    pages: (target, sha, roots, b) => base.changedUnder(target, `${sha}^`, sha, roots, b)?.filter((f) => /\.mdx?$/.test(f)) ?? null,
    between: (target, from, to) => base.commitsBetween(target, from, to),
    show(target, rev, file) {
      const cwd = base.repoPath(target);
      return cwd ? out(cwd, ['show', `${rev}:${file}`]) : null;
    },
  };
}

// ------------------------------------------------------------------ the collector

const targetOf = (settings, pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo);
const uaRootsOf = (settings, pr, target) => {
  const roots = (pr.targets ?? []).map((id) => settings.targets.find((t) => t.id === id)?.uaRoot).filter(Boolean);
  return roots.length ? [...new Set(roots)] : target ? [target.uaRoot] : [];
};
// Every commit the ledger records as the pipeline's: `pipelineCommits`, and the commits its other records name (the
// rounds' commits, the id step's), so a pipeline push missing from `pipelineCommits` is never taken for the owner's.
// Not a stage's recorded head: a step that made no commit records the head it found, which may be the owner's.
const SHA = /^[0-9a-f]{7,40}$/;
export function pipelineShas(pr) {
  const out = new Set((pr.pipelineCommits ?? []).map(String));
  const add = (v) => typeof v === 'string' && SHA.test(v) && out.add(v);
  for (const r of pr.rounds ?? []) for (const c of r?.commits ?? []) add(typeof c === 'string' ? c : c?.sha);
  for (const c of pr.idCommits ?? []) add(typeof c === 'string' ? c : c?.sha ?? c?.commit);
  return [...out];
}
const mineIn = (shas, sha) => shas.some((c) => c && (sha.startsWith(String(c)) || String(c).startsWith(sha)));

// The owner's commit: its author's email or name is one of `learning.authors` (case aside).
const byOwner = (settings, c) => {
  const who = (settings.learning?.authors ?? []).map((a) => a.toLowerCase());
  return who.includes(String(c.email ?? '').toLowerCase()) || who.includes(String(c.name ?? '').toLowerCase());
};

// The comments an `answerComments` round handled (`ledger.reviewComments`, recorded with the round's `at`, as its edits
// are): the edits of that round answer them.
const roundComments = (ledger, pr, at) => (ledger.reviewComments ?? []).filter((c) => c.repo === pr.repo && Number(c.pr) === Number(pr.number) && c.at === at);
const commentEdit = (e) => e.stage === 'answerComments' && !e.rule && !e.restores;

// Whether an applied comment's edit is the owner's, by the authors the forge gives for the comments its round handled
// (never a model's word): yes when one of them is `forge.self` (or the round recorded none to check); no when all are
// someone else's; null when an author isn't known here (read again at a later pass, with the forge).
function ownerComment(settings, ledger, pr, e, authors) {
  const handled = roundComments(ledger, pr, e.at);
  if (!handled.length) return true;
  if (!authors) return null;
  const who = handled.flatMap((c) => [c.id, c.replyId].filter((x) => x !== undefined && x !== null)).map((x) => authors.get(String(x))).filter(Boolean);
  if (!who.length) return null;
  return who.includes(settings.forge?.self);
}

// Every comment author of a PR on the forge, by comment id (the reviews, the line comments, the PR's comments).
export function authorsFrom(forge) {
  return async (pr) => {
    const act = await forge.prActivity({ repo: pr.repo, number: pr.number });
    const m = new Map();
    for (const r of act.reviews ?? []) if (r?.id !== undefined) m.set(String(r.id), r.author ?? null);
    for (const t of act.threads ?? []) for (const c of t.comments ?? []) if (c?.id !== undefined) m.set(String(c.id), c.author ?? null);
    for (const c of act.comments ?? []) if (c?.id !== undefined) m.set(String(c.id), c.author ?? null);
    return m;
  };
}

// The entries one PR gives now. `view`: { head, state ('open' | 'merged' | 'closed'), mergedAt, mergeCommit }.
// `authors`: the PR's comment authors by id (`authorsFrom`), or null when the forge isn't read here.
export function entriesOf({ settings, ledger, pr, view, git, authors = null }) {
  const id = prId(pr);
  const common = { key: ledger.key, repo: pr.repo, pr: pr.number, url: pr.url ?? null };
  const out = [];
  const notes = [];
  let deferred = false;
  for (const e of pr.edits ?? []) {
    if (e.rule && e.rejected) {
      out.push({ id: `restore:${id}:${e.list}:${e.n}`, at: e.rejected.at ?? e.at ?? null, ...common, page: e.page, block: e.block ?? null, before: e.after, after: e.before, source: 'restore', rule: e.rule, n: e.n });
    } else if (commentEdit(e)) {
      const own = ownerComment(settings, ledger, pr, e, authors);
      if (own === null) deferred = true;
      if (!own) continue;
      out.push({ id: `comment:${id}:${e.list}:${e.n}`, at: e.at ?? null, ...common, page: e.page, block: e.block ?? null, before: e.before, after: e.after, source: 'comment', n: e.n, ...(e.reason ? { comment: e.reason } : {}) });
    }
  }
  const target = targetOf(settings, pr);
  if (target && view?.head) {
    const b = pr.base ?? target.base ?? 'main';
    const mergeCommit = view.state === 'merged' ? view.mergeCommit ?? pr.merged?.commit ?? null : null;
    if (view.state === 'merged' && !mergeCommit) notes.push(`${id}: merged, with no merge commit known: its hand edits are read at a later run`);
    const commits = view.state === 'merged' && !mergeCommit ? null : git.commits(target, view.head, b, { mergeCommit });
    if (commits === null && !(view.state === 'merged' && !mergeCommit)) notes.push(`${id}: git here can't list the branch's commits at ${String(view.head).slice(0, 7)}: its hand edits are read at a later run`);
    const ready = pr.readyForMerge?.[0]?.head ?? null;
    const afterReady = ready ? git.between(target, ready, view.head) : null;
    const shas = pipelineShas(pr);
    for (const c of (commits ?? []).filter((x) => !mineIn(shas, x.sha) && byOwner(settings, x))) {
      const pages = git.pages(target, c.sha, uaRootsOf(settings, pr, target), b);
      if (pages === null) {
        notes.push(`${id}: the hand commit ${c.sha.slice(0, 7)} can't be diffed here`);
        continue;
      }
      const reason = (pr.styleChecked ?? []).find((x) => x?.sha && (c.sha.startsWith(x.sha) || x.sha.startsWith(c.sha)))?.reason ?? null;
      const source = afterReady?.includes(c.sha) ? 'final' : 'hand';
      for (const page of pages) {
        const before = git.show(target, `${c.sha}^`, page);
        const after = git.show(target, c.sha, page);
        // A page the commit added or removed whole is new content or a removal, not an edit of a text.
        if (before === null || after === null) continue;
        const changes = changedBlocks(before, after);
        if (changes === null) {
          notes.push(`${id}: ${page} in ${c.sha.slice(0, 7)} is too long to compare by blocks`);
          continue;
        }
        changes.forEach((x, i) => {
          const bt = cut(x.before);
          const at = cut(x.after);
          // Keyed by the commit, not the source: a commit read as `hand` once is never logged again as `final`.
          out.push({ id: `commit:${id}:${c.sha.slice(0, 12)}:${page}:${i}`, at: c.at ?? null, ...common, page, block: x.block, before: bt.text, after: at.text, ...(bt.cut || at.cut ? { cut: true } : {}), source, sha: c.sha, comment: reason ?? c.subject ?? null });
        });
      }
    }
  }
  return { entries: out, notes, deferred };
}

// Whether a PR is the collector's: open, or merged at or after `since` (no `since`: every merged one).
export function inWindow(view, since) {
  if (!view) return false;
  if (view.state === 'open') return true;
  if (view.state !== 'merged') return false;
  if (!since) return true;
  const at = Date.parse(view.mergedAt ?? '');
  return Number.isFinite(at) && at >= Date.parse(since);
}

// One pass over the ledgers. `viewOf(ledger, pr)`: the PR's { head, state, mergedAt }, or null when it can't be read
// (async: the runner's status gives it for open tickets, the forge for a merged one). Appends the new lines and
// returns { added, prs, notes }. `dryRun`: writes nothing, returns what it would add.
export async function collectEdits({ settings, ledgers, viewOf, git = learnGit(settings), since = settings.learning?.since ?? null, dryRun = false, now = Date.now(), authorsOf = null }) {
  if (!since) throw new Error('the collection needs `since` (learning.since or --since): it never reads the whole history');
  const state = settings.state;
  const seen = new Set(readLog(state).map((e) => e.id));
  const cursor = readJson(cursorPath(state), {});
  // The earliest `since` a pass used (`#since`): a pass with an earlier one reads again the PRs an earlier pass left
  // outside its window, so a backfill run after the switch still finds them.
  const was0 = cursor['#since'] ?? null;
  if (was0 && Date.parse(since) < Date.parse(was0)) for (const [k, v] of Object.entries(cursor)) if (k !== '#since' && v?.outside) delete cursor[k];
  if (!was0 || Date.parse(since) < Date.parse(was0)) cursor['#since'] = since;
  const added = [];
  const notes = [];
  const prs = [];
  for (const l of ledgers) {
    for (const pr of l.prs ?? []) {
      if (!pr.number) continue;
      const id = prId(pr);
      const ck = `${l.key}|${id}`;
      const was = cursor[ck];
      if (was?.final) continue;
      // A PR the ledger records merged before the window: outside, with no read.
      const mergedAt = Date.parse(pr.merged?.at ?? '');
      if (since && Number.isFinite(mergedAt) && mergedAt < Date.parse(since)) {
        cursor[ck] = { final: true, outside: true, at: new Date(now).toISOString() };
        continue;
      }
      let view = null;
      try {
        view = await viewOf(l, pr);
      } catch (e) {
        notes.push(`${id}: its state can't be read (${String(e.message ?? e).split('\n')[0]}): read at a later run`);
        continue;
      }
      if (!inWindow(view, since)) {
        if (view && view.state !== 'open') cursor[ck] = { ...(was ?? {}), final: true, outside: true, at: new Date(now).toISOString() };
        continue;
      }
      const edits = (pr.edits ?? []).length;
      const rejected = (pr.edits ?? []).filter((e) => e.rejected).length;
      if (was && was.head === view.head && was.edits === edits && was.rejected === rejected && view.state === 'open') continue;
      // The comment authors from the forge, only for a PR with an applied comment's edit not logged yet.
      let authors = null;
      const pending = (pr.edits ?? []).some((e) => commentEdit(e) && !seen.has(`comment:${id}:${e.list}:${e.n}`) && roundComments(l, pr, e.at).length);
      if (pending && authorsOf) {
        try {
          authors = await authorsOf(pr);
        } catch (e) {
          notes.push(`${id}: its comment authors can't be read (${String(e.message ?? e).split('\n')[0]}): its applied comments are read at a later pass`);
        }
      }
      const r = entriesOf({ settings, ledger: l, pr, view, git, authors });
      notes.push(...r.notes);
      const fresh = r.entries.filter((e) => !seen.has(e.id));
      for (const e of fresh) seen.add(e.id);
      added.push(...fresh.map((e) => ({ ...e, logged: new Date(now).toISOString() })));
      prs.push({ pr: id, key: l.key, added: fresh.length, state: view.state, ...(r.deferred ? { deferred: 'comment authors' } : {}) });
      // A PR whose commits git couldn't read here, or whose comment authors this pass couldn't read, is read again at a
      // later pass, whatever its head.
      if (!r.notes.length && !r.deferred) cursor[ck] = { head: view.head, edits, rejected, ...(view.state !== 'open' ? { final: true } : {}), at: new Date(now).toISOString() };
    }
  }
  if (!dryRun) {
    if (added.length) {
      fs.mkdirSync(learningDir(state), { recursive: true });
      fs.appendFileSync(logPath(state), added.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    writeJson(cursorPath(state), cursor);
  }
  return { added, prs, notes, since };
}

// One collector at a time: the runs a check hands on end together, and two appends of the same PR would race. A run that
// finds the lock taken skips the pass (the next run reads the same ledgers); a lock older than 10 minutes is stale.
// A dry run takes no lock and writes nothing, the learning folder included.
export async function collectOnce(settings, args) {
  if (args.dryRun) return collectEdits({ settings, ...args });
  const lock = path.join(learningDir(settings.state), '.collect.lock');
  fs.mkdirSync(learningDir(settings.state), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      /* gone meanwhile */
    }
    if (age < 10 * 60000) return { skipped: 'another collection runs', added: [], prs: [], notes: [] };
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  try {
    return await collectEdits({ settings, ...args });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// The view of a PR from the runner's status (`st.tickets[].prs`), else, for a PR the status no longer shows (a merged,
// closed ticket), from the forge once (`prState`).
export function viewsFrom(st, forge) {
  const byId = new Map();
  for (const t of st?.tickets ?? []) for (const v of t.prs ?? []) if (v?.id) byId.set(`${t.key}|${v.id}`, v);
  return async (l, pr) => {
    const v = byId.get(`${l.key}|${prId(pr)}`);
    if (v?.head && v.state) return { head: v.head, state: v.state, mergedAt: v.mergedAt ?? pr.merged?.at ?? null, mergeCommit: v.mergeCommit ?? pr.merged?.commit ?? null };
    // With no forge (a run's own pass), a PR its status doesn't show waits for a pass that reads the forge.
    if (!forge) return null;
    const s = await forge.prState({ repo: pr.repo, number: pr.number });
    return { head: s.headCommit ?? null, state: s.state === 'merged' || s.merged ? 'merged' : s.state === 'closed' ? 'closed' : 'open', mergedAt: s.mergedAt ?? pr.merged?.at ?? null, mergeCommit: s.mergeCommit ?? pr.merged?.commit ?? null };
  };
}
