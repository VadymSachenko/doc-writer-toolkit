import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeStatus } from './status.mjs';
import { readAllLedgers, readLedger, findPr, prId } from './ledger.mjs';
import { allLocks, takeLock, releaseLock, renewLock } from './locks.mjs';
import { runRecord, cardStatusFor } from './record.mjs';
import { runUnlock } from './handover.mjs';
import { allowanceOf, parseUsage } from './allowance.mjs';
import { CARD_STATUS_OF, LABEL_OF, PR_STAGE_OF_STATUS, PRIORITY_RANK, finishRank } from './stages.mjs';
import { appendRunLog, localDate, readRunLog, renderReport, writeReport } from './report.mjs';
import { ROLES } from './settings.mjs';
import { cleanupTicket } from './cleanup.mjs';
import { childEnv } from './env.mjs';
import { ensureWorktree, prsForStep, worktreePath } from './worktree.mjs';

// The daily run (design §7): finish first, then triage the quiet intake cards (mornings), then start ready groups while
// the limits and the day's allowance allow. A script decides; each step that needs a model is one `claude -p` session
// in one role, with that role's model and effort from the settings. A dry run prints the plan and the command lines
// and changes nothing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '../../..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'ticket-state', 'ticket-state.mjs');
export const ROLE_DIR = path.join(PLUGIN_ROOT, 'context', 'ticket-roles');
// A git allow rule in the `git -C <worktree>` spelling, for each worktree the runner made for the step: the literal
// path, as a prefix rule (`Bash(git -C /x/wt status:*)`). Never a wildcard path: `Bash(git -C * status *)` would also
// match `git -C <any folder> clean -fdx -e status`, any subcommand with an allowed word later in the command. A step
// with no worktree gets no twin.
export function gitCFor(rule, dirs) {
  const m = /^Bash\(git (?!-C )(.+):\*\)$/.exec(rule);
  return m ? dirs.map((d) => `Bash(git -C ${d} ${m[1]}:*)`) : [];
}
export const withGitC = (rules, dirs = []) => [...new Set(rules.flatMap((r) => [r, ...gitCFor(r, dirs)]))];

// The only push a session may run: its worktree's HEAD to its ticket branch, exactly as the brief writes it, in both
// spellings (`cd` to the worktree, then the plain one). No role file allows `git push` otherwise, so a `+` refspec, a
// force flag anywhere, a deletion (`--delete`, `-d`, `:<ref>`) or another branch is never allowed.
export const pushRulesFor = (trees = []) => [...new Set(trees.flatMap((t) => [`Bash(git -C ${t.path} push origin HEAD:refs/heads/${t.branch})`, `Bash(git push origin HEAD:refs/heads/${t.branch})`]))];

// Denied in every role, whatever its file says: a push that could drop someone else's commits (the owner pushes to the
// same branches by hand), skip the hooks, or delete a branch, in both spellings, plain and `git -C <any folder>`. A deny
// rule may hold a `*` in the middle (a wider deny only denies more): the flag right after `push`, or anywhere after it,
// and a `+` refspec (a forced update). A `:*` after a middle `*` never matches, so each is written as the command alone
// and with arguments; a `:<ref>` deletion can't be written as a deny rule at all, and is kept out by allowing only the
// brief's exact push (`pushRulesFor`).
const FORCE_FLAGS = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--no-verify', '--mirror', '--delete', '-d'];
const PUSH_PLAIN = FORCE_FLAGS.map((f) => `Bash(git push ${f}:*)`);
const pushDenied = (git) => [
  ...FORCE_FLAGS.flatMap((f) => [`Bash(${git} push ${f})`, `Bash(${git} push ${f} *)`, `Bash(${git} push * ${f})`, `Bash(${git} push * ${f} *)`]),
  `Bash(${git} push +*)`,
  `Bash(${git} push * +*)`,
];
export const PUSH_DENIED = [...new Set([...PUSH_PLAIN, ...pushDenied('git'), ...pushDenied('git -C *')])];
// Denied in every role too: the runner prepares the worktree (lib/worktree.mjs), so no session installs packages or
// links files into it.
export const SETUP_DENIED = ['Bash(npm ci:*)', 'Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(ln:*)'];

// ------------------------------------------------------------------ roles

// A role file: frontmatter (`name`, `description`, `allowedTools`, `disallowedTools` as YAML lists) and the role's
// instructions. The runner hands them to `claude -p` as a session agent (`--agents <file> --agent ticket-<role>`).
export function readRole(role, dir = ROLE_DIR) {
  const text = fs.readFileSync(path.join(dir, `${role}.md`), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${role}.md has no frontmatter`);
  const meta = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(item[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') {
      listKey = kv[1];
      meta[listKey] = [];
    } else {
      listKey = null;
      meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2').replace(/''/g, "'");
    }
  }
  return { role, name: meta.name, description: meta.description, allowedTools: meta.allowedTools ?? [], disallowedTools: meta.disallowedTools ?? [], prompt: m[2].trim() };
}

export const agentName = (role) => `ticket-${role}`;

// Every role, as the `--agents` file: its instructions, then the rules of working unattended that every role shares.
export function agentsFile(dir = ROLE_DIR) {
  const shared = fs.readFileSync(path.join(dir, 'unattended.md'), 'utf8').trim();
  return Object.fromEntries(ROLES.map((r) => {
    const role = readRole(r, dir);
    return [agentName(r), { description: role.description, prompt: `${role.prompt}\n\n${shared}` }];
  }));
}

export const nextModelUp = (model, ladder) => {
  const i = ladder.indexOf(model);
  return i >= 0 && i < ladder.length - 1 ? ladder[i + 1] : null;
};

// ------------------------------------------------------------------ one step's session

// What a session is told: the ticket, the stage, where the settings and the ticket's status are, and how to record.
export function briefFor(step, settings) {
  const root = settings.root;
  const ts = `node ${SCRIPT}`;
  // The settings file the runner read, so a session of a run started with --settings finds the same one.
  const at = `--root ${root}${settings.file ? ` --settings ${settings.file}` : ''}`;
  const keys = step.keys.join(', ');
  const rules = Object.entries(settings.hostRules ?? {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const cardOf = (key) => step.cards?.find((c) => c.key === key);
  const recordLine = (key) =>
    `${ts} record ${key} ${at} --stage ${step.stage}${step.pr ? ` --pr ${step.pr}` : ''} --status done${step.stage === 'start' || step.stage === 'triage' ? ` --card ${cardOf(key)?.shortLink ?? '<card>'}` : ''}${step.stage === 'start' ? ` --started-by ${step.startedBy ?? 'schedule'}` : ''} --result ${step.stage === 'start' && step.group ? `'{"group":"${step.group}"}'` : '<json>'}`;
  return [
    `Stage \`${step.stage}\` of ticket${step.keys.length > 1 ? 's' : ''} ${keys}${step.group ? ` (group ${step.group})` : ''}${step.pr ? `, PR ${step.pr}` : ''}.`,
    step.interrupted ? 'The last run of this stage was interrupted: read what it left and finish it.' : null,
    step.withoutVideo ? 'The owner moved the card back before every video part had its transcript: go on without the video, and say so in the plan comment.' : null,
    step.changed ? 'The section plan file changed after its gate: post the new plan and move the card back to Blocked (a new gate).' : null,
    step.stale ? `The UA pages changed after this stage last ran (${step.stale} file(s)): run it again on the current head.` : null,
    step.cards ? `Cards, highest priority first:\n${step.cards.map((c) => `- ${c.key}: ${c.url ?? c.shortLink} (${c.priority})`).join('\n')}` : null,
    step.worktrees?.length ? worktreeLines(step.worktrees) : null,
    '',
    `Host repo: ${root}`,
    `The toolkit's scripts folder: ${path.join(PLUGIN_ROOT, 'scripts')}`,
    `Settings (merged): \`${ts} config ${at}\``,
    `The ticket now: \`${ts} status ${at} --ticket ${step.keys[0]}\``,
    rules ? `Host rules:\n${rules}` : null,
    '',
    'When the stage ends, record it, one command per call, for each ticket:',
    ...step.keys.map((k) => `  ${recordLine(k)}`),
    `or \`--status failed --note <the reason>\`. A record the tracker, the forge or the files don't support is refused: fix the cause, never the record.`,
  ]
    .filter((x) => x !== null)
    .join('\n');
}

// What the brief says about the worktrees the runner made for the session.
function worktreeLines(trees) {
  return [
    'Worktrees (the runner made them; work only there, and never create, move or remove a worktree, or link a file into one). Run git there as `git -C <the path exactly as below> <command>`, or `cd` to it and run plain `git <command>`: other spellings are denied.',
    ...trees.map((t) => `- ${t.repo} ${t.branch}: ${t.path}${t.linked?.length ? ` (linked from the clone: ${t.linked.join(', ')})` : ''}. It is detached at the branch's head; push with \`${t.push}\`.${t.notes?.length ? ` Note: ${t.notes.join('; ')}.` : ''}`),
  ].join('\n');
}

export function commandFor(step, settings, { model, agentsPath, claude = 'claude', roleDir = ROLE_DIR }) {
  const role = settings.roles[step.role];
  const def = readRole(step.role, roleDir);
  // Every git rule in both spellings, plain and `git -C <worktree>` for each worktree of the step (lib/worktree.mjs).
  const allowed = [...withGitC([...def.allowedTools, ...(role.allowedTools ?? [])], (step.worktrees ?? []).map((t) => t.path)), ...pushRulesFor(step.worktrees)];
  const disallowed = [...new Set([...def.disallowedTools, ...(role.disallowedTools ?? []), ...PUSH_DENIED, ...SETUP_DENIED])];
  const dirs = [...new Set([...settings.targets.map((t) => (t.path ? path.resolve(settings.root, t.path) : null)), ...(step.worktrees ?? []).map((t) => t.path)].filter((d) => d && d !== settings.root))];
  const args = [
    '-p',
    briefFor(step, settings),
    '--agents', agentsPath,
    '--agent', agentName(step.role),
    '--model', model ?? role.model,
    ...(role.effort ? ['--effort', role.effort] : []),
    '--max-turns', String(role.maxTurns ?? 100),
    ...(role.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(role.maxBudgetUsd)] : []),
    '--permission-prompts', 'none',
    '--output-format', 'json',
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ...dirs.flatMap((d) => ['--add-dir', d]),
  ];
  return { bin: claude, args, cwd: settings.root, role: step.role, model: model ?? role.model, effort: role.effort ?? null };
}

// Runs one session; resolves { code, stdout, stderr }.
// The child gets no API key or auth token (`lib/env.mjs`), so the plan pays.
export function spawnClaude({ bin, args, cwd }, { timeoutMs = 4 * 3600 * 1000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// The result event of `--output-format json`: turns, the CLI's cost estimate, tokens, the session id.
export function parseResult(stdout) {
  const line = String(stdout ?? '').trim().split('\n').reverse().find((x) => x.trim().startsWith('{'));
  if (!line) return null;
  try {
    const r = JSON.parse(line);
    return {
      isError: Boolean(r.is_error) || r.subtype !== 'success',
      turns: r.num_turns ?? null,
      costUsd: r.total_cost_usd ?? null,
      tokens: r.usage ? { in: r.usage.input_tokens ?? 0, out: r.usage.output_tokens ?? 0, cacheRead: r.usage.cache_read_input_tokens ?? 0, cacheWrite: r.usage.cache_creation_input_tokens ?? 0 } : null,
      session: r.session_id ?? null,
      denials: (r.permission_denials ?? []).length,
      durationMs: r.duration_ms ?? null,
    };
  } catch {
    return null;
  }
}

export function readUsageFromClaude(claude = 'claude', env = process.env) {
  const run = spawnSync(claude, ['-p', '/usage'], { cwd: os.tmpdir(), env: childEnv(env), encoding: 'utf8', timeout: 60 * 1000 });
  const usage = parseUsage(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  return usage.week || usage.session ? usage : null;
}

// ------------------------------------------------------------------ the order of the run

// The runnable steps of a status, one per group: tickets of a group with the same next stage run as one session.
// Finishing first (merged, ready for merge, final review, review comments, answers in, writing), and within a kind the
// higher priority, then the older card. A step whose last session failed, with no person's action since, waits for
// the morning run or a manual one (`retryWaiting`).
export function collectSteps(st, { named = [], includeStart = false, retryWaiting = false } = {}) {
  const groups = new Map();
  for (const t of st.tickets) {
    if (!t.next || t.locked || t.hand) continue;
    if (t.next.waits && !retryWaiting) continue;
    if (named.length && !named.includes(t.key)) continue;
    if (t.next.stage === 'start' && !includeStart && !t.next.byHand) continue;
    const g = t.group ?? t.key;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const out = [];
  for (const [group, tickets] of groups) {
    const first = tickets[0];
    const same = tickets.filter((t) => t.next.stage === first.next.stage && (t.next.pr ?? null) === (first.next.pr ?? null));
    out.push({
      ...first.next,
      group,
      keys: same.map((t) => t.key),
      priority: tickets.map((t) => t.priority).sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0],
      createdAt: tickets.map((t) => t.createdAt).filter(Boolean).sort()[0] ?? null,
      card: first.card,
    });
  }
  return out.sort((a, b) => finishRank(a) - finishRank(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || String(a.createdAt ?? '9').localeCompare(String(b.createdAt ?? '9')));
}

// ------------------------------------------------------------------ the steps that need no model

// What a scripted step does, as the tracker and forge operations it calls (for the plan of a dry run).
export function scriptedCalls(step, ledger, settings) {
  const card = ledger?.card?.shortLink ?? ledger?.card?.id ?? step.card?.shortLink;
  const target = (pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo);
  const label = (pr, stage) => (LABEL_OF[stage] && target(pr) ? [`forge set-stage-label --target ${target(pr).id} --number ${pr.number} --stage ${LABEL_OF[stage]}`] : []);
  switch (step.stage) {
    case 'move': {
      if (step.pr) {
        const pr = findPr(ledger, step.pr);
        const after = structuredClone(ledger);
        findPr(after, step.pr).stage = step.to;
        const expected = cardStatusFor(after);
        return [...label(pr, step.to), ...(expected && expected !== step.card?.status ? [`tracker move ${card} --to ${expected}`] : [])];
      }
      return [...ledger.prs.filter((p) => p.number && !p.merged).flatMap((p) => label(p, p.stage)), `tracker move ${card} --to ${step.to}`];
    }
    case 'follow':
      return ledger.prs.filter((p) => p.number && CARD_STATUS_OF[p.stage] === ledger.left?.status && PR_STAGE_OF_STATUS[step.to]).flatMap((p) => label(p, PR_STAGE_OF_STATUS[step.to]));
    case 'close':
      return step.card?.status === 'done' ? [] : [`tracker move ${card} --to done`];
    case 'videoBlock':
      return [...(ledger.video?.gateComment ? [`tracker comment ${card} --text-file <the gate comment> --unless-header <its first line>`] : []), `tracker move ${card} --to blocked`];
    case 'videoTry':
      return [`the transcriber adapter: ${step.parts?.length ?? 0} part(s)`];
    default:
      return [];
  }
}

async function runScripted(step, ctx) {
  const { settings, clients, io } = ctx;
  const key = step.keys[0];
  const ledger = readLedger(settings.state, key);
  const card = ledger.card.shortLink ?? ledger.card.id;
  const target = (pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo);
  const setLabel = async (pr, stage) => {
    const t = target(pr);
    if (LABEL_OF[stage] && t?.labels?.[LABEL_OF[stage]]) await clients.forge.setStageLabel({ target: t.id, number: pr.number, stage: LABEL_OF[stage] });
  };
  const rec = (k, extra = {}) => runRecord({ settings, clients, key: k, stage: step.stage, status: 'done', pr: step.pr, now: (io.now ?? Date.now)(), ...extra });
  switch (step.stage) {
    case 'move': {
      if (step.pr) {
        const pr = findPr(ledger, step.pr);
        await setLabel(pr, step.to);
        const after = structuredClone(ledger);
        findPr(after, step.pr).stage = step.to;
        const expected = cardStatusFor(after);
        if (expected) await clients.tracker.move({ card, to: expected });
        for (const k of step.keys) await rec(k, { to: step.to });
        return;
      }
      for (const p of ledger.prs.filter((x) => x.number && !x.merged)) await setLabel(p, p.stage);
      await clients.tracker.move({ card, to: step.to });
      for (const k of step.keys) await rec(k, { to: step.to });
      return;
    }
    case 'follow': {
      for (const p of ledger.prs.filter((x) => x.number && CARD_STATUS_OF[x.stage] === ledger.left?.status && PR_STAGE_OF_STATUS[step.to])) await setLabel(p, PR_STAGE_OF_STATUS[step.to]);
      for (const k of step.keys) await rec(k, { to: step.to });
      return;
    }
    case 'close': {
      // The PRs first: the cleanup removes nothing unless every one is merged.
      const states = new Map();
      for (const p of ledger.prs.filter((x) => x.number)) states.set(prId(p), (await clients.forge.prState({ repo: p.repo, number: p.number })).state);
      const now = await clients.tracker.findCards({ link: card });
      if (now.cards[0]?.status !== 'done') await clients.tracker.move({ card, to: 'done' });
      for (const k of step.keys) {
        const l = readLedger(settings.state, k);
        const cleanup = cleanupTicket({ settings, ledger: l, prState: (p) => states.get(prId(p)) ?? null, trashDir: trashOf(settings, io) });
        await rec(k, { result: JSON.stringify({ cleanup }) });
      }
      return;
    }
    case 'readyForMerge':
      // Its record checks the UA → EN image pairs in the PR's worktree: made or brought up to date first.
      for (const p of prsForStep({ ...step, stage: 'align' }, [ledger])) (io.ensureWorktree ?? ensureWorktree)(settings, p);
      for (const k of step.keys) await rec(k, { head: step.head });
      return;
    case 'planApproval':
      for (const k of step.keys) await rec(k);
      return;
    case 'videoTry': {
      // The transcriber is the host's adapter (the video gate's own task builds it). Without one, every try fails
      // at once, which is the fallback to the person.
      const parts = [];
      for (const file of step.parts ?? []) {
        const r = io.transcriber ? await io.transcriber.tryPart({ ledger, file, settings }) : { outcome: 'failed', reason: 'no transcriber adapter is installed' };
        parts.push({ file, ...r });
      }
      await rec(key, { result: JSON.stringify({ parts }) });
      return;
    }
    case 'videoBlock': {
      const gate = ledger.video?.gateComment;
      let commentId = null;
      if (gate) {
        const c = await clients.tracker.comment({ card, text: gate, unlessHeader: gate.split('\n')[0], since: ledger.video.at });
        commentId = c.id ?? c.existing ?? null;
      }
      await clients.tracker.move({ card, to: 'blocked' });
      const asked = (ledger.video?.videos ?? []).flatMap((v) => v.parts).filter((p) => !p.transcript).slice(0, settings.video.partsPerDay).map((p) => p.file);
      await rec(key, { result: JSON.stringify({ commentId, asked, posted: { card: commentId ? [commentId] : [] } }) });
      return;
    }
    default:
      throw new Error(`no scripted handler for ${step.stage}`);
  }
}

export const trashOf = (settings, io = {}) => io.trashDir ?? settings.cleanup.trashDir ?? path.join(os.homedir(), '.Trash');

// ------------------------------------------------------------------ the weekly roles proposal

// From the last 7 days of runs: a role whose steps often needed the retry with the next model up gets that model
// proposed; a role with many steps, no failure and no retry at high effort gets a lower effort proposed. For a yes or
// no in the report; nothing changes on its own.
export function proposeRoles(ledgers, settings, now = Date.now()) {
  const since = new Date(now - 7 * 86400000).toISOString();
  const proposals = [];
  for (const role of ROLES) {
    const runs = ledgers.flatMap((l) => l.runs ?? []).filter((r) => r.role === role && String(r.start ?? '') >= since);
    if (!runs.length) continue;
    const steps = runs.filter((r) => !r.retryOf).length;
    const retried = runs.filter((r) => r.retryOf).length;
    const failed = runs.filter((r) => r.outcome && r.outcome !== 'done').length;
    const current = settings.roles[role];
    const up = nextModelUp(current.model, settings.modelLadder);
    if (steps >= 5 && retried / steps >= 0.3 && up) proposals.push({ role, change: `model ${current.model} → ${up}`, why: `${retried} of ${steps} steps needed the retry with ${up}` });
    else if (steps >= 10 && !failed && !retried && current.effort === 'high') proposals.push({ role, change: 'effort high → medium', why: `${steps} steps, none failed or needed a retry` });
  }
  return { at: new Date(now).toISOString(), since, proposals };
}

// ------------------------------------------------------------------ the run

export async function runDaily({ settings, clients, io = {}, options = {} }) {
  // `progress.begun` turns true once the run starts its first step: a caller can tell a run that failed before doing
  // anything (safe to start again) from one that failed part way.
  const { dryRun = false, morning = false, trigger = 'schedule', named = [], claude = 'claude', progress = {} } = options;
  const clock = io.now ?? Date.now;
  const manual = trigger === 'manual';
  // A failed step that waits for a person runs again once at the next morning run, or when the owner runs it by hand.
  const retryWaiting = manual || morning;
  const observe = settings.mode === 'observe' && !dryRun;
  const planOnly = dryRun || observe;
  const date = localDate(clock());
  const out = { mode: settings.mode, dryRun, observe, trigger, morning, named, planned: [], ran: [], triage: null, starts: [], guard: [], notes: [] };
  const log = [];
  const say = (e) => log.push({ at: new Date(clock()).toISOString(), ...e });
  if (settings.mode === 'off') {
    out.stopped = 'mode off: nothing runs';
    return out;
  }

  const readUsage = io.readUsage ?? (() => readUsageFromClaude(claude, io.claudeEnv));
  let usage = await readUsage();
  out.usage = usage;
  // Why a scheduled model step may not start now, or null.
  const guardReason = () => {
    if (manual) return null;
    const a = allowanceOf(usage, settings.limits, new Date(clock()));
    if (!a) return 'no usage reading: no scheduled start';
    if (a.remaining <= 0) return `the week is at ${a.used}%, the allowance by now is ${a.cap}%`;
    return null;
  };
  const guard = (what, group = null) => {
    const reason = guardReason();
    if (reason) say({ kind: 'guard', reason, what, ...(group ? { group } : {}) });
    return !reason;
  };
  const sessionNear = () => (usage?.session?.percent ?? 0) >= (settings.limits.sessionPercent ?? 80);

  // Stale locks: moved aside, their running stages recorded failed.
  if (!planOnly) {
    for (const lock of allLocks(settings.state, clock())) {
      if (lock.live) continue;
      const r = runUnlock({ settings, group: lock.group, stale: true, now: clock() });
      say({ kind: 'lock', group: lock.group, outcome: 'released', note: `stale lock moved aside; ${r.failed.length} stage(s) recorded failed` });
    }
  }

  const own = new Set();
  const status = () => computeStatus({ settings, clients, usage, now: clock(), ignoreLocks: own });
  let st = await status();
  out.before = summary(st);

  // Plan a dry run: describe, start nothing.
  const describe = (step) => {
    const l = readLedger(settings.state, step.keys[0]);
    if (!step.role) {
      const d = { ...pick(step), runs: 'no model', calls: l ? scriptedCalls(step, l, settings) : [] };
      if (step.stage === 'close' && l) {
        // What the close step would remove after the merge: listed, nothing removed.
        const views = st.tickets.find((t) => t.key === l.key)?.prs ?? [];
        const c = cleanupTicket({ settings, ledger: l, prState: (p) => views.find((v) => v.id === prId(p))?.state ?? (p.merged ? 'merged' : null), dryRun: true, trashDir: trashOf(settings, io) });
        d.cleanup = { mode: c.mode, wouldRemove: c.removed, keeps: c.kept, freesBytes: c.freedBytes, blocked: c.blocked, worktrees: c.worktrees.map((t) => t.path) };
      }
      return d;
    }
    // The worktrees a live run would make or bring up to date: named, nothing made.
    const trees = prsForStep(step, step.keys.map((k) => readLedger(settings.state, k))).map((p) => ({ repo: p.repo, branch: p.branch, path: worktreePath(settings, p), push: `git -C ${worktreePath(settings, p)} push origin HEAD:refs/heads/${p.branch}` }));
    const cmd = commandFor({ ...step, worktrees: trees }, settings, { model: settings.roles[step.role].model, agentsPath: path.join(settings.state, 'roles', 'agents.json'), claude });
    const held = guardReason();
    return { ...pick(step), runs: `claude -p as ${agentName(step.role)}`, model: cmd.model, effort: cmd.effort, ...(trees.length ? { worktrees: trees.map((t) => t.path) } : {}), ...(held ? { guard: `a live run would not start it: ${held}` } : {}), command: [cmd.bin, ...cmd.args] };
  };

  const finishing = collectSteps(st, { named, includeStart: manual && named.length > 0, retryWaiting });
  if (planOnly) {
    out.planned.push(...finishing.map(describe));
  } else {
    await pool(finishing, sessionNear() ? 1 : settings.limits.parallel, (step) => advance(step));
  }

  // Mornings: triage every intake card quiet for its hours, high priority first, in one session. A manual run that
  // names tickets triages only those.
  if (morning) {
    const due = st.intake.due.filter((c) => !manual || !named.length || named.includes(c.key)).slice(0, settings.limits.triageBatch);
    if (due.length) {
      const step = { stage: 'triage', role: 'triage', keys: due.map((c) => c.key), group: null, cards: due.map((c) => ({ key: c.key, url: c.card.url, shortLink: c.card.shortLink, priority: c.priority })) };
      if (planOnly) out.triage = describe(step);
      else if (guard('triage')) {
        progress.begun = true;
        out.triage = await runModelStep(step, { lockGroups: step.keys });
        st = await status();
      }
    } else out.triage = { note: 'no intake card is due' };
  }

  // Start ready groups while the limits and the allowance allow: the highest priority first, the oldest within a level.
  const cardsOf = (keys) => keys.map((k) => st.tickets.find((t) => t.key === k)).filter(Boolean).map((t) => ({ key: t.key, url: t.card?.url, shortLink: t.card?.shortLink, priority: t.priority }));
  // The watcher's run finishes the tickets it names; it starts no ready group (the morning run does).
  if (trigger === 'schedule') {
    if (planOnly) {
      out.starts = st.startable.map((g) => describe({ stage: 'start', role: 'writer', group: g.group, keys: g.keys, priority: g.priority, startedBy: 'schedule', cards: cardsOf(g.keys) }));
    } else {
      const started = new Set();
      while (st.startable.length && guard('start')) {
        const g = st.startable.find((x) => !started.has(x.group));
        if (!g) break;
        started.add(g.group);
        const r = await advance({ stage: 'start', role: 'writer', group: g.group, keys: g.keys, priority: g.priority, startedBy: 'schedule', cards: cardsOf(g.keys) });
        out.starts.push(r);
        st = await status();
      }
    }
  } else if (manual && named.length) {
    for (const g of st.groups.filter((x) => x.keys.some((k) => named.includes(k)))) {
      const step = { stage: 'start', role: 'writer', group: g.group, keys: g.keys, priority: g.priority, startedBy: 'manual', cards: cardsOf(g.keys) };
      out.starts.push(planOnly ? describe(step) : await advance(step));
    }
  }

  // A plan whose model steps the guard would hold back says so, in the output and the report.
  if (planOnly && guardReason() && [...out.planned, out.triage, ...out.starts].some((d) => d?.role)) {
    say({ kind: 'guard', reason: `${guardReason()}: a live run would start no model step`, what: 'the plan' });
  }

  st = planOnly ? st : await status();
  out.after = summary(st);
  out.notStarted = st.notStarted;
  out.guard = log.filter((e) => e.kind === 'guard');

  // The report and the run log. A dry run writes neither and prints the report.
  const ledgers = readAllLedgers(settings.state);
  const watched = [];
  for (const job of settings.hostJobs ?? []) {
    if (!job.watch?.board || !job.watch?.list) continue;
    try {
      const r = await clients.tracker.listCardsOn({ board: job.watch.board, list: job.watch.list });
      watched.push({ list: job.watch.list, cards: r.cards });
    } catch (e) {
      out.notes.push(`${job.name}: ${e.message}`);
    }
  }
  const proposal = weeklyProposal(settings, ledgers, clock(), !planOnly);
  const report = renderReport({ settings, st, date, runLog: [...(dryRun ? [] : readRunLog(settings.state, date)), ...log], watched, proposal, ledgers });
  if (dryRun) out.report = report;
  else {
    appendRunLog(settings.state, date, log);
    out.reportFile = path.relative(settings.root, writeReport(settings.state, date, report));
  }
  out.log = log;
  return out;

  // ---------------------------------------------------------------- advancing one group

  // Runs a group's steps one after another, as far as it goes: a scripted step, or one session per step.
  async function advance(first) {
    progress.begun = true;
    const kind = manual ? 'manual' : 'schedule';
    const group = first.group ?? first.keys[0];
    const taken = takeLock(settings.state, { group, kind, stage: first.stage, leaseMinutes: settings.limits.lockLeaseMinutes, now: clock() });
    if (!taken.taken) {
      const h = taken.held;
      if (manual && h?.kind === 'schedule' && h.live) out.notes.push(`group ${group} is held by a scheduled run at ${h.stage}: the manual run stops there`);
      say({ kind: 'lock', group, outcome: 'skipped', note: `locked by a ${h?.kind ?? 'run'} run at ${h?.stage ?? '?'}` });
      return { group, skipped: 'locked' };
    }
    own.add(group);
    const done = [];
    try {
      let step = first;
      for (let i = 0; step && i < settings.limits.stepsPerTicket; i++) {
        if (step.role && !guard(step.stage, step.group)) break;
        const r = step.role ? await runModelStep(step) : await runScriptedStep(step);
        done.push(r);
        ran(r);
        if (r.outcome !== 'done') break;
        const now = await computeStatus({ settings, clients, usage, now: clock(), only: step.keys, ignoreLocks: own });
        const next = collectSteps(now, { named: step.keys, includeStart: false, retryWaiting })[0] ?? null;
        step = next ? { ...next, keys: next.keys.filter((k) => step.keys.includes(k)) } : null;
      }
    } finally {
      own.delete(group);
      releaseLock(settings.state, group);
    }
    return { group, steps: done };
  }

  function ran(r) {
    out.ran.push(r);
  }

  async function runScriptedStep(step) {
    try {
      await runScripted(step, { settings, clients, io });
      say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, outcome: 'done' });
      return { ...pick(step), outcome: 'done' };
    } catch (e) {
      const note = `${e.message}`.slice(0, 300);
      for (const k of step.keys) await runRecord({ settings, clients, key: k, stage: step.stage, status: 'failed', pr: step.pr, note, now: clock() }).catch(() => {});
      say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, outcome: 'failed', note });
      return { ...pick(step), outcome: 'failed', note };
    }
  }

  async function runModelStep(step, { lockGroups = [] } = {}) {
    // Triage has no group yet: each card's key is its lock.
    const held = [];
    for (const g of lockGroups) {
      const t = takeLock(settings.state, { group: g, kind: manual ? 'manual' : 'schedule', stage: step.stage, leaseMinutes: settings.limits.lockLeaseMinutes, now: clock() });
      if (t.taken) held.push(g);
    }
    try {
      // The worktrees of the step's PRs, made or brought up to date before the session. If one can't be made, no
      // session starts: the stage is recorded failed with git's reason.
      try {
        step = { ...step, worktrees: prsForStep(step, step.keys.map((k) => readLedger(settings.state, k))).map((p) => (io.ensureWorktree ?? ensureWorktree)(settings, p)) };
      } catch (e) {
        const note = `the worktree: ${String(e.message).slice(0, 280)}`;
        for (const k of step.keys) if (readLedger(settings.state, k)) await runRecord({ settings, clients, key: k, stage: step.stage, status: 'failed', pr: step.pr, note, now: clock() }).catch(() => {});
        say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, role: step.role, outcome: 'failed', note });
        return { ...pick(step), outcome: 'failed', note };
      }
      const agentsPath = path.join(settings.state, 'roles', 'agents.json');
      fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
      fs.writeFileSync(agentsPath, JSON.stringify(agentsFile(io.roleDir), null, 2) + '\n');
      let model = settings.roles[step.role].model;
      // Failed sessions of this step in a row with no person's action between them: two hold the ticket for the owner.
      let failures = step.prior ?? 0;
      const ledgered = step.keys.some((k) => readLedger(settings.state, k));
      for (let attempt = 0; attempt < 2; attempt++) {
        const seqBefore = new Map(step.keys.map((k) => [k, readLedger(settings.state, k)?.seq ?? 0]));
        const before = usage?.week?.percent ?? null;
        const cmd = commandFor(step, settings, { model, agentsPath, claude });
        const start = new Date(clock()).toISOString();
        const renew = setInterval(() => {
          for (const g of [step.group, ...held].filter(Boolean)) renewLock(settings.state, g, { leaseMinutes: settings.limits.lockLeaseMinutes, now: clock() });
        }, 5 * 60000);
        let res;
        try {
          res = await (io.spawnClaude ?? spawnClaude)(cmd, io.claudeEnv ? { env: io.claudeEnv } : {});
        } finally {
          clearInterval(renew);
        }
        usage = (await readUsage()) ?? usage;
        const r = parseResult(res.stdout) ?? {};
        const after = usage?.week?.percent ?? null;
        const outcome = await gateOf(step, seqBefore);
        if (outcome !== 'done') failures += 1;
        // What the ticket looks like now the session is over, so its own unrecorded writes never count as a person's.
        const marks = outcome === 'done' || !ledgered ? {} : await marksOf(step);
        const run = { stage: step.stage, role: step.role, model, effort: cmd.effort, trigger: manual ? 'manual' : trigger, start, durationMs: r.durationMs, turns: r.turns, costUsd: r.costUsd, tokens: r.tokens, weekPercent: { before, after }, session: r.session, outcome, share: Number((1 / step.keys.length).toFixed(4)), ...(attempt ? { retryOf: settings.roles[step.role].model } : {}), ...(r.denials ? { denials: r.denials } : {}), ...(outcome === 'done' ? {} : { failures }) };
        for (const k of step.keys) if (readLedger(settings.state, k)) await runRecord({ settings, clients, key: k, run: JSON.stringify({ ...run, ...(marks[k] ? { after: marks[k] } : {}) }), pr: step.pr, now: clock() }).catch(() => {});
        const entry = { kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, role: step.role, model, exit: res.code, ...(r.denials ? { denials: r.denials } : {}) };
        if (outcome === 'done') {
          say({ ...entry, outcome });
          return { ...pick(step), model, outcome };
        }
        const up = nextModelUp(model, settings.modelLadder);
        if (failures < 2 && attempt === 0 && up && guard(`${step.stage} retry`, step.group)) {
          say({ kind: 'retry', group: step.group, stage: step.stage, from: model, to: up });
          model = up;
          continue;
        }
        // One line a pair in the report's failures: a first failure only waits (for a person, or the next morning run).
        const twice = failures >= 2;
        const why = twice ? 'failed twice' : !up ? 'failed; no model above to retry with' : 'failed; the guard held the retry';
        const waits = ledgered && !twice;
        say({ ...entry, outcome: waits ? 'waits' : 'failed', note: twice && ledgered ? 'failed twice: held for the owner until a person acts on the ticket or `ticket-state set retry` re-arms it' : waits ? `${why}: runs again after a person acts on the ticket, or once at the next morning run` : why });
        return { ...pick(step), model, outcome: 'failed', note: why };
      }
      return { ...pick(step), outcome: 'failed' };
    } finally {
      for (const g of held) releaseLock(settings.state, g);
    }
  }

  // The mark of each ticket of a step right after its session failed (`markOf` in lib/rule.mjs). If the world can't be
  // read now, a bare mark: then only `ticket-state set retry` or the morning run gives the step another try.
  async function marksOf(step) {
    try {
      const now = await computeStatus({ settings, clients, usage, now: clock(), only: step.keys, ignoreLocks: own, marks: step.keys });
      return Object.fromEntries(now.tickets.filter((t) => t.mark).map((t) => [t.key, t.mark]));
    } catch {
      return Object.fromEntries(step.keys.map((k) => [k, { at: new Date(clock()).toISOString(), list: null, comments: null, prs: {} }]));
    }
  }

  // Whether the session passed its gate: every ticket recorded the stage done after the session began. A stage left
  // `running` is recorded failed for it.
  async function gateOf(step, seqBefore) {
    let ok = true;
    for (const k of step.keys) {
      const l = readLedger(settings.state, k);
      const rec = !l ? null : step.pr ? (() => {
        try {
          const p = findPr(l, step.pr);
          return p.chain?.[step.stage] ?? p.steps?.[step.stage];
        } catch {
          return null;
        }
      })() : l.stages?.[step.stage];
      if (rec?.status === 'running') {
        await runRecord({ settings, clients, key: k, stage: step.stage, status: 'failed', pr: step.pr, note: 'the session ended without recording the stage', now: clock() }).catch(() => {});
        ok = false;
      } else if (!rec || rec.status !== 'done' || rec.seq <= (seqBefore.get(k) ?? 0)) ok = false;
    }
    return ok ? 'done' : 'failed';
  }
}

function weeklyProposal(settings, ledgers, now, write) {
  const file = path.join(settings.state, 'roles-proposal.json');
  let last = null;
  try {
    last = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  if (last && now - Date.parse(last.at) < 7 * 86400000) return null;
  const p = proposeRoles(ledgers, settings, now);
  if (write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return p;
}

const pick = (s) => ({ stage: s.stage, role: s.role ?? null, group: s.group ?? null, keys: s.keys, ...(s.pr ? { pr: s.pr } : {}), ...(s.to ? { to: s.to } : {}), priority: s.priority ?? null });

function summary(st) {
  return { wip: st.wip, allowance: st.allowance, tickets: st.tickets.length, startable: st.startable.map((g) => g.group), intakeDue: st.intake.due.map((c) => c.key) };
}

async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
