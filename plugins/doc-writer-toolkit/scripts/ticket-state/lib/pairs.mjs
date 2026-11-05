import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveConfig } from '../../screenshot-locales/lib/config.mjs';
import { checkPairs, pairsMessage } from '../../screenshot-locales/lib/pairs.mjs';
import { worktreePath } from './worktree.mjs';

// The UA → EN image pair check of the align stage (`screenshot-locales pairs`), run by `record align` in the PR's
// worktree at the head the stage names, so the target repo's own declarations at that head decide (the owner's clone
// may be on another branch). Returns { missing, message, summary }, or { error } when it can't run.
export async function imagePairsAt(settings, pr, head) {
  const wt = worktreePath(settings, pr);
  if (!wt || !fs.existsSync(wt)) return { missing: [], summary: `not checked: no worktree at ${wt ?? `${pr.repo} (targets[].path)`}` };
  const base = pr.base ?? 'main';
  let ref = base;
  try {
    execFileSync('git', ['-C', wt, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`], { stdio: 'ignore' });
    ref = `origin/${base}`;
  } catch {
    /* the local base */
  }
  let r;
  try {
    r = checkPairs(await resolveConfig({ root: wt }), { base: ref, head });
  } catch (e) {
    // The declarations or git can't be read: the check can't pass, so the stage can't either.
    return { missing: [], error: String(e.message).slice(0, 300) };
  }
  if (!r.applies) return { missing: [], summary: `not needed: ${r.why}` };
  return { missing: r.missing, message: pairsMessage(r), summary: `${r.checked} UA image(s) checked against ${ref}: each has its EN counterpart` };
}
