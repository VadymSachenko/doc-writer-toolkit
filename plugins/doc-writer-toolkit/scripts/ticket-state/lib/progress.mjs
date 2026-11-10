import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { notReadyYet, prId, readLedgersApart } from './ledger.mjs';
import { CHAIN, PR_ORDER } from './stages.mjs';
import { readFeed, watchDir } from './feed.mjs';

// The live progress file: `<state>/watch/progress.md`, a checklist of phases rendered from the ledgers and the current
// pass's log, for the owner's Markdown preview. No model and no network: this file reads the ledgers and a few small
// files in the state folder, and writes two (`progress.md` and the memory `progress.json`). A failed write is returned,
// never thrown, so it can't fail a run or stop a step. Nothing here talks to the tracker or the forge; the runner hands
// in the status it already computed (`st`), and the file keeps what it needs of it (which chain stages UA changes made
// stale) in the memory file, so a quiet watcher pass shows the same.

export const progressPath = (state) => path.join(watchDir(state), 'progress.md');
export const memoryPath = (state) => path.join(watchDir(state), 'progress.json');

// ------------------------------------------------------------------ labels

const TICKET_ROWS = [
  ['triage', 'Triaging'],
  ['start', 'Picking up the ticket'],
  ['plan', 'Drafting a plan'],
  ['answers', 'Applying the answers'],
  ['videoImport', 'Importing the video transcripts'],
  ['write', 'Writing the UA pages'],
  ['uaReview', 'Reviewing the UA text'],
  ['pr', 'Opening the PR'],
];
const OPTIONAL_TICKET = new Set(['answers', 'videoImport']);
const CHAIN_LABELS = {
  translate: 'Translating into EN',
  enReview: 'Reviewing the EN text',
  locales: 'Translating into the other locales',
  align: 'Checking UA and EN alignment',
  labelSync: 'Syncing the UI labels',
  build: 'Building the site',
  visualPack: 'Checking the screenshots',
};
const STAGE_LABEL = { ...Object.fromEntries(TICKET_ROWS), ...CHAIN_LABELS, close: 'Closing the ticket', resync: 'Re-syncing after a change in UA', answerComments: 'Answering the review comments', styleCheck: 'Style check of hand edits', move: 'Moving the card', follow: 'Following the card', readyForMerge: 'Marking ready for merge', baseMerge: 'Merging the base into the branch', baseFix: 'Resolving the base merge conflict' };
export const labelOf = (stage) => STAGE_LABEL[stage] ?? String(stage);

// ------------------------------------------------------------------ small formats

const iso = (ms) => new Date(ms).toISOString();
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const hhmm = (t) => {
  const v = ms(t);
  return Number.isFinite(v) ? new Date(v).toTimeString().slice(0, 5) : '?';
};
export function duration(total) {
  if (!Number.isFinite(total) || total < 0) return '';
  const s = Math.round(total / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const oneLine = (t, max = 160) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// ------------------------------------------------------------------ gates

// What waits for a person, from the ledger alone: the pipeline's own record that opened the wait. `ident` tells one
// arrival at a gate from the next (a second round of questions, a new head after a rework), so the notification fires
// once for each. `notify: false` for a wait the owner caused (a card moved back) or a reviewer's. A failed or held step
// is not a gate here: the runner's urgent notification covers it.
const GATE_WHY = {
  questions: 'answers on the card, then the card back to In progress',
  planGate: 'the section plan: moving the card back approves it',
  video: 'transcripts of the video parts',
  smeReview: "the expert review: the expert's Approve moves the card on, or a person does",
  reworkWait: 'a person moved the card back to In progress',
  finalReview: 'comments first, then the card to In translation, or to the review status to call the expert',
  readyForMerge: 'the final edit and the merge',
};
const GATE_ACTION = {
  questions: 'answer the questions on the card',
  planGate: 'approve the section plan',
  video: 'provide the video transcripts',
  finalReview: 'read the UA',
  readyForMerge: 'make the final edit and merge',
};

export function gatesOf(l) {
  if (!l || l.mode !== 'pipeline' || l.stages?.close?.status === 'done') return [];
  const st = l.stages ?? {};
  const gates = [];
  const gate = (kind, who, extra = {}) => gates.push({ key: l.key, kind, who, why: GATE_WHY[kind], notify: who === 'owner' && kind in GATE_ACTION, ident: '', pr: null, ...extra });
  const after = (a, b) => st[a]?.status === 'done' && st[b]?.status === 'done' && st[a].seq > st[b].seq;

  const open = (l.questions ?? []).filter((q) => !q.answer);
  if (open.length && (st.questions?.status === 'done' || (l.prs ?? []).some((p) => p.stage === 'questions'))) {
    gate('questions', 'owner', { ident: open.map((q) => q.askedAt ?? '').sort().at(-1) || String(st.questions?.seq ?? '') });
  }
  if (st.planGate?.status === 'done' && !after('planApproval', 'planGate') && !after('write', 'planGate') && st.pr?.status !== 'done') gate('planGate', 'owner', { ident: String(st.planGate.seq) });
  if (st.videoBlock?.status === 'done' && !after('videoImport', 'videoBlock')) gate('video', 'owner', { ident: String(st.videoBlock.seq) });

  for (const p of l.prs ?? []) {
    if (p.merged) continue;
    const id = prId(p);
    if (p.stage === 'smeReview') gate('smeReview', 'reviewer', { pr: id });
    else if (p.stage === 'reworkWait') gate('reworkWait', 'owner', { pr: id });
    else if (p.stage === 'finalReview') gate('finalReview', 'owner', { pr: id, ident: String(p.pipelineCommits?.at(-1) ?? st.pr?.seq ?? ''), recommended: p.expertReview?.recommended ? oneLine(p.expertReview.why, 140) : null });
    // Not while the base is merged in (`forge.keepFresh`): a conflict, or CI on the merge, comes first.
    else if (p.stage === 'readyForMerge' && !notReadyYet(p)) gate('readyForMerge', 'owner', { pr: id, ident: String(p.readyForMerge?.at(-1)?.head ?? '') });
  }
  return gates;
}

// ------------------------------------------------------------------ rows

const WHO = { owner: 'you', reviewer: 'the reviewer', team: 'the team', transcriber: 'the transcriber' };

function runOf(l, stage, pr) {
  return (l.runs ?? []).filter((r) => r.stage === stage && (pr ? r.pr === pr : !r.pr) && r.outcome === 'done').at(-1) ?? null;
}
// A run's time: its wall-clock time (start to end), with the session's own count after it when they differ by a minute or
// more (a session that waited for something after its last turn); a run from before `wallMs` shows the session's count.
export function timeOf(run) {
  const wall = typeof run?.wallMs === 'number' ? run.wallMs : null;
  const own = typeof run?.durationMs === 'number' ? run.durationMs : null;
  if (wall === null) return own === null ? '' : duration(own);
  return `${duration(wall)}${own !== null && Math.abs(wall - own) >= 60000 ? ` (session ${duration(own)})` : ''}`;
}
function costAndTime(run) {
  if (!run) return '';
  const bits = [];
  const shared = typeof run.share === 'number' && run.share < 1;
  if (typeof run.costUsd === 'number') bits.push(`$${(run.costUsd * (run.share ?? 1)).toFixed(2)}${shared ? ' (a share)' : ''}`);
  if (!shared) {
    const t = timeOf(run);
    if (t) bits.push(t);
  }
  return bits.length ? ` — ${bits.join(', ')}` : '';
}
const flightOf = (flights, key, stage, pr) => flights.find((f) => f.keys?.includes(key) && f.stage === stage && (pr ? f.pr === pr : !f.pr)) ?? null;

// One phase: ⏳ running (or in flight now), ⬜ not yet (or stale), ❌ failed, ✅ done.
function stageRow(label, { rec, run, flight, stale, now }) {
  const since = flight ? flight.since : rec?.status === 'running' ? Date.parse(rec.at) : null;
  if (flight || rec?.status === 'running') return { sym: '⏳', text: `- ⏳ ${label}${Number.isFinite(since) ? ` — since ${hhmm(since)} (${duration(now - since)})` : ''}` };
  if (stale) return { sym: '⬜', text: `- ⬜ ${label} — stale: ${stale}` };
  if (rec?.status === 'failed') return { sym: '❌', text: `- ❌ ${label}${rec.note ? ` — ${oneLine(rec.note)}` : ''}` };
  if (rec?.status === 'done') return { sym: '✅', text: `- ✅ ${label}${costAndTime(run)}`, done: true };
  return { sym: '⬜', text: `- ⬜ ${label}` };
}

const gateRow = (label, g) => `- ${g.who === 'owner' ? '👉' : '⏸'} ${label} — waits for ${WHO[g.who] ?? g.who}: ${g.why}${g.recommended ? `; an expert review is recommended: ${g.recommended}` : ''}`;

// A session working on the ticket now (an answer to a review comment, say) is not the owner's turn: the gate it works at
// shows as running, not as a wait.
const busyAt = (flights, g) => flights.some((f) => f.keys?.includes(g.key) && (!g.pr || !f.pr || f.pr === g.pr));

// Whether the expert was called for this PR: a review request the `pr` record did not bring. The writer's own
// `reviewersRequested` is in that record's result; the ones a person's move to the review status added later (`follow`,
// `move`, lib/record.mjs) are not. A target with no reviewers on the forge leaves no such trace: then nothing tells it.
function calledOf(l, p) {
  const own = new Set((l.stages?.pr?.result?.prs ?? []).filter((e) => e?.branch === p.branch).flatMap((e) => e.reviewersRequested ?? []).map(String));
  return (p.reviewersRequested ?? []).some((r) => !own.has(String(r)));
}

function ticketBlock(l, { flights, stale, now }) {
  const gates = gatesOf(l).filter((g) => !busyAt(flights, g));
  const st = l.stages ?? {};
  const all = [];
  const lines = [];
  const add = (r) => (all.push(r), lines.push(r.text));
  for (const [stage, label] of TICKET_ROWS) {
    if (OPTIONAL_TICKET.has(stage) && !st[stage]) continue;
    add(stageRow(label, { rec: st[stage], run: runOf(l, stage, null), flight: flightOf(flights, l.key, stage, null), now }));
    if (stage !== 'plan') continue;
    // The waits the plan can stop at, shown only when the ledger shows them.
    const q = gates.find((g) => g.kind === 'questions');
    if (q) add({ text: gateRow('Questions', q) });
    else if (st.questions) add({ text: '- ✅ Questions answered', done: true });
    const pg = gates.find((g) => g.kind === 'planGate');
    if (pg) add({ text: gateRow('Plan approval', pg) });
    else if (st.planGate) add({ text: '- ✅ Plan approved', done: true });
    const v = gates.find((g) => g.kind === 'video');
    if (v) add({ text: gateRow('Video transcripts', v) });
  }
  const prs = l.prs ?? [];
  if (!prs.length) add({ text: '- ⬜ Review, translation and merge — after the PR opens' });
  for (const p of prs) {
    const id = prId(p);
    const rank = PR_ORDER.indexOf(p.stage);
    const idx = (s) => PR_ORDER.indexOf(s);
    lines.push('', `**PR ${id}** — ${p.review ?? 'review'} review, stage ${p.stage}`, '');
    // A session on the PR that is not a chain stage (answering the review comments, moving the card).
    for (const f of flights.filter((x) => x.keys?.includes(l.key) && x.pr === id && !CHAIN.includes(x.stage) && x.stage !== 'resync')) add({ text: `- ⏳ ${labelOf(f.stage)} — since ${hhmm(f.since)} (${duration(now - f.since)})` });
    const q = gates.find((g) => g.kind === 'questions');
    if (p.stage === 'questions' && q) add({ text: gateRow('Question on this PR', q) });
    const rw = gates.find((g) => g.kind === 'reworkWait' && g.pr === id);
    const fr = gates.find((g) => g.kind === 'finalReview' && g.pr === id);
    if (rw) add({ text: gateRow('Rework', rw) });
    else if (fr) add({ text: gateRow('Your read of the UA', fr) });
    else if (rank >= idx('translation') || p.approval) add({ text: '- ✅ Your read of the UA', done: true });
    else add({ text: '- ⬜ Your read of the UA' });
    // The expert review, after the owner's read: shown when the PR is at it, was asked for, or is recommended. Done only
    // when a move took the PR there and back (a review request on the PR alone, from the `pr` record, is not that).
    const sme = gates.find((x) => x.kind === 'smeReview' && x.pr === id);
    const asked = (p.reviewersRequested ?? []).length > 0;
    const called = calledOf(l, p);
    const recommended = p.expertReview?.recommended ? oneLine(p.expertReview.why, 140) : null;
    if (p.stage === 'smeReview') add({ text: sme ? gateRow('Expert review', sme) : '- ⏸ Expert review' });
    else if (called) add({ text: '- ✅ Expert review', done: true });
    else if (asked || recommended) add({ text: `- ⬜ Expert review — ${recommended ? `recommended: ${recommended}` : 'requested, not called'}` });
    // The chain; a stage made stale by a change in UA, and every later one, goes back to not done.
    const overlay = stale.get(`${l.key}|${id}`);
    const from = overlay ? CHAIN.indexOf(overlay.stage) : -1;
    CHAIN.forEach((stage, i) => {
      const rec = p.chain?.[stage];
      const isStale = overlay && i >= from && rec?.status === 'done' && rec.head !== overlay.head ? 'UA changed since' : null;
      add(stageRow(CHAIN_LABELS[stage], { rec, run: runOf(l, stage, id), flight: flightOf(flights, l.key, stage, id), stale: isStale, now }));
    });
    const rs = p.steps?.resync;
    const rsFlight = flightOf(flights, l.key, 'resync', id);
    if (rsFlight || (rs && rs.status !== 'done')) add(stageRow(labelOf('resync'), { rec: rs, run: null, flight: rsFlight, now }));
    const rg = gates.find((g) => g.kind === 'readyForMerge' && g.pr === id);
    if (p.merged) add({ text: `- ✅ Merged${p.merged.at ? ` at ${hhmm(p.merged.at)}` : ''}`, done: true });
    else if (rg) add({ text: gateRow('Ready for merge', rg) });
    else add({ text: `- ⬜ Ready for merge${notReadyYet(p) ? ` (${notReadyYet(p)})` : ''}` });
  }
  if (prs.length) lines.push('');
  add(stageRow(labelOf('close'), { rec: st.close, run: null, flight: flightOf(flights, l.key, 'close', null), now }));
  const name = oneLine(l.card?.name ?? '', 90);
  const head = `### ${l.key}${name ? ` · ${name}` : ''} (${all.filter((r) => r.done).length} of ${all.length})`;
  return { head, lines };
}

// ------------------------------------------------------------------ the whole file

const KIND = { morning: 'the morning run', startPass: 'a start pass', schedule: 'a scheduled run', watcher: 'the watcher', manual: 'a run started by hand' };

// The last start pass of the watcher (`feed.starts`), when it didn't run or started nothing, or is waiting: the reason.
function startLine(starts, startHours, now) {
  // The morning run's own record says nothing here, unless it keeps a deferral or a retry.
  if (!starts || (starts.by === 'morning' && !starts.deferred && !starts.retryAt)) return null;
  const at = starts.at ? ` (${hhmm(starts.at)})` : '';
  const outcome = String(starts.outcome ?? '');
  if (starts.retryAt && Date.parse(starts.retryAt) > now) return `- ⏸ Start pass${at}: retry at ${hhmm(starts.retryAt)}${starts.deferred ? ` — ${oneLine(starts.deferred, 120)}` : ''}`;
  if (starts.deferred) return `- ⏸ Start pass deferred${at}: ${oneLine(starts.deferred, 120)}${startHours ? ` — waits for the start hours (${startHours}) or a board that reads` : ''}`;
  if (/^failed/.test(outcome)) return `- ❌ Start pass${at}: ${oneLine(outcome, 140)}`;
  if (/^not run|^started nothing/.test(outcome)) return `- ⬜ Start pass${at}: ${oneLine(outcome, 140)}`;
  return null;
}

function runSection(run, flights, now, live, { starts = null, startHours = null, ledgers = [] } = {}) {
  const out = [];
  const start = startLine(starts, startHours, now);
  if (!run && !flights.length) return start ? ['No run yet.', '', start] : ['No run yet.'];
  const when = run?.at ? ` (${hhmm(run.at)})` : '';
  const kind = KIND[run?.kind] ?? (run?.trigger ? `started by ${run.trigger}` : null);
  out.push(live ? `Run in progress${kind ? `, ${kind}` : ''}${run?.startedAt ? `, since ${hhmm(run.startedAt)}` : ''}` : `Last run${when}${kind ? `, ${kind}` : ''}`, '');
  for (const f of flights) out.push(`- ⏳ ${labelOf(f.stage)} — ${f.keys?.join(', ')}${f.pr ? ` (${f.pr})` : ''}, since ${hhmm(f.since)} (${duration(now - f.since)})`);
  if (run?.triage) {
    // A triage session is shared by its cards: its duration is shown here once, from one card's run of it.
    const session = ledgers.filter((l) => run.triage.keys?.includes(l.key)).flatMap((l) => l.runs ?? []).filter((r) => r.stage === 'triage' && (typeof r.durationMs === 'number' || typeof r.wallMs === 'number') && Date.parse(r.start) >= Date.parse(run.startedAt ?? 0)).at(-1);
    out.push(`- ${run.triage.outcome === 'done' ? '✅' : run.triage.outcome ? '❌' : '⬜'} Triaging: ${run.triage.keys?.length ?? run.triage.due ?? 0} intake card(s)${run.triage.outcome ? ` — ${run.triage.outcome}${session ? `, ${timeOf(session)}` : ''}` : ' due'}`);
  }
  else if (run?.intakeDue) out.push(`- ⬜ Triaging: ${run.intakeDue} intake card(s) due`);
  for (const s of run?.steps ?? []) out.push(`- ${s.outcome === 'done' ? '✅' : s.outcome === 'failed' ? '❌' : '⏸'} ${labelOf(s.stage)} — ${(s.keys ?? []).join(', ')}${s.pr ? ` (${s.pr})` : ''}${s.outcome && s.outcome !== 'done' ? `: ${s.outcome}${s.note ? ` (${oneLine(s.note, 100)})` : ''}` : s.note ? ` — ${oneLine(s.note, 100)}` : ''}`);
  for (const h of run?.handedOn ?? []) out.push(`- ${h.handed ? '↪️' : '⏸'} ${labelOf(h.stage)} — ${h.keys.join(', ')}${h.pr ? ` (${h.pr})` : ''}${h.handed ? ': handed to a run of its own' : `: not handed on (${oneLine(h.note ?? '', 100)})`}`);
  if (run?.picked?.length) out.push(`- ✅ Picked: ${run.picked.join(', ')}`);
  for (const n of run?.notStarted ?? []) out.push(`- ⬜ Not started: ${n.keys?.join(', ') ?? n.group} — ${(n.reasons ?? []).join('; ')}`);
  for (const g of run?.guard ?? []) out.push(`- ⏸ ${g.what ? `${g.what}: ` : ''}${g.reason}`);
  const w = run?.wip;
  if (w) out.push(`- Slots: ${w.inProgress} in progress${w.limits?.inProgress != null ? ` of ${w.limits.inProgress}` : ''}, ${w.waiting} waiting${w.limits?.waiting != null ? ` of ${w.limits.waiting}` : ''}${w.limits?.open != null ? `, ${w.open} open of ${w.limits.open}` : ''}`);
  const a = run?.allowance;
  if (a) out.push(`- Today's allowance: ${a.remaining}% left of ${a.cap}% (the week is at ${a.used}%)`);
  if (start) out.push(start);
  return out;
}

// The whole file as text. Pure: the same input gives the same text.
export function renderProgress({ ledgers = [], bad = [], memory = {}, run = null, live = false, flights = [], now = Date.now(), mode = null, stepsText = null, starts = null, startHours = null }) {
  const stale = new Map(Object.entries(memory.stale ?? {}));
  const open = ledgers.filter((l) => l.stages?.close?.status !== 'done');
  const mine = open.filter((l) => l.mode === 'pipeline');
  const hand = open.filter((l) => l.mode !== 'pipeline').map((l) => l.key);
  const gates = mine.flatMap(gatesOf).filter((g) => g.who === 'owner' && !busyAt(flights, g));
  const out = ['# Ticket flow progress', '', `Updated ${hhmm(now)}${mode ? ` · mode ${mode}` : ''}`, '', '## Waiting for you', ''];
  // A colleague's comment the pipeline doesn't take (the trigger words): the owner hands it on or leaves it.
  const others = Object.entries(memory.others ?? {}).filter(([k]) => mine.some((l) => k.startsWith(`${l.key}|`))).flatMap(([k, list]) => list.map((c) => ({ key: k.split('|')[0], pr: k.split('|').slice(1).join('|'), ...c })));
  if (!gates.length && !others.length) out.push('Nothing waits for you.');
  for (const g of gates) {
    const l = mine.find((x) => x.key === g.key);
    out.push(`- 👉 ${g.key}${l?.card?.name ? ` · ${oneLine(l.card.name, 70)}` : ''} — ${g.pr ? `${g.pr}: ` : ''}${GATE_ACTION[g.kind] ?? g.why}${g.recommended ? ` (an expert review is recommended: ${g.recommended})` : ''}`);
  }
  for (const c of others) out.push(`- 💬 ${c.key} — ${c.pr}: a comment of ${c.author ?? 'a colleague'}'s the pipeline doesn't take${c.link ? ` (${c.link})` : ''}: hand it on with a comment that starts with the trigger word, or leave it`);
  out.push('', live ? '## The current run' : '## The last run', '', ...runSection(run, flights, now, live, { starts, startHours, ledgers }), '', '## Tickets in work', '');
  if (!ledgers.length && !bad.length) out.push('No ledgers yet: nothing has started.');
  else if (!mine.length) out.push('No ticket is in work.');
  const started = (l) => Boolean(l.stages?.start) || flights.some((f) => f.keys?.includes(l.key));
  for (const l of mine.filter(started)) {
    const b = ticketBlock(l, { flights, stale, now });
    out.push(b.head, '', ...b.lines, '');
  }
  const waiting = mine.filter((l) => !started(l)).map((l) => l.key);
  if (waiting.length) out.push(`Triaged, not started: ${waiting.join(', ')}`, '');
  if (hand.length) out.push(`In the owner's hands (observed only): ${hand.join(', ')}`, '');
  const closed = ledgers.length - open.length;
  if (closed) out.push(`${closed} closed ticket(s) not shown.`, '');
  for (const b of bad) out.push(`⚠️ The ledger ${b.key} does not read: ${oneLine(b.error)}`, '');
  if (stepsText) out.push("## Claude's planned steps", '', stepsText.trimEnd(), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ------------------------------------------------------------------ files

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // a temp file that can't be removed is left
    }
    throw e;
  }
}

// The memory: which chain stages a change in UA made stale (from the last status), the last run, and the gates a
// "your turn" notification went out for. `exists: false` before the first write.
export function readMemory(state) {
  try {
    const data = JSON.parse(fs.readFileSync(memoryPath(state), 'utf8'));
    return data && typeof data === 'object' ? { exists: true, data } : { exists: false, data: {} };
  } catch {
    return { exists: false, data: {} };
  }
}

const readSteps = (file) => {
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
};

// Chain stages the status calls stale: { '<key>|<pr>': { stage, head, count } }, for the tickets the status covers.
function staleFrom(st, previous = {}) {
  const next = { ...previous };
  for (const t of st?.tickets ?? []) {
    for (const k of Object.keys(next)) if (k.startsWith(`${t.key}|`)) delete next[k];
    for (const s of t.steps ?? []) if (s.stale && s.pr && CHAIN.includes(s.stage)) next[`${t.key}|${s.pr}`] = { stage: s.stage, head: s.head ?? null, count: s.stale };
  }
  return next;
}

// PR comments the trigger words keep from the pipeline (lib/world.mjs `sortComments`: a colleague's, a reply in the
// pipeline's or the owner's thread), from the status: { '<key>|<pr>': [{ id, author, link }] }, for the tickets the
// status covers. The owner hands one on or leaves it; it goes once a session recorded it handled, or the PR is done.
function othersFrom(st, previous = {}) {
  const next = { ...previous };
  for (const t of st?.tickets ?? []) {
    for (const k of Object.keys(next)) if (k.startsWith(`${t.key}|`)) delete next[k];
    for (const p of t.prs ?? []) if (p.others?.length) next[`${t.key}|${p.id}`] = p.others.map((c) => ({ id: c.id, author: c.author ?? null, link: c.link ?? null }));
  }
  return next;
}

// What the run looks like in the file, from what the runner has so far. Plain data, kept in the memory so a quiet
// watcher pass can still show the last run.
export function digestRun({ out = {}, st = null, log = [], trigger = null, startedAt = null, now = Date.now() } = {}) {
  const guard = [];
  // Only a run that decides starts says why a group didn't start: the status of a run that only finishes (the watcher's,
  // a run handed one group) still works out which groups could start, and its "starting now" would read as starts.
  const decides = (trigger ?? out.trigger) !== 'watcher' && !out.startKeys;
  for (const e of log) if (e.kind === 'guard' && !guard.some((g) => g.what === e.what && g.reason === e.reason)) guard.push({ what: e.what ?? null, reason: e.reason });
  return {
    at: iso(now),
    startedAt: startedAt ? iso(startedAt) : null,
    trigger: trigger ?? out.trigger ?? null,
    kind: out.morning ? 'morning' : out.startPass === true ? 'startPass' : (trigger ?? out.trigger ?? null),
    steps: (out.ran ?? []).map((s) => ({ stage: s.stage, keys: s.keys ?? [], pr: s.pr ?? null, outcome: s.outcome, note: s.note ?? null })),
    triage: out.triage?.stage ? { keys: out.triage.keys ?? [], outcome: out.triage.outcome ?? null } : null,
    intakeDue: out.triage ? 0 : (st?.intake?.due?.length ?? 0),
    picked: (out.starts ?? []).filter((s) => !s.skipped && !s.waits && !s.held && !s.error).flatMap((s) => (s.steps?.[0]?.keys ?? (s.group ? [s.group] : []))),
    handedOn: (out.handedOn ?? []).map((x) => ({ stage: x.stage, keys: x.keys ?? [], pr: x.pr ?? null, handed: Boolean(x.handedOn), note: x.handedOn ? null : x.waits ?? x.held ?? x.guard ?? x.error ?? null })),
    notStarted: decides ? (st?.notStarted ?? []).map((n) => ({ group: n.group, keys: n.keys ?? [], reasons: n.reasons ?? [] })) : [],
    guard,
    wip: st?.wip ? { inProgress: st.wip.inProgress, waiting: st.wip.waiting, open: st.wip.open, limits: st.wip.limits } : null,
    allowance: st?.allowance ? { remaining: st.allowance.remaining, cap: st.allowance.cap, used: st.allowance.used } : null,
  };
}

// The watcher's last start pass, from the feed; a feed that doesn't read shows none.
function startsOf(state) {
  try {
    return readFeed(state).starts ?? null;
  } catch {
    return null;
  }
}

// Renders and writes `watch/progress.md`. Never throws: a failed write is `{ written: false, error }`.
// `st`: the status the runner already has (optional); `run`: `digestRun`'s data (optional); `flights`: the steps running now.
export function writeProgress({ settings, now = Date.now(), st = null, run = null, live = false, flights = [] }) {
  try {
    const state = settings.state;
    const { ledgers, bad } = readLedgersApart(state);
    const mem = readMemory(state);
    const memory = { ...mem.data, stale: staleFrom(st, mem.data.stale), others: othersFrom(st, mem.data.others), ...(run ? { lastRun: run } : {}) };
    // The first write seeds the gates already standing, so a host that starts using the file isn't told about all of them.
    if (!mem.exists) memory.notified = Object.fromEntries(ledgers.flatMap((l) => gatesOf(l).filter((g) => g.notify).map((g) => [gateId(g), iso(now)])));
    const text = renderProgress({ ledgers, bad, memory, run: run ?? memory.lastRun ?? null, live: live && Boolean(run), flights, now, mode: settings.mode ?? null, stepsText: readSteps(settings.progress?.stepsFile), starts: startsOf(state), startHours: settings.limits?.startHours ?? null });
    atomicWrite(progressPath(state), text);
    atomicWrite(memoryPath(state), JSON.stringify(memory, null, 2) + '\n');
    return { written: true, file: progressPath(state) };
  } catch (e) {
    return { written: false, error: String(e?.message ?? e).split('\n')[0] };
  }
}

// ------------------------------------------------------------------ "your turn"

const gateId = (g) => `${g.key}|${g.kind}|${g.pr ?? ''}|${g.ident}`;

// One notification for each gate reached, never repeated while the gate stands. A gate that is gone is forgotten, so a
// later one of the same kind (a second round of questions) tells again. The first call with no memory only seeds.
// `notify` is the sender (lib/notify.mjs `notify`); none: nothing is sent. Never throws.
export function notifyGates({ settings, notify = null, notifyIo = {}, now = Date.now() }) {
  try {
    if (!notify) return { sent: [], skipped: 'no sender' };
    const state = settings.state;
    const { ledgers } = readLedgersApart(state);
    const gates = ledgers.flatMap((l) => gatesOf(l).filter((g) => g.notify).map((g) => ({ ...g, id: gateId(g), name: l.card?.name ?? '' })));
    const mem = readMemory(state);
    const notified = mem.exists ? { ...(mem.data.notified ?? {}) } : null;
    const next = {};
    const due = [];
    for (const g of gates) {
      if (!notified || notified[g.id]) next[g.id] = notified?.[g.id] ?? iso(now);
      else {
        next[g.id] = iso(now);
        due.push(g);
      }
    }
    // Remembered before it is sent: a sender that hangs or throws can't make the next pass tell it again.
    atomicWrite(memoryPath(state), JSON.stringify({ ...mem.data, notified: next }, null, 2) + '\n');
    const sent = [];
    for (const g of due) {
      try {
        const r = notify({ title: 'Ticket flow: your turn', text: `${g.key}${g.name ? ` ${oneLine(g.name, 70)}` : ''}: ${GATE_ACTION[g.kind]}${g.pr ? ` (${g.pr})` : ''}`, urgent: false }, notifyIo);
        sent.push({ key: g.key, kind: g.kind, pr: g.pr, ...(r ?? {}) });
      } catch (e) {
        sent.push({ key: g.key, kind: g.kind, pr: g.pr, sent: false, why: String(e?.message ?? e).split('\n')[0] });
      }
    }
    return { sent };
  } catch (e) {
    return { sent: [], error: String(e?.message ?? e).split('\n')[0] };
  }
}

// What the watcher does at the end of a check: refresh the file, then tell the owner of the gates just reached.
export function progressAfterCheck({ settings, now = Date.now(), notify = null, notifyIo = {} }) {
  const file = writeProgress({ settings, now });
  return { ...file, ...notifyGates({ settings, notify, notifyIo, now }) };
}

// ------------------------------------------------------------------ the runner's side

// The runner's handle: `write()` at a step boundary, and `tracked(step, fn)` around a step, which shows it running
// (⏳) while `fn` runs and writes again when it ends, whatever its outcome. `off`: a dry run or observe mode, which
// write nothing. `getRun()` gives what the runner has now: { out, st, log, trigger }.
export function liveProgress({ settings, clock = Date.now, off = false, getRun = () => ({}) }) {
  const flights = new Map();
  const startedAt = clock();
  let n = 0;
  const write = (live = true) => {
    if (off) return { written: false, off: true };
    try {
      const now = clock();
      const r = getRun() ?? {};
      return writeProgress({ settings, now, st: r.st ?? null, run: digestRun({ ...r, startedAt, now }), live, flights: [...flights.values()] });
    } catch (e) {
      return { written: false, error: String(e?.message ?? e).split('\n')[0] };
    }
  };
  const tracked = async (step, fn) => {
    const id = ++n;
    flights.set(id, { keys: step.keys ?? [], stage: step.stage, pr: step.pr ?? null, since: clock() });
    write();
    try {
      return await fn();
    } finally {
      flights.delete(id);
      write();
    }
  };
  return { write, tracked, finish: () => write(false) };
}
