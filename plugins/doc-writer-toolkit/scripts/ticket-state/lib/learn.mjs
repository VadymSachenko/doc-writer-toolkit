import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { allowanceOf } from './allowance.mjs';
import { parseReply } from './edits.mjs';
import { afterTrigger } from './world.mjs';
import { parseClaudeConfig } from '../../ui-labels/lib/config.mjs';
import { withoutHeader } from '../../tracker/lib/comment-header.mjs';
import { createForge } from '../../forge/lib/forge.mjs';
import { validateForge } from '../../forge/lib/settings.mjs';
import { createAdapter as createForgeAdapter } from '../../forge/adapters/index.mjs';
import { spawnGh } from '../../forge/adapters/github/gh.mjs';
import { learningDir, readLog, writeJson, collectOnce, viewsFrom } from './learn-log.mjs';
import { CORPORA, formOf, insertRule, ruleFiles, scriptOf } from './rule-insert.mjs';
import { LEARN_LABELS, validateLearning } from './learn-settings.mjs';
import { parseStartHours } from './settings.mjs';

export { LEARN_LABELS, validateLearning };

// Learning from the owner's edits (TASK-054; context/ticket-flow.md, "Learning from the owner's edits"). The model
// proposes, the scripts dispose: the weekly session's only output is a JSON file under `<state>/tmp/`, and everything
// it leads to (the kit's edit, the commits, the host PRs, the replies, the toolkit PR, the rejected rules) is done here,
// with no model, and checked first:
//
//  - point 2: once a week, at the first full check from Monday's morning run on with no ticket run going and the day's
//    allowance left (D-131: the tickets first), one session groups the log's edits into patterns;
//  - AC-1: a pattern is kept only with two examples or more from two PRs or more, each a line of the log no earlier
//    proposal used (a line is used once, so a rejected rule's edits never come back), of one of the three kinds;
//  - point 3: per host repo where a kept pattern was seen, one PR that adds it to `<kit>/product-rules.md` (a general
//    rule too, so it works at once), its description rendered here in the host's PR structure;
//  - point 4, AC-2: the owner's reply by number on that PR is read with no model (yes, no, the owner's text, a kind);
//    only a rewording by description goes to a session. The merge is the yes; a PR closed unmerged rejects what was
//    left; a rejected rule is kept and named to every later session, and its edits are used;
//  - point 5: a general rule merged in a host becomes a toolkit PR, the rule in an existing rule file in that file's form
//    (lib/rule-insert.mjs), with no product, company, host or person name; once the toolkit's own copy of the file holds
//    it (the switch), the next weekly host PR removes the host's copy;
//  - point 6: an exception to a general rule stays in the host's kit; when the session finds the toolkit rule itself
//    wrong, the toolkit PR corrects it, a distilled corpus only with its primary source cited, and never with a taste
//    rule.

export const KINDS = { product: ['product', 'продукт', 'тільки цей проєкт', 'only this project'], general: ['general', 'загальне'], exception: ['exception', 'виняток із загального', 'виняток'] };
// A kind by its stem, so «продуктове», «тільки для цього проєкту», «загальне правило», «винятком» are kinds too: the whole
// text (up to five words) starts with a kind's stem.
const KIND_STEMS = {
  product: /^(?:продукт\S*|(?:тільки|лише)\s+(?:для\s+)?(?:цього|цей|цьому)\s+проєкт\S*|product\S*|only\s+(?:for\s+)?this\s+project)/iu,
  general: /^(?:загальн\S*|спільн\S*|general\S*|shared)/iu,
  exception: /^(?:виняток\S*|винятк\S*|exception\S*)/iu,
};
export function kindOf(word) {
  const w = String(word ?? '').trim().toLowerCase().replace(/[.!]+$/u, '');
  const exact = Object.entries(KINDS).find(([, words]) => words.includes(w))?.[0];
  if (exact) return exact;
  if (!w || w.split(/\s+/u).length > 5) return null;
  return Object.entries(KIND_STEMS).find(([, re]) => re.test(w))?.[0] ?? null;
}

// ------------------------------------------------------------------ the state

const statePath = (state) => path.join(learningDir(state), 'proposals.json');
export function readLearning(state) {
  try {
    const d = JSON.parse(fs.readFileSync(statePath(state), 'utf8'));
    return { startWeek: d.startWeek ?? null, weeks: d.weeks ?? {}, attempts: d.attempts ?? {}, rules: d.rules ?? [], prs: d.prs ?? [], consumed: d.consumed ?? [], runs: d.runs ?? [], notified: d.notified ?? {} };
  } catch {
    return { startWeek: null, weeks: {}, attempts: {}, rules: [], prs: [], consumed: [], runs: [], notified: {} };
  }
}
const saveLearning = (state, d) => writeJson(statePath(state), d);

// The ISO week of a local time: `2026-W46`.
export function weekOf(ms) {
  const d = new Date(ms);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - dow + 3);
  const firstThursday = new Date(day.getFullYear(), 0, 4);
  const week = 1 + Math.round(((day - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${day.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
const weekStart = (ms) => {
  const d = new Date(ms);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
};

// The trend line's numbers: the owner's edits per PR last week (the week before the run's), against the average of the
// earlier weeks that had any (up to four). From the log: the measures of pipeline-measures don't read the ledgers yet
// (TASK-100), and the log is the same edits, block by block.
export function trendOf(log, now) {
  const last = weekStart(now) - 7 * 86400000;
  const byWeek = new Map();
  for (const e of log) {
    const at = Date.parse(e.at ?? e.logged ?? '');
    if (!Number.isFinite(at)) continue;
    const w = weekStart(at);
    const x = byWeek.get(w) ?? { edits: 0, prs: new Set() };
    x.edits += 1;
    x.prs.add(`${e.repo}#${e.pr}`);
    byWeek.set(w, x);
  }
  const per = (x) => (x && x.prs.size ? x.edits / x.prs.size : 0);
  const cur = byWeek.get(last);
  const earlier = [...byWeek.entries()].filter(([w]) => w < last).sort((a, b) => b[0] - a[0]).slice(0, 4);
  const before = earlier.length ? earlier.reduce((s, [, x]) => s + per(x), 0) / earlier.length : null;
  return { now: per(cur), prs: cur?.prs.size ?? 0, before, weeks: earlier.length };
}
const num = (x) => (Math.round(x * 10) / 10).toFixed(1);
const fill = (t, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`<${k}>`).join(String(v)), t);

// ------------------------------------------------------------------ the session's result, checked (AC-1)

const normal = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The session's patterns against the log: { kept, refused }. Kept: two examples or more, from two PRs or more, each a
// line of the log no earlier proposal used and no other kept pattern cites, of a known kind, with the rule and its
// reason, and not a rule the owner rejected before.
export function checkPatterns(result, { log, consumed = [], rejected = [], taken = [] }) {
  const byId = new Map(log.map((e) => [e.id, e]));
  const used = new Set(consumed);
  const gone = new Set(rejected.map(normal));
  // A rule open on a PR or accepted already (any of its wordings): proposing it again would add a second kit line.
  const have = new Set(taken.map(normal));
  const kept = [];
  const refused = [];
  for (const [i, p] of (Array.isArray(result?.patterns) ? result.patterns : []).entries()) {
    const no = (why) => refused.push({ i, rule: p?.rule ?? null, why });
    const kind = kindOf(p?.kind);
    if (!kind) {
      no(`the kind ${JSON.stringify(p?.kind)} is none of product, general, exception`);
      continue;
    }
    if (typeof p.rule !== 'string' || !p.rule.trim() || typeof p.why !== 'string' || !p.why.trim()) {
      no('a pattern needs "rule" and "why"');
      continue;
    }
    const ids = [...new Set(Array.isArray(p.examples) ? p.examples.map(String) : [])];
    const unknown = ids.filter((x) => !byId.has(x));
    if (unknown.length) {
      no(`examples not in the log: ${unknown.join(', ')}`);
      continue;
    }
    const again = ids.filter((x) => used.has(x));
    if (again.length) {
      no(`examples an earlier proposal already used: ${again.join(', ')}`);
      continue;
    }
    const prs = new Set(ids.map((x) => `${byId.get(x).repo}#${byId.get(x).pr}`));
    if (ids.length < 2 || prs.size < 2) {
      no(`seen ${ids.length} time(s) on ${prs.size} PR(s): a rule needs two examples on two PRs at least`);
      continue;
    }
    if (gone.has(normal(p.rule))) {
      no('the owner rejected this rule before');
      continue;
    }
    if (have.has(normal(p.rule))) {
      no('this rule is open on a rule PR or accepted already');
      continue;
    }
    if (kind === 'exception' && !(typeof p.overrides === 'string' && p.overrides.trim())) {
      no('an exception names the general rule it overrides ("overrides")');
      continue;
    }
    for (const x of ids) used.add(x);
    have.add(normal(p.rule));
    kept.push({ kind, rule: p.rule.trim(), why: p.why.trim(), examples: ids, ...(kind === 'exception' ? { overrides: p.overrides.trim(), ...(p.correct === true ? { correct: true } : {}) } : {}), ...(typeof p.question === 'string' && p.question.trim() ? { question: p.question.trim() } : {}) });
  }
  return { kept, refused };
}

// ------------------------------------------------------------------ the kit file

export const markerOf = (rid) => `<!-- learned:${rid} -->`;
export function kitLine(item, labels) {
  const over = item.kind === 'exception' && item.overrides ? ` (${labels.kinds.exception}: ${item.overrides})` : '';
  return `- ${item.rule}${over} ${labels.why}: ${item.why} ${markerOf(item.rid)}`;
}

// The kit's text with the lines added under `section` (made at the end when the file has none) and the marked lines of
// `remove` taken out. A missing file starts as the starter kit's skeleton.
export function editKit(text, { add = [], replace = [], remove = [], section, labels }) {
  let lines = (text ?? `# Product rules\n`).replace(/\r\n?/g, '\n').split('\n');
  for (const rid of [...remove, ...replace.map((x) => x.rid)]) {
    const i = lines.findIndex((l) => l.includes(markerOf(rid)));
    if (i < 0) continue;
    if (remove.includes(rid)) lines.splice(i, 1);
    else lines[i] = kitLine(replace.find((x) => x.rid === rid), labels);
  }
  if (add.length) {
    let at = lines.findIndex((l) => l.trim() === section.trim());
    if (at < 0) {
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      lines.push('', section, '');
      at = lines.length - 2;
    }
    let end = at + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
    while (end > at + 1 && !lines[end - 1].trim()) end--;
    const block = add.map((x) => kitLine(x, labels));
    const before = end === at + 1 ? [''] : [];
    lines.splice(end, 0, ...before, ...block);
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

// ------------------------------------------------------------------ the host PR's description

const short = (s, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// The description, in the host's PR structure (D-091, D-123): the trend line, the numbered list of rules (kind, rule,
// why, «was → now» with PR links), then Description, the closed list of changes, Task link and Open questions.
export function renderBody({ pr, rules, log, trend, labels, kit }) {
  const byId = new Map(log.map((e) => [e.id, e]));
  const L = labels;
  const items = pr.items ?? [];
  const out = [trend.before === null ? fill(L.trendFirst, { now: num(trend.now), prs: trend.prs }) : fill(L.trend, { now: num(trend.now), prs: trend.prs, before: num(trend.before), weeks: trend.weeks }), ''];
  for (const it of items) {
    const r = rules.find((x) => x.rid === it.rid);
    const head = `${it.n}. **${L.kinds[it.kind]}** — ${it.rule}${it.kind === 'exception' && r?.overrides ? ` (${L.overrides}: ${r.overrides})` : ''}`;
    out.push(it.state === 'rejected' ? `${it.n}. ~~${L.kinds[it.kind]} — ${it.rule}~~ (${L.rejectedMark})` : head);
    if (it.state === 'rejected') continue;
    out.push(`   ${L.why}: ${it.why}`);
    for (const id of r?.examples ?? []) {
      const e = byId.get(id);
      if (!e) continue;
      out.push(`   - ${L.example}: «${short(e.before) || '—'}» → «${short(e.after) || '—'}» ([${e.repo}#${e.pr}](${e.url ?? '#'}))`);
    }
  }
  if (!items.length) out.push(L.removedOnly);
  const added = items.map((x) => x.n);
  const removed = (pr.removes ?? []).map((rid) => rules.find((x) => x.rid === rid)?.rule).filter(Boolean);
  out.push('', '## Description', '', L.description, '', '<details>', `<summary>${L.changes}</summary>`, '');
  if (added.length) out.push(`- \`${kit}\`: ${fill(L.added, { list: added.join(', ') })}.`);
  if (removed.length) out.push(`- \`${kit}\`: ${fill(L.removed, { list: removed.map((x) => `«${short(x, 80)}»`).join(', ') })}.`);
  out.push('', '</details>', '', `## ${L.taskLink}`, '', `- ${L.noTask}`, '', `## ${L.questions}`, '');
  const qs = items.filter((x) => x.state !== 'rejected' && rules.find((r) => r.rid === x.rid)?.question);
  if (qs.length) out.push('<details>', `<summary>${L.reader}</summary>`, '', ...qs.map((x) => `- ${x.n}: ${rules.find((r) => r.rid === x.rid).question}`), '', '</details>');
  else out.push(L.none);
  out.push('', L.how);
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ names that never go into the toolkit

// The host's names: its repos, the logins of its people and its forge owner, the hub's folder, and `learning.names` (the
// product's and the company's names, which the settings can't know). Not a target's id or app label: those are often
// plain words («operator») that a general rule may well use.
// A repo name's own words (split on - and _), the generic ones left out: «ACME-DOC-PORTAL» gives ACME.
const GENERIC = new Set(['doc', 'docs', 'documentation', 'api', 'client', 'clients', 'operator', 'operators', 'developer', 'developers', 'dev', 'guide', 'guides', 'portal', 'site', 'web', 'www', 'app', 'apps', 'main', 'admin', 'user', 'users', 'public', 'internal', 'core', 'sdk', 'help', 'kb', 'wiki', 'content', 'hub', 'repo', 'service', 'services', 'platform', 'manual', 'reference', 'partner', 'partners']);
const repoWords = (repo) => String(repo ?? '').split(/[-_.\s]+/u).filter((w) => w.length >= 3 && !GENERIC.has(w.toLowerCase()));

export function namesOf(settings) {
  const n = [
    ...settings.targets.flatMap((t) => [t.repo, ...repoWords(t.repo), ...(t.reviewers ?? []), ...(t.cardMembers ?? [])]),
    ...repoWords(path.basename(settings.root)),
    settings.forge.owner, settings.forge.self, settings.forge.assignee, settings.tracker?.owner,
    path.basename(settings.root),
    ...(settings.learning?.names ?? []),
  ];
  return [...new Set(n.filter((x) => typeof x === 'string' && x.trim().length >= 3).map((x) => x.trim()))];
}
export function namesIn(text, names) {
  const s = String(text ?? '');
  return names.filter((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(s));
}

// ------------------------------------------------------------------ the owner's reply by number on a rule PR

// A reply that starts with a no-word is a no, whatever follows it («2 — ні, це факт», «2 — не додавай це»).
const NO = /^(?:ні|нi|no|nope|не\s+треба|не\s+потрібно|не\s+додавай\S*|не\s+бери|прибери\S*|прибрати|видали\S*|відхил\S*|reject\S*|drop|remove)(?=$|[\s,.;:!?—–-])/iu;

// Each item the reply names, against the PR's items: { n, do: keep | reject | verbatim | kind | rewrite | ask, … }.
export function resolveRuleReply(body, items) {
  const parsed = parseReply(body);
  if (!parsed) return null;
  return parsed.items.map((it) => {
    const item = items.find((x) => x.n === it.n);
    const ask = (why) => ({ n: it.n, do: 'ask', why });
    if (it.ownList) return ask('the comment reads as a numbered list of its own');
    if (it.together) return ask(`items ${it.together.join(', ')} are named together: one at a time`);
    if (it.twice) return ask(`item ${it.n} is named twice`);
    if (!item) return ask(`there is no rule ${it.n} on this PR`);
    if (item.state === 'rejected') return ask(`rule ${it.n} was removed already`);
    const words = String(it.text ?? '').trim().replace(/[.!]+$/u, '');
    if (it.kind === 'verbatim') return { n: it.n, do: 'verbatim', rule: it.text };
    if (it.kind === 'keep') return { n: it.n, do: 'keep' };
    if (it.kind === 'unclear') return ask(`rule ${it.n} is named with nothing to do`);
    if (it.kind === 'restore') return ask(`«${words}» on rule ${it.n}: keep it or drop it?`);
    if (it.kind === 'either' || NO.test(words)) return { n: it.n, do: 'reject' };
    const kind = kindOf(words);
    if (kind) return kind === 'exception' && !item.overrides ? ask(`rule ${it.n} as an exception: which general rule does it override?`) : { n: it.n, do: 'kind', kind };
    return { n: it.n, do: 'rewrite', how: it.text.trim() };
  });
}

// ------------------------------------------------------------------ git, for the runner's own commits

const gitRun = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const gitTry = (cwd, args) => {
  try {
    return gitRun(cwd, args);
  } catch {
    return null;
  }
};

// A detached worktree of the clone at `ref`, beside nothing the owner uses: `<state>/learning/trees/<name>`. A tree made
// before is put at `ref` clean (forced checkout, its untracked files removed: inside the tree only), so a step that
// failed half way leaves nothing to the next.
function treeAt(settings, clone, name, ref, git) {
  const tree = path.join(learningDir(settings.state), 'trees', name);
  if (fs.existsSync(path.join(tree, '.git'))) {
    git(tree, ['checkout', '-q', '-f', '--detach', ref]);
    git(tree, ['clean', '-fdq']);
    return tree;
  }
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git(clone, ['worktree', 'add', '-q', '--detach', tree, ref]);
  return tree;
}

// A tree the step is done with, removed from its clone (merged, closed or failed). A tree that can't be removed stays,
// with a note.
function dropTree(clone, tree, git, out, what) {
  if (!tree || !fs.existsSync(tree)) return;
  try {
    git(clone, ['worktree', 'remove', '--force', tree]);
  } catch (e) {
    out.notes.push(`${what}: its worktree ${tree} stays (${String(e.message ?? e).split('\n')[0]})`);
  }
}

// ------------------------------------------------------------------ the session

const SESSION_MS = 60 * 60 * 1000;

// One learner session: the input in a file, the brief naming it and the result file the session writes, nothing else.
// Returns { result, cost, error }.
export async function runSession({ settings, mode, input, io = {}, now }) {
  const { commandFor, spawnClaude, parseResult, agentsFile } = await import('./runner.mjs');
  const dir = path.join(settings.state, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const inFile = path.join(dir, `learn-${mode}-${stamp}-input.json`);
  const outFile = path.join(dir, `learn-${mode}-${stamp}-result.json`);
  fs.writeFileSync(inFile, JSON.stringify(input, null, 2));
  const agentsPath = path.join(settings.state, 'roles', 'agents.json');
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  fs.writeFileSync(agentsPath, JSON.stringify(agentsFile(), null, 2));
  const brief = [
    `Stage \`learn ${mode}\` of the learning from the owner's edits (the learner role, "${mode === 'week' ? 'The weekly grouping' : mode === 'answer' ? 'A rewording by description' : 'The rule for the toolkit'}").`,
    `Read the input: ${inFile}`,
    `Write your result as JSON with the Write tool to exactly: ${outFile}`,
    'Write nothing else, run nothing, post nothing: the runner checks the result and does every change itself.',
  ].join('\n');
  const cmd = commandFor({ stage: `learn-${mode}`, role: 'learner', keys: [], worktrees: [] }, settings, { agentsPath, claude: io.claude ?? 'claude', brief });
  const res = await (io.spawnClaude ?? spawnClaude)(cmd, { timeoutMs: SESSION_MS, env: io.claudeEnv ?? process.env });
  const parsed = parseResult(res.stdout);
  const cost = { mode, at: new Date(now).toISOString(), model: cmd.model, code: res.code, costUsd: parsed?.costUsd ?? null, turns: parsed?.turns ?? null };
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return { result: null, cost, error: res.code === 0 ? 'the session wrote no result file' : `the session ended with exit ${res.code}${res.timedOut ? ' (timed out)' : ''}` };
  }
  return { result, cost, error: null };
}

// ------------------------------------------------------------------ the toolkit's forge

export function toolkitForge(settings, io = {}) {
  const t = settings.learning?.toolkit;
  if (!t) return null;
  const [owner, name] = t.repo.split('/');
  const forge = validateForge({ kind: settings.forge.kind, owner, self: settings.forge.self, assignee: settings.forge.assignee }, [{ id: 'toolkit', repo: name }], null);
  if (io.toolkitForgeAdapter) return createForge({ adapter: io.toolkitForgeAdapter, forge });
  const made = createForgeAdapter(forge, { env: io.env ?? process.env, runner: io.ghRunner ?? spawnGh });
  return createForge({ adapter: made.adapter, forge });
}

// ------------------------------------------------------------------ the check

// Whether a learner session (the week's, a rewording, the toolkit's) may start now, or why not: today's morning run
// done, no ticket run going (D-131: the tickets first), and inside `limits.startHours` (D-109: no work at night or in
// the early morning).
export function sessionGate({ settings, now, morningDone, busy }) {
  if (!morningDone) return "today's morning run hasn't run yet";
  if (busy) return `the tickets first: ${busy}`;
  const h = parseStartHours(settings.limits?.startHours) ?? parseStartHours('10-22');
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < h.from || m >= h.to) return `outside the start hours (${settings.limits?.startHours ?? '10-22'})`;
  return null;
}

// A weekly session that failed is tried again at most WEEK_TRIES times in its week, two hours apart.
export const WEEK_TRIES = 3;
const WEEK_BACKOFF_MS = 2 * 60 * 60 * 1000;

// Whether the weekly session is due now: `learning` set, this week not done, not past its tries, and the session gate
// open (`sessionGate`).
export function weekDue({ settings, data, now, morningDone, busy }) {
  if (!settings.learning) return { due: false, why: 'no learning settings' };
  const week = weekOf(now);
  // The week the learning was switched on gets no session of its own: the first one is the next week's, on its Monday,
  // and reads that week's edits too (the backfill's among them). Switched on mid-week, nothing runs at once.
  if (!data.startWeek || week <= data.startWeek) return { due: false, why: `the learning started in ${data.startWeek ?? week}: the first session is the next week's` };
  if (data.weeks[week]) return { due: false, why: `${week} is done` };
  const tries = data.attempts?.[week];
  if (tries?.n >= WEEK_TRIES) return { due: false, why: `${week}: the session failed ${tries.n} times (${tries.why}); the next one is next week's` };
  if (tries?.last && now - Date.parse(tries.last) < WEEK_BACKOFF_MS) return { due: false, why: `${week}: the last try failed (${tries.why}); the next one two hours after it` };
  const gate = sessionGate({ settings, now, morningDone, busy });
  if (gate) return { due: false, why: gate };
  return { due: true, week };
}

const usageHeld = async (settings, io, now) => {
  if (settings.limits.usageGuard === false) return null;
  const usage = io.readUsage ? await io.readUsage() : null;
  const a = allowanceOf(usage, settings.limits, new Date(now));
  if (!a) return 'no usage reading';
  return a.remaining <= 0 ? `the week is at ${a.used}%, the allowance by now is ${a.cap}%` : null;
};

// The kit folder of a target's repo, from that repo's CLAUDE.md at `origin/<base>` (`Product kit:`), or null.
export function kitOf(settings, target, git = gitTry) {
  const clone = path.resolve(settings.root, target.path);
  const text = git(clone, ['show', `origin/${target.base ?? 'main'}:CLAUDE.md`]) ?? git(clone, ['show', 'HEAD:CLAUDE.md']);
  const kit = text ? parseClaudeConfig(text)['product kit'] : null;
  return kit ? kit.replace(/^\.\//, '').replace(/\/?$/, '/') : null;
}

// What a learning pass does, in order, each part with no model unless it says so. It runs in a process of its own
// (`watcher.mjs --learn`, handed on by the full check, lib/watch.mjs 5c), never inside the check, so no session holds the
// check's lock.
//   1. the open rule PRs: merged, closed, the branch's rule lines against the items' states, or the owner's reply by
//      number (a rewording by description: one session, gated like the week's);
//   2. the toolkit PRs: the open ones' merge or close, then a queued general rule (one session, gated, and only while
//      no other toolkit PR is open, so two never take the same rule number);
//   3. the weekly session when due, after one more collection (lib/learn-log.mjs), so it reads the latest edits.
// Returns { notes, proposed, replied, toolkit, week, notify, unclear }. `dryRun` and a mode other than `on`: reads and
// plans; writes, removes and pushes nothing.
export async function learningCheck({ settings, clients, io = {}, now = Date.now(), st = null, morningDone = false, busy = null, dryRun = false }) {
  const out = { notes: [], proposed: [], replied: [], toolkit: [], week: null, notify: [], unclear: [] };
  if (!settings.learning) return out;
  const live = !dryRun && settings.mode === 'on';
  const git = io.git ?? gitRun;
  const data = readLearning(settings.state);
  const save = () => live && saveLearning(settings.state, data);
  let log = readLog(settings.state);
  const gate = sessionGate({ settings, now, morningDone, busy });

  // 1. The open rule PRs.
  for (const pr of data.prs.filter((p) => p.state === 'open')) {
    try {
      const s = await clients.forge.prState({ repo: pr.repo, number: pr.number });
      const merged = s.state === 'merged' || s.merged;
      if ((merged || s.state === 'closed') && !live) {
        out.notes.push(`${pr.repo}#${pr.number}: ${merged ? 'merged' : 'closed'}; recorded at a live pass`);
        continue;
      }
      if (merged) {
        pr.state = 'merged';
        pr.mergedAt = s.mergedAt ?? new Date(now).toISOString();
        for (const it of pr.items) {
          if (it.state !== 'open') continue;
          it.state = 'accepted';
          const r = data.rules.find((x) => x.rid === it.rid);
          if (!r) continue;
          r.accepted = [...new Set([...(r.accepted ?? []), pr.repo])];
          // A general rule (and an exception whose toolkit rule is wrong) goes to the toolkit next.
          if (settings.learning.toolkit && !r.toolkit && (it.kind === 'general' || (it.kind === 'exception' && r.correct))) r.toolkit = { state: 'queued', at: new Date(now).toISOString(), kind: it.kind, rule: it.rule, why: it.why };
        }
        for (const rid of pr.removes ?? []) {
          const r = data.rules.find((x) => x.rid === rid);
          if (r) r.removedFrom = [...new Set([...(r.removedFrom ?? []), pr.repo])];
        }
        removeTree(settings, pr, git, out);
        continue;
      }
      if (s.state === 'closed') {
        pr.state = 'closed';
        for (const it of pr.items.filter((x) => x.state === 'open')) reject(data, it, 'closed unmerged');
        removeTree(settings, pr, git, out);
        continue;
      }
      if (!live) continue;
      // The branch moved (the owner pushed, or a reply's commit): its rule lines against the items' states.
      if (s.headCommit && s.headCommit !== pr.head) {
        reconcile({ settings, data, pr, git, out });
        pr.head = s.headCommit;
      }
      const act = await clients.forge.prActivity({ repo: pr.repo, number: pr.number });
      const fresh = (act.comments ?? []).filter((c) => !(pr.seen ?? []).includes(c.id) && !(pr.posted ?? []).includes(c.id));
      // The owner's comments only (`forge.self`; the pipeline posts from the owner's login, so a comment with the header,
      // or one it posted, is its own), with the trigger word or without it: a rule PR is the owner's own thread. Another
      // person's comment is never obeyed. A comment that reads as no reply by number is listed in progress.md, never
      // dropped silently. A comment is seen once it was answered, so an answer that failed part way, or a rewording
      // that waits for the gate, is tried again at a later pass (and the comments after it wait for it).
      for (const c of fresh) {
        const plain = withoutHeader(c.body ?? '', settings.commentHeader);
        const own = c.author === settings.forge.self && !(settings.commentHeader && plain !== (c.body ?? ''));
        if (!own) {
          pr.seen = [...(pr.seen ?? []), c.id];
          continue;
        }
        const text = (settings.triggerWords?.length ? afterTrigger(plain, settings.triggerWords) : null) ?? plain;
        const done = resolveRuleReply(text, pr.items.map((it) => ({ ...it, overrides: data.rules.find((r) => r.rid === it.rid)?.overrides })));
        if (!done?.length) {
          pr.unclear = [...(pr.unclear ?? []), { id: c.id, url: c.url ?? null, at: c.createdAt ?? null, text: short(plain, 120) }];
          pr.seen = [...(pr.seen ?? []), c.id];
          continue;
        }
        if (done.some((x) => x.do === 'rewrite') && gate) {
          out.notes.push(`${pr.repo}#${pr.number}: a rewording by description waits: ${gate}`);
          break;
        }
        if (!(await answer({ settings, clients, io, data, pr, done, git, now, log, out, comment: c.id }))) break;
      }
    } catch (e) {
      out.notes.push(`${pr.repo}#${pr.number}: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
  for (const pr of data.prs.filter((p) => p.state === 'open' && p.unclear?.length)) out.unclear.push({ pr: `${pr.repo}#${pr.number}`, url: pr.url ?? null, comments: pr.unclear });
  save();

  // 2. The toolkit.
  if (settings.learning.toolkit) {
    const tf = toolkitForge(settings, io);
    const tclone = path.resolve(settings.root, settings.learning.toolkit.path);
    for (const r of data.rules.filter((x) => x.toolkit?.state === 'open')) {
      try {
        const s = await tf.prState({ repo: settings.learning.toolkit.repo, number: r.toolkit.number });
        const ended = s.state === 'merged' || s.merged ? 'merged' : s.state === 'closed' ? 'closed' : null;
        if (ended && live) {
          r.toolkit.state = ended;
          dropTree(tclone, r.toolkit.tree, git, out, `the toolkit PR of ${r.rid}`);
        }
      } catch (e) {
        out.notes.push(`the toolkit PR of ${r.rid}: ${String(e.message ?? e).split('\n')[0]}`);
      }
    }
    const next = data.rules.find((x) => x.toolkit?.state === 'queued');
    const openOne = data.rules.find((x) => x.toolkit?.state === 'open');
    if (next && live) {
      if (openOne) out.notes.push(`the toolkit rule ${next.rid} waits for the toolkit PR of ${openOne.rid} (#${openOne.toolkit.number}): one at a time, so two never take one rule number`);
      else if (gate) out.notes.push(`the toolkit rule ${next.rid} waits: ${gate}`);
      else {
        const held = await usageHeld(settings, io, now);
        if (held) out.notes.push(`the toolkit rule ${next.rid} waits: ${held}`);
        else await toolkitStep({ settings, io, data, rule: next, tf, git, now, log, out });
      }
    }
    save();
  }

  // 3. The week. The first live pass records the week the learning started in.
  if (!data.startWeek && live) {
    data.startWeek = weekOf(now);
    save();
  }
  const due = weekDue({ settings, data, now, morningDone, busy });
  out.week = due;
  if (due.due && live) {
    const held = await usageHeld(settings, io, now);
    if (held) out.week = { due: false, why: held };
    else {
      try {
        const { readAllLedgers } = await import('./ledger.mjs');
        const r = await collectOnce(settings, { ledgers: readAllLedgers(settings.state), viewOf: io.viewOf ?? viewsFrom(st, clients.forge), ...(io.learnReader ? { git: io.learnReader } : {}), now });
        out.collected = r.added.length;
        out.notes.push(...r.notes);
      } catch (e) {
        out.notes.push(`the collection of the owner's edits failed: ${String(e.message ?? e).split('\n')[0]}`);
      }
      log = readLog(settings.state);
      await weekStep({ settings, clients, io, data, week: due.week, git, now, log, out });
      save();
    }
  }
  return out;
}

// The rule lines on a rule PR's branch against its items: a line still there for a rejected item (a push that failed
// after the state was kept, by an older version) is removed; an open item whose line the owner took out by hand is
// rejected, as a no.
function reconcile({ settings, data, pr, git, out }) {
  const file = path.posix.join(pr.kit, 'product-rules.md');
  git(pr.clone, ['fetch', '-q', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`]);
  const text = gitTryWith(git, pr.clone, ['show', `origin/${pr.branch}:${file}`]);
  if (text === null) return;
  const onBranch = new Set([...String(text).matchAll(/<!-- learned:(\S+) -->/g)].map((m) => m[1]));
  for (const it of pr.items.filter((x) => x.state === 'open' && !onBranch.has(x.rid))) reject(data, it, 'its line was removed from the branch');
  const stale = pr.items.filter((x) => x.state === 'rejected' && onBranch.has(x.rid)).map((x) => x.rid);
  if (!stale.length) return;
  pr.tree = treeAt(settings, pr.clone, pr.treeName, `origin/${pr.branch}`, git);
  commitKit({ settings, git, pr, edit: { remove: stale }, message: settings.learning.labels.answerCommit });
  out.notes.push(`${pr.repo}#${pr.number}: the lines of rejected rules ${stale.join(', ')} removed from the branch`);
}

const removeTree = (settings, pr, git, out) => dropTree(pr.clone, pr.tree, git, out, `${pr.repo}#${pr.number}`);

function reject(data, it, why) {
  it.state = 'rejected';
  it.why_rejected = why;
  const r = data.rules.find((x) => x.rid === it.rid);
  if (r) r.rejected = [...new Set([...(r.rejected ?? []), it.rule])];
}

// The rule texts the owner rejected, every wording of them: named to every session, and refused in a result.
export const rejectedTexts = (data) => [...new Set(data.rules.flatMap((r) => r.rejected ?? []))];

// The kit file's path in a target's clone, committed and pushed in its worktree; returns the new head.
function commitKit({ settings, git, pr, edit, message }) {
  const file = path.join(pr.tree, pr.kit, 'product-rules.md');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const after = editKit(before, { ...edit, section: settings.learning.section, labels: settings.learning.labels });
  if (after === before) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  git(pr.tree, ['add', '--', path.join(pr.kit, 'product-rules.md')]);
  git(pr.tree, ['commit', '-q', '-m', message]);
  git(pr.tree, ['push', '-q', 'origin', `HEAD:refs/heads/${pr.branch}`]);
  return git(pr.tree, ['rev-parse', 'HEAD']).trim();
}

// The owner's reply on a rule PR, done: a rewording by description goes to one session (which may also say the owner
// meant no, another kind, or ask back), then the kit's lines change on the branch, and only once that push went
// through do the items' states change, so a failed push keeps nothing. The comment is seen from then on; the reply in
// the thread and the description are posted after, a failure there only noted. Returns false when nothing was done
// (the comment is read again at a later pass).
async function answer({ settings, clients, io, data, pr, done, git, now, log, out, comment = null }) {
  const L = settings.learning.labels;
  const overridesOf = (it) => data.rules.find((r) => r.rid === it.rid)?.overrides;
  const rewrites = done.filter((x) => x.do === 'rewrite');
  if (rewrites.length) {
    const held = await usageHeld(settings, io, now);
    const res = held ? { result: null, error: held } : await runSession({ settings, mode: 'answer', now, io, input: { rules: rewrites.map((x) => ({ n: x.n, ...pick(pr.items.find((it) => it.n === x.n)), how: x.how, examples: exampleTexts(data, log, pr.items.find((it) => it.n === x.n).rid) })), rejected: rejectedTexts(data) } });
    if (res.cost) data.runs.push(res.cost);
    if (held) {
      out.notes.push(`${pr.repo}#${pr.number}: a rewording by description waits: ${held}`);
      return false;
    }
    for (const x of rewrites) {
      const got = (res.result?.rules ?? []).find((r) => Number(r.n) === x.n);
      const it = pr.items.find((i) => i.n === x.n);
      const kind = got && !got.rule ? kindOf(got.kind) : null;
      if (got?.reject === true) Object.assign(x, { do: 'reject' });
      else if (kind) Object.assign(x, kind === 'exception' && !overridesOf(it) ? { do: 'ask', why: `rule ${x.n} as an exception: which general rule does it override?` } : { do: 'kind', kind });
      else if (got && typeof got.rule === 'string' && got.rule.trim()) Object.assign(x, { do: 'verbatim', rule: got.rule.trim(), described: true });
      else if (got && typeof got.ask === 'string' && got.ask.trim()) Object.assign(x, { do: 'ask', why: got.ask.trim() });
      else Object.assign(x, { do: 'ask', why: res.error ? `the rewording failed: ${res.error}` : 'no rewording came back' });
    }
  }
  const plan = done.map((x) => ({ x, it: pr.items.find((i) => i.n === x.n) })).filter((p) => p.it);
  const replace = [];
  const remove = [];
  for (const { x, it } of plan) {
    if (x.do === 'reject') remove.push(it.rid);
    else if (x.do === 'verbatim') replace.push({ ...it, rule: x.rule, overrides: overridesOf(it) });
    else if (x.do === 'kind') replace.push({ ...it, kind: x.kind, overrides: overridesOf(it) });
  }
  if (replace.length || remove.length) {
    try {
      // The branch as the forge has it (the owner may have pushed to it): fetched, and the worktree put at it.
      git(pr.clone, ['fetch', '-q', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`]);
      pr.tree = treeAt(settings, pr.clone, pr.treeName, `origin/${pr.branch}`, git);
      const head = commitKit({ settings, git, pr, edit: { replace, remove }, message: L.answerCommit });
      if (head) pr.head = head;
    } catch (e) {
      out.notes.push(`${pr.repo}#${pr.number}: the reply's change could not be pushed (${String(e.stderr || e.message || e).trim().split('\n')[0]}): read again at a later pass`);
      return false;
    }
  }
  for (const { x, it } of plan) {
    if (x.do === 'reject') reject(data, it, 'the owner said no');
    else if (x.do === 'verbatim') {
      if (normal(x.rule) !== normal(it.rule)) (data.rules.find((r) => r.rid === it.rid).wordings ??= []).push(it.rule);
      it.rule = x.rule;
    } else if (x.do === 'kind') it.kind = x.kind;
  }
  if (comment !== null) pr.seen = [...(pr.seen ?? []), comment];
  out.replied.push({ pr: `${pr.repo}#${pr.number}`, items: done.map((x) => ({ n: x.n, do: x.do })) });
  try {
    const lines = [L.replyTitle, '', ...done.map((x) => `**${x.n}** — ${L.done[x.do]}${x.do === 'ask' ? `: ${x.why}` : x.do === 'verbatim' ? `: «${pr.items.find((i) => i.n === x.n).rule}»` : x.do === 'kind' ? `: ${L.kinds[x.kind]}` : ''}`)];
    const posted = await clients.forge.comment({ repo: pr.repo, number: pr.number, body: lines.join('\n') });
    pr.posted = [...(pr.posted ?? []), ...(posted.posted ?? []).map((p) => p.id)];
    await clients.forge.editPr({ repo: pr.repo, number: pr.number, body: renderBody({ pr, rules: data.rules, log, trend: pr.trend, labels: L, kit: path.join(pr.kit, 'product-rules.md') }) });
  } catch (e) {
    out.notes.push(`${pr.repo}#${pr.number}: the reply was done, its comment or description not posted (${String(e.message ?? e).split('\n')[0]})`);
  }
  return true;
}

const pick = (it) => ({ kind: it.kind, rule: it.rule, why: it.why });
const exampleTexts = (data, log, rid) => {
  const r = data.rules.find((x) => x.rid === rid);
  const byId = new Map(log.map((e) => [e.id, e]));
  return (r?.examples ?? []).map((id) => byId.get(id)).filter(Boolean).map((e) => ({ page: e.page, block: e.block, before: e.before, after: e.after, comment: e.comment ?? null }));
};

// The rule texts open on a rule PR or accepted, every wording of them: a pattern proposing one again is refused.
const takenTexts = (data) => {
  const live = new Set(data.prs.flatMap((p) => p.items.filter((it) => it.state === 'open' || it.state === 'accepted').map((it) => it.rid)));
  return [...new Set(data.rules.filter((r) => live.has(r.rid)).flatMap((r) => [r.rule, ...(r.wordings ?? [])]).concat(data.prs.flatMap((p) => p.items.filter((it) => live.has(it.rid)).map((it) => it.rule))))];
};

async function weekStep({ settings, clients, io, data, week, git, now, log, out }) {
  const L = settings.learning.labels;
  const at = new Date(now).toISOString();
  const consumed = new Set(data.consumed);
  const horizon = now - settings.learning.horizonWeeks * 7 * 86400000;
  const open = log.filter((e) => !consumed.has(e.id) && Date.parse(e.at ?? e.logged ?? '') >= horizon);
  const prsSeen = new Set(open.map((e) => `${e.repo}#${e.pr}`));
  const tries = data.attempts?.[week] ?? { n: 0 };
  const failTry = (why) => {
    (data.attempts ??= {})[week] = { n: tries.n + 1, last: at, why };
    out.notes.push(`the weekly session of ${week}: ${why}; try ${tries.n + 1} of ${WEEK_TRIES}`);
    out.week = { due: false, week, error: why };
  };
  // The host copies of general rules the toolkit's own files hold now (the switch, by the rule's `learned:` id in the
  // installed plugin's file): removed in this week's PRs.
  const { PLUGIN_ROOT } = await import('./runner.mjs');
  const root = io.pluginRoot ?? PLUGIN_ROOT;
  const pending = new Set(data.prs.filter((p) => p.state === 'open').flatMap((p) => (p.removes ?? []).map((rid) => `${p.repo}|${rid}`)));
  const removable = (r, repo) => !(r.removedFrom ?? []).includes(repo) && !pending.has(`${repo}|${r.rid}`);
  const removes = data.rules.filter((r) => r.toolkit?.state === 'merged' && r.toolkit.kind === 'general' && r.toolkit.file && (r.accepted ?? []).some((repo) => removable(r, repo)) && (() => {
    try {
      return fs.readFileSync(path.join(root, r.toolkit.file), 'utf8').includes(markerOf(r.rid));
    } catch {
      return false;
    }
  })());
  let kept = [];
  let facts = [];
  const record = { at, entries: open.length, prs: prsSeen.size };
  if (prsSeen.size >= 2) {
    const kits = {};
    for (const t of settings.targets) if (!kits[t.repo]) kits[t.repo] = kitText(settings, t, git);
    const res = await runSession({
      settings, mode: 'week', now, io,
      input: { week, edits: open, rejected: rejectedTexts(data), taken: takenTexts(data), kits, kinds: { product: KINDS.product[1], general: KINDS.general[1], exception: KINDS.exception[1] } },
    });
    if (res.cost) data.runs.push(res.cost);
    if (res.error) return failTry(res.error);
    const checked = checkPatterns(res.result, { log, consumed: data.consumed, rejected: rejectedTexts(data), taken: takenTexts(data) });
    kept = checked.kept;
    record.refused = checked.refused;
    facts = (Array.isArray(res.result?.dropped) ? res.result.dropped : []).filter((d) => d?.why === 'fact').flatMap((d) => (Array.isArray(d.ids) ? d.ids.map(String) : [])).filter((id) => log.some((e) => e.id === id));
    record.dropped = res.result?.dropped ?? [];
  } else record.skipped = `${prsSeen.size} PR(s) with new edits: no session`;
  // The rules get their ids now (after the week's earlier ones, a retry's included) and are kept only once a PR carries
  // them: a rule no PR could be opened for leaves its examples unused for the next try.
  const n0 = data.rules.filter((r) => r.week === week).length;
  const fresh = kept.map((p, i) => ({ rid: `${week}-${n0 + i + 1}`, week, ...p, at }));
  const all = [...data.rules, ...fresh];
  const byId = new Map(log.map((e) => [e.id, e]));
  const trend = trendOf(log, now);
  const repos = [...new Set([...fresh.flatMap((r) => r.examples.map((id) => byId.get(id)?.repo)), ...removes.flatMap((r) => r.accepted)].filter(Boolean))];
  record.prs = [];
  const carried = new Set();
  let failed = 0;
  for (const repo of repos) {
    const target = settings.targets.find((t) => t.repo === repo && t.path);
    if (!target) continue;
    // A retry never opens a second PR of the week in a repo.
    if (data.prs.some((p) => p.week === week && p.repo === repo)) continue;
    const kit = kitOf(settings, target, (cwd, args) => gitTryWith(git, cwd, args));
    if (!kit) {
      out.notes.push(`${repo}: its CLAUDE.md declares no "Product kit:": no rule PR there`);
      continue;
    }
    const mine = fresh.filter((r) => r.examples.some((id) => byId.get(id)?.repo === repo));
    const dropHere = removes.filter((r) => (r.accepted ?? []).includes(repo) && removable(r, repo)).map((r) => r.rid);
    if (!mine.length && !dropHere.length) continue;
    const base = target.base ?? 'main';
    const branch = settings.learning.branch.replace('<week>', week.toLowerCase());
    const clone = path.resolve(settings.root, target.path);
    const pr = { repo, branch, base, kit, clone, treeName: `${repo}/${branch}`, week, state: 'open', items: mine.map((r, i) => ({ n: i + 1, rid: r.rid, kind: r.kind, rule: r.rule, why: r.why, state: 'open' })), removes: dropHere, trend, seen: [], posted: [] };
    let pushed = false;
    try {
      git(clone, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
      pr.tree = treeAt(settings, clone, pr.treeName, `origin/${base}`, git);
      const head = commitKit({ settings, git, pr, edit: { add: pr.items.map((it) => ({ ...it, overrides: fresh.find((r) => r.rid === it.rid)?.overrides })), remove: dropHere }, message: L.commit });
      if (!head) {
        out.notes.push(`${repo}: the kit already reads as proposed: no PR`);
        dropTree(clone, pr.tree, git, out, repo);
        continue;
      }
      pushed = true;
      pr.head = head;
      const body = renderBody({ pr, rules: all, log, trend, labels: L, kit: path.join(kit, 'product-rules.md') });
      const made = await clients.forge.openPr({ repo, head: branch, base, title: fill(L.title, { week }), body });
      Object.assign(pr, { number: made.number, url: made.url, at });
      data.prs.push(pr);
      for (const it of pr.items) carried.add(it.rid);
      record.prs.push(`${repo}#${made.number}`);
      out.proposed.push({ repo, number: made.number, url: made.url, rules: pr.items.length, removes: dropHere.length });
    } catch (e) {
      failed++;
      out.notes.push(`${repo}: the rule PR could not be made (${String(e.stderr || e.message || e).trim().split('\n')[0]})`);
      // Nothing of it stays: the branch it pushed is deleted, its worktree removed.
      if (pushed) gitTryWith(git, clone, ['push', '-q', 'origin', `:refs/heads/${branch}`]);
      dropTree(clone, pr.tree, git, out, repo);
    }
  }
  for (const r of fresh) if (carried.has(r.rid)) data.rules.push(r);
  data.consumed = [...new Set([...data.consumed, ...fresh.filter((r) => carried.has(r.rid)).flatMap((r) => r.examples), ...facts])];
  if (out.proposed.length) out.notify.push({ key: `learning:${week}:${out.proposed.map((p) => `${p.repo}#${p.number}`).join(',')}`, urgent: false, title: 'Ticket flow: rules from your edits', text: `${out.proposed.reduce((s, p) => s + p.rules, 0)} rule(s) proposed in ${out.proposed.map((p) => `${p.repo}#${p.number}`).join(', ')}: reply by number, or merge.` });
  if (failed) return failTry(`${failed} rule PR(s) could not be made`);
  data.weeks[week] = record;
  delete data.attempts?.[week];
}

const gitTryWith = (git, cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

function kitText(settings, target, git) {
  const kit = kitOf(settings, target, (cwd, args) => gitTryWith(git, cwd, args));
  if (!kit) return null;
  const clone = path.resolve(settings.root, target.path);
  return { kit, productRules: gitTryWith(git, clone, ['show', `origin/${target.base ?? 'main'}:${kit}product-rules.md`]) };
}

async function toolkitStep({ settings, io, data, rule, tf, git, now, log, out }) {
  const t = settings.learning.toolkit;
  const correct = rule.toolkit.kind === 'exception';
  const clone = path.resolve(settings.root, t.path);
  const branch = `learned-rule-${rule.rid.toLowerCase()}`;
  let tree = null;
  // A step that fails leaves nothing: its worktree goes, and it waits for the owner (not tried again by itself).
  const failed = (why) => {
    rule.toolkit = { ...rule.toolkit, state: 'failed', why, at: new Date(now).toISOString() };
    out.toolkit.push({ rid: rule.rid, failed: why });
    out.notes.push(`the toolkit rule ${rule.rid}: ${why}`);
    dropTree(clone, tree, git, out, `the toolkit rule ${rule.rid}`);
  };
  // The toolkit at its base, in a worktree of its clone that only the runner uses: the rule goes into the file as the
  // base has it, so its number is the next free one there (and no other toolkit PR is open: learningCheck).
  try {
    git(clone, ['fetch', '-q', 'origin', `+refs/heads/${t.base}:refs/remotes/origin/${t.base}`]);
    tree = treeAt(settings, clone, `toolkit/${branch}`, `origin/${t.base}`, git);
  } catch (e) {
    return failed(`the toolkit's clone can't be read (${String(e.stderr || e.message || e).trim().split('\n')[0]})`);
  }
  const root = path.join(tree, 'plugins', 'doc-writer-toolkit');
  const files = ruleFiles(root);
  const res = await runSession({ settings, mode: 'toolkit', now, io, input: { rule: rule.toolkit.rule, why: rule.toolkit.why, kind: rule.toolkit.kind, ...(correct ? { overrides: rule.overrides, correct: true } : {}), files, corpora: CORPORA, meaning: exampleTexts(data, log, rule.rid) } });
  if (res.cost) data.runs.push(res.cost);
  if (res.error) return failed(res.error);
  const r = res.result ?? {};
  // The PR's own words: one English sentence on what the rule says and why.
  if (typeof r.summary !== 'string' || !r.summary.trim() || /\p{Script=Cyrillic}/u.test(r.summary)) return failed('the result needs "summary": one English sentence, what the rule says and why');
  const file = String(r.file ?? '');
  const abs = path.join(root, file);
  if (!file || file.includes('..') || path.isAbsolute(file) || !fs.existsSync(abs)) return failed(`no such toolkit file: ${JSON.stringify(r.file)}`);
  const inCorpus = CORPORA.some((c) => file.startsWith(c));
  const ruleFile = files.find((f) => f.file === file);
  const text = fs.readFileSync(abs, 'utf8');
  let next;
  let heading;
  try {
    if (r.find !== undefined) {
      if (!correct) throw new Error('a general rule is added, never a correction');
      // A correction goes to a rule file or a distilled corpus only: never a skill, a command, a script or anything else.
      if (!ruleFile && !(inCorpus && file.endsWith('.md'))) throw new Error(`${file} is neither a rule file nor a distilled corpus file: a correction goes to the rules only`);
      if (inCorpus && !/^https?:\/\//.test(String(r.source ?? ''))) throw new Error('a correction of a distilled corpus cites its primary source ("source", a URL)');
      const find = String(r.find);
      const replacement = String(r.replace ?? '');
      const count = find ? text.split(find).length - 1 : 0;
      if (count !== 1) throw new Error(`the text to correct is found ${count} times in ${file}, not once`);
      // The file's language: a replacement in another script is refused (a short one tells nothing).
      const fileScript = scriptOf(text);
      const newScript = scriptOf(replacement);
      if (fileScript && newScript && fileScript !== newScript) throw new Error(`the correction is in ${newScript}, ${file} in ${fileScript}`);
      // The file's form: a heading the correction touches keeps the form of the file's rule headings.
      const f = formOf(text);
      const oldHeads = find.split('\n').filter((l) => /^#{2,6}\s/.test(l));
      const newHeads = replacement.split('\n').filter((l) => /^#{2,6}\s/.test(l));
      if (f?.form === 'heading' && (oldHeads.length || newHeads.length)) {
        if (oldHeads.length !== newHeads.length) throw new Error('the correction adds or removes a heading: a correction changes a rule\'s text, not the file\'s structure');
        const re = new RegExp(`^#{${f.level}} ${f.prefix}\\d+[a-z]? ${f.sep} .+$`, 'u');
        if (oldHeads.some((l) => re.test(l)) && !newHeads.every((l) => re.test(l))) throw new Error(`a rule heading keeps the file's form (\`${'#'.repeat(f.level)} ${f.prefix}N ${f.sep} …\`)`);
      }
      // A function, so a `$&` or `$1` in the text is the text, not a pattern.
      next = text.replace(find, () => replacement);
      heading = (newHeads[0] ?? replacement.split('\n').find((l) => l.trim()) ?? '').trim();
    } else {
      if (inCorpus) throw new Error('no rule from the owner\'s edits goes into a distilled corpus');
      if (!ruleFile) throw new Error(`${file} is not a rule file this tool can extend`);
      const ins = insertRule(text, r, { pluginRoot: root, marker: markerOf(rule.rid) });
      next = ins.text;
      heading = ins.heading;
    }
  } catch (e) {
    return failed(String(e.message ?? e));
  }
  const names = namesIn([r.summary, r.name, r.english, r.body, r.check, ...(Array.isArray(r.loadRow) ? r.loadRow : []), r.replace, r.source].filter(Boolean).join('\n'), namesOf(settings));
  if (names.length) return failed(`the rule names the host (${names.join(', ')}): never in the toolkit`);
  try {
    fs.writeFileSync(abs, next);
    // The toolkit's lint, before anything is pushed: a rule that breaks it never leaves the machine.
    const lint = path.join(tree, 'tools', 'lint-plugin.mjs');
    if (io.lint) io.lint(tree);
    else if (fs.existsSync(lint)) execFileSync(process.execPath, [lint], { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    else throw new Error('the toolkit has no tools/lint-plugin.mjs to check the rule with');
    git(tree, ['add', '--', path.join('plugins', 'doc-writer-toolkit', file)]);
    const title = correct ? `Correct ${path.basename(file)}: a rule the owner's edits reversed` : `Add a rule learned from the owner's edits to ${path.basename(file)}`;
    git(tree, ['commit', '-q', '-m', title]);
    git(tree, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    const body = [
      correct ? `A rule of \`${file}\` that the owner reversed on two PRs or more, corrected.` : `A general rule from the owner's edits, seen on two PRs or more and approved in a host's product rules, added to \`${file}\` in that file's own form.`,
      '',
      `- The rule: ${heading}`,
      `- What and why: ${r.summary.trim()}`,
      ...(r.source ? [`- Source: ${r.source}`] : []),
      '',
      'Merge it to make the rule shared. After the switch, the next weekly host proposal removes the host copy.',
      '',
    ].join('\n');
    const made = await tf.openPr({ repo: t.repo, head: branch, base: t.base, title, body });
    rule.toolkit = { ...rule.toolkit, state: 'open', number: made.number, url: made.url, file, heading, branch, tree, at: new Date(now).toISOString() };
    out.toolkit.push({ rid: rule.rid, number: made.number, url: made.url });
  } catch (e) {
    return failed(`the toolkit PR could not be made (${String(e.stdout || e.stderr || e.message || e).trim().split('\n').at(-1)})`);
  }
}

// `ticket-state learn status`: the log's counts, the weeks, the open rule PRs, the rules and their states. Reads only.
export function learnStatus(settings) {
  const log = readLog(settings.state);
  const d = readLearning(settings.state);
  const bySource = {};
  for (const e of log) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  return {
    log: { entries: log.length, prs: new Set(log.map((e) => `${e.repo}#${e.pr}`)).size, bySource, used: d.consumed.length },
    startWeek: d.startWeek,
    weeks: d.weeks,
    attempts: d.attempts,
    openPrs: d.prs.filter((p) => p.state === 'open').map((p) => ({ pr: `${p.repo}#${p.number}`, url: p.url, items: p.items.map((x) => ({ n: x.n, kind: x.kind, state: x.state })), unclear: p.unclear ?? [] })),
    rules: d.rules.map((r) => ({ rid: r.rid, kind: r.kind, rule: r.rule, accepted: r.accepted ?? [], rejected: Boolean(r.rejected?.length), toolkit: r.toolkit ? { state: r.toolkit.state, url: r.toolkit.url ?? null, why: r.toolkit.why ?? null } : null })),
    sessions: d.runs.length,
  };
}

// What a learning pass has to do now, read from the state with no forge call: the open rule PRs and toolkit PRs to read,
// a queued toolkit rule, and the week (a first pass records the start week). Empty: the full check hands nothing on.
// The week and a queued rule count only while the session gate is open, so a closed gate starts no process for them.
export function learnWanted({ settings, now, morningDone = false, busy = null }) {
  if (!settings.learning) return [];
  const data = readLearning(settings.state);
  const out = [];
  const openPrs = data.prs.filter((p) => p.state === 'open').length;
  if (openPrs) out.push(`${openPrs} open rule PR(s)`);
  if (data.rules.some((r) => r.toolkit?.state === 'open')) out.push('an open toolkit PR');
  const gate = sessionGate({ settings, now, morningDone, busy });
  if (!data.startWeek) out.push('the start week to record');
  else if (!gate && weekDue({ settings, data, now, morningDone, busy }).due) out.push(`the week ${weekOf(now)}`);
  if (!gate && settings.learning.toolkit && data.rules.some((r) => r.toolkit?.state === 'queued')) out.push('a queued toolkit rule');
  return out;
}

// The notifications of a pass not sent before, each key once: the keys go into the state as they are returned.
export function unsentNotes(settings, notes, now) {
  const data = readLearning(settings.state);
  const fresh = notes.filter((n) => !data.notified[n.key]);
  if (fresh.length) {
    for (const n of fresh) data.notified[n.key] = new Date(now).toISOString();
    saveLearning(settings.state, data);
  }
  return fresh;
}
