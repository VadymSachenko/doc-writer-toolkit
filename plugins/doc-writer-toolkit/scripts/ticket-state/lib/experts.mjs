// The expert review a person calls (context/ticket-flow.md, "The expert review"). Every PR lands in the owner's queue
// after the `pr` stage, with no reviewer; a person's move of the card to the review status calls the expert of each PR
// that follows the move: the PR's targets' `reviewers` on the forge, and their `cardMembers` on the card. A review a
// person requested on the forge from the owner's queue (row 9) moves the card, and adds the card members only: the
// person already chose who reviews. Nobody is ever removed, from a PR or a card, whichever way the card moves.

const targetsOf = (settings, pr) => {
  const named = (pr.targets ?? []).map((id) => settings.targets.find((t) => t.id === id)).filter(Boolean);
  if (named.length) return named;
  const byRepo = settings.targets.find((t) => t.repo === pr.repo);
  return byRepo ? [byRepo] : [];
};

// The forge logins and the card members of one PR: the union over its targets.
export function expertsOf(settings, pr) {
  const ts = targetsOf(settings, pr);
  return {
    reviewers: [...new Set(ts.flatMap((t) => t.reviewers ?? []))],
    members: [...new Set(ts.flatMap((t) => t.cardMembers ?? []))],
  };
}

// Calls the expert for these PRs on these cards: the reviewers asked (unless `request` is false; those already asked
// are left alone by the forge), then each card member added (one already on a card is no change). Idempotent, so a run
// stopped halfway does it again in full.
export async function callExperts({ settings, clients, prs, cards, request = true }) {
  const done = { requested: [], members: [] };
  for (const pr of prs) {
    const { reviewers } = expertsOf(settings, pr);
    if (request && pr.number && reviewers.length) {
      const r = await clients.forge.requestReviewers({ repo: pr.repo, number: pr.number, logins: reviewers });
      done.requested.push(...(r.requested ?? []));
    }
  }
  const members = [...new Set(prs.flatMap((pr) => expertsOf(settings, pr).members))];
  for (const card of cards) {
    for (const member of members) {
      const r = await clients.tracker.addMember({ card, member });
      if (r.changed) done.members.push(member);
    }
  }
  return done;
}

// The same, as the calls a dry run lists.
export function expertCalls(settings, prs, cards, { request = true } = {}) {
  const out = [];
  for (const pr of prs) {
    const { reviewers } = expertsOf(settings, pr);
    if (request && pr.number && reviewers.length) out.push(`forge request-reviewers --repo ${pr.repo} --number ${pr.number} ${reviewers.map((r) => `--reviewer ${r}`).join(' ')}`);
  }
  const members = [...new Set(prs.flatMap((pr) => expertsOf(settings, pr).members))];
  for (const card of cards) for (const m of members) out.push(`tracker add-member ${card} --member ${m}`);
  return out;
}

// The comment a PR gets each time it enters the expert's review (D-082): the settings' `reviewComment`, with the PR's
// Files changed link. The same text is what the report gives the owner to send a quiet expert. Null with no PR link or
// no `reviewComment` set.
export function reviewCommentFor(settings, url) {
  if (!url || !settings.reviewComment) return null;
  return settings.reviewComment.replaceAll('<files>', `${String(url).replace(/\/+$/, '')}/files`);
}

// Posts it once per entry: none when one with the same first line is already there since `since` (the run that posted it
// stopped before its record). Gives the comment's id, posted or found, for the record's `posted`, so the pipeline never
// reads it as the owner's: it posts from the owner's login.
export async function postReviewComment({ settings, clients, pr, url, since }) {
  const body = reviewCommentFor(settings, url);
  if (!body || !pr.number) return null;
  const c = await clients.forge.comment({ repo: pr.repo, number: pr.number, body, unlessHeader: body.split('\n')[0], ...(since ? { since } : {}) });
  return c.id ?? c.existing ?? null;
}
