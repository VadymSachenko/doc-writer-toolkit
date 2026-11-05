import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliError } from './errors.mjs';
import { childEnv, scriptEnv } from './env.mjs';
import { jobDenied } from './runner.mjs';

// Host jobs (D-054): the host declares "when list X gets new cards and stays quiet for N hours, run job Y", or "run job
// Y every N minutes"; Y is a script or a skill. The watcher knows nothing about what a job does. A job:
//   { "name": "...", "watch": { "board": "<id>", "list": "<name, * allowed>" }, "quietHours": 3, "run": { "skill": "..." } }
//   { "name": "...", "every": 5, "run": { "script": "path/in/the/host.mjs", "args": [] } }
// `run.skill` takes `args`, `model`, `effort`, `maxTurns`, `allowedTools`; `timeoutMinutes` (default 120) bounds a run.

const ARRIVALS = new Set(['createCard', 'copyCard', 'moveCardToBoard', 'convertToCardFromCheckItem']);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function validateJobs(jobs, root = null) {
  if (!Array.isArray(jobs)) throw new CliError('ticket flow settings: hostJobs must be a list', { code: 2 });
  const names = new Set();
  return jobs.map((j, i) => {
    const where = `hostJobs[${i}]`;
    const fail = (m) => {
      throw new CliError(`ticket flow settings: ${where} ${m}`, { code: 2 });
    };
    if (!isObject(j)) fail('must be an object');
    if (typeof j.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(j.name)) fail('.name must be letters, digits, ".", "_" or "-"');
    if (names.has(j.name)) fail(`.name '${j.name}' is used twice`);
    names.add(j.name);
    const watch = j.watch !== undefined;
    if (watch === (j.every !== undefined)) fail('needs either watch (with quietHours) or every (minutes), one of them');
    if (watch && (!isObject(j.watch) || typeof j.watch.board !== 'string' || typeof j.watch.list !== 'string' || !j.watch.list.trim())) fail('.watch needs board and list');
    if (watch && (typeof j.quietHours !== 'number' || !(j.quietHours >= 0))) fail('.quietHours must be a number ≥ 0');
    if (!watch && (typeof j.every !== 'number' || !(j.every >= 1))) fail('.every must be minutes ≥ 1');
    if (!isObject(j.run) || (typeof j.run.script === 'string') === (typeof j.run.skill === 'string')) fail('.run needs either script or skill, one of them');
    if (typeof j.run.script === 'string' && root) {
      const rel = path.relative(root, path.resolve(root, j.run.script));
      if (!j.run.script.trim() || rel.startsWith('..') || path.isAbsolute(rel)) fail(`.run.script ${j.run.script} must be a file inside the host repo`);
    }
    if (j.run.args !== undefined && !(typeof j.run.args === 'string' || (Array.isArray(j.run.args) && j.run.args.every((a) => typeof a === 'string')))) fail('.run.args must be text or a list of texts');
    if (j.run.allowedTools !== undefined && (!Array.isArray(j.run.allowedTools) || j.run.allowedTools.some((x) => typeof x !== 'string'))) fail('.run.allowedTools must be a list of rules');
    if (j.timeoutMinutes !== undefined && !(typeof j.timeoutMinutes === 'number' && j.timeoutMinutes > 0)) fail('.timeoutMinutes must be a number > 0');
    return { ...j, timeoutMinutes: j.timeoutMinutes ?? 120 };
  });
}

const globOf = (name) => new RegExp(`^${String(name).trim().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

// The places a job watches, as a matcher of a list reference ({ id, name }). On the board in the settings the actions
// carry list names; on another board a non-move action carries only the list id, so the ids are read once per check
// (and only when that board had events).
export async function listMatcher(job, { settings, clients }) {
  const byName = globOf(job.watch.list);
  if (job.watch.board === settings.tracker.board) return (ref) => Boolean(ref?.name) && byName.test(ref.name.trim());
  const r = await clients.tracker.listCardsOn({ board: job.watch.board, list: job.watch.list });
  const ids = new Set(r.lists.map((l) => l.id));
  return (ref) => Boolean(ref) && (ids.has(ref.id) || (Boolean(ref.name) && byName.test(ref.name.trim())));
}

// What the events did to a watched list: the times of cards that arrived, and of every change in it or out of it.
export function listChanges(events, inList) {
  const arrivals = [];
  const changes = [];
  for (const e of events) {
    const into = inList(e.listAfter) && !inList(e.listBefore);
    const created = ARRIVALS.has(e.type) && inList(e.list);
    const touched = inList(e.list) || inList(e.listBefore) || inList(e.listAfter);
    if (into || created) arrivals.push(e.time);
    if (touched || into || created) changes.push(e.time);
  }
  return { arrivals, changes };
}

const latest = (times) => times.reduce((m, t) => (!m || Date.parse(t) > Date.parse(m) ? t : m), null);

// A watch job's state after this check's events: armed by a new card, its wait restarted by any change in the list.
export function updateWatchState(state = {}, { arrivals, changes }) {
  const next = { ...state };
  if (arrivals.length) {
    if (!next.armed) next.firstChange = [...arrivals].sort((x, y) => Date.parse(x) - Date.parse(y))[0];
    next.armed = true;
  }
  if (next.armed && changes.length) {
    const last = latest(changes);
    if (!next.lastChange || Date.parse(last) > Date.parse(next.lastChange)) next.lastChange = last;
  }
  return next;
}

// Whether a job runs now, and when its wait ends if not.
export function jobDue(job, state = {}, now) {
  if (state.heldUntil && now < Date.parse(state.heldUntil)) return { due: false, why: `held until ${state.heldUntil}` };
  if (job.every !== undefined) {
    const at = state.lastRun ? Date.parse(state.lastRun) + job.every * 60000 : now;
    return at <= now ? { due: true } : { due: false, at: new Date(at).toISOString() };
  }
  if (!state.armed) return { due: false, why: 'no new card' };
  const at = Date.parse(state.lastChange) + job.quietHours * 3600000;
  return at <= now ? { due: true } : { due: false, at: new Date(at).toISOString() };
}

// The command line of a job. A script runs from the host root and must be inside it; a skill is one `claude -p`.
export function jobCommand(job, { settings, state = {}, claude = 'claude', node = process.execPath, roots }) {
  if (job.run.script) {
    const abs = path.resolve(settings.root, job.run.script);
    const rel = path.relative(settings.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new CliError(`hostJobs '${job.name}': the script ${job.run.script} is outside the host repo`, { code: 2 });
    const args = Array.isArray(job.run.args) ? job.run.args : job.run.args ? [job.run.args] : [];
    return /\.[cm]?js$/.test(abs) ? { bin: node, args: [abs, ...args], model: false } : { bin: abs, args, model: false };
  }
  const context = job.watch
    ? `Started unattended by the ticket flow's watcher: nobody answers questions in this session. The list ${job.watch.list} got its first new card at ${state.firstChange ?? 'an unknown time'}, and has had no change since ${state.lastChange ?? 'an unknown time'}.`
    : "Started unattended by the ticket flow's watcher: nobody answers questions in this session.";
  const args = [
    '-p',
    `/${job.run.skill}${job.run.args ? ` ${Array.isArray(job.run.args) ? job.run.args.join(' ') : job.run.args}` : ''}\n\n${context}`,
    '--output-format', 'json',
    '--permission-prompts', 'none',
    ...(job.run.model ? ['--model', job.run.model] : []),
    ...(job.run.effort ? ['--effort', job.run.effort] : []),
    ...(job.run.maxTurns ? ['--max-turns', String(job.run.maxTurns)] : []),
    ...(job.run.allowedTools?.length ? ['--allowedTools', ...job.run.allowedTools] : []),
    // Whatever the job allows: no push, branch change or fetch, no code of its own, no write that widens a session's rules.
    '--disallowedTools', ...jobDenied(settings, roots),
  ];
  return { bin: claude, args, model: true };
}

// Runs one job to its end; resolves { code, stdout, stderr }. Its environment holds no API key, plus the job's facts;
// a script's holds no sign-in token either (only a skill job's `claude` gets it, through `env`).
export function spawnJob({ bin, args, model }, { cwd, env = process.env, timeoutMs, extra = {} }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: model ? childEnv(env, extra) : scriptEnv(env, extra), stdio: ['ignore', 'pipe', 'pipe'] });
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

export const jobEnv = (job, state = {}) => ({
  DOC_TOOLKIT_JOB: job.name,
  ...(job.watch ? { DOC_TOOLKIT_JOB_LIST: job.watch.list } : {}),
  ...(state.firstChange ? { DOC_TOOLKIT_JOB_FIRST_CHANGE: state.firstChange } : {}),
  ...(state.lastChange ? { DOC_TOOLKIT_JOB_LAST_CHANGE: state.lastChange } : {}),
});

export function writeJobLog(stateDir, name, stamp, res) {
  const file = path.join(stateDir, 'watch', 'jobs', `${name}-${stamp.replace(/[:.]/g, '-')}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `exit ${res.code}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}\n`);
  return file;
}
