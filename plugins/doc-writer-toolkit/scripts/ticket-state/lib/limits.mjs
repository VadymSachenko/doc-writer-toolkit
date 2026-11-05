import { PRIORITY_RANK } from './stages.mjs';
import { groupId, sortKeys } from './ledger.mjs';
import { SIZES } from './settings.mjs';

// The limits (design §7, D-042, D-066, D-067, D-071):
//   - `inProgress` counts tickets planning or writing; `waiting` counts questions, plan gates, video gates, PRs waiting
//     on their places, and tickets the owner blocked or took back. Review and final review count for nothing.
//   - only tickets a scheduled run started, in mode pipeline, count; a manual start stays out for its whole life;
//   - a scheduled run starts a ready group only if inProgress + its size ≤ the ceiling and waiting < its limit; a group
//     larger than the ceiling starts only when nothing is in progress;
//   - and only if its estimated cost, added to the remaining cost of every ticket in work, fits the day's remaining
//     allowance. With no estimate for a size yet, one ticket at a time;
//   - `open` (when set) counts the tickets a scheduled run started that are not merged yet, SME review and final review
//     included: a group starts only if open + its size ≤ it (a larger group only when none is open);
//   - the order (`startOrder`): `priority`, the highest first, the oldest first within a level, a lower level never
//     starting while a higher one waits; or `easiest`, the smallest triage size first, then fewer repos, then fewer
//     pages, then priority and age, a harder group never starting while an easier one waits on the limits.

// What a ticket has cost so far, in percent of the week: the sum of its runs' measured use.
export function spentOf(l) {
  let sum = null;
  for (const r of l.runs ?? []) {
    const b = r.weekPercent?.before;
    const a = r.weekPercent?.after;
    if (typeof a === 'number' && typeof b === 'number') sum = (sum ?? 0) + Math.max(0, a - b) * (typeof r.share === 'number' ? r.share : 1);
  }
  return sum;
}

const finished = (l) => l.stages?.close?.status === 'done' || (l.prs ?? []).some((p) => (p.readyForMerge ?? []).length);

// The cost of a ticket per size: measured on finished tickets (the pilots first), else the owner's figure in
// `limits.estimates`, else none.
export function estimatesOf(ledgers, limits) {
  const out = {};
  for (const size of SIZES) {
    const costs = ledgers.filter((l) => l.triage?.size === size && finished(l)).map(spentOf).filter((c) => c !== null);
    if (costs.length) out[size] = { percent: round(costs.reduce((a, b) => a + b, 0) / costs.length), source: 'measured', tickets: costs.length };
    else if (typeof limits.estimates?.[size] === 'number') out[size] = { percent: limits.estimates[size], source: 'settings', tickets: 0 };
    else out[size] = null;
  }
  return out;
}

const round = (n) => Math.round(n * 100) / 100;

// What is left to spend on a ticket in work: its estimate less what it spent, never below a fifth of the estimate
// (a ticket over its estimate is not free to finish). Null with no estimate.
export function remainingOf(l, estimates) {
  const est = estimates[l.triage?.size]?.percent;
  if (typeof est !== 'number') return null;
  return round(Math.max(est - (spentOf(l) ?? 0), est * 0.2));
}

// Related ready tickets go together, as the host's batch skill groups them: the triage named the other (and they
// share a target repo), the card's text names the other's number, or the triage found the same page.
export function groupsOf(ready, settings) {
  const parent = new Map(ready.map((t) => [t.key, t.key]));
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
  const join = (a, b) => parent.set(find(a), find(b));
  const repos = (t) => new Set((t.targets ?? []).map((id) => settings.targets.find((x) => x.id === id)?.repo).filter(Boolean));
  for (const a of ready) {
    for (const b of ready) {
      if (a.key >= b.key) continue;
      if (related(a, b, repos)) join(a.key, b.key);
    }
  }
  const groups = new Map();
  for (const t of ready) {
    const root = find(t.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  return [...groups.values()].map((members) => {
    const keys = members.map((t) => t.key);
    const priority = members.map((t) => t.priority ?? 'medium').sort((x, y) => PRIORITY_RANK[x] - PRIORITY_RANK[y])[0];
    const oldest = members.map((t) => t.createdAt).filter(Boolean).sort()[0] ?? null;
    return { group: groupId(keys), keys: sortKeys(keys), size: members.length, priority, oldest, members, ...difficultyOf(members, repos) };
  }).sort(settings.limits?.startOrder === 'easiest' ? byEasiest : byGroupOrder);
}

export const byGroupOrder = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || String(a.oldest ?? '9').localeCompare(String(b.oldest ?? '9')) || a.group.localeCompare(b.group);

// How hard a group is: its largest triage size (a size not known yet counts as the hardest), the repos its targets
// are in, and the pages its triage found.
const SIZE_RANK = { edit: 0, newPage: 1, newSection: 2 };
export function difficultyOf(members, repos) {
  const sizeRank = Math.max(...members.map((m) => SIZE_RANK[m.size] ?? 3));
  const repoSet = new Set(members.flatMap((m) => [...repos(m)]));
  const pages = new Set(members.flatMap((m) => (m.pages ?? []).map((p) => `${p.repo ?? ''}:${p.path ?? p}`)));
  return { sizeRank, repoCount: repoSet.size, pageCount: pages.size };
}

export const byEasiest = (a, b) => a.sizeRank - b.sizeRank || a.repoCount - b.repoCount || a.pageCount - b.pageCount || byGroupOrder(a, b);

export function related(a, b, repos) {
  const ra = repos(a);
  const shareRepo = [...repos(b)].some((r) => ra.has(r)) || !ra.size || !repos(b).size;
  if ((a.relations ?? []).map(String).includes(String(b.key)) && shareRepo) return true;
  if ((b.relations ?? []).map(String).includes(String(a.key)) && shareRepo) return true;
  const names = (t, n) => n !== null && n !== undefined && new RegExp(`#${n}\\b`).test(`${t.name ?? ''}\n${t.desc ?? ''}`.replace(/^\s*(#\d+\s*[-–—:]?\s*)+/, ''));
  if (names(a, b.number) || names(b, a.number)) return true;
  const pa = new Set((a.pages ?? []).map((p) => `${p.repo ?? ''}:${p.path ?? p}`));
  return (b.pages ?? []).some((p) => pa.has(`${p.repo ?? ''}:${p.path ?? p}`));
}

// The WIP counts and the groups a scheduled run may start now, with the reason each other group doesn't.
// A ticket a scheduled run started and the forge hasn't merged yet: every state from planning to ready for merge.
const NOT_OPEN = new Set(['ready', 'needsInfo', 'new', 'merged', 'closed']);
export const isOpen = (t) => t.ledger === 'present' && t.mode === 'pipeline' && t.startedBy === 'schedule' && !NOT_OPEN.has(t.state === 'locked' ? t.derivedState : t.state);

export function startable({ tickets, groups, settings, allowance, estimates, inWork, locked }) {
  const { limits } = settings;
  const counted = tickets.filter((t) => t.counted);
  let inProgress = counted.filter((t) => t.counts === 'inProgress').length;
  const waiting = counted.filter((t) => t.counts === 'waiting').length;
  let open = tickets.filter(isOpen).length;
  const wip = { inProgress, waiting, open, limits: { inProgress: limits.inProgress, waiting: limits.waiting, open: limits.open }, manual: tickets.filter((t) => t.counts && !t.counted && t.startedBy === 'manual').length };
  const easiest = limits.startOrder === 'easiest';

  // The remaining cost of every ticket in work, scheduled or not: they all spend the same allowance.
  const unknown = inWork.filter((l) => remainingOf(l, estimates) === null).map((l) => l.key);
  let committed = round(inWork.reduce((sum, l) => sum + (remainingOf(l, estimates) ?? 0), 0));
  const budget = allowance ? { remaining: allowance.remaining, cap: allowance.cap, used: allowance.used, day: allowance.day, inWork: committed, inWorkUnknown: unknown } : null;

  const out = [];
  const notStarted = [];
  let blockedLevel = null; // priority order: a higher priority that waits holds back every lower one
  let blockedBy = null; // easiest order: an easier group that waits holds back every harder one
  for (const g of groups) {
    const why = [];
    if (settings.mode === 'off') why.push('mode off');
    if (!easiest && blockedLevel !== null && PRIORITY_RANK[g.priority] > blockedLevel) why.push(`waits behind a ${['high', 'medium', 'low'][blockedLevel]} priority group`);
    if (easiest && blockedBy !== null) why.push(`waits behind the easier group ${blockedBy}`);
    if (g.keys.some((k) => locked.has(k))) why.push('locked by a run');
    if (g.waitsFor?.length) why.push(`related to ${g.waitsFor.join(', ')}, still in work`);
    if (waiting >= limits.waiting) why.push(`${waiting} waiting (limit ${limits.waiting})`);
    if (limits.open !== null && open + g.size > limits.open && !(g.size > limits.open && open === 0)) why.push(`${open} open + ${g.size} > ${limits.open} (open: started by a schedule, not merged yet)`);
    if (inProgress + g.size > limits.inProgress && !(g.size > limits.inProgress && inProgress === 0)) {
      why.push(`${inProgress} in progress + ${g.size} > ${limits.inProgress}`);
    }
    const est = g.members.map((m) => estimates[m.size]?.percent ?? null);
    const estimate = est.every((x) => typeof x === 'number') ? round(est.reduce((a, b) => a + b, 0)) : null;
    if (!allowance) why.push("the day's allowance is unknown (no usage reading)");
    else if (estimate === null) {
      if (inWork.length || out.length) why.push(`no cost estimate for size ${g.members.filter((m, i) => est[i] === null).map((m) => m.size ?? 'unknown').join(', ')} yet: one ticket at a time`);
      else if (allowance.remaining <= 0) why.push(`the day's allowance is used (${allowance.used}% of ${allowance.cap}%)`);
    } else if (committed + estimate > allowance.remaining) {
      why.push(`estimate ${estimate}% + ${committed}% to finish the tickets in work > ${allowance.remaining}% left today`);
    }
    if (why.length) {
      notStarted.push({ group: g.group, keys: g.keys, priority: g.priority, estimate, reasons: why });
      // A group held back by the limits holds back the lower levels; one held back by its own relation or lock doesn't.
      if (!why.every((r) => /^locked|^related/.test(r))) {
        if (blockedLevel === null) blockedLevel = PRIORITY_RANK[g.priority];
        if (blockedBy === null) blockedBy = g.group;
      }
      continue;
    }
    out.push({ group: g.group, keys: g.keys, size: g.size, priority: g.priority, oldest: g.oldest, estimate, ...(easiest ? { sizeRank: g.sizeRank, repoCount: g.repoCount, pageCount: g.pageCount } : {}) });
    inProgress += g.size;
    open += g.size;
    committed = round(committed + (estimate ?? 0));
    if (estimate === null) inWork = [...inWork, { key: g.group }];
  }
  return { wip, budget, startable: out, notStarted };
}
