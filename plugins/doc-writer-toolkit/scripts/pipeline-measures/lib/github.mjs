import { CliError } from '../../ui-labels/lib/util.mjs';
import { windowOf } from './config.mjs';

const LIST_FIELDS = 'number,title,state,isDraft,headRefName,createdAt,mergedAt,closedAt,body,author,reviewRequests,reviews';

const repoArgs = (s) => (s.repo ? ['--repo', s.repo] : []);

async function json(gh, args) {
  const out = await gh(args);
  try {
    return JSON.parse(out);
  } catch {
    throw new CliError(`gh ${args.slice(0, 2).join(' ')} did not print JSON`, { code: 1 });
  }
}

// The pull requests created in the window whose branch matches the pipeline's pattern, oldest first.
// One list call; the commits come per pull request (a list call with the commits is too big for GitHub's API).
export async function listPrs(gh, s) {
  const list = await json(gh, ['pr', 'list', '--state', 'all', '--limit', '1000', '--search', `created:${s.from}..${s.to}`, '--json', LIST_FIELDS, ...repoArgs(s)]);
  const { start, end } = windowOf(s);
  return list
    .filter((p) => s.branchPattern.test(p.headRefName) && Date.parse(p.createdAt) >= start && Date.parse(p.createdAt) < end)
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const author = p.author?.login ?? null;
      return {
        number: p.number,
        title: p.title ?? '',
        branch: p.headRefName,
        state: { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }[p.state] ?? String(p.state).toLowerCase(),
        isDraft: Boolean(p.isDraft),
        createdAt: p.createdAt,
        mergedAt: p.mergedAt || null,
        closedAt: p.closedAt || null,
        body: p.body ?? '',
        // Counts only: a person's login is not a measure. A review by the author is not a reviewer.
        reviewRequests: (p.reviewRequests ?? []).length,
        reviewsByOthers: (p.reviews ?? []).filter((r) => r.author?.login && r.author.login !== author).length,
      };
    });
}

// The pull request's commits, in branch order: { oid, subject, date }.
export async function prCommits(gh, s, number) {
  const data = await json(gh, ['pr', 'view', String(number), '--json', 'commits', ...repoArgs(s)]);
  return (data.commits ?? []).map((c) => ({ oid: c.oid, subject: c.messageHeadline ?? '', date: c.committedDate ?? c.authoredDate ?? null }));
}
