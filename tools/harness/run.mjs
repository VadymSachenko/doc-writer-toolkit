#!/usr/bin/env node
// Runs harness cases against one plugin tree under one label, N times each, every run in a fresh fixture host.
//   node tools/harness/run.mjs --tree <plugin dir> --label <name> --case <id>[,<id>…] [--runs 3] [--out <dir>]
//                              [--model <model>] [--claude <bin>] [--resume]
// The tree is copied under the sentinel name `harness-<label>`, the installed copy of the plugin is switched off
// for the run, and every run checks that the session loaded the sentinel (sentinel-loaded) and called no skill
// of another copy (no-foreign-skill). Writes <out>/<label>/<case>/run-<n>/ and a summary per case and per label.
// Every run is a full session on the caller's plan. HARNESS_MODE=off (or "mode": "off" in tools/harness/local.json)
// turns the harness off: it makes no run and exits 3. Before each run it reads `claude -p /usage` and stops, exit 4,
// once the 5-hour session or the week is at its limit (default 80% and 50%; HARNESS_MAX_SESSION_PERCENT,
// HARNESS_MAX_WEEK_PERCENT, or maxSessionPercent and maxWeekPercent in local.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './fixture.mjs';
import { check, label as nameOf } from './assertions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_NAME = 'doc-writer-toolkit';
const INSTALLED_OFF = JSON.stringify({ enabledPlugins: { [`${PLUGIN_NAME}@${PLUGIN_NAME}`]: false } });
const SKIP = new Set(['node_modules', '__pycache__', '.git']);

export function loadCase(idOrPath) {
  const file = idOrPath.endsWith('.json') ? path.resolve(idOrPath) : path.join(here, 'cases', `${idOrPath}.json`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['id', 'fixture', 'prompt', 'assertions']) if (!(key in c)) throw new Error(`${file}: missing '${key}'`);
  for (const a of c.assertions) {
    if (typeof a.pattern !== 'string') continue;
    try { new RegExp(a.pattern, a.flags ?? ''); } catch (e) { throw new Error(`${file}: assertion '${nameOf(a)}': ${e.message}`); }
  }
  return c;
}

export function sentinelCopy(tree, sentinel, dir) {
  const copy = path.join(dir, sentinel);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(tree, copy, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) && !path.basename(src).startsWith('.venv') });
  const manifest = path.join(copy, '.claude-plugin', 'plugin.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), name: sentinel }, null, 2));
  return copy;
}

// The init and result events of a stream-json transcript, and every Skill call.
export function readTranscript(text) {
  let init = null;
  let result = null;
  const skills = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'init') init = e;
    if (e.type === 'result') result = e;
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) if (c.type === 'tool_use' && c.name === 'Skill') skills.push(c.input?.skill ?? '');
    }
  }
  return { init, result, skills };
}

// The two checks every run makes before its case's own assertions.
export function builtInChecks({ init, skills }, sentinel, ownSkills) {
  const loaded = (init?.plugins ?? []).some((p) => p.source === `${sentinel}@inline`);
  const foreign = skills.filter((s) => !s.startsWith(`${sentinel}:`) && ownSkills.has(s.split(':').pop()));
  return [
    { name: 'sentinel-loaded', pass: loaded, detail: loaded ? `${sentinel}@inline` : `plugins: ${(init?.plugins ?? []).map((p) => p.source).join(', ') || 'no init event'}` },
    { name: 'no-foreign-skill', pass: !foreign.length, detail: foreign.length ? `called ${foreign.join(', ')}` : `skills called: ${skills.join(', ') || 'none'}` },
  ];
}

// Settings from tools/harness/local.json (untracked, per machine), overridden by HARNESS_* variables.
export function harnessSettings(env = process.env, file = path.join(here, 'local.json')) {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no local settings */ }
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  return {
    mode: env.HARNESS_MODE ?? local.mode ?? 'on',
    maxSessionPercent: num(env.HARNESS_MAX_SESSION_PERCENT) ?? local.maxSessionPercent ?? 80,
    maxWeekPercent: num(env.HARNESS_MAX_WEEK_PERCENT) ?? local.maxWeekPercent ?? 50,
  };
}

// The plan's usage bars from `/usage`. Either is null when the output has none (an API key has no plan limits).
export function parseUsage(text) {
  const bar = (re) => {
    const m = re.exec(text);
    return m ? { percent: Number(m[1]), resets: m[2]?.trim() ?? null } : null;
  };
  return {
    session: bar(/Current session:\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?/),
    week: bar(/Current week \(all models\):\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?/),
  };
}

// Why the next run must not start, or null.
export function overLimit(usage, settings) {
  if (usage.session && usage.session.percent >= settings.maxSessionPercent) {
    return `the 5-hour session is at ${usage.session.percent}% (limit ${settings.maxSessionPercent}%), resets ${usage.session.resets ?? 'later'}`;
  }
  if (usage.week && usage.week.percent >= settings.maxWeekPercent) {
    return `the week is at ${usage.week.percent}% (limit ${settings.maxWeekPercent}%), resets ${usage.week.resets ?? 'later'}`;
  }
  return null;
}

function readUsage(claude) {
  const run = spawnSync(claude, ['-p', '/usage'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60 * 1000 });
  return parseUsage(`${run.stdout ?? ''}${run.stderr ?? ''}`);
}

function claudeArgs(c, prompt, copy, model) {
  const o = c.options ?? {};
  const args = ['-p', prompt, '--plugin-dir', copy, '--output-format', 'stream-json', '--verbose', '--settings', INSTALLED_OFF];
  if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.allowedTools?.length) args.push('--allowedTools', ...o.allowedTools);
  if (o.disallowedTools?.length) args.push('--disallowedTools', ...o.disallowedTools);
  if (model ?? o.model) args.push('--model', model ?? o.model);
  return args;
}

export function runOnce(c, { copy, sentinel, ownSkills, dir, model, claude = 'claude' }) {
  const host = path.join(dir, 'host');
  fs.mkdirSync(host, { recursive: true });
  makeFixture(host, c.fixture.shape, c.fixture);
  for (const cmd of c.setup ?? []) {
    const s = spawnSync('sh', ['-c', cmd], { cwd: host, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } });
    if (s.status !== 0) throw new Error(`${c.id}: setup '${cmd}' exited ${s.status}: ${s.stderr}`);
  }
  const prompt = c.prompt.replaceAll('{plugin}', sentinel);
  const started = Date.now();
  const run = spawnSync(claude, claudeArgs(c, prompt, copy, model), { cwd: host, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: (c.options?.timeoutSeconds ?? 900) * 1000 });
  if (run.error?.code === 'ENOENT') throw new Error(`'${claude}' not found`);
  const seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), run.stdout ?? '');
  if (run.stderr) fs.writeFileSync(path.join(dir, 'stderr.txt'), run.stderr);
  const t = readTranscript(run.stdout ?? '');
  const git = (...args) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: host, encoding: 'utf8' }).stdout ?? '';
  const status = git('status', '--porcelain', '--untracked-files=all');
  fs.writeFileSync(path.join(dir, 'status.txt'), status);
  git('add', '-A', '--intent-to-add');
  fs.writeFileSync(path.join(dir, 'diff.patch'), git('diff'));
  const output = t.result?.result ?? '';
  const result = { exit: run.status, subtype: t.result?.subtype ?? null, turns: t.result?.num_turns ?? null, costUsd: t.result?.total_cost_usd ?? 0, seconds, output };
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const checks = score(c, t, { host, output, status, sentinel, ownSkills });
  fs.writeFileSync(path.join(dir, 'assertions.json'), `${JSON.stringify(checks, null, 2)}\n`);
  return { ...result, checks };
}

// The built-in checks, then the case's own assertions. rescore.mjs reuses it on saved runs.
export function score(c, t, { host, output, status, sentinel, ownSkills }) {
  return [
    ...builtInChecks(t, sentinel, ownSkills),
    ...c.assertions.map((a) => ({ name: nameOf(a), ...check(a, { host, output, status }) })),
  ];
}

export function summarize(c, runs) {
  const names = runs[0]?.checks.map((ch) => ch.name) ?? [];
  return {
    case: c.id,
    runs: runs.length,
    passedRuns: runs.filter((r) => r.checks.every((ch) => ch.pass)).length,
    assertions: names.map((name) => ({ name, passed: runs.filter((r) => r.checks.find((ch) => ch.name === name)?.pass).length })),
    costUsd: Number(runs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
    seconds: runs.reduce((s, r) => s + r.seconds, 0),
  };
}

function option(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tree = option('--tree');
  const labelName = option('--label');
  const ids = (option('--case') ?? '').split(',').filter(Boolean);
  if (!tree || !labelName || !ids.length) {
    console.error('usage: node tools/harness/run.mjs --tree <plugin dir> --label <name> --case <id>[,<id>…] [--runs 3] [--out <dir>] [--model <m>] [--resume]');
    process.exit(2);
  }
  const settings = harnessSettings();
  if (settings.mode === 'off') {
    console.error('harness: off (HARNESS_MODE or tools/harness/local.json); no runs made');
    process.exit(3);
  }
  // Every case loads, and its patterns compile, before the first run spends anything.
  let order;
  try { order = ids.map((id) => loadCase(id).id); } catch (e) {
    console.error(`harness: ${e.message}`);
    process.exit(2);
  }
  const runs = Number(option('--runs', '3'));
  const out = path.resolve(option('--out', path.join(os.tmpdir(), 'doc-toolkit-harness')));
  const sentinel = `harness-${labelName}`;
  const base = path.join(out, labelName);
  fs.mkdirSync(base, { recursive: true });
  const copy = sentinelCopy(path.resolve(tree), sentinel, path.join(base, '.plugin'));
  const ownSkills = new Set([...fs.readdirSync(path.join(copy, 'skills')), ...fs.readdirSync(path.join(copy, 'commands')).map((f) => f.replace(/\.md$/, ''))]);
  const options = { copy, sentinel, ownSkills, model: option('--model'), claude: option('--claude', process.env.CLAUDE_BIN || 'claude') };
  const pass = { label: labelName, tree: path.resolve(tree), sentinel, model: options.model ?? 'default', cases: [], costUsd: 0, stopped: null };
  let warned = false;
  // --resume keeps the cases a stopped pass already finished with the same number of runs.
  if (process.argv.includes('--resume') && fs.existsSync(path.join(base, 'pass.json'))) {
    const before = JSON.parse(fs.readFileSync(path.join(base, 'pass.json'), 'utf8'));
    const wanted = ids.map((id) => loadCase(id).id);
    pass.cases = before.cases.filter((s) => s.runs === runs && wanted.includes(s.case));
    pass.costUsd = Number(pass.cases.reduce((sum, s) => sum + s.costUsd, 0).toFixed(4));
  }
  const save = () => {
    pass.cases.sort((x, y) => order.indexOf(x.case) - order.indexOf(y.case));
    fs.writeFileSync(path.join(base, 'pass.json'), `${JSON.stringify(pass, null, 2)}\n`);
  };
  // pass.json is saved after every case, so a crash keeps what --resume needs.
  for (const id of ids) {
    const c = loadCase(id);
    if (pass.cases.some((s) => s.case === c.id)) continue;
    const caseDir = path.join(base, c.id);
    fs.rmSync(caseDir, { recursive: true, force: true });
    const results = [];
    for (let n = 1; n <= runs; n++) {
      const usage = readUsage(options.claude);
      if (!usage.session && !usage.week && !warned) {
        console.error('harness: /usage shows no plan limits (an API key?); running without the usage guard');
        warned = true;
      }
      const reason = overLimit(usage, settings);
      if (reason) {
        pass.stopped = { before: `${c.id} run ${n}`, reason };
        console.error(`harness: stopped before ${c.id} run ${n}: ${reason}`);
        break;
      }
      const dir = path.join(caseDir, `run-${n}`);
      fs.mkdirSync(dir, { recursive: true });
      const r = runOnce(c, { ...options, dir });
      results.push(r);
      const failed = r.checks.filter((ch) => !ch.pass).map((ch) => ch.name);
      console.error(`${c.id} run ${n}/${runs}: ${failed.length ? `FAIL (${failed.join('; ')})` : 'pass'}, ${r.subtype}, ${r.turns} turns, $${r.costUsd.toFixed(2)}, ${r.seconds} s`);
    }
    if (results.length) {
      const summary = summarize(c, results);
      fs.writeFileSync(path.join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      pass.cases.push(summary);
      pass.costUsd = Number((pass.costUsd + summary.costUsd).toFixed(4));
      save();
    }
    if (pass.stopped) break;
  }
  save();
  for (const s of pass.cases) {
    console.log(`${s.case}: ${s.passedRuns}/${s.runs} runs passed, $${s.costUsd.toFixed(2)}`);
    for (const a of s.assertions) console.log(`  ${a.passed}/${s.runs}  ${a.name}`);
  }
  console.log(`pass '${labelName}': $${pass.costUsd.toFixed(2)} in total, results in ${base}`);
  if (pass.stopped) {
    console.log(`stopped before ${pass.stopped.before}: ${pass.stopped.reason}. Run the rest later with the same arguments plus --resume.`);
    process.exitCode = 4;
  }
}
