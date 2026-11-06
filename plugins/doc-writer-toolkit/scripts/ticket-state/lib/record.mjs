import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError, Refused } from './errors.mjs';
import { checkKey, findPr, keyOf, newLedger, newPr, prId, readLedger, writeLedger } from './ledger.mjs';
import { lockOf, renewLock } from './locks.mjs';
import { CARD_STATUS_OF, CHAIN, LABEL_OF, PR_ORDER, PR_STAGE_OF_STATUS, PR_STAGES, STATUSES, TICKET_STAGES } from './stages.mjs';
import { labelCheck } from './intake.mjs';
import { KINDS, recordedSize } from './cleanup.mjs';
import { imagePairsAt } from './pairs.mjs';
import { writtenIn } from './worktree.mjs';

// `record <key> --stage <s> --status running|done|failed`: one stage result, written only when the tracker, the forge
// and the files support it (context/ticket-flow.md, "When a record is accepted"). On any problem nothing is written.

const PR_ONLY = new Set([...CHAIN, 'answerComments', 'readyForMerge', 'resync']);
const PR_TARGET_STAGES = ['writing', 'placesWait', 'reworkWait', 'smeReview', 'finalReview', 'questions'];
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
  const tracker = { findCards: (a) => clients.tracker.findCards(a), readCard: (a) => clients.tracker.readCard(a) };
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

  if (status === 'done') await applyDone();
  else if (status === 'running' && pr && (CHAIN.includes(stage) || ['answerComments', 'resync', 'readyForMerge'].includes(stage))) {
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
  l.log.push({ seq: l.seq, at, stage, ...(pr ? { pr: prId(pr) } : {}), outcome: status, ...(note ? { note } : {}) });
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
  return { file: path.relative(settings.root, file), key, stage, status, ...(pr ? { pr: prId(pr) } : {}), seq: l.seq, lockRenewed: Boolean(lock) };

  // ------------------------------------------------------------------ what `done` checks, and what it changes

  async function applyDone() {
    switch (stage) {
      case 'triage': {
        if (!VERDICTS.includes(result.verdict)) throw new CliError(`triage needs --result {"verdict": …}, one of ${VERDICTS.join(', ')}`, { code: 2 });
        const card = await cardNow(ref);
        if (result.movedTo && card.status !== result.movedTo) throw new Refused('card', `the triage moved the card to ${result.movedTo}, but it is in ${card.status}`);
        // Labels confirm; a missing app label alone is no reason for needs-info when the text settles the target.
        if (result.verdict === 'needs-info' && result.reason === 'noAppLabel') {
          const check = labelCheck(await tracker.readCard({ card: card.id }), settings, null);
          if (check.settled) throw new Refused('textSettles', `the card has no app label, but its text names ${check.targets.join(', ')}: triage it from the text`, { targets: check.targets });
        }
        l.triage = { ...result, at, priority: card.priority ?? 'medium' };
        l.priority = card.priority ?? 'medium';
        l.left = { ...brief(card), at };
        return;
      }
      case 'start': {
        const card = await needCard('inProgress');
        if (!l.triage) l.triage = { verdict: result.verdict ?? 'owner-card', targets: result.targets ?? [], size: result.size ?? null, at };
        if (!startedBy) {
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
          pr.stage = pr.resumeTo ?? 'smeReview';
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
        if (!l.video) throw new Refused('noGate', 'no video gate was recorded');
        for (const r of result.parts ?? []) {
          const part = l.video.videos.flatMap((v) => v.parts).find((p) => p.file === r.file);
          if (!part) throw new CliError(`no video part ${r.file}`, { code: 2 });
          part.tries.push({ at, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
          if (r.transcript) {
            part.transcript = r.transcript;
            addFile(r.transcript, 'transcript', stage);
          }
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
        if (!entries.length) throw new CliError('pr needs --result {"prs": [{ "branch", "number", "url" }], "places": [...]}', { code: 2 });
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
        }
        for (const place of result.places ?? []) l.places.push({ state: 'open', at, ...place, pr: Number(place.pr) });
        for (const e of entries) {
          const p = l.prs.find((x) => x.branch === e.branch && (!e.repo || x.repo === e.repo));
          p.stage = p.review === 'sme' ? 'smeReview' : l.places.some((x) => x.repo === p.repo && Number(x.pr) === p.number && x.state === 'open') ? 'placesWait' : 'finalReview';
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
          // The text the review approved (or the places settled on): a later word change in UA is reported.
          if (to === 'finalReview') pr.approval = { head: st.headCommit, at, from: before };
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
          if (p.number && CARD_STATUS_OF[p.stage] === from && PR_STAGE_OF_STATUS[to]) {
            if (PR_STAGE_OF_STATUS[to] === 'finalReview') p.approval = { head: (await clients.forge.prState({ repo: p.repo, number: p.number })).headCommit, at, from: p.stage, by: 'person' };
            p.stage = PR_STAGE_OF_STATUS[to];
            const label = targetOf(p)?.labels?.[LABEL_OF[p.stage]];
            if (label) p.label = label;
          }
        }
        if (to === 'done' || to === 'outOfScope') l.stages.close = { status: 'done', seq: l.seq + 1, at, note: `a person moved the card to ${card.list?.name ?? to}` };
        l.left = { ...brief(card), at };
        return;
      }
      case 'answerComments': {
        for (const c of result.handled ?? []) l.reviewComments.push({ repo: pr.repo, pr: pr.number, at, ...c });
        if (result.summary) l.summaries.push({ repo: pr.repo, pr: pr.number, at, ...result.summary });
        for (const u of result.places ?? []) {
          const place = l.places.find((p) => p.id === u.id && p.repo === pr.repo && Number(p.pr) === pr.number);
          if (place) Object.assign(place, u, { at });
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
          pr.readyForMerge.push({ head: st.headCommit, at });
          pr.stage = 'readyForMerge';
        }
        // The re-sync no longer makes the PR ready by itself: the rule checks the images, then `readyForMerge` does.
        if (pr.stage === 'reworkWait' && CHAIN.includes(stage)) pr.stage = 'finalReview';
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
