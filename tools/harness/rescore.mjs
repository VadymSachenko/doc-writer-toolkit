// Re-checks a pass's saved runs against the cases' current assertions, with no model run: for a case whose assertion
// turned out to be wrong. Rewrites each run's assertions.json, the case's summary.json and pass.json; cost stays as run.
// Usage: node tools/harness/rescore.mjs --out <dir> --label <name> --case <id>[,<id>…]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCase, readTranscript, score, summarize } from './run.mjs';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

export function rescoreRun(c, dir, { sentinel, ownSkills }) {
  const result = JSON.parse(read(dir, 'result.json'));
  const status = fs.existsSync(path.join(dir, 'status.txt')) ? read(dir, 'status.txt') : '';
  const checks = score(c, readTranscript(read(dir, 'transcript.jsonl')), { host: path.join(dir, 'host'), output: result.output, status, sentinel, ownSkills });
  fs.writeFileSync(path.join(dir, 'assertions.json'), `${JSON.stringify(checks, null, 2)}\n`);
  return { ...result, checks };
}

function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, labelName, ids] = [option('--out'), option('--label'), (option('--case') ?? '').split(',').filter(Boolean)];
  if (!out || !labelName || !ids.length) {
    console.error('usage: node tools/harness/rescore.mjs --out <dir> --label <name> --case <id>[,<id>…]');
    process.exit(2);
  }
  const base = path.resolve(out, labelName);
  const pass = JSON.parse(read(base, 'pass.json'));
  const copy = path.join(base, '.plugin', pass.sentinel);
  const ownSkills = new Set([...fs.readdirSync(path.join(copy, 'skills')), ...fs.readdirSync(path.join(copy, 'commands')).map((f) => f.replace(/\.md$/, ''))]);
  for (const id of ids) {
    const c = loadCase(id);
    const caseDir = path.join(base, c.id);
    const runs = fs.readdirSync(caseDir).filter((d) => /^run-\d+$/.test(d)).sort((x, y) => Number(x.slice(4)) - Number(y.slice(4)));
    if (!runs.length) {
      console.error(`rescore: no saved runs of ${c.id} in ${base}`);
      process.exit(2);
    }
    const summary = summarize(c, runs.map((r) => rescoreRun(c, path.join(caseDir, r), { sentinel: pass.sentinel, ownSkills })));
    fs.writeFileSync(path.join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    pass.cases = pass.cases.map((s) => (s.case === c.id ? summary : s));
    console.log(`${c.id}: ${summary.passedRuns}/${summary.runs} runs passed (rescored)`);
    for (const a of summary.assertions) console.log(`  ${a.passed}/${summary.runs}  ${a.name}`);
  }
  pass.costUsd = Number(pass.cases.reduce((sum, s) => sum + s.costUsd, 0).toFixed(4));
  fs.writeFileSync(path.join(base, 'pass.json'), `${JSON.stringify(pass, null, 2)}\n`);
}
