import { CARD_STATUS_OF, CHAIN, IN_PROGRESS, PR_ORDER, PR_STAGE_OF_STATUS, ROLE_OF, WAITING } from './stages.mjs';
import { prId } from './ledger.mjs';

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
//    8-12 per PR: a hand edit; placesWait with a review requested; placesWait with no open place; new comments;
//         finalReview: the first chain stage not done for the head
//   13 videoGate                                      the automatic try, the fallback, or the import
//   14 ready and a free slot                          start (the `startable` groups, see limits.mjs)
//   15 otherwise                                      the state's own next step
//
// Over every row: a step whose last session failed runs again only after a person acted on the ticket (a move, a
// comment, a review, a hand commit) or the owner re-armed it with `set`; until then it waits for the next morning run,
// and after two failed sessions with no such action between them the ticket is held for the owner. A ready ticket's
// failed start (row 14) is held or waits the same way.

export const step = (stage, extra = {}) => ({ stage, role: ROLE_OF[stage] ?? null, ...extra });

// The start of a ticket whose card is in work, with its origin (`startedBy`, which the brief passes on). The runner
// records a start before its session, with its origin: such a start goes on as it was started (`again`), whoever moved
// the card since (the session itself, or a person giving the failed start one more try). With no start recorded, a
// person took the card into work by hand: a manual start, out of the limits for the ticket's whole life (`byHand`).
const startStep = (l, extra = {}) => (l.stages?.start && l.startedBy ? step('start', { again: true, startedBy: l.startedBy, ...extra }) : step('start', { byHand: true, startedBy: 'manual', ...extra }));

// A start recorded but not done whose card is still in the ready status: the start didn't happen (its session failed
// or died before the move), so the ticket is still ready.
const startNotMoved = (l, status) => l.stage === 'start' && Boolean(l.stages?.start) && l.stages.start.status !== 'done' && status === 'ready';

const rank = (stage) => PR_ORDER.indexOf(stage);
const dayOf = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// The ticket-level stages a ticket goes through before its PRs open, in order. A stage counts as done after another
// when its record was made later (`seq`).
const doneAfter = (l, stage, after) => l.stages?.[stage]?.status === 'done' && (!after || (l.stages?.[after]?.status === 'done' && l.stages[stage].seq > l.stages[after].seq));

function runningStage(l) {
  for (const [stage, rec] of Object.entries(l.stages ?? {})) if (rec?.status === 'running') return { stage };
  for (const pr of l.prs ?? []) {
    for (const [stage, rec] of Object.entries({ ...(pr.chain ?? {}), ...(pr.steps ?? {}) })) if (rec?.status === 'running') return { stage, pr: prId(pr) };
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
  if (['videoGate', 'videoTry', 'videoBlock'].includes(last) && l.stages?.videoGate?.status === 'done') return 'videoGate';
  if (l.stages?.write?.status === 'done' || ['write', 'uaReview', 'pr'].includes(last)) return 'writing';
  if (['start', 'plan', 'answers', 'planApproval', 'videoImport'].includes(last)) return 'planning';
  return 'card';
}

// The next writer or reviewer stage before the PR: plan, then write, then the UA review, then the PR.
function preparationStep(l) {
  if (l.stages?.plan?.status !== 'done') return l.stages?.start?.status === 'done' ? step('plan') : startStep(l);
  const resumed = ['answers', 'planApproval', 'videoImport'].filter((s) => l.stages?.[s]?.status === 'done').map((s) => l.stages[s].seq);
  const lastResume = resumed.length ? Math.max(...resumed) : 0;
  const writeRec = l.stages?.write;
  if (!writeRec || writeRec.status !== 'done' || writeRec.seq < lastResume) return step('write');
  if (!doneAfter(l, 'uaReview', 'write')) return step('uaReview');
  if (!doneAfter(l, 'pr', 'uaReview')) return step('pr');
  return null;
}

const openPlaces = (l, pr) => (l.places ?? []).filter((p) => p.repo === pr.repo && Number(p.pr) === Number(pr.number) && (p.state ?? 'open') === 'open').length;

const GATES = {
  needsInfo: { who: 'team', why: 'a person removes the needs-info label' },
  questions: { who: 'owner', why: 'answers on the card, then the card back to In progress' },
  planGate: { who: 'owner', why: 'the section plan: moving the card back approves it' },
  placesWait: { who: 'owner', why: 'answer the places in their threads, or request a reviewer' },
  reworkWait: { who: 'owner', why: 'a person moved the card back to In progress' },
  smeReview: { who: 'reviewer', why: 'the review, then a person moves the card' },
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
      t.gate = { who: 'owner', why: `${failed.stage}${failed.pr ? ` on ${failed.pr}` : ''} ${failed.noSession ? `failed ${failed.sessions === 2 ? 'twice' : `${failed.sessions} times`} with no one acting in between, the last time before any session started (${failed.noSession.slice(0, 200)})` : `failed in ${failed.sessions} sessions with no one acting in between`}: a comment on the card or the PR gives it one more try (so do a review, a commit, a move of the card, or \`ticket-state set retry ${l.key}\`)` };
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
// and whether a person acted since the last of them. A session that ended on a busy browser lock (`busy`) is neither a
// failure nor a success: the one before it counts.
function failedStep(l, w, steps) {
  const last = (l.runs ?? []).findLast((r) => r.outcome !== 'busy');
  const s = steps[0];
  if (!s || last?.outcome !== 'failed' || !last.after || last.stage !== s.stage || (last.pr ?? null) !== (s.pr ?? null)) return null;
  const sessions = last.failures ?? 1;
  const acted = actedAfter(l, w, last.after);
  // A failure with no session (no `start`: a worktree that couldn't be made or was stuck) says so, with its reason.
  return { stage: last.stage, ...(last.pr ? { pr: last.pr } : {}), at: last.after.at, sessions, ...(last.start ? {} : { noSession: String(last.note ?? 'no session started') }), ...(acted ? { acted } : { held: sessions >= 2 }) };
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

function derive(l, w) {
  const out = { state: null, steps: [], gate: null, mismatch: [], notes: [], prs: [] };
  const card = w.card;
  const status = card?.status ?? null;

  const prs = (l.prs ?? []).map((pr) => {
    const world = pr.number ? w.prWorld?.get(`${l.key}/${prId(pr)}`) ?? null : null;
    const merged = Boolean(pr.merged) || world?.state === 'merged';
    return { pr, world, merged, closed: world?.state === 'closed', stage: merged ? 'merged' : pr.stage };
  });
  out.prs = prs.map((p) => ({ id: prId(p.pr), repo: p.pr.repo, number: p.pr.number, url: p.pr.url ?? p.world?.url ?? null, review: p.pr.review, stage: p.stage, state: p.merged ? 'merged' : p.world?.state ?? null, labels: p.world?.labels ?? null, head: p.world?.headCommit ?? null, next: null }));
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
    // The card stands where the least advanced PR is. If the pipeline left it elsewhere, it moves it.
    const expected = CARD_STATUS_OF[PR_ORDER[least]];
    if (expected && expected !== status && card.list?.id === l.left?.list?.id && !out.steps.some((s) => s.stage === 'move' && !s.pr)) {
      out.steps.unshift(step('move', { to: expected, card: true }));
    }
    return out;
  }

  // Row 13.
  if (phase === 'videoGate') return videoGate(l, w, out, status);

  // Row 15 (row 14 is the startable groups).
  if (phase === 'planning' || phase === 'writing') {
    const s = preparationStep(l);
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
    // the runner's own start session moved (or a person moved after that start failed) goes on as that start.
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
      } else out.steps.push(step('videoImport'));
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
  out.state = to === 'finalReview' ? 'finalReview' : to === 'smeReview' ? 'smeReview' : to === 'inProgress' ? 'reworkWait' : stateOf(l, prs, to, phase);
  out.steps.push(step('follow', { to, ...(PR_STAGE_OF_STATUS[to] ? { prStage: PR_STAGE_OF_STATUS[to] } : {}) }));
  return out;
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
  // Row 8: commits the pipeline didn't make (neither in pipelineCommits nor from the base).
  const hand = handCommits(pr, head, w);
  if (hand === null) out.notes.push(`${id}: the head ${String(head ?? '').slice(0, 7)} is not fetched here: hand edits and stale chain stages are not checked`);
  else {
    if (hand.length) {
      if (pr.readyForMerge?.length) {
        // A hand commit after ready for merge: the re-sync, then the visual pack if it changed an image, then ready again.
        const after = handAfterReady(pr, p, w, target, head, hand.length, out);
        if (after) return after;
      } else out.mismatch.push(`${id}: ${hand.length} commit(s) on the branch the pipeline didn't make: a hand edit, kept; the next stage reads the branch`);
    }
  }
  // The approval (the SME review, or the places settled) saw a head; a word change in UA since then is reported. An
  // id-only change (heading ids, link fragments) keeps it (D-073).
  if (pr.approval?.head && head && pr.approval.head !== head && ['finalReview', 'readyForMerge'].includes(p.stage)) {
    const roots = uaRoots(pr, w, target);
    const changed = w.git?.changedUnder(target, pr.approval.head, head, roots) ?? null;
    const v = out.prs.find((x) => x.id === id);
    if (changed?.length) {
      v.approvalStale = changed.length;
      out.mismatch.push(`${id}: ${changed.length} UA page(s) changed after the approval at ${String(pr.approval.head).slice(0, 7)}: the review saw another text`);
    } else if (changed) v.approvalStale = 0;
  }
  // Row 9.
  if (p.stage === 'placesWait' && world.reviewRequests.length) return step('move', { pr: id, to: 'smeReview' });
  // Row 10.
  if (p.stage === 'placesWait' && openPlaces(l, pr) === 0) return step('move', { pr: id, to: 'finalReview' });
  // Row 11.
  if (world.newComments?.length) {
    const owner = world.newComments.filter((c) => c.by === 'owner').length;
    return step('answerComments', { pr: id, comments: world.newComments.length, owner, reviewer: world.newComments.length - owner });
  }
  // Two PRs: an approved PR goes on by itself while the card stands where the slower PR is.
  if (p.stage === 'smeReview' && world.reviewDecision === 'APPROVED' && prs.some((o) => o !== p && rank(o.stage) < rank(p.stage))) {
    return step('move', { pr: id, to: 'finalReview', approved: true });
  }
  // Row 12.
  if (p.stage === 'finalReview') return chainStep(l, p, w, out, target, head);
  return null;
}

// Row 8 after ready for merge: the hand commit's blocks re-synced (`resync`), then, when an image changed since the
// visual pack saw the branch, the pack again (`visualPack`), and only then `readyForMerge` for the new head.
function handAfterReady(pr, p, w, target, head, commits, out) {
  const id = prId(pr);
  if (pr.readyForMerge.at(-1).head === head) return null;
  const synced = pr.steps?.resync?.status === 'done' && pr.steps.resync.head === head;
  if (!synced) return step('resync', { pr: id, head, commits });
  const pack = pr.chain?.visualPack;
  if (pack?.head && pack.head !== head) {
    const images = w.git?.imagesChanged?.(target, pack.head, head) ?? null;
    if (images === null) out.notes.push(`${id}: the visual pack saw ${String(pack.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare their images`);
    else if (images.length) return step('visualPack', { pr: id, head, images: images.length });
  }
  return p.stage === 'readyForMerge' ? step('readyForMerge', { pr: id, head }) : null;
}

// The first chain stage not done for the current head. UA pages changed after a stage's head make it (and so every
// later stage) stale. EN changed by hand is never translated over: only UA changes make a stage stale.
function chainStep(l, p, w, out, target, head) {
  const { pr } = p;
  const id = prId(pr);
  const roots = uaRoots(pr, w, target);
  for (const stage of CHAIN) {
    const rec = pr.chain?.[stage];
    if (!rec || rec.status !== 'done') return step(stage, { pr: id, head });
    if (rec.head && head && rec.head !== head) {
      const changed = w.git?.changedUnder(target, rec.head, head, roots) ?? null;
      if (changed === null) out.notes.push(`${id}: ${stage} saw ${String(rec.head).slice(0, 7)}, the head is ${String(head).slice(0, 7)}, and git here can't compare them`);
      else if (changed.length) return step(stage, { pr: id, head, stale: changed.length });
    }
  }
  if (!(pr.readyForMerge ?? []).some((r) => r.head === head)) return step('readyForMerge', { pr: id, head });
  return null;
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

// Row 13: the video gate. Parts not yet tried go to the automatic try, as many as the day allows; a failed try (or no
// automatic try configured) falls back to the gate: the card to Blocked with the gate comment, the parts in the
// report. Once every part has its transcript: the import.
function videoGate(l, w, out, status) {
  const v = w.settings.video;
  const parts = (l.video?.videos ?? []).flatMap((x) => x.parts ?? []);
  const missing = missingParts(l, w);
  if (!missing.length) {
    out.steps.push(step('videoImport', { parts: parts.length }));
    return out;
  }
  const tz = undefined; // the machine's own zone: the day the owner lives in
  const today = dayOf(w.now, tz);
  const tries = parts.flatMap((p) => p.tries ?? []);
  const triedToday = tries.filter((t) => t.at && dayOf(Date.parse(t.at), tz) === today).length;
  const late = (t) => t.outcome === 'uploaded' && w.now - Date.parse(t.at) > v.transcriptHours * 3600000;
  const failed = missing.filter((p) => (p.tries ?? []).some((t) => t.outcome === 'failed' || late(t)));
  const untried = missing.filter((p) => !(p.tries ?? []).length);
  const quota = Math.max(0, v.partsPerDay - triedToday);
  out.gate = { who: 'owner', why: `transcripts of ${missing.length} video part(s)` };
  if (failed.length || !v.browserProfile) {
    if (status !== 'blocked') out.steps.push(step('videoBlock', { reason: failed.length ? 'the automatic try failed' : 'no automatic try configured (video.browserProfile)' }));
    return out;
  }
  if (untried.length && quota > 0) {
    out.gate = { who: 'transcriber', why: 'the automatic transcription try' };
    out.steps.push(step('videoTry', { parts: untried.slice(0, quota).map((p) => p.file) }));
  } else if (untried.length) out.notes.push(`${untried.length} part(s) wait for tomorrow: ${v.partsPerDay} a day`);
  return out;
}

// For a card that counts as a ticket but has no ledger (a lost ledger, or one the pipeline never had): the state the
// tracker and the forge show. Such a ticket is the owner's (mode hand) until `ticket-state handover`.
export function rebuiltState(card, prViews) {
  const status = card.status;
  if (status === 'ready') return 'ready';
  if (status === 'blocked') return 'questions';
  if (status === 'smeReview') return 'smeReview';
  if (status === 'finalReview') return prViews.length && prViews.every((p) => p.state === 'merged') ? 'merged' : 'finalReview';
  if (status === 'inProgress') return prViews.some((p) => p.state === 'open') ? 'writing' : 'planning';
  if (status === 'done' || status === 'outOfScope') return 'closed';
  if (status === 'intake') return 'new';
  return 'outside';
}
