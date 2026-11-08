import { PRIORITY_RANK } from './stages.mjs';
import { keyOf } from './ledger.mjs';
import { hasLabel } from './rule.mjs';

// Intake (design §2): a card in the intake status is triaged only once it has been quiet for `quietHours` (its last
// activity that long ago), manual cards included; the drafts status is never read (the tracker module refuses it). A
// doc or app label confirms that docs are needed; a card with neither gets an extra check from its text and the
// existing pages, and the triage gives `needs-info` only when that check can't decide. High priority first, then the
// oldest card.

const norm = (s) => String(s ?? '').replace(/‌/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A name as a whole word (letters and digits of any script bound it), without case.
const mentions = (text, name) => Boolean(name) && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(norm(name))}([^\\p{L}\\p{N}]|$)`, 'u').test(norm(text));

// The targets a card's own text names: a target's app label or repository by name, or an existing page by its path
// (from the UA root, with or without the extension; a folder path of two levels or more counts too).
export function textTargets(text, targets, pagesOf) {
  const hits = [];
  const body = norm(text);
  for (const t of targets) {
    for (const name of [t.appLabel, t.repo].filter(Boolean)) {
      if (mentions(body, name)) {
        hits.push({ target: t.id, by: 'name', match: name });
        break;
      }
    }
    if (hits.some((h) => h.target === t.id)) continue;
    for (const page of pagesOf ? pagesOf(t) : []) {
      const p = norm(page);
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      const found = [p, `${norm(t.uaRoot)}${p}`].find((x) => body.includes(x)) ?? (dir.includes('/') && body.includes(dir) ? dir : null);
      if (found) {
        hits.push({ target: t.id, by: 'page', match: page });
        break;
      }
    }
  }
  return hits;
}

// What the labels say: the targets whose app label the card has, and the doc labels it has.
export function labelCheck(card, settings, pagesOf) {
  const appTargets = settings.targets.filter((t) => t.appLabel && hasLabel(card, t.appLabel)).map((t) => t.id);
  const docLabels = settings.intake.docLabels.filter((name) => hasLabel(card, name));
  if (appTargets.length) return { check: 'labels', targets: appTargets, docLabels, settled: true };
  const fromText = textTargets(`${card.name ?? ''}\n${card.desc ?? ''}`, settings.targets, pagesOf);
  const targets = [...new Set(fromText.map((h) => h.target))];
  // A doc label with no target of its own (a general docs label) confirms docs; the target still comes from the text.
  return { check: 'text', targets, docLabels, evidence: fromText, settled: targets.length > 0 };
}

export const byPriorityThenAge = (a, b) =>
  (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.key).localeCompare(String(b.key));

// The intake cards, split into those due for triage now and those still inside their quiet hours.
export function intakeList({ cards, ledgersByCard, settings, now, pagesOf }) {
  const quietMs = settings.intake.quietHours * 3600000;
  const due = [];
  const waiting = [];
  const triaged = [];
  for (const card of cards) {
    const key = keyOf(card);
    const ledger = ledgersByCard.get(card.id);
    const entry = {
      key,
      card: { id: card.id, shortLink: card.shortLink, url: card.url, name: card.name },
      priority: card.priority ?? 'medium',
      createdAt: card.createdAt ?? null,
      lastActivity: card.lastActivity,
      labels: (card.labels ?? []).map((l) => l.name).filter(Boolean),
      ...labelCheck(card, settings, pagesOf),
    };
    if (ledger?.stages?.triage?.status === 'done') {
      triaged.push({ ...entry, note: 'triaged, but the card is still in the intake status' });
      continue;
    }
    const last = Date.parse(card.lastActivity ?? '');
    if (Number.isFinite(last) && now - last < quietMs) waiting.push({ ...entry, quietAt: new Date(last + quietMs).toISOString() });
    else due.push(entry);
  }
  due.sort(byPriorityThenAge);
  waiting.sort((a, b) => a.quietAt.localeCompare(b.quietAt));
  return { quietHours: settings.intake.quietHours, due, waiting, triaged };
}
