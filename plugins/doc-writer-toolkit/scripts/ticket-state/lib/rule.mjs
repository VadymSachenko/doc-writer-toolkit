import { CARD_STATUS_OF, CHAIN, IN_PROGRESS, PR_ORDER, PR_STAGE_OF_STATUS, ROLE_OF, WAITING } from './stages.mjs';
import { prId } from './ledger.mjs';
import { editsOf, mergedEdits, nextEditNumber, parseReply, parseThreadReply, resolveReply, resolveThreadReply, suggestionOf } from './edits.mjs';
import { IMAGE } from './world.mjs';
import { parseStartHours } from './settings.mjs';
import { companyReposOn } from './company-repos.mjs';
import { heldPending, passGaveUp } from './answer-pass.mjs';

// The next-step rule of the ticket flow (context/ticket-flow.md, "The rule"). A pure function of a ledger and what the
// tracker, the forge, git and the files show now: the world wins over the ledger. First match wins:
//
//    1 a live lock on the group                       locked; nothing
//    2 mode hand                                      the derived state; nothing; reported
//    3 the card archived, gone, or outside the flow   outside; reported
//    4 every PR merged                                merged; close
//    5 a PR closed unmerged                           outside; reported
//    6 the card's list differs from left.list        a person moved it: follow the move
//    7 a stage recorded running, no live lock         interrupted; run it again
//    8-12 per PR: a hand edit, or a UA change after ready for merge (back to the owner's queue); finalReview with a new
//         review requested; new comments; a hand edit of UA no style check read (styleCheck); smeReview with a reviewer's
//         approval since it entered the review (to finalReview); translation: the first chain stage not done for the
//         head, or after ready for merge the re-sync of the whole range since the ready head
//         With `forge.keepFresh`, from ready for merge on (D-113, D-127): the base merged into the branch when it moved
//         (`baseMerge`, the runner's), a conflict resolved by a session (`baseFix`), and ready for merge only once CI
//         passed on the head
//   13 videoGate                                      the automatic try (uploads, then fetches), the fallback, or
//                                                     the frame sweep and the import
//   14 ready and a free slot                          start (the `startable` groups, see limits.mjs)
//   15 otherwise                                      the state's own next step
//
// Over every row: a step whose last session failed runs again only after a person acted on the ticket (a move, a
// comment, a review, a hand commit) or the owner re-armed it with `set`; until then it waits for the next morning run,
// and after two failed sessions with no such action between them the ticket is held for the owner. A ready ticket's
// failed start (row 14) is held or waits the same way.

export const step = (stage, extra = {}) => ({ stage, role: ROLE_OF[stage] ?? null, ...extra });

// The start of a ticket whose card is in work, with its origin (`startedBy`, which the brief passes on). The runner
// records a start before its session, with its origin: such a start goes on as it was started (`again`). With no start
// recorded, or after a start whose failed session left the card in the ready status, a person took the card into work
// by hand: a manual start, out of the limits for the ticket's whole life (`byHand`).
const startStep = (l, extra = {}) => (l.stages?.start && l.startedBy && !failedInReady(l) ? step('start', { again: true, startedBy: l.startedBy, ...extra }) : step('start', { byHand: true, startedBy: 'manual', ...extra }));

// The ticket's last session was a start that failed with the card still where the ledger left it, in the ready status
// (the failure's mark shows it): whoever took the card into work since was a person, not that start. A start recorded
// after that failure (a retry, whose session may have moved the card and died before its run) is that retry's.
function failedInReady(l) {
  const last = (l.runs ?? []).at(-1);
  return last?.stage === 'start' && last.outcome === 'failed' && Boolean(last.after?.list) && l.left?.status === 'ready' && last.after.list === l.left.list?.id && last.seq >= (l.stages?.start?.seq ?? 0);
}

// A start recorded but not done whose card is still in the ready status: the start didn't happen (its session failed
// or died before the move), so the ticket is still ready.
const startNotMoved = (l, status) => l.stage === 'start' && Boolean(l.stages?.start) && l.stages.start.status !== 'done' && status === 'ready';

const rank = (stage) => PR_ORDER.indexOf(stage);
const dayOf = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// The ticket-level stages a ticket goes through before its PRs open, in order. A stage counts as done after another
// when its record was made later (`seq`).
const doneAfter = (l, stage, after) => l.stages?.[stage]?.status === 'done' && (!after || (l.stages?.[after]?.status === 'done' && l.stages[stage].seq > l.stages[after].seq));

// A chain stage or a re-sync left running on a PR that isn't at `translation` now (an old ledger, a person's move back,
// a re-sync the earlier rule started at ready for merge) waits for a person's move like the rest of the chain: no
// session starts for it. So does a merge of the base, or its conflict's session, left running on a PR that isn't at
// ready for merge now (D-127: the owner moved it back, and edits the branch there).
const FRESH_STAGES = ['baseMerge', 'baseFix'];
function runningStage(l) {
  for (const [stage, rec] of Object.entries(l.stages ?? {})) if (rec?.status === 'running') return { stage };
  for (const pr of l.prs ?? []) {
    for (const [stage, rec] of Object.entries({ ...(pr.chain ?? {}), ...(pr.steps ?? {}) })) {
      const resumes = FRESH_STAGES.includes(stage) ? pr.stage === 'readyForMerge' : (!CHAIN.includes(stage) && stage !== 'resync') || pr.stage === 'translation';
      if (rec?.status === 'running' && resumes) return { stage, pr: prId(pr) };
    }
  }
  return null;
}

// Where a ticket is before its PRs open: from the last ticket-level record.
function phaseOf(l) {
  const last = l.stage;
  const rec = last ? l.stages?.[last] : null;
  if (l.stages?.pr?.status === 'done') return 'prs';
  if (last === 'questions' && rec?.status === 'done') return 'questions';
  if (last === 'planGate' && rec?.status === 'done') return 'planGate';
  if (['videoGate', 'videoTry', 'videoBlock', 'videoExtract'].includes(last) && l.stages?.videoGate?.status === 'done') return 'videoGate';
  // A pass on the questions the plan held, with the plan not done yet: still planning.
  if (last === 'answerPass' && l.heldQuestions?.from === 'plan' && l.stages?.plan?.status !== 'done') return 'planning';
  if (l.stages?.write?.status === 'done' || ['write', 'uaReview', 'answerPass', 'pr'].includes(last)) return 'writing';
  if (['start', 'plan', 'answers', 'planApproval', 'videoImport'].includes(last)) return 'planning';
  return 'card';
}

// The next writer or reviewer stage before the PR: plan, then write, then the UA review, then the answer pass (with
// `companyRepos`, TASK-105), then the PR. With no `companyRepos`, no pass: the PR follows the UA review, as before, and
// `notes` says so.
function preparationStep(l, settings, notes = []) {
  if (l.stages?.plan?.status !== 'done') return l.stages?.start?.status === 'done' ? step('plan') : startStep(l);
  const resumed = ['answers', 'planApproval', 'videoImport'].filter((s) => l.stages?.[s]?.status === 'done').map((s) => l.stages[s].seq);
  const lastResume = resumed.length ? Math.max(...resumed) : 0;
  const writeRec = l.stages?.write;
  if (!writeRec || writeRec.status !== 'done' || writeRec.seq < lastResume) return step('write');
  if (!doneAfter(l, 'uaReview', 'write')) return step('uaReview');
  if (companyReposOn(settings) && passGaveUp(l)) {
    // The pass after this UA review failed (lib/answer-pass.mjs, `passFailed`): the PR follows the UA review with what
    // the write left, as with no pass, so nothing waits on it.
    if (!doneAfter(l, 'pr', 'uaReview')) {
      notes.push('the answer pass failed after the UA review, so the PR follows the UA review with what the write left open');
      return step('pr');
    }
    return null;
  }
  if (companyReposOn(settings)) {
    if (!doneAfter(l, 'answerPass', 'uaReview')) return step('answerPass');
    if (!doneAfter(l, 'pr', 'answerPass')) return step('pr');
    return null;
  }
  if (!doneAfter(l, 'pr', 'uaReview')) {
    notes.push('no answer pass: the host sets no companyRepos, so the PR follows the UA review as before');
    return step('pr');
  }
  return null;
}

const GATES = {
  needsInfo: { who: 'team', why: 'a person removes the needs-info label' },
  questions: { who: 'owner', why: 'answers on the card, then the card back to In progress' },
  planGate: { who: 'owner', why: 'the section plan: moving the card back approves it' },
  reworkWait: { who: 'owner', why: 'a person moved the card back to In progress' },
  smeReview: { who: 'reviewer', why: "the review: the expert's Approve moves the card to the owner's queue, and so does a person" },
  finalReview: { who: 'owner', why: "the owner's read of the UA: comments first, then the card to In translation, or to the review status to call the expert" },
  readyForMerge: { who: 'owner', why: 'the final edit and the merge' },
  ownerBlock: { who: 'owner', why: "the owner's own block" },
  paused: { who: 'owner', why: 'a person moved the card back to the ready status' },
  outside: { who: 'owner', why: 'the card or a PR left the flow' },
  hand: { who: 'owner', why: 'mode hand: the pipeline only observes until `ticket-state handover`' },
};

// The status of one ticket. `w`: { now (ms), card (the tracker's card, null when gone), lock, prWorld (Map
// `<key>/<pr id>` -> the forge's view), git (makeGit), settings, fileExists(rel) }.
export function deriveTicket(l, w) {
  const d = derive(l, w);
  const card = w.card;
  const t = {
    key: l.key,
    group: l.group,
    ledger: 'present',
    priority: card?.priority ?? l.priority ?? 'medium',
    createdAt: card?.createdAt ?? l.card?.createdAt ?? null,
    mode: l.mode,
    startedBy: l.startedBy,
    stage: l.stage,
    card: card ? { id: card.id, shortLink: card.shortLink, url: card.url, name: card.name, status: card.status, list: card.list?.name ?? null } : null,
    state: d.state,
    next: null,
    steps: d.steps,
    gate: d.gate ?? GATES[d.state] ?? null,
    mismatch: d.mismatch,
    notes: d.notes,
    prs: d.prs,
    counts: IN_PROGRESS.includes(d.state) ? 'inProgress' : WAITING.includes(d.state) ? 'waiting' : null,
    counted: false,
    locked: false,
  };
  t.counted = Boolean(t.counts) && l.mode === 'pipeline' && l.startedBy === 'schedule';
  // Row 2: a ticket in the owner's hands is observed only.
  if (l.mode === 'hand') {
    t.steps = [];
    t.gate = GATES.hand;
    t.hand = true;
  }
  // Row 1: a live lock. It still counts as what it is doing.
  if (w.lock?.live) {
    t.locked = true;
    t.lock = { kind: w.lock.kind ?? null, stage: w.lock.stage ?? null, expiresAt: w.lock.expiresAt ?? null };
    t.derivedState = t.state;
    t.state = 'locked';
    t.steps = [];
  }
  // The failed step's gate, after every row (row 6 resumes the same move at every call, so no row can hold it alone).
  // A ready ticket's step is its start, which the start loop runs (row 14): its failed start is held or waits the same
  // way, and `startable` (lib/limits.mjs) reads it from `failed` and `held`.
  const pending = t.steps.length ? t.steps : d.state === 'ready' && !t.hand && !t.locked ? [step('start')] : [];
  const failed = failedStep(l, w, pending);
  if (failed) {
    t.failed = failed;
    if (failed.held) {
      t.steps = [];
      t.gate = { who: 'owner', why: `${heldWhy(failed)}: a comment on the card or the PR gives it one more try (so do a review, a commit, a move of the card, or \`ticket-state set retry ${l.key}\`)` };
      t.held = true;
    } else if (!failed.acted && t.steps.length) t.steps[0] = { ...t.steps[0], prior: failed.sessions, waits: 'a person acting on the ticket, or the next morning run' };
  }
  // A cap on the sessions of one stage a day, whatever the cause of a loop: beyond it, held for the owner until tomorrow.
  const capped = !t.held && cappedStep(l, w, pending);
  if (capped) {
    t.capped = capped;
    t.steps = [];
    t.gate = { who: 'owner', why: `${capped.stage}${capped.pr ? ` on ${capped.pr}` : ''} ran ${capped.sessions} sessions today (limits.sessionsPerStageDay): held until tomorrow, or \`ticket-state set retry ${l.key}\`` };
    t.held = true;
  }
  if (w.mark) t.mark = markOf(l, w);
  for (const p of t.prs) if (t.locked || t.hand || t.held) p.next = null;
  t.next = t.steps[0] ?? null;
  return t;
}

// ------------------------------------------------------------------ a failed step

// What a person can change on a ticket, as the runner sees it right after a failed session: the card's list and
// comments, and per PR its head, the commits the pipeline didn't make and the comments no record handled. Taken after
// the session ended, so whatever that session wrote without recording it is part of the mark, not a person's action.
export function markOf(l, w) {
  const prs = {};
  for (const pr of l.prs ?? []) {
    const world = pr.number ? w.prWorld?.get(`${l.key}/${prId(pr)}`) : null;
    if (!world) continue;
    prs[prId(pr)] = { head: world.headCommit ?? null, hand: handCommits(pr, world.headCommit, w), comments: (world.newComments ?? []).map((c) => String(c.id)) };
  }
  const moves = w.cardMoves ? { lastMove: w.cardMoves.map((m) => m.time).filter(Boolean).sort().at(-1) ?? null } : {};
  return { at: new Date(w.now).toISOString(), list: w.card?.list?.id ?? null, ...moves, comments: w.cardComments ? w.cardComments.map((c) => String(c.id)) : null, prs };
}

// What a person did on the ticket after a mark, or null. The pipeline's own writes never count: its recorded comments
// are in `posted`, its recorded commits in `pipelineCommits`, and what a failed session wrote is in the mark.
export function actedAfter(l, w, mark) {
  if (w.rearmedAt && w.rearmedAt > Date.parse(mark.at)) return 'the owner re-armed it with `ticket-state set retry`';
  if (mark.list && w.card?.list?.id && w.card.list.id !== mark.list) return 'a person moved the card';
  // A move there and back leaves the list as it was: the card's own moves (the tracker's times) show it.
  if ('lastMove' in mark && w.cardMoves?.some((m) => m.time && (!mark.lastMove || m.time > mark.lastMove))) return 'a person moved the card';
  if (mark.comments && w.cardComments) {
    const posted = new Set((l.posted?.card ?? []).map(String));
    if (w.cardComments.some((c) => !mark.comments.includes(String(c.id)) && !posted.has(String(c.id)))) return 'a person commented on the card';
  }
  for (const pr of l.prs ?? []) {
    const m = mark.prs?.[prId(pr)];
    const world = pr.number ? w.prWorld?.get(`${l.key}/${prId(pr)}`) : null;
    if (!m || !world) continue;
    if ((world.newComments ?? []).some((c) => !m.comments.includes(String(c.id)))) return `a comment or review on ${prId(pr)}`;
    const hand = handCommits(pr, world.headCommit, w);
    const committed = hand && m.hand ? hand.some((sha) => !m.hand.includes(sha)) : Boolean(world.headCommit && m.head && world.headCommit !== m.head);
    if (committed) return `a commit on ${prId(pr)}`;
  }
  return null;
}

// The ticket's last session, when it failed at the stage the ticket would run now: how many sessions failed in a row,
// and whether a person acted since the last of them. A session that ended on a busy lock (`busy`), or on a branch a
// person moved under it (`moved`), is neither a failure nor a success: the one before it counts. A run of the runner's
// own build (`script`) counts as a run with no session.
const PASSING = new Set(['busy', 'moved']);
function failedStep(l, w, steps) {
  const last = (l.runs ?? []).findLast((r) => !PASSING.has(r.outcome));
  const s = steps[0];
  if (!s || last?.outcome !== 'failed' || !last.after || last.stage !== s.stage || (last.pr ?? null) !== (s.pr ?? null)) return null;
  // `sessions`: the failures in a row, a session's or not (the runner's count).
  const sessions = last.failures ?? 1;
  const acted = actedAfter(l, w, last.after);
  // A failure with no session (no `start`: a worktree that couldn't be made or was stuck) says so, with its reason. So
  // do the earlier failures of the row that had none: a stuck worktree, then a failed session, is two failures and one
  // session.
  const row = (l.runs ?? []).filter((r) => !PASSING.has(r.outcome)).slice(-sessions).filter((r) => r.outcome === 'failed' && r.stage === last.stage && (r.pr ?? null) === (last.pr ?? null));
  const withoutSession = row.filter((r) => !r.start || r.script).length;
  return { stage: last.stage, ...(last.pr ? { pr: last.pr } : {}), at: last.after.at, sessions, ...(withoutSession ? { withoutSession } : {}), ...(last.start && !last.script ? {} : { noSession: String(last.note ?? 'no session started') }), ...(last.script ? { script: true } : {}), ...(acted ? { acted } : { held: sessions >= 2 }) };
}

const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

// Why a failed step is held, in words that count its failures right: "in N sessions" only when each failure was a
// session's.
function heldWhy(failed) {
  const where = `${failed.stage}${failed.pr ? ` on ${failed.pr}` : ''}`;
  if (failed.script) return `${where} failed ${times(failed.sessions)} with no one acting in between, the last time in the runner's own ${failed.stage === 'baseMerge' ? 'merge of the base' : 'build'} (${failed.noSession.slice(0, 200)})`;
  if (failed.noSession) return `${where} failed ${times(failed.sessions)} with no one acting in between, the last time before any session started (${failed.noSession.slice(0, 200)})`;
  if (failed.withoutSession) return `${where} failed ${times(failed.sessions)} with no one acting in between, ${times(failed.withoutSession)} before any session started`;
  return `${where} failed in ${failed.sessions} sessions with no one acting in between`;
}

// The sessions the ticket's next step already had today (since a `set retry`, if later), when they reach the cap.
function cappedStep(l, w, steps) {
  const s = steps[0];
  const cap = w.settings.limits?.sessionsPerStageDay;
  if (!s?.role || !cap) return null;
  const today = dayOf(w.now);
  const runs = (l.runs ?? []).filter((r) => r.start && r.stage === s.stage && (r.pr ?? null) === (s.pr ?? null) && dayOf(Date.parse(r.start)) === today && !(w.rearmedAt && Date.parse(r.start) <= w.rearmedAt));
  return runs.length >= cap ? { stage: s.stage, ...(s.pr ? { pr: s.pr } : {}), sessions: runs.length } : null;
}

// The commits on a PR's branch the pipeline didn't make (neither in pipelineCommits nor from the base), or null when
// git here can't tell.
function handCommits(pr, head, w) {
  const target = w.settings.targets.find((t) => t.id === pr.targets?.[0]) ?? w.settings.targets.find((t) => t.repo === pr.repo);
  const onBranch = w.git?.branchCommits(target, head, pr.base ?? target?.base ?? 'main') ?? null;
  if (onBranch === null) return null;
  const mine = (sha) => (pr.pipelineCommits ?? []).some((c) => c && sha.startsWith(String(c)));
  return onBranch.filter((sha) => !mine(sha));
}

// A colleague's comment the trigger words keep from the pipeline (lib/world.mjs `sortComments`): for the owner, with a
// link to it, to hand on or leave.
const ANCHOR = { comment: 'issuecomment', 'review-comment': 'discussion_r', review: 'pullrequestreview' };
function othersEntry(c, url) {
  return { id: c.id, kind: c.kind, author: c.author ?? null, at: c.updatedAt ?? null, link: url ? `${String(url).replace(/\/+$/, '')}#${ANCHOR[c.kind] === 'discussion_r' ? `discussion_r${c.id}` : `${ANCHOR[c.kind]}-${c.id}`}` : null };
}

function derive(l, w) {
  const out = { state: null, steps: [], gate: null, mismatch: [], notes: [], prs: [] };
  const card = w.card;
  const status = card?.status ?? null;

  const prs = (l.prs ?? []).map((pr) => {
    const world = pr.number ? w.prWorld?.get(`${l.key}/${prId(pr)}`) ?? null : null;
    const merged = Boolean(pr.merged) || world?.state === 'merged';
    return { pr, world, merged, closed: world?.state === 'closed', stage: merged ? 'merged' : pr.stage };
  });
  out.prs = prs.map((p) => ({ id: prId(p.pr), repo: p.pr.repo, number: p.pr.number, url: p.pr.url ?? p.world?.url ?? null, review: p.pr.review, stage: p.stage, state: p.merged ? 'merged' : p.world?.state ?? null, labels: p.world?.labels ?? null, head: p.world?.headCommit ?? null, expertReview: p.pr.expertReview ?? null, smeSince: p.pr.smeSince ?? (l.left?.status === 'smeReview' && p.stage === 'smeReview' ? l.left.at ?? null : null), reviewerAt: p.world?.reviewerAt ?? null, expertApproval: p.pr.expertApproval ?? null, ...(p.world?.others?.length ? { others: p.world.others.map((c) => othersEntry(c, p.pr.url ?? p.world.url)) } : {}), next: null }));
  const view = (p) => out.prs.find((x) => x.id === prId(p.pr));

  if (l.stages?.close?.status === 'done') {
    out.state = 'closed';
    return out;
  }
  // Row 3.
  if (!card || card.closed || status === null) {
    out.state = 'outside';
    out.notes.push(!card ? 'the card is gone' : card.closed ? 'the card is archived' : `the card is in '${card.list?.name ?? card.list?.id}', a list outside the flow`);
    return out;
  }
  const opened = prs.filter((p) => p.pr.number);
  // Row 4.
  if (opened.length && opened.length === prs.length && prs.every((p) => p.merged)) {
    out.state = 'merged';
    out.steps.push(step('close'));
    return out;
  }
  // Row 5.
  const closedPr = opened.find((p) => p.closed && !p.merged);
  if (closedPr) {
    out.state = 'outside';
    out.notes.push(`${prId(closedPr.pr)} was closed unmerged`);
    return out;
  }
  // Row 6.
  if (l.left?.list?.id && card.list?.id !== l.left.list.id) return personMoved(l, w, out, prs);
  // Row 14 before row 7: a start whose card never left the ready status is still ready, running or failed.
  if (startNotMoved(l, status)) {
    out.state = hasLabel(card, w.settings.intake?.needsInfoLabel) ? 'needsInfo' : 'ready';
    return out;
  }
  // Row 7.
  const running = runningStage(l);
  if (running) {
    out.state = stateOf(l, prs, status);
    out.steps.push(running.stage === 'start' && !running.pr ? startStep(l, { interrupted: true }) : step(running.stage, { ...(running.pr ? { pr: running.pr } : {}), interrupted: true }));
    return out;
  }

  const phase = phaseOf(l);
  out.state = stateOf(l, prs, status, phase);
  if (out.state === 'ready' && hasLabel(card, w.settings.intake?.needsInfoLabel)) out.state = 'needsInfo';

  // Rows 8 to 12, each PR on its own.
  if (phase === 'prs') {
    const least = Math.min(...prs.map((p) => rank(p.stage)));
    for (const p of prs) {
      if (!p.pr.number || p.merged) continue;
      const s = prStep(l, p, w, out, prs);
      if (s) {
        view(p).next = s;
        out.steps.push(s);
      }
    }
    // The card stands where the least advanced PR is. If the pipeline left it elsewhere, it moves it. Back from In
    // translation with every PR ready for merge: the chain is done, and the card says so.
    const expected = CARD_STATUS_OF[PR_ORDER[least]];
    // Never into In translation by itself: only a person's move (or the other card of the same PR, lib/runner.mjs) goes there.
    // A PR's own move takes the card where it belongs, so the card isn't moved first (nor said ready when a PR goes back
    // to the owner's queue).
    if (expected && expected !== status && expected !== 'translation' && card.list?.id === l.left?.list?.id && !out.steps.some((s) => s.stage === 'move')) {
      out.steps.unshift(step('move', { to: expected, card: true, ...(status === 'translation' && PR_ORDER[least] === 'readyForMerge' ? { ready: true } : {}) }));
    }
    // A place from the code with no reference at a commit: its comment is posted, so the record stood; it is reported.
    for (const p of prs) {
      const missing = (l.places ?? []).filter((x) => x.noRef && x.repo === p.pr.repo && Number(x.pr) === Number(p.pr.number)).map((x) => x.id);
      if (missing.length) out.mismatch.push(`${prId(p.pr)}: ${missing.length} place(s) from the code with no reference at a commit: ${missing.join(', ')}`);
    }
    return out;
  }

  // Row 13.
  if (phase === 'videoGate') return videoGate(l, w, out, status);

  // Row 15 (row 14 is the startable groups).
  if (phase === 'planning' || phase === 'writing') {
    // The questions the plan or the write held for the answer pass (TASK-105) go to it before anything else.
    const s = companyReposOn(w.settings) && heldPending(l) ? step('answerPass', { held: true }) : preparationStep(l, w.settings, out.notes);
    if (s) out.steps.push(s);
  }
  return out;
}

// The ticket's state: the least advanced PR's once PRs exist; else the phase, or the card's status.
function stateOf(l, prs, status, phase = phaseOf(l)) {
  if (phase === 'prs') {
    const stages = prs.map((p) => p.stage);
    if (stages.every((s) => s === 'merged')) return 'merged';
    return PR_ORDER[Math.min(...stages.map(rank))];
  }
  if (phase === 'questions' || phase === 'planGate' || phase === 'videoGate' || phase === 'planning' || phase === 'writing') return phase;
  return cardState(l, status);
}

const norm = (name) => String(name ?? '').replace(/\u200c/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const hasLabel = (card, name) => Boolean(name) && (card?.labels ?? []).some((x) => norm(x.name) === norm(name));

function cardState(l, status) {
  if (status === 'intake') return 'new';
  if (status === 'ready') return 'ready';
  if (status === 'done' || status === 'outOfScope') return 'closed';
  if (status === 'blocked') return 'ownerBlock';
  return 'planning';
}

// Row 6: a person moved the card. The pipeline follows: the PRs at the card's stage take the new stage and its label
// (on every move, a person's too), and a card back from Blocked resumes where the ticket stopped.
function personMoved(l, w, out, prs) {
  const from = l.left.status;
  const to = w.card.status;
  out.notes.push(`a person moved the card from '${l.left.list?.name ?? from}' to '${w.card.list?.name ?? to}'`);
  const phase = phaseOf(l);
  if (to === 'done' || to === 'outOfScope') {
    out.state = 'closed';
    out.steps.push(step('follow', { to }));
    return out;
  }
  if (to === 'ready' || to === 'intake') {
    out.state = 'paused';
    return out;
  }
  if (to === 'blocked') {
    out.state = 'ownerBlock';
    return out;
  }
  if ((from === 'ready' || from === 'intake') && to === 'inProgress') {
    // A person took the card into work by hand: a manual start, out of the limits for the ticket's whole life. A card
    // the runner's own start session moved goes on as that start; one a person moved after that start failed with the
    // card still in the ready status is a manual start too.
    out.state = 'planning';
    out.steps.push(startStep(l));
    return out;
  }
  if (from === 'blocked' && to === 'inProgress') {
    const asked = prs.find((p) => p.stage === 'questions');
    if (asked) {
      out.state = stateOf(l, prs, to, phase);
      out.steps.push(step('answers', { pr: prId(asked.pr) }));
    } else if (phase === 'planGate') {
      // Moving the card back approves the plan with the gate's hash; a plan file changed since is a new gate.
      const sp = l.plan?.sectionPlan;
      const changed = Boolean(sp?.file && w.fileHash && w.fileHash(sp.file) !== sp.hash);
      out.state = 'planning';
      out.steps.push(changed ? step('planGate', { changed: true }) : step('planApproval'));
    } else if (phase === 'videoGate') {
      const missing = missingParts(l, w);
      out.state = 'planning';
      if (missing.length) {
        out.notes.push(`went on without the video: ${missing.length} part(s) had no transcript when the card came back`);
        out.steps.push(step('answers', { withoutVideo: true }));
      } else out.steps.push(importStep(l));
    } else if (phase === 'questions') {
      out.state = 'planning';
      out.steps.push(step('answers'));
    } else {
      // The owner's own block lifted: note the move and go on where the ticket stopped.
      out.state = stateOf(l, prs, to, phase === 'card' ? 'planning' : phase);
      out.steps.push(step('follow', { to }));
    }
    return out;
  }
  out.state = ['finalReview', 'translation', 'smeReview'].includes(to) ? to : to === 'inProgress' ? 'reworkWait' : stateOf(l, prs, to, phase);
  // A move to In translation also takes a ready PR whose head moved only by the owner's own commits since it was marked
  // ready (a hand edit the rule had no time to send back): the owner read what they wrote. A commit of the pipeline's
  // in that range (an answer to a comment, pushed while the owner moved the card) is not read yet: that PR stays, and
  // row 8 sends it back to the owner's queue.
  const takeReady = to === 'translation' ? prs.map((p) => ownEditsSinceReady(l, p, w)).filter(Boolean) : [];
  out.steps.push(step('follow', { to, ...(PR_STAGE_OF_STATUS[to] ? { prStage: PR_STAGE_OF_STATUS[to] } : {}), ...(takeReady.length ? { takeReady } : {}) }));
  return out;
}

// A model session on the PR since it was marked ready, done or failed, may have pushed what no record names (an answer
// whose record failed): then the change isn't known to be the owner's alone, and the PR is not taken.
function ownEditsSinceReady(l, p, w) {
  const { pr, world } = p;
  const ready = pr.readyForMerge?.at(-1);
  const head = world?.headCommit;
  if (!pr.number || p.merged || p.stage !== 'readyForMerge' || !ready?.head || !head || head === ready.head) return null;
  const after = (r) => (ready.seq !== undefined && r.seq !== undefined ? r.seq > ready.seq : String(r.start ?? r.at ?? '') > String(ready.at ?? ''));
  if ((l.runs ?? []).some((r) => r.role && r.pr === prId(pr) && after(r))) return null;
  const target = w.settings.targets.find((t) => t.id === pr.targets?.[0]) ?? w.settings.targets.find((t) => t.repo === pr.repo);
  const commits = w.git?.commitsBetween?.(target, ready.head, head) ?? null;
  const mine = (sha) => (pr.pipelineCommits ?? []).some((c) => c && sha.startsWith(String(c)));
  return commits?.length && !commits.some(mine) ? { pr: prId(pr), head } : null;
}

// Rows 8 to 12 for one PR. First match wins.
function prStep(l, p, w, out, prs) {
  const { pr, world } = p;
  const id = prId(pr);
  if (!world) {
    out.notes.push(`${id}: not read from the forge`);
    return null;
  }
  const target = w.settings.targets.find((t) => t.id === pr.targets?.[0]) ?? w.settings.targets.find((t) => t.repo === pr.repo);
  const head = world.headCommit;
  // How far behind its base the PR is, for `status` and the report (`forge.keepFresh`).
  if (w.settings.keepFresh) out.prs.find((x) => x.id === id).behind = w.git?.behind?.(target, head, baseOf(pr, target), world.baseCommit ?? null) ?? null;
  // The translated label (`forge.translatedLabel`), at any stage: UA changed in words since the head it was put on for
  // (a page, not an image; not an id-only change, not the runner's own id commit) takes it off, with no model step. The
  // owner's move, EN and images leave it.
  const tr = w.settings.forge?.translatedLabel ? pr.translated : null;
  if (tr?.head && head && tr.head !== head) {
    const changed = changedAround(pr, w, target, tr.head, head);
    if (changed === null) out.notes.push(`${id}: translated at ${String(tr.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare them`);
    else if (changed.some((f) => !IMAGE.test(f))) return step('untranslated', { pr: id, head, since: tr.head, pages: changed.filter((f) => !IMAGE.test(f)).length });
  }
  // Row 8: commits the pipeline didn't make (neither in pipelineCommits nor from the base).
  const hand = handCommits(pr, head, w);
  if (hand === null) out.notes.push(`${id}: the head ${String(head ?? '').slice(0, 7)} is not fetched here: hand edits and stale chain stages are not checked`);
  else {
    if (hand.length && p.stage !== 'readyForMerge') out.mismatch.push(`${id}: ${hand.length} commit(s) on the branch the pipeline didn't make: a hand edit, kept; the next stage reads the branch`);
    // A UA change after ready for merge, whoever made it (the owner's final edit, an answer to a comment), translates
    // nothing by itself (D-112): the PR goes back to the owner's queue, and the owner's move to In translation re-syncs
    // the whole range since the ready head (row 12). An id-only change keeps the PR ready (D-073, `changedUnder`), and
    // so does a commit that left UA alone: a person's is made ready for its head, with the pack again if it changed an
    // image, and no re-sync.
    const ready = pr.readyForMerge?.at(-1);
    if (p.stage === 'readyForMerge' && ready && head && ready.head !== head) {
      const changed = changedAround(pr, w, target, ready.head, head);
      if (changed === null) out.notes.push(`${id}: ready for merge at ${String(ready.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare them`);
      else if (changed.length) return step('move', { pr: id, to: 'finalReview', uaChanged: changed.length, since: ready.head });
      else if (hand.length) {
        // A hand edit of an EN page: its heading ids kept in step with UA first, then ready for the head that gives.
        const ids = idSyncStep(pr, w, target, head, hand, out);
        if (ids) return ids;
        // A page whose heading ids the step couldn't keep in step holds the PR at its ready head: the line comment says
        // what to change, and a later commit's check of that page lets it go on. Only the ready step waits: a review
        // request, a comment or a rename asked for still goes on below.
        if (w.settings.forge?.translatedLabel && pr.idBlocked?.length) {
          out.notes.push(`${id}: the heading ids of ${[...new Set(pr.idBlocked.flatMap((b) => b.pages))].join(', ')} can't be kept in step with UA (see the line comment): not made ready for ${String(head).slice(0, 7)}`);
        } else {
          const after = readyAgain(pr, w, target, head, out, world);
          if (after) return after;
        }
      } else if (w.settings.keepFresh && mergedAt(pr, head)) {
        // The runner's own merge of the base made the head and changed no UA block of the PR's own: ready again for it,
        // once CI passed (`readyStep`).
        const after = readyAgain(pr, w, target, head, out, world);
        if (after) return after;
      }
    }
  }
  // The approval (a person's move of the card to In translation) saw a head; a word change in UA since then is reported.
  // An id-only change (heading ids, link fragments) keeps it (D-073).
  if (pr.approval?.head && head && pr.approval.head !== head && ['translation', 'readyForMerge'].includes(p.stage)) {
    const changed = changedAround(pr, w, target, pr.approval.head, head);
    const v = out.prs.find((x) => x.id === id);
    if (changed?.length) {
      v.approvalStale = changed.length;
      out.mismatch.push(`${id}: ${changed.length} UA page(s) changed after the approval at ${String(pr.approval.head).slice(0, 7)}: the review saw another text`);
    } else if (changed) v.approvalStale = 0;
  }
  // Row 9: a person asked a reviewer on a PR in the owner's queue, of either review kind: the card goes to the review,
  // and the target's card members onto it (lib/experts.mjs). A request a move already took along (a reviewer who hasn't
  // answered when a person moved the card back) doesn't move it again.
  if (p.stage === 'finalReview' && newReviewRequests(pr, world).length) return step('move', { pr: id, to: 'smeReview' });
  // The owner's reply in the thread of a published id the runner kept, asking to rename it instead
  // (`forge.idComments.rename`): the rename, with no model step, before the other comments.
  const rename = renameAsked(pr, world, w);
  if (rename.length) return step('idSync', { pr: id, head, commits: [], rename });
  // Row 10b, with `companyRepos` and review rounds (TASK-105): a round asked new questions, held from the description
  // until the answer pass on this PR records what it answered and what it kept.
  if (pr.answerPassDue && companyReposOn(w.settings) && w.settings.reviewRounds) return step('answerPass', { pr: id, head, nextEdit: nextEditNumber(pr) });
  // Row 11.
  const approved = p.stage === 'smeReview' ? expertApproved(l, p) : null;
  if (world.newComments?.length) {
    const owner = world.newComments.filter((c) => c.by === 'owner');
    const reviewer = world.newComments.length - owner.length;
    // Answering the expert in their review, not yet approved: the summary ends with the way to approve (D-082).
    const files = filesLink(pr, world);
    const ask = p.stage === 'smeReview' && reviewer && !approved && files ? { askApprove: files } : {};
    // The questions to the owner still open from the PR's last summaries: the session says which are left (lib/pr-labels.mjs).
    const asked = pr.openQuestions?.items?.length ? { openQuestions: pr.openQuestions.items } : {};
    return step('answerComments', { pr: id, comments: world.newComments.length, owner: owner.length, reviewer, ...ownerForms(l, pr, world.newComments, w), ...ask, ...asked });
  }
  // After the translation, a hand edit of an EN page at any other stage: its heading ids kept in step with UA (`idSync`).
  if (hand?.length && p.stage !== 'readyForMerge') {
    const ids = idSyncStep(pr, w, target, head, hand, out);
    if (ids) return ids;
  }
  // Row 11b, the style check: hand commits that changed UA and no style check read are reviewed while the PR is in the
  // owner's queue (D-081, D-082), each once, whatever the head (the check records the shas it read). A ready PR went
  // back to the queue above first; new comments are answered first (the forge check picks them up within a minute);
  // at an earlier stage they wait for the queue. Once a person moved the card on to In translation, the move approved
  // them: no session and no bounce, the shas recorded as seen (`skip`, a scripted step).
  if (hand?.length && ['finalReview', 'translation'].includes(p.stage)) {
    const commits = handToCheck(pr, hand, w, target, head, out, { grace: p.stage === 'finalReview' });
    if (commits.length && p.stage === 'translation') return step('styleCheck', { role: null, skip: true, pr: id, head, commits });
    if (commits.length) {
      const edits = mergedEdits(w.editsByPr?.get(id) ?? [editsOf(pr)]);
      // The style fixes already posted on the pages these commits changed: a hand edit that puts one's «було» back is
      // the owner undoing it, and is left out (no re-fix loop).
      const pages = new Set(commits.flatMap((c) => c.pages));
      const fixes = edits.filter((e) => e.rule && pages.has(e.page)).map((e) => ({ n: e.n, page: e.page, block: e.block ?? null, before: e.before }));
      return step('styleCheck', { pr: id, head, commits, nextEdit: nextEditNumber({ edits }), ...(fixes.length ? { fixes } : {}) });
    }
  }
  // The expert's Approve (D-082): a PR in the expert's review that a reviewer approved since it entered the review goes
  // on to the owner's queue by itself, after its new comments are answered (row 11), and the card goes where its least
  // advanced PR is: with one PR, to the final review status; with two, it stays with the slower one. That starts
  // nothing: the owner reads, then moves the card.
  if (approved) return step('move', { pr: id, to: 'finalReview', approved: true, review: approved });
  // Row 12.
  if (p.stage === 'translation') return chainStep(l, p, w, out, target, head);
  // Row 12b, with `forge.keepFresh`: a PR ready for merge whose base moved gets the base merged in, after every row
  // above, so no merge pushes under an answer. In the owner's queue and before, never (D-127): the owner edits there.
  if (p.stage === 'readyForMerge' && w.settings.keepFresh) {
    const s = freshStep(pr, world, w, target, head, out)?.step ?? null;
    if (s) notReady(out, id, stepWhy(s));
    return s;
  }
  return null;
}

// The hand commits a style check has to read: not reviewed by one yet, after the head last marked ready for merge (what
// came before it went through the chain and was the owner's to approve), and with a UA page of the PR's own changed
// (a page, not an image; not an id-only change, not a page a merge of the base brought). Oldest first, each with its pages. A commit git
// here can't diff is noted and left for a later check.
function handToCheck(pr, hand, w, target, head, out, { grace = false } = {}) {
  const id = prId(pr);
  const reviewed = (sha) => (pr.styleChecked ?? []).some((x) => x?.sha && (sha.startsWith(x.sha) || x.sha.startsWith(sha)));
  let todo = hand.filter((sha) => !reviewed(sha));
  const ready = pr.readyForMerge?.at(-1)?.head;
  if (todo.length && ready) {
    const after = w.git?.commitsBetween?.(target, ready, head) ?? null;
    if (after === null) {
      out.notes.push(`${id}: ready for merge at ${String(ready).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't list the commits between: hand edits are not style-checked`);
      return [];
    }
    todo = todo.filter((sha) => after.includes(sha));
  }
  // Built for the PRs to come (D-080): a commit written before `styleCheck.since` (its author date, which a rebase or an
  // amend keeps) counts as seen.
  const since = w.settings.styleCheck?.since ? Date.parse(w.settings.styleCheck.since) : null;
  if (since !== null && todo.length) {
    todo = todo.filter((sha) => {
      const at = w.git?.commitDates?.(target, sha)?.author ?? null;
      if (at === null) out.notes.push(`${id}: the hand commit ${sha.slice(0, 7)} has no date here: not style-checked yet`);
      return at !== null && at >= since;
    });
  }
  // The owner's usual "push, then move": a commit made less than GRACE ago waits, so a move to In translation right
  // after it finds no style session running (the move then approves it). A commit git here has no date for goes on.
  if (grace && todo.length) {
    todo = todo.filter((sha) => {
      const at = w.git?.commitDates?.(target, sha)?.committer ?? null;
      // A date ahead of this clock (a skewed clock) doesn't hold the commit.
      const young = at !== null && w.now - at >= 0 && w.now - at < GRACE_MS;
      if (young) out.notes.push(`${id}: the hand commit ${sha.slice(0, 7)} is less than ${GRACE_MS / 60000} minutes old: style-checked at a later check`);
      return !young;
    });
  }
  const commits = [];
  for (const sha of [...todo].reverse()) {
    const changed = w.git?.changedUnder(target, `${sha}^`, sha, uaRoots(pr, w, target), baseOf(pr, target)) ?? null;
    const pages = changed?.filter((f) => /\.mdx?$/.test(f)) ?? null;
    if (pages === null) out.notes.push(`${id}: the hand commit ${sha.slice(0, 7)} can't be diffed here: not style-checked yet`);
    else if (pages.length) commits.push({ sha, pages });
  }
  return commits;
}

// How long a hand commit waits before its style check (the owner's push, then the move).
export const GRACE_MS = 10 * 60000;

// After the translation (`forge.translatedLabel` on, and `pr.translated` still matching UA), the hand commits since it
// that changed an EN page (a page outside the repo's UA roots) and no id check read: the runner checks their pages'
// heading ids against UA (`idSync`, no model). Oldest first, each with its pages. A commit git here can't diff is noted
// and left for a later check.
function idSyncStep(pr, w, target, head, hand, out) {
  const tr = w.settings.forge?.translatedLabel ? pr.translated : null;
  if (!tr?.head || !hand.length || tr.head === head) return null;
  const id = prId(pr);
  const read = [...(pr.idChecked ?? []), ...(pr.idBlocked ?? []).map((b) => b.sha)].map(String);
  const checked = (sha) => read.some((x) => sha.startsWith(x) || x.startsWith(sha));
  const after = w.git?.commitsBetween?.(target, tr.head, head) ?? null;
  if (after === null) return null;
  const todo = hand.filter((sha) => !checked(sha) && after.includes(sha));
  const ua = w.settings.targets.filter((t) => t.repo === pr.repo).map((t) => t.uaRoot);
  const commits = [];
  for (const sha of [...todo].reverse()) {
    const changed = w.git?.changedUnder(target, `${sha}^`, sha, ['.'], baseOf(pr, target)) ?? null;
    if (changed === null) out.notes.push(`${id}: the hand commit ${sha.slice(0, 7)} can't be diffed here: its heading ids are not checked yet`);
    else {
      const pages = changed.filter((f) => /\.mdx?$/.test(f) && !ua.some((r) => f.startsWith(r)));
      if (pages.length) commits.push({ sha, pages });
    }
  }
  return commits.length ? step('idSync', { pr: id, head, commits }) : null;
}

// The owner's replies in the threads of the published ids the runner kept (`pr.idComments`, kind `kept`) that ask for
// the rename (`forge.idComments.rename`, after the trigger word when the host has one): [{ comment, reply, page, id }].
const plainReply = (t) => String(t ?? '').replace(/[`«»"'.!]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function renameAsked(pr, world, w) {
  const phrase = w.settings.idComments?.rename;
  const kept = (pr.idComments ?? []).filter((c) => c.kind === 'kept' && !c.renamed && c.commentId !== undefined && c.commentId !== null);
  if (!w.settings.forge?.translatedLabel || !phrase || !kept.length) return [];
  return (world.newComments ?? []).flatMap((c) => {
    const k = c.by === 'owner' && c.kind === 'review-comment' ? kept.find((x) => String(x.commentId) === String(c.root)) : null;
    return k && plainReply(c.body) === plainReply(phrase) ? [{ comment: k.commentId, reply: c.id, updatedAt: c.updatedAt ?? null, page: k.page, ua: k.ua, id: k.old }] : [];
  });
}

// The latest approving review of a PR in the expert's review, when one of its experts approved since it entered the review;
// none while any expert's last verdict asks for changes, whatever its time (lib/world.mjs `reviewerSignals`) (an older
// approval, of a review before a move back, moves nothing), and no review asks for changes. With the head it approved.
function expertApproved(l, p) {
  if (!p.world?.approvals?.length || p.world.reviewDecision === 'CHANGES_REQUESTED') return null;
  const since = p.pr.smeSince ?? (l.left?.status === 'smeReview' ? l.left.at : null);
  const a = p.world.approvals.filter((x) => !since || Date.parse(x.at) >= Date.parse(since)).sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).at(-1);
  if (!a) return null;
  return { id: a.id, login: a.login, head: a.commit ?? p.world.headCommit ?? null, at: a.at };
}

// The PR's Files changed tab, where the expert reads and approves.
export const filesLink = (pr, world) => {
  const url = pr.url ?? world?.url ?? null;
  return url ? `${url.replace(/\/+$/, '')}/files` : null;
};

const newReviewRequests = (pr, world) => (world.reviewRequests ?? []).map((r) => r.login ?? r.team ?? r).filter((r) => !(pr.reviewersRequested ?? []).map(String).includes(String(r)));

// The owner's comments in the two forms the writer takes as they are: a reply by number to the PR's lists of edits
// (only once the PR has a list: before that a numbered comment is an ordinary instruction), resolved item by item
// against the lists; and a review comment with a `suggestion` block, its block to be put in verbatim.
//
// A reply in a thread the pipeline opened is read against that thread: in the thread of an item's line comment
// (`edits[].commentId`), the owner's reply is a reply by number with the number taken from the thread (lib/edits.mjs,
// `parseThreadReply`); in a place's thread (`places[].commentId`), the owner's reply is the answer to that place. Both
// only with review rounds. A suggestion block is a suggestion wherever it is.
function ownerForms(l, pr, comments, w) {
  const owner = comments.filter((c) => c.by === 'owner');
  const edits = mergedEdits(w.editsByPr?.get(prId(pr)) ?? [editsOf(pr)]);
  const replies = edits.length
    ? owner.filter((c) => c.kind !== 'review-comment').map((c) => ({ id: c.id, parsed: parseReply(c.body) })).filter((x) => x.parsed).map((x) => ({ id: x.id, items: resolveReply(x.parsed, edits), ...(x.parsed.rest ? { rest: x.parsed.rest } : {}) }))
    : [];
  const suggestions = owner.filter((c) => c.kind === 'review-comment').map((c) => ({ c, s: suggestionOf(c.body) })).filter((x) => x.s).map(({ c, s }) => ({ id: c.id, path: c.path ?? null, line: c.line ?? null, ...(s.several ? { several: s.several } : { text: s.text, note: s.note }) }));
  const suggested = new Set(suggestions.map((s) => String(s.id)));
  const inThread = (c) => c.kind === 'review-comment' && c.root !== null && c.root !== undefined && String(c.root) !== String(c.id) && !suggested.has(String(c.id));
  // Only with review rounds (the host's `forge.reviewRounds`): without them a reply in a thread is an ordinary comment,
  // as before, and no runner settles a place's thread.
  const rounds = Boolean(w.settings?.reviewRounds);
  const threadReplies = !rounds ? [] : owner.filter(inThread).flatMap((c) => {
    const item = edits.find((e) => e.commentId !== undefined && e.commentId !== null && String(e.commentId) === String(c.root));
    return item ? [{ id: c.id, n: item.n, ...resolveThreadReply(item, parseThreadReply(c.body), edits) }] : [];
  });
  const places = (l.places ?? []).filter((p) => p.repo === pr.repo && Number(p.pr) === Number(pr.number) && p.commentId !== undefined && p.commentId !== null);
  // The owner's replies only (decision 3): an expert's in a place's thread is for people (lib/world.mjs).
  const placeReplies = !rounds ? [] : owner.filter(inThread).flatMap((c) => {
    const place = places.find((p) => String(p.commentId) === String(c.root));
    return place ? [{ id: c.id, place: place.id, by: c.by, author: c.author ?? null, page: place.page ?? null, line: place.line ?? null, state: place.state ?? 'open', text: String(c.body ?? '').trim() }] : [];
  });
  // With the trigger words, the comments the step takes, each with the text the session reads (the word cut off) and,
  // in a thread, the thread's earlier comments: the session acts on these and on no other comment of the PR.
  const take = w.settings?.triggerWords?.length ? comments.map((c) => ({ id: c.id, kind: c.kind, by: c.by, author: c.author ?? null, ...(c.path ? { path: c.path, line: c.line ?? null } : {}), text: String(c.body ?? '').trim(), ...(c.context?.length ? { context: c.context } : {}) })) : [];
  return { nextEdit: nextEditNumber({ edits }), ...(replies.length ? { replies } : {}), ...(suggestions.length ? { suggestions } : {}), ...(threadReplies.length ? { threadReplies } : {}), ...(placeReplies.length ? { placeReplies } : {}), ...(take.length ? { take } : {}) };
}

// After ready for merge, once the owner moved the card to In translation: the blocks changed since the ready head
// re-synced (`resync`, once over the whole range, whatever rounds of comments made it), then, when an image changed
// since the visual pack saw the branch, the pack again (`visualPack`), and only then `readyForMerge` for the new head.
// The numbered edits made since the ready head go with the re-sync, so it records their EN side.
function resyncAfterReady(pr, w, target, head, out, world = null) {
  const id = prId(pr);
  const ready = pr.readyForMerge.at(-1);
  if (ready.head !== head) {
    const changed = changedAround(pr, w, target, ready.head, head);
    if (changed === null) {
      out.notes.push(`${id}: ready for merge at ${String(ready.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare them`);
      return null;
    }
    const synced = pr.steps?.resync?.status === 'done' && pr.steps.resync.head === head;
    if (changed.length && !synced) {
      const since = (e) => (ready.seq !== undefined && e.seq !== undefined ? e.seq > ready.seq : String(e.at ?? '') > String(ready.at ?? ''));
      const items = editsOf(pr).filter(since).map((e) => ({ n: e.n, page: e.page, block: e.block, en: Boolean(e.en) }));
      return step('resync', { pr: id, head, since: ready.head, pages: changed.length, files: changed, ...(items.length ? { items } : {}) });
    }
  }
  return readyAgain(pr, w, target, head, out, world);
}

// The pack again when an image changed since it saw the branch, then ready for this head.
function readyAgain(pr, w, target, head, out, world = null) {
  const id = prId(pr);
  const pack = pr.chain?.visualPack;
  if (pack?.head && pack.head !== head) {
    const images = w.git?.imagesChanged?.(target, pack.head, head, baseOf(pr, target)) ?? null;
    if (images === null) out.notes.push(`${id}: the visual pack saw ${String(pack.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare their images`);
    else if (images.length) return step('visualPack', { pr: id, head, images: images.length });
  }
  return readyStep(pr, w, target, head, out, world);
}

// The first chain stage not done for the current head. UA pages changed after a stage's head make it (and so every
// later stage) stale. EN changed by hand is never translated over: only UA changes make a stage stale.
function chainStep(l, p, w, out, target, head) {
  const { pr } = p;
  const id = prId(pr);
  // Ready for merge before, every chain stage done: the UA changes since then are re-synced as one range, not by the
  // chain again.
  if (pr.readyForMerge?.length && CHAIN.every((s) => pr.chain?.[s]?.status === 'done')) return resyncAfterReady(pr, w, target, head, out, p.world);
  for (const stage of CHAIN) {
    const rec = pr.chain?.[stage];
    // The EN review posts its rewrites on the description's numbered list, going on from the PR's last number.
    const numbered = stage === 'enReview' ? { nextEdit: nextEditNumber(pr) } : {};
    if (!rec || rec.status !== 'done') return step(stage, { pr: id, head, ...numbered });
    if (rec.head && head && rec.head !== head) {
      const changed = changedAround(pr, w, target, rec.head, head);
      if (changed === null) out.notes.push(`${id}: ${stage} saw ${String(rec.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare them`);
      else if (changed.length) return step(stage, { pr: id, head, stale: changed.length, since: rec.head, files: changed, ...numbered });
    }
  }
  // Every stage is done for this head: ready again. So a person's move here with nothing changed starts no model step.
  return readyStep(pr, w, target, head, out, p.world);
}

// ------------------------------------------------------------------ keeping a PR up to date with its base

// How long a new head waits for a CI check to report (`forge.keepFresh`): the forge takes a moment to start CI after a
// push. After it, a head no check reported on opens a gate to the owner: it is never read as passing.
export const CI_GRACE_MS = 10 * 60000;
// How long CI may stay pending (or expected: a required check that never started) on a head before the owner is asked.
export const CI_TIMEOUT_MS = 60 * 60000;
// The conflicts with its base a PR's sessions resolve: from this many on (counted once per head and base tip, never
// reset by a merge that went through), the owner merges the base in.
export const CONFLICT_LIMIT = 2;

const short = (sha) => String(sha ?? '').slice(0, 7);

// Why a PR the rule keeps from ready for merge for its head is not ready yet (`forge.keepFresh`), on its view
// (`prs[].notReady`): the report and the progress file never call it ready for the merge meanwhile.
function notReady(out, id, why) {
  const v = out.prs.find((x) => x.id === id);
  if (v) v.notReady = why;
}
const stepWhy = (s) => (s.stage === 'baseFix' ? `the merge of the base conflicted in ${(s.files ?? []).join(', ')}: a session resolves it` : `${s.behind} commit(s) behind its base: the runner merges it in first`);

// The runner's last base merge of a PR, when it made this head (a merge pushed, not a conflict aborted).
function mergedAt(pr, head) {
  const m = pr.steps?.baseMerge;
  return m?.status === 'done' && !m.result?.conflict && m.head && head && m.head === head ? m : null;
}

// Ready for merge for this head. With `forge.keepFresh`: on a PR at ready for merge (D-127: from ready for merge on,
// never at the chain's end, where the PR is marked ready first), only once the branch has its base (`freshStep`); and
// at every stage only once CI passed on the head (`ciHolds`). Without it, as before.
function readyStep(pr, w, target, head, out, world) {
  const id = prId(pr);
  if (w.settings.keepFresh) {
    if (pr.stage === 'readyForMerge') {
      const fresh = freshStep(pr, world, w, target, head, out);
      if (fresh?.step) {
        notReady(out, id, stepWhy(fresh.step));
        return fresh.step;
      }
      if (fresh) return null;
    }
    if (ciHolds(pr, world, w, head, out)) return null;
  }
  return step('readyForMerge', { pr: id, head });
}

// Whether CI keeps the head from ready for merge (`ciOf`), with what the status says: a wait is a note; a red check is
// a mismatch with the check named and a gate; CI that never reported, or stayed pending past CI_TIMEOUT_MS, is a gate
// to the owner. The PR's view says why it is not ready (`notReady`).
function ciHolds(pr, world, w, head, out) {
  const id = prId(pr);
  const ci = ciOf(pr, world, w, head);
  if (!ci) return false;
  if (ci.wait) {
    out.notes.push(`${id}: ${ci.wait}: ready for merge once it passes`);
    notReady(out, id, `${ci.wait}: ready for merge once it passes`);
  } else if (ci.stuck) {
    out.notes.push(`${id}: ${ci.stuck}`);
    out.gate = { who: 'owner', why: `${ci.stuck} on ${id}: see why on the PR (a check that never starts, or one the branch protection expects); it is ready for merge once CI passes on ${short(head)}` };
    notReady(out, id, ci.stuck);
  } else {
    out.mismatch.push(`${id}: CI failed on ${short(head)}: ${ci.red.join(', ')}; not ready for merge until a later head passes`);
    out.gate = { who: 'owner', why: `CI failed on ${id} (${ci.red.join(', ')}): a commit that fixes it, and the PR is ready for merge once CI passes on it` };
    notReady(out, id, `CI failed on ${short(head)}: ${ci.red.join(', ')}`);
  }
  return true;
}

// A gate to the owner for the PR's merge of the base, with the PR kept out of ready for merge.
function ownerMerges(out, id, why) {
  out.notes.push(`${id}: ${why}`);
  out.gate = { who: 'owner', why: `${id}: ${why}` };
  notReady(out, id, why);
  return { gate: true };
}

// Whether the base has to be merged into the branch first (D-113), on a PR at ready for merge: `{ step }`, the runner's
// `baseMerge` when the head lacks commits of the base, or, after a merge that conflicted at this head and this base,
// the session that resolves it (`baseFix`: the writer, or the translator when no conflicting file is under a UA root);
// `{ gate }` for a conflict no session resolves (a delete or a rename in it), or once the PR's conflicts reach
// CONFLICT_LIMIT; `{ wait }` while new comments are answered first, whatever the merge needs; null when the branch is up
// to date, while CI on the runner's last merge still runs or hasn't reported yet (so a base that moves often merges once
// per CI run), or when git here can't tell.
function freshStep(pr, world, w, target, head, out) {
  const id = prId(pr);
  if (world?.newComments?.length) return { wait: true };
  const base = baseOf(pr, target);
  const tip = world?.baseCommit ?? null;
  const last = pr.steps?.baseMerge;
  const conflict = last?.status === 'done' && last.head === head ? last.result?.conflict : null;
  if (conflict && (!tip || !conflict.base || conflict.base === tip)) {
    const files = conflict.files.join(', ');
    if (conflict.unresolvable?.length) return ownerMerges(out, id, `the merge of origin/${base} conflicts in ${conflict.unresolvable.map((u) => `${u.path} (${u.kind})`).join(', ')}, which needs a delete or a move that no session makes: merge origin/${base} into ${pr.branch} and resolve it`);
    const count = pr.baseConflicts?.count ?? 1;
    if (count >= CONFLICT_LIMIT) return ownerMerges(out, id, `the merge of origin/${base} conflicted ${count} times on this PR, the last time in ${files}: merge origin/${base} into ${pr.branch} and resolve it`);
    const roots = uaRoots(pr, w, target);
    const ua = conflict.files.some((f) => roots.some((r) => f.startsWith(r)));
    return { step: step('baseFix', { role: ua ? 'writer' : 'translator', pr: id, head, base, ...(conflict.base ? { tip: conflict.base } : {}), files: conflict.files }) };
  }
  if (mergedAt(pr, head) && ciOf(pr, world, w, head)?.wait) return null;
  const behind = w.git?.behind?.(target, head, base, tip) ?? null;
  if (behind === null) {
    out.notes.push(`${id}: the head ${short(head)} or ${base} is not fetched here: whether the branch is behind its base is not checked`);
    return null;
  }
  if (!behind) return null;
  return { step: step('baseMerge', { pr: id, head, base, behind, ...(tip ? { tip } : {}) }) };
}

// When the head was first seen: the earliest ledger record made at it (a chain stage, a step such as the runner's
// merge), else the forge's last update of the PR (a push updates it). Null when neither is known.
function headSince(pr, world, head) {
  const at = [...Object.values(pr.chain ?? {}), ...Object.values(pr.steps ?? {})].filter((r) => r?.head === head && r.at).map((r) => Date.parse(r.at)).filter(Number.isFinite);
  if (at.length) return Math.min(...at);
  const updated = Date.parse(world?.updatedAt ?? '');
  return Number.isFinite(updated) ? updated : null;
}

// The CI of the head (`forge.keepFresh`), read only from the checks of that very commit: `{ red: [names] }` when one
// failed; `{ wait }` while one runs, or while none has reported within CI_GRACE_MS of the head; `{ stuck }` past either
// (CI pending past CI_TIMEOUT_MS, or no check at all after the grace); null when CI passed. Checks of another commit,
// or none, are never a pass.
function ciOf(pr, world, w, head) {
  const c = world?.checks?.commit && world.checks.commit === head ? world.checks : null;
  if (c?.state === 'failure') return { red: c.failing?.length ? c.failing : ['a check'] };
  if (c?.state === 'success') return null;
  const since = headSince(pr, world, head);
  const age = since === null ? null : w.now - since;
  if (c?.state === 'pending') {
    const names = c.pending?.length ? ` (${c.pending.join(', ')})` : '';
    if (age !== null && age > CI_TIMEOUT_MS) return { stuck: `CI on ${short(head)} has been pending for over ${CI_TIMEOUT_MS / 60000} min${names}` };
    return { wait: `CI runs on ${short(head)}${names}` };
  }
  if (age === null || age > CI_GRACE_MS) return { stuck: `no CI check has reported on ${short(head)} in ${CI_GRACE_MS / 60000} min` };
  return { wait: `no CI check has reported on ${short(head)} yet` };
}

// The PR's base: a page or an image the base brought into the branch (a merge of the base) is never the PR's change.
const baseOf = (pr, target) => pr.base ?? target?.base ?? 'main';

// The files under the PR's UA roots that changed between two of its heads (`changedUnder`), read around the runner's
// own id commits (`pr.idCommits`, the `idSync` step): such a commit changes heading ids and the links to them only,
// which `changedUnder` counts (a changed id is no id-only change), so the range is read in pieces that leave each out,
// `from..c^` and `c..to`. With none in the range, the range as one. Null when git here can't tell.
function changedAround(pr, w, target, from, to) {
  const roots = uaRoots(pr, w, target);
  const base = baseOf(pr, target);
  const ids = (pr.idCommits ?? []).map((c) => String(c.sha ?? c));
  if (!ids.length) return w.git?.changedUnder(target, from, to, roots, base) ?? null;
  const between = w.git?.commitsBetween?.(target, from, to) ?? null;
  if (between === null) return null;
  const skip = [...between].reverse().filter((sha) => ids.some((x) => sha.startsWith(x) || x.startsWith(sha)));
  if (!skip.length) return w.git?.changedUnder(target, from, to, roots, base) ?? null;
  const pieces = [];
  let start = from;
  for (const c of skip) {
    pieces.push([start, `${c}^`]);
    start = c;
  }
  pieces.push([start, to]);
  const out = new Set();
  for (const [a, b] of pieces) {
    const piece = w.git?.changedUnder(target, a, b, roots, base) ?? null;
    if (piece === null) return null;
    for (const f of piece) out.add(f);
  }
  return [...out];
}

function uaRoots(pr, w, target) {
  const roots = (pr.targets ?? []).map((tid) => w.settings.targets.find((t) => t.id === tid)?.uaRoot).filter(Boolean);
  if (!roots.length && target) roots.push(target.uaRoot);
  return roots;
}

// The video parts that have no transcript file yet.
function missingParts(l, w) {
  const parts = (l.video?.videos ?? []).flatMap((v) => v.parts ?? []);
  return parts.filter((p) => !(p.transcript && w.fileExists?.(p.transcript)));
}

// A part's uploads (a fetch's failure is a try too, marked `fetch`), and the last upload.
const uploadsOf = (p) => (p.tries ?? []).filter((t) => !t.fetch);
const lastUpload = (p) => uploadsOf(p).at(-1) ?? null;
// The automatic try is on only with both settings: the adapter and its browser profile.
export const automaticVideo = (v) => Boolean(v?.transcriber && v?.browserProfile);
// An uploaded part's transcript is looked for every `fetchMinutes`, from its upload or its last look.
function fetchDue(p, now, v) {
  const up = lastUpload(p);
  if (up?.outcome !== 'uploaded') return false;
  const last = Math.max(Date.parse(up.at), ...(p.checks ?? []).map((c) => Date.parse(c.at)).filter(Number.isFinite));
  return now - last >= v.fetchMinutes * 60000;
}

// The step once every part has its transcript, whatever the video settings (a person's transcripts too): the runner's
// frame sweep with them (`videoExtract`), then the import's session. A sweep recorded before the last gate was for
// another set of parts. A sweep the runner skipped (no venv, no `tesseract` or `ffmpeg`: its preflight) leaves the
// import on the parts' transcripts at their offsets, with no frames, as before the sweep, and says why.
function importStep(l) {
  const videos = l.video?.videos ?? [];
  const parts = videos.flatMap((v) => v.parts ?? []).length;
  if (!doneAfter(l, 'videoExtract', 'videoGate')) return step('videoExtract', { parts });
  const skipped = l.video?.extractSkipped?.reason ?? null;
  const partsOf = (v) => (v.parts ?? []).map((p) => ({ transcript: p.transcript, start: p.start }));
  if (skipped) return step('videoImport', { parts, noFrames: skipped, videos: videos.map((v) => ({ file: v.file, parts: partsOf(v) })) });
  const extract = videos.filter((v) => v.extract).map((v) => ({ file: v.file, transcript: v.extract.transcript, frames: v.extract.frames, ...(v.extract.context ? { context: v.extract.context } : {}), parts: partsOf(v) }));
  return step('videoImport', { parts, ...(extract.length ? { extract } : {}) });
}

// Whether a time is inside `limits.startHours`, local time: the automatic try opens a browser only then (D-109: no
// work in the early morning). Outside them it waits; nothing falls back.
function inVideoHours(ms, settings) {
  const h = parseStartHours(settings.limits?.startHours) ?? parseStartHours('10-22');
  const d = new Date(ms);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= h.from && m < h.to;
}

// The time between two moments that falls inside `limits.startHours`, local time (ms): the hours in which a try runs.
export function startHoursBetween(from, to, settings) {
  const h = parseStartHours(settings.limits?.startHours) ?? parseStartHours('10-22');
  let total = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() < to; day.setDate(day.getDate() + 1)) {
    const a = new Date(day);
    a.setHours(0, h.from, 0, 0);
    const b = new Date(day);
    b.setHours(0, h.to, 0, 0);
    total += Math.max(0, Math.min(to, b.getTime()) - Math.max(from, a.getTime()));
  }
  return total;
}

// Whether the transcriber's profile has been in use by another run, at every try since the first (`busySince`), for
// longer than `transcriptHours` of the start hours: a lock the runs can't get past. The night outside them, when no
// try runs, doesn't count; the profile opening clears `busySince` (lib/record.mjs).
function busyTooLong(l, now, settings) {
  const since = Date.parse(l.video?.busySince ?? '');
  return Number.isFinite(since) && startHoursBetween(since, now, settings) > settings.video.transcriptHours * 3600000;
}

// For the watcher, inside the start hours: a ticket at the video gate with an uploaded part whose transcript is due a
// look, or (with `ledgers`, every ticket's) a part not yet uploaded that the day's uploads still allow: a gate reached
// before the start hours, or a day's parts left for tomorrow, is tried once they begin. `exists(rel)`: a file of the
// host repo exists.
export function videoFetchDue(l, now, settings, exists, ledgers = null) {
  if (!automaticVideo(settings.video) || !l.video || l.video.importedAt || l.video.skipped || l.video.blockedAt || phaseOf(l) !== 'videoGate' || !inVideoHours(now, settings)) return false;
  const parts = (l.video.videos ?? []).flatMap((v) => v.parts ?? []).filter((p) => !(p.transcript && exists(p.transcript)));
  if (parts.some((p) => (p.tries ?? []).some((t) => t.outcome === 'failed'))) return false;
  if (parts.some((p) => fetchDue(p, now, settings.video))) return true;
  return Boolean(ledgers) && parts.some((p) => !uploadsOf(p).length) && videoQuota(ledgers, l, settings, now, exists) > 0;
}

// The uploads the transcription account has left today for this ticket: `partsPerDay` is the account's, across every
// ticket, and the oldest gate goes first (D-070), so the parts an older gate still waits to upload come off it. A gate
// that fell back to the person waits for no upload. `exists(rel)`: a file of the host repo exists.
export function videoQuota(ledgers, l, settings, now, exists) {
  const v = settings.video;
  const today = dayOf(now);
  const used = ledgers.flatMap((x) => (x.video?.videos ?? []).flatMap((vv) => vv.parts ?? [])).flatMap(uploadsOf).filter((t) => t.at && dayOf(Date.parse(t.at)) === today).length;
  const older = (x) => x.key !== l.key && x.video?.at && (x.video.at < l.video.at || (x.video.at === l.video.at && String(x.key) < String(l.key)));
  const waiting = ledgers
    .filter((x) => older(x) && !x.video.importedAt && !x.video.skipped && !x.video.blockedAt && phaseOf(x) === 'videoGate')
    .map((x) => (x.video.videos ?? []).flatMap((vv) => vv.parts ?? []))
    .filter((ps) => !ps.some((p) => (p.tries ?? []).some((t) => t.outcome === 'failed')))
    .flatMap((ps) => ps.filter((p) => !uploadsOf(p).length && !(p.transcript && exists(p.transcript)))).length;
  return Math.max(0, v.partsPerDay - used - waiting);
}

// Row 13: the video gate. With the automatic try on, parts not yet uploaded go to it, as many as the day allows, and
// an uploaded part's transcript is looked for every `fetchMinutes` (uploading and fetching are separate runs). A failed
// try (or no automatic try configured) falls back to the gate: the card to Blocked with the gate comment, the parts in
// the report. Once every part has its transcript: the frame sweep, then the import.
function videoGate(l, w, out, status) {
  const v = w.settings.video;
  const missing = missingParts(l, w);
  if (!missing.length) {
    out.steps.push(importStep(l));
    return out;
  }
  const tz = undefined; // the machine's own zone: the day the owner lives in
  const today = dayOf(w.now, tz);
  const triedToday = (l.video?.videos ?? []).flatMap((x) => x.parts ?? []).flatMap(uploadsOf).filter((t) => t.at && dayOf(Date.parse(t.at), tz) === today).length;
  const failed = missing.filter((p) => (p.tries ?? []).some((t) => t.outcome === 'failed'));
  const untried = missing.filter((p) => !uploadsOf(p).length);
  const uploaded = missing.filter((p) => lastUpload(p)?.outcome === 'uploaded');
  const quota = Math.max(0, v.partsPerDay - triedToday);
  out.gate = { who: 'owner', why: `transcripts of ${missing.length} video part(s)` };
  const block = (reason) => {
    if (status !== 'blocked') out.steps.push(step('videoBlock', { reason }));
    return out;
  };
  if (failed.length || !automaticVideo(v)) return block(failed.length ? 'the automatic try failed' : 'no automatic try configured (video.transcriber and video.browserProfile)');
  const due = uploaded.filter((p) => fetchDue(p, w.now, v));
  const upload = untried.slice(0, quota);
  if (uploaded.length || upload.length) out.gate = { who: 'transcriber', why: 'the automatic transcription try' };
  // Outside the start hours the try waits, before anything else: the busy profile's time counts only inside them.
  if ((upload.length || due.length) && !inVideoHours(w.now, w.settings)) {
    out.notes.push(`the automatic try waits for the start hours (${w.settings.limits?.startHours ?? '10-22'}): no browser opens outside them`);
    return out;
  }
  if (busyTooLong(l, w.now, w.settings)) return block(`the transcriber's browser profile stayed in use by another run for more than ${v.transcriptHours} h of the start hours (video.transcriptHours)`);
  if (upload.length || due.length) out.steps.push(step('videoTry', { parts: upload.map((p) => p.file), ...(due.length ? { fetch: due.map((p) => p.file) } : {}) }));
  if (untried.length > upload.length) out.notes.push(`${untried.length - upload.length} part(s) wait for tomorrow: ${v.partsPerDay} a day`);
  if (uploaded.length > due.length) out.notes.push(`${uploaded.length - due.length} uploaded part(s) wait for their transcript (looked for every ${v.fetchMinutes} min)`);
  return out;
}

// For a card that counts as a ticket but has no ledger (a lost ledger, or one the pipeline never had): the state the
// tracker and the forge show. Such a ticket is the owner's (mode hand) until `ticket-state handover`.
export function rebuiltState(card, prViews) {
  const status = card.status;
  if (status === 'ready') return 'ready';
  if (status === 'blocked') return 'questions';
  if (status === 'smeReview') return 'smeReview';
  if (status === 'finalReview' || status === 'translation') return prViews.length && prViews.every((p) => p.state === 'merged') ? 'merged' : status;
  if (status === 'inProgress') return prViews.some((p) => p.state === 'open') ? 'writing' : 'planning';
  if (status === 'done' || status === 'outOfScope') return 'closed';
  if (status === 'intake') return 'new';
  return 'outside';
}
