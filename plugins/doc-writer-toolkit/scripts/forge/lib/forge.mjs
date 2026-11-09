import { CliError, Refusal } from './errors.mjs';
import { assertAdapter } from './adapter-contract.mjs';
import { STAGES, labelKey } from './settings.mjs';
import { withHeader, withoutHeader } from '../../tracker/lib/comment-header.mjs';

// The forge module. It owns every decision and calls an adapter (see `adapter-contract.mjs`) for the forge's own API.
// Nothing here knows GitHub.
//
// The rules held here, whatever the adapter:
//   - it works only on the repositories the settings' targets name, and asks only the logins the settings name;
//   - it adds only labels the settings name (the targets' stage labels, `checkLabel`, `expertLabel` and `readyLabel`)
//     and removes only the stage labels, `checkLabel` and `readyLabel`, so a label the settings don't name (the owner's
//     merge label) can't be set and `expertLabel` is never removed;
//   - it creates no label, but `readyLabel` on a repository that lacks it;
//   - a review on lines only comments, and a line outside the PR's diff is refused before anything is sent (or, asked,
//     its text goes into the review's own text);
//   - the texts it is given are sent exactly, but for the settings' `commentHeader` in front of every comment, line
//     comment and reply (not a PR's title or description): it adds no footer and no tool name;
//   - every write says which ids it posted;
//   - the operations are the ones in `OPERATIONS`; there is none to withdraw a review, give a verdict, join a branch,
//     close a PR or delete a branch. Two touch what was posted, each only on the pipeline's own: `resolveThread`
//     settles a thread whose first comment the caller posted (its id among the caller's own), and `deleteComment`
//     removes a conversation comment the caller posted, written from `self` and starting with the comment header. A
//     person's thread or comment is refused, and a submitted review can't be removed at all.

export const OPERATIONS = [
  'openPr', 'editPr', 'prState', 'changedPrsSince', 'prActivity', 'eventsSince', 'requestReviewers',
  'reviewOnLines', 'reply', 'suggest', 'comment', 'addLabel', 'removeLabel', 'setStageLabel', 'resolveThread', 'deleteComment',
];

// What the event feed reads by default (`eventsSince`): the events that move a ticket.
export const FEED_EVENTS = ['review_requested', 'review_request_removed', 'labeled', 'unlabeled', 'merged', 'closed', 'reopened'];

const ZWNJ = /‌/g;
const bare = (text) => String(text ?? '').replace(ZWNJ, '').trim();

const toIso = (value, what = 'a time') => {
  if (value === undefined || value === null || value === '') return null;
  if (Number.isNaN(Date.parse(value))) throw new CliError(`'${value}' is not ${what}: give an ISO date such as 2026-11-04T08:00:00Z`, { code: 2 });
  return new Date(value).toISOString();
};
const needNumber = (n) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0 || String(n).trim() !== String(v)) throw new CliError(`'${n}' is not a PR number`, { code: 2 });
  return v;
};
const needId = (n, what) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0 || String(n).trim() !== String(v)) throw new CliError(`'${n}' is not ${what}`, { code: 2 });
  return v;
};

// The ids a caller says it posted (its ledger's `posted`): a list, or a text of ids split by commas and spaces.
const ownIds = (own) => new Set((Array.isArray(own) ? own : String(own ?? '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean));

// A suggestion block, with a fence longer than any run of backticks inside the replacement.
export function suggestionBlock(replacement) {
  const text = String(replacement).replace(/\r?\n$/, '');
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}suggestion\n${text}\n${fence}`;
}

export function createForge({ adapter, forge, dryRun = false }) {
  assertAdapter(adapter);
  const header = forge.commentHeader ?? null;
  // A comment as sent, and as read for its first words or for a duplicate: without the header, so one posted before
  // the header existed counts the same (lib/comment-header.mjs in the tracker module).
  const posting = (body) => withHeader(body, header);
  const plain = (body) => withoutHeader(body, header);

  const repoOf = (input) => {
    const raw = String(input ?? '').trim();
    if (!raw) throw new CliError('a repo is needed (--repo)', { code: 2 });
    const [owner, name] = raw.includes('/') ? raw.split('/') : [forge.owner, raw];
    if (owner !== forge.owner || !forge.repos.includes(name)) {
      throw new Refusal('notAllowed', `'${raw}' is not a repository the settings' targets name. Known: ${forge.repos.join(', ')}.`, { repo: raw });
    }
    return name;
  };
  const loginsOf = (logins, what) => {
    const list = (logins ?? []).map((l) => String(l).trim()).filter(Boolean);
    for (const l of list) {
      if (!forge.logins.has(l)) throw new Refusal('notAllowed', `'${l}' is not a login the settings name (${what}).`, { login: l });
    }
    return list;
  };
  const labelsToAdd = (labels) =>
    (labels ?? []).map((raw) => {
      const hit = forge.addable.get(labelKey(raw));
      if (!hit) throw new Refusal('notNamed', `label '${raw}' is not one the settings name; the module adds only the targets' stage labels and the check label`, { label: raw });
      return hit;
    });
  const labelsToRemove = (labels) =>
    (labels ?? []).map((raw) => {
      const hit = forge.removable.get(labelKey(raw));
      if (!hit) throw new Refusal('notNamed', `label '${raw}' is not a stage label of a target nor the check label; the module removes only those`, { label: raw });
      return hit;
    });
  const target = (id) => {
    const t = forge.targets.find((x) => x.id === id);
    if (!t) throw new Refusal('unknown', `no target '${id}' in the settings. Known: ${forge.targets.map((x) => x.id).join(', ')}.`, { target: id });
    return t;
  };
  const text = (value, what) => {
    if (!bare(plain(value))) throw new Refusal('empty', `an empty ${what} is refused`);
    return value;
  };
  const same = (a, b) => labelKey(a) === labelKey(b);
  // A comment of the pipeline's: from `self` (when set) and, with a header in the settings, starting with it. The
  // pipeline posts from the owner's login, so the login alone tells nothing.
  const ownedText = (c) => (!forge.self || c.author === forge.self) && (!header || plain(c.body) !== String(c.body ?? ''));

  // The PR fields a caller needs everywhere; nothing the module would not return twice.
  const brief = (pr) => ({
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    head: pr.head,
    base: pr.base,
    headCommit: pr.headCommit,
    updatedAt: pr.updatedAt,
  });

  // One request that adds and removes labels in a PR. Labels the PR already has (or lacks) are left out.
  async function swapLabels(repo, number, add, remove, current) {
    const have = current ?? (await adapter.pr({ repo, number })).labels;
    const has = (name) => have.some((l) => same(l, name));
    const toAdd = add.filter((n) => !has(n));
    const toRemove = remove.filter((n) => has(n) && !add.some((a) => same(a, n)));
    if (toAdd.length || toRemove.length) await adapter.changeLabels({ repo, number, add: toAdd, remove: toRemove });
    return { added: toAdd, removed: toRemove, changed: Boolean(toAdd.length || toRemove.length) };
  }

  return {
    dryRun,

    // What the settings let the module touch.
    settings() {
      return {
        kind: forge.kind,
        owner: forge.owner,
        self: forge.self,
        assignee: forge.assignee,
        repos: forge.repos,
        targets: forge.targets.map(({ id, repo, review, reviewers, labels }) => ({ id, repo, review, reviewers, labels })),
        addableLabels: [...forge.addable.values()],
        removableLabels: [...forge.removable.values()],
        logins: [...forge.logins],
        operations: OPERATIONS,
      };
    },

    // A PR for the head, or the one that is already open for it. A second head in the same repo is a second PR.
    async openPr({ repo: repoIn, head, base, title, body = '', assignee, reviewers = [], labels = [], draft = false }) {
      const repo = repoOf(repoIn);
      const branch = String(head ?? '').trim().replace(new RegExp(`^${forge.owner}:`), '');
      if (!branch || branch.includes(':')) throw new CliError('openPr needs --head: a branch of the same repository', { code: 2 });
      if (!bare(base)) throw new CliError('openPr needs --base', { code: 2 });
      text(title, 'title');
      const who = assignee === undefined ? forge.assignee : assignee;
      const assignees = who ? loginsOf([who], 'assignee') : [];
      const asked = loginsOf(reviewers, 'reviewer');
      const wanted = labelsToAdd(labels);
      // The check and ready labels follow the ticket flow's records (its runner adds and removes them), never a PR's opening.
      const runners = wanted.filter((l) => [forge.checkLabel, forge.readyLabel].some((x) => x && same(x, l)));
      if (runners.length) throw new Refusal('notNamed', `open-pr does not set ${runners.map((l) => `'${l}'`).join(', ')}: the check and ready labels are added on their own (add-label)`, { labels: runners });
      const existing = await adapter.openPrByHead({ repo, head: branch });
      if (existing) {
        return { repo, created: false, ...brief(existing), reason: 'an open PR for this head already exists', posted: [] };
      }
      const made = await adapter.createPr({ repo, head: branch, base: base.trim(), title, body: body ?? '', draft: Boolean(draft) });
      try {
        if (assignees.length) await adapter.addAssignees({ repo, number: made.number, logins: assignees });
        if (asked.length) await adapter.requestReviewers({ repo, number: made.number, logins: asked });
        if (wanted.length) await adapter.changeLabels({ repo, number: made.number, add: wanted, remove: [] });
      } catch (e) {
        if (e.data) e.data.pr = { number: made.number, url: made.url };
        e.message = `${e.message} (the PR was opened: #${made.number} ${made.url}; set the rest with the single operations)`;
        throw e;
      }
      return {
        repo,
        created: true,
        number: made.number,
        url: made.url,
        draft: Boolean(draft),
        head: branch,
        base: base.trim(),
        assignees,
        reviewers: asked,
        labels: wanted,
        posted: [{ kind: 'pr', id: made.id, number: made.number }],
      };
    },

    // Title and/or description. An empty one is refused; the same text is a no-op.
    async editPr({ repo: repoIn, number, title, body }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      if (title === undefined && body === undefined) throw new CliError('editPr needs --title or --body', { code: 2 });
      if (title !== undefined) text(title, 'title');
      if (body !== undefined) text(body, 'description');
      const pr = await adapter.pr({ repo, number: n });
      const change = {};
      if (title !== undefined && title !== pr.title) change.title = title;
      if (body !== undefined && body !== pr.body) change.body = body;
      if (!Object.keys(change).length) return { repo, number: n, changed: false, reason: 'the PR already has this title and description', posted: [] };
      await adapter.updatePr({ repo, number: n, ...change });
      return { repo, number: n, changed: true, fields: Object.keys(change), posted: [] };
    },

    // The state of one PR, by number or by head branch.
    async prState({ repo: repoIn, number, head, withBody = false }) {
      const repo = repoOf(repoIn);
      if ((number === undefined || number === null) === !head) throw new CliError('prState needs exactly one of --number or --head', { code: 2 });
      const pr = head ? await adapter.prByHead({ repo, head: String(head).trim() }) : await adapter.pr({ repo, number: needNumber(number) });
      if (!pr) throw new Refusal('unknown', `no PR for the head '${head}' in ${repo}`, { head });
      const { nodeId, body, ...rest } = pr;
      return { repo, ...rest, ...(withBody ? { body } : {}) };
    },

    // Which PRs changed since a time: all states, newest update first.
    async changedPrsSince({ repo: repoIn, since }) {
      const repo = repoOf(repoIn);
      const from = toIso(since);
      if (!from) throw new CliError('changedPrsSince needs a time (--since)', { code: 2 });
      const prs = await adapter.changedPrs({ repo, since: from });
      const out = prs.map((p) => ({
        number: p.number,
        head: p.head,
        base: p.base,
        state: p.state,
        draft: p.draft,
        updatedAt: p.updatedAt,
        headCommit: p.headCommit,
        mergeCommit: p.mergeCommit,
        reviewDecision: p.reviewDecision,
        reviewRequests: p.reviewRequests,
        labels: p.labels,
        url: p.url,
      }));
      return { repo, since: from, count: out.length, numbers: out.map((p) => p.number), prs: out };
    },

    // Reviews, review threads with their comments, conversation comments and review requests of one PR; with a time,
    // only what was posted or edited since. Ids are the forge's numeric ids (what a write returns), `nodeId` the other form.
    async prActivity({ repo: repoIn, number, since }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      const from = toIso(since);
      const fresh = (c) => !from || c.createdAt >= from || c.updatedAt >= from;
      // GitHub stamps a comment of a new review a second after it was created; only a later update counts as an edit.
      const mark = (c) => ({ ...c, new: fresh(c), edited: Date.parse(c.updatedAt) - Date.parse(c.createdAt) > 5000 });
      const pr = await adapter.pr({ repo, number: n });
      const [reviews, threads, comments] = await Promise.all([adapter.reviews({ repo, number: n }), adapter.threads({ repo, number: n }), adapter.issueComments({ repo, number: n })]);
      const keptReviews = reviews.filter((r) => !from || (r.submittedAt && r.submittedAt >= from));
      const keptThreads = threads
        .filter((t) => t.comments.some(fresh))
        .map((t) => ({ ...t, comments: t.comments.map(mark) }));
      const keptComments = comments.filter(fresh).map(mark);
      return {
        repo,
        number: n,
        since: from,
        pr: { state: pr.state, headCommit: pr.headCommit, reviewDecision: pr.reviewDecision },
        reviewRequests: pr.reviewRequests,
        counts: { reviews: keptReviews.length, threads: keptThreads.length, comments: keptComments.length },
        reviews: keptReviews,
        threads: keptThreads,
        comments: keptComments,
      };
    },

    // The repository's PR events since a time, newest first. `types` narrows the default feed set.
    async eventsSince({ repo: repoIn, since, types }) {
      const repo = repoOf(repoIn);
      const from = toIso(since);
      if (!from) throw new CliError('eventsSince needs a time (--since)', { code: 2 });
      const wanted = types?.length ? types : FEED_EVENTS;
      const { events, truncated } = await adapter.events({ repo, since: from });
      const kept = events.filter((e) => e.createdAt >= from && wanted.includes(e.event));
      return { repo, since: from, types: wanted, count: kept.length, truncated, events: kept };
    },

    // Ask people for a review. Logins the settings name only; those already asked are left alone.
    async requestReviewers({ repo: repoIn, number, logins }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      const asked = loginsOf(logins, 'reviewer');
      if (!asked.length) throw new CliError('requestReviewers needs at least one login (--reviewer)', { code: 2 });
      const pr = await adapter.pr({ repo, number: n });
      const already = new Set(pr.reviewRequests.map((r) => r.login).filter(Boolean));
      const skipped = [];
      const todo = [];
      for (const l of asked) {
        if (already.has(l)) skipped.push({ login: l, reason: 'already asked' });
        else if (pr.author === l) skipped.push({ login: l, reason: 'the PR author cannot review it' });
        else todo.push(l);
      }
      if (todo.length) await adapter.requestReviewers({ repo, number: n, logins: todo });
      return { repo, number: n, requested: todo, skipped, changed: Boolean(todo.length), posted: [] };
    },

    // One review with event COMMENT and a comment per place. Lines outside the diff are refused, or with dropOutside
    // left out and listed, or with outsideInBody put into the review's own text (each as its path and line, then its
    // text), so nothing the caller wrote is lost. Comments already on the PR with the same path, line and text are not
    // posted again. With a text of its own, a review may hold no line comment (a round whose changes need none); one
    // whose text is already a review of the pipeline's login on the PR is not posted again.
    async reviewOnLines({ repo: repoIn, number, commit, comments, body, dropOutside = false, skipDiffCheck = false, outsideInBody = false }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      if (!bare(commit)) throw new CliError('reviewOnLines needs the commit the lines refer to (--commit)', { code: 2 });
      const hasBody = Boolean(bare(plain(body)));
      if (!Array.isArray(comments) || (!comments.length && !hasBody)) throw new Refusal('empty', 'reviewOnLines needs at least one comment: [{ path, line, body }], or a review text (--body)');
      if (dropOutside && outsideInBody) throw new CliError('give --drop-outside or --outside-in-body, not both', { code: 2 });
      const list = comments.map((c, i) => {
        if (!c || typeof c.path !== 'string' || !c.path.trim()) throw new Refusal('empty', `comment ${i + 1} has no path`);
        const line = Number(c.line);
        if (!Number.isInteger(line) || line <= 0) throw new Refusal('empty', `comment ${i + 1} (${c.path}) has no line number`);
        return { path: c.path.trim(), line, body: text(c.body, `comment ${i + 1} text`) };
      });
      const pr = await adapter.pr({ repo, number: n });
      let outside = [];
      let inside = list;
      if (!skipDiffCheck) {
        if (commit.trim() !== pr.headCommit) {
          throw new Refusal('stale', `the lines refer to ${commit.trim().slice(0, 12)} but the PR's head is ${String(pr.headCommit).slice(0, 12)}: read the diff of the head`, { commit: commit.trim(), headCommit: pr.headCommit });
        }
        const files = await adapter.diffLines({ repo, number: n });
        const byPath = new Map(files.map((f) => [f.path, f.lines]));
        inside = [];
        for (const c of list) {
          if (!byPath.has(c.path)) outside.push({ path: c.path, line: c.line, reason: 'the file is not in the diff' });
          else if (byPath.get(c.path) && !byPath.get(c.path).includes(c.line)) outside.push({ path: c.path, line: c.line, reason: 'the line is not in the diff' });
          else inside.push(c);
        }
        if (outside.length && !dropOutside && !outsideInBody) {
          throw new Refusal('outsideDiff', `${outside.length} comment(s) are on lines outside the PR's diff, where the forge takes no line comment; nothing was posted`, { outside });
        }
      }
      // A comment outside the diff, kept: under the review's text, as `path:line` and then its own text.
      const moved = outsideInBody ? list.filter((c) => outside.some((o) => o.path === c.path && o.line === c.line)) : [];
      const reviewText = [hasBody ? plain(body).trim() : null, ...moved.map((c) => `\`${c.path}:${c.line}\`\n${plain(c.body).trim()}`)].filter(Boolean).join('\n\n');
      const known = await adapter.reviewComments({ repo, number: n });
      const skipped = [];
      const toPost = [];
      for (const c of inside) {
        const dup = known.find((k) => k.path === c.path && k.line === c.line && plain(k.body) === plain(c.body));
        if (dup) skipped.push({ path: c.path, line: c.line, reason: 'the same comment is already on the PR', existing: dup.id });
        else toPost.push({ ...c, body: posting(c.body) });
      }
      const none = { repo, number: n, commit: commit.trim(), reviewId: null, commentIds: [], comments: [], skipped, outside, ...(moved.length ? { inBody: moved.map((c) => ({ path: c.path, line: c.line })) } : {}), posted: [] };
      // Nothing new on a line: every line comment already there is the review posted before. A review with no line
      // comment left (none given, or all kept in its text) is posted once for its text.
      if (!toPost.length) {
        if (!reviewText || inside.length) return none;
        const same = (await adapter.reviews({ repo, number: n })).find((r) => (!forge.self || r.author === forge.self) && bare(plain(r.body)) === bare(reviewText));
        if (same) return { ...none, existing: same.id, reason: 'a review with this text is already on the PR' };
      }
      const made = await adapter.createReview({ repo, number: n, commit: commit.trim(), ...(reviewText ? { body: posting(reviewText) } : {}), comments: toPost });
      // Each comment we sent is matched to the one the forge made, by path, line and text, so an id never lands on the wrong place.
      const left = [...made.comments];
      const placed = toPost.map((c) => {
        const at = left.findIndex((m) => m.path === c.path && m.line === c.line && m.body === c.body);
        const hit = at >= 0 ? left.splice(at, 1)[0] : null;
        return { id: hit?.id ?? null, path: c.path, line: c.line };
      });
      const ids = placed.map((c) => c.id).filter((id) => id !== null);
      return {
        repo,
        number: n,
        commit: commit.trim(),
        reviewId: made.id,
        commentIds: ids,
        comments: placed,
        skipped,
        outside,
        ...(moved.length ? { inBody: moved.map((c) => ({ path: c.path, line: c.line })) } : {}),
        posted: [{ kind: 'review', id: made.id }, ...ids.map((id) => ({ kind: 'review-comment', id }))],
      };
    },

    // A reply in a review thread. A reply to a reply goes to the thread's first comment.
    async reply({ repo: repoIn, number, comment, body }) {
      return replyIn({ repoIn, number, comment, body: text(body, 'reply') });
    },

    // A reply with a suggestion block: the lines the first comment of the thread is on, replaced by `replacement`.
    async suggest({ repo: repoIn, number, comment, replacement, body }) {
      if (!bare(replacement)) throw new Refusal('empty', 'a suggestion needs a replacement text');
      const full = `${bare(body) ? `${body}\n\n` : ''}${suggestionBlock(replacement)}`;
      return replyIn({ repoIn, number, comment, body: full });
    },

    // A comment in the PR's conversation. With `unlessHeader`, none when one since `since` already starts with it.
    async comment({ repo: repoIn, number, body, unlessHeader, since }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      text(body, 'comment');
      if (unlessHeader) {
        const from = toIso(since);
        const first = bare(plain(unlessHeader));
        if (!first) throw new Refusal('empty', "the header to look for is the comment header alone: give the message's first line");
        const existing = (await adapter.issueComments({ repo, number: n })).find((c) => (!from || c.createdAt >= from) && bare(plain(c.body)).startsWith(first));
        if (existing) return { repo, number: n, commented: false, reason: 'a comment with this header is already there', existing: existing.id, posted: [] };
      }
      const made = await adapter.comment({ repo, number: n, body: posting(body) });
      return { repo, number: n, commented: true, id: made.id, posted: [{ kind: 'comment', id: made.id }] };
    },

    // The ready label is created on a repository that lacks it, then added; any other label the repository lacks is
    // refused, as before.
    async addLabel({ repo: repoIn, number, label }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      const [name] = labelsToAdd([label]);
      let r;
      let created = false;
      try {
        r = await swapLabels(repo, n, [name], []);
      } catch (e) {
        if (!(e instanceof Refusal && e.refused === 'unknown' && forge.readyLabel && same(name, forge.readyLabel) && same(e.data?.label, name))) throw e;
        await adapter.createLabel({ repo, name });
        created = true;
        // A dry run created nothing, so the repository still lacks it: the add it would make is reported.
        r = dryRun ? { added: [name], removed: [], changed: true } : await swapLabels(repo, n, [name], []);
      }
      return { repo, number: n, label: name, changed: r.changed, ...(created ? { created: true } : {}), ...(r.changed ? {} : { reason: 'the PR already has the label' }), posted: [] };
    },

    async removeLabel({ repo: repoIn, number, label }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      const [name] = labelsToRemove([label]);
      const r = await swapLabels(repo, n, [], [name]);
      return { repo, number: n, label: name, changed: r.changed, ...(r.changed ? {} : { reason: 'the PR does not have the label' }), posted: [] };
    },

    // The PR's stage label follows the card: add the target's label for the new stage and remove the target's other
    // stage labels, in one request. It reads the PR's labels as they are, so it does not matter who moved the card or
    // who set the previous label.
    async setStageLabel({ repo: repoIn, number, target: targetId, stage }) {
      const t = target(targetId);
      const repo = repoOf(repoIn ?? t.repo);
      if (repo !== t.repo) throw new Refusal('notAllowed', `target '${t.id}' is for ${t.repo}, not ${repo}`, { target: t.id, repo });
      const n = needNumber(number);
      if (!STAGES.includes(stage)) throw new Refusal('unknown', `'${stage}' is not a stage. Known: ${STAGES.join(', ')}.`, { stage });
      const wanted = t.labels[stage];
      if (!wanted) throw new Refusal('notNamed', `target '${t.id}' names no label for the stage '${stage}'`, { target: t.id, stage });
      const others = STAGES.filter((s) => s !== stage).map((s) => t.labels[s]).filter((l) => l && !same(l, wanted));
      const r = await swapLabels(repo, n, [wanted], others);
      return { repo, number: n, target: t.id, stage, label: wanted, ...r, ...(r.changed ? {} : { reason: 'the PR already has exactly this stage label' }), posted: [] };
    },

    // Settles a review thread the pipeline opened: the thread whose first comment is `comment`, an id among the
    // caller's own (`own`, its ledger's posted ids), written from `self` and starting with the comment header when the
    // settings have one. Any other thread (a person's, or one the pipeline only replied in) is refused. A thread
    // already settled is a no-op.
    async resolveThread({ repo: repoIn, number, comment, own }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      const id = needId(comment, 'a review comment id');
      if (!ownIds(own).has(String(id))) throw new Refusal('notOwn', `comment ${id} is not among the ids the caller posted (--own): only the pipeline's own thread is settled`, { comment: id });
      const threads = await adapter.threads({ repo, number: n });
      const thread = threads.find((t) => String(t.comments[0]?.id) === String(id));
      if (!thread) {
        const inside = threads.find((t) => t.comments.some((c) => String(c.id) === String(id)));
        throw new Refusal(inside ? 'notOwn' : 'unknown', inside ? `comment ${id} is a reply in a thread another comment opened: only a thread the pipeline opened is settled` : `no review thread on PR #${n} starts with comment ${id}`, { comment: id });
      }
      const first = thread.comments[0];
      if (!ownedText(first)) throw new Refusal('notOwn', `the thread of comment ${id} was not opened from ${forge.self ?? 'the pipeline\'s login'} with the comment header: it is a person's`, { comment: id, author: first.author ?? null });
      if (thread.resolved) return { repo, number: n, comment: id, thread: thread.id, resolved: false, reason: 'the thread is already resolved', posted: [] };
      await adapter.resolveThread({ repo, thread: thread.id });
      return { repo, number: n, comment: id, thread: thread.id, resolved: true, posted: [] };
    },

    // Removes a conversation comment the pipeline posted and a newer one replaces (an older summary, a duplicate):
    // only an id among the caller's own (`own`), on this PR, written from `self` and starting with the comment header.
    // A line comment or a review is never removed here. A comment already gone is the forge's 404 (the caller warns).
    async deleteComment({ repo: repoIn, number, comment, own }) {
      const repo = repoOf(repoIn);
      const n = needNumber(number);
      const id = needId(comment, 'a comment id');
      if (!ownIds(own).has(String(id))) throw new Refusal('notOwn', `comment ${id} is not among the ids the caller posted (--own): only the pipeline's own comment is removed`, { comment: id });
      if (!forge.self || !header) throw new Refusal('notOwn', 'removing a comment needs forge.self and the comment header in the settings: without them a comment of the pipeline\'s can\'t be told from a person\'s', { comment: id });
      const found = await adapter.issueComment({ repo, id });
      if (found.number !== n) throw new Refusal('unknown', `comment ${id} is on #${found.number}, not #${n}`, { comment: id, number: found.number });
      if (!ownedText(found)) throw new Refusal('notOwn', `comment ${id} was not written from ${forge.self} with the comment header: it is a person's`, { comment: id, author: found.author ?? null });
      await adapter.deleteComment({ repo, id });
      return { repo, number: n, comment: id, deleted: true, posted: [] };
    },
  };

  async function replyIn({ repoIn, number, comment, body }) {
    const repo = repoOf(repoIn);
    const n = needNumber(number);
    const id = needId(comment, 'a review comment id');
    const found = await adapter.reviewComment({ repo, id });
    if (found.number !== n) throw new Refusal('unknown', `review comment ${id} is on PR #${found.number}, not #${n}`, { comment: id, number: found.number });
    const root = found.inReplyTo ?? found.id;
    const thread = (await adapter.reviewComments({ repo, number: n })).filter((c) => c.id === root || c.inReplyTo === root);
    const dup = thread.find((c) => c.id !== root && plain(c.body) === plain(body) && (!forge.self || c.author === forge.self));
    if (dup) return { repo, number: n, replied: false, reason: 'the thread already has this reply', thread: root, existing: dup.id, posted: [] };
    const made = await adapter.reply({ repo, number: n, comment: root, body: posting(body) });
    return { repo, number: n, replied: true, id: made.id, thread: root, posted: [{ kind: 'review-comment', id: made.id }] };
  }
}
