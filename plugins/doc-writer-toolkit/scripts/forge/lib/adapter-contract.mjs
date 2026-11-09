// What the module asks of a forge adapter. The module (`lib/forge.mjs`) owns every decision: which repos, logins and
// labels the settings name, the label rules, the diff check before a line comment, the idempotency checks. An adapter
// only turns these calls into its forge's API and the answers into the shapes below. A GitLab adapter is a new folder
// under `adapters/` with these methods and one line in `adapters/index.mjs`; no caller changes.
//
// `repo` is the repository's name, without the owner (the adapter knows the owner from the settings). A `number` is
// the PR's number (a merge request's iid on GitLab). A *login* is a user name.
//
// Shapes
//   Pr       { number, nodeId, url, title, body, state: 'open'|'closed'|'merged', draft, head, base, headCommit,
//              mergeCommit|null, mergedAt|null, closedAt|null, createdAt, updatedAt, author|null,
//              reviewDecision|null, mergeable, mergeState, reviewRequests: [{ login }|{ team }], labels: [names],
//              assignees: [logins] }
//   Event    { id, event, createdAt, actor|null, number, label?, reviewer?, team?, requester?, commit? }
//   Review   { id, nodeId, author|null, state, body, submittedAt, commit|null }
//   Thread   { id, resolved, outdated, path, line|null, truncated, comments: [Comment] }
//   Comment  { id, nodeId, author|null, authorBot?, body, createdAt, updatedAt, path?, line?, inReplyTo?|null, reviewId? }
//            (`authorBot: true` on a Comment or a Review whose author is a bot)
//
// Reads (nothing here changes the forge)
//   pr({repo, number})                    -> Pr
//   prByHead({repo, head})                -> Pr | null; an open PR of that head branch in the same repo, else the most recent
//   openPrByHead({repo, head})            -> Pr | null; an open one only
//   changedPrs({repo, since})             -> [Pr], newest update first, every state, read until one is older than `since`
//   reviews({repo, number})               -> [Review], submitted ones only: never a review not yet sent (a draft)
//   threads({repo, number})               -> [Thread], never a comment of a review not yet sent, nor a thread with
//                                            nothing else
//   issueComments({repo, number})         -> [Comment], the PR's conversation comments
//   reviewComments({repo, number})        -> [Comment], every review comment, flat, with `inReplyTo`
//   reviewComment({repo, id})             -> Comment & { number }, one review comment and the PR it is on
//   events({repo, since})                 -> { events: [Event], truncated }, newest first, only PRs
//   diffLines({repo, number})             -> [{ path, lines: [numbers]|null }]; the new-side lines the diff shows,
//                                            null when the forge gave no diff text for the file
// Writes (each goes through the client's one `write`, which `--dry-run` stops)
//   createPr({repo, head, base, title, body, draft})  -> { number, url, id, nodeId }
//   updatePr({repo, number, title?, body?})
//   addAssignees({repo, number, logins})
//   requestReviewers({repo, number, logins})
//   createReview({repo, number, commit, body?, comments: [{path, line, body}]}) -> { id, comments: [{ id, path, line, body }] }
//        a review that only comments: the interface has no way to give another verdict.
//   reply({repo, number, comment, body})          -> { id }
//   comment({repo, number, body})                 -> { id }
//   changeLabels({repo, number, add: [names], remove: [names]})
//        one request; a name the repository doesn't have is a Refusal('unknown', …, { label }): it is not created here.
//   createLabel({repo, name})
//        a label on the repository; one already there (in any case) is no error. The module calls it only for the
//        settings' `readyLabel`.
//
// An adapter has no operation that settles a discussion, withdraws a review, gives a verdict, joins the branch into
// its base, closes a PR or removes a branch, and none that a caller could add: those rules are held by what the
// interface does not contain.

export const READS = ['pr', 'prByHead', 'openPrByHead', 'changedPrs', 'reviews', 'threads', 'issueComments', 'reviewComments', 'reviewComment', 'events', 'diffLines'];
export const WRITES = ['createPr', 'updatePr', 'addAssignees', 'requestReviewers', 'createReview', 'reply', 'comment', 'changeLabels', 'createLabel'];

export function assertAdapter(adapter) {
  const missing = [...READS, ...WRITES].filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`the ${adapter?.kind ?? 'forge'} adapter lacks: ${missing.join(', ')}`);
  return adapter;
}
