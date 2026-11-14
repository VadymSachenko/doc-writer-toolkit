import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../ui-labels/lib/util.mjs';

// PROVISIONAL FORMAT. The run log of the unattended flow does not exist yet; until it does, this reader takes a
// JSON Lines file with one record per step: { "pr": 41, "stage": "write", "cost": 1.2, "inputTokens": 900,
// "outputTokens": 300 }. `cost` is the CLI's estimate in dollars. Records without a `pr` number or a `stage` are
// counted in `skipped`. When the real log lands, only this file changes.
// Returns null when no file is declared or the file is not there.
export function readRunLog(root, file) {
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(path.resolve(root, file), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CliError(`cannot read the run log: ${e.code ?? 'error'}`, { code: 2 });
  }
  const byPr = new Map();
  let skipped = 0;
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      throw new CliError(`the run log is not JSON Lines: line ${i + 1}`, { code: 2 });
    }
    if (!Number.isInteger(r.pr) || !r.stage) {
      skipped++;
      continue;
    }
    const pr = byPr.get(r.pr) ?? { stages: {}, cost: 0, inputTokens: 0, outputTokens: 0, steps: 0 };
    const st = (pr.stages[r.stage] ??= { cost: 0, inputTokens: 0, outputTokens: 0, steps: 0 });
    for (const target of [pr, st]) {
      target.cost += Number(r.cost) || 0;
      target.inputTokens += Number(r.inputTokens) || 0;
      target.outputTokens += Number(r.outputTokens) || 0;
      target.steps++;
    }
    byPr.set(r.pr, pr);
  }
  return { byPr, skipped };
}
