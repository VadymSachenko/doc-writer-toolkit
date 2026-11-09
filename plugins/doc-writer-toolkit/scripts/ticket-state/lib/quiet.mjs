import { prId } from './ledger.mjs';
import { unhandled } from './world.mjs';

// The start rule for comments on a pipeline PR (D-126), held at the watcher's hand-on (lib/watch.mjs), not in the rule:
// the rule says a ticket has comments to answer; this says when the session for them starts.
//   - A submitted review is a batch: its session starts at once. A review is a batch when it has text of its own, gives
//     a verdict (approved, changes requested) or holds more than one line comment.
//   - Single comments (a conversation comment, a line comment added on its own, a reply in a thread) start a session
//     once the newest of them is `schedule.commentQuietMinutes` old with no newer one, the owner's and a reviewer's
//     alike. Three comments 30 s apart start one session, not three.
//   - A comment that arrives while a session for the ticket runs waits for the next session (the ticket's lock), as
//     before.
// A review not yet submitted is never read: the forge leaves out a draft review and its comments (forge adapter).

const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED']);
const timeOf = (c) => Date.parse(c.updatedAt ?? c.submittedAt ?? c.createdAt ?? '') || 0;

export const quietMsOf = (settings) => Math.round((settings.schedule.commentQuietMinutes ?? 2) * 60000);

// One PR's unhandled comments (lib/world.mjs `unhandled`) against the rule, with the activity they came from. Gives
// { ready, why, newest, dueAt } (ms), or null when nothing is unhandled.
export function startRule(items, activity, { now, quietMs }) {
  if (!items.length) return null;
  const lineCounts = new Map();
  const reviewOf = new Map();
  for (const t of activity.threads ?? []) {
    for (const c of t.comments ?? []) {
      if (c.reviewId === null || c.reviewId === undefined) continue;
      reviewOf.set(String(c.id), String(c.reviewId));
      lineCounts.set(String(c.reviewId), (lineCounts.get(String(c.reviewId)) ?? 0) + 1);
    }
  }
  const batches = new Set(
    (activity.reviews ?? [])
      .filter((r) => String(r.body ?? '').trim() || VERDICTS.has(r.state) || (lineCounts.get(String(r.id)) ?? 0) > 1)
      .map((r) => String(r.id)),
  );
  const batch = items.find((c) => (c.kind === 'review' && batches.has(String(c.id))) || (c.kind === 'review-comment' && batches.has(reviewOf.get(String(c.id)))));
  const newest = Math.max(...items.map(timeOf));
  if (batch) return { ready: true, why: 'a submitted review', newest, dueAt: now };
  const dueAt = newest + quietMs;
  return now >= dueAt ? { ready: true, why: `quiet since ${new Date(newest).toISOString()}`, newest, dueAt } : { ready: false, why: `a comment at ${new Date(newest).toISOString()}: waits for quiet`, newest, dueAt };
}

// The rule for one ticket: its open PRs (only `prIds` when given) read from the forge, their unhandled comments put to
// `startRule`. Ready when one PR is; otherwise it waits until the earliest PR's quiet ends. `comments: 0` when nothing
// is unhandled (the comments were answered, or there were none).
export async function commentWait({ settings, clients, ledger, prIds = null, now, quietMs = quietMsOf(settings) }) {
  const looks = [];
  for (const p of ledger.prs ?? []) {
    if (!p.number || p.merged) continue;
    if (prIds && !prIds.includes(prId(p))) continue;
    const activity = await clients.forge.prActivity({ repo: p.repo, number: p.number });
    if (activity.pr?.state && activity.pr.state !== 'open') continue;
    const items = unhandled(ledger, p, activity, settings.forge.self, settings.commentHeader);
    const r = startRule(items, activity, { now, quietMs });
    if (r) looks.push({ pr: prId(p), comments: items.length, ...r });
  }
  if (!looks.length) return { ready: false, comments: 0, prs: [], dueAt: null, why: 'no comment to answer' };
  const comments = looks.reduce((n, l) => n + l.comments, 0);
  const ready = looks.find((l) => l.ready);
  if (ready) return { ready: true, comments, prs: looks.map((l) => l.pr), dueAt: now, why: `${ready.pr}: ${ready.why}` };
  const first = looks.reduce((a, b) => (b.dueAt < a.dueAt ? b : a));
  return { ready: false, comments, prs: looks.map((l) => l.pr), dueAt: first.dueAt, why: `${first.pr}: ${first.why}` };
}

// The wait list in the feed (`commentWaits`): { <key>: { prs, dueAt, why, since } }. Due entries are looked at by the
// next check of either kind, with no event needed: a quiet PR has none.
export const dueWaits = (waits, now) => Object.entries(waits ?? {}).filter(([, w]) => Date.parse(w.dueAt) <= now).map(([k]) => k);
