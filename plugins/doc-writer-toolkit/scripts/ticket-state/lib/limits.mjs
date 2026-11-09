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
//   - `open` (when set) counts the open tickets a scheduled run started: from planning to the final review, ready for
//     merge included (not paused, not outside the flow, not merged or closed). A group starts only if open + its size ≤
//     it (a larger group only when none is open);
//   - the order (`startOrder`): `priority`, the highest first, the oldest first within a level, a lower level never
//     starting while a higher one waits; or `easiest`, the smallest triage size first, then fewer repos, then fewer
//     pages, then priority and age, no later group starting while an earlier one waits on the limits;
//   - a group whose start failed waits as any failed step does (lib/rule.mjs): held for the owner, or until a person
//     acts or the next morning run. It holds no slot and holds back no other group, and neither does a group this run
//     already tried.

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

// Two meanings, kept apart. `related` is overlap: a ready ticket waits for a related ticket in work. `together` is the
// triage's judgement that separate PRs would edit the same place or feature: only that joins tickets into one group, in
// either direction, within one repo. Overlap alone never joins, so two tickets on one page go one after the other.
export function groupsOf(ready, settings) {
  const parent = new Map(ready.map((t) => [t.key, t.key]));
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
  const join = (a, b) => parent.set(find(a), find(b));
  const repos = (t) => new Set((t.targets ?? []).map((id) => settings.targets.find((x) => x.id === id)?.repo).filter(Boolean));
  for (const a of ready) {
    for (const b of ready) {
      if (a.key >= b.key) continue;
      if (together(a, b, repos)) join(a.key, b.key);
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
    return { group: groupId(keys), keys: sortKeys(keys), size: members.length, priority, oldest, members, ...difficultyOf(members, repos), failedStart: failedStartOf(members) };
  }).sort(settings.limits?.startOrder === 'easiest' ? byEasiest : byGroupOrder);
}

// The group's start that failed, from its members' failed-step state (lib/rule.mjs): the members held for the owner
// (two failed sessions, or the day's cap), the members that wait for a person or the next morning run, and the failed
// sessions in a row so far (`prior` of the next try). Null when no member's start failed.
export function failedStartOf(members) {
  const held = members.filter((m) => m.held).map((m) => ({ key: m.key, why: m.gate?.why ?? 'held' }));
  const waits = members.filter((m) => !m.held && m.failed && !m.failed.acted);
  if (!held.length && !waits.length) return null;
  return { held, waits: waits.map((m) => m.key), sessions: Math.max(0, ...waits.map((m) => m.failed.sessions ?? 1)), at: waits.map((m) => m.failed.at).filter(Boolean).sort().at(-1) ?? null };
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

// A ticket as triage writes it: `#1221` and `1221` are one ticket.
const ticketRef = (x) => String(x).trim().replace(/^#/, '');
const names = (list, t) => (list ?? []).some((x) => ticketRef(x) === String(t.key));
const shareRepo = (a, b, repos) => {
  const ra = repos(a);
  return [...repos(b)].some((r) => ra.has(r)) || !ra.size || !repos(b).size;
};

// A page as triage writes it (`<repo> <path> — <block>`) or as the older ledgers have it ({ repo, path }): its repo and
// path, without the block. A key needs both: `guide-docs a.md` and { repo, path: 'a.md' } have one, while a path with
// no repo (`docs/a.md`, `a.md`, { path }) gets none, since nothing says which repo it is in, so it matches no page.
export function pageKey(p) {
  if (p && typeof p === 'object') return p.repo && p.path ? `${p.repo} ${p.path}` : null;
  const [head] = String(p ?? '').split(/\s+[—–-]\s+/);
  const [repo, ...rest] = head.trim().split(/\s+/);
  return repo && rest.length ? `${repo} ${rest.join(' ')}` : null;
}

// The triage's judgement that the two go together, in either direction. Across repos a relation stays context.
export const together = (a, b, repos) => (names(a.together, b) || names(b.together, a)) && shareRepo(a, b, repos);

// Overlap: the triage named the other (and they share a target repo), the card's text names the other's number, or the
// triage found the same page.
export function related(a, b, repos) {
  if ((names(a.relations, b) || names(b.relations, a)) && shareRepo(a, b, repos)) return true;
  if (together(a, b, repos)) return true;
  const named = (t, n) => n !== null && n !== undefined && new RegExp(`#${n}\\b`).test(`${t.name ?? ''}\n${t.desc ?? ''}`.replace(/^\s*(#\d+\s*[-–—:]?\s*)+/, ''));
  if (named(a, b.number) || named(b, a.number)) return true;
  const pa = new Set((a.pages ?? []).map(pageKey).filter(Boolean));
  return (b.pages ?? []).map(pageKey).some((k) => k && pa.has(k));
}

// The WIP counts and the groups a scheduled run may start now, with the reason each other group doesn't.
// An open ticket: a scheduled run started it, and it is from planning to the final review, ready for merge included. Not
// open: before the start, a pause (the card moved back to the ready status), outside the flow (a PR closed unmerged,
// the card archived, gone or moved out of the flow), merged or closed. A locked ticket counts as what it is doing; one
// locked at its start by a scheduled run is open, its card still in the ready status or not: its session may be moving
// the card now, and a second scheduled run at the same time (a runner.mjs run by hand without --manual, a check lock
// taken over) must not start a group past the limit meanwhile.
const NOT_OPEN = new Set(['ready', 'needsInfo', 'new', 'paused', 'outside', 'merged', 'closed']);
const lockedAtStart = (t) => t.state === 'locked' && t.lock?.stage === 'start';
export const isOpen = (t) => t.ledger === 'present' && t.mode === 'pipeline' && t.startedBy === 'schedule' && (lockedAtStart(t) || !NOT_OPEN.has(t.state === 'locked' ? t.derivedState : t.state));

// `tried`: the tickets this run already started (or tried to): their groups hold no slot in its later calculations, so a
// start that failed lets the run try the next group. `retryWaiting`: the run may give a waiting failed start its one more try
// (the morning run, a manual run): `true` for every group, or a Set of tickets for those groups only (a start pass gives
// it to the start whose try the morning run handed on and lost, lib/watch.mjs `owed`). `inFlight`: the tickets of starts a check handed to a process of their own that hasn't
// recorded them yet (lib/forge-state.mjs `startsInFlight`): their ready groups are starting now, so they take their slots,
// their share of the allowance and their relations here, and are not started again.
export function startable({ tickets, groups, settings, allowance, estimates, inWork, locked, tried = new Set(), retryWaiting = false, inFlight = new Set() }) {
  const { limits } = settings;
  const repos = (t) => new Set((t.targets ?? []).map((id) => settings.targets.find((x) => x.id === id)?.repo).filter(Boolean));
  const startingMembers = []; // the tickets this calculation starts: a ticket related to one of them waits like one in work
  const counted = tickets.filter((t) => t.counted);
  let inProgress = counted.filter((t) => t.counts === 'inProgress').length;
  const waiting = counted.filter((t) => t.counts === 'waiting').length;
  const openKeys = tickets.filter(isOpen).map((t) => t.key);
  let open = openKeys.length;
  const starting = []; // the keys of the groups this calculation starts, which take open slots too
  // The starts handed on that go on elsewhere, counted first, as if this calculation had started them: a failed start's
  // one more try too, which only the run that hands it on may give (the morning run's).
  const flying = groups.filter((g) => g.keys.some((k) => inFlight.has(k)) && !g.keys.some((k) => tried.has(k)));
  for (const g of flying) {
    inProgress += g.size;
    open += g.size;
    starting.push(...g.keys);
    startingMembers.push(...g.members);
  }
  const wip = { inProgress, waiting, open, openKeys, limits: { inProgress: limits.inProgress, waiting: limits.waiting, open: limits.open }, manual: tickets.filter((t) => t.counts && !t.counted && t.startedBy === 'manual').length };
  const easiest = limits.startOrder === 'easiest';
  const holders = () => [...openKeys, ...starting.map((k) => `${k} starting now`)].join(', ');

  // The remaining cost of every ticket in work, scheduled or not: they all spend the same allowance.
  const unknown = inWork.filter((l) => remainingOf(l, estimates) === null).map((l) => l.key);
  const estimateOf = (g) => {
    const est = g.members.map((m) => estimates[m.size]?.percent ?? null);
    return est.every((x) => typeof x === 'number') ? round(est.reduce((a, b) => a + b, 0)) : null;
  };
  let committed = round(inWork.reduce((sum, l) => sum + (remainingOf(l, estimates) ?? 0), 0) + flying.reduce((sum, g) => sum + (estimateOf(g) ?? 0), 0));
  const budget = allowance ? { remaining: allowance.remaining, cap: allowance.cap, used: allowance.used, day: allowance.day, inWork: committed, inWorkUnknown: unknown } : null;

  const out = [];
  const notStarted = [];
  let blockedLevel = null; // priority order: a higher priority that waits holds back every lower one
  let blockedBy = null; // easiest order: an easier group that waits holds back every harder one
  if (flying.some((g) => estimateOf(g) === null)) inWork = [...inWork, ...flying.filter((g) => estimateOf(g) === null).map((g) => ({ key: g.group }))];
  for (const g of groups) {
    const est = g.members.map((m) => estimates[m.size]?.percent ?? null);
    const estimate = estimateOf(g);
    if (flying.includes(g)) {
      notStarted.push({ group: g.group, keys: g.keys, priority: g.priority, estimate, reasons: ['starting now in a process of its own'] });
      continue;
    }
    // A start that failed waits as any failed step: the group can't start in this run, so it takes no slot and holds
    // back no other group.
    const failed = failedStartReason(g, { tried, retryWaiting });
    if (failed) {
      notStarted.push({ group: g.group, keys: g.keys, priority: g.priority, estimate, reasons: [failed] });
      continue;
    }
    const why = [];
    if (settings.mode === 'off') why.push('mode off');
    if (!easiest && blockedLevel !== null && PRIORITY_RANK[g.priority] > blockedLevel) why.push(`waits behind a ${['high', 'medium', 'low'][blockedLevel]} priority group`);
    if (easiest && blockedBy !== null) why.push(`waits behind the easier group ${blockedBy}`);
    if (g.keys.some((k) => locked.has(k))) why.push('locked by a run');
    if (g.waitsFor?.length) why.push(`related to ${g.waitsFor.join(', ')}, still in work`);
    const startingRelated = startingMembers.filter((s) => g.members.some((m) => related(m, s, repos))).map((s) => s.key);
    if (startingRelated.length) why.push(`related to ${startingRelated.join(', ')}, starting now`);
    if (waiting >= limits.waiting) why.push(`${waiting} waiting (limit ${limits.waiting})`);
    if (limits.open !== null && open + g.size > limits.open && !(g.size > limits.open && open === 0)) why.push(`${open} open (${holders()}) + ${g.size} > ${limits.open}`);
    if (inProgress + g.size > limits.inProgress && !(g.size > limits.inProgress && inProgress === 0)) {
      why.push(`${inProgress} in progress + ${g.size} > ${limits.inProgress}`);
    }
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
    out.push({ group: g.group, keys: g.keys, size: g.size, priority: g.priority, oldest: g.oldest, estimate, ...(g.failedStart?.sessions ? { prior: g.failedStart.sessions } : {}), ...(easiest ? { sizeRank: g.sizeRank, repoCount: g.repoCount, pageCount: g.pageCount } : {}) });
    inProgress += g.size;
    open += g.size;
    starting.push(...g.keys);
    startingMembers.push(...g.members);
    committed = round(committed + (estimate ?? 0));
    if (estimate === null) inWork = [...inWork, { key: g.group }];
  }
  return { wip, budget, startable: out, notStarted };
}

// Why a group can't start in this run for its own failed start, or null: tried already in this run, held for the
// owner, or a first failure that waits for a person or the next morning run.
function failedStartReason(g, { tried, retryWaiting }) {
  if (g.keys.some((k) => tried.has(k))) return 'tried in this run already: its start did not get the card into work';
  const f = g.failedStart;
  if (f?.held.length) return `held for the owner: ${f.held.map((h) => `${h.key}: ${h.why}`).join('; ')}`;
  const retry = retryWaiting === true || (retryWaiting instanceof Set && g.keys.some((k) => retryWaiting.has(k)));
  if (f?.waits.length && !retry) return `its start failed${f.at ? ` at ${f.at}` : ''} (${f.waits.join(', ')}): waits for a person acting on the ticket, or the next morning run`;
  return null;
}
