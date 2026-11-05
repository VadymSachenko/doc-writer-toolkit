import { CliError, Refused } from './errors.mjs';
import { checkKey, newLedger, newPr, readAllLedgers, readLedger, writeLedger } from './ledger.mjs';
import { lockOf, moveStaleLock, releaseLock, takeLock } from './locks.mjs';
import { labelCheck } from './intake.mjs';
import { prLinks } from './world.mjs';

// `handover <key>`: the owner hands a ticket to the pipeline (mode hand -> pipeline), or takes it back (--to hand).
// A ticket with no ledger (lost, or from before the ledgers) is rebuilt from the tracker and the forge first.

export const PR_STAGE_FROM_CARD = { inProgress: 'reworkWait', blocked: 'questions', smeReview: 'smeReview', finalReview: 'finalReview' };

export async function runHandover({ settings, clients, key: keyIn, to = 'pipeline', now = Date.now() }) {
  const key = checkKey(keyIn);
  if (!['pipeline', 'hand'].includes(to)) throw new CliError('--to must be pipeline or hand', { code: 2 });
  const at = new Date(now).toISOString();
  const existing = readLedger(settings.state, key);
  if (existing) {
    if (existing.mode === to) return { key, mode: to, changed: false };
    const l = structuredClone(existing);
    l.mode = to;
    l.seq += 1;
    l.updatedAt = at;
    l.log.push({ seq: l.seq, at, stage: 'handover', outcome: 'done', note: `mode ${existing.mode} -> ${to}` });
    writeLedger(settings.state, l);
    return { key, mode: to, changed: true };
  }
  if (to === 'hand') throw new Refused('noLedger', `ticket ${key} has no ledger: it is already observed only`);

  // Rebuild: the open card with this key, its PR links, each PR's state on the forge.
  const found = /^\d+$/.test(key) ? await clients.tracker.findCards({ number: Number(key) }) : await clients.tracker.findCards({ link: key });
  const card = found.cards.find((c) => !c.closed && c.status);
  if (!card) throw new Refused('card', `no open card in the flow has the key ${key}`);
  const detail = await clients.tracker.readCard({ card: card.id });
  const l = newLedger({ key, card: detail, now: at, mode: 'pipeline' });
  l.startedBy = 'manual';
  l.triage = { verdict: 'legacy', targets: labelCheck(detail, settings, null).targets, size: null, at };
  l.left = { status: card.status, list: { id: card.list?.id ?? null, name: card.list?.name ?? null }, at };
  l.legacy = { rebuiltAt: at, from: 'the tracker and the forge' };
  for (const link of prLinks(detail.comments.map((c) => c.text).join('\n'), settings)) {
    const st = await clients.forge.prState({ repo: link.repo, number: link.number });
    const targets = settings.targets.filter((t) => t.repo === link.repo);
    const named = targets.filter((t) => t.appLabel && l.triage.targets.includes(t.id));
    const use = named.length ? named : targets;
    const pr = newPr({ repo: link.repo, targets: use.map((t) => t.id), review: use.some((t) => t.review === 'sme') ? 'sme' : 'places', branch: st.head, base: st.base });
    pr.number = link.number;
    pr.url = st.url;
    pr.lastSeenHead = st.headCommit;
    pr.stage = st.state === 'merged' ? 'merged' : PR_STAGE_FROM_CARD[card.status] ?? 'finalReview';
    if (st.state === 'merged') pr.merged = { at: st.mergedAt, commit: st.mergeCommit };
    l.prs.push(pr);
  }
  l.seq = 1;
  if (l.prs.length) {
    l.stages.pr = { status: 'done', seq: 1, at, note: 'rebuilt at handover' };
    l.stage = 'pr';
  } else if (card.status !== 'ready') {
    l.stages.start = { status: 'done', seq: 1, at, note: 'rebuilt at handover' };
    l.stage = 'start';
  }
  l.log.push({ seq: 1, at, stage: 'handover', outcome: 'done', note: `rebuilt from the tracker and the forge, ${l.prs.length} PR(s); mode pipeline` });
  writeLedger(settings.state, l);
  return { key, mode: 'pipeline', changed: true, rebuilt: true, prs: l.prs.map((p) => `${p.repo}#${p.number}`), state: card.status };
}

// The group a key's ledger belongs to, or the key itself.
export function groupOfKey(settings, key) {
  return readLedger(settings.state, checkKey(key))?.group ?? key;
}

export function runLock({ settings, group, kind, stage, now = Date.now() }) {
  const r = takeLock(settings.state, { group, kind, stage, leaseMinutes: settings.limits.lockLeaseMinutes, now });
  if (r.taken) return { group, taken: true, lock: r.lock };
  const h = r.held;
  if (h?.live) throw new Refused('locked', `group ${group} is held by a ${h.kind ?? 'run'} run${h.stage ? ` at the stage ${h.stage}` : ''} until ${h.expiresAt ?? 'its owner file is written'}`, { held: h });
  throw new Refused('stale', `group ${group} has a stale lock (its lease ran out at ${h?.expiresAt}): the runner releases it`, { held: h });
}

// Releasing a lock. A stale one is moved aside, and every stage its group's tickets recorded `running` is recorded
// `failed`, so the next run repeats it.
export function runUnlock({ settings, group, stale = false, now = Date.now() }) {
  const lock = lockOf(settings.state, group, now);
  if (!lock) return { group, released: false, reason: 'not locked' };
  if (!stale) return { group, released: releaseLock(settings.state, group) };
  if (lock.live) throw new Refused('live', `the lock of ${group} is live until ${lock.expiresAt}; only a stale one is moved aside`);
  const failed = failRunning(settings, group, `interrupted: the lock lease ran out at ${lock.expiresAt ?? 'an unknown time'}`, now);
  const moved = moveStaleLock(settings.state, group, now);
  return { group, released: true, stale: true, movedTo: moved, failed };
}

export function failRunning(settings, group, note, now = Date.now()) {
  const at = new Date(now).toISOString();
  const out = [];
  for (const l of readAllLedgers(settings.state).filter((x) => x.group === group)) {
    const marks = [];
    for (const [stage, rec] of Object.entries(l.stages ?? {})) if (rec?.status === 'running') marks.push({ rec, stage });
    for (const pr of l.prs ?? []) for (const [stage, rec] of Object.entries({ ...(pr.chain ?? {}), ...(pr.steps ?? {}) })) if (rec?.status === 'running') marks.push({ rec, stage, pr: `${pr.repo}#${pr.number}` });
    if (!marks.length) continue;
    for (const m of marks) {
      l.seq += 1;
      Object.assign(m.rec, { status: 'failed', seq: l.seq, at, note });
      l.log.push({ seq: l.seq, at, stage: m.stage, ...(m.pr ? { pr: m.pr } : {}), outcome: 'failed', note });
      out.push({ key: l.key, stage: m.stage, ...(m.pr ? { pr: m.pr } : {}) });
    }
    l.updatedAt = at;
    writeLedger(settings.state, l);
  }
  return out;
}
