import { findPr, prId, readLedger } from './ledger.mjs';
import { withoutHeader } from '../../tracker/lib/comment-header.mjs';

// The status marks on the comments a step takes (TASK-095): the runner's own reactions around the session, set with no
// model and never by a role (the forge's and the tracker's `markComment`, which no CLI command reaches).
//   - picked up: 👀 (`seen`) on each comment, also when the owner took it off, and the pipeline's earlier result on it
//     taken off;
//   - the step done: `applied` (🚀 on the forge, ✅ on the tracker) or `asked` (😕, ❓) for a comment the session asked
//     back about or didn't take; the step failed: `asked` on each. A step that waits (`busy`) or whose branch moved
//     keeps 👀: the next pickup sets the marks again.
// The state is the ledger's (the handled ids and the version seen), never a reaction's: one a person takes off starts
// nothing, and the next pickup of that comment (an edit) puts 👀 back. A reaction call that fails is a warning; the
// step stays as it ended.
//
// Which comments: on the forge (`forge.reactions`), the `take` of `answerComments` (so only with `forge.triggerWords`);
// on the tracker (`tracker.reactions`), the answers the `answers` step reads: the card's comments after its open
// question that the pipeline didn't post, the owner's (`tracker.owner`) when the settings name one.
//
// How a forge comment ended, from the record alone: `asked` when the record left it out of `handled`; else the
// session's own word, its `handled` entry's `result` (`applied` or `asked`). An entry with none (a record from before
// the field) is read from the rest of the record: `asked` when an item of its reply by number (or of its reply in an
// item's thread) is one the rule asks back, or one a new question of the record's names (`questions[].n`); when the
// entry has no `commit` and the record asked something (a new question, a description question in `asked`, a question
// on the card for the PR); or, for a reviewer's comment, when it has no `commit` (a suggestion or a note for the
// owner). Every other handled comment is `applied`.

const EMOJI = { forge: { seen: '👀', applied: '🚀', asked: '😕' }, tracker: { seen: '👀', applied: '✅', asked: '❓' } };
const same = (a, b) => String(a) === String(b);
const low = (x) => String(x ?? '').replace(/^@/, '').trim().toLowerCase();

// The comments the step takes, marked `seen`; what the end needs to tell how each one ended. Null when the step takes
// none or the settings ask for no marks.
export async function pickMarks({ settings, clients, step }) {
  const key = step.keys?.length === 1 ? step.keys[0] : null;
  const onForge = settings.reactions?.forge && step.stage === 'answerComments' && step.take?.length && step.pr;
  const onCard = settings.reactions?.tracker && step.stage === 'answers';
  if (!key || (!onForge && !onCard)) return null;
  let l;
  try {
    l = readLedger(settings.state, key);
  } catch (e) {
    return { key, warnings: [`no marks: the ledger can't be read: ${e.message}`], forge: null, card: null };
  }
  if (!l) return null;
  const picked = { key, warnings: [], seq: l.seq, handled: (l.reviewComments ?? []).length, questions: (l.questions ?? []).length, forge: null, card: null };
  if (onForge) {
    try {
      const pr = findPr(l, step.pr);
      picked.forge = { repo: pr.repo, number: pr.number, asked: (pr.questions ?? []).length, items: step.take.map((c) => ({ id: c.id, kind: c.kind, by: c.by })) };
    } catch (e) {
      picked.warnings.push(`no marks on ${step.pr}: ${e.message}`);
    }
  }
  if (onCard) {
    try {
      picked.card = await answersOf(settings, clients, l, step);
    } catch (e) {
      picked.warnings.push(`no marks on the card's answers: ${e.message}`);
    }
  }
  await markAll(settings, clients, picked, () => 'seen');
  return picked.forge?.items.length || picked.card?.items.length || picked.warnings.length ? picked : null;
}

// The marks once the step ended: the warnings of the pickup and of these calls, for the run log.
export async function settleMarks({ settings, clients, step, picked, outcome }) {
  if (!picked) return [];
  if (outcome !== 'done' && outcome !== 'failed') return picked.warnings;
  let l = null;
  try {
    l = readLedger(settings.state, picked.key);
  } catch (e) {
    picked.warnings.push(`the ledger can't be read, so each comment is marked as not done: ${e.message}`);
  }
  const forgeEnd = outcome === 'failed' || !l || !picked.forge ? () => 'asked' : forgeEnds(step, picked, l);
  const cardAsked = outcome === 'failed' || !l || (l.questions ?? []).length > picked.questions;
  await markAll(settings, clients, picked, (where, item) => (where === 'forge' ? forgeEnd(item) : cardAsked ? 'asked' : 'applied'));
  return picked.warnings;
}

// The card's comments the `answers` step reads: after the earliest open question (of the step's PR, for one asked
// during the chain), neither posted by the pipeline nor starting with its header, the owner's when the settings name one.
async function answersOf(settings, clients, l, step) {
  const pr = step.pr ? findPr(l, step.pr) : null;
  const open = (l.questions ?? []).filter((q) => !q.answer && (!pr || (q.repo === pr.repo && Number(q.pr) === Number(pr.number))));
  const since = open.map((q) => q.askedAt).filter(Boolean).sort()[0];
  const ref = l.card?.shortLink ?? l.card?.id;
  if (!since || !ref) return { ref, items: [] };
  const posted = new Set((l.posted?.card ?? []).map(String));
  const header = settings.commentHeader;
  const owner = settings.tracker.owner ? low(settings.tracker.owner) : null;
  const card = await clients.tracker.readCard({ card: ref });
  const items = (card.comments ?? [])
    .filter((c) => c.time > since && !posted.has(String(c.id)) && !(header && withoutHeader(c.text, header) !== String(c.text ?? '')) && (!owner || low(c.author?.username) === owner))
    .map((c) => ({ id: c.id }));
  return { ref, items };
}

// How each taken forge comment ended, from what the record left in the ledger (see the head of the file).
function forgeEnds(step, picked, l) {
  let pr;
  try {
    pr = findPr(l, `${picked.forge.repo}#${picked.forge.number}`);
  } catch {
    return () => 'asked';
  }
  const handled = (l.reviewComments ?? []).slice(picked.handled).filter((c) => c.repo === pr.repo && Number(c.pr) === Number(pr.number));
  const known = new Set((step.openQuestions ?? []).map((q) => q.text));
  const fresh = (pr.openQuestions?.seq ?? 0) > picked.seq ? pr.openQuestions.items ?? [] : [];
  const newQuestions = fresh.filter((q) => !known.has(q.text));
  const asked = new Set(newQuestions.filter((q) => q.n !== undefined && q.n !== null).map((q) => Number(q.n)));
  const onCard = (l.questions ?? []).slice(picked.questions).some((q) => q.repo === pr.repo && Number(q.pr) === Number(pr.number));
  const askedSomething = newQuestions.length > 0 || (pr.questions ?? []).length > (picked.forge.asked ?? 0) || onCard;
  const items = (id) => [...(step.replies ?? []).filter((r) => same(r.id, id)).flatMap((r) => r.items ?? []), ...(step.threadReplies ?? []).filter((r) => same(r.id, id))];
  return (item) => {
    const h = handled.findLast((c) => same(c.id, item.id));
    if (!h) return 'asked';
    if (h.result === 'applied' || h.result === 'asked') return h.result;
    if (items(item.id).some((x) => x.do === 'ask' || asked.has(Number(x.n)))) return 'asked';
    if (!h.commit && (askedSomething || item.by === 'reviewer')) return 'asked';
    return 'applied';
  };
}

async function markAll(settings, clients, picked, markOf) {
  const f = picked.forge;
  for (const item of f?.items ?? []) {
    const mark = markOf('forge', item);
    try {
      await clients.forge.markComment({ repo: f.repo, number: f.number, kind: item.kind, id: item.id, mark });
    } catch (e) {
      picked.warnings.push(`${prId(f)}: the ${EMOJI.forge[mark]} on ${item.kind} ${item.id} was not set: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
  const c = picked.card;
  for (const item of c?.items ?? []) {
    const mark = markOf('tracker', item);
    try {
      await clients.tracker.markComment({ card: c.ref, comment: item.id, mark });
    } catch (e) {
      picked.warnings.push(`the card's comment ${item.id}: the ${EMOJI.tracker[mark]} was not set: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
}
