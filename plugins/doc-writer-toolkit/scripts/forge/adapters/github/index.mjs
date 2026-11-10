import { Refusal } from '../../lib/errors.mjs';

// The GitHub adapter: the interface of `lib/adapter-contract.mjs` over `gh api` (REST and GraphQL). `gh pr edit`,
// `gh pr create` and the other porcelain commands are not used: they run GraphQL queries of their own that fail on
// some repositories.

const PAGE = 100;
const MAX_PAGES = 100;
const PR_STATE = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const PR_FIELDS = `
  id number url title body state isDraft merged mergedAt closedAt createdAt updatedAt
  headRefName headRefOid baseRefName reviewDecision mergeable mergeStateStatus
  author { login }
  mergeCommit { oid }
  headRepository { nameWithOwner }
  labels(first: 100) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
`;

// With `forge.keepFresh` (`fresh`), one PR read by number also gives its base branch's tip now (`baseRef`, not
// `baseRefOid`, which GitHub keeps from the PR's last update) and the CI checks of its head commit: what keeping the
// branch up to date with its base reads. Without it the read is as before, so a token that can't read checks reads PRs.
const PR_FRESH_FIELDS = `
  baseRef { target { oid } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
`;

const Q = {
  prByNumber: `query PrByNumber($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } }
  }`,
  prByNumberFresh: `query PrByNumber($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} ${PR_FRESH_FIELDS} } }
  }`,
  prsByHead: `query PrsByHead($owner: String!, $name: String!, $head: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(headRefName: $head, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    }
  }`,
  changedPrs: `query ChangedPrs($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PR_FIELDS} }
      }
    }
  }`,
  reviews: `query PrReviews($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviews(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { __typename login } state body submittedAt commit { oid } }
      }
    } }
  }`,
  threads: `query PrThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { id databaseId author { __typename login } body createdAt updatedAt path line replyTo { databaseId } pullRequestReview { databaseId state } }
          }
        }
      }
    } }
  }`,
  comments: `query PrComments($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId author { __typename login } body createdAt updatedAt }
      }
    } }
  }`,
  labelTargets: `query LabelTargets($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { id }
      labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name } }
    }
  }`,
};

// The new-side line numbers a unified diff patch shows, context lines and added lines.
export function patchLines(patch) {
  const lines = new Set();
  let n = 0;
  for (const row of String(patch).split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (!n) continue;
    if (row.startsWith('\\')) continue;
    if (row.startsWith('-')) continue;
    lines.add(n);
    n++;
  }
  return [...lines];
}

const login = (u) => u?.login ?? null;
// GraphQL gives a bot's login without `[bot]` (`netlify`, `github-actions`), so its type says it; REST logins carry the suffix.
const authorBot = (u) => (u?.__typename === 'Bot' || /\[bot\]$/.test(u?.login ?? '') ? { authorBot: true } : {});

function reviewRequestOf(node) {
  const r = node?.requestedReviewer;
  if (!r) return null;
  return r.__typename === 'Team' ? { team: r.slug } : { login: r.login };
}

// The CI checks of a commit, from GitHub's status check rollup: `state` `success`, `failure` or `pending`, or null when
// no check reported on it; the names of the failing ones and of those still running. A check run that ended neutral or
// skipped neither fails nor waits.
const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
export function checksOf(commit) {
  const rollup = commit?.statusCheckRollup ?? null;
  const contexts = rollup?.contexts?.nodes ?? [];
  const failing = [];
  const pending = [];
  for (const c of contexts) {
    if (c.__typename === 'StatusContext') {
      if (['FAILURE', 'ERROR'].includes(c.state)) failing.push(c.context);
      else if (['PENDING', 'EXPECTED'].includes(c.state)) pending.push(c.context);
    } else if (c.status && c.status !== 'COMPLETED') pending.push(c.name);
    else if (FAILED_RUN.has(c.conclusion)) failing.push(c.name);
  }
  const state = !rollup ? null : failing.length || ['FAILURE', 'ERROR'].includes(rollup.state) ? 'failure' : pending.length || ['PENDING', 'EXPECTED'].includes(rollup.state) ? 'pending' : 'success';
  return { commit: commit?.oid ?? null, state, failing, pending };
}

export function normalizePr(n) {
  if (!n) return null;
  return {
    number: n.number,
    nodeId: n.id,
    url: n.url,
    title: n.title,
    body: n.body ?? '',
    state: n.merged ? 'merged' : (PR_STATE[n.state] ?? String(n.state).toLowerCase()),
    draft: Boolean(n.isDraft),
    head: n.headRefName,
    base: n.baseRefName,
    headCommit: n.headRefOid,
    mergeCommit: n.mergeCommit?.oid ?? null,
    mergedAt: n.mergedAt ?? null,
    closedAt: n.closedAt ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    author: login(n.author),
    reviewDecision: n.reviewDecision ?? null,
    mergeable: n.mergeable ?? null,
    mergeState: n.mergeStateStatus ?? null,
    reviewRequests: (n.reviewRequests?.nodes ?? []).map(reviewRequestOf).filter(Boolean),
    labels: (n.labels?.nodes ?? []).map((l) => l.name),
    assignees: (n.assignees?.nodes ?? []).map((a) => a.login),
    headRepository: n.headRepository?.nameWithOwner ?? null,
    // Only from a read by number, which asks for them.
    ...(n.baseRef !== undefined ? { baseCommit: n.baseRef?.target?.oid ?? null } : {}),
    ...(n.commits !== undefined ? { checks: checksOf(n.commits?.nodes?.[0]?.commit) } : {}),
  };
}

const commentOf = (n) => ({
  id: n.databaseId,
  nodeId: n.id,
  author: login(n.author),
  ...authorBot(n.author),
  body: n.body,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

export function createGithubAdapter(gh, { owner, pageSize = PAGE, fresh = false }) {
  const repoPath = (repo) => `repos/${owner}/${repo}`;
  const vars = (repo, extra = {}) => ({ owner, name: repo, ...extra });
  const must = (value, what) => {
    if (!value) throw new Refusal('unknown', `${what} was not found`);
    return value;
  };

  // A GraphQL connection read page by page.
  async function pages(name, document, variables, pick) {
    const nodes = [];
    let after = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const data = await gh.query(name, document, { ...variables, after });
      const conn = pick(data);
      nodes.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return nodes;
  }

  // A REST list read page by page: `per_page` and `page` are added to the path.
  async function restPages(pathname, { until } = {}) {
    const rows = [];
    const sep = pathname.includes('?') ? '&' : '?';
    let truncated = false;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        truncated = true;
        break;
      }
      const got = await gh.get(`${pathname}${sep}per_page=${pageSize}&page=${page}`);
      rows.push(...got);
      if (got.length < pageSize || (until && until(got))) break;
    }
    return { rows, truncated };
  }

  const getPr = async (repo, number) => {
    const data = await gh.query('PrByNumber', fresh ? Q.prByNumberFresh : Q.prByNumber, vars(repo, { number }));
    return normalizePr(must(data.repository?.pullRequest, `PR #${number} in ${repo}`));
  };
  const byHead = async (repo, head) => {
    const data = await gh.query('PrsByHead', Q.prsByHead, vars(repo, { head }));
    // Only branches of the repository itself: a fork's branch with the same name is not the same head.
    return (data.repository?.pullRequests?.nodes ?? []).map(normalizePr).filter((p) => !p.headRepository || p.headRepository === `${owner}/${repo}`);
  };

  return {
    kind: 'github',

    pr: ({ repo, number }) => getPr(repo, number),
    async prByHead({ repo, head }) {
      const all = await byHead(repo, head);
      return all.find((p) => p.state === 'open') ?? all[0] ?? null;
    },
    async openPrByHead({ repo, head }) {
      return (await byHead(repo, head)).find((p) => p.state === 'open') ?? null;
    },

    // Newest update first, all states, until a PR older than `since` is on the page.
    async changedPrs({ repo, since }) {
      const out = [];
      let after = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const data = await gh.query('ChangedPrs', Q.changedPrs, vars(repo, { after }));
        const conn = data.repository.pullRequests;
        let done = false;
        for (const node of conn.nodes) {
          if (node.updatedAt < since) {
            done = true;
            break;
          }
          out.push(normalizePr(node));
        }
        if (done || !conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return out;
    },

    async reviews({ repo, number }) {
      const nodes = await pages('PrReviews', Q.reviews, vars(repo, { number }), (d) => must(d.repository?.pullRequest, `PR #${number}`).reviews);
      return nodes
        .filter((r) => r.state !== 'PENDING')
        .map((r) => ({ id: r.databaseId, nodeId: r.id, author: login(r.author), ...authorBot(r.author), state: r.state, body: r.body ?? '', submittedAt: r.submittedAt ?? null, commit: r.commit?.oid ?? null }));
    },

    // GitHub gives the author of a review not yet submitted (`PENDING`) its line comments too. The forge acts from the
    // owner's own login, so those would read as the owner's: they are left out, as `reviews` leaves out the review, and
    // a thread with nothing else (one the draft opened) with them. Once the review is submitted they are read.
    async threads({ repo, number }) {
      const nodes = await pages('PrThreads', Q.threads, vars(repo, { number }), (d) => must(d.repository?.pullRequest, `PR #${number}`).reviewThreads);
      return nodes
        .map((t) => ({
          id: t.id,
          resolved: t.isResolved,
          outdated: t.isOutdated,
          path: t.path,
          line: t.line ?? null,
          truncated: Boolean(t.comments.pageInfo.hasNextPage),
          comments: t.comments.nodes
            .filter((c) => c.pullRequestReview?.state !== 'PENDING')
            .map((c) => ({
              ...commentOf(c),
              path: c.path,
              line: c.line ?? null,
              inReplyTo: c.replyTo?.databaseId ?? null,
              reviewId: c.pullRequestReview?.databaseId ?? null,
            })),
        }))
        .filter((t) => t.comments.length);
    },

    async issueComments({ repo, number }) {
      const nodes = await pages('PrComments', Q.comments, vars(repo, { number }), (d) => must(d.repository?.pullRequest, `PR #${number}`).comments);
      return nodes.map(commentOf);
    },

    async reviewComments({ repo, number }) {
      const { rows } = await restPages(`${repoPath(repo)}/pulls/${number}/comments`);
      return rows.map(restReviewComment);
    },

    async reviewComment({ repo, id }) {
      const c = await gh.get(`${repoPath(repo)}/pulls/comments/${id}`);
      const m = /\/pulls\/(\d+)$/.exec(c.pull_request_url ?? '');
      return { ...restReviewComment(c), number: m ? Number(m[1]) : null };
    },

    async issueComment({ repo, id }) {
      const c = await gh.get(`${repoPath(repo)}/issues/comments/${id}`);
      const m = /\/issues\/(\d+)$/.exec(c.issue_url ?? '');
      return { id: c.id, nodeId: c.node_id, author: login(c.user), ...authorBot(c.user), body: c.body, createdAt: c.created_at, updatedAt: c.updated_at, number: m ? Number(m[1]) : null };
    },

    // `issues/events` has no `since` parameter and lists the newest first: read pages until one holds an event older
    // than `since`. Only PRs are kept.
    async events({ repo, since }) {
      const { rows, truncated } = await restPages(`${repoPath(repo)}/issues/events`, { until: (got) => got[got.length - 1].created_at < since });
      const events = rows
        .filter((e) => e.issue?.pull_request)
        .map((e) => ({
          id: e.id,
          event: e.event,
          createdAt: e.created_at,
          actor: login(e.actor),
          number: e.issue.number,
          ...(e.label ? { label: e.label.name } : {}),
          ...(e.requested_reviewer ? { reviewer: e.requested_reviewer.login } : {}),
          ...(e.requested_team ? { team: e.requested_team.slug } : {}),
          ...(e.review_requester ? { requester: e.review_requester.login } : {}),
          ...(e.commit_id ? { commit: e.commit_id } : {}),
        }));
      return { events, truncated };
    },

    // The new-side lines each changed file shows. A file with no patch text (binary, too large) has `lines: null`.
    async diffLines({ repo, number }) {
      const { rows } = await restPages(`${repoPath(repo)}/pulls/${number}/files`);
      return rows.map((f) => ({ path: f.filename, lines: typeof f.patch === 'string' ? patchLines(f.patch) : null }));
    },

    async createPr({ repo, head, base, title, body, draft }) {
      const made = await gh.write('POST', `${repoPath(repo)}/pulls`, { title, head, base, body, draft }, { number: 0, html_url: `dry-run://${repo}/pull/0`, node_id: 'dry-run' });
      return { number: made.number, url: made.html_url, id: made.id, nodeId: made.node_id };
    },

    async updatePr({ repo, number, title, body }) {
      await gh.write('PATCH', `${repoPath(repo)}/pulls/${number}`, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) });
    },

    async addAssignees({ repo, number, logins }) {
      await gh.write('POST', `${repoPath(repo)}/issues/${number}/assignees`, { assignees: logins });
    },

    async requestReviewers({ repo, number, logins }) {
      await gh.write('POST', `${repoPath(repo)}/pulls/${number}/requested_reviewers`, { reviewers: logins });
    },

    // A review whose only verdict is a comment. The event is fixed here; nothing above this line can change it.
    async createReview({ repo, number, commit, body, comments }) {
      const made = await gh.write(
        'POST',
        `${repoPath(repo)}/pulls/${number}/reviews`,
        {
          commit_id: commit,
          event: 'COMMENT',
          ...(body ? { body } : {}),
          comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
        },
        { state: 'COMMENTED' },
      );
      if (gh.dryRun) return { id: made.id, comments: comments.map((c, i) => ({ ...c, id: `dry-run-comment-${i + 1}` })) };
      // The review's own comment list has no `line` field; the PR's comment list has, so the new comments are picked from it.
      const { rows } = await restPages(`${repoPath(repo)}/pulls/${number}/comments`);
      return { id: made.id, comments: rows.filter((c) => c.pull_request_review_id === made.id).map(restReviewComment) };
    },

    async reply({ repo, number, comment, body }) {
      const made = await gh.write('POST', `${repoPath(repo)}/pulls/${number}/comments/${comment}/replies`, { body });
      return { id: made.id };
    },

    async comment({ repo, number, body }) {
      const made = await gh.write('POST', `${repoPath(repo)}/issues/${number}/comments`, { body });
      return { id: made.id };
    },

    // A label on the repository, in the forge's default grey. One there already (GitHub answers 422) is no error.
    async createLabel({ repo, name }) {
      try {
        await gh.write('POST', `${repoPath(repo)}/labels`, { name, color: 'ededed' });
      } catch (e) {
        if (e?.data?.status !== 422) throw e;
      }
    },

    // One review thread settled, by its GraphQL id (a Thread's `id`).
    async resolveThread({ thread }) {
      await gh.write('POST', 'graphql', {
        query: 'mutation ResolveThread($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }',
        variables: { thread },
      });
    },

    // One conversation comment removed (GitHub answers 204, no body).
    async deleteComment({ repo, id }) {
      await gh.write('DELETE', `${repoPath(repo)}/issues/comments/${id}`);
    },

    // Labels by name, in one GraphQL request. A name the repository doesn't have is refused: it is not created here.
    async changeLabels({ repo, number, add, remove }) {
      if (!add.length && !remove.length) return;
      let prId = null;
      const ids = new Map();
      let after = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const data = await gh.query('LabelTargets', Q.labelTargets, vars(repo, { number, after }));
        prId = must(data.repository?.pullRequest, `PR #${number} in ${repo}`).id;
        for (const l of data.repository.labels.nodes) ids.set(l.name.trim().toLowerCase(), l.id);
        if (!data.repository.labels.pageInfo.hasNextPage) break;
        after = data.repository.labels.pageInfo.endCursor;
      }
      const idOf = (name) => {
        const id = ids.get(name.trim().toLowerCase());
        if (!id) throw new Refusal('unknown', `the repository ${repo} has no label '${name}'; the module creates only the ready label`, { label: name });
        return id;
      };
      const addIds = add.map(idOf);
      const removeIds = remove.map(idOf);
      const head = ['$pr: ID!', ...(addIds.length ? ['$add: [ID!]!'] : []), ...(removeIds.length ? ['$remove: [ID!]!'] : [])].join(', ');
      const parts = [
        ...(addIds.length ? ['added: addLabelsToLabelable(input: { labelableId: $pr, labelIds: $add }) { clientMutationId }'] : []),
        ...(removeIds.length ? ['removed: removeLabelsFromLabelable(input: { labelableId: $pr, labelIds: $remove }) { clientMutationId }'] : []),
      ];
      await gh.write('POST', 'graphql', {
        query: `mutation ChangeLabels(${head}) { ${parts.join(' ')} }`,
        variables: { pr: prId, ...(addIds.length ? { add: addIds } : {}), ...(removeIds.length ? { remove: removeIds } : {}) },
      });
    },
  };
}

function restReviewComment(c) {
  return {
    id: c.id,
    nodeId: c.node_id,
    author: login(c.user),
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    inReplyTo: c.in_reply_to_id ?? null,
    reviewId: c.pull_request_review_id ?? null,
  };
}
