import { PAGE_STAGES, dateOnlyChange, fileHash, headText, listPages, norm, readText, sectionFile, uncommitted, withoutDates } from './ledger.mjs';

const ok = (state) => state === 'done' || state === 'skipped';

// A page gets at most this many review rounds; what is left after the last one goes to UA approval as open findings.
export const MAX_REVIEW_ROUNDS = 2;

// The round a review of the page's current version is: the same version again keeps its round; a review after a fix
// that started on the last reviewed version is the next round; anything else (a first review, a hand edit) is round 1.
export function reviewRound(page, cur) {
  const last = page.review;
  if (!last) return 1;
  if (cur === last.hash) return last.round;
  const fix = page.stages?.fix;
  if (fix?.status === 'done' && page.fixFrom?.hash === last.hash && page.fixFrom.seq > last.seq) return last.round + 1;
  return 1;
}

async function evidenceMatches(root, rec) {
  for (const e of rec.evidence ?? []) if ((await fileHash(root, e.path)) !== e.hash) return false;
  return true;
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The section stages, checked against the files. Before the plan is approved a changed readiness report, app notes
// or page set makes that stage stale; after it, only a warning: the approved plan drives the run.
async function sectionStates(root, ledger, warnings) {
  const s = ledger.stages ?? {};
  const approvedEver = s.planApproval?.status === 'done';
  const out = {};
  const plain = (rec) => (!rec ? 'pending' : rec.status === 'done' ? 'done' : rec.status);

  for (const name of ['readiness', 'explore']) {
    const rec = s[name];
    let state = plain(rec);
    let note = rec?.note ?? null;
    if (state === 'done') {
      const pagesNow = name === 'readiness' ? await listPages(root, ledger.section) : null;
      const changed = !(await evidenceMatches(root, rec));
      const pagesChanged = name === 'readiness' && rec.pages && !sameSet(rec.pages, pagesNow);
      if (changed || pagesChanged) {
        const what = pagesChanged ? 'the section\'s page set changed' : `${rec.evidence?.[0]?.path} changed`;
        if (approvedEver) warnings.push(`${what} after the plan was approved; the plan may be out of date`);
        else {
          state = 'stale';
          note = `${what} since this stage ran`;
        }
      }
    }
    out[name] = { state, note, result: rec?.result ?? null };
  }

  {
    const rec = s.plan;
    let state = plain(rec);
    let note = rec?.note ?? null;
    if (state === 'done') {
      // A plan edited after it was written is not stale: gate G1 shows it again (planApproval below).
      for (const e of rec.evidence ?? []) {
        if ((await fileHash(root, e.path)) === null) {
          state = 'stale';
          note = `${e.path} is missing`;
        }
      }
      if (!approvedEver && state === 'done') {
        const earlier = ['readiness', 'explore'].find((n) => !ok(out[n].state) || (s[n]?.seq ?? 0) > rec.seq);
        if (earlier) {
          state = 'stale';
          note = `${earlier} ran again or is not done`;
        }
      }
    }
    out.plan = { state, note, result: rec?.result ?? null };
  }

  {
    const rec = s.planApproval;
    let state = plain(rec);
    let note = rec?.note ?? null;
    if (state === 'done') {
      if (out.plan.state !== 'done' || (s.plan?.seq ?? 0) > rec.seq) {
        state = 'stale';
        note = 'the plan ran again or is not done';
      } else if (!(await evidenceMatches(root, rec))) {
        state = 'stale';
        note = 'the plan changed after it was approved';
      }
    }
    out.planApproval = { state, note, result: rec?.result ?? null };
  }

  // Resolve covers every page: a page written after it makes it stale.
  {
    const rec = s.resolve;
    let state = plain(rec);
    let note = rec?.note ?? null;
    if (ok(state)) {
      const later = (ledger.pages ?? []).filter((p) => p.stages?.write?.status === 'done' && p.stages.write.seq > rec.seq);
      if (later.length) {
        state = 'stale';
        note = `written after it ran: ${later.map((p) => p.id).join(', ')}`;
      }
    }
    out.resolve = { state, note, result: rec?.result ?? null };
  }
  return out;
}

// One page: each stage's state, from its record and the current hashes, in chain order.
async function pageState(root, ledger, page, warnings) {
  let cur = await fileHash(root, page.path);
  const curEn = await fileHash(root, page.enPath);
  // A translation interrupted (or failed) after the translator saved: the UA page differs from the approved version
  // only in its frontmatter dates. That is the translator's date bump, not an edit: the records still hold.
  const approved = page.stages?.uaApproval?.status === 'done' ? page.stages.uaApproval.uaHash : null;
  const tr = page.stages?.translate?.status;
  let dateBump = false;
  if (approved && cur !== null && cur !== approved && (tr === 'running' || tr === 'failed')) {
    dateBump = (await dateOnlyChange(root, page.path, approved)).dateOnly;
    if (dateBump) cur = approved;
  }
  const stages = {};
  let prevOk = true;
  for (const name of PAGE_STAGES) {
    const rec = page.stages?.[name];
    let state = !rec ? 'pending' : rec.status;
    if (state === 'done') {
      const valid = {
        write: cur !== null,
        fix: rec.uaHash === cur,
        review: rec.uaHash === cur,
        uaApproval: rec.uaHash === cur,
        translate: rec.uaHash === cur && curEn !== null,
        align: rec.uaHash === cur && rec.enHash === curEn,
      }[name];
      if (!valid || !prevOk) state = 'stale';
    }
    stages[name] = state;
    prevOk = ok(state);
  }
  const written = page.stages?.write?.status === 'done';
  const handEdited = written && cur !== null && cur !== page.uaHash;
  const enHandEdited = Boolean(page.enHash) && curEn !== page.enHash;
  const unknownDraft = stages.write !== 'done' && cur !== null && cur !== page.uaHash;
  const results = Object.fromEntries(PAGE_STAGES.filter((n) => page.stages?.[n]?.result).map((n) => [n, page.stages[n].result]));
  const review = page.stages?.review;
  const fix = page.stages?.fix;
  const counts = review?.result ?? {};
  const reviewRoundNow = (stages.review === 'done' ? review.result?.round : null) ?? page.review?.round ?? null;
  // Errors or deviations left after a round below the cap: fix and review again, unless a fix already ran after it.
  const reviewAgain = stages.review === 'done'
    && (reviewRoundNow ?? 1) < MAX_REVIEW_ROUNDS
    && (Number(counts.errors) || 0) + (Number(counts.deviations) || 0) > 0
    && !(fix?.status === 'done' && fix.seq > review.seq);
  if (written && cur === null) warnings.push(`${page.id}: the page is missing; it is written again`);
  if (handEdited) warnings.push(`${page.id}: the UA page changed outside the pipeline; its fix, review, approval, translation and alignment run again`);
  if (enHandEdited) warnings.push(`${page.id}: the EN page changed outside the pipeline; only its alignment runs again`);
  if (dateBump) warnings.push(`${page.id}: the UA page differs from the approved version only in its date (an interrupted translation); the records still hold`);
  return {
    id: page.id,
    path: page.path,
    enPath: page.enPath,
    action: page.action,
    docType: page.docType,
    order: page.order,
    from: page.from ?? [],
    exists: cur !== null,
    enExists: curEn !== null,
    handEdited,
    enHandEdited,
    unknownDraft,
    dateBump,
    blocked: page.blocked ?? null,
    stages,
    results,
    reviewRound: reviewRoundNow,
    reviewAgain,
    syncBase: page.syncBase ?? ledger.baseCommit,
  };
}

// Checks the ledger against the files. Writes nothing: a stale stage is derived on every call, never stored.
export async function computeStatus(root, section, ledger) {
  const file = sectionFile(section, 'ledger');
  if (!ledger) {
    return { section: norm(section), ledger: 'absent', file, baseCommit: null, stages: {}, pages: [], listed: [], outside: [], blocked: [], next: { stage: 'readiness', pages: [] }, gate: null, warnings: [] };
  }
  const warnings = [];
  const stages = await sectionStates(root, ledger, warnings);
  const pages = [];
  for (const p of ledger.pages ?? []) pages.push(await pageState(root, ledger, p, warnings));

  const known = new Set([...pages.map((p) => p.path), ...(ledger.listed ?? []).map((l) => l.path)]);
  const outside = ledger.stages?.planApproval?.status === 'done' ? (await listPages(root, ledger.section)).filter((p) => !known.has(p)) : [];
  for (const p of outside) warnings.push(`${p}: not in the approved plan; outside this run`);

  const next = await nextStage(root, stages, pages);
  return {
    section: ledger.section,
    ledger: 'present',
    file,
    pair: ledger.pair ?? null,
    roots: ledger.roots,
    baseCommit: ledger.baseCommit,
    stages,
    pages,
    listed: ledger.listed ?? [],
    outside,
    blocked: pages.filter((p) => p.blocked).map((p) => ({ id: p.id, ...p.blocked })),
    next,
    gate: gateOf(stages, pages, next),
    warnings,
  };
}

// The first stage in chain order that isn't done. A page stage runs across all pages before the next one starts;
// a blocked page doesn't hold the others back.
async function nextStage(root, stages, pages) {
  for (const name of ['readiness', 'explore', 'plan', 'planApproval']) {
    if (!ok(stages[name].state)) return { stage: name, state: stages[name].state, pages: [] };
  }
  const active = pages.filter((p) => !p.blocked);
  const need = (name) => active.filter((p) => !ok(p.stages[name]) || (name === 'fix' && p.reviewAgain)).map((p) => p.id);
  if (need('write').length) return { stage: 'write', pages: need('write') };
  if (pages.length && !ok(stages.resolve.state)) return { stage: 'resolve', state: stages.resolve.state, pages: [] };
  for (const name of PAGE_STAGES.slice(1)) {
    const ids = need(name);
    if (!ids.length) continue;
    const out = { stage: name, pages: ids };
    if (name === 'translate') {
      const due = active.filter((p) => ids.includes(p.id));
      const dirty = await uncommitted(root, due.map((p) => p.path));
      // A date bump of an interrupted translation is not a change to commit: the translation reads the commit before it.
      for (const p of due) if (p.dateBump && dirty.has(p.path) && (await sameButDates(root, p.path))) dirty.delete(p.path);
      out.uncommitted = due.filter((p) => dirty.has(p.path)).map((p) => p.id);
    }
    return out;
  }
  return { stage: null, pages: [] };
}

async function sameButDates(root, file) {
  const [head, now] = [await headText(root, file), await readText(root, file)];
  return head !== null && now !== null && withoutDates(head) === withoutDates(now);
}

function gateOf(stages, pages, next) {
  if (next.stage === 'planApproval' && stages.plan.state === 'done') return { name: 'plan', pages: [] };
  if (next.stage === 'write') {
    const drafts = pages.filter((p) => next.pages.includes(p.id) && p.unknownDraft).map((p) => p.id);
    if (drafts.length) return { name: 'unknownDraft', pages: drafts };
  }
  if (next.stage === 'uaApproval') return { name: 'uaApproval', pages: next.pages };
  if (next.stage === 'translate' && next.uncommitted.length) return { name: 'commit', pages: next.uncommitted };
  return null;
}

// The status as a short Markdown block for the conversation.
export function renderMarkdown(st) {
  if (st.ledger === 'absent') return `**Section:** \`${st.section}\` · no ledger yet (\`${st.file}\`): a fresh run.\n\n**Next:** readiness`;
  const short = { done: 'done', skipped: 'skipped', pending: '·', running: 'running', failed: 'FAILED', stale: 'stale' };
  const lines = [`**Section:** \`${st.section}\`${st.pair ? ` (pair \`${st.pair}\`)` : ''} · base \`${String(st.baseCommit).slice(0, 7)}\``, ''];
  lines.push('| Stage | State | Note |', '|---|---|---|');
  for (const [name, s] of Object.entries(st.stages)) lines.push(`| ${name} | ${short[s.state] ?? s.state} | ${s.note ?? ''} |`);
  if (st.pages.length) {
    lines.push('', `| # | Page | Action | Type | ${PAGE_STAGES.join(' | ')} | Flags |`, `|---|---|---|---|${PAGE_STAGES.map(() => '---|').join('')}---|`);
    for (const p of st.pages) {
      const r = p.results?.review;
      const open = p.results?.fix?.open;
      const flags = [
        p.blocked && `blocked at ${p.blocked.stage}: ${p.blocked.reason}`,
        p.handEdited && 'UA edited by hand',
        p.enHandEdited && 'EN edited by hand',
        p.unknownDraft && 'unknown draft on disk',
        p.dateBump && 'UA date bumped',
        r && `review round ${r.round ?? p.reviewRound ?? '?'}: ${r.errors ?? '?'} E, ${r.deviations ?? '?'} D, ${r.suggestions ?? '?'} S`,
        p.reviewAgain && 'another review round due',
        Array.isArray(open) && open.length && `${open.length} unapplied fixer finding(s)`,
      ].filter(Boolean).join('; ');
      lines.push(`| ${p.order ?? ''} | \`${p.id}\` | ${p.action} | ${p.docType} | ${PAGE_STAGES.map((n) => short[p.stages[n]] ?? p.stages[n]).join(' | ')} | ${flags} |`);
    }
  }
  if (st.listed.length) lines.push('', `**Listed, not processed:** ${st.listed.map((l) => `\`${l.path}\` (${l.reason}${l.into ? ` → ${[].concat(l.into).join(', ')}` : ''})`).join('; ')}`);
  lines.push('', `**Next:** ${st.next.stage ?? 'nothing: the chain is complete'}${st.next.pages.length ? ` — ${st.next.pages.join(', ')}` : ''}`);
  if (st.gate) lines.push(`**Gate:** ${st.gate.name}${st.gate.pages.length ? ` — ${st.gate.pages.join(', ')}` : ''}`);
  for (const w of st.warnings) lines.push(`- ${w}`);
  return lines.join('\n');
}
