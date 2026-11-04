import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBlocks } from './blocks.mjs';
import { candidateText } from './apply.mjs';
import { listUaPages } from './pages.mjs';
import { recordUnit } from './record.mjs';
import { selectPages } from './settings.mjs';

// Carries the id-only changes of the UA pages into every target locale with no translator (heading-anchors.md, "Id-only
// changes"): for each stale page and locale whose only changes are heading anchor comments and the link fragments
// rewritten to them (`spliceOnly` in `blocks`), it writes the spliced translation and records it, through the same
// checks as `record --candidate`. A cell that fails them is not written and its state doesn't move. Every other stale
// cell is listed in `toTranslate`, for the workers; its splices go in with its translated blocks (`apply`).
export async function runSplice(s, { selectors = [], date = null, dryRun = false } = {}) {
  const { inScope } = await listUaPages(s);
  const units = selectPages(s, inScope, selectors.length ? selectors : ['.']);
  const results = [];
  const toTranslate = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'locale-sync-splice-'));
  const byRef = new Map(units.map((u) => [u.ref, u]));
  try {
    const { results: cells } = units.length ? await runBlocks(s, { selectors: units.map((u) => u.ref) }) : { results: [] };
    for (const r of cells) {
      if (r.mode === 'none' || r.mode === 'skipped') continue;
      if (!r.spliceOnly) {
        toTranslate.push({ page: r.page, locale: r.locale, mode: r.mode, ...(r.mode === 'incremental' ? { noop: r.noop, changes: r.changes.length, spliced: r.spliced.length, unmapped: r.unmapped.length } : {}) });
        continue;
      }
      const candidate = path.join(tmp, `${results.length}.md`);
      await fs.writeFile(candidate, await candidateText(s, r));
      const rec = await recordUnit(s, byRef.get(r.page), r.locale, { candidate, date, dryRun });
      results.push({ ...rec, spliced: r.spliced.map((c) => ({ id: c.id, kind: c.kind, line: c.target.lines[0], ...(c.anchor ? { anchor: c.anchor } : { fragments: c.fragments }) })) });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return { ok: results.every((x) => x.recorded), results, toTranslate };
}
