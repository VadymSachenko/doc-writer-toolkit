#!/usr/bin/env node
// Runs the regression set from the repo root and prints one row per step:
// its exit code and result line. A step whose tool is missing is `not run`, which fails the run unless
// --allow-not-run is passed. --skip <step,...> leaves steps out; --out <dir> saves each step's full output.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = 'plugins/doc-writer-toolkit/scripts';
const claude = process.env.CLAUDE_BIN || 'claude';

const STEPS = [
  { id: 'lint', cmd: 'node', args: ['tools/lint-plugin.mjs'] },
  { id: 'tools-tests', cmd: 'node', args: ['--test', 'tools/lint-plugin.test.mjs', 'tools/check-visibility.test.mjs'] },
  { id: 'ui-labels', cmd: 'npm', args: ['test'], cwd: `${scripts}/ui-labels` },
  { id: 'locale-sync', cmd: 'npm', args: ['test'], cwd: `${scripts}/locale-sync` },
  { id: 'validate', cmd: claude, args: ['plugin', 'validate', 'plugins/doc-writer-toolkit'] },
  { id: 'visibility', cmd: 'node', args: ['tools/check-visibility.mjs'], notRunExit: 2 },
];

// The line that says how a step went.
export function resultLine(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const counts = lines.filter((l) => /^ℹ (tests|pass|fail) \d+$/.test(l));
  if (counts.length) return counts.map((l) => l.slice(2)).join(', ');
  const known = lines.filter((l) => /^(lint-plugin|check-visibility):|Validation (passed|failed)/.test(l));
  if (known.length) {
    // `validate` prints one "Found N error(s)" block per file.
    const errors = [...output.matchAll(/Found (\d+) errors?:/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    return known.at(-1) + (errors ? ` (${errors} error${errors === 1 ? '' : 's'})` : '');
  }
  return lines.at(-1) ?? '';
}

function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const skip = new Set((option('--skip') ?? '').split(',').filter(Boolean));
  const out = option('--out');
  if (out) fs.mkdirSync(out, { recursive: true });
  const rows = [];
  for (const step of STEPS.filter((s) => !skip.has(s.id))) {
    const started = Date.now();
    const run = spawnSync(step.cmd, step.args, { cwd: path.join(root, step.cwd ?? ''), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const notRun = run.error?.code === 'ENOENT' || (step.notRunExit !== undefined && run.status === step.notRunExit);
    const status = notRun ? 'not run' : run.status === 0 ? 'pass' : 'FAIL';
    const line = run.error?.code === 'ENOENT' ? `'${step.cmd}' not found` : resultLine(output);
    rows.push({ id: step.id, status, exit: run.status ?? '-', line, seconds: Math.round((Date.now() - started) / 1000) });
    if (out) fs.writeFileSync(path.join(out, `${step.id}.txt`), `$ ${[step.cmd, ...step.args].join(' ')}  (in ${step.cwd ?? '.'})\n${output}\nexit ${run.status}\n`);
    console.error(`${step.id}: ${status}`);
  }
  const head = git(['rev-parse', '--short', 'HEAD']);
  console.log(`Regression set @ ${head}${git(['status', '--porcelain']) ? ' (with uncommitted changes)' : ''}\n`);
  console.log('| Step | Result | Exit | Output | Time |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.id} | ${r.status} | ${r.exit} | ${r.line.replace(/\|/g, '\\|')} | ${r.seconds} s |`);
  const failed = rows.filter((r) => r.status === 'FAIL' || (r.status === 'not run' && !process.argv.includes('--allow-not-run')));
  process.exitCode = failed.length ? 1 : 0;
}

function git(args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return (run.stdout ?? '').trim();
}
