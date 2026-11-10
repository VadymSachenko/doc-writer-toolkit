import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readAllLedgers } from './ledger.mjs';
import { readFeed } from './feed.mjs';
import { reviewCommentFor } from './experts.mjs';
import { duration as spell } from './progress.mjs';

// The morning report (design §7): a local file `<state>/reports/<date>.md`, written with no model call. Nothing goes to
// the tracker or the forge. A separate skill reads it on demand.

export const reportPath = (state, date) => path.join(state, 'reports', `${date}.md`);
export const runLogPath = (state, date) => path.join(state, 'runs', `${date}.jsonl`);

export function localDate(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export function readRunLog(state, date) {
  try {
    return fs
      .readFileSync(runLogPath(state, date), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export function appendRunLog(state, date, entries) {
  if (!entries.length) return;
  const file = runLogPath(state, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export function writeReport(state, date, text) {
  const file = reportPath(state, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return file;
}

// The working days (Monday to Friday) wholly between a time and a local date (`YYYY-MM-DD`), neither day counted: the
// days the expert had in full.
export function workingDaysBetween(fromMs, toDate) {
  const [y, m, d] = String(toDate).split('-').map(Number);
  const end = new Date(y, m - 1, d);
  const day = new Date(fromMs);
  day.setHours(0, 0, 0, 0);
  let n = 0;
  for (;;) {
    day.setDate(day.getDate() + 1);
    if (day >= end) return n;
    if (day.getDay() !== 0 && day.getDay() !== 6) n++;
  }
}

const mb = (bytes) => `${((bytes ?? 0) / 1048576).toFixed(1)} MB`;
const link = (t) => (t.card?.url ? `[${t.key}](${t.card.url})` : t.key);
const cardName = (t) => (t.card?.name ? ` ${t.card.name.replace(/\s+/g, ' ').slice(0, 90)}` : '');
const list = (rows, empty = 'none') => (rows.length ? rows.map((r) => `- ${r}`).join('\n') : `- ${empty}`);

// The report's text, from a status, the ledgers, the run log, the cards left in the host jobs' watch lists and the
// weekly roles proposal.
export function renderReport({ settings, st, date, runLog = [], watched = [], proposal = null, ledgers = readAllLedgers(settings.state) }) {
  const out = [];
  const byKey = new Map(ledgers.map((l) => [l.key, l]));
  out.push(`# Ticket flow, ${date}`, '');
  const a = st.allowance;
  // With `limits.open`, the tickets that hold its slots, by name.
  const open = typeof st.wip.limits.open === 'number' ? `, open ${st.wip.open} of ${st.wip.limits.open}${st.wip.openKeys?.length ? ` (${st.wip.openKeys.join(', ')})` : ''}` : '';
  out.push(`Mode \`${st.mode}\`. In progress ${st.wip.inProgress} of ${st.wip.limits.inProgress}, waiting ${st.wip.waiting} of ${st.wip.limits.waiting}${open}${st.wip.manual ? `, ${st.wip.manual} started by hand (not counted)` : ''}.`);
  out.push(a ? `Allowance: day ${a.day} of the week window, ${a.used}% of the week used of ${a.cap}% allowed by now, ${a.remaining}% left today; finishing the tickets in work needs about ${a.inWork}%${a.inWorkUnknown?.length ? ` plus ${a.inWorkUnknown.length} ticket(s) with no estimate yet` : ''}.` : 'Allowance: no usage reading.');
  out.push('');

  const waitingOwner = st.tickets.filter((t) => t.held || ['questions', 'planGate', 'ownerBlock', 'paused', 'reworkWait', 'finalReview'].includes(t.state));
  out.push('## Waiting for you', '', list(waitingOwner.map((t) => `${link(t)}${cardName(t)}: ${t.state}${t.gate?.why ? `, ${t.gate.why}` : ''}`)), '');

  // Per PR in the owner's queue, whether the writer recommends an expert review and why (the `pr` record). The owner
  // decides: moving the card to the review status calls the expert; nothing waits on it.
  const experts = [];
  for (const t of st.tickets) {
    for (const p of t.prs ?? []) {
      if (p.stage !== 'finalReview' || !p.expertReview) continue;
      experts.push(`${p.url ? `[${p.id}](${p.url})` : p.id} (${link(t)}): ${p.expertReview.recommended ? 'an expert review is recommended' : 'no expert review is recommended'}: ${p.expertReview.why}`);
    }
  }
  out.push('## Expert review, your call', '', list(experts), '');

  // Per PR in the expert's review, the expert quiet for `schedule.expertQuietDays` working days or more since the PR
  // entered the review or since their last review or comment: a line with the text to send them (D-082).
  const quiet = [];
  const days = settings.schedule.expertQuietDays;
  for (const t of st.tickets) {
    for (const p of t.prs ?? []) {
      if (p.stage !== 'smeReview' || (p.state && p.state !== 'open')) continue;
      const since = [p.smeSince, p.reviewerAt].filter((x) => x && !Number.isNaN(Date.parse(x))).map((x) => Date.parse(x));
      if (!since.length) continue;
      const last = Math.max(...since);
      const n = workingDaysBetween(last, date);
      if (n < days) continue;
      const text = reviewCommentFor(settings, p.url);
      quiet.push(`${p.url ? `[${p.id}](${p.url})` : p.id} (${link(t)}): no word from the expert for ${n} working day(s), since ${localDate(last)}${text ? `. To send: ${text.replace(/\s*\n\s*/g, ' ')}` : ''}`);
    }
  }
  out.push('## Expert review gone quiet', '', list(quiet), '');

  const places = [];
  const check = [];
  const ready = [];
  const checkLabel = settings.forge.checkLabel?.toLowerCase();
  for (const t of st.tickets) {
    const l = byKey.get(t.key);
    for (const p of t.prs ?? []) {
      const open = (l?.places ?? []).filter((x) => x.repo === p.repo && Number(x.pr) === Number(p.number) && (x.state ?? 'open') === 'open').length;
      if (open && p.state !== 'merged') places.push(`${p.url ? `[${p.id}](${p.url})` : p.id} (${link(t)}): ${open} open place(s)`);
      if (checkLabel && (p.labels ?? []).some((x) => x.toLowerCase() === checkLabel)) check.push(`${p.url ? `[${p.id}](${p.url})` : p.id} (${link(t)})`);
      if (p.stage === 'readyForMerge') ready.push(`${p.url ? `[${p.id}](${p.url})` : p.id} (${link(t)}): ready for your final edit and the merge`);
      else if (p.stage === 'finalReview' && t.state !== 'finalReview' && t.prs.length > 1) ready.push(`${p.id} (${link(t)}): in the owner's queue; it waits for the card, which stands where the slower PR is`);
    }
  }
  out.push('## PRs with places', '', list(places), '');
  out.push(`## PRs labelled «${settings.forge.checkLabel ?? 'check'}»`, '', list(check), '');

  const videos = [];
  for (const t of st.tickets.filter((x) => (x.derivedState ?? x.state) === 'videoGate')) {
    const l = byKey.get(t.key);
    const parts = (l?.video?.videos ?? []).flatMap((v) => v.parts.map((p) => ({ ...p, video: v.file })));
    const missing = parts.filter((p) => !p.transcript || !fs.existsSync(path.resolve(settings.root, p.transcript)));
    const failed = missing.flatMap((p) => (p.tries ?? []).filter((x) => x.outcome === 'failed').map((x) => x.reason)).filter(Boolean);
    const today = missing.slice(0, settings.video.partsPerDay);
    videos.push(`${link(t)}: ${missing.length} part(s) without a transcript; to upload today: ${today.map((p) => `\`${p.file}\` (from ${p.start ?? 0} s, save as \`${p.transcript}\`)`).join(', ') || 'none'}${failed.length ? `; the automatic try failed: ${[...new Set(failed)].join('; ')}` : ''}`);
  }
  out.push('## Videos waiting for transcripts', '', list(videos), '');
  out.push('## Ready for merge', '', list(ready), '');

  // With `forge.keepFresh`: today's merges of the base into the PRs' branches and their conflicts (the run log), and the
  // open PRs still behind their base.
  if (settings.keepFresh) {
    const merges = runLog.filter((e) => e.kind === 'step' && (e.stage === 'baseMerge' || e.stage === 'baseFix') && e.outcome !== 'moved').map((e) => `${e.at} ${e.pr ?? (e.keys ?? []).join(', ')} ${e.stage}: ${e.note ?? e.outcome}`);
    const behind = st.tickets.flatMap((t) => (t.prs ?? []).filter((p) => p.state !== 'merged' && p.behind > 0).map((p) => `${p.url ? `[${p.id}](${p.url})` : p.id} (${link(t)}): ${p.behind} commit(s) behind its base, at ${p.stage}${p.stage === 'readyForMerge' ? '' : ' (merged in from ready for merge on)'}`));
    out.push('## Kept up to date with the base', '', list([...merges, ...behind], 'no merge of the base today, and no ready PR behind it'), '');
  }

  for (const w of watched) out.push(`## Cards left in ${w.list}`, '', list(w.cards.map((c) => `[${c.name}](${c.url}), last activity ${c.lastActivity}`)), '');

  // The watcher: when it last read each source, what fails, and the host jobs waiting for their quiet hours.
  let feed = null;
  try {
    feed = readFeed(settings.state);
  } catch {
    /* unreadable: left out */
  }
  if (feed && Object.keys(feed.sources).length) {
    const checks = Object.values(feed.sources).map((x) => x.lastCheck).filter(Boolean).sort();
    const failing = Object.entries(feed.sources).filter(([, x]) => x.failingSince).map(([n, x]) => `${n} failing since ${x.failingSince}: ${x.lastError ?? 'error'}`);
    const jobs = (settings.hostJobs ?? []).map((j) => {
      const js = feed.jobs?.[j.name] ?? {};
      // A job that fails is tried at each check; after an hour of failing it is disarmed (`lastFailure`).
      const failing = js.failingSince ? `, failing since ${js.failingSince} (${js.failures ?? 0} tries)` : '';
      if (j.watch && js.armed) return `${j.name}: new cards in ${j.watch.list} since ${js.firstChange}; runs ${j.quietHours} h after the last change (${js.lastChange})${failing}${js.heldUntil ? `, held by the guard until ${js.heldUntil}` : ''}`;
      return `${j.name}: ${js.lastRun ? `last run ${js.lastRun}` : 'not run yet'}${failing}${js.lastFailure ? `, disarmed after an hour of failing at ${js.lastFailure}${js.rearmed ? `, re-armed at ${js.rearmed.at} (${js.rearmed.why})` : ''}` : ''}${js.heldUntil ? `, held until ${js.heldUntil}` : ''}`;
    });
    // The last start pass between morning runs (lib/watch.mjs), and a change it keeps for the start hours.
    const s = feed.starts;
    const pass = s?.by === 'watcher' && s.date === date ? ` The last start pass when a slot freed: ${s.at}, ${!s.outcome || s.outcome === 'running' ? 'the run that wrote this report' : s.outcome}.` : '';
    const kept = s?.deferred ? ` A change waits for the start hours (${s.deferred}).` : '';
    out.push('## The watcher', '', `Last check ${checks.at(-1) ?? 'never'}; the morning run ${feed.morning?.lastDate === date ? `ran at ${feed.morning.at ?? date}` : 'has not run on this date'}.${pass}${kept}`, '', list([...failing, ...jobs], 'no source failing, no host job'), '');
  }

  out.push('## Starting and finishing', '');
  const steps = st.tickets.filter((t) => t.next);
  out.push(list(steps.map((t) => `${link(t)}: next ${t.next.stage}${t.next.pr ? ` on ${t.next.pr}` : ''}${t.next.role ? ` (${t.next.role})` : ' (no model)'}${t.next.waits ? `; failed at ${t.failed.at}, waits for ${t.next.waits}` : ''}`), 'nothing to finish'));
  out.push('', list(st.startable.map((g) => `start ${g.group} (${g.priority}${g.estimate !== null ? `, about ${g.estimate}%` : ', no estimate yet'})`), 'no group can start'));
  if (st.notStarted.length) out.push('', list(st.notStarted.map((g) => `${g.group} (${g.priority}) didn't start: ${g.reasons.join('; ')}`)));
  out.push('');

  // A closed ticket in the owner's hands (an imported one, say) is no longer in anyone's hands: left out.
  const odd = st.tickets.filter((t) => t.mismatch?.length || (t.hand && t.state !== 'closed') || ['outside', 'merged'].includes(t.state));
  out.push('## Mismatches and tickets in your hands', '', list(odd.map((t) => `${link(t)}${cardName(t)}: ${t.state}${t.hand ? ', mode hand' : ''}${t.mismatch?.length ? `; ${t.mismatch.join('; ')}` : ''}${t.notes?.length ? `; ${t.notes.join('; ')}` : ''}`)), '');
  if (st.notTickets.length) out.push('## Cards that are not tickets', '', list(st.notTickets.map((c) => `[${c.key}](${c.card.url})${cardName(c)}: ${c.why}`)), '');

  // Cleanup after the merge (D-074): what went today, and what stays because a PR was closed unmerged.
  const onDate = (iso) => Boolean(iso) && Number.isFinite(Date.parse(iso)) && localDate(Date.parse(iso)) === date;
  const cleaned = ledgers.filter((l) => l.stages?.close?.result?.cleanup && onDate(l.stages.close.at));
  const freed = cleaned.reduce((s, l) => s + (l.stages.close.result.cleanup.freedBytes ?? 0), 0);
  const removedLines = cleaned.flatMap((l) => {
    const c = l.stages.close.result.cleanup;
    if (c.blocked) return [`${l.key}: ${c.blocked}`];
    const trees = (c.worktrees ?? []).filter((t) => t.removed);
    const stuck = (c.worktrees ?? []).filter((t) => !t.removed && t.error);
    const held = (c.worktrees ?? []).filter((t) => !t.removed && t.kept);
    return [`${l.key}: ${c.removed.length} path(s), ${mb(c.freedBytes)} ${c.mode === 'delete' ? 'deleted' : 'moved to the Trash'}${c.removed.length ? ` (${c.removed.map((r) => `\`${r.path}\``).join(', ')})` : ''}${trees.length ? `; ${trees.length} worktree(s) removed with git` : ''}${c.deletedWithWorktree?.length ? `; deleted with the worktree, not in the Trash: ${c.deletedWithWorktree.map((d) => `\`${d.path}\``).join(', ')}` : ''}${stuck.length ? `; git would not remove ${stuck.map((t) => `\`${t.path}\` (${t.error})`).join(', ')}` : ''}${held.length ? `; worktree(s) kept: ${held.map((t) => `\`${t.path}\` (${t.kept}): ${t.todo}`).join('; ')}` : ''}${c.kept.length ? `; kept ${c.kept.map((k) => `\`${k.path}\` (${k.reason})`).join(', ')}` : ''}`];
  });
  const unmerged = st.tickets.filter((t) => t.state === 'outside' && (t.notes ?? []).some((n) => /closed unmerged/.test(n)) && (byKey.get(t.key)?.files ?? []).length);
  for (const e of runLog.filter((x) => x.kind === 'legacyMarkdown' && x.outcome === 'removed')) removedLines.push(`${e.key}: the Markdown ledger \`${e.file}\` (closed; its JSON holds every line) ${e.to === 'deleted' ? 'deleted' : 'moved to the Trash'}`);
  for (const t of unmerged) removedLines.push(`${t.key}: a PR was closed unmerged, so its ${byKey.get(t.key).files.length} work file(s) stay (${mb(byKey.get(t.key).files.reduce((s, f) => s + (f.bytes ?? 0), 0))})`);
  out.push('## Work files removed after the merge', '', list(removedLines), ...(freed ? ['', `Space freed today: ${mb(freed)}.`] : []), '');

  const failures = runLog.filter((e) => e.outcome === 'failed' || e.kind === 'guard');
  out.push('## Failures and guard stops', '', list(failures.map((e) => `${e.at} ${[e.key ?? e.group ?? (e.keys ?? []).join(', '), e.stage ?? e.what ?? (e.job ? `job ${e.job}` : null)].filter(Boolean).join(' ')}: ${e.note ?? e.reason ?? e.outcome}`)), '');

  // A session is a run with a model: the runner's own build (`script`) is not one.
  const today = ledgers.flatMap((l) => (l.runs ?? []).filter((r) => onDate(r.start) && !r.script).map((r) => ({ ...r, key: l.key })));
  const cost = today.reduce((s, r) => s + (typeof r.costUsd === 'number' ? r.costUsd * (r.share ?? 1) : 0), 0);
  out.push("## The day's cost", '', `${today.length} session(s) today, about $${cost.toFixed(2)} by the CLI's estimate.${a ? ` Week: ${a.used}% used.` : ''}`, '');
  // Each step today by its wall-clock time (start to end), the runner's own build too, with the session's own count when
  // it is a minute or more shorter: what a step took, not only what its session counted.
  const timed = ledgers.flatMap((l) => (l.runs ?? []).filter((r) => onDate(r.start) && typeof r.wallMs === 'number').map((r) => ({ ...r, key: l.key }))).sort((x, y) => String(x.start).localeCompare(String(y.start)));
  if (timed.length) {
    const total = timed.reduce((s, r) => s + r.wallMs * (r.share ?? 1), 0);
    out.push("## Today's steps by wall-clock time", '', `${spell(total)} in all.`, '', list(timed.map((r) => `${new Date(Date.parse(r.start)).toTimeString().slice(0, 5)} ${r.key} ${r.stage}${r.pr ? ` (${r.pr})` : ''}${r.script ? (r.stage === 'baseMerge' ? ', the runner\'s merge of the base' : ', the runner\'s build') : ''}: ${spell(r.wallMs)}${typeof r.durationMs === 'number' && r.wallMs - r.durationMs >= 60000 ? ` (session ${spell(r.durationMs)})` : ''}, ${r.outcome}`)), '');
  }
  if (proposal?.proposals?.length) {
    out.push('## Proposed changes to the roles (yes or no)', '', list(proposal.proposals.map((p) => `${p.role}: ${p.change} (${p.why})`)), '');
  }
  return out.join('\n');
}
