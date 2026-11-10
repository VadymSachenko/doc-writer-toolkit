import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError, Refused } from './errors.mjs';
import { checkKey, findPr, keyOf, newLedger, newPr, prId, readLedger, writeLedger } from './ledger.mjs';
import { lockOf, renewLock } from './locks.mjs';
import { CARD_STATUS_OF, CHAIN, LABEL_OF, PR_ORDER, PR_STAGE_OF_STATUS, PR_STAGES, STATUSES, TICKET_STAGES, followsMove, forwardMove, stageLabelOf } from './stages.mjs';
import { labelCheck } from './intake.mjs';
import { KINDS, recordedSize } from './cleanup.mjs';
import { imagePairsAt } from './pairs.mjs';
import { writtenIn } from './worktree.mjs';
import { addEdits, addEnSides } from './edits.mjs';

// `record <key> --stage <s> --status running|done|failed`: one stage result, written only when the tracker, the forge
// and the files support it (context/ticket-flow.md, "When a record is accepted"). On any problem nothing is written.

const PR_ONLY = new Set([...CHAIN, 'answerComments', 'styleCheck', 'readyForMerge', 'resync']);
// Never `translation`: only `follow`, a person's move of the card, takes a PR there.
const PR_TARGET_STAGES = ['writing', 'reworkWait', 'smeReview', 'finalReview', 'questions'];
const VERDICTS = ['docs-required', 'needs-info', 'out-of-scope', 'already-documented', 'duplicate', 'manual-out-of-scope', 'owner-card'];

export const blobHash = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
export function fileHash(root, rel) {
  try {
    return blobHash(fs.readFileSync(path.resolve(root, rel)));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}

function json(value, flag) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    const v = JSON.parse(value);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    throw new CliError(`--${flag} must be a JSON object: ${e.message}`, { code: 2 });
  }
}

const brief = (card) => ({ status: card.status, list: { id: card.list?.id ?? null, name: card.list?.name ?? null } });
const addAll = (list, items) => {
  for (const x of items ?? []) if (x !== null && x !== undefined && !list.map(String).includes(String(x))) list.push(x);
  return list;
};

export async function runRecord({ settings, clients, key: keyIn, stage, status, pr: prRef, to, head, result: resultIn, run: runIn, note, card: cardRef, startedBy, now = Date.now() }) {
  const key = checkKey(keyIn);
  if (stage === undefined && status === undefined && runIn !== undefined) return appendRun(settings, key, json(runIn, 'run'), prRef, now);
  if (![...TICKET_STAGES, ...PR_STAGES].includes(stage)) throw new CliError(`unknown stage '${stage}'. Ticket stages: ${TICKET_STAGES.join(', ')}. PR stages (with --pr): ${PR_STAGES.join(', ')}.`, { code: 2 });
  if (!STATUSES.includes(status)) throw new CliError(`--status must be ${STATUSES.join(', ')}`, { code: 2 });
  if (PR_ONLY.has(stage) && !prRef) throw new CliError(`${stage} is a PR stage: name the PR with --pr <repo>#<number>`, { code: 2 });
  if (status === 'failed' && !note) throw new CliError('a failed record needs --note with the reason', { code: 2 });
  if (startedBy !== undefined && !['schedule', 'manual'].includes(startedBy)) throw new CliError('--started-by must be schedule or manual', { code: 2 });
  const result = json(resultIn, 'result') ?? {};
  const run = json(runIn, 'run');
  const at = new Date(now).toISOString();

  let ledger = readLedger(settings.state, key);
  // The tracker client is made on first use: a record refused before it needs the tracker needs no credentials.
  const tracker = { findCards: (a) => clients.tracker.findCards(a), readCard: (a) => clients.tracker.readCard(a), hasMember: (a) => clients.tracker.hasMember(a) };
  const cardNow = async (ref) => {
    const r = await tracker.findCards({ link: ref });
    if (!r.cards[0]) throw new Refused('card', `the tracker has no card ${ref}`);
    return r.cards[0];
  };
  if (!ledger) {
    if (!['triage', 'start'].includes(stage) || !cardRef) throw new Refused('noLedger', `ticket ${key} has no ledger; only triage or start with --card creates one`);
    const card = await cardNow(cardRef);
    if (keyOf(card) !== key) throw new CliError(`the card's key is ${keyOf(card)}, not ${key}`, { code: 2 });
    ledger = newLedger({ key, card, now: at });
    // The runner's record of a start before its session, for a ready card with no ledger: where the card was (row 6
    // compares it), and the triage `status` read for it (`result.triage`), as a triage record would have left them.
    if (stage === 'start' && status !== 'done') {
      ledger.left = { ...brief(card), at };
      if (result.triage && typeof result.triage === 'object') ledger.triage = { ...result.triage, at };
    }
  }
  const l = structuredClone(ledger);
  const pr = prRef ? findPr(l, prRef) : null;
  const ref = l.card?.shortLink ?? l.card?.id;
  const needCard = async (...statuses) => {
    const card = await cardNow(ref);
    if (!statuses.includes(card.status)) throw new Refused('card', `the card is in '${card.list?.name ?? card.status}' (${card.status ?? 'outside the flow'}), not ${statuses.join(' or ')}`, { status: card.status });
    return card;
  };
  const forgeHead = async (p) => {
    const st = await clients.forge.prState({ repo: p.repo, number: p.number });
    return st;
  };
  const record = { status, seq: l.seq + 1, at, ...(note ? { note } : {}), ...(Object.keys(result).length ? { result } : {}) };
  const warnings = [];

  if (status === 'done') await applyDone();
  else if (status === 'running' && pr && (CHAIN.includes(stage) || ['answerComments', 'styleCheck', 'resync', 'readyForMerge'].includes(stage))) {
    const st = pr.number ? await forgeHead(pr) : null;
    if (st) record.head = st.headCommit;
  }

  // Where the record goes: a PR's chain or steps, or the ticket's stages.
  if (pr && (CHAIN.includes(stage))) pr.chain[stage] = { ...record, ...(pr.chain[stage]?.head && status !== 'done' && !record.head ? { head: pr.chain[stage].head } : {}) };
  else if (pr && PR_STAGES.includes(stage)) pr.steps[stage] = record;
  else {
    l.stages[stage] = record;
    l.stage = stage;
  }
  l.seq += 1;
  l.updatedAt = at;
  l.log.push({ seq: l.seq, at, stage, ...(pr ? { pr: prId(pr) } : {}), outcome: status, ...(record.note ? { note: record.note } : {}) });
  if (run) l.runs.push({ seq: l.seq, stage, ...(pr ? { pr: prId(pr) } : {}), ...run });
  const posted = result.posted;
  if (Array.isArray(posted)) addAll(l.posted.pr, posted.map((p) => (typeof p === 'object' ? p.id : p)));
  else if (posted && typeof posted === 'object') {
    addAll(l.posted.card, posted.card);
    addAll(l.posted.pr, (posted.pr ?? []).map((p) => (typeof p === 'object' ? p.id : p)));
  }
  if (pr && Array.isArray(result.commits)) addAll(pr.pipelineCommits, result.commits);
  for (const f of result.files ?? []) addFile(f.path, f.kind, stage, f.bytes);
  if (startedBy && stage === 'start') l.startedBy = startedBy;
  // The group a start runs with, whatever its status: the runner's record before the session puts the ticket under the
  // group's lock at once.
  if (stage === 'start' && result.group) l.group = String(result.group);

  const file = writeLedger(settings.state, l);
  const lock = renewLock(settings.state, l.group, { leaseMinutes: settings.limits.lockLeaseMinutes, stage: status === 'running' ? stage : undefined, now });
  return { file: path.relative(settings.root, file), key, stage, status, ...(pr ? { pr: prId(pr) } : {}), seq: l.seq, lockRenewed: Boolean(lock), ...(warnings.length ? { warnings } : {}) };

  // ------------------------------------------------------------------ what `done` checks, and what it changes

  async function applyDone() {
    switch (stage) {
      case 'triage': {
        if (!VERDICTS.includes(result.verdict)) throw new CliError(`triage needs --result {"verdict": …}, one of ${VERDICTS.join(', ')}`, { code: 2 });
        for (const k of ['together', 'separate']) if (result[k] !== undefined && !Array.isArray(result[k])) throw new CliError(`triage: ${k} must be a list of ticket numbers`, { code: 2 });
        const card = await cardNow(ref);
        if (result.movedTo && card.status !== result.movedTo) throw new Refused('card', `the triage moved the card to ${result.movedTo}, but it is in ${card.status}`);
        // Labels confirm; a missing app label alone is no reason for needs-info when the text settles the target.
        if (result.verdict === 'needs-info' && result.reason === 'noAppLabel') {
          const check = labelCheck(await tracker.readCard({ card: card.id }), settings, null);
          if (check.settled) throw new Refused('textSettles', `the card has no app label, but its text names ${check.targets.join(', ')}: triage it from the text`, { targets: check.targets });
        }
        // The owner on every card the triage moved into the ready status (`tracker.owner`), by the record itself, so no
        // session has to: one already on the card is no change, and a failure to add is a warning, never a refusal.
        if (result.movedTo === 'ready' && card.status === 'ready' && settings.tracker.owner) {
          try {
            const added = await clients.tracker.addMember({ card: card.id, member: 'owner' });
            if (added.changed) result.ownerAdded = true;
          } catch (e) {
            warnings.push(`the owner (${settings.tracker.owner}) was not added to the card: ${e.message}`);
          }
        }
        l.triage = { ...result, at, priority: card.priority ?? 'medium' };
        l.priority = card.priority ?? 'medium';
        l.left = { ...brief(card), at };
        return;
      }
      case 'start': {
        const card = await needCard('inProgress');
        if (!l.triage) l.triage = { verdict: result.verdict ?? 'owner-card', targets: result.targets ?? [], size: result.size ?? null, at };
        // Who started it: the record's own --started-by, else the origin already recorded (the runner's record before
        // the session), else the live lock's kind, else manual.
        if (!startedBy && !l.startedBy) {
          const lock = lockOf(settings.state, result.group ? String(result.group) : l.group, now);
          l.startedBy = lock?.live ? lock.kind : 'manual';
        }
        l.left = { ...brief(card), at };
        return;
      }
      case 'plan': {
        l.plan = { ...(l.plan ?? {}), ...result, at };
        for (const p of result.prs ?? []) upsertPr(p);
        if (result.size) l.triage = { ...(l.triage ?? {}), size: result.size };
        return;
      }
      case 'questions': {
        const card = await needCard('blocked');
        for (const q of result.questions ?? []) l.questions.push({ ...q, askedAt: q.askedAt ?? at, ...(pr ? { repo: pr.repo, pr: pr.number } : {}) });
        if (pr) {
          if (pr.stage !== 'questions') pr.resumeTo = pr.stage;
          pr.stage = 'questions';
        }
        l.left = { ...brief(card), at };
        return;
      }
      case 'answers': {
        const card = await needCard('inProgress');
        for (const q of l.questions) if (!q.answer && (!pr || (q.repo === pr.repo && Number(q.pr) === Number(pr.number)))) q.answer = { at, ...(result.answer ?? {}) };
        if (pr) {
          // A question asked during the chain: the answer may change the text, so the owner reads it and moves the card again.
          pr.stage = pr.resumeTo === 'translation' ? 'finalReview' : pr.resumeTo ?? 'finalReview';
          pr.resumeTo = null;
        }
        if (result.withoutVideo && l.video) l.video.skipped = { at, reason: 'the card came back before every transcript' };
        l.left = { ...brief(card), at };
        return;
      }
      case 'planGate': {
        const card = await needCard('blocked');
        if (!result.planFile) throw new CliError('planGate needs --result {"planFile": "<the plan file, from the host root>"}', { code: 2 });
        const hash = fileHash(settings.root, result.planFile);
        if (!hash) throw new Refused('file', `the plan file ${result.planFile} does not exist`);
        l.plan = { ...(l.plan ?? {}), sectionPlan: { file: result.planFile, hash, commentId: result.commentId ?? null, approved: null } };
        l.left = { ...brief(card), at };
        return;
      }
      case 'planApproval': {
        const card = await needCard('inProgress');
        const sp = l.plan?.sectionPlan;
        if (!sp) throw new Refused('noGate', 'no section plan gate was recorded');
        const hash = fileHash(settings.root, sp.file);
        if (hash !== sp.hash) throw new Refused('planChanged', `${sp.file} changed since the gate: a new plan is a new gate`, { file: sp.file });
        sp.approved = { hash, at };
        l.left = { ...brief(card), at };
        return;
      }
      case 'videoGate': {
        const videos = result.videos;
        for (const v of videos ?? []) {
          if (v.file) addFile(v.file, 'video', stage);
          for (const p of v.parts ?? []) if (p.file && p.file !== v.file) addFile(p.file, 'videoPart', stage);
        }
        if (!Array.isArray(videos) || !videos.length || videos.some((v) => !Array.isArray(v.parts) || !v.parts.length)) {
          throw new CliError('videoGate needs --result {"videos": [{ "file", "parts": [{ "file", "start", "transcript" }] }], "gateComment": "…"}', { code: 2 });
        }
        l.video = { videos: videos.map((v) => ({ ...v, parts: v.parts.map((p) => ({ tries: [], askedAt: null, ...p })) })), gateComment: result.gateComment ?? null, commentId: null, at };
        return;
      }
      case 'videoTry': {
        // An upload: a try, `uploaded` (with the name the service lists it by) or `failed`. A look for its transcript
        // (`fetch`): `waiting` or `done` is a look (`checks`); `failed` is a try, marked `fetch`, so the gate falls back.
        if (!l.video) throw new Refused('noGate', 'no video gate was recorded');
        for (const r of result.parts ?? []) {
          const part = l.video.videos.flatMap((v) => v.parts).find((p) => p.file === r.file);
          if (!part) throw new CliError(`no video part ${r.file}`, { code: 2 });
          const outcomes = r.fetch ? ['done', 'waiting', 'failed'] : ['uploaded', 'failed'];
          if (!outcomes.includes(r.outcome)) throw new CliError(`a video part's ${r.fetch ? 'fetch' : 'upload'} outcome is one of ${outcomes.join(', ')}`, { code: 2 });
          if (r.fetch && r.outcome !== 'failed') {
            if (r.outcome === 'done' && !(part.transcript && fs.existsSync(path.resolve(settings.root, part.transcript)))) throw new Refused('file', `the transcript of ${part.file} is not at ${part.transcript}`, { file: part.transcript });
            (part.checks ??= []).push({ at, outcome: r.outcome });
          } else part.tries.push({ at, outcome: r.outcome, ...(r.fetch ? { fetch: true } : {}), ...(r.reason ? { reason: String(r.reason).slice(0, 300) } : {}), ...(typeof r.ref?.name === 'string' ? { ref: { name: r.ref.name } } : {}) });
          if (r.outcome === 'done' || r.transcript) {
            if (r.transcript) part.transcript = r.transcript;
            addFile(part.transcript, 'transcript', stage);
          }
        }
        return;
      }
      case 'videoExtract': {
        // The runner's frame sweep with every part's transcript: per video, its package (the merged transcript, the
        // context) and the frames folder the import's session reads.
        if (!l.video) throw new Refused('noGate', 'no video gate was recorded');
        const missing = l.video.videos.flatMap((v) => v.parts).filter((p) => !p.transcript || !fs.existsSync(path.resolve(settings.root, p.transcript)));
        if (missing.length) throw new Refused('file', `${missing.length} part(s) have no transcript file yet`, { parts: missing.map((p) => p.file) });
        if (!Array.isArray(result.videos) || !result.videos.length) throw new CliError('videoExtract needs --result {"videos": [{ "file", "package", "transcript", "frames" }]}', { code: 2 });
        for (const x of result.videos) {
          const v = l.video.videos.find((y) => y.file === x.file);
          if (!v) throw new CliError(`no video ${x.file}`, { code: 2 });
          for (const k of ['transcript', 'frames']) if (!x[k] || !fs.existsSync(path.resolve(settings.root, x[k]))) throw new Refused('file', `the ${k} of ${x.file} is not at ${x[k]}`, { file: x[k] ?? null });
          v.extract = { at, package: x.package, transcript: x.transcript, frames: x.frames, ...(x.context ? { context: x.context } : {}) };
          if (x.package) addFile(x.package, 'runDir', stage);
          addFile(x.frames, 'frames', stage);
        }
        return;
      }
      case 'videoBlock': {
        const card = await needCard('blocked');
        if (!l.video) throw new Refused('noGate', 'no video gate was recorded');
        l.video.blockedAt = at;
        if (result.commentId) l.video.commentId = result.commentId;
        for (const p of l.video.videos.flatMap((v) => v.parts)) if (!p.askedAt && result.asked?.includes(p.file)) p.askedAt = at;
        l.left = { ...brief(card), at };
        return;
      }
      case 'videoImport': {
        const card = await needCard('inProgress');
        const missing = (l.video?.videos ?? []).flatMap((v) => v.parts).filter((p) => !p.transcript || !fs.existsSync(path.resolve(settings.root, p.transcript)));
        if (missing.length) throw new Refused('file', `${missing.length} part(s) have no transcript file yet`, { parts: missing.map((p) => p.file) });
        l.video.importedAt = at;
        for (const p of l.video.videos.flatMap((v) => v.parts)) addFile(p.transcript, 'transcript', stage);
        l.left = { ...brief(card), at };
        return;
      }
      case 'write':
      case 'uaReview': {
        for (const p of result.prs ?? []) upsertPr(p);
        if (stage === 'write') {
          // The PRs the write names, each with commits in its worktree, pushed as they are: pages written into an owner's
          // checkout, or a worktree left untouched, are no write (lib/worktree.mjs, `writtenIn`).
          if (!(result.prs ?? []).length) throw new Refused('noPr', 'write done needs the PRs it wrote for: --result {"prs": [{ "repo", "targets", "review", "branch", "base", "commits" }]}');
          for (const e of result.prs) {
            const w = writtenIn(settings, l.prs.find((x) => x.repo === e.repo && x.branch === e.branch));
            if (w.error) throw new Refused('notWritten', `${e.repo} ${e.branch}: ${w.error}`);
          }
        }
        return;
      }
      case 'pr': {
        const entries = result.prs ?? [];
        if (!entries.length) throw new CliError('pr needs --result {"prs": [{ "branch", "number", "url", "expertReview" }], "places": [...]}', { code: 2 });
        // Whether the writer recommends an expert review, and why: the owner decides; nothing waits on it. The PR and its
        // comments are already posted, so a missing or malformed one is recorded as null with a warning, not refused.
        const expertOf = (e) => {
          const x = e.expertReview;
          if (x && typeof x.recommended === 'boolean' && typeof x.why === 'string' && x.why.trim()) return { recommended: x.recommended, why: x.why.trim(), at };
          warnings.push(`${e.branch}: no "expertReview": { "recommended": true|false, "why": "<the open questions for the expert, or the facts not found in the code or the UI; or why none is needed>" }; recorded as null`);
          return null;
        };
        for (const e of entries) {
          const p = l.prs.find((x) => x.branch === e.branch && (!e.repo || x.repo === e.repo));
          if (!p) throw new CliError(`no PR entry for the branch ${e.branch}; the write record names the branches`, { code: 2 });
          p.number = Number(e.number);
          const st = await clients.forge.prState({ repo: p.repo, number: p.number }).catch((err) => {
            throw new Refused('noPr', `${p.repo}#${e.number} is not on the forge: ${err.message}`);
          });
          if (st.head !== p.branch) throw new Refused('noPr', `${p.repo}#${p.number} is the PR of ${st.head}, not ${p.branch}`);
          p.url = st.url;
          p.lastSeenHead = st.headCommit;
          p.label = (st.labels ?? []).find((x) => Object.values(targetOf(p)?.labels ?? {}).some((y) => y.toLowerCase() === x.toLowerCase())) ?? null;
          addAll(p.reviewersRequested, e.reviewersRequested);
          addAll(p.pipelineCommits, e.commits);
          p.expertReview = expertOf(e);
          // The numbered change list of the description (the UA review's fixes), from 1.
          warnings.push(...addEdits(p, e.edits, { list: 'description', stage, at, seq: l.seq + 1 }).map((x) => `${prId(p)}: ${x}`));
          // The description's questions (D-142), numbered from 1, and the first round: the draft and the UA review's
          // commits, and the review of the places' line comments. The runner writes the description's sections from them.
          // Only with review rounds (the host's `forge.reviewRounds`); there the questions are required (`[]` when none),
          // so the runner's section never replaces questions the session wrote with "none".
          if (settings.reviewRounds) {
            if (!Array.isArray(e.questions)) throw new CliError(`pr: ${e.repo} ${e.branch}: "questions" is required with review rounds: the description's questions, [{ "text", "reader", "place"?, "why"?, "proposal"? }], or [] when there are none`, { code: 2 });
            p.questions = (p.questions ?? []).filter((q) => q.stage !== 'pr');
            addQuestions(p, e.questions);
            firstRound(p, e);
          }
          const asked =(st.reviewRequests ?? []).map((r) => r.login ?? r.team ?? r).filter((r) => !p.reviewersRequested.map(String).includes(String(r)));
          if (asked.length) warnings.push(`${p.repo}#${p.number} has review requests (${asked.join(', ')}): every PR opens with no reviewer, and the expert is called by a person's move`);
        }
        // The places' comments are posted before this record, so a place from the code with no reference at a commit is
        // not refused (a retry would post them again): the record stands, the session is told, and `status` reports it.
        for (const place of result.places ?? []) {
          const noRef = place.source === 'code' && !(Array.isArray(place.refs) && place.refs.length && place.refs.every((r) => r?.repo && r?.path && r?.lines && r?.commit));
          if (noRef) warnings.push(`place ${place.id ?? '?'} is from the code and has no reference with repo, path, lines and commit`);
          l.places.push({ state: 'open', at, ...place, pr: Number(place.pr), ...(noRef ? { noRef: true } : {}) });
          // Its line comment was posted from the owner's login: in `posted`, so it never reads as the owner's.
          addAll(l.posted.pr, [place.commentId]);
        }
        // Every PR to the owner's queue, whatever its review kind: the owner reads first and calls the expert if needed. A
        // recommended expert review puts `forge.expertLabel` on the PR, never taken off; a failure is a warning.
        for (const e of entries) {
          const p = l.prs.find((x) => x.branch === e.branch && (!e.repo || x.repo === e.repo));
          p.stage = 'finalReview';
          if (p.expertReview?.recommended && settings.forge.expertLabel) {
            try {
              await clients.forge.addLabel({ repo: p.repo, number: p.number, label: settings.forge.expertLabel });
            } catch (err) {
              warnings.push(`${p.repo}#${p.number}: the label '${settings.forge.expertLabel}' was not added: ${err.message}`);
            }
          }
        }
        return;
      }
      case 'move': {
        if (pr) {
          if (!PR_TARGET_STAGES.includes(to)) throw new CliError(`move --pr needs --to, a PR stage: ${PR_TARGET_STAGES.join(', ')}`, { code: 2 });
          const before = pr.stage;
          pr.stage = to;
          const expected = cardStatusFor(l);
          const card = await cardNow(ref);
          if (expected && card.status !== expected) {
            pr.stage = before;
            throw new Refused('card', `with ${prId(pr)} at ${to}, the card belongs in ${expected}, but it is in ${card.status}`);
          }
          const label = targetOf(pr)?.labels?.[LABEL_OF[to]];
          const st = await clients.forge.prState({ repo: pr.repo, number: pr.number });
          if (label) {
            if (!(st.labels ?? []).some((x) => x.toLowerCase() === label.toLowerCase())) throw new Refused('label', `${prId(pr)} lacks its stage label '${label}'`);
            pr.label = label;
          }
          // Who a move into or out of the review took along: a pending request then moves no card back (row 9).
          if (to === 'smeReview' || before === 'smeReview') addAll(pr.reviewersRequested, (st.reviewRequests ?? []).map((r) => r.login ?? r.team ?? r));
          // When the PR entered the expert's review: only an approval after it moves the PR on.
          if (to === 'smeReview' && before !== 'smeReview') pr.smeSince = at;
          // The expert's Approve moved it (D-082): the approval, at the head the expert approved.
          const ok = result.expertApproval;
          if (ok !== undefined) {
            if (before !== 'smeReview' || to !== 'finalReview' || !ok || typeof ok !== 'object' || !ok.head) throw new CliError('move: "expertApproval" goes with a move from smeReview to finalReview: { "id", "login", "head", "at" }', { code: 2 });
            pr.expertApproval = { head: String(ok.head), at: ok.at ?? at, by: 'reviewer', ...(ok.login ? { login: String(ok.login) } : {}), ...(ok.id !== undefined ? { review: ok.id } : {}) };
          }
          l.left = { ...brief(card), at };
          return;
        }
        if (!to) throw new CliError('move needs --to: a status (the card) or, with --pr, a PR stage', { code: 2 });
        const card = await needCard(to);
        l.left = { ...brief(card), at };
        return;
      }
      case 'follow': {
        if (!to) throw new CliError('follow needs --to, the status the card was moved to', { code: 2 });
        const card = await needCard(to);
        const from = l.left?.status;
        for (const p of l.prs) {
          // A PR ready for merge whose head moved since by the owner's own commits only (the rule names it in
          // `takeReady`, with the head it saw) goes along with a move to `translation` too: the move approves that
          // change, and the rule re-syncs it. A head that moved again since the rule looked stays, like a pipeline commit.
          const take = to === 'translation' && p.stage === 'readyForMerge' && !p.merged ? (result.takeReady ?? []).find((x) => x?.pr === prId(p)) : null;
          const headNow = p.number && take ? (await clients.forge.prState({ repo: p.repo, number: p.number })).headCommit : null;
          const moved = Boolean(headNow && headNow === take.head && p.readyForMerge?.at(-1)?.head && headNow !== p.readyForMerge.at(-1).head);
          if (p.number && (followsMove(p.stage, from, to) || moved)) {
            // The only UA approve: a person's move to `translation`. A later word change in UA is reported.
            if (to === 'translation') p.approval = { head: headNow ?? (await clients.forge.prState({ repo: p.repo, number: p.number })).headCommit, at, from: p.stage, by: 'person' };
            // Who a move into or out of the review took along: a pending request then moves no card back (row 9).
            if (to === 'smeReview' || p.stage === 'smeReview') {
              const st = await clients.forge.prState({ repo: p.repo, number: p.number });
              addAll(p.reviewersRequested, (st.reviewRequests ?? []).map((r) => r.login ?? r.team ?? r));
              // A person's move on from the expert's review is the approval, at the head now (D-082): a word of the
              // expert's elsewhere, recorded by the person who heard it.
              if (p.stage === 'smeReview' && (to === 'finalReview' || to === 'translation')) p.expertApproval = { head: st.headCommit, at, by: 'person' };
            }
            // When the PR entered the expert's review: only an approval after it moves the PR on.
            if (to === 'smeReview' && p.stage !== 'smeReview') p.smeSince = at;
            p.stage = PR_STAGE_OF_STATUS[to];
            const label = targetOf(p)?.labels?.[stageLabelOf(p.stage, targetOf(p))];
            if (label) p.label = label;
          }
        }
        if (to === 'done' || to === 'outOfScope') l.stages.close = { status: 'done', seq: l.seq + 1, at, note: `a person moved the card to ${card.list?.name ?? to}` };
        // A person's forward move: the owner's check is done, and the questions put to the owner with it (D-128).
        if (forwardMove(from, to)) for (const p of l.prs) if (to === 'done' || p.stage === 'translation') delete p.openQuestions;
        l.left = { ...brief(card), at };
        return;
      }
      case 'answerComments': {
        // A review round (D-142): two commits and one review with line comments instead of the summary.
        if (result.review !== undefined) {
          const round = roundOf(['comments', 'style']);
          for (const c of result.handled ?? []) l.reviewComments.push({ repo: pr.repo, pr: pr.number, at, ...c });
          warnings.push(...addEdits(pr, result.edits, { list: String(result.review.id), stage, at, seq: l.seq + 1 }));
          pr.openQuestions = { items: questionsOf(result, stage, { required: true }), stage, at, seq: l.seq + 1 };
          placesOf();
          descriptionOf();
          addRound(round);
          return;
        }
        for (const c of result.handled ?? []) l.reviewComments.push({ repo: pr.repo, pr: pr.number, at, ...c });
        // The notes are the style check's fixes left undone (they would change what an edit meant): in the summary
        // after its numbered list, never numbered.
        if (result.notes !== undefined && (!Array.isArray(result.notes) || (result.notes.length && !result.summary?.id))) throw new CliError('answerComments: "notes" is a list of { "page", "block", "text" } in the summary comment: give "summary": { "id" } too', { code: 2 });
        if (result.summary) l.summaries.push({ repo: pr.repo, pr: pr.number, at, ...result.summary, ...(result.notes?.length ? { notes: result.notes } : {}) });
        // The numbered list of the reply: the summary comment it was posted in, going on from the PR's last number.
        if (result.edits !== undefined && !result.summary?.id) throw new CliError('answerComments: "edits" are the numbered list of the summary comment: give "summary": { "id" } too', { code: 2 });
        warnings.push(...addEdits(pr, result.edits, { list: result.summary?.id, stage, at, seq: l.seq + 1 }));
        // The questions to the owner left open after this round: the summary's own and the earlier ones its comments
        // didn't answer (the brief lists them). The runner sets the check label from them.
        pr.openQuestions = { items: questionsOf(result, stage, { required: true }), stage, at, seq: l.seq + 1 };
        for (const u of result.places ?? []) {
          const place = l.places.find((p) => p.id === u.id && p.repo === pr.repo && Number(p.pr) === pr.number);
          if (place) Object.assign(place, u, { at });
        }
        return;
      }
      case 'styleCheck': {
        // The style check of hand commits (D-081, D-082): the shas it reviewed, so the rule asks for each only once
        // whatever the head; its fixes on the summary's numbered list; the notes in the summary.
        const reviewed = result.reviewed;
        if (!Array.isArray(reviewed) || !reviewed.length || reviewed.some((r) => !/^[0-9a-f]{7,40}$/.test(String(r?.sha ?? '')))) throw new CliError('styleCheck: "reviewed" lists every hand commit the check read: [{ "sha", "reason"? }], each sha as hex', { code: 2 });
        if (result.notes !== undefined && !Array.isArray(result.notes)) throw new CliError('styleCheck: "notes" is a list of { "page", "block", "text" }', { code: 2 });
        // A review round (D-142): the fixes in one commit and one review with line comments instead of the summary.
        const round = result.review !== undefined ? roundOf(['style']) : null;
        if (round) {
          if (result.summary) throw new CliError('styleCheck: a round posts its review, not a summary: give "review" or "summary", not both', { code: 2 });
          if (result.edits?.length && !result.commits?.length) throw new CliError('styleCheck: "edits" are fixes: give the "commits" that pushed them', { code: 2 });
          if (result.commits?.length && !result.edits?.length) throw new CliError('styleCheck: "commits" pushed fixes: give their "edits", the items of the round\'s review', { code: 2 });
          warnings.push(...addEdits(pr, result.edits, { list: String(result.review.id), stage, at, seq: l.seq + 1 }));
          placesOf();
          descriptionOf();
          addRound(round);
        } else {
          if ((result.edits?.length || result.notes?.length) && !result.summary?.id) throw new CliError('styleCheck: "edits" and "notes" are in the summary comment: give "summary": { "id" } too', { code: 2 });
          // A fix is a commit pushed, and its list a comment posted: neither is recorded without the other.
          if (result.edits?.length && !result.commits?.length) throw new CliError('styleCheck: "edits" are fixes: give the "commits" that pushed them', { code: 2 });
          // And the other way: a commit pushed is a fix the owner reads on the summary's list, posted.
          if (result.commits?.length && (!result.edits?.length || !result.summary?.id)) throw new CliError('styleCheck: "commits" pushed fixes: give their "edits" and the "summary" that listed them', { code: 2 });
          const postedIds = (Array.isArray(result.posted) ? result.posted : []).map((p) => String(typeof p === 'object' ? p?.id : p));
          if (result.summary?.id && !postedIds.includes(String(result.summary.id))) throw new CliError('styleCheck: the summary comment goes in "posted" too, so the pipeline never answers it', { code: 2 });
          if (result.summary) l.summaries.push({ repo: pr.repo, pr: pr.number, at, ...result.summary, ...(result.notes?.length ? { notes: result.notes } : {}) });
          warnings.push(...addEdits(pr, result.edits, { list: result.summary?.id, stage, at, seq: l.seq + 1 }));
        }
        // A style check answers no question: the ones still open stay, with any its summary asks. The skip (the card was
        // moved on) changes none.
        const asked = questionsOf(result, stage);
        if (!result.skipped) pr.openQuestions = { items: [...(pr.openQuestions?.items ?? []), ...asked], stage, at, seq: l.seq + 1 };
        pr.styleChecked ??= [];
        for (const r of reviewed) {
          const sha = String(r.sha);
          if (pr.styleChecked.some((x) => x.sha.startsWith(sha) || sha.startsWith(x.sha))) continue;
          pr.styleChecked.push({ sha, ...(typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason } : {}), ...(result.skipped ? { skipped: String(result.skipped) } : {}), at });
        }
        // Fixes pushed after a person moved the card on (the move came while the session ran): the chain goes on with
        // them; the owner reads them on the summary's numbered list and can undo them by number.
        if (result.commits?.length) {
          const card = await cardNow(ref);
          if (card.status !== 'finalReview') {
            const moved = round
              ? `style fixes landed after the card was moved on (${card.list?.name ?? card.status}): they are in the round's review (${result.review.id}) and can be undone in their threads`
              : `style fixes landed after the card was moved on (${card.list?.name ?? card.status}): they are on the summary's numbered list (comment ${result.summary?.id}) and can be undone by number`;
            record.note = record.note ? `${record.note}; ${moved}` : moved;
            warnings.push(moved);
          }
        }
        return;
      }
      case 'readyForMerge':
      case 'resync':
      default: {
        if (!CHAIN.includes(stage) && !['readyForMerge', 'resync', 'close'].includes(stage)) return;
        if (stage === 'close') {
          const open = [];
          for (const p of l.prs) {
            if (!p.number) {
              open.push(prId(p));
              continue;
            }
            const st = await clients.forge.prState({ repo: p.repo, number: p.number });
            if (st.state !== 'merged') open.push(prId(p));
            else p.merged = { at: st.mergedAt, commit: st.mergeCommit };
          }
          if (open.length) throw new Refused('notMerged', `not every PR is merged: ${open.join(', ')}`, { open });
          const card = await needCard('done');
          for (const p of l.prs) p.stage = 'merged';
          l.left = { ...brief(card), at };
          return;
        }
        const st = await forgeHead(pr);
        if (st.state !== 'open') throw new Refused('notOpen', `${prId(pr)} is ${st.state}`);
        const given = head ?? result.head ?? null;
        if (!given) throw new CliError(`${stage} done needs --head: the branch head the stage saw (after its own push)`, { code: 2 });
        if (!st.headCommit.startsWith(given)) throw new Refused('stale', `the branch head is ${st.headCommit.slice(0, 12)}, not ${String(given).slice(0, 12)}`, { head: st.headCommit });
        record.head = st.headCommit;
        pr.lastSeenHead = st.headCommit;
        // The EN review's posted rewrites go on the description's list; the re-sync gives the EN side of the items it
        // re-synced, so a restore later puts EN back too. In a review round (D-142) the EN review posts its own review
        // with line comments, as a UA round does: its items are that review's, and the description's list stays the UA's.
        if (stage === 'enReview' && result.review !== undefined) {
          const round = roundOf(['translation', 'style']);
          warnings.push(...addEdits(pr, result.edits, { list: String(result.review.id), stage, at, seq: l.seq + 1 }));
          descriptionOf();
          addRound(round);
        } else if (stage === 'enReview') warnings.push(...addEdits(pr, result.edits, { list: 'description', stage, at, seq: l.seq + 1 }));
        if (stage === 'resync') warnings.push(...addEnSides(pr, result.edits));
        if (stage === 'readyForMerge') {
          const missing = CHAIN.filter((s) => pr.chain[s]?.status !== 'done');
          if (missing.length) throw new Refused('chain', `the chain is not done: ${missing.join(', ')}`, { missing });
        }
        // The align stage and ready for merge (a hand commit after ready may change a UA image alone): no UA image
        // changed without its EN counterpart, checked in the PR's worktree at the head.
        if (stage === 'align' || stage === 'readyForMerge') {
          const pairs = await imagePairsAt(settings, pr, st.headCommit);
          if (pairs.error) throw new Refused('imagePairs', `the UA → EN image check can't run: ${pairs.error}`);
          if (pairs.missing?.length) throw new Refused('imagePairs', `UA images changed without their EN counterpart: ${pairs.message}`, { missing: pairs.missing });
          record.imagePairs = pairs.summary;
        }
        if (stage === 'readyForMerge') {
          pr.readyForMerge.push({ head: st.headCommit, at, seq: l.seq + 1 });
          pr.stage = 'readyForMerge';
          pr.label = targetOf(pr)?.labels?.[stageLabelOf(pr.stage, targetOf(pr))] ?? pr.label;
        }
        // The re-sync no longer makes the PR ready by itself: the rule checks the images, then `readyForMerge` does. A
        // chain stage finished after a person moved the card back changes no PR stage: the move stands.
      }
    }
  }

  // A work file outside git that the stage made or downloaded, for the cleanup after the merge (D-074). Only a path in
  // the host repo or the state root is recorded.
  function addFile(rel, kind = 'other', byStage = stage, bytes) {
    if (!rel) return;
    const abs = path.resolve(settings.root, rel);
    const within = [settings.root, settings.state].some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!within || abs === settings.root || abs === settings.state) throw new CliError(`files: '${rel}' is not a path inside the host repo or the state root`, { code: 2 });
    if (!KINDS.includes(kind)) throw new CliError(`files: kind '${kind}' is not one of ${KINDS.join(', ')}`, { code: 2 });
    const p = path.relative(settings.root, abs).split(path.sep).join('/');
    l.files ??= [];
    const entry = { path: p, kind, bytes: typeof bytes === 'number' ? bytes : recordedSize(settings.root, p), stage: byStage, at };
    const i = l.files.findIndex((f) => f.path === p);
    if (i >= 0) l.files[i] = { ...l.files[i], bytes: entry.bytes };
    else l.files.push(entry);
  }

  // `questions`: what the summary asks the owner to decide, each `{ "text", "n"? }` (`n`, the item of the numbered list
  // it asks about). In a summary only: a question is read on the PR, so none is recorded without the comment.
  function questionsOf(res, st, { required = false } = {}) {
    const q = res.questions;
    if (q === undefined || q === null) {
      if (required) throw new CliError(`${st}: give "questions": the questions to the owner left open, [{ "text", "n"? }], or [] when none is`, { code: 2 });
      return [];
    }
    if (!Array.isArray(q) || q.some((x) => !x || typeof x.text !== 'string' || !x.text.trim() || (x.n !== undefined && x.n !== null && !Number.isInteger(Number(x.n))))) throw new CliError(`${st}: "questions" is a list of { "text", "n"? }`, { code: 2 });
    if (q.length && !res.summary?.id && !res.review?.id) throw new CliError(`${st}: "questions" are asked in the summary comment: give "summary": { "id" } too`, { code: 2 });
    return q.map((x) => ({ text: x.text, ...(x.n !== undefined && x.n !== null ? { n: Number(x.n) } : {}) }));
  }

  // ---------------------------------------------------------------- a review round (D-142)

  // The round's review and commits, checked: `review`: { id, commits: [{ sha, role }] }, the review's id in `posted`,
  // each commit's sha among `commits` and its role one of `roles` (each at most once). Each item's line comment is a
  // comment the record posts (`commentId` in `posted`); a substantive style fix has one, a mechanical fix none. A
  // malformed round is a usage error: what was posted stays, and the session fixes its `--result`.
  function roundOf(roles) {
    const rv = result.review;
    if (!rv || typeof rv !== 'object' || rv.id === undefined || rv.id === null) throw new CliError(`${stage}: "review" is the round's review: { "id", "commits": [{ "sha", "role" }] }`, { code: 2 });
    const postedIds = new Set((Array.isArray(result.posted) ? result.posted : []).map((p) => String(typeof p === 'object' ? p?.id : p)));
    if (!postedIds.has(String(rv.id))) throw new CliError(`${stage}: the round's review ${rv.id} goes in "posted" too, so the pipeline never answers it`, { code: 2 });
    const commits = rv.commits ?? [];
    if (!Array.isArray(commits) || commits.some((c) => !/^[0-9a-f]{7,40}$/.test(String(c?.sha ?? '')) || !roles.includes(c?.role))) throw new CliError(`${stage}: "review.commits" is [{ "sha", "role" }], each role one of ${roles.join(', ')}`, { code: 2 });
    for (const r of roles) if (commits.filter((c) => c.role === r).length > 1) throw new CliError(`${stage}: one "${r}" commit a round, not ${commits.filter((c) => c.role === r).length}`, { code: 2 });
    const shas = (result.commits ?? []).map(String);
    const same = (s, c) => s.startsWith(c.sha) || c.sha.startsWith(s);
    // The EN round names the translation commit too, which the translation stage recorded (the PR's pipeline commits).
    const earlier = (c) => c.role === 'translation' && (pr.pipelineCommits ?? []).map(String).some((s) => same(s, c));
    for (const c of commits) if (!shas.some((s) => same(s, c)) && !earlier(c)) throw new CliError(`${stage}: the round's commit ${c.sha} is not among "commits"${c.role === 'translation' ? " nor the PR's recorded commits" : ''}`, { code: 2 });
    for (const e of result.edits ?? []) {
      const n = e?.n ?? '?';
      const has = e?.commentId !== undefined && e?.commentId !== null;
      if (has && !postedIds.has(String(e.commentId))) throw new CliError(`${stage}: item ${n}'s line comment ${e.commentId} is not in "posted"`, { code: 2 });
      if (e?.mechanical === true && has) throw new CliError(`${stage}: item ${n} is a mechanical fix: it is folded in the review's text, with no line comment`, { code: 2 });
      if (e?.mechanical === true && !e.rule) throw new CliError(`${stage}: item ${n} is a mechanical fix: give the "rule" it applies`, { code: 2 });
      if (e?.rule && e?.mechanical !== true && !has) throw new CliError(`${stage}: item ${n} is a substantive style fix: give the "commentId" of its line comment (the rule and why)`, { code: 2 });
    }
    const byRole = (r) => commits.find((c) => c.role === r);
    if ((result.edits ?? []).some((e) => e?.rule) && roles.includes('style') && !byRole('style')) throw new CliError(`${stage}: the style fixes are the "style" commit: name it in "review.commits"`, { code: 2 });
    if ((result.edits ?? []).some((e) => !e?.rule) && roles.includes('comments') && !byRole('comments')) throw new CliError(`${stage}: the edits the comments asked for are the "comments" commit: name it in "review.commits"`, { code: 2 });
    if (result.notes !== undefined && !Array.isArray(result.notes)) throw new CliError(`${stage}: "notes" is a list of { "page", "block", "text", "commentId"? }`, { code: 2 });
    for (const x of result.notes ?? []) if (x?.commentId !== undefined && x?.commentId !== null && !postedIds.has(String(x.commentId))) throw new CliError(`${stage}: a note's line comment ${x.commentId} is not in "posted"`, { code: 2 });
    const lineComments = (result.edits ?? []).filter((e) => e?.commentId !== undefined && e?.commentId !== null).length + (result.notes ?? []).filter((x) => x?.commentId !== undefined && x?.commentId !== null).length;
    return { review: rv.id, commits: commits.map((c) => ({ sha: String(c.sha), role: c.role })), comments: lineComments, notes: result.notes ?? [] };
  }

  // The round in the PR's list, numbered on (the description's "rounds" section reads it).
  function addRound(round) {
    pr.rounds ??= [];
    pr.rounds.push({ n: pr.rounds.length + 1, stage, at, seq: l.seq + 1, commits: round.commits, review: round.review, comments: round.comments, ...(round.notes.length ? { notes: round.notes } : {}) });
  }

  // The places a round changed: `places`: [{ id, state, replyId?, answer? }]. A place confirmed or whose block went
  // (`confirmed`, `deleted`) has the reply that says why in its thread (`replyId`, in `posted`): the runner then settles
  // the thread (lib/pr-rounds.mjs).
  function placesOf() {
    const postedIds = new Set((Array.isArray(result.posted) ? result.posted : []).map((p) => String(typeof p === 'object' ? p?.id : p)));
    for (const u of result.places ?? []) {
      if (!u || !u.id) throw new CliError(`${stage}: "places" is a list of { "id", "state", "replyId"? }`, { code: 2 });
      if (u.state !== undefined && !['open', 'confirmed', 'deleted'].includes(u.state)) throw new CliError(`${stage}: place ${u.id}'s state is open, confirmed or deleted`, { code: 2 });
      if (['confirmed', 'deleted'].includes(u.state) && (u.replyId === undefined || u.replyId === null || !postedIds.has(String(u.replyId)))) throw new CliError(`${stage}: place ${u.id} is ${u.state}: give "replyId", the reply in its thread that says why (in "posted" too)`, { code: 2 });
      const place = l.places.find((p) => p.id === u.id && p.repo === pr.repo && Number(p.pr) === pr.number);
      if (!place) {
        warnings.push(`no place ${u.id} on ${prId(pr)}: not changed`);
        continue;
      }
      // Only what a round may change: the place's id, page, claim and comment stay as the `pr` record wrote them.
      for (const k of ['state', 'replyId', 'answer']) if (u[k] !== undefined) place[k] = u[k];
      place.at = at;
    }
  }

  // The description's questions a round answered (`answered`: [{ n, answer, link? }]) and the new ones it asks for a
  // reader (`asked`: [{ text, reader, place?, why?, proposal? }], numbered on). The runner writes the section from them.
  function descriptionOf() {
    pr.questions ??= [];
    if (result.answered !== undefined && !Array.isArray(result.answered)) throw new CliError(`${stage}: "answered" is a list of { "n", "answer", "link"? }`, { code: 2 });
    for (const a of result.answered ?? []) {
      if (!Number.isInteger(Number(a?.n)) || typeof a?.answer !== 'string' || !a.answer.trim()) throw new CliError(`${stage}: "answered" is a list of { "n", "answer", "link"? }`, { code: 2 });
      const q = pr.questions.find((x) => x.n === Number(a.n));
      if (!q) {
        warnings.push(`no description question ${a.n} on ${prId(pr)}: its answer is not kept`);
        continue;
      }
      q.answer = { text: a.answer.trim(), ...(a.link ? { link: String(a.link) } : {}), ...(a.by ? { by: String(a.by) } : {}), at, seq: l.seq + 1 };
    }
    addQuestions(pr, result.asked);
  }

  // The `pr` stage's round: the commits the write and the UA review recorded for this PR's branch, and the places'
  // review when the entry names it. Recorded again, it replaces itself.
  function firstRound(p, e) {
    const of = (st, role) => (l.stages?.[st]?.result?.prs ?? []).filter((x) => x.branch === p.branch && (!x.repo || x.repo === p.repo)).flatMap((x) => x.commits ?? []).map((sha) => ({ sha: String(sha), role }));
    const commits = [...of('write', 'draft'), ...of('uaReview', 'style')];
    const review = e.review?.id ?? null;
    const comments = (result.places ?? []).filter((x) => Number(x.pr) === p.number && x.commentId !== undefined && x.commentId !== null).length;
    p.rounds = (p.rounds ?? []).filter((r) => r.stage !== 'pr');
    p.rounds.unshift({ n: 1, stage: 'pr', at, seq: l.seq + 1, commits, review, comments });
    p.rounds.forEach((r, i) => (r.n = i + 1));
  }

  // Questions of the description, numbered on from the PR's last: a question's number never changes.
  function addQuestions(p, items) {
    if (items === undefined || items === null) return;
    if (!Array.isArray(items) || items.some((x) => !x || typeof x.text !== 'string' || !x.text.trim())) throw new CliError(`${stage}: the description's questions are a list of { "n"?, "text", "reader", "place"?, "why"?, "proposal"? }`, { code: 2 });
    p.questions ??= [];
    let next = p.questions.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    for (const x of items) {
      const n = Number.isInteger(Number(x.n)) && Number(x.n) >= next ? Number(x.n) : next;
      const fields = Object.fromEntries(['reader', 'place', 'why', 'proposal'].filter((k) => typeof x[k] === 'string' && x[k].trim()).map((k) => [k, x[k].trim()]));
      p.questions.push({ n, text: x.text.trim(), ...fields, stage, at });
      next = n + 1;
    }
  }

  function targetOf(p) {
    return settings.targets.find((t) => t.id === p.targets?.[0]) ?? settings.targets.find((t) => t.repo === p.repo) ?? null;
  }

  function upsertPr(e) {
    if (!e.branch || !e.repo) throw new CliError('each PR in --result needs repo and branch', { code: 2 });
    if (!settings.forge.repos.includes(e.repo)) throw new CliError(`'${e.repo}' is not a repository the targets name`, { code: 2 });
    let p = l.prs.find((x) => x.repo === e.repo && x.branch === e.branch);
    if (!p) {
      const targets = e.targets ?? [];
      const review = e.review ?? settings.targets.find((t) => t.id === targets[0])?.review ?? null;
      // One PR per review kind in a repo: a PR holds targets of one kind only.
      const kinds = new Set(targets.map((id) => settings.targets.find((t) => t.id === id)?.review).filter(Boolean));
      if (kinds.size > 1) throw new CliError(`a PR holds targets of one review kind only; ${e.branch} names ${[...kinds].join(' and ')}`, { code: 2 });
      p = newPr({ repo: e.repo, targets, review, branch: e.branch, base: e.base ?? settings.targets.find((t) => t.id === targets[0])?.base ?? 'main' });
      l.prs.push(p);
    }
    addAll(p.pipelineCommits, e.commits);
    return p;
  }
}

// The status the card belongs in: its least advanced PR's.
export function cardStatusFor(l) {
  if (!l.prs.length) return null;
  const least = Math.min(...l.prs.map((p) => PR_ORDER.indexOf(p.merged ? 'merged' : p.stage)));
  return CARD_STATUS_OF[PR_ORDER[least]] ?? null;
}

// `record <key> --run <json>` with no stage: the cost of a session, added to the ledger's runs. The runner records it
// after each session; it checks nothing, since it changes no stage.
function appendRun(settings, key, run, prRef, now) {
  const ledger = readLedger(settings.state, key);
  if (!ledger) throw new Refused('noLedger', `ticket ${key} has no ledger`);
  const l = structuredClone(ledger);
  const pr = prRef ? findPr(l, prRef) : null;
  l.seq += 1;
  l.updatedAt = new Date(now).toISOString();
  l.runs.push({ seq: l.seq, ...(pr ? { pr: prId(pr) } : {}), ...run });
  const file = writeLedger(settings.state, l);
  renewLock(settings.state, l.group, { leaseMinutes: settings.limits.lockLeaseMinutes, now });
  return { file: path.relative(settings.root, file), key, run: true, seq: l.seq };
}
