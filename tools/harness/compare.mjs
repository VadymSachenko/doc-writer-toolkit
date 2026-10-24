#!/usr/bin/env node
// Puts two labels of a harness pass side by side, per case and per assertion.
//   node tools/harness/compare.mjs <out dir> <baseline label> <after label>
// An assertion "regressed" when it passed in every baseline run and fails in some after run, "fixed" the other
// way round, and is "mixed" when neither side is unanimous. Exits 1 when anything regressed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verdict(base, after) {
  if (base.passed === base.runs && after.passed < after.runs) return 'regressed';
  if (base.passed === 0 && after.passed === after.runs) return 'fixed';
  if (base.passed === base.runs && after.passed === after.runs) return 'same: pass';
  if (base.passed === 0 && after.passed === 0) return 'same: fail';
  return 'mixed';
}

export function compare(basePass, afterPass) {
  const rows = [];
  for (const b of basePass.cases) {
    const a = afterPass.cases.find((x) => x.case === b.case);
    if (!a) { rows.push({ case: b.case, assertion: '(case)', base: `${b.passedRuns}/${b.runs}`, after: 'not run', verdict: 'not run' }); continue; }
    for (const ba of b.assertions) {
      const aa = a.assertions.find((x) => x.name === ba.name);
      const v = aa ? verdict({ passed: ba.passed, runs: b.runs }, { passed: aa.passed, runs: a.runs }) : 'not run';
      rows.push({ case: b.case, assertion: ba.name, base: `${ba.passed}/${b.runs}`, after: aa ? `${aa.passed}/${a.runs}` : 'not run', verdict: v });
    }
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, baseLabel, afterLabel] = process.argv.slice(2);
  if (!afterLabel) {
    console.error('usage: node tools/harness/compare.mjs <out dir> <baseline label> <after label>');
    process.exit(2);
  }
  const load = (l) => JSON.parse(fs.readFileSync(path.join(out, l, 'pass.json'), 'utf8'));
  const [base, after] = [load(baseLabel), load(afterLabel)];
  const rows = compare(base, after);
  console.log(`| Case | Assertion | ${baseLabel} | ${afterLabel} | Verdict |`);
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.case} | ${r.assertion.replace(/\|/g, '\\|')} | ${r.base} | ${r.after} | ${r.verdict} |`);
  console.log(`\nCost: ${baseLabel} $${base.costUsd.toFixed(2)}, ${afterLabel} $${after.costUsd.toFixed(2)}`);
  process.exitCode = rows.some((r) => r.verdict === 'regressed') ? 1 : 0;
}
