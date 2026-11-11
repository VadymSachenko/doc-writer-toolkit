import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError } from './errors.mjs';

// The misses log (TASK-105): an item the pipeline left (a question, a place, a marker) that was settled later from a
// source already in reach, one line each in `<state>/misses.jsonl`. "Later" is the answer pass, or the owner's answer
// in a review round (the trigger word), an expert's that the owner hands on included. Each line names the ticket, the
// item, the source that answered it and the stage that missed it. The weekly summary groups them by the source's kind,
// and proposes a kind seen twice, once, as one rule line for the role or the hub. No AI: the source is what the record
// said; the rule line is a template.

export const missesPath = (state) => path.join(state, 'misses.jsonl');
export const weekPath = (state) => path.join(state, 'answers-week.json');
export const proposedPath = (state) => path.join(state, 'misses-proposed.json');

// The kinds of source an answer came from. `owner` is the owner's own word, which no system held: no miss.
export const SOURCE_KINDS = ['code', 'docs', 'ticket', 'live', 'decision', 'owner'];

// A `source` an answer in a round may carry: { kind, ref }, `ref` the repo and path, the earlier ticket, the check's
// log, or the decision. A malformed one is a usage error (nothing was posted for it).
export function checkSource(s, where) {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'object' || !SOURCE_KINDS.includes(s.kind)) throw new CliError(`${where}: "source" is { "kind", "ref" }, the kind one of ${SOURCE_KINDS.join(', ')}`, { code: 2 });
  if (s.kind !== 'owner' && (typeof s.ref !== 'string' || !s.ref.trim())) throw new CliError(`${where}: a "source" of kind ${s.kind} names its "ref" (the repo and path, the ticket, the log, the decision)`, { code: 2 });
  return { kind: s.kind, ...(typeof s.ref === 'string' && s.ref.trim() ? { ref: s.ref.trim() } : {}) };
}

// The source an answer pass's evidence entry names, as a miss line keeps it.
export function sourceOfEvidence(e) {
  if (!e) return null;
  if (e.kind === 'code') return { kind: 'code', ref: `${e.repo}:${e.path}${e.lines ? `#L${String(e.lines).replace(/^L/, '')}` : ''}` };
  if (e.kind === 'docs') return e.ticket !== undefined && e.ticket !== null ? { kind: 'ticket', ref: `${e.ticket}/${e.file}` } : { kind: 'docs', ref: `${e.repo}:${e.path}` };
  if (e.kind === 'live') return { kind: 'live', ref: String(e.log) };
  if (e.kind === 'rule') return { kind: 'decision', ref: String(e.ref) };
  return null;
}

export function readMisses(state) {
  let raw;
  try {
    raw = fs.readFileSync(missesPath(state), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line: skipped */
    }
  }
  return out;
}

// Appends the lines not already there (by `key`): a record given again after a refusal, or twice, logs nothing twice.
// A line of kind `owner` is no miss and is never written. Returns the lines written.
export function appendMisses(state, lines) {
  const fresh = (lines ?? []).filter((x) => x && x.source && x.source.kind !== 'owner');
  if (!fresh.length) return [];
  const have = new Set(readMisses(state).map((x) => x.key));
  const out = fresh.filter((x) => !have.has(x.key) && have.add(x.key));
  if (!out.length) return [];
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(missesPath(state), out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return out;
}

// One miss line.
export const missLine = ({ at, ticket, pr = null, item, source, settledBy, missedBy, key }) => ({ at, ticket, ...(pr ? { pr } : {}), item, source, settledBy, missedBy, key });

// ------------------------------------------------------------------ the measures, per ticket

// Per ticket with a pass in the window: the items the writer left (the pass's input), the ones the pass answered or
// confirmed, and the ones that reached the owner (kept by a pass, or posted with no pass: the description's questions
// and the places of its `pr` record).
export function answerMeasures(ledgers, { since = 0, until = Infinity } = {}) {
  const inWindow = (iso) => {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) && t >= since && t < until;
  };
  const out = [];
  for (const l of ledgers.filter(Boolean)) {
    const passes = [l.stages?.answerPass, ...(l.prs ?? []).map((p) => p.steps?.answerPass)].filter((r) => r?.status === 'done' && inWindow(r.at));
    const prAt = l.stages?.pr?.status === 'done' && inWindow(l.stages.pr.at);
    if (!passes.length && !prAt) continue;
    let left = 0;
    let answered = 0;
    let confirmed = 0;
    let kept = 0;
    for (const r of passes) {
      left += r.result?.input?.items?.length ?? 0;
      for (const x of r.result?.items ?? []) {
        if (x.outcome === 'answered') answered += 1;
        else if (x.outcome === 'confirmed') confirmed += 1;
        else if (x.outcome === 'kept') kept += 1;
      }
    }
    // With the PR opened in the window, what it posted (the description's first questions, its places); else what the
    // passes kept for the owner.
    const posted = (l.prs ?? []).reduce((n, p) => n + (p.questions ?? []).filter((q) => q.stage === 'pr' && q.answer?.by !== 'answerPass').length, 0) + (l.places ?? []).length;
    out.push({ ticket: l.key, left, answered, confirmed, kept, reachedOwner: prAt ? posted : kept });
  }
  return out;
}

// ------------------------------------------------------------------ the week

// The rule line a kind of source gives, for the role or the hub: a template, never a model's words.
const RULE_OF = {
  code: (refs) => ({ for: 'writer role', line: `Before a question or a place, search the company repos for the names it holds (an endpoint, a field, a component, a label): these were answered there: ${refs}.` }),
  docs: (refs) => ({ for: 'writer role', line: `Before a question or a place, read the published pages the docs lookup lists for the ticket's terms: these were answered there: ${refs}.` }),
  ticket: (refs) => ({ for: 'writer role', line: `Before a question or a place, read the earlier tickets' notes the docs lookup lists (their live checks and API calls): these were answered there: ${refs}.` }),
  live: (refs) => ({ for: 'writer role', line: `A behaviour the test environment can reach is checked there, with the setup the host's rules allow, before it is a place or a question: these were answered by such a check: ${refs}.` }),
  decision: (refs) => ({ for: 'hub rules', line: `Write the owner's standing decision into the host's rules, so the sessions read it: these were answered by it: ${refs}.` }),
};

// The week's misses grouped by the source's kind (most first), each with its lines; and the kinds seen twice or more
// that were never proposed, each as one rule line.
export function weekOf(misses, { since, until, proposed = [] }) {
  const groups = new Map();
  for (const m of misses) {
    const t = Date.parse(m.at ?? '');
    if (!Number.isFinite(t) || t < since || t >= until) continue;
    const k = m.source?.kind;
    if (!RULE_OF[k]) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const list = [...groups.entries()].map(([kind, lines]) => ({ kind, count: lines.length, lines })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const done = new Set(proposed);
  const proposals = list.filter((g) => g.count >= 2 && !done.has(g.kind)).map((g) => {
    const refs = [...new Set(g.lines.map((x) => `${x.ticket} ${x.item?.id ?? ''} (${x.source.ref ?? x.source.kind})`.replace(/\s+\(/, ' (')))].slice(0, 5).join('; ');
    return { kind: g.kind, count: g.count, ...RULE_OF[g.kind](refs) };
  });
  return { groups: list, proposals };
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
};

// The weekly summary, once in seven days (as the roles proposal): the misses of the last seven days by kind, the rule
// lines proposed (each kind once: the kinds proposed are kept), and the measures per ticket. Null when the last one is
// younger than a week. `write`: the run's live mode (a dry run writes nothing).
export function weeklyAnswers(settings, ledgers, now, write) {
  const last = readJson(weekPath(settings.state), null);
  if (last && now - Date.parse(last.at) < 7 * 86400000) return null;
  const since = now - 7 * 86400000;
  const proposed = readJson(proposedPath(settings.state), []);
  const week = weekOf(readMisses(settings.state), { since, until: now + 1, proposed: Array.isArray(proposed) ? proposed : [] });
  const out = { at: new Date(now).toISOString(), since: new Date(since).toISOString(), groups: week.groups.map((g) => ({ kind: g.kind, count: g.count, lines: g.lines.map((x) => ({ ticket: x.ticket, item: x.item, source: x.source, settledBy: x.settledBy, missedBy: x.missedBy })) })), proposals: week.proposals, measures: answerMeasures(ledgers, { since, until: now + 1 }) };
  if (write) {
    writeJson(weekPath(settings.state), out);
    if (week.proposals.length) writeJson(proposedPath(settings.state), [...new Set([...(Array.isArray(proposed) ? proposed : []), ...week.proposals.map((p) => p.kind)])]);
  }
  return out;
}

// The report's section from a weekly summary. A stand-in for the weekly measures report (TASK-100), which reads the
// same file once it is built.
export function renderAnswers(week) {
  if (!week) return [];
  const out = ['## Answers and misses this week', ''];
  out.push(`Since ${week.since.slice(0, 10)}. Per ticket: the items the writer left, those the answer pass answered or confirmed, and those that reached the owner.`, '');
  out.push(...(week.measures.length ? week.measures.map((m) => `- ${m.ticket}: left ${m.left}, answered ${m.answered}, confirmed ${m.confirmed}, reached the owner ${m.reachedOwner}`) : ['- no ticket']), '');
  out.push('Misses, by the kind of source that answered them:', '');
  out.push(...(week.groups.length ? week.groups.map((g) => `- ${g.kind}: ${g.count} (${g.lines.slice(0, 5).map((x) => `${x.ticket} ${x.item?.id ?? ''} from ${x.source.ref ?? x.source.kind}, missed at ${x.missedBy}, settled by ${x.settledBy}`).join('; ')})`) : ['- none']), '');
  if (week.proposals.length) out.push('Proposed rule lines (yes or no; each kind is proposed once):', '', ...week.proposals.map((p) => `- for the ${p.for}: ${p.line}`), '');
  return out;
}
