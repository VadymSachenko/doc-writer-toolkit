import { Refusal } from '../lib/errors.mjs';

// An adapter that keeps its PRs in memory and knows nothing of GitHub. It stands for "a GitLab adapter": the same
// module, settings and callers run on it unchanged, which is what the interface is for.

export function memoryAdapter() {
  const prs = [
    {
      number: 1, nodeId: 'mr-1', url: 'forge://guide-docs/1', title: 'First', body: 'one', state: 'open', draft: false, head: 'topic-a', base: 'main',
      headCommit: 'c0ffee0', mergeCommit: null, mergedAt: null, closedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z',
      author: 'docs-writer', reviewDecision: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewRequests: [], labels: ['in progress'], assignees: [],
    },
  ];
  const log = [];
  const get = (n) => {
    const p = prs.find((x) => x.number === n);
    if (!p) throw new Refusal('unknown', `no PR ${n}`);
    return p;
  };
  return {
    kind: 'memory',
    log,
    pr: async ({ number }) => ({ ...get(number) }),
    prByHead: async ({ head }) => prs.find((p) => p.head === head) ?? null,
    openPrByHead: async ({ head }) => prs.find((p) => p.head === head && p.state === 'open') ?? null,
    changedPrs: async ({ since }) => prs.filter((p) => p.updatedAt >= since),
    reviews: async () => [],
    threads: async () => [],
    issueComments: async () => [],
    reviewComments: async () => [],
    reviewComment: async () => {
      throw new Refusal('unknown', 'no such comment');
    },
    events: async () => ({ events: [], truncated: false }),
    diffLines: async () => [{ path: 'docs/a.md', lines: [1, 2, 3] }],
    createPr: async (a) => {
      log.push(['createPr', a.head]);
      prs.push({ ...prs[0], number: prs.length + 1, head: a.head, title: a.title, labels: [] });
      return { number: prs.length, url: `forge://guide-docs/${prs.length}`, id: 5000 + prs.length, nodeId: `mr-${prs.length}` };
    },
    updatePr: async (a) => void log.push(['updatePr', a.number, a.title, a.body]),
    addAssignees: async (a) => void log.push(['addAssignees', a.logins]),
    requestReviewers: async (a) => void log.push(['requestReviewers', a.logins]),
    createReview: async (a) => (log.push(['createReview', a.comments.length]), { id: 77, comments: a.comments.map((c, i) => ({ ...c, id: 780 + i })) }),
    reply: async (a) => (log.push(['reply', a.comment]), { id: 90 }),
    comment: async (a) => (log.push(['comment', a.body]), { id: 91 }),
    createLabel: async (a) => void log.push(['createLabel', a.name]),
    changeLabels: async (a) => {
      log.push(['changeLabels', a.add, a.remove]);
      const p = get(a.number);
      p.labels = [...p.labels.filter((l) => !a.remove.includes(l)), ...a.add];
    },
  };
}
