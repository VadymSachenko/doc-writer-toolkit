import fs from 'node:fs';
import path from 'node:path';
import { keyOf, prId, readAllLedgers } from './ledger.mjs';
import { allLocks } from './locks.mjs';
import { deriveTicket, hasLabel, rebuiltState } from './rule.mjs';
import { readCards, readPrs, prLinks, makeGit } from './world.mjs';
import { intakeList, labelCheck, byPriorityThenAge } from './intake.mjs';
import { estimatesOf, groupsOf, related, startable } from './limits.mjs';
import { allowanceOf } from './allowance.mjs';
import { fileHash } from './record.mjs';
import { readRearm, rearmedAt } from './setlocal.mjs';

// `status`: every ticket's state, next step, open gate and mismatches, the intake, the WIP counts and the groups a
// scheduled run may start now. It reads the ledgers, the tracker, the forge and git, and writes nothing: the one change
// it makes is the fetch of a head the forge has and a target clone doesn't, into that clone's remote-tracking refs.

const bare = (t) => String(t ?? '').replace(/‌/g, '').trim();
const OPEN_STATES = new Set(['ready', 'needsInfo', 'new', 'closed', 'outside', 'merged']);

// `tried` and `retryWaiting` come from a run (lib/runner.mjs): the tickets it already started or tried, and whether it may
// give a waiting failed start its one more try (`startable` in lib/limits.mjs).
export async function computeStatus({ settings, clients, now = Date.now(), only = null, usage = null, git = makeGit(settings), ignoreLocks = null, marks = null, tried = new Set(), retryWaiting = false }) {
  const ledgers = readAllLedgers(settings.state);
  const ledgersByCard = new Map(ledgers.filter((l) => l.card?.id).map((l) => [l.card.id, l]));
  const { cards, byStatus } = await readCards({ settings, tracker: clients.tracker, ledgers });
  const needsForge = ledgers.some((l) => (l.prs ?? []).some((p) => p.number && !p.merged) && l.stages?.close?.status !== 'done');
  const prWorld = needsForge ? await readPrs({ settings, forge: clients.forge, ledgers }) : new Map();
  // A head the forge has and the target clone doesn't (a commit made on the forge): fetched into the clone's
  // remote-tracking refs once for this check, so the rule reads it as it reads a push from the clone (lib/world.mjs).
  // Only the tickets asked for (`only`), when the check names them.
  const targetOfPr = (pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo);
  git.fetchHeads?.(ledgers.filter((l) => !only || only.includes(l.key)).flatMap((l) => (l.prs ?? []).map((pr) => ({ pr, world: prWorld.get(`${l.key}/${prId(pr)}`) })).filter((x) => x.world?.state === 'open' && x.pr.branch).map(({ pr, world }) => ({ target: targetOfPr(pr), branch: pr.branch, base: pr.base ?? targetOfPr(pr)?.base ?? 'main', head: world.headCommit }))));
  // The runner's own locks (the group it is advancing) don't hide that group from it.
  const locks = new Map(allLocks(settings.state, now).filter((x) => !ignoreLocks?.has(x.group)).map((x) => [x.group, x]));
  const fileExists = (rel) => fs.existsSync(path.resolve(settings.root, rel));
  const hashOf = (rel) => fileHash(settings.root, rel);

  // The card's comments, only where a failed step needs them: a ticket whose last session failed (did a person comment
  // since?), and the tickets whose mark the runner takes right after a failed session (`marks`). A card that can't be
  // read (moved to a list never read, say) gives none: its move is seen on its own.
  const rearm = readRearm(settings.state);
  const cardComments = new Map();
  const cardMoves = new Map();
  for (const l of ledgers) {
    const last = (l.runs ?? []).at(-1);
    const card = l.card?.id ? cards.get(l.card.id) : null;
    if (!card || (only && !only.includes(l.key)) || !(marks?.includes(l.key) || (last?.outcome === 'failed' && last.after?.comments))) continue;
    try {
      const detail = await clients.tracker.readCard({ card: card.id });
      cardComments.set(l.key, detail.comments ?? []);
      cardMoves.set(l.key, detail.moves ?? []);
    } catch {
      /* no comments: the other signs still count */
    }
  }

  // The numbered edits of each PR across the ledgers that share it (a PR with two cards): a reply is read against both.
  const editsByPr = new Map();
  for (const l of ledgers) for (const p of l.prs ?? []) if (p.number && p.edits?.length) editsByPr.set(`${p.repo}#${p.number}`, [...(editsByPr.get(`${p.repo}#${p.number}`) ?? []), p.edits]);

  // Tickets with a ledger.
  const tickets = ledgers.map((l) =>
    deriveTicket(l, { now, editsByPr, card: l.card?.id && cards.has(l.card.id) ? cards.get(l.card.id) : l.stages?.close?.status === 'done' ? undefined : null, lock: locks.get(l.group) ?? null, prWorld, git, settings, fileExists, fileHash: hashOf, cardComments: cardComments.get(l.key) ?? null, cardMoves: cardMoves.get(l.key) ?? null, rearmedAt: rearmedAt(rearm, l.key), mark: Boolean(marks?.includes(l.key)) }),
  );

  // Cards with no ledger: the intake, ready tickets the pipeline hasn't started, tickets whose ledger is missing, and
  // cards that are not tickets at all (a plan, a report).
  const marker = settings.intake.triageMarker;
  const notTickets = [];
  const ready = [];
  for (const [status, list] of Object.entries(byStatus)) {
    if (status === 'intake') continue;
    for (const card of list) {
      if (ledgersByCard.has(card.id)) continue;
      const detail = await clients.tracker.readCard({ card: card.id });
      const triaged = Boolean(marker) && detail.comments.some((c) => bare(c.text).startsWith(bare(marker)));
      const key = keyOf(card);
      const base = { key, priority: card.priority ?? 'medium', createdAt: card.createdAt ?? null, card: { id: card.id, shortLink: card.shortLink, url: card.url, name: card.name, status: card.status, list: card.list?.name ?? null } };
      if (status === 'ready') {
        const check = labelCheck(card, settings, git.pagesOf);
        if (!triaged && !check.settled) {
          notTickets.push({ ...base, why: "an owner's card in the ready status that names no docs target: left where it is" });
          continue;
        }
        const needsInfo = hasLabel(card, settings.intake.needsInfoLabel);
        const t = { ...base, group: key, ledger: 'absent', mode: 'pipeline', startedBy: null, state: needsInfo ? 'needsInfo' : 'ready', next: null, steps: [], gate: needsInfo ? { who: 'team', why: 'a person removes the needs-info label' } : null, mismatch: [], notes: [triaged ? 'triaged before the ledger existed' : "an owner's card that names a docs target"], prs: [], counts: null, counted: false, locked: Boolean(locks.get(key)?.live), triage: { verdict: triaged ? 'legacy' : 'owner-card', targets: check.targets, size: null, relations: [] } };
        tickets.push(t);
        if (!needsInfo) ready.push({ ...t, number: card.number, name: card.name, desc: card.desc, targets: check.targets, relations: [], together: [], pages: [], size: null });
        continue;
      }
      const links = prLinks(detail.comments.map((c) => c.text).join('\n'), settings);
      if (!triaged && !links.length) {
        notTickets.push({ ...base, why: 'no triage comment and no PR link: not a ticket' });
        continue;
      }
      const views = [];
      for (const pr of links) {
        try {
          const st = await clients.forge.prState({ repo: pr.repo, number: pr.number });
          views.push({ id: `${pr.repo}#${pr.number}`, repo: pr.repo, number: pr.number, url: st.url, state: st.state, labels: st.labels, head: st.headCommit, reviewRequests: (st.reviewRequests ?? []).map((r) => r.login ?? r.team), reviewDecision: st.reviewDecision });
        } catch (e) {
          views.push({ id: `${pr.repo}#${pr.number}`, repo: pr.repo, number: pr.number, error: e.message });
        }
      }
      tickets.push({ ...base, group: key, ledger: 'absent', rebuilt: true, mode: 'hand', hand: true, startedBy: null, state: rebuiltState(card, views), next: null, steps: [], gate: { who: 'owner', why: 'no ledger: rebuilt from the tracker and the forge as mode hand until `ticket-state handover`' }, mismatch: [], notes: [triaged ? 'triaged' : 'a PR link on the card'], prs: views, counts: null, counted: false, locked: Boolean(locks.get(key)?.live) });
    }
  }

  // Ready tickets that have a ledger.
  for (const t of tickets) {
    if (t.ledger !== 'present' || t.state !== 'ready') continue;
    const l = ledgers.find((x) => x.key === t.key);
    const card = cards.get(l.card?.id);
    ready.push({ ...t, number: card?.number ?? null, name: card?.name ?? l.card?.name, desc: card?.desc ?? '', targets: l.triage?.targets ?? [], relations: l.triage?.relations ?? [], together: l.triage?.together ?? [], pages: l.triage?.pages ?? [], size: l.triage?.size ?? null });
  }

  // Groups, and the tickets in work a ready one waits for (the host's batch skill attaches it or waits; v1 waits).
  const inWorkTickets = tickets.filter((t) => t.ledger === 'present' && !OPEN_STATES.has(t.state === 'locked' ? t.derivedState : t.state));
  const workView = inWorkTickets.map((t) => {
    const l = ledgers.find((x) => x.key === t.key);
    const card = cards.get(l.card?.id);
    return { key: t.key, number: card?.number ?? null, name: card?.name ?? '', desc: card?.desc ?? '', targets: l.triage?.targets ?? [], relations: l.triage?.relations ?? [], together: l.triage?.together ?? [], pages: l.triage?.pages ?? [] };
  });
  const repos = (t) => new Set((t.targets ?? []).map((id) => settings.targets.find((x) => x.id === id)?.repo).filter(Boolean));
  const groups = groupsOf(ready, settings).map((g) => ({ ...g, waitsFor: workView.filter((w) => g.members.some((m) => related(m, w, repos))).map((w) => w.key) }));

  const allowance = usage ? allowanceOf(usage, settings.limits, new Date(now)) : null;
  const estimates = estimatesOf(ledgers, settings.limits);
  const inWork = ledgers.filter((l) => l.mode === 'pipeline' && inWorkTickets.some((t) => t.key === l.key));
  const lockedGroup = (g) => Boolean(locks.get(g.group)?.live) || g.keys.some((k) => tickets.find((t) => t.key === k)?.locked);
  const plan = startable({ tickets, groups, settings, allowance, estimates, inWork, locked: { has: (k) => lockedGroup(groups.find((g) => g.keys.includes(k)) ?? { group: k, keys: [k] }) }, tried, retryWaiting });

  const intakeCards = byStatus.intake ?? [];
  const intake = intakeList({ cards: intakeCards, ledgersByCard, settings, now, pagesOf: git.pagesOf });

  const order = (a, b) => byPriorityThenAge(a, b);
  const shown = only ? tickets.filter((t) => only.includes(t.key)) : tickets;
  return {
    now: new Date(now).toISOString(),
    mode: settings.mode,
    state: settings.stateRel,
    tickets: shown.sort(order).map(({ number, desc, ...t }) => t),
    intake,
    groups: groups.map(({ members, failedStart, ...g }) => ({ ...g, ...(failedStart ? { failedStart } : {}) })),
    wip: plan.wip,
    allowance: plan.budget,
    estimates,
    startable: plan.startable,
    notStarted: plan.notStarted,
    notTickets,
    locks: [...locks.values()],
    ...(only ? { only } : {}),
  };
}
